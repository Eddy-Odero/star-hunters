"""SPHEREx IRSA TAP discovery and synchronous/asynchronous cutout ingestion."""

from __future__ import annotations

import asyncio
import os
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

IRSA_TAP_URL = "https://irsa.ipac.caltech.edu/TAP/"
IRSA_BASE_URL = "https://irsa.ipac.caltech.edu/"

DEFAULT_HTTP_TIMEOUT = 8.0
DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 3
DEFAULT_INGEST_BUDGET_SECONDS = 18.0
DEFAULT_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024


class TimeoutSession(requests.Session):
    """Requests session with bounded connection and response timeouts."""

    def request(self, method: str, url: str, **kwargs: Any) -> requests.Response:
        """Issue an HTTP request with a default ``(4, 8)`` second timeout tuple."""
        kwargs.setdefault("timeout", (4, 8))
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
            "429",
            "service unavailable",
            "bad gateway",
            "gateway timeout",
            "too many requests",
            "timed out",
            "timeout",
        )
    )


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


def query_observations(
    ra: float,
    dec: float,
    fov_arcmin: float,
    bandpasses: tuple[str, ...] = SPHEREX_BANDPASSES,
) -> list[SpherexObservation]:
    """Query IRSA TAP for SPHEREx observations covering a sky position.

    Args:
        ra: Right Ascension in degrees.
        dec: Declination in degrees.
        fov_arcmin: Field of view in arcminutes.
        bandpasses: Tuple of SPHEREx bandpass names to query.

    Returns:
        List of :class:`SpherexObservation` metadata records.

    Raises:
        SpherexValidationError: If query parameters are invalid.
        SpherexIngestError: If IRSA TAP query execution fails.
    """
    query = build_adql_query(
        ra=ra,
        dec=dec,
        fov_arcmin=fov_arcmin,
        bandpasses=bandpasses,
    )

    if TAPService is None:  # pragma: no cover
        raise SpherexIngestError("pyvo is required to query the IRSA TAP service.")

    try:
        logger.info(
            "Querying IRSA TAP for SPHEREx cutouts (ra=%.4f, dec=%.4f, fov_arcmin=%.2f)",
            ra,
            dec,
            fov_arcmin,
        )
        with TimeoutSession() as session:
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
            "IRSA SPHEREx TAP returned %d observation(s) at ra=%.4f dec=%.4f",
            len(observations),
            ra,
            dec,
        )
        return observations

    except Exception as exc:
        logger.warning("IRSA SPHEREx TAP query failed at ra=%.4f dec=%.4f: %s", ra, dec, exc)
        raise SpherexIngestError(f"IRSA TAP query failed: {exc}") from exc


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
    http = client or httpx.AsyncClient(
        timeout=httpx.Timeout(timeout),
        follow_redirects=True,
    )

    try:
        response = await http.get(url)
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
) -> list[SpherexCutout]:
    """Query, download, and clean all SPHEREx cutouts covering a sky position.

    If IRSA is unreachable or a cutout cannot be downloaded, cached fixtures or
    deterministic synthetic cutouts are returned when ``allow_synthetic_fallback``
    is enabled.

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

    Returns:
        List of cleaned :class:`SpherexCutout` instances.

    Raises:
        SpherexIngestError: If ``allow_synthetic_fallback`` is ``False`` and
            IRSA returns no observations or all downloads fail.
    """
    validate_coordinates(ra, dec, fov_arcmin)

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
            logger.info(
                "No live SPHEREx archival cutouts available at ra=%.4f dec=%.4f (%s)",
                ra,
                dec,
                query_error or "zero observations",
            )
            if query_error is not None:
                raise SpherexIngestError(
                    f"IRSA is unreachable and no cached fixtures exist: {query_error}"
                ) from query_error
            raise SpherexIngestError("No SPHEREx observations cover the requested position.")
        logger.info(
            "Falling back to SPHEREx local fixtures/synthetic cutouts at ra=%.4f dec=%.4f",
            ra,
            dec,
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

    results: list[SpherexCutout | None] = [None] * len(observations)
    effective_timeout = min(float(timeout), 8.0) if not allow_synthetic_fallback else float(timeout)
    workers = 1 if session is not None else min(6, max(1, len(observations)))
    last_exc: Exception | None = None
    transient_failures = 0
    deadline = time.monotonic() + DEFAULT_INGEST_BUDGET_SECONDS

    def _download_one(
        index: int, observation: SpherexObservation
    ) -> tuple[int, SpherexCutout | None, Exception | None]:
        try:
            payload = download_cutout(
                observation.uri,
                ra=ra,
                dec=dec,
                fov_arcmin=fov_arcmin,
                session=session,
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
                "Failed downloading SPHEREx cutout %s (%s): %s",
                observation.bandpass,
                observation.uri,
                exc,
            )
            if not allow_synthetic_fallback:
                return index, None, exc
            fallback = fallback_cutout(
                ra=ra,
                dec=dec,
                fov_arcmin=fov_arcmin,
                bandpass=observation.bandpass,
                fixture_dir=fixture_dir,
                mjd_obs=observation.mjd_obs or 60000.0,
            )
            return index, fallback, None

    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        pending = {pool.submit(_download_one, idx, obs) for idx, obs in enumerate(observations)}
        while pending:
            wait_sec = None if allow_synthetic_fallback else max(0.05, deadline - time.monotonic())
            done, pending = wait_futures(pending, timeout=wait_sec, return_when=FIRST_COMPLETED)
            if not done:
                logger.warning(
                    "SPHEREx download budget (%.1fs) reached at ra=%.4f dec=%.4f; short-circuiting "
                    "%d pending cutout(s).",
                    DEFAULT_INGEST_BUDGET_SECONDS,
                    ra,
                    dec,
                    len(pending),
                )
                for rem in pending:
                    rem.cancel()
                break

            for fut in done:
                idx, cutout, exc = fut.result()
                if cutout is not None:
                    results[idx] = cutout
                    continue
                if exc is not None:
                    last_exc = exc
                    if _is_transient_upstream_error(exc):
                        transient_failures += 1
                    if (
                        not allow_synthetic_fallback
                        and transient_failures >= DEFAULT_CIRCUIT_BREAKER_THRESHOLD
                    ):
                        logger.warning(
                            "Trip SPHEREx 503 circuit breaker after %d transient failures at "
                            "ra=%.4f dec=%.4f; cancelling %d pending cutout(s).",
                            transient_failures,
                            ra,
                            dec,
                            len(pending),
                        )
                        for rem in pending:
                            rem.cancel()
                        pending = set()
                        break
    finally:
        pool.shutdown(wait=False, cancel_futures=True)

    cutouts = [c for c in results if c is not None]
    if not cutouts and not allow_synthetic_fallback:
        if last_exc is not None:
            raise last_exc
        raise SpherexDownloadError("All SPHEREx cutout downloads failed or timed out.")

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
