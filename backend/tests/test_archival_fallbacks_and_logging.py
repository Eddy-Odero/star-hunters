"""Unit tests for SkyView fallback, Saturn ephemeris overlays, single-flight, and logging."""

from __future__ import annotations

import asyncio
import json
import logging
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from astropy.io import fits

from app.models.contracts import (
    BINARY_DETECTOR_FLOAT32_BYTES,
    BINARY_FLAGS_UINT8_BYTES,
    validate_sky_patch_manifest,
)
from app.services.backend_service import StarHuntersBackendService
from app.services.logging_config import (
    ROOT_LOGGER_NAME,
    configure_backend_logging,
    parse_log_level,
)
from app.services.skyview_fallback import (
    SkyViewFallbackError,
    fetch_skyview_fallback,
    inject_solar_system_ephemeris_overlay,
)
from app.services.spatial_cache import SpatialSqliteCache
from app.services.wise_fallback import WiseFallbackError


def _make_skyview_header(ra: float = 8.48, dec: float = 0.78) -> fits.Header:
    hdr = fits.Header()
    hdr["SIMPLE"] = True
    hdr["BITPIX"] = -32
    hdr["NAXIS"] = 2
    hdr["NAXIS1"] = 256
    hdr["NAXIS2"] = 256
    hdr["CTYPE1"] = "RA---TAN"
    hdr["CTYPE2"] = "DEC--TAN"
    hdr["CRVAL1"] = ra
    hdr["CRVAL2"] = dec
    hdr["CRPIX1"] = 128.5
    hdr["CRPIX2"] = 128.5
    hdr["CDELT1"] = -5.0 / (60.0 * 256.0)
    hdr["CDELT2"] = 5.0 / (60.0 * 256.0)
    return hdr


class TestLoggingConfiguration(unittest.TestCase):
    def tearDown(self) -> None:
        configure_backend_logging(level="INFO", log_format="text")

    def test_parse_log_level_valid_and_fallback(self) -> None:
        self.assertEqual(parse_log_level("debug"), (logging.DEBUG, "DEBUG", False))
        self.assertEqual(parse_log_level("WARNING"), (logging.WARNING, "WARNING", False))
        self.assertEqual(parse_log_level("bogus"), (logging.INFO, "INFO", True))

    def test_json_logging_formatter_emits_structured_json(self) -> None:
        logger = configure_backend_logging(level="DEBUG", log_format="json")
        self.assertEqual(logger.name, ROOT_LOGGER_NAME)
        self.assertEqual(logger.level, logging.DEBUG)
        record = logger.makeRecord(
            name=f"{ROOT_LOGGER_NAME}.test",
            level=logging.INFO,
            fn="test.py",
            lno=10,
            msg="Loaded patch %s",
            args=("grid_123",),
            exc_info=None,
        )
        formatted = logger.handlers[0].format(record)
        parsed = json.loads(formatted)
        self.assertEqual(parsed["level"], "INFO")
        self.assertEqual(parsed["message"], "Loaded patch grid_123")
        self.assertEqual(parsed["logger"], f"{ROOT_LOGGER_NAME}.test")


class TestSkyViewFallbackAndOverlays(unittest.TestCase):
    def test_fetch_skyview_fallback_builds_canonical_cubes_and_masks(self) -> None:
        header = _make_skyview_header()

        def fake_downloader(
            ra: float,
            dec: float,
            fov_arcmin: float,
            survey: str,
            session: object = None,
        ) -> tuple[np.ndarray, fits.Header]:
            img = np.full((256, 256), 120.0, dtype=np.float64)
            img[128, 128] = 850.0 if "IR" in survey else 520.0
            img[0, 0] = np.nan
            return img, header

        epochs = fetch_skyview_fallback(
            ra=8.48,
            dec=0.78,
            fov_arcmin=5.0,
            target_wcs_header=header,
            downloader=fake_downloader,
        )
        self.assertEqual(len(epochs), 2)
        for ep in epochs:
            self.assertEqual(ep.detector_data.shape, (6, 256, 256))
            self.assertEqual(len(ep.detector_buffer), BINARY_DETECTOR_FLOAT32_BYTES)
            self.assertEqual(ep.flags_mask.shape, (256, 256))
            self.assertEqual(len(ep.flags_buffer), BINARY_FLAGS_UINT8_BYTES)
            self.assertGreater(float(np.max(ep.detector_data[0])), 0.0)
            self.assertGreater(int(np.count_nonzero(ep.flags_mask)), 0)

    def test_fetch_skyview_fallback_retries_legacy_dss_when_dss2_fails(self) -> None:
        calls: list[str] = []
        header = _make_skyview_header()

        def downloader_only_legacy(
            ra: float,
            dec: float,
            fov_arcmin: float,
            survey: str,
            session: object = None,
        ) -> tuple[np.ndarray, fits.Header]:
            calls.append(survey)
            if survey != "DSS":
                raise SkyViewFallbackError("DSS2 unavailable")
            return np.full((256, 256), 250.0, dtype=np.float64), header

        epochs = fetch_skyview_fallback(
            ra=8.48,
            dec=0.78,
            fov_arcmin=5.0,
            downloader=downloader_only_legacy,
        )
        self.assertEqual([ep.survey for ep in epochs], ["DSS"])
        self.assertIn("DSS", calls)

    def test_inject_solar_system_ephemeris_overlay_renders_saturn_rings(self) -> None:
        cube = np.full((6, 256, 256), 0.1, dtype="<f4")
        updated = inject_solar_system_ephemeris_overlay(
            cube,
            x_px=128.0,
            y_px=128.0,
            body_name="Saturn (JPL 699)",
            body_class="planet",
            available_detectors=[1, 2],
        )
        self.assertGreater(float(updated[0, 128, 128]), 2.0)
        # Extended ring emission should brighten pixels several pixels radially away from core.
        self.assertGreater(float(updated[0, 128, 134]), float(cube[0, 128, 134]))


class TestArchivalChainSingleFlightAndHorizons(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp_dir.name) / "test_archival.db")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    async def test_get_sky_patch_async_falls_back_to_skyview_when_spherex_and_wise_empty(
        self,
    ) -> None:
        header = _make_skyview_header(ra=8.483, dec=0.785)
        sv_epochs = fetch_skyview_fallback(
            ra=8.483,
            dec=0.785,
            fov_arcmin=5.0,
            target_wcs_header=header,
            downloader=lambda *_a, **_kw: (
                np.full((256, 256), 300.0, dtype=np.float64),
                header,
            ),
        )

        def fail_wise(**_kwargs: object) -> None:
            raise WiseFallbackError("No WISE coverage")

        cache = SpatialSqliteCache(self.db_path)
        self.addCleanup(cache.close)
        svc = StarHuntersBackendService(
            cache=cache,
            enable_archival_data=True,
            spherex_cutout_fetcher=lambda **_kw: [],
            wise_fallback_fetcher=fail_wise,
            skyview_fallback_fetcher=lambda **_kw: sv_epochs,
        )

        async def _empty_pipeline(**_kwargs: object) -> dict[str, object]:
            return {
                "simbad": [],
                "gaia_proper_motion": [],
                "solar_system_most": [],
                "known_objects": [],
            }

        with patch.object(
            svc.catalog_pipeline, "resolve_patch_objects", side_effect=_empty_pipeline
        ):
            manifest = await svc.get_sky_patch_async(
                ra=8.483, dec=0.785, fov=5.0, live_catalogs=False
            )

        validate_sky_patch_manifest(manifest)
        summary = manifest["data_source_summary"]
        self.assertEqual(summary["primary_mission"], "SkyView")
        self.assertEqual(summary["provenance_tier"], "extension")
        self.assertEqual(len(manifest["epochs"]), 2)
        grid_key = manifest["query"]["grid_key"]
        raw_bytes, _hdr = svc.get_frame_bytes(grid_key=grid_key, filename="dss2_red.bin")
        self.assertEqual(len(raw_bytes), BINARY_DETECTOR_FLOAT32_BYTES)

    async def test_get_sky_patch_async_uses_labeled_simulated_when_all_archives_fail(
        self,
    ) -> None:
        cache = SpatialSqliteCache(self.db_path)
        self.addCleanup(cache.close)
        svc = StarHuntersBackendService(
            cache=cache,
            enable_archival_data=True,
            spherex_cutout_fetcher=lambda **_kw: [],
            wise_fallback_fetcher=lambda **_kw: (_ for _ in ()).throw(WiseFallbackError("down")),
            skyview_fallback_fetcher=lambda **_kw: (_ for _ in ()).throw(
                SkyViewFallbackError("down")
            ),
        )

        async def _empty_pipeline(**_kwargs: object) -> dict[str, object]:
            return {
                "simbad": [],
                "gaia_proper_motion": [],
                "solar_system_most": [],
                "known_objects": [],
            }

        with patch.object(
            svc.catalog_pipeline, "resolve_patch_objects", side_effect=_empty_pipeline
        ):
            manifest = await svc.get_sky_patch_async(
                ra=150.25, dec=2.15, fov=5.0, live_catalogs=False
            )

        validate_sky_patch_manifest(manifest)
        self.assertEqual(manifest["data_source_summary"]["primary_mission"], "Simulated")
        self.assertEqual(manifest["data_source_summary"]["provenance_tier"], "simulated")

    async def test_concurrent_catalogs_and_patch_coalesce_via_singleflight(self) -> None:
        cache = SpatialSqliteCache(self.db_path)
        self.addCleanup(cache.close)
        svc = StarHuntersBackendService(cache=cache, enable_archival_data=False)
        calls = 0

        async def slow_pipeline(**_kwargs: object) -> dict[str, object]:
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.05)
            return {
                "simbad": [],
                "gaia_proper_motion": [],
                "solar_system_most": [],
                "known_objects": [],
            }

        with patch.object(svc.catalog_pipeline, "resolve_patch_objects", side_effect=slow_pipeline):
            cat_res, patch_res = await asyncio.gather(
                svc.get_catalogs_async(ra=42.15, dec=-12.35, fov=5.0, live_catalogs=True),
                svc.get_sky_patch_async(ra=42.15, dec=-12.35, fov=5.0, live_catalogs=True),
            )

        self.assertEqual(calls, 1)
        self.assertIn("catalog_overlays", cat_res)
        self.assertIn("epochs", patch_res)

    async def test_search_known_objects_async_refreshes_saturn_live_ephemeris(self) -> None:
        cache = SpatialSqliteCache(self.db_path)
        self.addCleanup(cache.close)
        svc = StarHuntersBackendService(cache=cache, enable_archival_data=True)

        async def fake_horizons(spec: dict[str, str]) -> dict[str, object] | None:
            if spec.get("naif_id") == "699":
                return {
                    "ra": 8.48315,
                    "dec": 0.7848,
                    "vmag": 0.54,
                    "mjd": 61360.0,
                }
            return None

        with patch.object(
            svc.catalog_pipeline, "resolve_live_horizons_for_body", side_effect=fake_horizons
        ):
            results = await svc.search_known_objects_async(query="Saturn", limit=10)

        saturn = next(item for item in results if item["object_id"] == "horizons:699")
        self.assertAlmostEqual(float(saturn["ra"]), 8.48315, places=4)
        self.assertAlmostEqual(float(saturn["dec"]), 0.7848, places=4)
        self.assertEqual(saturn["data_source"], "jpl_horizons_live")

    async def test_fast_spherex_hit_coadds_only_once_and_skips_fallbacks(self) -> None:
        from app.services.spherex_coadd import SpherexCoaddResult, SpherexEpochCoadd

        cache = SpatialSqliteCache(self.db_path)
        self.addCleanup(cache.close)
        wise_calls = 0
        skyview_calls = 0

        def fail_wise(**_kwargs: object) -> None:
            nonlocal wise_calls
            wise_calls += 1
            raise WiseFallbackError("should not be called")

        def fail_skyview(**_kwargs: object) -> None:
            nonlocal skyview_calls
            skyview_calls += 1
            raise SkyViewFallbackError("should not be called")

        coadd_calls = 0

        def counting_coadder(*_args: object, **_kwargs: object) -> SpherexCoaddResult:
            nonlocal coadd_calls
            coadd_calls += 1
            return coadd_result

        svc = StarHuntersBackendService(
            cache=cache,
            enable_archival_data=True,
            spherex_cutout_fetcher=lambda **_kw: ["dummy"],
            spherex_coadder=counting_coadder,
            wise_fallback_fetcher=fail_wise,
            skyview_fallback_fetcher=fail_skyview,
        )

        det_buf = np.zeros((6, 256, 256), dtype="<f4").tobytes()
        flag_buf = np.zeros((256, 256), dtype=np.uint8).tobytes()
        coadd_result = SpherexCoaddResult(
            epochs=[
                SpherexEpochCoadd(
                    epoch_id="pass_1",
                    mjd=60800.0,
                    mjd_start=60800.0,
                    mjd_end=60800.0,
                    detector_data=np.zeros((6, 256, 256), dtype="<f4"),
                    flags_mask=np.zeros((256, 256), dtype=np.uint8),
                    detector_buffer=det_buf,
                    flags_buffer=flag_buf,
                    wcs_header={},
                    available_detectors=[1, 2],
                    exposure_count=1,
                ),
                SpherexEpochCoadd(
                    epoch_id="pass_2",
                    mjd=60980.0,
                    mjd_start=60980.0,
                    mjd_end=60980.0,
                    detector_data=np.zeros((6, 256, 256), dtype="<f4"),
                    flags_mask=np.zeros((256, 256), dtype=np.uint8),
                    detector_buffer=det_buf,
                    flags_buffer=flag_buf,
                    wcs_header={},
                    available_detectors=[1, 2],
                    exposure_count=1,
                ),
            ],
            has_multi_epoch_spherex=True,
            needs_wise_fallback=False,
            baseline_days=180.0,
        )

        async def _empty_pipeline(**_kwargs: object) -> dict[str, object]:
            return {
                "simbad": [],
                "gaia_proper_motion": [],
                "solar_system_most": [],
                "known_objects": [],
            }

        with patch.object(
            svc.catalog_pipeline, "resolve_patch_objects", side_effect=_empty_pipeline
        ):
            manifest = await svc.get_sky_patch_async(
                ra=133.7951, dec=-7.2451, fov=5.0, live_catalogs=False
            )

        validate_sky_patch_manifest(manifest)
        self.assertEqual(coadd_calls, 1)
        self.assertEqual(wise_calls, 0)
        self.assertEqual(skyview_calls, 0)
        self.assertEqual(manifest["data_source_summary"]["primary_mission"], "SPHEREx")
        self.assertTrue(manifest["data_source_summary"]["has_multi_epoch_spherex"])
