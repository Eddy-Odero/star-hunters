"""WISE/NEOWISE archival cutout fallback on the canonical SPHEREx TAN grid.

The service uses IRSA's programmatic Image Server inventory (IBE) to discover
WISE All-Sky and NEOWISE-R L1b exposures, downloads calibrated intensity/uncertainty FITS
cutouts, converts them to MJy/sr, and reprojects them onto the ISS-08 grid.
No synthetic values are substituted when archival data are unavailable.
"""

from __future__ import annotations

import csv
import gzip
import io
import math
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import numpy as np
import requests

IRSA_INVENTORIES = (
    (
        "https://irsa.ipac.caltech.edu/ibe/search/wise/allsky/4band_p1bm_frm",
        "allsky",
        "4band_p1bm_frm",
    ),
    ("https://irsa.ipac.caltech.edu/ibe/search/wise/neowiser/p1bm_frm", "neowiser", "p1bm_frm"),
)
IRSA_TIMEOUT = 45.0
GRID_SIZE = 256
WISE_ZERO_POINT_JY = {1: 309.540, 2: 171.787}


class WiseFallbackError(RuntimeError):
    """Raised when WISE data cannot be queried, calibrated, or reprojected."""


@dataclass(frozen=True)
class WiseExposure:
    band: int
    mjd: float
    intensity_url: str
    uncertainty_url: str | None = None


@dataclass(frozen=True)
class WiseFallbackResult:
    detector_data: np.ndarray
    detector_buffer: bytes
    flags_mask: np.ndarray
    flags_buffer: bytes
    wcs_header: dict[str, Any]
    mjd: float
    mjd_start: float
    mjd_end: float
    available_detectors: list[int]
    exposure_count: int

    @property
    def baseline_days(self) -> float:
        return max(0.0, self.mjd_end - self.mjd_start)

    def data_source_summary(self, spherex_mjds: Iterable[float] = ()) -> dict[str, Any]:
        dates = [float(value) for value in spherex_mjds if math.isfinite(float(value))]
        wise_dates = [self.mjd_start, self.mjd_end]
        combined = dates + wise_dates
        baseline = max(combined) - min(combined) if combined else self.baseline_days
        return {
            "primary_mission": "WISE",
            "has_multi_epoch_spherex": False,
            "uses_wise_fallback": True,
            "baseline_days": max(self.baseline_days, baseline),
            "status_note": f"WISE/NEOWISE W1/W2 fallback ({self.exposure_count} exposure(s))",
        }


def _validate_target(ra: float, dec: float, fov_arcmin: float) -> None:
    if not all(math.isfinite(float(v)) for v in (ra, dec, fov_arcmin)):
        raise WiseFallbackError("RA, Dec and field of view must be finite.")
    if not 0.0 <= ra < 360.0 or not -90.0 <= dec <= 90.0 or fov_arcmin <= 0:
        raise WiseFallbackError("Invalid sky coordinates or field of view.")


def query_wise_exposures(
    ra: float,
    dec: float,
    fov_arcmin: float,
    session: Any = requests,
) -> list[WiseExposure]:
    """Discover quality-screened WISE All-Sky and NEOWISE-R L1b exposures."""
    _validate_target(ra, dec, fov_arcmin)
    params = {
        "POS": f"{ra:.8f},{dec:.8f}",
        "SIZE": f"{fov_arcmin / 60.0:.8f}",
        "where": "band in (1,2) and qual_frame=10",
        "columns": "band,mjd_obs,qual_frame,scan_id,frame_num",
        "ct": "CSV",
    }
    exposures: list[WiseExposure] = []
    query_errors: list[str] = []
    for endpoint, dataset, table in IRSA_INVENTORIES:
        try:
            response = session.get(endpoint, params=params, timeout=IRSA_TIMEOUT)
            response.raise_for_status()
            lines = response.text.splitlines()
            header_index = next(
                (
                    i
                    for i, line in enumerate(lines)
                    if "band" in line.lower() and "mjd_obs" in line.lower()
                ),
                None,
            )
            if header_index is None:
                continue
            reader = csv.DictReader(lines[header_index:])
            for row in reader:
                normalized = {
                    str(k).strip().lower(): str(v).strip().strip('"') for k, v in row.items() if k
                }
                band = int(float(normalized.get("band", "0")))
                mjd = float(normalized.get("mjd_obs", "nan"))
                scan_id = normalized.get("scan_id", "")
                frame_num = int(float(normalized.get("frame_num", "-1")))
                if band not in (1, 2) or not math.isfinite(mjd) or not scan_id or frame_num < 0:
                    continue
                if len(scan_id) < 2 or not scan_id.isalnum():
                    continue
                frame_name = f"{scan_id}{frame_num:03d}-w{band}"
                base_path = (
                    f"https://irsa.ipac.caltech.edu/ibe/data/wise/{dataset}/{table}/"
                    f"{scan_id[-2:]}/{scan_id}/{frame_num:03d}/{frame_name}"
                )
                cutout_query = urlencode(
                    {"center": f"{ra:.8f},{dec:.8f}deg", "size": f"{fov_arcmin:.4f}arcmin"}
                )
                image_url = f"{base_path}-int-1b.fits?{cutout_query}"
                uncertainty_url = f"{base_path}-unc-1b.fits.gz?{cutout_query}"
                exposures.append(WiseExposure(band, mjd, image_url, uncertainty_url))
        except Exception as exc:
            query_errors.append(f"{dataset}: {exc}")

    if not exposures:
        detail = "; ".join(query_errors) if query_errors else "no quality-screened rows"
        raise WiseFallbackError(f"IRSA returned no usable WISE W1/W2 exposures ({detail}).")
    # The two inventory services can overlap at release boundaries. Deduplicate
    # identical band/time records while preserving distinct survey epochs.
    unique = {(item.band, item.mjd, item.intensity_url): item for item in exposures}
    return sorted(unique.values(), key=lambda item: item.mjd)


def _to_mjy_sr(
    data: np.ndarray,
    header: Any,
    band: int,
    calibration_header: Any | None = None,
) -> np.ndarray:
    """Convert calibrated FITS values to MJy/sr using BUNIT or MAGZP.

    WISE uncertainty frames carry DN units but omit the MAGZP keyword; callers
    can pass the matching intensity header so both frames use the same zero point.
    """
    values = np.asarray(data, dtype=np.float64)
    unit = str(header.get("BUNIT", "")).strip().lower().replace(" ", "")
    zero_point_header = calibration_header if calibration_header is not None else header
    if unit in {"mjy/sr", "mjy*sr-1", "mjy/sr/pixel"}:
        return values
    if unit in {"jy/sr", "jy*sr-1"}:
        return values / 1_000_000.0
    if unit in {"jy/pixel", "jy/pix"}:
        from astropy.wcs import WCS
        from astropy.wcs.utils import proj_plane_pixel_area

        area_sr = float(proj_plane_pixel_area(WCS(header).celestial)) * (math.pi / 180.0) ** 2
        return values * 1e-6 / area_sr
    if unit in {"dn", "adu", "dn/s", "adu/s", ""} and "MAGZP" in zero_point_header:
        from astropy.wcs import WCS
        from astropy.wcs.utils import proj_plane_pixel_area

        area_sr = float(proj_plane_pixel_area(WCS(header).celestial)) * (math.pi / 180.0) ** 2
        # WISE magnitude zero point: mag = MAGZP - 2.5 log10(counts).
        magzp = float(zero_point_header["MAGZP"])
        jy_per_count = WISE_ZERO_POINT_JY[band] * 10.0 ** (-0.4 * magzp)
        return values * jy_per_count * 1e-6 / area_sr
    raise WiseFallbackError(
        f"Unsupported WISE image unit {header.get('BUNIT')!r}; cannot calibrate to MJy/sr."
    )


def _download_fits(url: str, session: Any = requests) -> tuple[np.ndarray, Any]:
    try:
        response = session.get(url, timeout=IRSA_TIMEOUT)
        response.raise_for_status()
        from astropy.io import fits

        # IRSA serves FITS cutouts gzip-compressed even when the requested IBE
        # path ends in ".fits"; decompress by magic bytes before opening.
        content = response.content
        if content[:2] == b"\x1f\x8b":
            content = gzip.decompress(content)
        with fits.open(io.BytesIO(content), memmap=False) as hdus:
            for hdu in hdus:
                if getattr(hdu, "data", None) is not None and np.asarray(hdu.data).ndim == 2:
                    return np.asarray(hdu.data, dtype=np.float64).copy(), hdu.header.copy()
    except WiseFallbackError:
        raise
    except Exception as exc:
        raise WiseFallbackError(f"Could not download/read WISE FITS cutout {url}: {exc}") from exc
    raise WiseFallbackError(f"WISE FITS file contains no 2-D image: {url}")


def _reproject_to_target(
    image: np.ndarray,
    source_header: Any,
    target_wcs_header: dict[str, Any],
) -> np.ndarray:
    try:
        from astropy.wcs import WCS
        from reproject import reproject_interp

        projected, footprint = reproject_interp(
            (np.asarray(image, dtype=np.float64), WCS(source_header).celestial),
            WCS(target_wcs_header).celestial,
            shape_out=(GRID_SIZE, GRID_SIZE),
            order="bilinear",
        )
    except Exception as exc:
        raise WiseFallbackError(f"WISE-to-SPHEREx WCS reprojection failed: {exc}") from exc
    projected = np.asarray(projected, dtype=np.float64)
    projected[np.asarray(footprint) <= 0] = np.nan
    return projected


def assemble_wise_detector_planes(
    w1_mjy_sr: np.ndarray,
    w2_mjy_sr: np.ndarray,
    w1_variance: np.ndarray | None = None,
    w2_variance: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray, bytes, bytes]:
    """Map W1 to plane 3 and W2 to planes 4/5 in the six-plane wire format."""
    w1 = np.asarray(w1_mjy_sr, dtype=np.float64)
    w2 = np.asarray(w2_mjy_sr, dtype=np.float64)
    expected = (GRID_SIZE, GRID_SIZE)
    if w1.shape != expected or w2.shape != expected:
        raise WiseFallbackError(f"WISE reprojections must both have shape {expected}.")
    if not np.any(np.isfinite(w1) & (w1 != 0)) or not np.any(np.isfinite(w2) & (w2 != 0)):
        raise WiseFallbackError(
            "WISE W1 and W2 cutouts must contain finite non-zero calibrated flux."
        )

    data = np.zeros((6, GRID_SIZE, GRID_SIZE), dtype="<f4")
    flags = np.zeros(expected, dtype=np.uint8)
    # Detector 4 receives W1; detectors 5 and 6 receive W2 as requested by ISS-12.
    data[3] = np.nan_to_num(w1, nan=0.0, posinf=0.0, neginf=0.0).astype("<f4")
    data[4] = np.nan_to_num(w2, nan=0.0, posinf=0.0, neginf=0.0).astype("<f4")
    data[5] = data[4]
    invalid = ~(np.isfinite(w1) & np.isfinite(w2))
    flags[invalid] = 1
    data = np.ascontiguousarray(data, dtype="<f4")
    flags = np.ascontiguousarray(flags, dtype=np.uint8)
    detector_bytes = data.tobytes(order="C")
    flags_bytes = flags.tobytes(order="C")
    if len(detector_bytes) != 1_572_864 or len(flags_bytes) != 65_536:
        raise WiseFallbackError("WISE fallback buffers do not match the canonical binary contract.")
    return data, flags, detector_bytes, flags_bytes


def fetch_wise_fallback(
    ra: float,
    dec: float,
    fov_arcmin: float,
    target_wcs_header: dict[str, Any],
    session: Any = requests,
    exposure_query: Callable[..., list[WiseExposure]] = query_wise_exposures,
) -> WiseFallbackResult:
    """Fetch, calibrate and reproject the latest WISE W1/W2 images onto the ISS-08 grid."""
    exposures = [
        item for item in exposure_query(ra, dec, fov_arcmin, session=session) if item.band in (1, 2)
    ]
    if not exposures:
        raise WiseFallbackError("WISE archive returned no W1/W2 exposures for reprojection.")
    earliest_mjd = min(item.mjd for item in exposures)
    latest_mjd = max(item.mjd for item in exposures)

    # A sky position usually has hundreds of overlapping survey frames. Only the
    # most recent W1 and W2 exposure are needed for the fallback epoch; downloading
    # the full history would make the interactive fallback path prohibitively slow.
    latest_exposure_by_band: dict[int, WiseExposure] = {}
    for exposure in exposures:
        current = latest_exposure_by_band.get(exposure.band)
        if current is None or exposure.mjd > current.mjd:
            latest_exposure_by_band[exposure.band] = exposure
    if 1 not in latest_exposure_by_band or 2 not in latest_exposure_by_band:
        raise WiseFallbackError("WISE archive did not provide both W1 (3.4 μm) and W2 (4.6 μm).")

    latest_by_band: dict[int, tuple[float, np.ndarray]] = {}
    for band, exposure in latest_exposure_by_band.items():
        image, header = _download_fits(exposure.intensity_url, session=session)
        calibrated = _to_mjy_sr(image, header, band)
        projected = _reproject_to_target(calibrated, header, target_wcs_header)
        if not exposure.uncertainty_url:
            raise WiseFallbackError("WISE exposure is missing its uncertainty FITS URL.")
        uncertainty, uncertainty_header = _download_fits(exposure.uncertainty_url, session=session)
        uncertainty_mjy_sr = np.abs(
            _to_mjy_sr(uncertainty, uncertainty_header, band, calibration_header=header)
        )
        projected_uncertainty = _reproject_to_target(
            uncertainty_mjy_sr, uncertainty_header, target_wcs_header
        )
        projected[~(np.isfinite(projected_uncertainty) & (projected_uncertainty > 0))] = np.nan
        latest_by_band[band] = (exposure.mjd, projected)

    data, flags, detector_bytes, flags_bytes = assemble_wise_detector_planes(
        latest_by_band[1][1], latest_by_band[2][1]
    )
    return WiseFallbackResult(
        detector_data=data,
        detector_buffer=detector_bytes,
        flags_mask=flags,
        flags_buffer=flags_bytes,
        wcs_header=dict(target_wcs_header),
        mjd=float(np.mean([latest_by_band[1][0], latest_by_band[2][0]])),
        mjd_start=earliest_mjd,
        mjd_end=latest_mjd,
        available_detectors=[4, 5, 6],
        exposure_count=len(exposures),
    )
