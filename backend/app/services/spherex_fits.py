"""SPHEREx MEF FITS reading, ``IMAGE - ZODI`` cleaning, and cutout data contracts."""

from __future__ import annotations

import io
import os
from collections.abc import Iterable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, BinaryIO

import numpy as np
from astropy.io import fits
from astropy.time import Time

from app.models.contracts import NUM_DETECTORS
from app.services.spherex_flags import (
    FLAG_BAD_REFERENCE,
    as_uint32_bitmap,
    map_flags_to_hygiene,
)

SPHEREX_BANDPASSES = (
    "SPHEREx-D1",
    "SPHEREx-D2",
    "SPHEREx-D3",
    "SPHEREx-D4",
    "SPHEREx-D5",
    "SPHEREx-D6",
)

WCS_WAVE_HEADER_KEYS = (
    "WAVELEN",
    "WAVELENGTH",
    "WAVE",
    "WAVEMEAN",
    "LAMBDA",
    "CRVAL3",
    "CDELT3",
    "CRPIX3",
    "CTYPE3",
    "CUNIT3",
)

FITS_SOURCE = str | os.PathLike | bytes | bytearray | memoryview | BinaryIO | fits.HDUList


class SpherexIngestError(Exception):
    """Base exception for SPHEREx ingestion failures."""


class SpherexValidationError(SpherexIngestError):
    """Raised when observation query parameters are invalid."""


class SpherexDownloadError(SpherexIngestError):
    """Raised when an IRSA cutout cannot be downloaded."""


class SpherexProcessingError(SpherexIngestError):
    """Raised when a FITS cutout cannot be processed."""


@dataclass(frozen=True)
class SpherexObservation:
    """Metadata describing one SPHEREx observation discovered via IRSA TAP."""

    uri: str
    bandpass: str
    time_bounds_lower: str | None = None
    mjd_obs: float | None = None


@dataclass
class SpherexCutout:
    """Processed SPHEREx FITS cutout with zodiacal background subtracted."""

    clean_image: np.ndarray
    variance: np.ndarray
    weight_map: np.ndarray
    flags_mask: np.ndarray
    mjd_obs: float
    bandpass: str
    uri: str | None = None
    source: str = "fits"
    header: dict[str, Any] = field(default_factory=dict)


def validate_coordinates(
    ra: float,
    dec: float,
    fov_arcmin: float,
) -> None:
    """Validate sky coordinates and field of view.

    Args:
        ra: Right Ascension in degrees (``0 <= ra < 360``).
        dec: Declination in degrees (``-90 <= dec <= 90``).
        fov_arcmin: Field of view in arcminutes (``fov_arcmin > 0``).

    Raises:
        SpherexValidationError: If any coordinate or FOV is non-finite or out
            of bounds.
    """
    values = np.asarray(
        [ra, dec, fov_arcmin],
        dtype=np.float64,
    )

    if not np.all(np.isfinite(values)):
        raise SpherexValidationError("Coordinates and field of view must be finite numbers.")

    if not 0.0 <= ra < 360.0:
        raise SpherexValidationError("Right Ascension must be between 0 and 360 degrees.")

    if not -90.0 <= dec <= 90.0:
        raise SpherexValidationError("Declination must be between -90 and 90 degrees.")

    if fov_arcmin <= 0.0:
        raise SpherexValidationError("Field of view must be greater than zero.")


def detector_to_bandpass(value: Any) -> str | None:
    """Convert a 1-based SPHEREx detector integer to its bandpass name.

    Args:
        value: Raw detector identifier (e.g. ``1`` or ``"3"``).

    Returns:
        Canonical bandpass string (e.g. ``"SPHEREx-D1"``), or ``None`` if invalid.
    """
    try:
        detector = int(value)
    except (TypeError, ValueError):
        return None
    if 1 <= detector <= NUM_DETECTORS:
        return f"SPHEREx-D{detector}"
    return None


def _normalize_source(source: FITS_SOURCE) -> Any:
    """Normalize FITS input sources into a stream or filesystem path."""
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
    """Open a FITS source and ensure the HDUList is closed on exit."""
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
    """Locate a named FITS extension HDU with optional positional fallbacks."""
    wanted = name.strip().upper()
    for hdu in hdulist:
        if str(getattr(hdu, "name", "")).strip().upper() == wanted:
            return hdu

    for index in fallback_indices:
        if 0 <= index < len(hdulist):
            return hdulist[index]

    raise SpherexProcessingError(f"SPHEREx FITS file is missing the {name!r} extension.")


def _extension_array(hdu: Any, name: str) -> np.ndarray:
    """Extract the numpy data array from an HDU or raise if missing."""
    if hdu.data is None:
        raise SpherexProcessingError(f"SPHEREx {name!r} extension has no data.")
    return np.asarray(hdu.data)


def _header_value(
    hdulist: fits.HDUList,
    keys: Sequence[str],
) -> Any:
    """Return the first matching header keyword value across an HDUList."""
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
    """Extract the observation MJD from ``MJD-OBS``, ``MJD-BEG/END``, or ``DATE-OBS``."""
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
        "SPHEREx FITS header does not contain MJD-OBS or an equivalent observation time."
    )


def _extract_bandpass(hdulist: fits.HDUList, requested: str | None) -> str:
    """Resolve the SPHEREx bandpass identifier from request override or FITS headers."""
    if requested:
        return str(requested)

    value = _header_value(
        hdulist,
        ("BANDPASS", "ENERGY_BANDPASSNAME", "BAND"),
    )
    if value is not None:
        text = str(value).strip()
        if text:
            mapped = detector_to_bandpass(text)
            return mapped or text

    detector = _header_value(hdulist, ("DETECTOR", "DETECTOR_ID"))
    mapped = detector_to_bandpass(detector)
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
    uri: str | None,
    source: str,
    header: dict[str, Any] | None = None,
    flags_invalid: np.ndarray | None = None,
) -> SpherexCutout:
    """Apply ``IMAGE - ZODI``, sanitize invalid pixels, and build :class:`SpherexCutout`."""
    image = np.asarray(image, dtype=np.float32)
    zodi = np.asarray(zodi, dtype=np.float32)
    variance = np.asarray(variance, dtype=np.float32)

    if image.shape != zodi.shape:
        raise SpherexProcessingError(
            f"IMAGE and ZODI extensions must have the same shape ({image.shape} != {zodi.shape})."
        )
    if variance.shape != image.shape:
        raise SpherexProcessingError(
            f"VARIANCE extension must match IMAGE shape ({variance.shape} != {image.shape})."
        )

    raw_bitmap, raw_invalid = as_uint32_bitmap(raw_flags)
    if raw_bitmap.shape != image.shape:
        raise SpherexProcessingError(
            f"FLAGS extension must match IMAGE shape ({raw_bitmap.shape} != {image.shape})."
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

    corrupted = image_invalid | zodi_invalid | variance_invalid | clean_invalid | raw_invalid

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


def _wcs_wave_header(hdulist: fits.HDUList) -> dict[str, Any]:
    """Copy spectral wavelength metadata from an optional ``WCS-WAVE`` extension."""
    try:
        hdu = _find_hdu(hdulist, "WCS-WAVE")
    except SpherexProcessingError:
        return {}

    header: dict[str, Any] = {}
    for key in WCS_WAVE_HEADER_KEYS:
        try:
            if key in hdu.header:
                header[key] = hdu.header[key]
        except Exception:
            continue
    return header


def process_spherex_fits(
    source: FITS_SOURCE,
    bandpass: str | None = None,
    uri: str | None = None,
    source_name: str = "fits",
) -> SpherexCutout:
    """Clean one SPHEREx MEF cutout and extract its hygiene information.

    Args:
        source: File path, raw FITS bytes, seekable binary stream, or open
            ``fits.HDUList``. Files opened by this function are always closed
            before returning.
        bandpass: Optional bandpass override (e.g. ``"SPHEREx-D1"``).
        uri: Optional source artifact URI for provenance tracking.
        source_name: Provenance label assigned to the returned cutout.

    Returns:
        Cleaned :class:`SpherexCutout` with ``IMAGE - ZODI`` subtraction,
        inverse-variance weight map, and 8-bit hygiene mask.

    Raises:
        SpherexProcessingError: If required FITS extensions or metadata are
            missing or malformed.
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
        raw_flags, flags_invalid = as_uint32_bitmap(flags_data)

        mjd_obs = _extract_mjd_obs(hdulist)
        resolved_bandpass = _extract_bandpass(hdulist, bandpass)
        header = dict(getattr(image_hdu, "header", {}))
        header.update(_wcs_wave_header(hdulist))

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
