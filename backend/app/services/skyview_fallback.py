"""NASA SkyView multi-band archival cutout fallback and planetary ephemeris overlay."""

from __future__ import annotations

import io
import math
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

import numpy as np
import requests
from astropy.io import fits
from astropy.wcs import WCS
from reproject import reproject_interp

from app.services.logging_config import get_logger

SKYVIEW_IMAGE_URL = "https://skyview.gsfc.nasa.gov/cgi-bin/images"
SKYVIEW_TIMEOUT = 25.0
GRID_SIZE = 256
BYTES_FLOAT32_CUBE = 6 * GRID_SIZE * GRID_SIZE * 4
BYTES_UINT8_MASK = GRID_SIZE * GRID_SIZE

SKYVIEW_DEFAULT_SURVEYS: tuple[tuple[str, str, str, float], ...] = (
    ("dss2_red", "DSS2 Red", "NASA SkyView DSS2 Red (0.65 um)", 49353.0),
    ("dss2_ir", "DSS2 IR", "NASA SkyView DSS2 IR (0.85 um)", 50449.0),
)

_logger = get_logger("skyview_fallback")


class SkyViewFallbackError(RuntimeError):
    """Raised when NASA SkyView FITS cutouts cannot be retrieved or calibrated."""


@dataclass(frozen=True)
class SkyViewEpochResult:
    """Packed detector cube and hygiene mask for one SkyView survey epoch."""

    epoch_id: str
    survey: str
    label: str
    mjd: float
    detector_data: np.ndarray
    detector_buffer: bytes
    flags_mask: np.ndarray
    flags_buffer: bytes
    available_detectors: list[int]


def _parse_fits_2d(content: bytes, survey: str) -> tuple[np.ndarray, Any]:
    if not content or (b"SIMPLE" not in content[:160] and content[:2] != b"\x1f\x8b"):
        raise SkyViewFallbackError(f"SkyView did not return FITS data for survey {survey!r}.")
    with fits.open(io.BytesIO(content), memmap=False) as hdus:
        for hdu in hdus:
            if getattr(hdu, "data", None) is not None and np.asarray(hdu.data).ndim >= 2:
                arr = np.asarray(hdu.data, dtype=np.float64)
                while arr.ndim > 2:
                    arr = arr[0]
                return arr.copy(), hdu.header.copy()
    raise SkyViewFallbackError(f"SkyView FITS for {survey!r} contained no 2D image.")


def _normalize_skyview_plate(image: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Subtract background pedestal and scale archival photographic counts safely."""
    arr = np.asarray(image, dtype=np.float64)
    finite = np.isfinite(arr)
    if not np.any(finite):
        raise SkyViewFallbackError("SkyView FITS cutout has no finite pixel values.")

    valid_vals = arr[finite]
    bg = float(np.percentile(valid_vals, 20.0))
    mad = float(np.median(np.abs(valid_vals - np.median(valid_vals))))
    scale = max(1e-3, mad * 1.4826)
    rel = np.zeros_like(arr, dtype=np.float64)
    rel[finite] = np.clip((arr[finite] - bg) / scale, -0.5, 45.0)
    # Shift into positive photometric brightness while preserving faint structures.
    rel[finite] = np.maximum(0.0, rel[finite] + 0.15)
    invalid = ~finite
    return rel, invalid


def _download_skyview_fits(
    ra: float,
    dec: float,
    fov_arcmin: float,
    survey: str,
    session: Any = requests,
) -> tuple[np.ndarray, Any]:
    size_deg = max(0.02, float(fov_arcmin) / 60.0)
    params = {
        "Position": f"{float(ra):.6f},{float(dec):.6f}",
        "Survey": survey,
        "Pixels": str(GRID_SIZE),
        "Size": f"{size_deg:.6f}",
        "Coordinates": "J2000",
        "Projection": "Tan",
        "Return": "FITS",
    }
    response = session.get(SKYVIEW_IMAGE_URL, params=params, timeout=SKYVIEW_TIMEOUT)
    response.raise_for_status()
    return _parse_fits_2d(response.content, survey=survey)


def _assemble_skyview_cube(
    projected_plane: np.ndarray,
    invalid_mask: np.ndarray,
    *,
    detector_channels: tuple[int, ...] = (0, 1),
) -> tuple[np.ndarray, np.ndarray, bytes, bytes]:
    expected = (GRID_SIZE, GRID_SIZE)
    plane = np.asarray(projected_plane, dtype=np.float64)
    invalid = np.asarray(invalid_mask, dtype=bool)
    if plane.shape != expected or invalid.shape != expected:
        raise SkyViewFallbackError(f"SkyView cutout must have shape {expected}.")

    cube = np.zeros((6, GRID_SIZE, GRID_SIZE), dtype="<f4")
    clean_plane = np.nan_to_num(plane, nan=0.0, posinf=0.0, neginf=0.0).astype("<f4")
    for ch_idx in detector_channels:
        if 0 <= ch_idx < 6:
            # Slightly attenuate secondary band so multi-detector slices remain responsive.
            scale = 1.0 if ch_idx == detector_channels[0] else 0.88
            cube[ch_idx] = (clean_plane * scale).astype("<f4")

    flags = np.zeros(expected, dtype=np.uint8)
    flags[invalid | (~np.isfinite(plane))] = 1
    cube = np.ascontiguousarray(cube, dtype="<f4")
    flags = np.ascontiguousarray(flags, dtype=np.uint8)
    det_bytes = cube.tobytes(order="C")
    flag_bytes = flags.tobytes(order="C")
    if len(det_bytes) != BYTES_FLOAT32_CUBE or len(flag_bytes) != BYTES_UINT8_MASK:
        raise SkyViewFallbackError("SkyView packed buffers failed canonical binary size check.")
    return cube, flags, det_bytes, flag_bytes


def fetch_skyview_fallback(
    ra: float,
    dec: float,
    fov_arcmin: float,
    target_wcs_header: dict[str, Any] | None = None,
    session: Any = requests,
    downloader: Callable[..., tuple[np.ndarray, Any]] = _download_skyview_fits,
) -> list[SkyViewEpochResult]:
    """Fetch SkyView archival optical/NIR FITS plates onto the 256x256 TAN grid."""
    t0 = time.perf_counter()
    surveys_to_fetch = list(SKYVIEW_DEFAULT_SURVEYS)

    def _fetch_one(spec: tuple[str, str, str, float]) -> SkyViewEpochResult | None:
        epoch_id, survey, label, mjd = spec
        try:
            raw_img, src_hdr = downloader(ra, dec, fov_arcmin, survey, session=session)
        except Exception as exc:
            _logger.warning("SkyView survey %s failed for (%.4f, %.4f): %s", survey, ra, dec, exc)
            return None

        if target_wcs_header is not None and src_hdr and "CTYPE1" in src_hdr:
            try:
                reprojected, footprint = reproject_interp(
                    (raw_img, WCS(src_hdr).celestial),
                    WCS(target_wcs_header).celestial,
                    shape_out=(GRID_SIZE, GRID_SIZE),
                    order="bilinear",
                )
                plane = np.asarray(reprojected, dtype=np.float64)
                out_invalid = np.asarray(footprint) <= 0
                norm_plane, val_invalid = _normalize_skyview_plate(plane)
                invalid = out_invalid | val_invalid
            except Exception:
                norm_plane, invalid = _normalize_skyview_plate(raw_img)
        else:
            norm_plane, invalid = _normalize_skyview_plate(raw_img)

        if norm_plane.shape != (GRID_SIZE, GRID_SIZE):
            return None

        det_idx = (0, 1) if "ir" in epoch_id or "dss2_ir" in epoch_id else (0, 1)
        cube, flags, det_bytes, flag_bytes = _assemble_skyview_cube(
            norm_plane,
            invalid,
            detector_channels=det_idx,
        )
        return SkyViewEpochResult(
            epoch_id=epoch_id,
            survey=survey,
            label=label,
            mjd=mjd,
            detector_data=cube,
            detector_buffer=det_bytes,
            flags_mask=flags,
            flags_buffer=flag_bytes,
            available_detectors=[1, 2],
        )

    results: list[SkyViewEpochResult | None]
    if session is requests and downloader is _download_skyview_fits:
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(_fetch_one, surveys_to_fetch))
    else:
        results = [_fetch_one(spec) for spec in surveys_to_fetch]

    valid_epochs = [res for res in results if res is not None]
    if not valid_epochs:
        # Last-resort single legacy DSS plate attempt (covers full sky when DSS2 fails)
        dss_fallback = _fetch_one(("skyview_dss", "DSS", "NASA SkyView DSS", 47000.0))
        if dss_fallback is not None:
            valid_epochs.append(dss_fallback)

    if not valid_epochs:
        raise SkyViewFallbackError(
            f"NASA SkyView returned no usable archival plates for ({ra:.4f}, {dec:.4f})."
        )

    _logger.info(
        "SkyView archival fallback retrieved %d plate(s) for (%.4f, %.4f) in %.2fs",
        len(valid_epochs),
        ra,
        dec,
        time.perf_counter() - t0,
    )
    return valid_epochs


def inject_solar_system_ephemeris_overlay(
    cube: np.ndarray,
    *,
    x_px: float,
    y_px: float,
    body_name: str,
    body_class: str,
    available_detectors: list[int],
) -> np.ndarray:
    """Blend a crisp multi-band Solar System ephemeris marker onto archival sky plates.

    Static multi-decade archival surveys reject moving planets; this adds a subtle
    photometric planetary PSF (including inclined rings for Saturn) at the live
    JPL Horizons pixel coordinate on the real archival background starfield.
    """
    out = np.array(cube, dtype="<f4", copy=True)
    if not (-12.0 <= x_px <= GRID_SIZE + 12.0 and -12.0 <= y_px <= GRID_SIZE + 12.0):
        return out

    yy, xx = np.mgrid[0:GRID_SIZE, 0:GRID_SIZE]
    dx = xx - float(x_px)
    dy = yy - float(y_px)
    r2 = dx * dx + dy * dy

    is_saturn = "saturn" in body_name.lower()
    is_jupiter = "jupiter" in body_name.lower()
    sigma = 4.2 if is_saturn else (4.6 if is_jupiter else (3.0 if body_class == "planet" else 2.2))
    core_flux = 36.0 if body_class == "planet" else 22.0
    disk = core_flux * np.exp(-r2 / (2.0 * sigma * sigma))

    if is_saturn:
        # Add an elliptical Cassini ring profile tilted ~18 deg around Saturn's core.
        theta = math.radians(18.0)
        rx = dx * math.cos(theta) + dy * math.sin(theta)
        ry = -dx * math.sin(theta) + dy * math.cos(theta)
        ring_dist = np.hypot(rx / 11.5, ry / 3.4)
        ring_band = np.exp(-((ring_dist - 1.0) ** 2) / (2.0 * 0.19**2))
        disk += 18.0 * ring_band * np.exp(-r2 / (2.0 * 14.0**2))

    channels = available_detectors or [1, 2]
    for det_num in channels:
        ch_idx = int(det_num) - 1
        if 0 <= ch_idx < 6:
            out[ch_idx] = (out[ch_idx] + disk.astype("<f4")).astype("<f4")
    return np.ascontiguousarray(out, dtype="<f4")
