"""SPHEREx IRSA TAP discovery and synchronous/asynchronous cutout ingestion."""

from __future__ import annotations

import asyncio
import csv
import io
import math
import os
import threading
import time
from collections.abc import Sequence
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor
from concurrent.futures import wait as wait_futures
from typing import Any

import httpx
import numpy as np
import requests
from astropy.time import Time

try:
    from pyvo.dal import TAPService
except ImportError:  # pragma: no cover
    TAPService = None  # type: ignore[assignment,misc]

from app.services.logging_config import get_logger
from app.services.spherex_fits import (
    SPHEREX_BANDPASSES,
    SpherexCutout,
    SpherexDownloadError,
    SpherexIngestError,
    SpherexObservation,
    SpherexValidationError,
    process_spherex_fits,
    validate_coordinates,
)
from app.services.spherex_synthetic import fallback_cutout
from app.utils.astronomy import offline_requested

logger = get_logger("spherex_ingest")

IRSA_SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
IRSA_TAP_URL = "https://irsa.ipac.caltech.edu/TAP/"
IRSA_BASE_URL = "https://irsa.ipac.caltech.edu/"


def _env_float(name: str, default: float) -> float:
    """Read a positive finite float override from ``os.environ``."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        parsed = float(raw)
    except ValueError:
        return default
    return parsed if math.isfinite(parsed) and parsed > 0.0 else default


DEFAULT_CONNECT_TIMEOUT = _env_float("IRSA_CONNECT_TIMEOUT_S", 3.5)
DEFAULT_DISCOVERY_TIMEOUT = _env_float("IRSA_DISCOVERY_TIMEOUT_S", 10.0)
DEFAULT_HTTP_TIMEOUT = _env_float("IRSA_CUTOUT_TIMEOUT_S", 8.0)
DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 2
DEFAULT_INGEST_BUDGET_SECONDS = _env_float("SPHEREX_INGEST_BUDGET_S", 16.0)
DEFAULT_IRSA_COOLDOWN_SECONDS = _env_float("IRSA_CIRCUIT_COOLDOWN_S", 45.0)
DEFAULT_MAX_PATCH_CUTOUTS = 18
DEFAULT_MAX_SPECTRUM_CUTOUTS = 6
DEFAULT_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024


class IrsaCircuitBreaker:
    """Thread-safe shared cooldown circuit breaker for upstream IRSA outages."""

    def __init__(self, cooldown_seconds: float = DEFAULT_IRSA_COOLDOWN_SECONDS) -> None:
        self._cooldown_seconds = float(cooldown_seconds)
        self._lock = threading.Lock()
        self._open_until = 0.0
        self._last_reason = ""

    def is_open(self) -> bool:
        """Return True while the shared IRSA cooldown window is active."""
        with self._lock:
            now = time.monotonic()
            if now < self._open_until:
                return True
            if self._open_until > 0.0:
                self._open_until = 0.0
                self._last_reason = ""
            return False

    def remaining_seconds(self) -> float:
        """Return remaining cooldown duration in seconds."""
        with self._lock:
            return max(0.0, self._open_until - time.monotonic())

    def last_reason(self) -> str:
        """Return the concise error summary that opened the circuit."""
        with self._lock:
            return self._last_reason

    def record_failure(self, reason: str, *, cooldown_s: float | None = None) -> None:
        """Open the circuit breaker for ``cooldown_s`` seconds."""
        duration = self._cooldown_seconds if cooldown_s is None else max(0.5, float(cooldown_s))
        with self._lock:
            self._open_until = max(self._open_until, time.monotonic() + duration)
            self._last_reason = reason

    def record_success(self) -> None:
        """Close the circuit breaker immediately after a healthy response."""
        with self._lock:
            self._open_until = 0.0
            self._last_reason = ""

    def reset(self) -> None:
        """Reset circuit breaker state (intended for tests)."""
        self.record_success()


irsa_circuit_breaker = IrsaCircuitBreaker()


class TimeoutSession(requests.Session):
    """Requests session with bounded connection and response timeouts."""

    def __init__(
        self,
        connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
        read_timeout: float = DEFAULT_DISCOVERY_TIMEOUT,
    ) -> None:
        super().__init__()
        self.connect_timeout = float(connect_timeout)
        self.read_timeout = float(read_timeout)

    def request(self, method: str, url: str, **kwargs: Any) -> requests.Response:
        """Issue an HTTP request with a bounded ``(connect, read)`` timeout tuple."""
        timeout = kwargs.pop("timeout", None)
        if timeout is None:
            kwargs["timeout"] = (self.connect_timeout, self.read_timeout)
        elif isinstance(timeout, (int, float)):
            kwargs["timeout"] = (min(self.connect_timeout, float(timeout)), float(timeout))
        else:
            kwargs["timeout"] = timeout
        return super().request(method, url, **kwargs)


def _is_transient_upstream_error(exc: Exception) -> bool:
    """Return True when an HTTP failure indicates upstream throttling or 5xx outage."""
    msg = str(exc).lower()
    return any(
        token in msg
        for token in (
            "503",
            "502",
            "504",
            "500",
            "429",
            "service unavailable",
            "bad gateway",
            "gateway timeout",
            "too many requests",
            "timed out",
            "timeout",
        )
    )


def _is_non_recoverable_http_error(exc: BaseException) -> bool:
    """Return True for non-retryable client/SSL/DNS failures (fail fast)."""
    if isinstance(exc, requests.HTTPError) and exc.response is not None:
        status = exc.response.status_code
        if 400 <= status < 500 and status != 429:
            return True
    msg = str(exc).lower()
    return any(
        token in msg
        for token in (
            "400 client error",
            "401 client error",
            "403 client error",
            "404 client error",
            "certificate verify",
            "sslerror",
            "name resolution",
            "nodename nor servname",
            "connection refused",
        )
    )


def _concise_error_summary(exc: BaseException) -> str:
    """Format an exception concisely without repeating cutout URLs multiple times."""
    text = str(exc).strip() or type(exc).__name__
    prefix = "Failed to download SPHEREx cutout "
    if text.startswith(prefix) and ": " in text:
        text = text.split(": ", 1)[1]
    if " for url: " in text:
        text = text.split(" for url: ", 1)[0]
    if len(text) > 180:
        text = text[:177] + "..."
    return text


def build_adql_query(
    ra: float,
    dec: float,
    fov_arcmin: float,
    bandpasses: tuple[str, ...] = SPHEREX_BANDPASSES,
) -> str:
    """Build an IRSA ADQL query for SPHEREx cutouts.

    Args:
        ra: Right Ascension in degrees.
        dec: Declination in degrees.
        fov_arcmin: Field of view in arcminutes.
        bandpasses: Tuple of SPHEREx bandpass names to filter on.

    Returns:
        ADQL query string selecting cutout URI, bandpass, and observation start time.

    Raises:
        SpherexValidationError: If coordinates or bandpasses are invalid.
    """
    validate_coordinates(ra, dec, fov_arcmin)

    if not bandpasses:
        raise SpherexValidationError("At least one bandpass must be provided.")

    invalid_bandpasses = [band for band in bandpasses if band not in SPHEREX_BANDPASSES]
    if invalid_bandpasses:
        raise SpherexValidationError(f"Unsupported SPHEREx bandpasses: {invalid_bandpasses}")

    fov_deg = fov_arcmin / 60.0
    bandpass_list = ", ".join(f"'{band}'" for band in bandpasses)

    query = f"""
    SELECT
        'https://irsa.ipac.caltech.edu/' ||
        a.uri ||
        '?center={ra},{dec}d&size={fov_deg}' AS uri,
        p.energy_bandpassname AS bandpass,
        p.time_bounds_lower AS time_bounds_lower
    FROM spherex.artifact a
    JOIN spherex.plane p
        ON a.planeid = p.planeid
    WHERE
        1 = CONTAINS(
            POINT('ICRS', {ra}, {dec}),
            p.poly
        )
        AND p.energy_bandpassname IN ({bandpass_list})
    ORDER BY p.time_bounds_lower
    """
    return query.strip()


def _mjd_from_time_value(value: Any) -> float | None:
    """Convert an IRSA TAP time value into a Modified Julian Date."""
    if value is None:
        return None
    try:
        if np.ma.is_masked(value):
            return None
        if isinstance(value, Time):
            return float(value.mjd)
        return float(Time(value, format="iso", scale="utc").mjd)
    except Exception:
        try:
            return float(value)
        except Exception:
            return None


def query_observations_sia(
    ra: float,
    dec: float,
    fov_arcmin: float,
    bandpasses: tuple[str, ...] = SPHEREX_BANDPASSES,
    session: requests.Session | None = None,
) -> list[SpherexObservation]:
    """Query IRSA SIA CSV for SPHEREx Level-2 observations covering a sky position."""
    validate_coordinates(ra, dec, fov_arcmin)
    if not bandpasses:
        raise SpherexValidationError("At least one bandpass must be provided.")
    invalid_bandpasses = [band for band in bandpasses if band not in SPHEREX_BANDPASSES]
    if invalid_bandpasses:
        raise SpherexValidationError(f"Unsupported SPHEREx bandpasses: {invalid_bandpasses}")

    radius_deg = max((float(fov_arcmin) / 60.0) * 0.5, 0.02)
    params = {
        "COLLECTION": "spherex_dr1",
        "POS": f"circle {float(ra):.6f} {float(dec):.6f} {radius_deg:.6f}",
        "RESPONSEFORMAT": "CSV",
    }
    owns_session = session is None
    http = session or TimeoutSession(
        connect_timeout=DEFAULT_CONNECT_TIMEOUT,
        read_timeout=DEFAULT_DISCOVERY_TIMEOUT,
    )
    t0 = time.perf_counter()
    try:
        logger.info(
            "Querying IRSA SIA (%s) for SPHEREx cutouts (ra=%.4f, dec=%.4f, fov_arcmin=%.2f)",
            IRSA_SIA_URL,
            ra,
            dec,
            fov_arcmin,
        )
        response = http.get(
            IRSA_SIA_URL,
            params=params,
            timeout=(DEFAULT_CONNECT_TIMEOUT, DEFAULT_DISCOVERY_TIMEOUT),
        )
        response.raise_for_status()

        reader = csv.DictReader(io.StringIO(response.text))
        fieldnames = set(reader.fieldnames or [])
        if "access_url" not in fieldnames or "energy_bandpassname" not in fieldnames:
            raise SpherexIngestError(f"IRSA SIA ({IRSA_SIA_URL}) returned unexpected CSV headers.")

        band_set = set(bandpasses)
        observations: list[SpherexObservation] = []
        seen: set[tuple[str, str]] = set()
        for row in reader:
            bandpass = (row.get("energy_bandpassname") or "").strip()
            access_url = (row.get("access_url") or "").strip()
            if not access_url or bandpass not in band_set:
                continue
            cutout_uri = build_cutout_url(access_url, ra, dec, fov_arcmin)
            key = (cutout_uri, bandpass)
            if key in seen:
                continue
            seen.add(key)
            t_min_raw = (row.get("t_min") or "").strip()
            mjd_obs = _mjd_from_time_value(t_min_raw) if t_min_raw else None
            observations.append(
                SpherexObservation(
                    uri=cutout_uri,
                    bandpass=bandpass,
                    time_bounds_lower=t_min_raw or None,
                    mjd_obs=mjd_obs,
                )
            )

        observations.sort(
            key=lambda obs: (obs.mjd_obs if obs.mjd_obs is not None else float("inf"), obs.bandpass)
        )
        logger.info(
            "IRSA SIA (%s) returned %d observation(s) at ra=%.4f dec=%.4f in %.2fs",
            IRSA_SIA_URL,
            len(observations),
            ra,
            dec,
            time.perf_counter() - t0,
        )
        return observations
    except SpherexIngestError:
        raise
    except Exception as exc:
        logger.warning(
            "IRSA SIA (%s) query failed at ra=%.4f dec=%.4f in %.2fs: %s",
            IRSA_SIA_URL,
            ra,
            dec,
            time.perf_counter() - t0,
            _concise_error_summary(exc),
        )
        raise SpherexIngestError(f"IRSA SIA query failed: {exc}") from exc
    finally:
        if owns_session:
            http.close()


def query_observations_tap(
    ra: float,
    dec: float,
    fov_arcmin: float,
    bandpasses: tuple[str, ...] = SPHEREX_BANDPASSES,
) -> list[SpherexObservation]:
    """Query IRSA TAP for SPHEREx observations covering a sky position."""
    query = build_adql_query(
        ra=ra,
        dec=dec,
        fov_arcmin=fov_arcmin,
        bandpasses=bandpasses,
    )

    if TAPService is None:  # pragma: no cover
        raise SpherexIngestError("pyvo is required to query the IRSA TAP service.")

    t0 = time.perf_counter()
    try:
        logger.info(
            "Querying IRSA TAP (%s) for SPHEREx cutouts (ra=%.4f, dec=%.4f, fov_arcmin=%.2f)",
            IRSA_TAP_URL,
            ra,
            dec,
            fov_arcmin,
        )
        with TimeoutSession(
            connect_timeout=DEFAULT_CONNECT_TIMEOUT,
            read_timeout=DEFAULT_DISCOVERY_TIMEOUT,
        ) as session:
            service = TAPService(
                IRSA_TAP_URL,
                session=session,
            )
            results = service.search(query)
            table = results.to_table()

        observations: list[SpherexObservation] = []
        for row in table:
            uri = str(row["uri"])
            bandpass = str(row["bandpass"])

            try:
                time_value = row["time_bounds_lower"]
            except Exception:
                time_value = None

            if time_value is None or np.ma.is_masked(time_value):
                time_value_str = None
                mjd_obs = None
            else:
                time_value_str = str(time_value)
                mjd_obs = _mjd_from_time_value(time_value_str)

            observations.append(
                SpherexObservation(
                    uri=uri,
                    bandpass=bandpass,
                    time_bounds_lower=time_value_str,
                    mjd_obs=mjd_obs,
                )
            )

        logger.info(
            "IRSA TAP (%s) returned %d observation(s) at ra=%.4f dec=%.4f in %.2fs",
            IRSA_TAP_URL,
            len(observations),
            ra,
            dec,
            time.perf_counter() - t0,
        )
        return observations

    except Exception as exc:
        logger.warning(
            "IRSA TAP (%s) query failed at ra=%.4f dec=%.4f in %.2fs: %s",
            IRSA_TAP_URL,
            ra,
            dec,
            time.perf_counter() - t0,
            _concise_error_summary(exc),
        )
        raise SpherexIngestError(f"IRSA TAP query failed: {exc}") from exc


def query_observations(
    ra: float,
    dec: float,
    fov_arcmin: float,
    bandpasses: tuple[str, ...] = SPHEREX_BANDPASSES,
) -> list[SpherexObservation]:
    """Query IRSA SIA (primary) with IRSA TAP failover for SPHEREx observations.

    Args:
        ra: Right Ascension in degrees.
        dec: Declination in degrees.
        fov_arcmin: Field of view in arcminutes.
        bandpasses: Tuple of SPHEREx bandpass names to query.

    Returns:
        List of :class:`SpherexObservation` metadata records.

    Raises:
        SpherexValidationError: If query parameters are invalid.
        SpherexIngestError: If IRSA circuit breaker is open or discovery fails.
    """
    build_adql_query(ra=ra, dec=dec, fov_arcmin=fov_arcmin, bandpasses=bandpasses)

    if irsa_circuit_breaker.is_open():
        rem = irsa_circuit_breaker.remaining_seconds()
        reason = irsa_circuit_breaker.last_reason() or "upstream outage"
        raise SpherexIngestError(
            f"IRSA circuit breaker open ({rem:.0f}s cooldown remaining; {reason})"
        )

    try:
        observations = query_observations_sia(
            ra=ra,
            dec=dec,
            fov_arcmin=fov_arcmin,
            bandpasses=bandpasses,
        )
        irsa_circuit_breaker.record_success()
        return observations
    except SpherexValidationError:
        raise
    except SpherexIngestError as sia_exc:
        cause = sia_exc.__cause__ or sia_exc
        if _is_non_recoverable_http_error(cause):
            raise
        logger.info(
            "Failing over SPHEREx discovery from %s to %s (%s)",
            IRSA_SIA_URL,
            IRSA_TAP_URL,
            _concise_error_summary(sia_exc),
        )

    try:
        observations = query_observations_tap(
            ra=ra,
            dec=dec,
            fov_arcmin=fov_arcmin,
            bandpasses=bandpasses,
        )
        irsa_circuit_breaker.record_success()
        return observations
    except SpherexIngestError as tap_exc:
        cause = tap_exc.__cause__ or tap_exc
        if _is_transient_upstream_error(cause) or _is_transient_upstream_error(tap_exc):
            irsa_circuit_breaker.record_failure(f"discovery:{_concise_error_summary(tap_exc)}")
        raise


def select_representative_observations(
    observations: Sequence[SpherexObservation],
    *,
    max_cutouts: int = DEFAULT_MAX_PATCH_CUTOUTS,
    max_epochs: int = 3,
) -> list[SpherexObservation]:
    """Stratify a large IRSA observation list across epoch bins and SPHEREx detectors."""
    if max_cutouts <= 0 or len(observations) <= max_cutouts:
        return list(observations)

    if max_epochs <= 1 or max_cutouts <= len(SPHEREX_BANDPASSES):
        by_band: dict[str, SpherexObservation] = {}
        for obs in observations:
            prev = by_band.get(obs.bandpass)
            if prev is None:
                by_band[obs.bandpass] = obs
            elif obs.mjd_obs is not None and (prev.mjd_obs is None or obs.mjd_obs > prev.mjd_obs):
                by_band[obs.bandpass] = obs
        return sorted(by_band.values(), key=lambda obs: obs.bandpass)[:max_cutouts]

    with_mjd = [obs for obs in observations if obs.mjd_obs is not None]
    if not with_mjd:
        buckets: dict[str, list[SpherexObservation]] = {}
        for obs in observations:
            buckets.setdefault(obs.bandpass, []).append(obs)
        selected: list[SpherexObservation] = []
        idx = 0
        while len(selected) < max_cutouts:
            added = False
            for bp in sorted(buckets):
                if idx < len(buckets[bp]):
                    selected.append(buckets[bp][idx])
                    added = True
                    if len(selected) >= max_cutouts:
                        break
            if not added:
                break
            idx += 1
        return selected

    mjds = sorted(float(obs.mjd_obs) for obs in with_mjd if obs.mjd_obs is not None)
    min_mjd, max_mjd = mjds[0], mjds[-1]
    if max_mjd - min_mjd < 1.0:
        targets = [min_mjd]
    elif max_epochs == 2:
        targets = [min_mjd, max_mjd]
    else:
        targets = [
            min_mjd + (max_mjd - min_mjd) * (i / (max_epochs - 1)) for i in range(max_epochs)
        ]

    by_band_obs: dict[str, list[SpherexObservation]] = {}
    for obs in observations:
        by_band_obs.setdefault(obs.bandpass, []).append(obs)

    chosen: list[SpherexObservation] = []
    seen_keys: set[tuple[str, str]] = set()
    for target_mjd in targets:
        for bp in sorted(by_band_obs):
            candidates = [
                obs for obs in by_band_obs[bp] if (obs.uri, obs.bandpass) not in seen_keys
            ]
            if not candidates:
                continue
            best = min(
                candidates,
                key=lambda obs: (
                    abs(float(obs.mjd_obs) - target_mjd)
                    if obs.mjd_obs is not None
                    else float("inf")
                ),
            )
            seen_keys.add((best.uri, best.bandpass))
            chosen.append(best)
            if len(chosen) >= max_cutouts:
                return sorted(
                    chosen,
                    key=lambda obs: (
                        obs.mjd_obs if obs.mjd_obs is not None else float("inf"),
                        obs.bandpass,
                    ),
                )

    return sorted(
        chosen,
        key=lambda obs: (obs.mjd_obs if obs.mjd_obs is not None else float("inf"), obs.bandpass),
    )


def build_cutout_url(
    uri: str,
    ra: float,
    dec: float,
    fov_arcmin: float,
) -> str:
    """Build an IRSA cutout URL for an artifact URI.

    Args:
        uri: Relative or absolute IRSA artifact URI.
        ra: Right Ascension in degrees.
        dec: Declination in degrees.
        fov_arcmin: Field of view in arcminutes.

    Returns:
        Fully qualified IRSA cutout URL with ``center`` and ``size`` params.

    Raises:
        SpherexValidationError: If ``uri`` is empty or coordinates are invalid.
    """
    validate_coordinates(ra, dec, fov_arcmin)

    url = str(uri).strip()
    if not url:
        raise SpherexValidationError("Cutout URI must not be empty.")

    if url.startswith("http://") or url.startswith("https://"):
        base = url
    else:
        base = IRSA_BASE_URL + url.lstrip("/")

    if "center=" not in base or "size=" not in base:
        fov_deg = fov_arcmin / 60.0
        separator = "&" if "?" in base else "?"
        if "center=" not in base:
            base += f"{separator}center={float(ra)},{float(dec)}d"
            separator = "&"
        if "size=" not in base:
            base += f"{separator}size={fov_deg}"

    return base


def _read_response_content(
    response: requests.Response,
    max_bytes: int,
) -> bytes:
    """Stream response chunks while enforcing ``max_bytes``."""
    chunks: list[bytes] = []
    total = 0

    if hasattr(response, "iter_content"):
        iterator = response.iter_content(chunk_size=1024 * 1024)
    else:  # pragma: no cover
        iterator = (response.content,)

    for chunk in iterator:
        if not chunk:
            continue
        total += len(chunk)
        if total > max_bytes:
            raise SpherexDownloadError(
                f"Cutout exceeds maximum download size of {max_bytes} bytes."
            )
        chunks.append(chunk)

    return b"".join(chunks)


def download_cutout(
    uri: str,
    ra: float,
    dec: float,
    fov_arcmin: float,
    session: requests.Session | None = None,
    timeout: float = DEFAULT_HTTP_TIMEOUT,
    max_bytes: int = DEFAULT_MAX_DOWNLOAD_BYTES,
) -> bytes:
    """Download one SPHEREx MEF cutout synchronously.

    Args:
        uri: Artifact URI or full cutout URL.
        ra: Field center Right Ascension in degrees.
        dec: Field center Declination in degrees.
        fov_arcmin: Field of view in arcminutes.
        session: Optional HTTP session for connection reuse or test doubles.
        timeout: Request timeout in seconds.
        max_bytes: Maximum permitted payload size in bytes.

    Returns:
        Raw downloaded FITS byte payload.

    Raises:
        SpherexDownloadError: If the download fails, exceeds ``max_bytes``, or
            returns an empty response.
    """
    url = build_cutout_url(uri, ra, dec, fov_arcmin)
    owns_session = session is None
    http = session or TimeoutSession()

    try:
        response = http.get(url, timeout=timeout, stream=True)
        try:
            response.raise_for_status()
            data = _read_response_content(response, max_bytes=max_bytes)
        finally:
            close = getattr(response, "close", None)
            if callable(close):
                close()
    except SpherexDownloadError:
        raise
    except Exception as exc:
        raise SpherexDownloadError(f"Failed to download SPHEREx cutout {url}: {exc}") from exc
    finally:
        if owns_session:
            http.close()

    if not data:
        raise SpherexDownloadError(f"IRSA returned an empty SPHEREx cutout for {url}.")

    return data


async def download_cutout_async(
    uri: str,
    ra: float,
    dec: float,
    fov_arcmin: float,
    client: httpx.AsyncClient | None = None,
    timeout: float = DEFAULT_HTTP_TIMEOUT,
    max_bytes: int = DEFAULT_MAX_DOWNLOAD_BYTES,
) -> bytes:
    """Download one SPHEREx MEF cutout using an async HTTP client.

    Args:
        uri: Artifact URI or full cutout URL.
        ra: Field center Right Ascension in degrees.
        dec: Field center Declination in degrees.
        fov_arcmin: Field of view in arcminutes.
        client: Optional shared :class:`httpx.AsyncClient`.
        timeout: Request timeout in seconds.
        max_bytes: Maximum permitted payload size in bytes.

    Returns:
        Raw downloaded FITS byte payload.

    Raises:
        SpherexDownloadError: If the download fails, exceeds ``max_bytes``, or
            returns an empty response.
    """
    url = build_cutout_url(uri, ra, dec, fov_arcmin)
    owns_client = client is None
    req_timeout = httpx.Timeout(timeout, connect=DEFAULT_CONNECT_TIMEOUT)
    http = client or httpx.AsyncClient(
        timeout=req_timeout,
        follow_redirects=True,
    )

    try:
        response = await http.get(url, timeout=req_timeout)
        response.raise_for_status()
        data = response.content
    except Exception as exc:
        raise SpherexDownloadError(f"Failed to download SPHEREx cutout {url}: {exc}") from exc
    finally:
        if owns_client:
            await http.aclose()

    if len(data) > max_bytes:
        raise SpherexDownloadError(f"Cutout exceeds maximum download size of {max_bytes} bytes.")
    if not data:
        raise SpherexDownloadError(f"IRSA returned an empty SPHEREx cutout for {url}.")

    return data


async def download_cutouts_async(
    observations: Sequence[SpherexObservation],
    ra: float,
    dec: float,
    fov_arcmin: float,
    client: httpx.AsyncClient | None = None,
    timeout: float = DEFAULT_HTTP_TIMEOUT,
    max_bytes: int = DEFAULT_MAX_DOWNLOAD_BYTES,
) -> list[bytes | None]:
    """Download several cutouts concurrently, returning ``None`` on failure.

    Args:
        observations: Sequence of :class:`SpherexObservation` records.
        ra: Field center Right Ascension in degrees.
        dec: Field center Declination in degrees.
        fov_arcmin: Field of view in arcminutes.
        client: Optional shared :class:`httpx.AsyncClient`.
        timeout: Per-request timeout in seconds.
        max_bytes: Maximum permitted payload size per cutout.

    Returns:
        List aligned with ``observations`` containing FITS bytes or ``None``.
    """
    tasks = [
        download_cutout_async(
            observation.uri,
            ra,
            dec,
            fov_arcmin,
            client=client,
            timeout=timeout,
            max_bytes=max_bytes,
        )
        for observation in observations
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    return [None if isinstance(result, BaseException) else result for result in results]


def ingest_spherex_cutouts(
    ra: float,
    dec: float,
    fov_arcmin: float,
    bandpasses: tuple[str, ...] = SPHEREX_BANDPASSES,
    fixture_dir: str | os.PathLike | None = None,
    allow_synthetic_fallback: bool = True,
    session: requests.Session | None = None,
    timeout: float = DEFAULT_HTTP_TIMEOUT,
    max_cutouts: int | None = DEFAULT_MAX_PATCH_CUTOUTS,
    budget_seconds: float | None = None,
) -> list[SpherexCutout]:
    """Query, download, and clean representative SPHEREx cutouts covering a sky position.

    If IRSA is unreachable or cutouts cannot be downloaded, cached fixtures or
    deterministic synthetic cutouts are returned when ``allow_synthetic_fallback``
    is enabled. Enforces bounded ingest budgets and fail-fast circuit breaking in
    both live and fallback modes.

    Args:
        ra: Field center Right Ascension in degrees.
        dec: Field center Declination in degrees.
        fov_arcmin: Field of view in arcminutes.
        bandpasses: Tuple of SPHEREx bandpasses to ingest.
        fixture_dir: Optional directory containing cached FITS fixtures.
        allow_synthetic_fallback: Whether to fall back to local fixtures or
            synthetic cutouts when IRSA is unavailable.
        session: Optional synchronous ``requests.Session``.
        timeout: Per-download timeout in seconds.
        max_cutouts: Maximum number of observations to download (stratified across
            epochs and detectors), or ``None`` for uncapped downloads.

    Returns:
        List of cleaned :class:`SpherexCutout` instances.

    Raises:
        SpherexIngestError: If ``allow_synthetic_fallback`` is ``False`` and
            IRSA returns no observations or all downloads fail.
    """
    validate_coordinates(ra, dec, fov_arcmin)
    ingest_start = time.monotonic()
    total_budget = float(
        DEFAULT_INGEST_BUDGET_SECONDS if budget_seconds is None else budget_seconds
    )

    observations: list[SpherexObservation] = []
    query_error: Exception | None = None
    if offline_requested():
        query_error = SpherexIngestError("IRSA access disabled by environment.")
    else:
        try:
            observations = query_observations(
                ra=ra,
                dec=dec,
                fov_arcmin=fov_arcmin,
                bandpasses=bandpasses,
            )
        except Exception as exc:
            query_error = exc

    if not observations:
        if not allow_synthetic_fallback:
            if query_error is not None:
                raise SpherexIngestError(
                    f"IRSA is unreachable and no cached fixtures exist: {query_error}"
                ) from query_error
            logger.info("No SPHEREx observations cover ra=%.4f dec=%.4f", ra, dec)
            raise SpherexIngestError("No SPHEREx observations cover the requested position.")
        fallback_reason = (
            _concise_error_summary(query_error)
            if query_error is not None
            else "no archival coverage"
        )
        logger.info(
            "Using local fixtures/synthetic SPHEREx cutouts at ra=%.4f dec=%.4f (%s)",
            ra,
            dec,
            fallback_reason,
        )
        return [
            fallback_cutout(
                ra=ra,
                dec=dec,
                fov_arcmin=fov_arcmin,
                bandpass=bandpass,
                fixture_dir=fixture_dir,
                seed=index,
            )
            for index, bandpass in enumerate(bandpasses)
        ]

    max_epochs = 1 if (max_cutouts is not None and max_cutouts <= len(SPHEREX_BANDPASSES)) else 3
    if max_cutouts is not None and len(observations) > max_cutouts:
        selected_observations = select_representative_observations(
            observations,
            max_cutouts=max_cutouts,
            max_epochs=max_epochs,
        )
        logger.info(
            "Selected %d representative SPHEREx observation(s) from %d at ra=%.4f dec=%.4f",
            len(selected_observations),
            len(observations),
            ra,
            dec,
        )
    else:
        selected_observations = list(observations)

    results: list[SpherexCutout | None] = [None] * len(selected_observations)
    effective_timeout = min(float(timeout), DEFAULT_HTTP_TIMEOUT)
    workers = 1 if session is not None else min(6, max(1, len(selected_observations)))
    last_exc: Exception | None = None
    transient_failures = 0
    success_count = 0
    aborted_early = False
    abort_event = threading.Event()
    deadline = max(time.monotonic() + 2.0, ingest_start + total_budget)

    worker_local = threading.local()
    worker_sessions_lock = threading.Lock()
    worker_sessions: list[TimeoutSession] = []

    def _get_worker_session() -> requests.Session:
        if session is not None:
            return session
        local_sess = getattr(worker_local, "session", None)
        if local_sess is None:
            local_sess = TimeoutSession(
                connect_timeout=DEFAULT_CONNECT_TIMEOUT,
                read_timeout=effective_timeout,
            )
            worker_local.session = local_sess
            with worker_sessions_lock:
                worker_sessions.append(local_sess)
        return local_sess

    def _download_one(
        index: int, observation: SpherexObservation
    ) -> tuple[int, SpherexCutout | None, Exception | None]:
        if abort_event.is_set():
            return index, None, None
        try:
            payload = download_cutout(
                observation.uri,
                ra=ra,
                dec=dec,
                fov_arcmin=fov_arcmin,
                session=_get_worker_session(),
                timeout=effective_timeout,
            )
            cutout = process_spherex_fits(
                payload,
                bandpass=observation.bandpass,
                uri=observation.uri,
                source_name="irsa",
            )
            return index, cutout, None
        except Exception as exc:
            logger.warning(
                "SPHEREx cutout %s failed (%s): %s",
                observation.bandpass,
                observation.uri,
                _concise_error_summary(exc),
            )
            return index, None, exc

    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        pending = {
            pool.submit(_download_one, idx, obs) for idx, obs in enumerate(selected_observations)
        }
        while pending:
            wait_sec = max(0.05, deadline - time.monotonic())
            done, pending = wait_futures(pending, timeout=wait_sec, return_when=FIRST_COMPLETED)
            if not done:
                aborted_early = True
                abort_event.set()
                logger.warning(
                    "SPHEREx ingest budget (%.1fs) reached at ra=%.4f dec=%.4f; "
                    "cancelling %d pending cutout(s).",
                    total_budget,
                    ra,
                    dec,
                    len(pending),
                )
                if success_count == 0:
                    irsa_circuit_breaker.record_failure(
                        f"download budget {total_budget:.0f}s exceeded"
                    )
                for rem in pending:
                    rem.cancel()
                break

            for fut in done:
                idx, cutout, exc = fut.result()
                if cutout is not None:
                    results[idx] = cutout
                    success_count += 1
                    irsa_circuit_breaker.record_success()
                    continue
                if exc is not None:
                    last_exc = exc
                    if _is_non_recoverable_http_error(exc):
                        aborted_early = True
                        logger.warning(
                            "Aborting SPHEREx downloads on non-recoverable error at "
                            "ra=%.4f dec=%.4f: %s",
                            ra,
                            dec,
                            _concise_error_summary(exc),
                        )
                        for rem in pending:
                            rem.cancel()
                        pending = set()
                        break

                    if _is_transient_upstream_error(exc):
                        transient_failures += 1

                    should_trip = (
                        success_count == 0
                        and transient_failures >= DEFAULT_CIRCUIT_BREAKER_THRESHOLD
                    ) or transient_failures >= DEFAULT_CIRCUIT_BREAKER_THRESHOLD + 1
                    if should_trip:
                        aborted_early = True
                        abort_event.set()
                        logger.warning(
                            "Trip SPHEREx circuit breaker after %d transient failures at "
                            "ra=%.4f dec=%.4f; cancelling %d pending cutout(s).",
                            transient_failures,
                            ra,
                            dec,
                            len(pending),
                        )
                        irsa_circuit_breaker.record_failure(
                            f"cutouts:{_concise_error_summary(exc)}"
                        )
                        for rem in pending:
                            rem.cancel()
                        pending = set()
                        break
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
        with worker_sessions_lock:
            for ws in worker_sessions:
                try:
                    ws.close()
                except Exception:
                    pass

    cutouts = [c for c in results if c is not None]
    if not cutouts and not allow_synthetic_fallback:
        if last_exc is not None:
            raise last_exc
        raise SpherexDownloadError("All SPHEREx cutout downloads failed or timed out.")

    if allow_synthetic_fallback and (aborted_early or len(cutouts) < len(selected_observations)):
        present_bands = {c.bandpass for c in cutouts}
        if not cutouts:
            cutouts = [
                fallback_cutout(
                    ra=ra,
                    dec=dec,
                    fov_arcmin=fov_arcmin,
                    bandpass=bandpass,
                    fixture_dir=fixture_dir,
                    seed=index,
                )
                for index, bandpass in enumerate(bandpasses)
            ]
        else:
            for index, obs in enumerate(selected_observations):
                if results[index] is None and obs.bandpass not in present_bands:
                    present_bands.add(obs.bandpass)
                    cutouts.append(
                        fallback_cutout(
                            ra=ra,
                            dec=dec,
                            fov_arcmin=fov_arcmin,
                            bandpass=obs.bandpass,
                            fixture_dir=fixture_dir,
                            mjd_obs=obs.mjd_obs or 60000.0,
                        )
                    )

    logger.info(
        "Ingested %d SPHEREx cutout(s) at ra=%.4f dec=%.4f (sources=%s)",
        len(cutouts),
        ra,
        dec,
        ",".join(sorted({c.source for c in cutouts})),
    )
    return cutouts


async def ingest_spherex_cutouts_async(
    ra: float,
    dec: float,
    fov_arcmin: float,
    bandpasses: tuple[str, ...] = SPHEREX_BANDPASSES,
    fixture_dir: str | os.PathLike | None = None,
    allow_synthetic_fallback: bool = True,
    client: httpx.AsyncClient | None = None,
    timeout: float = DEFAULT_HTTP_TIMEOUT,
) -> list[SpherexCutout]:
    """Async variant of :func:`ingest_spherex_cutouts`.

    Args:
        ra: Field center Right Ascension in degrees.
        dec: Field center Declination in degrees.
        fov_arcmin: Field of view in arcminutes.
        bandpasses: Tuple of SPHEREx bandpasses to ingest.
        fixture_dir: Optional directory containing cached FITS fixtures.
        allow_synthetic_fallback: Whether to fall back to local fixtures or
            synthetic cutouts when IRSA is unavailable.
        client: Optional shared :class:`httpx.AsyncClient`.
        timeout: Per-download timeout in seconds.

    Returns:
        List of cleaned :class:`SpherexCutout` instances.

    Raises:
        SpherexIngestError: If ``allow_synthetic_fallback`` is ``False`` and
            IRSA is unreachable or downloads fail.
    """
    validate_coordinates(ra, dec, fov_arcmin)

    try:
        if offline_requested():
            raise SpherexIngestError("IRSA access disabled by environment.")
        observations = await asyncio.to_thread(
            query_observations,
            ra=ra,
            dec=dec,
            fov_arcmin=fov_arcmin,
            bandpasses=bandpasses,
        )
    except Exception as exc:
        if not allow_synthetic_fallback:
            raise SpherexIngestError(
                f"IRSA is unreachable and no cached fixtures exist: {exc}"
            ) from exc
        observations = []

    if not observations:
        if not allow_synthetic_fallback:
            raise SpherexIngestError("No SPHEREx observations cover the requested position.")
        return [
            fallback_cutout(
                ra=ra,
                dec=dec,
                fov_arcmin=fov_arcmin,
                bandpass=bandpass,
                fixture_dir=fixture_dir,
                seed=index,
            )
            for index, bandpass in enumerate(bandpasses)
        ]

    payloads = await download_cutouts_async(
        observations,
        ra=ra,
        dec=dec,
        fov_arcmin=fov_arcmin,
        client=client,
        timeout=timeout,
    )

    cutouts: list[SpherexCutout] = []
    for observation, payload in zip(observations, payloads, strict=True):
        if payload is None:
            if not allow_synthetic_fallback:
                raise SpherexDownloadError(f"Failed to download cutout {observation.uri}.")
            cutout = fallback_cutout(
                ra=ra,
                dec=dec,
                fov_arcmin=fov_arcmin,
                bandpass=observation.bandpass,
                fixture_dir=fixture_dir,
                mjd_obs=observation.mjd_obs or 60000.0,
            )
        else:
            cutout = process_spherex_fits(
                payload,
                bandpass=observation.bandpass,
                uri=observation.uri,
                source_name="irsa",
            )
        cutouts.append(cutout)

    return cutouts
