"""Shared astronomical coordinate, WCS, time-scale, and environment utilities."""

from __future__ import annotations

import math
import os
from datetime import UTC, datetime, timedelta
from typing import Any

from app.models.contracts import GRID_HEIGHT, GRID_WIDTH

MJD_EPOCH = datetime(1858, 11, 17, 0, 0, 0, tzinfo=UTC)
GAIA_DR3_REF_YEAR = 2016.0


def offline_requested() -> bool:
    """Return True when offline archive mode is enabled via environment variables.

    Checks ``SPHEREX_OFFLINE`` and ``IRSA_OFFLINE`` in priority order, ignoring
    unset or blank values, for truthy strings (``"1"``, ``"true"``, ``"yes"``,
    ``"on"``).

    Returns:
        ``True`` if live archival network access is disabled, otherwise ``False``.
    """
    for env_var in ("SPHEREX_OFFLINE", "IRSA_OFFLINE"):
        raw = os.environ.get(env_var, "").strip().lower()
        if raw:
            return raw in {"1", "true", "yes", "on"}
    return False


def datetime_to_mjd(dt: datetime | None = None) -> float:
    """Convert a datetime (defaulting to current UTC time) to Modified Julian Date.

    Args:
        dt: Datetime to convert; naive datetimes are treated as UTC and ``None``
            uses ``datetime.now(UTC)``.

    Returns:
        Modified Julian Date as a floating-point day count since 1858-11-17.
    """
    target = dt if dt is not None else datetime.now(UTC)
    if target.tzinfo is None:
        target = target.replace(tzinfo=UTC)
    else:
        target = target.astimezone(UTC)
    return (target - MJD_EPOCH).total_seconds() / 86400.0


def mjd_to_iso(mjd: float) -> str:
    """Convert a Modified Julian Date (MJD) to an ISO-8601 UTC timestamp.

    Args:
        mjd: Modified Julian Date.

    Returns:
        UTC timestamp formatted as ``YYYY-MM-DDTHH:MM:SSZ``.
    """
    return (MJD_EPOCH + timedelta(days=float(mjd))).strftime("%Y-%m-%dT%H:%M:%SZ")


def mjd_to_date_bucket(mjd: float) -> str:
    """Convert a Modified Julian Date (MJD) to an ISO UTC date bucket.

    Args:
        mjd: Modified Julian Date.

    Returns:
        UTC date string formatted as ``YYYY-MM-DD``.
    """
    dt = MJD_EPOCH + timedelta(days=float(mjd))
    return dt.date().isoformat()


def iso_to_mjd(iso_or_horizons_date: str) -> float:
    """Parse an ISO-8601 or JPL Horizons date string into UTC Modified Julian Date.

    Args:
        iso_or_horizons_date: Timestamp such as ``"2025-05-01T00:00:00Z"`` or
            ``"2025-May-01 00:00"``.

    Returns:
        UTC Modified Julian Date.

    Raises:
        ValueError: If the date string cannot be parsed by any supported format.
    """
    cleaned = iso_or_horizons_date.strip()
    for fmt in (
        "%Y-%b-%d %H:%M",
        "%Y-%b-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
    ):
        try:
            dt = datetime.strptime(cleaned, fmt).replace(tzinfo=UTC)
            return datetime_to_mjd(dt)
        except ValueError:
            continue
    dt = datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
    return datetime_to_mjd(dt)


def mjd_to_julian_year(mjd: float) -> float:
    """Convert Modified Julian Date (MJD) to Julian year (e.g. MJD 57388.5 -> J2016.0).

    Args:
        mjd: Modified Julian Date.

    Returns:
        Julian year value.
    """
    return 2000.0 + (float(mjd) - 51544.5) / 365.25


def angular_separation_deg(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    """Compute great-circle angular separation between two ICRS coordinates.

    Args:
        ra1: First Right Ascension in degrees.
        dec1: First Declination in degrees.
        ra2: Second Right Ascension in degrees.
        dec2: Second Declination in degrees.

    Returns:
        Angular separation in degrees using the haversine formula.
    """
    ra1_r = math.radians(ra1)
    dec1_r = math.radians(dec1)
    ra2_r = math.radians(ra2)
    dec2_r = math.radians(dec2)
    dra = ra2_r - ra1_r
    ddec = dec2_r - dec1_r
    sin_ddec = math.sin(ddec / 2.0)
    sin_dra = math.sin(dra / 2.0)
    a = sin_ddec * sin_ddec + math.cos(dec1_r) * math.cos(dec2_r) * sin_dra * sin_dra
    return math.degrees(2.0 * math.asin(min(1.0, math.sqrt(max(0.0, a)))))


def propagate_proper_motion(
    ra_deg: float,
    dec_deg: float,
    pmra_mas_yr: float | None,
    pmdec_mas_yr: float | None,
    target_mjd: float,
    ref_year: float = GAIA_DR3_REF_YEAR,
) -> tuple[float, float]:
    """Propagate ICRS coordinates from a reference epoch to ``target_mjd``.

    Assumes ``pmra_mas_yr`` follows the Gaia DR3 convention
    ``mu_alpha* = mu_alpha * cos(dec)`` in milliarcseconds per year.

    Args:
        ra_deg: Reference Right Ascension in degrees.
        dec_deg: Reference Declination in degrees.
        pmra_mas_yr: Proper motion in Right Ascension (mas/yr), or ``None``.
        pmdec_mas_yr: Proper motion in Declination (mas/yr), or ``None``.
        target_mjd: Target observation Modified Julian Date.
        ref_year: Reference epoch in Julian years (default ``2016.0``).

    Returns:
        Tuple of ``(ra_epoch_deg, dec_epoch_deg)`` normalized to ``[0, 360)``
        and ``[-90, 90]``.
    """
    dt_yr = mjd_to_julian_year(target_mjd) - ref_year
    pmra = float(pmra_mas_yr or 0.0)
    pmdec = float(pmdec_mas_yr or 0.0)
    cos_dec = max(1e-4, math.cos(math.radians(dec_deg)))
    ra_epoch = (float(ra_deg) + (pmra * dt_yr) / (3600000.0 * cos_dec)) % 360.0
    dec_epoch = max(-90.0, min(90.0, float(dec_deg) + (pmdec * dt_yr) / 3600000.0))
    return round(ra_epoch, 6), round(dec_epoch, 6)


def build_tan_wcs_header(
    ra: float,
    dec: float,
    fov_arcmin: float = 5.0,
    *,
    crpix: float | tuple[float, float] = 128.0,
    grid_width: int = GRID_WIDTH,
    grid_height: int = GRID_HEIGHT,
    fits_keywords: bool = False,
) -> dict[str, Any]:
    """Build a north-up 2D TAN WCS representation for a sky patch.

    Supports both the compact API contract WCS dictionary (default ``crpix=128.0``)
    and full FITS WCS headers (typically ``crpix=128.5`` for 1-based FITS pixel
    centers on a ``256x256`` grid).

    Args:
        ra: Field center Right Ascension in degrees.
        dec: Field center Declination in degrees.
        fov_arcmin: Field of view in arcminutes.
        crpix: Reference pixel coordinate(s), either a scalar applied to both axes
            or a ``(crpix1, crpix2)`` tuple.
        grid_width: Grid width in pixels.
        grid_height: Grid height in pixels.
        fits_keywords: If ``True``, return standard FITS WCS header keywords;
            otherwise return the API contract WCS dictionary.

    Returns:
        Dictionary containing either API contract WCS fields or FITS WCS keywords.
    """
    crpix_x, crpix_y = (
        (float(crpix), float(crpix))
        if isinstance(crpix, (int, float))
        else (float(crpix[0]), float(crpix[1]))
    )
    fov_deg = float(fov_arcmin) / 60.0
    pixel_scale = fov_deg / float(max(grid_width, grid_height))
    if fits_keywords:
        return {
            "NAXIS": 2,
            "NAXIS1": int(grid_width),
            "NAXIS2": int(grid_height),
            "CTYPE1": "RA---TAN",
            "CTYPE2": "DEC--TAN",
            "CUNIT1": "deg",
            "CUNIT2": "deg",
            "CRVAL1": float(ra),
            "CRVAL2": float(dec),
            "CRPIX1": crpix_x,
            "CRPIX2": crpix_y,
            "CDELT1": -pixel_scale,
            "CDELT2": pixel_scale,
            "RADESYS": "ICRS",
            "EQUINOX": 2000.0,
        }

    scale_deg = round(pixel_scale, 7)
    return {
        "width": int(grid_width),
        "height": int(grid_height),
        "crval": [round(float(ra), 4), round(float(dec), 4)],
        "crpix": [crpix_x, crpix_y],
        "cdelt": [-scale_deg, scale_deg],
    }


def sky_to_pixel(
    ra: float,
    dec: float,
    wcs: dict[str, Any],
    *,
    ndigits: int | None = 2,
) -> tuple[float, float]:
    """Project sky coordinates ``(ra, dec)`` onto a 2D TAN WCS pixel grid.

    Args:
        ra: Target Right Ascension in degrees.
        dec: Target Declination in degrees.
        wcs: Contract WCS dictionary containing ``crval``, ``crpix``, and ``cdelt``.
        ndigits: Optional decimal rounding precision (default ``2``; pass ``None``
            for unrounded floating-point pixel coordinates).

    Returns:
        Projected pixel coordinates ``(x, y)``.
    """
    ra0, dec0 = float(wcs["crval"][0]), float(wcs["crval"][1])
    x0, y0 = float(wcs["crpix"][0]), float(wcs["crpix"][1])
    cdelt_x, cdelt_y = float(wcs["cdelt"][0]), float(wcs["cdelt"][1])
    cos_dec = math.cos(math.radians(dec0))
    dra = ((float(ra) - ra0 + 180.0) % 360.0) - 180.0
    x = x0 + (dra * cos_dec) / cdelt_x
    y = y0 + (float(dec) - dec0) / cdelt_y
    if ndigits is not None:
        return round(x, ndigits), round(y, ndigits)
    return x, y


def pixel_to_sky(
    x: float,
    y: float,
    wcs: dict[str, Any],
) -> tuple[float, float]:
    """Invert 2D TAN WCS pixel coordinates ``(x, y)`` to ICRS ``(ra, dec)``.

    Args:
        x: Pixel X coordinate.
        y: Pixel Y coordinate.
        wcs: Contract WCS dictionary containing ``crval``, ``crpix``, and ``cdelt``.

    Returns:
        Sky coordinates ``(ra, dec)`` in degrees rounded to 5 decimal places.
    """
    ra0, dec0 = float(wcs["crval"][0]), float(wcs["crval"][1])
    x0, y0 = float(wcs["crpix"][0]), float(wcs["crpix"][1])
    cdelt_x, cdelt_y = float(wcs["cdelt"][0]), float(wcs["cdelt"][1])
    cos_dec = max(0.01, math.cos(math.radians(dec0)))
    ra = (ra0 + ((float(x) - x0) * cdelt_x) / cos_dec) % 360.0
    dec = max(-90.0, min(90.0, dec0 + (float(y) - y0) * cdelt_y))
    return round(ra, 5), round(dec, 5)
