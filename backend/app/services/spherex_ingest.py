"""
SPHEREx IRSA cutout ingestion and preprocessing.

Responsibilities:
- Query SPHEREx observations from IRSA.
- Retrieve FITS cutouts asynchronously.
- Subtract zodiacal background (IMAGE - ZODI).
- Extract variance and observation metadata.
- Convert native SPHEREx flags into the application hygiene mask.
"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from dataclasses import dataclass, field
import io
import os
from pathlib import Path
from typing import Any, BinaryIO, Iterable, Iterator, Optional, Sequence, Union

import numpy as np
import requests
from astropy.io import fits
from astropy.time import Time

try:
    from pyvo.dal import TAPService
except ImportError:  # pragma: no cover
    TAPService = None  # type: ignore[assignment,misc]


# ---------------------------------------------------------
# Configuration
# ---------------------------------------------------------

IRSA_TAP_URL = "https://irsa.ipac.caltech.edu/TAP/"
IRSA_BASE_URL = "https://irsa.ipac.caltech.edu/"

SPHEREX_BANDPASSES = (
    "SPHEREx-D1",
    "SPHEREx-D2",
    "SPHEREx-D3",
    "SPHEREx-D4",
    "SPHEREx-D5",
    "SPHEREx-D6",
)

DEFAULT_HTTP_TIMEOUT = 30.0
DEFAULT_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024


class TimeoutSession(requests.Session):
    """Requests session with bounded connection and response timeouts."""

    def request(self, method, url, **kwargs):
        kwargs.setdefault("timeout", (10, 60))
        return super().request(method, url, **kwargs)


# Application-level hygiene mask bits.
FLAG_TRANSIENT = np.uint8(1)
FLAG_SATURATED = np.uint8(2)
FLAG_BAD_REFERENCE = np.uint8(4)
FLAG_STRAY_LIGHT = np.uint8(8)

HYGIENE_FLAG_BITS = {
    "TRANSIENT_OR_COSMIC_RAY": int(FLAG_TRANSIENT),
    "SATURATED_PIXEL": int(FLAG_SATURATED),
    "DEAD_OR_BAD_REFERENCE": int(FLAG_BAD_REFERENCE),
    "STRAY_LIGHT_OR_BORDER": int(FLAG_STRAY_LIGHT),
}

# Native SPHEREx Level 2 flag bit numbers (SPHEREx Explanatory Supplement,
# Table 16).  The first four entries also make the low byte of the raw FLAGS
# bitmap directly usable by clients that provide simplified fixture masks.
SPHEREX_FLAG_BITS = {
    "TRANSIENT": 0,
    "OVERFLOW": 1,
    "SUR_ERROR": 2,
    "NONFUNC": 6,
    "DICHROIC": 7,
    "MISSING_DATA": 9,
    "HOT": 10,
    "COLD": 11,
    "FULLSAMPLE": 12,
    "PHANMISS": 14,
    "NONLINEAR": 15,
    "PERSIST": 17,
    "OUTLIER": 19,
    "CROSSTALK": 20,
    "SOURCE": 21,
    "GHOST": 22,
    "GHOST_FPA": 23,
    "GHOST_EXT": 24,
    "STREAK": 25,
    "BLOOM": 26,
    "SNOWBALL": 27,
    "HALO": 28,
    "SATELLITE_HALO": 29,
}

SPHEREX_FLAG_GROUPS = {
    "TRANSIENT_OR_COSMIC_RAY": (
        "TRANSIENT",
        "OUTLIER",
        "STREAK",
        "SNOWBALL",
    ),
    "SATURATED_PIXEL": (
        "OVERFLOW",
        "NONLINEAR",
        "BLOOM",
    ),
    "DEAD_OR_BAD_REFERENCE": (
        "SUR_ERROR",
        "NONFUNC",
        "DICHROIC",
        "MISSING_DATA",
        "HOT",
        "COLD",
        "FULLSAMPLE",
        "PHANMISS",
        "PERSIST",
        "CROSSTALK",
    ),
    "STRAY_LIGHT_OR_BORDER": (
        "GHOST",
        "GHOST_FPA",
        "GHOST_EXT",
        "HALO",
        "SATELLITE_HALO",
    ),
}

FITS_SOURCE = Union[str, os.PathLike, bytes, bytearray, memoryview, BinaryIO, fits.HDUList]


# ---------------------------------------------------------
# Exceptions
# ---------------------------------------------------------

class SpherexIngestError(Exception):
    """Base exception for SPHEREx ingestion failures."""


class SpherexValidationError(SpherexIngestError):
    """Raised when observation query parameters are invalid."""


class SpherexDownloadError(SpherexIngestError):
    """Raised when an IRSA cutout cannot be downloaded."""


class SpherexProcessingError(SpherexIngestError):
    """Raised when a FITS cutout cannot be processed."""


# ---------------------------------------------------------
# Data structures
# ---------------------------------------------------------

@dataclass(frozen=True)
class SpherexObservation:
    """Metadata describing one SPHEREx observation."""

    uri: str
    bandpass: str
    time_bounds_lower: Optional[str] = None
    mjd_obs: Optional[float] = None


@dataclass
class SpherexCutout:
    """Processed SPHEREx FITS cutout."""

    clean_image: np.ndarray
    variance: np.ndarray
    weight_map: np.ndarray
    flags_mask: np.ndarray
    mjd_obs: float
    bandpass: str
    uri: Optional[str] = None
    source: str = "fits"
    header: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------
# Input validation
# ---------------------------------------------------------

def validate_coordinates(
    ra: float,
    dec: float,
    fov_arcmin: float,
) -> None:
    """
    Validate sky coordinates and field of view.

    RA: 0 <= RA < 360 degrees
    Dec: -90 <= Dec <= 90 degrees
    FOV: positive arcminutes
    """

    values = np.asarray(
        [ra, dec, fov_arcmin],
        dtype=np.float64,
    )

    if not np.all(np.isfinite(values)):
        raise SpherexValidationError(
            "Coordinates and field of view must be finite numbers."
        )

    if not 0.0 <= ra < 360.0:
        raise SpherexValidationError(
            "Right Ascension must be between 0 and 360 degrees."
        )

    if not -90.0 <= dec <= 90.0:
        raise SpherexValidationError(
            "Declination must be between -90 and 90 degrees."
        )

    if fov_arcmin <= 0.0:
        raise SpherexValidationError(
            "Field of view must be greater than zero."
        )


def build_adql_query(
    ra: float,
    dec: float,
    fov_arcmin: float,
    bandpasses: tuple[str, ...] = SPHEREX_BANDPASSES,
) -> str:
    """
    Build an IRSA ADQL query for SPHEREx cutouts.

    The query returns:
    - Cutout download URI
    - Bandpass
    - Observation start time
    """

    validate_coordinates(ra, dec, fov_arcmin)

    if not bandpasses:
        raise SpherexValidationError(
            "At least one bandpass must be provided."
        )

    invalid_bandpasses = [
        band for band in bandpasses
        if band not in SPHEREX_BANDPASSES
    ]

    if invalid_bandpasses:
        raise SpherexValidationError(
            f"Unsupported SPHEREx bandpasses: {invalid_bandpasses}"
        )

    fov_deg = fov_arcmin / 60.0

    bandpass_list = ", ".join(
        f"'{band}'" for band in bandpasses
    )

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


def _mjd_from_time_value(value: Any) -> Optional[float]:
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
    """
    Query IRSA TAP for SPHEREx observations covering a sky position.

    Returns observation metadata including the cutout URL,
    bandpass, and observation start time.
    """

    query = build_adql_query(
        ra=ra,
        dec=dec,
        fov_arcmin=fov_arcmin,
        bandpasses=bandpasses,
    )

    if TAPService is None:  # pragma: no cover
        raise SpherexIngestError(
            "pyvo is required to query the IRSA TAP service."
        )

    try:
        with TimeoutSession() as session:
            service = TAPService(
                IRSA_TAP_URL,
                session=session,
            )
            results = service.search(query)
            table = results.to_table()

        observations = []

        for row in table:
            uri = str(row["uri"])
            bandpass = str(row["bandpass"])

            try:
                time_value = row["time_bounds_lower"]
            except Exception:
                time_value = None

            if time_value is None or np.ma.is_masked(time_value):
                time_value = None
                mjd_obs = None
            else:
                time_value = str(time_value)
                mjd_obs = _mjd_from_time_value(time_value)

            observations.append(
                SpherexObservation(
                    uri=uri,
                    bandpass=bandpass,
                    time_bounds_lower=time_value,
                    mjd_obs=mjd_obs,
                )
            )

        return observations

    except Exception as exc:
        raise SpherexIngestError(
            f"IRSA TAP query failed: {exc}"
        ) from exc


# ---------------------------------------------------------
# URL construction & downloads
# ---------------------------------------------------------

def build_cutout_url(
    uri: str,
    ra: float,
    dec: float,
    fov_arcmin: float,
) -> str:
    """Build an IRSA cutout URL for an artifact URI."""

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
    session: Optional[requests.Session] = None,
    timeout: float = DEFAULT_HTTP_TIMEOUT,
    max_bytes: int = DEFAULT_MAX_DOWNLOAD_BYTES,
) -> bytes:
    """Download one SPHEREx MEF cutout synchronously."""

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
        raise SpherexDownloadError(
            f"Failed to download SPHEREx cutout {url}: {exc}"
        ) from exc
    finally:
        if owns_session:
            http.close()

    if not data:
        raise SpherexDownloadError(
            f"IRSA returned an empty SPHEREx cutout for {url}."
        )

    return data


async def download_cutout_async(
    uri: str,
    ra: float,
    dec: float,
    fov_arcmin: float,
    client: Any = None,
    timeout: float = DEFAULT_HTTP_TIMEOUT,
    max_bytes: int = DEFAULT_MAX_DOWNLOAD_BYTES,
) -> bytes:
    """Download one SPHEREx MEF cutout using an async HTTP client."""

    try:
        import httpx
    except ImportError as exc:  # pragma: no cover
        raise SpherexDownloadError(
            "httpx is required for asynchronous cutout downloads."
        ) from exc

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
        raise SpherexDownloadError(
            f"Failed to download SPHEREx cutout {url}: {exc}"
        ) from exc
    finally:
        if owns_client:
            await http.aclose()

    if len(data) > max_bytes:
        raise SpherexDownloadError(
            f"Cutout exceeds maximum download size of {max_bytes} bytes."
        )
    if not data:
        raise SpherexDownloadError(
            f"IRSA returned an empty SPHEREx cutout for {url}."
        )

    return data


async def download_cutouts_async(
    observations: Sequence[SpherexObservation],
    ra: float,
    dec: float,
    fov_arcmin: float,
    client: Any = None,
    timeout: float = DEFAULT_HTTP_TIMEOUT,
    max_bytes: int = DEFAULT_MAX_DOWNLOAD_BYTES,
) -> list[Optional[bytes]]:
    """Download several cutouts concurrently, returning None on failure."""

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
    return [
        None if isinstance(result, BaseException) else result
        for result in results
    ]


download_cutouts = download_cutouts_async


# ---------------------------------------------------------
# Flag hygiene mapping
# ---------------------------------------------------------

def _as_uint32_bitmap(flags: Any) -> tuple[np.ndarray, np.ndarray]:
    flag_array = np.asarray(flags)

    if np.issubdtype(flag_array.dtype, np.floating):
        invalid = ~np.isfinite(flag_array)
        safe = np.nan_to_num(
            flag_array,
            nan=0.0,
            posinf=0.0,
            neginf=0.0,
        )
        raw = (
            safe.astype(np.int64, copy=False)
            & np.int64(0xFFFFFFFF)
        ).astype(np.uint32)
        return raw, invalid

    if flag_array.dtype == np.uint32:
        raw = flag_array
    elif flag_array.dtype == np.int32:
        raw = flag_array.view(np.uint32)
    else:
        raw = (
            flag_array.astype(np.int64, copy=False)
            & np.int64(0xFFFFFFFF)
        ).astype(np.uint32)

    return raw, np.zeros(flag_array.shape, dtype=bool)


def map_flags_to_hygiene(flags: Any) -> np.ndarray:
    """
    Map the 32-bit SPHEREx FLAGS bitmap to the 8-bit web hygiene mask.

    Output bits:
    - 1: transient / cosmic ray
    - 2: saturated
    - 4: dead / bad reference / corrupted
    - 8: stray light / border / ghost
    """

    raw, invalid = _as_uint32_bitmap(flags)
    mask = np.zeros(raw.shape, dtype=np.uint8)

    bit_values = {
        "TRANSIENT_OR_COSMIC_RAY": FLAG_TRANSIENT,
        "SATURATED_PIXEL": FLAG_SATURATED,
        "DEAD_OR_BAD_REFERENCE": FLAG_BAD_REFERENCE,
        "STRAY_LIGHT_OR_BORDER": FLAG_STRAY_LIGHT,
    }

    for group, names in SPHEREX_FLAG_GROUPS.items():
        value = bit_values[group]
        for name in names:
            bit = np.uint32(SPHEREX_FLAG_BITS[name])
            selected = ((raw >> bit) & np.uint32(1)).astype(bool)
            mask[selected] |= value

    low_byte = (raw & np.uint32(0x0F)).astype(np.uint8)
    mask |= low_byte

    if invalid.any():
        mask[invalid] |= FLAG_BAD_REFERENCE

    return mask


map_flags_mask = map_flags_to_hygiene
extract_hygiene_mask = map_flags_to_hygiene
hygiene_mask_from_flags = map_flags_to_hygiene


# ---------------------------------------------------------
# FITS reading & cleaning
# ---------------------------------------------------------

def _normalize_source(source: FITS_SOURCE) -> Any:
    if isinstance(source, (bytes, bytearray, memoryview)):
        return io.BytesIO(bytes(source))
    if hasattr(source, "read"):
        try:
            source.seek(0)
        except Exception:
            pass
        return source
    return os.fspath(source)


@contextmanager
def _open_fits(source: FITS_SOURCE) -> Iterator[fits.HDUList]:
    if isinstance(source, fits.HDUList):
        yield source
        return

    normalized = _normalize_source(source)
    hdulist = fits.open(
        normalized,
        memmap=False,
        cache=False,
        lazy_load_hdus=True,
    )
    try:
        yield hdulist
    finally:
        hdulist.close()


def _find_hdu(
    hdulist: fits.HDUList,
    name: str,
    fallback_indices: Iterable[int] = (),
) -> fits.hdu.base.ExtensionHDU:
    wanted = name.strip().upper()
    for hdu in hdulist:
        if str(getattr(hdu, "name", "")).strip().upper() == wanted:
            return hdu

    for index in fallback_indices:
        if 0 <= index < len(hdulist):
            return hdulist[index]

    raise SpherexProcessingError(
        f"SPHEREx FITS file is missing the {name!r} extension."
    )


def _extension_array(hdu: Any, name: str) -> np.ndarray:
    if hdu.data is None:
        raise SpherexProcessingError(
            f"SPHEREx {name!r} extension has no data."
        )
    return np.asarray(hdu.data)


def _header_value(
    hdulist: fits.HDUList,
    keys: Sequence[str],
) -> Any:
    for hdu in hdulist:
        header = getattr(hdu, "header", None)
        if header is None:
            continue
        for key in keys:
            try:
                if key in header:
                    return header[key]
            except Exception:
                continue
    return None


def _extract_mjd_obs(hdulist: fits.HDUList) -> float:
    value = _header_value(
        hdulist,
        ("MJD-OBS", "MJD_OBS", "MJD"),
    )

    if value is not None:
        try:
            return float(value)
        except (TypeError, ValueError):
            pass

    start = _header_value(hdulist, ("MJD-BEG", "MJD_BEG"))
    end = _header_value(hdulist, ("MJD-END", "MJD_END"))
    try:
        if start is not None and end is not None:
            return (float(start) + float(end)) / 2.0
        if start is not None:
            return float(start)
    except (TypeError, ValueError):
        pass

    date_obs = _header_value(hdulist, ("DATE-OBS", "DATE_OBS"))
    if date_obs is not None:
        try:
            return float(Time(str(date_obs), scale="utc").mjd)
        except Exception:
            pass

    raise SpherexProcessingError(
        "SPHEREx FITS header does not contain MJD-OBS or an equivalent "
        "observation time."
    )


def _detector_to_bandpass(value: Any) -> Optional[str]:
    try:
        detector = int(value)
    except (TypeError, ValueError):
        return None
    if 1 <= detector <= 6:
        return f"SPHEREx-D{detector}"
    return None


def _extract_bandpass(hdulist: fits.HDUList, requested: Optional[str]) -> str:
    if requested:
        return str(requested)

    value = _header_value(
        hdulist,
        ("BANDPASS", "ENERGY_BANDPASSNAME", "BAND"),
    )
    if value is not None:
        text = str(value).strip()
        if text:
            mapped = _detector_to_bandpass(text)
            return mapped or text

    detector = _header_value(hdulist, ("DETECTOR", "DETECTOR_ID"))
    mapped = _detector_to_bandpass(detector)
    if mapped:
        return mapped

    return "unknown"


def _build_cutout(
    image: np.ndarray,
    zodi: np.ndarray,
    variance: np.ndarray,
    raw_flags: np.ndarray,
    mjd_obs: float,
    bandpass: str,
    uri: Optional[str],
    source: str,
    header: Optional[dict[str, Any]] = None,
    flags_invalid: Optional[np.ndarray] = None,
) -> SpherexCutout:
    image = np.asarray(image, dtype=np.float32)
    zodi = np.asarray(zodi, dtype=np.float32)
    variance = np.asarray(variance, dtype=np.float32)

    if image.shape != zodi.shape:
        raise SpherexProcessingError(
            "IMAGE and ZODI extensions must have the same shape "
            f"({image.shape} != {zodi.shape})."
        )
    if variance.shape != image.shape:
        raise SpherexProcessingError(
            "VARIANCE extension must match IMAGE shape "
            f"({variance.shape} != {image.shape})."
        )

    raw_bitmap, raw_invalid = _as_uint32_bitmap(raw_flags)
    if raw_bitmap.shape != image.shape:
        raise SpherexProcessingError(
            "FLAGS extension must match IMAGE shape "
            f"({raw_bitmap.shape} != {image.shape})."
        )

    if flags_invalid is not None:
        raw_invalid = np.logical_or(
            raw_invalid,
            np.asarray(flags_invalid, dtype=bool),
        )

    flags_mask = map_flags_to_hygiene(raw_bitmap)

    with np.errstate(invalid="ignore", over="ignore"):
        clean_image = image - zodi

    image_invalid = ~np.isfinite(image)
    zodi_invalid = ~np.isfinite(zodi)
    variance_invalid = ~np.isfinite(variance) | (variance < 0.0)
    clean_invalid = ~np.isfinite(clean_image)

    corrupted = (
        image_invalid
        | zodi_invalid
        | variance_invalid
        | clean_invalid
        | raw_invalid
    )

    flags_mask = flags_mask.astype(np.uint8, copy=True)
    if corrupted.any():
        flags_mask[corrupted] |= FLAG_BAD_REFERENCE

    clean_image = np.array(clean_image, dtype=np.float32, copy=True)
    clean_image[corrupted] = 0.0

    variance_out = np.array(variance, dtype=np.float32, copy=True)
    variance_out[variance_invalid] = 0.0

    weight_map = np.zeros_like(variance_out, dtype=np.float32)
    usable = (
        ~corrupted
        & np.isfinite(clean_image)
        & np.isfinite(variance_out)
        & (variance_out > 0.0)
        & (flags_mask == 0)
    )
    weight_map[usable] = 1.0 / variance_out[usable]

    return SpherexCutout(
        clean_image=clean_image,
        variance=variance_out,
        weight_map=weight_map,
        flags_mask=flags_mask,
        mjd_obs=float(mjd_obs),
        bandpass=str(bandpass),
        uri=uri,
        source=source,
        header=dict(header or {}),
    )


def process_spherex_fits(
    source: FITS_SOURCE,
    bandpass: Optional[str] = None,
    uri: Optional[str] = None,
    source_name: str = "fits",
) -> SpherexCutout:
    """
    Clean one SPHEREx MEF cutout and extract its hygiene information.

    ``source`` may be a path, raw FITS bytes, a seekable binary file, or an
    already-open ``fits.HDUList``.  Files opened by this function are always
    closed before returning.
    """

    with _open_fits(source) as hdulist:
        image_hdu = _find_hdu(hdulist, "IMAGE", fallback_indices=(1,))
        zodi_hdu = _find_hdu(hdulist, "ZODI", fallback_indices=(4,))
        variance_hdu = _find_hdu(hdulist, "VARIANCE", fallback_indices=(3,))
        flags_hdu = _find_hdu(hdulist, "FLAGS", fallback_indices=(2,))

        image = np.array(
            _extension_array(image_hdu, "IMAGE"),
            dtype=np.float32,
            copy=True,
        )
        zodi = np.array(
            _extension_array(zodi_hdu, "ZODI"),
            dtype=np.float32,
            copy=True,
        )
        variance = np.array(
            _extension_array(variance_hdu, "VARIANCE"),
            dtype=np.float32,
            copy=True,
        )

        flags_data = _extension_array(flags_hdu, "FLAGS")
        raw_flags, flags_invalid = _as_uint32_bitmap(flags_data)

        mjd_obs = _extract_mjd_obs(hdulist)
        resolved_bandpass = _extract_bandpass(hdulist, bandpass)
        header = dict(getattr(image_hdu, "header", {}))

    return _build_cutout(
        image=image,
        zodi=zodi,
        variance=variance,
        raw_flags=raw_flags,
        mjd_obs=mjd_obs,
        bandpass=resolved_bandpass,
        uri=uri,
        source=source_name,
        header=header,
        flags_invalid=flags_invalid,
    )


def read_spherex_cutout(
    source: FITS_SOURCE,
    bandpass: Optional[str] = None,
    uri: Optional[str] = None,
    source_name: str = "fits",
) -> SpherexCutout:
    """Alias for :func:`process_spherex_fits`."""

    return process_spherex_fits(
        source,
        bandpass=bandpass,
        uri=uri,
        source_name=source_name,
    )


process_cutout = process_spherex_fits
load_spherex_cutout = process_spherex_fits


# ---------------------------------------------------------
# Synthetic fixtures & offline fallback
# ---------------------------------------------------------

def _synthetic_arrays(
    ra: float,
    dec: float,
    fov_arcmin: float,
    bandpass: str,
    shape: tuple[int, int],
    seed: Optional[int],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    height, width = shape
    rng = np.random.default_rng(
        seed if seed is not None else int(ra * 1000 + dec * 1000)
    )

    yy, xx = np.mgrid[0:height, 0:width]
    x_norm = (xx - (width - 1) / 2.0) / max(width, 1)
    y_norm = (yy - (height - 1) / 2.0) / max(height, 1)

    detector = 1
    mapped = _detector_to_bandpass(bandpass.split("-")[-1])
    if mapped:
        detector = int(mapped.split("-")[-1])

    background = 0.8 + 0.15 * detector
    image = (
        background
        + 0.4 * x_norm
        - 0.3 * y_norm
        + rng.normal(0.0, 0.01, size=shape)
    ).astype(np.float32)

    zodi = (
        0.35
        + 0.08 * np.cos(np.linspace(0.0, np.pi, width))[None, :]
        + 0.05 * np.sin(np.linspace(0.0, np.pi, height))[:, None]
    )
    zodi = np.broadcast_to(zodi, shape).astype(np.float32)

    variance = np.full(
        shape,
        0.0025,
        dtype=np.float32,
    ) * (1.0 + 0.05 * rng.random(shape)).astype(np.float32)

    flags = np.zeros(shape, dtype=np.uint32)
    flags[::17, ::19] |= np.uint32(1 << SPHEREX_FLAG_BITS["TRANSIENT"])
    flags[3::23, 5::29] |= np.uint32(1 << SPHEREX_FLAG_BITS["OVERFLOW"])
    flags[7::31, 11::37] |= np.uint32(1 << SPHEREX_FLAG_BITS["NONFUNC"])
    flags[13::41, 17::43] |= np.uint32(1 << SPHEREX_FLAG_BITS["GHOST"])

    return image, zodi, variance, flags


def build_synthetic_spherex_hdul(
    ra: float = 0.0,
    dec: float = 0.0,
    fov_arcmin: float = 5.0,
    bandpass: str = "SPHEREx-D1",
    shape: tuple[int, int] = (64, 64),
    mjd_obs: float = 60000.0,
    seed: Optional[int] = None,
) -> fits.HDUList:
    """Build a deterministic SPHEREx-like MEF for offline tests/fallback."""

    validate_coordinates(ra, dec, fov_arcmin)

    image, zodi, variance, flags = _synthetic_arrays(
        ra=ra,
        dec=dec,
        fov_arcmin=fov_arcmin,
        bandpass=bandpass,
        shape=shape,
        seed=seed,
    )

    primary = fits.PrimaryHDU()
    primary.header["MJD-OBS"] = float(mjd_obs)
    primary.header["BANDPASS"] = str(bandpass)
    primary.header["RA"] = float(ra)
    primary.header["DEC"] = float(dec)

    image_hdu = fits.ImageHDU(image, name="IMAGE")
    image_hdu.header["MJD-OBS"] = float(mjd_obs)
    image_hdu.header["BANDPASS"] = str(bandpass)
    image_hdu.header["BUNIT"] = "MJy/sr"

    flags_hdu = fits.ImageHDU(flags.astype(np.int32), name="FLAGS")

    variance_hdu = fits.ImageHDU(variance, name="VARIANCE")
    variance_hdu.header["BUNIT"] = "(MJy/sr)^2"

    zodi_hdu = fits.ImageHDU(zodi, name="ZODI")
    zodi_hdu.header["BUNIT"] = "MJy/sr"

    return fits.HDUList(
        [primary, image_hdu, flags_hdu, variance_hdu, zodi_hdu]
    )


def write_synthetic_spherex_fits(
    path: Union[str, os.PathLike],
    ra: float = 0.0,
    dec: float = 0.0,
    fov_arcmin: float = 5.0,
    bandpass: str = "SPHEREx-D1",
    shape: tuple[int, int] = (64, 64),
    mjd_obs: float = 60000.0,
    seed: Optional[int] = None,
) -> Path:
    """Write a synthetic SPHEREx MEF fixture to disk."""

    output = Path(path)
    hdulist = build_synthetic_spherex_hdul(
        ra=ra,
        dec=dec,
        fov_arcmin=fov_arcmin,
        bandpass=bandpass,
        shape=shape,
        mjd_obs=mjd_obs,
        seed=seed,
    )
    try:
        hdulist.writeto(output, overwrite=True, output_verify="ignore")
    finally:
        hdulist.close()
    return output


def generate_synthetic_spherex_cutout(
    ra: float = 0.0,
    dec: float = 0.0,
    fov_arcmin: float = 5.0,
    bandpass: str = "SPHEREx-D1",
    shape: tuple[int, int] = (64, 64),
    mjd_obs: float = 60000.0,
    seed: Optional[int] = None,
) -> SpherexCutout:
    """Create a processed synthetic SPHEREx cutout without touching IRSA."""

    hdulist = build_synthetic_spherex_hdul(
        ra=ra,
        dec=dec,
        fov_arcmin=fov_arcmin,
        bandpass=bandpass,
        shape=shape,
        mjd_obs=mjd_obs,
        seed=seed,
    )
    try:
        return process_spherex_fits(
            hdulist,
            bandpass=bandpass,
            source_name="synthetic",
        )
    finally:
        hdulist.close()


def _offline_requested() -> bool:
    value = os.environ.get(
        "SPHEREX_OFFLINE",
        os.environ.get("IRSA_OFFLINE", ""),
    )
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _find_cached_fixture(
    fixture_dir: Optional[Union[str, os.PathLike]],
    bandpass: str,
) -> Optional[Path]:
    if fixture_dir is None:
        fixture_dir = os.environ.get("SPHEREX_FIXTURE_DIR")
    if fixture_dir is None:
        return None

    directory = Path(fixture_dir)
    if not directory.is_dir():
        return None

    names = (
        f"{bandpass}.fits",
        f"{bandpass}.fits.gz",
        f"{bandpass.replace('SPHEREx-', '')}.fits",
        "cutout.fits",
        "default.fits",
        "fixture.fits",
    )
    for name in names:
        candidate = directory / name
        if candidate.is_file():
            return candidate
    return None


def _fallback_cutout(
    ra: float,
    dec: float,
    fov_arcmin: float,
    bandpass: str,
    fixture_dir: Optional[Union[str, os.PathLike]] = None,
    mjd_obs: float = 60000.0,
    seed: Optional[int] = None,
) -> SpherexCutout:
    fixture = _find_cached_fixture(fixture_dir, bandpass)
    if fixture is not None:
        try:
            return process_spherex_fits(
                fixture,
                bandpass=bandpass,
                source_name="fixture-cache",
            )
        except SpherexIngestError:
            pass

    return generate_synthetic_spherex_cutout(
        ra=ra,
        dec=dec,
        fov_arcmin=fov_arcmin,
        bandpass=bandpass,
        mjd_obs=mjd_obs,
        seed=seed,
    )


def ingest_spherex_cutouts(
    ra: float,
    dec: float,
    fov_arcmin: float,
    bandpasses: tuple[str, ...] = SPHEREX_BANDPASSES,
    fixture_dir: Optional[Union[str, os.PathLike]] = None,
    allow_synthetic_fallback: bool = True,
    session: Optional[requests.Session] = None,
    timeout: float = DEFAULT_HTTP_TIMEOUT,
) -> list[SpherexCutout]:
    """
    Query, download, and clean all SPHEREx cutouts covering a position.

    If IRSA is unreachable, or a cutout cannot be downloaded, cached fixtures
    or deterministic synthetic cutouts are returned when fallback is enabled.
    """

    validate_coordinates(ra, dec, fov_arcmin)

    observations: list[SpherexObservation] = []
    query_error: Optional[Exception] = None
    if _offline_requested():
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
                    f"IRSA is unreachable and no cached fixtures exist: "
                    f"{query_error}"
                ) from query_error
            raise SpherexIngestError(
                "No SPHEREx observations cover the requested position."
            )
        return [
            _fallback_cutout(
                ra=ra,
                dec=dec,
                fov_arcmin=fov_arcmin,
                bandpass=bandpass,
                fixture_dir=fixture_dir,
                seed=index,
            )
            for index, bandpass in enumerate(bandpasses)
        ]

    cutouts: list[SpherexCutout] = []
    for observation in observations:
        try:
            payload = download_cutout(
                observation.uri,
                ra=ra,
                dec=dec,
                fov_arcmin=fov_arcmin,
                session=session,
                timeout=timeout,
            )
            cutout = process_spherex_fits(
                payload,
                bandpass=observation.bandpass,
                uri=observation.uri,
                source_name="irsa",
            )
        except Exception:
            if not allow_synthetic_fallback:
                raise
            cutout = _fallback_cutout(
                ra=ra,
                dec=dec,
                fov_arcmin=fov_arcmin,
                bandpass=observation.bandpass,
                fixture_dir=fixture_dir,
                mjd_obs=observation.mjd_obs or 60000.0,
            )
        cutouts.append(cutout)

    return cutouts


async def ingest_spherex_cutouts_async(
    ra: float,
    dec: float,
    fov_arcmin: float,
    bandpasses: tuple[str, ...] = SPHEREX_BANDPASSES,
    fixture_dir: Optional[Union[str, os.PathLike]] = None,
    allow_synthetic_fallback: bool = True,
    client: Any = None,
    timeout: float = DEFAULT_HTTP_TIMEOUT,
) -> list[SpherexCutout]:
    """Async variant of :func:`ingest_spherex_cutouts`."""

    validate_coordinates(ra, dec, fov_arcmin)

    try:
        if _offline_requested():
            raise SpherexIngestError(
                "IRSA access disabled by environment."
            )
        observations = query_observations(
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
            raise SpherexIngestError(
                "No SPHEREx observations cover the requested position."
            )
        return [
            _fallback_cutout(
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
    for observation, payload in zip(observations, payloads):
        if payload is None:
            if not allow_synthetic_fallback:
                raise SpherexDownloadError(
                    f"Failed to download cutout {observation.uri}."
                )
            cutout = _fallback_cutout(
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


process_spherex_cutout = process_spherex_fits
clean_spherex_cutout = process_spherex_fits
map_spherex_flags = map_flags_to_hygiene
flags_to_hygiene_mask = map_flags_to_hygiene
download_spherex_cutout = download_cutout
query_spherex_observations = query_observations
ingest_spherex = ingest_spherex_cutouts
