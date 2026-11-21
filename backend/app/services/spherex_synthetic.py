"""Deterministic synthetic SPHEREx MEF fixtures and local fixture fallbacks."""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
from astropy.io import fits

from app.services.spherex_fits import (
    SpherexCutout,
    SpherexIngestError,
    detector_to_bandpass,
    process_spherex_fits,
    validate_coordinates,
)
from app.services.spherex_flags import SPHEREX_FLAG_BITS
from app.utils.astronomy import build_tan_wcs_header, mjd_to_iso


def _synthetic_arrays(
    ra: float,
    dec: float,
    fov_arcmin: float,
    bandpass: str,
    shape: tuple[int, int],
    seed: int | None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Generate deterministic ``IMAGE``, ``ZODI``, ``VARIANCE``, and ``FLAGS`` arrays."""
    height, width = shape
    resolved_seed = (
        seed
        if seed is not None
        else abs(int(round(ra * 1000)) * 10_000 + int(round((dec + 90.0) * 1000)))
    )
    rng = np.random.default_rng(resolved_seed)

    yy, xx = np.mgrid[0:height, 0:width]
    x_norm = (xx - (width - 1) / 2.0) / max(width, 1)
    y_norm = (yy - (height - 1) / 2.0) / max(height, 1)

    detector = 1
    mapped = detector_to_bandpass(bandpass.split("-")[-1])
    if mapped:
        detector = int(mapped.split("-")[-1])

    background = 0.8 + 0.15 * detector
    image = (background + 0.4 * x_norm - 0.3 * y_norm + rng.normal(0.0, 0.01, size=shape)).astype(
        np.float32
    )

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
    seed: int | None = None,
) -> fits.HDUList:
    """Build a deterministic SPHEREx-like MEF HDUList for offline tests and fallbacks.

    Args:
        ra: Field center Right Ascension in degrees.
        dec: Field center Declination in degrees.
        fov_arcmin: Field of view in arcminutes.
        bandpass: SPHEREx bandpass identifier (e.g. ``"SPHEREx-D1"``).
        shape: Two-dimensional image shape ``(height, width)``.
        mjd_obs: Observation Modified Julian Date.
        seed: Optional random seed for deterministic synthesis.

    Returns:
        Open ``astropy.io.fits.HDUList`` with ``IMAGE``, ``FLAGS``,
        ``VARIANCE``, and ``ZODI`` extensions.
    """
    validate_coordinates(ra, dec, fov_arcmin)

    image, zodi, variance, flags = _synthetic_arrays(
        ra=ra,
        dec=dec,
        fov_arcmin=fov_arcmin,
        bandpass=bandpass,
        shape=shape,
        seed=seed,
    )

    height, width = shape
    wcs_header = build_tan_wcs_header(
        ra=ra,
        dec=dec,
        fov_arcmin=fov_arcmin,
        crpix=((width + 1.0) / 2.0, (height + 1.0) / 2.0),
        grid_width=width,
        grid_height=height,
        fits_keywords=True,
    )

    date_obs = mjd_to_iso(mjd_obs)
    primary = fits.PrimaryHDU()
    primary.header["MJD-OBS"] = float(mjd_obs)
    primary.header["DATE-OBS"] = date_obs
    primary.header["BANDPASS"] = str(bandpass)
    primary.header["RA"] = float(ra)
    primary.header["DEC"] = float(dec)
    primary.header.update(wcs_header)

    image_hdu = fits.ImageHDU(image, name="IMAGE")
    image_hdu.header["MJD-OBS"] = float(mjd_obs)
    image_hdu.header["DATE-OBS"] = date_obs
    image_hdu.header["BANDPASS"] = str(bandpass)
    image_hdu.header["BUNIT"] = "MJy/sr"
    image_hdu.header.update(wcs_header)

    flags_hdu = fits.ImageHDU(flags.astype(np.int32), name="FLAGS")

    variance_hdu = fits.ImageHDU(variance, name="VARIANCE")
    variance_hdu.header["BUNIT"] = "(MJy/sr)^2"

    zodi_hdu = fits.ImageHDU(zodi, name="ZODI")
    zodi_hdu.header["BUNIT"] = "MJy/sr"

    return fits.HDUList([primary, image_hdu, flags_hdu, variance_hdu, zodi_hdu])


def write_synthetic_spherex_fits(
    path: str | os.PathLike,
    ra: float = 0.0,
    dec: float = 0.0,
    fov_arcmin: float = 5.0,
    bandpass: str = "SPHEREx-D1",
    shape: tuple[int, int] = (64, 64),
    mjd_obs: float = 60000.0,
    seed: int | None = None,
) -> Path:
    """Write a synthetic SPHEREx MEF fixture to disk.

    Args:
        path: Output FITS file path.
        ra: Field center Right Ascension in degrees.
        dec: Field center Declination in degrees.
        fov_arcmin: Field of view in arcminutes.
        bandpass: SPHEREx bandpass identifier.
        shape: Two-dimensional image shape ``(height, width)``.
        mjd_obs: Observation Modified Julian Date.
        seed: Optional random seed for deterministic synthesis.

    Returns:
        Resolved output :class:`pathlib.Path`.
    """
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
    seed: int | None = None,
) -> SpherexCutout:
    """Create a processed synthetic SPHEREx cutout without touching IRSA.

    Args:
        ra: Field center Right Ascension in degrees.
        dec: Field center Declination in degrees.
        fov_arcmin: Field of view in arcminutes.
        bandpass: SPHEREx bandpass identifier.
        shape: Two-dimensional image shape ``(height, width)``.
        mjd_obs: Observation Modified Julian Date.
        seed: Optional random seed for deterministic synthesis.

    Returns:
        Cleaned :class:`SpherexCutout` instance marked with ``source="synthetic"``.
    """
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


def find_cached_fixture(
    fixture_dir: str | os.PathLike | None,
    bandpass: str,
) -> Path | None:
    """Locate a local FITS fixture matching ``bandpass`` inside ``fixture_dir``.

    Args:
        fixture_dir: Directory path, or ``None`` to check ``SPHEREX_FIXTURE_DIR``.
        bandpass: SPHEREx bandpass name to match.

    Returns:
        Matching fixture :class:`pathlib.Path`, or ``None`` if unavailable.
    """
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


def fallback_cutout(
    ra: float,
    dec: float,
    fov_arcmin: float,
    bandpass: str,
    fixture_dir: str | os.PathLike | None = None,
    mjd_obs: float = 60000.0,
    seed: int | None = None,
) -> SpherexCutout:
    """Return a cached FITS fixture cutout if present, otherwise a synthetic cutout.

    Args:
        ra: Field center Right Ascension in degrees.
        dec: Field center Declination in degrees.
        fov_arcmin: Field of view in arcminutes.
        bandpass: SPHEREx bandpass identifier.
        fixture_dir: Optional directory containing cached FITS fixtures.
        mjd_obs: Observation Modified Julian Date.
        seed: Optional deterministic random seed.

    Returns:
        Processed :class:`SpherexCutout`.
    """
    fixture = find_cached_fixture(fixture_dir, bandpass)
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
