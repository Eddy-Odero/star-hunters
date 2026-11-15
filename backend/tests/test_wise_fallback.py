"""Offline tests for WISE/NEOWISE fallback buffers and metadata."""

from __future__ import annotations

import gzip
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
from astropy.io import fits

from app.services.backend_service import StarHuntersBackendService
from app.services.spatial_cache import SpatialSqliteCache, compute_grid_key
from app.services.wise_fallback import (
    WiseFallbackError,
    WiseFallbackResult,
    _download_fits,
    _to_mjy_sr,
    assemble_wise_detector_planes,
    query_wise_exposures,
)


class TestWiseFallback(unittest.TestCase):
    def test_w1_w2_are_packed_into_detector_planes_4_5_6(self) -> None:
        w1 = np.full((256, 256), 1.25, dtype=np.float32)
        w2 = np.full((256, 256), 2.5, dtype=np.float32)
        data, flags, packed, flags_packed = assemble_wise_detector_planes(w1, w2)

        self.assertEqual(data.shape, (6, 256, 256))
        self.assertEqual(data.dtype, np.dtype("<f4"))
        self.assertEqual(len(packed), 1_572_864)
        self.assertEqual(flags.shape, (256, 256))
        self.assertEqual(len(flags_packed), 65_536)
        self.assertTrue(np.all(data[0:3] == 0))
        self.assertTrue(np.all(data[3] == 1.25))
        self.assertTrue(np.all(data[4] == 2.5))
        self.assertTrue(np.all(data[5] == 2.5))
        self.assertEqual(int(flags.sum()), 0)

    def test_uncertainty_calibration_reuses_intensity_magzp(self) -> None:
        intensity_header = fits.Header()
        intensity_header["BUNIT"] = "DN"
        intensity_header["MAGZP"] = 20.0
        intensity_header["CTYPE1"] = "RA---TAN"
        intensity_header["CTYPE2"] = "DEC--TAN"
        intensity_header["CRVAL1"] = 120.0
        intensity_header["CRVAL2"] = 5.0
        intensity_header["CRPIX1"] = 1.0
        intensity_header["CRPIX2"] = 1.0
        intensity_header["CDELT1"] = -0.001
        intensity_header["CDELT2"] = 0.001
        uncertainty_header = intensity_header.copy()
        del uncertainty_header["MAGZP"]
        values = np.ones((2, 2), dtype=np.float32)

        calibrated = _to_mjy_sr(
            values,
            uncertainty_header,
            1,
            calibration_header=intensity_header,
        )
        expected = _to_mjy_sr(values, intensity_header, 1)

        self.assertTrue(np.all(calibrated > 0))
        np.testing.assert_allclose(calibrated, expected)

    def test_gzip_compressed_fits_cutout_is_decompressed(self) -> None:
        hdu = fits.PrimaryHDU(np.ones((4, 4), dtype=np.float32))
        hdu.header["BUNIT"] = "MJy/sr"
        buffer = io.BytesIO()
        fits.HDUList([hdu]).writeto(buffer)
        payload = gzip.compress(buffer.getvalue())
        response = SimpleNamespace(content=payload, raise_for_status=Mock())
        session = SimpleNamespace(get=Mock(return_value=response))

        data, header = _download_fits("mock://wise/cutout.fits", session=session)

        self.assertEqual(data.shape, (4, 4))
        self.assertEqual(header["BUNIT"], "MJy/sr")

    def test_invalid_shape_is_rejected(self) -> None:
        with self.assertRaises(WiseFallbackError):
            assemble_wise_detector_planes(np.ones((32, 32)), np.ones((256, 256)))

    def test_zero_or_nonfinite_band_is_rejected(self) -> None:
        with self.assertRaises(WiseFallbackError):
            assemble_wise_detector_planes(np.zeros((256, 256)), np.ones((256, 256)))

    def test_query_builds_quality_screened_w1_w2_exposure_records(self) -> None:
        response = SimpleNamespace(
            text=(
                "band,mjd_obs,qual_frame,scan_id,frame_num\n"
                "1,55000.0,10,44213b,121\n"
                "2,59000.0,10,53318b,14\n"
            ),
            raise_for_status=Mock(),
        )
        empty_response = SimpleNamespace(
            text="band,mjd_obs,qual_frame,scan_id,frame_num\n", raise_for_status=Mock()
        )
        session = SimpleNamespace(get=Mock(side_effect=[response, empty_response]))
        rows = query_wise_exposures(120.0, 5.0, 5.0, session=session)

        self.assertEqual(len(rows), 2)
        self.assertEqual([row.band for row in rows], [1, 2])
        self.assertEqual(rows[0].mjd, 55000.0)
        self.assertIn("44213b121-w1-unc-1b.fits.gz", rows[0].uncertainty_url)
        self.assertIn("center=120.00000000%2C5.00000000deg", rows[0].intensity_url)
        kwargs = session.get.call_args.kwargs
        self.assertEqual(kwargs["params"]["POS"], "120.00000000,5.00000000")
        self.assertEqual(kwargs["params"]["where"], "band in (1,2) and qual_frame=10")
        self.assertIn("/allsky/4band_p1bm_frm/", rows[0].intensity_url)

    def test_backend_uses_wise_when_spherex_has_fewer_than_two_epochs(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            cache = SpatialSqliteCache(db_path=str(Path(temp_dir) / "wise.db"))
            self.addCleanup(cache.close)
            w1 = np.full((256, 256), 0.75, dtype=np.float32)
            w2 = np.full((256, 256), 1.5, dtype=np.float32)
            data, flags, detector_bytes, flags_bytes = assemble_wise_detector_planes(w1, w2)
            wise_result = WiseFallbackResult(
                detector_data=data,
                detector_buffer=detector_bytes,
                flags_mask=flags,
                flags_buffer=flags_bytes,
                wcs_header={"CTYPE1": "RA---TAN", "CTYPE2": "DEC--TAN"},
                mjd=56000.0,
                mjd_start=55000.0,
                mjd_end=57000.0,
                available_detectors=[4, 5, 6],
                exposure_count=8,
            )
            service = StarHuntersBackendService(
                cache=cache,
                enable_archival_data=True,
                spherex_cutout_fetcher=lambda **_kwargs: [],
                wcs_header_builder=lambda *_args: {
                    "CTYPE1": "RA---TAN",
                    "CTYPE2": "DEC--TAN",
                },
                spherex_coadder=lambda *_args: SimpleNamespace(
                    epochs=[], needs_wise_fallback=True, baseline_days=0.0
                ),
                wise_fallback_fetcher=lambda **_kwargs: wise_result,
            )
            manifest = service.get_sky_patch(120.0, 5.0, 5.0)

            self.assertTrue(manifest["data_source_summary"]["uses_wise_fallback"])
            self.assertFalse(manifest["data_source_summary"]["has_multi_epoch_spherex"])
            self.assertEqual(manifest["data_source_summary"]["primary_mission"], "WISE")
            self.assertGreaterEqual(manifest["data_source_summary"]["baseline_days"], 2000.0)
            self.assertEqual(manifest["epochs"][0]["available_detectors"], [4, 5, 6])
            self.assertEqual(manifest["epochs"][0]["mission"], "WISE")
            grid_key, _, _ = compute_grid_key(120.0, 5.0, 5.0)
            cached_frame = cache.get_frame(grid_key, "wise_fallback.bin")
            self.assertEqual(len(cached_frame), 1_572_864)
            cached_flags = cache.get_frame(grid_key, "wise_fallback_flags.bin")
            self.assertEqual(len(cached_flags), 65_536)

    def test_capital_fallback_prewarms_wise_patch_and_cross_mission_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            cache = SpatialSqliteCache(db_path=str(Path(temp_dir) / "capital.db"))
            self.addCleanup(cache.close)
            w1 = np.full((256, 256), 0.5, dtype=np.float32)
            w2 = np.full((256, 256), 1.25, dtype=np.float32)
            data, flags, detector_bytes, flags_bytes = assemble_wise_detector_planes(w1, w2)
            wise_result = WiseFallbackResult(
                detector_data=data,
                detector_buffer=detector_bytes,
                flags_mask=flags,
                flags_buffer=flags_bytes,
                wcs_header={"CTYPE1": "RA---TAN", "CTYPE2": "DEC--TAN"},
                mjd=57000.0,
                mjd_start=55000.0,
                mjd_end=57000.0,
                available_detectors=[4, 5, 6],
                exposure_count=3,
            )
            spherex_epoch = SimpleNamespace(
                epoch_id="pass_1",
                mjd=60000.0,
                detector_buffer=bytes(1_572_864),
                flags_buffer=bytes(65_536),
                available_detectors=[1, 2, 3, 4, 5, 6],
            )
            service = StarHuntersBackendService(
                cache=cache,
                enable_archival_data=True,
                spherex_cutout_fetcher=lambda **_kwargs: [],
                wcs_header_builder=lambda *_args: {
                    "CTYPE1": "RA---TAN",
                    "CTYPE2": "DEC--TAN",
                },
                spherex_coadder=lambda *_args: SimpleNamespace(
                    epochs=[spherex_epoch], needs_wise_fallback=True, baseline_days=0.0
                ),
                wise_fallback_fetcher=lambda **_kwargs: wise_result,
            )
            first = service.get_earth_to_sky(
                lat=None,
                lon=None,
                iso_time="2026-11-14T16:21:00Z",
                fallback_seed=7,
                prewarm_patch=True,
            )
            second = service.get_earth_to_sky(
                lat=None,
                lon=None,
                iso_time="2026-11-14T16:21:00Z",
                fallback_seed=7,
                prewarm_patch=True,
            )

            self.assertTrue(first["earth"]["is_fallback_capital"])
            self.assertTrue(second["earth"]["cached"])
            grid_key, _, _ = compute_grid_key(
                first["zenith_icrs"]["ra"], first["zenith_icrs"]["dec"], 5.0
            )
            manifest = cache.get_manifest(grid_key)
            self.assertIsNotNone(manifest)
            self.assertTrue(manifest["data_source_summary"]["uses_wise_fallback"])
            self.assertGreaterEqual(manifest["data_source_summary"]["baseline_days"], 5000.0)
            wise_epochs = [e for e in manifest["epochs"] if e["mission"] == "WISE"]
            self.assertEqual(len(wise_epochs), 1)
            self.assertEqual(wise_epochs[0]["available_detectors"], [4, 5, 6])
            self.assertEqual(len(cache.get_frame(grid_key, "wise_fallback.bin")), 1_572_864)

    def test_query_rejects_empty_archive_response(self) -> None:
        response = SimpleNamespace(
            text="band,mjd_obs,qual_frame,scan_id,frame_num\n", raise_for_status=Mock()
        )
        session = SimpleNamespace(get=Mock(return_value=response))
        with self.assertRaises(WiseFallbackError):
            query_wise_exposures(120.0, 5.0, 5.0, session=session)


if __name__ == "__main__":
    unittest.main()
