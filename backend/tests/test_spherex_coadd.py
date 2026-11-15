"""Tests for adaptive SPHEREx epoch clustering and WCS co-addition."""

from __future__ import annotations

import unittest

import numpy as np
from astropy.wcs import WCS

from app.services.spherex_coadd import (
    GRID_SIZE,
    SpherexCoaddError,
    build_target_wcs_header,
    cluster_spherex_epochs,
    coadd_spherex_epoch,
    coadd_spherex_epochs,
)
from app.services.spherex_ingest import (
    FLAG_BAD_REFERENCE,
    SpherexCutout,
)


def make_cutout(
    mjd: float,
    detector: int = 1,
    image_value: float = 10.0,
    variance_value: float = 1.0,
    shape: tuple[int, int] = (32, 32),
    ra: float = 120.0,
    dec: float = -20.0,
    pixel_scale_deg: float = 0.01,
    star: bool = False,
    flags: np.ndarray | None = None,
) -> SpherexCutout:
    image = np.full(shape, image_value, dtype=np.float32)
    if star:
        image[shape[0] // 2, shape[1] // 2] = 100.0
    variance = np.full(shape, variance_value, dtype=np.float32)
    mask = np.zeros(shape, dtype=np.uint8) if flags is None else flags.astype(np.uint8)

    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.cunit = ["deg", "deg"]
    wcs.wcs.crval = [ra, dec]
    wcs.wcs.crpix = [(shape[1] + 1.0) / 2.0, (shape[0] + 1.0) / 2.0]
    wcs.wcs.cdelt = [-pixel_scale_deg, pixel_scale_deg]

    return SpherexCutout(
        clean_image=image,
        variance=variance,
        weight_map=np.where(mask == 0, 1.0 / variance, 0.0).astype(np.float32),
        flags_mask=mask,
        mjd_obs=mjd,
        bandpass=f"SPHEREx-D{detector}",
        header=dict(wcs.to_header()),
    )


class TestAdaptiveEpochClustering(unittest.TestCase):
    def test_single_observation_is_one_epoch(self) -> None:
        clusters = cluster_spherex_epochs([make_cutout(60000.0)])
        self.assertEqual(len(clusters), 1)
        self.assertEqual(len(clusters[0]), 1)

    def test_baseline_below_one_day_remains_one_epoch(self) -> None:
        clusters = cluster_spherex_epochs([make_cutout(60000.0), make_cutout(60000.5)])
        self.assertEqual(len(clusters), 1)

    def test_short_baseline_splits_earliest_and_latest(self) -> None:
        cutouts = [make_cutout(mjd) for mjd in (60000.0, 60002.0, 60020.0, 60030.0)]
        clusters = cluster_spherex_epochs(cutouts)
        self.assertEqual(len(clusters), 2)
        self.assertEqual([item.mjd_obs for item in clusters[0]], [60000.0, 60002.0])
        self.assertEqual([item.mjd_obs for item in clusters[1]], [60020.0, 60030.0])

    def test_large_gaps_separate_survey_passes(self) -> None:
        cutouts = [make_cutout(mjd) for mjd in (59000.0, 59001.0, 59182.0, 59183.0, 59365.0)]
        clusters = cluster_spherex_epochs(cutouts)
        self.assertEqual([len(cluster) for cluster in clusters], [2, 2, 1])

    def test_dense_long_baseline_still_produces_comparison_epochs(self) -> None:
        cutouts = [make_cutout(mjd) for mjd in (59000.0, 59030.0, 59060.0, 59090.0)]
        clusters = cluster_spherex_epochs(cutouts)
        self.assertEqual(len(clusters), 2)


class TestCanonicalTanWcs(unittest.TestCase):
    def test_builds_shared_256_tan_grid(self) -> None:
        header = build_target_wcs_header(120.0, -20.0, 0.256)
        self.assertEqual(header["NAXIS1"], GRID_SIZE)
        self.assertEqual(header["NAXIS2"], GRID_SIZE)
        self.assertEqual(header["CTYPE1"], "RA---TAN")
        self.assertEqual(header["CTYPE2"], "DEC--TAN")
        self.assertAlmostEqual(abs(header["CDELT1"]), 0.001)
        self.assertAlmostEqual(header["CDELT2"], 0.001)
        self.assertEqual(header["CRVAL1"], 120.0)
        self.assertEqual(header["CRVAL2"], -20.0)


class TestSixDetectorCoaddition(unittest.TestCase):
    def setUp(self) -> None:
        self.target_header = build_target_wcs_header(120.0, -20.0, 0.32)

    def test_inverse_variance_weighting(self) -> None:
        cutouts = [
            make_cutout(60000.0, image_value=10.0, variance_value=1.0),
            make_cutout(60000.2, image_value=20.0, variance_value=4.0),
        ]
        epoch = coadd_spherex_epoch(cutouts, self.target_header)
        # (10 * 1 + 20 * 0.25) / 1.25 = 12
        self.assertAlmostEqual(float(epoch.detector_data[0, 128, 128]), 12.0, places=4)

    def test_flagged_pixels_are_excluded(self) -> None:
        flags = np.zeros((32, 32), dtype=np.uint8)
        flags[16, 16] = int(FLAG_BAD_REFERENCE)
        cutouts = [
            make_cutout(60000.0, image_value=100.0, flags=flags),
            make_cutout(60000.1, image_value=7.0),
        ]
        epoch = coadd_spherex_epoch(cutouts, self.target_header)
        self.assertAlmostEqual(float(epoch.detector_data[0, 128, 128]), 7.0, places=4)
        self.assertNotEqual(int(epoch.flags_mask[128, 128]) & int(FLAG_BAD_REFERENCE), 0)

    def test_missing_detector_planes_are_zero_filled(self) -> None:
        epoch = coadd_spherex_epoch([make_cutout(60000.0, detector=3)], self.target_header)
        self.assertEqual(epoch.detector_data.shape, (6, 256, 256))
        empty_plane = np.zeros((256, 256), dtype=np.float32)
        np.testing.assert_array_equal(epoch.detector_data[0], empty_plane)
        self.assertGreater(float(epoch.detector_data[2].max()), 0.0)
        self.assertEqual(epoch.available_detectors, [3])

    def test_output_buffers_have_required_sizes_and_are_finite(self) -> None:
        cutouts = [make_cutout(60000.0, detector=index) for index in range(1, 7)]
        epoch = coadd_spherex_epoch(cutouts, self.target_header)
        self.assertEqual(len(epoch.detector_buffer), 1_572_864)
        self.assertEqual(len(epoch.flags_buffer), 65_536)
        self.assertEqual(epoch.detector_data.dtype, np.dtype("<f4"))
        self.assertTrue(epoch.detector_data.flags.c_contiguous)
        self.assertTrue(np.isfinite(epoch.detector_data).all())
        self.assertTrue(np.isfinite(epoch.flags_mask).all())

    def test_stationary_source_reprojects_to_same_target_pixel(self) -> None:
        first = make_cutout(59000.0, star=True, pixel_scale_deg=0.01)
        second = make_cutout(59182.0, star=True, pixel_scale_deg=0.008)
        epoch_a = coadd_spherex_epoch([first], self.target_header, "pass_1")
        epoch_b = coadd_spherex_epoch([second], self.target_header, "pass_2")
        peak_a = np.unravel_index(np.argmax(epoch_a.detector_data[0]), (256, 256))
        peak_b = np.unravel_index(np.argmax(epoch_b.detector_data[0]), (256, 256))
        distance = np.hypot(peak_a[0] - peak_b[0], peak_a[1] - peak_b[1])
        self.assertLess(distance, 0.5)

    def test_summary_uses_actual_epoch_count_and_baseline(self) -> None:
        cutouts = [
            make_cutout(59000.0),
            make_cutout(59001.0),
            make_cutout(59182.0),
            make_cutout(59183.0),
        ]
        result = coadd_spherex_epochs(cutouts, 120.0, -20.0, 0.32)
        self.assertTrue(result.has_multi_epoch_spherex)
        self.assertFalse(result.needs_wise_fallback)
        self.assertAlmostEqual(result.baseline_days, 183.0)
        self.assertEqual(result.data_source_summary["baseline_days"], 183.0)
        self.assertTrue(result.data_source_summary["has_multi_epoch_spherex"])

    def test_single_epoch_requests_wise_fallback(self) -> None:
        result = coadd_spherex_epochs([make_cutout(59000.0)], 120.0, -20.0, 0.32)
        self.assertFalse(result.has_multi_epoch_spherex)
        self.assertTrue(result.needs_wise_fallback)
        self.assertEqual(result.baseline_days, 0.0)

    def test_cutout_without_wcs_is_rejected(self) -> None:
        cutout = make_cutout(60000.0)
        cutout.header = {}
        with self.assertRaises(SpherexCoaddError):
            coadd_spherex_epoch([cutout], self.target_header)


if __name__ == "__main__":
    unittest.main()
