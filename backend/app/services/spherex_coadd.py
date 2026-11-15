"""Adaptive epoch clustering and six-detector SPHEREx image co-addition.

The module consumes cleaned :class:`SpherexCutout` objects produced by
``spherex_ingest`` (ISS-04), reprojects them onto one shared TAN WCS grid,
and combines valid pixels using inverse-variance weights.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
from astropy.wcs import WCS
from reproject import reproject_interp

from app.services.spherex_ingest import (
    FLAG_BAD_REFERENCE,
    SpherexCutout,
    SpherexValidationError,
)

GRID_SIZE = 256
DETECTOR_COUNT = 6
DEFAULT_EPOCH_GAP_DAYS = 60.0


class SpherexCoaddError(ValueError):
    """Raised when SPHEREx cutouts cannot be clustered or co-added."""


@dataclass(frozen=True)
class SpherexEpochCoadd:
    """Packed detector images and quality flags for one comparison epoch."""

    epoch_id: str
    mjd: float
    mjd_start: float
    mjd_end: float
    detector_data: np.ndarray
    flags_mask: np.ndarray
    detector_buffer: bytes
    flags_buffer: bytes
    wcs_header: dict[str, Any]
    available_detectors: list[int]
    exposure_count: int


@dataclass(frozen=True)
class SpherexCoaddResult:
    """All co-added epochs and the mission availability summary."""

    epochs: list[SpherexEpochCoadd]
    has_multi_epoch_spherex: bool
    needs_wise_fallback: bool
    baseline_days: float

    @property
    def data_source_summary(self) -> dict[str, Any]:
        return {
            "primary_mission": "SPHEREx",
            "has_multi_epoch_spherex": self.has_multi_epoch_spherex,
            "uses_wise_fallback": self.needs_wise_fallback,
            "baseline_days": self.baseline_days,
            "status_note": (
                f"{len(self.epochs)} SPHEREx comparison epoch(s)"
                if self.epochs
                else "No SPHEREx observations available"
            ),
        }


def _validate_cutouts(cutouts: Sequence[SpherexCutout]) -> list[SpherexCutout]:
    valid: list[SpherexCutout] = []
    for cutout in cutouts:
        try:
            mjd = float(cutout.mjd_obs)
        except (TypeError, ValueError) as exc:
            raise SpherexCoaddError("Every cutout must have a numeric MJD timestamp.") from exc
        if not np.isfinite(mjd):
            raise SpherexCoaddError("Every cutout must have a finite MJD timestamp.")
        if np.asarray(cutout.clean_image).ndim != 2:
            raise SpherexCoaddError("SPHEREx cutout images must be two-dimensional.")
        if np.asarray(cutout.variance).shape != np.asarray(cutout.clean_image).shape:
            raise SpherexCoaddError("Cutout variance must have the same shape as its image.")
        if np.asarray(cutout.flags_mask).shape != np.asarray(cutout.clean_image).shape:
            raise SpherexCoaddError("Cutout flags must have the same shape as its image.")
        valid.append(cutout)
    return sorted(valid, key=lambda item: float(item.mjd_obs))


def _split_at_midpoint(items: list[SpherexCutout]) -> list[list[SpherexCutout]]:
    """Split a short baseline into earliest and latest temporal groups."""
    if len(items) < 2:
        return [items]
    midpoint = (float(items[0].mjd_obs) + float(items[-1].mjd_obs)) / 2.0
    first = [item for item in items if float(item.mjd_obs) <= midpoint]
    last = [item for item in items if float(item.mjd_obs) > midpoint]
    if not first or not last:
        first, last = items[:1], items[1:]
    return [first, last]


def cluster_spherex_epochs(
    cutouts: Sequence[SpherexCutout],
    gap_days: float = DEFAULT_EPOCH_GAP_DAYS,
) -> list[list[SpherexCutout]]:
    """Cluster cutouts into comparison epochs using their observation MJDs.

    Gaps greater than ``gap_days`` separate survey-pass clusters. For a
    baseline between one and ``gap_days`` days, the earliest and latest
    observations are separated into two comparison groups. A longer but
    densely sampled baseline with no large individual gap is also split at
    its temporal midpoint so that distinct observing periods are not hidden
    inside one epoch.
    """
    if not np.isfinite(gap_days) or gap_days <= 0:
        raise SpherexValidationError("Epoch gap threshold must be a positive finite number.")

    ordered = _validate_cutouts(cutouts)
    if not ordered:
        return []
    if len(ordered) == 1:
        return [ordered]

    baseline = float(ordered[-1].mjd_obs) - float(ordered[0].mjd_obs)
    if baseline < 1.0:
        return [ordered]

    if baseline <= gap_days:
        return _split_at_midpoint(ordered)

    clusters: list[list[SpherexCutout]] = [[ordered[0]]]
    for cutout in ordered[1:]:
        previous_mjd = float(clusters[-1][-1].mjd_obs)
        current_mjd = float(cutout.mjd_obs)
        if current_mjd - previous_mjd > gap_days:
            clusters.append([cutout])
        else:
            clusters[-1].append(cutout)

    if len(clusters) == 1:
        return _split_at_midpoint(ordered)
    return clusters


def build_target_wcs_header(
    ra: float,
    dec: float,
    fov_deg: float,
    grid_size: int = GRID_SIZE,
) -> dict[str, Any]:
    """Build the canonical north-up 2-D TAN WCS shared by every epoch."""
    values = np.asarray([ra, dec, fov_deg], dtype=np.float64)
    if not np.all(np.isfinite(values)):
        raise SpherexValidationError("RA, Dec and field of view must be finite numbers.")
    if not 0.0 <= ra < 360.0:
        raise SpherexValidationError("Right Ascension must be between 0 and 360 degrees.")
    if not -90.0 <= dec <= 90.0:
        raise SpherexValidationError("Declination must be between -90 and 90 degrees.")
    if fov_deg <= 0.0 or grid_size != GRID_SIZE:
        raise SpherexValidationError("Field of view must be positive and grid size must be 256.")

    pixel_scale = float(fov_deg) / float(grid_size)
    return {
        "NAXIS": 2,
        "NAXIS1": grid_size,
        "NAXIS2": grid_size,
        "CTYPE1": "RA---TAN",
        "CTYPE2": "DEC--TAN",
        "CUNIT1": "deg",
        "CUNIT2": "deg",
        "CRVAL1": float(ra),
        "CRVAL2": float(dec),
        "CRPIX1": (grid_size + 1.0) / 2.0,
        "CRPIX2": (grid_size + 1.0) / 2.0,
        "CDELT1": -pixel_scale,
        "CDELT2": pixel_scale,
        "RADESYS": "ICRS",
        "EQUINOX": 2000.0,
    }


def _detector_index(cutout: SpherexCutout) -> int:
    bandpass = str(cutout.bandpass).strip().upper()
    if not bandpass.startswith("SPHEREX-D"):
        raise SpherexCoaddError(f"Unsupported SPHEREx detector identifier: {cutout.bandpass!r}.")
    try:
        detector = int(bandpass.rsplit("D", 1)[1])
    except (IndexError, ValueError) as exc:
        message = f"Invalid SPHEREx detector identifier: {cutout.bandpass!r}."
        raise SpherexCoaddError(message) from exc
    if not 1 <= detector <= DETECTOR_COUNT:
        raise SpherexCoaddError(f"Detector must be numbered 1 through 6, got {detector}.")
    return detector - 1


def _source_wcs(cutout: SpherexCutout) -> WCS:
    try:
        source_wcs = WCS(cutout.header).celestial
    except Exception as exc:
        raise SpherexCoaddError(
            f"Cutout {cutout.bandpass} at MJD {cutout.mjd_obs} has an invalid WCS header."
        ) from exc
    if not source_wcs.has_celestial:
        raise SpherexCoaddError(
            f"Cutout {cutout.bandpass} at MJD {cutout.mjd_obs} has no celestial WCS."
        )
    return source_wcs


def _reproject_cutout(
    cutout: SpherexCutout,
    target_wcs: WCS,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    image = np.asarray(cutout.clean_image, dtype=np.float32)
    variance = np.asarray(cutout.variance, dtype=np.float32)
    flags = np.asarray(cutout.flags_mask, dtype=np.uint8)
    source_wcs = _source_wcs(cutout)

    valid = (
        np.isfinite(image)
        & np.isfinite(variance)
        & (variance > 0.0)
        & (flags == 0)
    )
    masked_image = image.astype(np.float64, copy=True)
    masked_image[~valid] = np.nan
    projected_image, image_footprint = reproject_interp(
        (masked_image, source_wcs), target_wcs, shape_out=(GRID_SIZE, GRID_SIZE), order="bilinear"
    )
    # Nearest-neighbour variance avoids inventing a lower variance by
    # interpolating independent input-pixel variances as ordinary intensities.
    masked_variance = variance.astype(np.float64, copy=True)
    masked_variance[~valid] = np.nan
    projected_variance, variance_footprint = reproject_interp(
        (masked_variance, source_wcs),
        target_wcs,
        shape_out=(GRID_SIZE, GRID_SIZE),
        order="nearest-neighbor",
    )
    projected_flags, flags_footprint = reproject_interp(
        (flags, source_wcs),
        target_wcs,
        shape_out=(GRID_SIZE, GRID_SIZE),
        order="nearest-neighbor",
    )

    footprint = (
        (image_footprint > 0)
        & (variance_footprint > 0)
        & (flags_footprint > 0)
    )
    projected_image = np.asarray(projected_image, dtype=np.float64)
    projected_variance = np.asarray(projected_variance, dtype=np.float64)
    projected_flags = np.nan_to_num(projected_flags, nan=0.0).astype(np.uint8)
    valid_projected = (
        footprint
        & (projected_flags == 0)
        & np.isfinite(projected_image)
        & np.isfinite(projected_variance)
        & (projected_variance > 0.0)
    )
    return projected_image, projected_variance, projected_flags, valid_projected


def coadd_spherex_epoch(
    cutouts: Sequence[SpherexCutout],
    target_wcs_header: dict[str, Any],
    epoch_id: str = "pass_1",
) -> SpherexEpochCoadd:
    """Reproject and inverse-variance co-add one epoch onto the target grid."""
    if not cutouts:
        raise SpherexCoaddError("Cannot co-add an empty SPHEREx epoch.")

    target_wcs = WCS(target_wcs_header).celestial
    detector_numerator = np.zeros((DETECTOR_COUNT, GRID_SIZE, GRID_SIZE), dtype=np.float64)
    detector_weight = np.zeros_like(detector_numerator)
    combined_flags = np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.uint8)
    available: set[int] = set()

    for cutout in cutouts:
        detector = _detector_index(cutout)
        image, variance, flags, valid = _reproject_cutout(cutout, target_wcs)
        combined_flags |= flags
        weights = np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.float64)
        weights[valid] = 1.0 / variance[valid]
        detector_numerator[detector] += np.where(valid, image * weights, 0.0)
        detector_weight[detector] += weights
        if np.any(valid):
            available.add(detector + 1)

    detector_data = np.zeros_like(detector_numerator, dtype="<f4")
    has_weight = detector_weight > 0.0
    detector_data[has_weight] = (
        detector_numerator[has_weight] / detector_weight[has_weight]
    ).astype("<f4")
    detector_data = np.nan_to_num(detector_data, nan=0.0, posinf=0.0, neginf=0.0)
    combined_flags = np.asarray(combined_flags, dtype=np.uint8)
    combined_flags[~np.any(has_weight, axis=0)] |= FLAG_BAD_REFERENCE

    detector_data = np.ascontiguousarray(detector_data, dtype="<f4")
    combined_flags = np.ascontiguousarray(combined_flags, dtype=np.uint8)
    detector_buffer = detector_data.tobytes(order="C")
    flags_buffer = combined_flags.tobytes(order="C")

    expected_detector_bytes = DETECTOR_COUNT * GRID_SIZE * GRID_SIZE * 4
    expected_flag_bytes = GRID_SIZE * GRID_SIZE
    if len(detector_buffer) != expected_detector_bytes:
        raise SpherexCoaddError("Packed detector buffer has an unexpected byte length.")
    if len(flags_buffer) != expected_flag_bytes:
        raise SpherexCoaddError("Packed flags buffer has an unexpected byte length.")

    mjds = np.asarray([float(item.mjd_obs) for item in cutouts], dtype=np.float64)
    return SpherexEpochCoadd(
        epoch_id=epoch_id,
        mjd=float(np.median(mjds)),
        mjd_start=float(np.min(mjds)),
        mjd_end=float(np.max(mjds)),
        detector_data=detector_data,
        flags_mask=combined_flags,
        detector_buffer=detector_buffer,
        flags_buffer=flags_buffer,
        wcs_header=dict(target_wcs_header),
        available_detectors=sorted(available),
        exposure_count=len(cutouts),
    )


def coadd_spherex_epochs(
    cutouts: Sequence[SpherexCutout],
    ra: float,
    dec: float,
    fov_deg: float,
    gap_days: float = DEFAULT_EPOCH_GAP_DAYS,
) -> SpherexCoaddResult:
    """Cluster cleaned cutouts and co-add every epoch on one canonical grid."""
    ordered = _validate_cutouts(cutouts)
    clusters = cluster_spherex_epochs(ordered, gap_days=gap_days)
    target_header = build_target_wcs_header(ra, dec, fov_deg)
    epochs = [
        coadd_spherex_epoch(cluster, target_header, epoch_id=f"pass_{index + 1}")
        for index, cluster in enumerate(clusters)
    ]
    baseline = (
        float(ordered[-1].mjd_obs) - float(ordered[0].mjd_obs)
        if len(ordered) >= 2
        else 0.0
    )
    multi_epoch = len(epochs) >= 2
    return SpherexCoaddResult(
        epochs=epochs,
        has_multi_epoch_spherex=multi_epoch,
        needs_wise_fallback=not multi_epoch,
        baseline_days=max(0.0, baseline),
    )


# Explicit aliases make the service convenient to call from existing routes.
cluster_epochs = cluster_spherex_epochs
build_tan_wcs_header = build_target_wcs_header
coadd_epochs = coadd_spherex_epochs
