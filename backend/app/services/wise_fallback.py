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
import time
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import numpy as np
import requests

from app.models.contracts import (
    BINARY_DETECTOR_FLOAT32_BYTES,
    BINARY_FLAGS_UINT8_BYTES,
    GRID_HEIGHT,
    GRID_WIDTH,
    NUM_DETECTORS,
)
from app.services.logging_config import get_logger

_logger = get_logger("wise_fallback")

IRSA_INVENTORIES = (
    (
        "https://irsa.ipac.caltech.edu/ibe/search/wise/allsky/4band_p1bm_frm",
        "allsky",
        "4band_p1bm_frm",
    ),
    ("https://irsa.ipac.caltech.edu/ibe/search/wise/neowiser/p1bm_frm", "neowiser", "p1bm_frm"),
)
IRSA_WISE_SEARCH_BASE_URL = "https://irsa.ipac.caltech.edu/ibe/search/wise"
IRSA_WISE_DATA_BASE_URL = "https://irsa.ipac.caltech.edu/ibe/data/wise"
IRSA_CONNECT_TIMEOUT = 3.5
IRSA_TIMEOUT = 10.0
WISE_ZERO_POINT_JY = {1: 309.540, 2: 171.787}


def _wise_request_timeout(session: Any) -> float | tuple[float, float]:
    """Use bounded ``(connect, read)`` tuple for live ``requests``, scalar for mocks."""
    if session is requests:
        return (IRSA_CONNECT_TIMEOUT, IRSA_TIMEOUT)
    return IRSA_TIMEOUT


class WiseFallbackError(RuntimeError):
    """Raised when WISE data cannot be queried, calibrated, or reprojected."""


@dataclass(frozen=True)
class WiseExposure:
    """Metadata for a single WISE All-Sky or NEOWISE-R L1b cutout exposure."""

    band: int
    mjd: float
    intensity_url: str
    uncertainty_url: str | None = None


@dataclass(frozen=True)
class WiseFallbackResult:
    """Packed W1/W2 detector cube, hygiene mask, and baseline metadata."""

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
        """Return total temporal baseline in days across discovered WISE exposures."""
        return max(0.0, self.mjd_end - self.mjd_start)

    def data_source_summary(self, spherex_mjds: Iterable[float] = ()) -> dict[str, Any]:
        """Build a manifest-compatible data source summary including SPHEREx dates.

        Args:
            spherex_mjds: Optional iterable of SPHEREx epoch MJDs for cross-mission
                baseline calculation.

        Returns:
            Dictionary describing the WISE/NEOWISE fallback provenance.
        """
        dates = [float(value) for value in spherex_mjds if math.isfinite(float(value))]
        wise_dates = [self.mjd_start, self.mjd_end]
        combined = dates + wise_dates
        baseline = max(combined) - min(combined) if combined else self.baseline_days
        return {
            "primary_mission": "WISE",
            "has_multi_epoch_spherex": False,
            "uses_wise_fallback": True,
            "baseline_days": max(self.baseline_days, baseline),
            "status_note": (
                f"Latest WISE/NEOWISE W1/W2 supplemental exposure ({self.exposure_count} cataloged)"
            ),
        }


def _validate_target(ra: float, dec: float, fov_arcmin: float) -> None:
    """Validate finite ICRS coordinates and positive FOV in arcminutes."""
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
    """Discover quality-screened WISE All-Sky and NEOWISE-R L1b exposures.

    Args:
        ra: Field center Right Ascension in degrees (``0 <= ra < 360``).
        dec: Field center Declination in degrees (``-90 <= dec <= 90``).
        fov_arcmin: Field of view in arcminutes.
        session: HTTP session/module exposing ``.get(...)``.

    Returns:
        Sorted list of unique :class:`WiseExposure` records ordered by MJD.

    Raises:
        WiseFallbackError: If coordinates are invalid or no exposures match.
    """
    _validate_target(ra, dec, fov_arcmin)
    if session is requests:
        from app.services.spherex_ingest import irsa_circuit_breaker

        if irsa_circuit_breaker.is_open():
            rem = irsa_circuit_breaker.remaining_seconds()
            raise WiseFallbackError(
                f"IRSA circuit breaker open ({rem:.0f}s remaining); "
                f"skipping WISE query ({IRSA_WISE_SEARCH_BASE_URL})."
            )

    params = {
        "POS": f"{ra:.8f},{dec:.8f}",
        "SIZE": f"{fov_arcmin / 60.0:.8f}",
        "where": "band in (1,2) and qual_frame=10",
        "columns": "band,mjd_obs,qual_frame,scan_id,frame_num",
        "ct": "CSV",
    }
    exposures: list[WiseExposure] = []
    query_errors: list[str] = []

    def _query_inventory(inv: tuple[str, str, str]) -> tuple[list[WiseExposure], str | None]:
        endpoint, dataset, table = inv
        inv_exposures: list[WiseExposure] = []
        try:
            response = session.get(endpoint, params=params, timeout=_wise_request_timeout(session))
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
                return inv_exposures, None
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
                inv_exposures.append(WiseExposure(band, mjd, image_url, uncertainty_url))
            return inv_exposures, None
        except Exception as exc:
            return inv_exposures, f"{dataset}: {exc}"

    t0 = time.perf_counter()
    if session is requests:
        with ThreadPoolExecutor(max_workers=len(IRSA_INVENTORIES)) as pool:
            inventory_results = list(pool.map(_query_inventory, IRSA_INVENTORIES))
    else:
        inventory_results = [_query_inventory(inv) for inv in IRSA_INVENTORIES]

    for inv_rows, err in inventory_results:
        exposures.extend(inv_rows)
        if err:
            query_errors.append(err)

    if not exposures:
        detail = "; ".join(query_errors) if query_errors else "no quality-screened rows"
        _logger.info(
            "WISE inventory (%s) returned 0 usable exposures for (%.4f, %.4f) in %.2fs (%s)",
            IRSA_WISE_SEARCH_BASE_URL,
            ra,
            dec,
            time.perf_counter() - t0,
            detail,
        )
        raise WiseFallbackError(f"IRSA returned no usable WISE W1/W2 exposures ({detail}).")
    # The two inventory services can overlap at release boundaries. Deduplicate
    # identical band/time records while preserving distinct survey epochs.
    unique = {(item.band, item.mjd, item.intensity_url): item for item in exposures}
    sorted_exposures = sorted(unique.values(), key=lambda item: item.mjd)
    _logger.info(
        "WISE inventory (%s) discovered %d unique exposure(s) for (%.4f, %.4f) in %.2fs",
        IRSA_WISE_SEARCH_BASE_URL,
        len(sorted_exposures),
        ra,
        dec,
        time.perf_counter() - t0,
    )
    return sorted_exposures


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
    """Download and extract the first 2D FITS image plane from a WISE cutout URL."""
    try:
        response = session.get(url, timeout=_wise_request_timeout(session))
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
    """Bilinearly reproject a 2D WISE image onto the canonical 256x256 TAN grid."""
    try:
        from astropy.wcs import WCS
        from reproject import reproject_interp

        projected, footprint = reproject_interp(
            (np.asarray(image, dtype=np.float64), WCS(source_header).celestial),
            WCS(target_wcs_header).celestial,
            shape_out=(GRID_HEIGHT, GRID_WIDTH),
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
    """Map W1 to plane 3 and W2 to planes 4/5 in the six-plane wire format.

    Args:
        w1_mjy_sr: Reprojected 256x256 WISE W1 array in MJy/sr.
        w2_mjy_sr: Reprojected 256x256 WISE W2 array in MJy/sr.
        w1_variance: Optional W1 variance array (unused, reserved for API symmetry).
        w2_variance: Optional W2 variance array (unused, reserved for API symmetry).

    Returns:
        Tuple of ``(detector_data, flags_mask, detector_bytes, flags_bytes)``.

    Raises:
        WiseFallbackError: If input shapes are invalid, flux is empty, or output
            buffers violate the canonical binary contract sizes.
    """
    w1 = np.asarray(w1_mjy_sr, dtype=np.float64)
    w2 = np.asarray(w2_mjy_sr, dtype=np.float64)
    expected = (GRID_HEIGHT, GRID_WIDTH)
    if w1.shape != expected or w2.shape != expected:
        raise WiseFallbackError(f"WISE reprojections must both have shape {expected}.")
    if not np.any(np.isfinite(w1) & (w1 != 0)) or not np.any(np.isfinite(w2) & (w2 != 0)):
        raise WiseFallbackError(
            "WISE W1 and W2 cutouts must contain finite non-zero calibrated flux."
        )

    data = np.zeros((NUM_DETECTORS, GRID_HEIGHT, GRID_WIDTH), dtype="<f4")
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
    if (
        len(detector_bytes) != BINARY_DETECTOR_FLOAT32_BYTES
        or len(flags_bytes) != BINARY_FLAGS_UINT8_BYTES
    ):
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
    """Fetch, calibrate, and reproject the latest WISE W1/W2 images onto the 256x256 grid.

    Args:
        ra: Field center Right Ascension in degrees.
        dec: Field center Declination in degrees.
        fov_arcmin: Field of view in arcminutes.
        target_wcs_header: Target FITS TAN WCS header dictionary.
        session: HTTP session/module exposing ``.get(...)``.
        exposure_query: Callable returning matching :class:`WiseExposure` rows.

    Returns:
        :class:`WiseFallbackResult` containing calibrated W1/W2 planes and mask.

    Raises:
        WiseFallbackError: If W1 or W2 exposures are missing, fail download, or
            cannot be calibrated and reprojected.
    """
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

    t0 = time.perf_counter()
    latest_by_band: dict[int, tuple[float, np.ndarray]] = {}
    for _band, exposure in latest_exposure_by_band.items():
        if not exposure.uncertainty_url:
            raise WiseFallbackError("WISE exposure is missing its uncertainty FITS URL.")

    def _download_band_pair(band: int, exposure: WiseExposure) -> tuple[int, float, np.ndarray]:
        if session is requests:
            with ThreadPoolExecutor(max_workers=2) as pair_pool:
                fut_img = pair_pool.submit(_download_fits, exposure.intensity_url, session)
                fut_unc = pair_pool.submit(_download_fits, exposure.uncertainty_url or "", session)
                image, header = fut_img.result()
                uncertainty, uncertainty_header = fut_unc.result()
        else:
            image, header = _download_fits(exposure.intensity_url, session=session)
            uncertainty, uncertainty_header = _download_fits(
                exposure.uncertainty_url or "", session=session
            )
        calibrated = _to_mjy_sr(image, header, band)
        projected = _reproject_to_target(calibrated, header, target_wcs_header)
        uncertainty_mjy_sr = np.abs(
            _to_mjy_sr(uncertainty, uncertainty_header, band, calibration_header=header)
        )
        projected_uncertainty = _reproject_to_target(
            uncertainty_mjy_sr, uncertainty_header, target_wcs_header
        )
        projected[~(np.isfinite(projected_uncertainty) & (projected_uncertainty > 0))] = np.nan
        return band, exposure.mjd, projected

    if session is requests:
        with ThreadPoolExecutor(max_workers=2) as band_pool:
            band_futures = [
                band_pool.submit(_download_band_pair, band, exp)
                for band, exp in latest_exposure_by_band.items()
            ]
            for fut in band_futures:
                b, ep_mjd, proj = fut.result()
                latest_by_band[b] = (ep_mjd, proj)
    else:
        for band, exposure in latest_exposure_by_band.items():
            b, ep_mjd, proj = _download_band_pair(band, exposure)
            latest_by_band[b] = (ep_mjd, proj)

    _logger.info(
        "WISE W1/W2 (%s) fallback downloaded & reprojected %d exposure(s) "
        "for (%.4f, %.4f) in %.2fs",
        IRSA_WISE_DATA_BASE_URL,
        len(exposures),
        ra,
        dec,
        time.perf_counter() - t0,
    )

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
