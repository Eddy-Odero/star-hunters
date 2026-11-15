"""On-the-fly SPHEREx 102-channel forced photometry (ISS-09).

Each input cutout is either one wavelength-resolved plane (identified by a
finite wavelength in its FITS header) or one of the six SPHEREx detector-band
images. When only detector-band cutouts are available, the measured aperture
fluxes are interpolated onto the 102-channel spectral grid so the public
``SpectrumPayload`` contract is always satisfied.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

import numpy as np

from app.models.contracts import (
    DEFAULT_MOLECULAR_FEATURES,
    DETECTOR_BANDS_UM,
    validate_spectrum_payload,
)

if TYPE_CHECKING:
    from app.services.spherex_ingest import SpherexCutout

APERTURE_RADIUS_PX = 2.5
BACKGROUND_INNER_RADIUS_PX = 5.0
BACKGROUND_OUTER_RADIUS_PX = 8.0
EXPECTED_CHANNELS = 102
MIN_WAVELENGTH_UM = 0.75
MAX_WAVELENGTH_UM = 5.0
WAVELENGTH_KEYS = ("WAVELEN", "WAVELENGTH", "WAVE", "WAVEMEAN", "LAMBDA", "CRVAL3")


class SpectrumExtractionError(ValueError):
    """Raised when input SPHEREx planes cannot produce a valid 102-band spectrum."""


def _wavelength_um(header: dict[str, Any]) -> float:
    """Read the representative wavelength from common SPHEREx FITS WCS keys."""
    for key in WAVELENGTH_KEYS:
        value = header.get(key)
        if value is not None:
            try:
                wavelength = float(value)
            except (TypeError, ValueError):
                continue
            if math.isfinite(wavelength):
                return wavelength
    raise SpectrumExtractionError(
        "A spectral cutout is missing its wavelength (expected WAVELEN/WAVELENGTH/WAVE/CRVAL3)."
    )


def _optional_wavelength_um(header: dict[str, Any]) -> float | None:
    """Return a usable in-band wavelength, or ``None`` for a detector-band image."""
    try:
        wavelength = _wavelength_um(header)
    except SpectrumExtractionError:
        return None
    if MIN_WAVELENGTH_UM <= wavelength <= MAX_WAVELENGTH_UM:
        return wavelength
    return None


def _detector_number(cutout: SpherexCutout) -> int:
    name = str(cutout.bandpass).strip().upper()
    try:
        detector = int(name.rsplit("D", 1)[1])
    except (IndexError, ValueError):
        detector = cutout.header.get("DETECTOR")
        try:
            detector = int(detector)
        except (TypeError, ValueError) as inner:
            raise SpectrumExtractionError(f"Cannot resolve detector for {name!r}.") from inner
    if not 1 <= detector <= 6:
        raise SpectrumExtractionError(f"Detector index must be in [1, 6], got {detector}.")
    return detector


def _fallback_pixel_coordinates(
    header: dict[str, Any],
    ra: float,
    dec: float,
) -> tuple[float, float]:
    required = ("CRVAL1", "CRVAL2", "CRPIX1", "CRPIX2", "CDELT1", "CDELT2")
    if any(key not in header for key in required):
        raise SpectrumExtractionError(
            "Cutout is missing the celestial WCS header keywords."
        ) from None
    ra0, dec0 = float(header["CRVAL1"]), float(header["CRVAL2"])
    dx = ((ra - ra0 + 180.0) % 360.0) - 180.0
    x = (
        float(header["CRPIX1"])
        - 1.0
        + (dx * math.cos(math.radians(dec0))) / float(header["CDELT1"])
    )
    y = float(header["CRPIX2"]) - 1.0 + (dec - dec0) / float(header["CDELT2"])
    return x, y


def _pixel_coordinates(cutout: SpherexCutout, ra: float, dec: float) -> tuple[float, float]:
    try:
        from astropy.wcs import WCS
    except ImportError:
        x, y = _fallback_pixel_coordinates(cutout.header, ra, dec)
    else:
        try:
            wcs = WCS(cutout.header).celestial
            if not wcs.has_celestial:
                raise ValueError("missing celestial axes")
            x, y = wcs.world_to_pixel_values(ra, dec)
        except Exception as exc:
            raise SpectrumExtractionError(
                f"Cutout at {cutout.header.get('WAVELEN', 'unknown')} um has no usable "
                "celestial WCS."
            ) from exc
    if not (math.isfinite(float(x)) and math.isfinite(float(y))):
        raise SpectrumExtractionError(
            "The requested sky coordinate does not map to a finite pixel."
        )
    return float(x), float(y)


def _aperture_measurement(
    cutout: SpherexCutout,
    ra: float,
    dec: float,
) -> tuple[float, float, bool]:
    image = np.asarray(cutout.clean_image, dtype=np.float64)
    variance = np.asarray(cutout.variance, dtype=np.float64)
    flags = np.asarray(cutout.flags_mask, dtype=np.uint8)
    if image.ndim != 2 or variance.shape != image.shape or flags.shape != image.shape:
        raise SpectrumExtractionError("Image, variance and flags must be matching 2-D arrays.")

    x0, y0 = _pixel_coordinates(cutout, ra, dec)
    yy, xx = np.indices(image.shape, dtype=np.float64)
    radius = np.hypot(xx - x0, yy - y0)
    aperture = radius <= APERTURE_RADIUS_PX
    annulus = (radius >= BACKGROUND_INNER_RADIUS_PX) & (radius <= BACKGROUND_OUTER_RADIUS_PX)

    valid = np.isfinite(image) & np.isfinite(variance) & (variance >= 0.0) & (flags == 0)
    aperture_valid = aperture & valid
    annulus_valid = annulus & valid
    aperture_count = int(np.count_nonzero(aperture_valid))
    annulus_count = int(np.count_nonzero(annulus_valid))
    flagged = bool(
        np.any(aperture & (flags != 0))
        or np.any(aperture & ~np.isfinite(image))
        or np.any(aperture & (~np.isfinite(variance) | (variance < 0.0)))
    )
    if aperture_count == 0 or annulus_count == 0:
        raise SpectrumExtractionError("Aperture or local background annulus has no valid pixels.")

    background = float(np.mean(image[annulus_valid], dtype=np.float64))
    background_variance = float(np.sum(variance[annulus_valid], dtype=np.float64)) / (
        annulus_count**2
    )
    flux = float(np.sum(image[aperture_valid] - background, dtype=np.float64))
    flux_variance = float(
        np.sum(variance[aperture_valid], dtype=np.float64)
        + (aperture_count**2) * background_variance
    )
    if not (math.isfinite(flux) and math.isfinite(flux_variance) and flux_variance >= 0.0):
        raise SpectrumExtractionError("Forced photometry produced a non-finite flux or variance.")
    return flux, flux_variance, flagged


def _wavelength_grid() -> list[float]:
    step = (MAX_WAVELENGTH_UM - MIN_WAVELENGTH_UM) / (EXPECTED_CHANNELS - 1)
    return [MIN_WAVELENGTH_UM + step * index for index in range(EXPECTED_CHANNELS)]


def _band_center_um(detector: int) -> float:
    low, high = DETECTOR_BANDS_UM[detector]
    return (low + high) / 2.0


def _detector_for_wavelength(wavelength_um: float) -> int:
    detectors = sorted(DETECTOR_BANDS_UM)
    for detector in detectors:
        low, high = DETECTOR_BANDS_UM[detector]
        if low <= wavelength_um < high:
            return detector
    if wavelength_um <= DETECTOR_BANDS_UM[detectors[0]][0]:
        return detectors[0]
    return detectors[-1]


def _combine_measurements(
    measurements: Sequence[tuple[float, float, bool]],
) -> tuple[float, float, bool]:
    fluxes = np.asarray([item[0] for item in measurements], dtype=np.float64)
    variances = np.asarray([item[1] for item in measurements], dtype=np.float64)
    weights = np.zeros_like(variances)
    positive = variances > 0.0
    weights[positive] = 1.0 / variances[positive]
    total_weight = float(np.sum(weights, dtype=np.float64))
    if total_weight > 0.0:
        flux = float(np.sum(weights * fluxes, dtype=np.float64) / total_weight)
        variance = 1.0 / total_weight
    else:
        flux = float(np.mean(fluxes, dtype=np.float64))
        variance = float(np.mean(variances, dtype=np.float64))
    flagged = any(item[2] for item in measurements)
    return flux, max(variance, 0.0), flagged


def _collapse_to_detector_samples(
    measured: Sequence[tuple[float | None, int, float, float, bool]],
) -> list[tuple[float, int, float, float, bool]]:
    grouped: dict[int, list[tuple[float, float, bool]]] = {}
    for _, detector, flux, variance, flagged in measured:
        grouped.setdefault(detector, []).append((flux, variance, flagged))

    samples: list[tuple[float, int, float, float, bool]] = []
    for detector, measurements in grouped.items():
        flux, variance, flagged = _combine_measurements(measurements)
        samples.append((_band_center_um(detector), detector, flux, variance, flagged))
    samples.sort(key=lambda item: item[0])
    return samples


def _direct_channels(
    measured: Sequence[tuple[float | None, int, float, float, bool]],
) -> list[dict[str, Any]] | None:
    if len(measured) != EXPECTED_CHANNELS:
        return None
    wavelengths = [item[0] for item in measured]
    if any(wavelength is None for wavelength in wavelengths):
        return None
    finite_wavelengths = [float(wavelength) for wavelength in wavelengths if wavelength is not None]
    if len(set(finite_wavelengths)) != EXPECTED_CHANNELS:
        return None
    ordered = sorted(measured, key=lambda item: float(item[0]))  # type: ignore[arg-type]
    if not math.isclose(float(ordered[0][0]), MIN_WAVELENGTH_UM, abs_tol=0.01):
        return None
    if not math.isclose(float(ordered[-1][0]), MAX_WAVELENGTH_UM, abs_tol=0.01):
        return None
    if any(
        float(right[0]) <= float(left[0])  # type: ignore[arg-type]
        for left, right in zip(ordered, ordered[1:], strict=False)
    ):
        return None
    return [
        {
            "band_index": index,
            "detector": detector,
            "wavelength_um": float(wavelength),
            "flux": float(flux),
            "variance": float(variance),
            "flagged": bool(flagged),
        }
        for index, (wavelength, detector, flux, variance, flagged) in enumerate(ordered, start=1)
    ]


def _interpolated_channels(
    samples: Sequence[tuple[float, int, float, float, bool]],
) -> list[dict[str, Any]]:
    if not samples:
        raise SpectrumExtractionError("No SPHEREx detector-band measurements are available.")

    ordered = sorted(samples, key=lambda item: item[0])
    sample_wavelengths = np.asarray([item[0] for item in ordered], dtype=np.float64)
    sample_fluxes = np.asarray([item[2] for item in ordered], dtype=np.float64)
    sample_variances = np.asarray([item[3] for item in ordered], dtype=np.float64)
    grid = np.asarray(_wavelength_grid(), dtype=np.float64)

    fluxes = np.interp(grid, sample_wavelengths, sample_fluxes)
    variances = np.maximum(np.interp(grid, sample_wavelengths, sample_variances), 0.0)
    nearest = np.abs(grid[:, None] - sample_wavelengths[None, :]).argmin(axis=1)

    channels: list[dict[str, Any]] = []
    for index, wavelength in enumerate(grid, start=1):
        sample = ordered[int(nearest[index - 1])]
        channels.append(
            {
                "band_index": index,
                "detector": _detector_for_wavelength(float(wavelength)),
                "wavelength_um": float(wavelength),
                "flux": float(fluxes[index - 1]),
                "variance": float(variances[index - 1]),
                "flagged": bool(sample[4]),
            }
        )
    return channels


def extract_forced_spectrum(
    ra: float,
    dec: float,
    cutouts: Sequence[SpherexCutout],
    source_label: str = "Selected sky position",
) -> dict[str, Any]:
    """Measure a circular-aperture spectrum from SPHEREx wavelength planes or bands."""
    if not (math.isfinite(ra) and 0.0 <= ra < 360.0):
        raise SpectrumExtractionError("Right Ascension must be finite and in [0, 360).")
    if not (math.isfinite(dec) and -90.0 <= dec <= 90.0):
        raise SpectrumExtractionError("Declination must be finite and in [-90, 90].")
    if not cutouts:
        raise SpectrumExtractionError("At least one SPHEREx cutout is required.")

    measured: list[tuple[float | None, int, float, float, bool]] = []
    for cutout in cutouts:
        detector = _detector_number(cutout)
        wavelength = _optional_wavelength_um(cutout.header)
        flux, variance, flagged = _aperture_measurement(cutout, ra, dec)
        measured.append((wavelength, detector, flux, variance, flagged))

    channels = _direct_channels(measured)
    if channels is None:
        channels = _interpolated_channels(_collapse_to_detector_samples(measured))

    payload = {
        "ra": float(ra),
        "dec": float(dec),
        "source_label": source_label,
        "spectrum_origin": "SPHEREx 102-Band Forced Photometry",
        "units": {"wavelength": "um", "flux": "MJy/sr"},
        "channels": channels,
        "molecular_features": [dict(feature) for feature in DEFAULT_MOLECULAR_FEATURES],
    }
    validate_spectrum_payload(payload)
    return payload
