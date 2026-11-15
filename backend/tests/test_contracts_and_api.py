"""Unit tests for Phase 0 shared contracts, 3G binary buffers, SQLite cache & backend routes."""

from __future__ import annotations

import copy
import tempfile
import unittest
from pathlib import Path

import jsonschema

from app.main import (
    StarHuntersBackendService,
    build_sky_patch_manifest_payload,
    build_spectrum_payload,
    compute_zenith_icrs,
    generate_synthetic_epoch_frames,
)
from app.models.contracts import (
    BINARY_DETECTOR_FLOAT16_BYTES,
    BINARY_DETECTOR_FLOAT32_BYTES,
    BINARY_FLAGS_UINT8_BYTES,
    SHOWCASE_TARGETS,
    WORLD_CAPITAL_CITIES,
    convert_float16_bytes_to_float32_bytes,
    convert_float32_bytes_to_float16_bytes,
    validate_catalogs_response,
    validate_detector_binary_buffer,
    validate_earth_to_sky_response,
    validate_flags_binary_buffer,
    validate_sky_patch_manifest,
    validate_spectrum_payload,
)
from app.services.spatial_cache import SpatialSqliteCache, compute_grid_key


class TestPhase0ContractsAndBackend(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp_dir.name) / "test_cache.db")
        self.cache = SpatialSqliteCache(db_path=self.db_path, max_cache_bytes=50 * 1024 * 1024)
        self.service = StarHuntersBackendService(cache=self.cache)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_health_endpoint_contract(self) -> None:
        res = self.service.health()
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["service"], "star-hunters-backend")

    def test_quantized_grid_key_sharing(self) -> None:
        # Two queries within 0.02 deg should map to the same 0.05-deg quantized grid key
        key1, _, _ = compute_grid_key(133.7951, -7.2451, 5.0)
        key2, _, _ = compute_grid_key(133.8090, -7.2580, 5.0)
        self.assertEqual(key1, key2)
        self.assertEqual(key1, "ra133.80_dec-7.25_fov5.0")

    def test_all_showcase_manifests_and_known_objects_contract(self) -> None:
        for slug, meta in SHOWCASE_TARGETS.items():
            manifest = build_sky_patch_manifest_payload(
                ra=meta["ra"],
                dec=meta["dec"],
                fov_arcmin=5.0,
                slug=slug,
            )
            parsed = validate_sky_patch_manifest(manifest)
            self.assertEqual(parsed.target_metadata.slug, slug)
            self.assertEqual(parsed.wcs.width, 256)
            self.assertEqual(parsed.wcs.height, 256)

            known = parsed.catalog_overlays.known_objects
            self.assertGreaterEqual(len(known), 2)
            # At least 1 notable mover should be default_checked=True, and background stars False
            checked = [obj for obj in known if obj.default_checked]
            unchecked = [obj for obj in known if not obj.default_checked]
            self.assertGreaterEqual(len(checked), 1)
            self.assertGreaterEqual(len(unchecked), 1)
            for obj in known:
                self.assertEqual(len(obj.epoch_positions), len(parsed.epochs))

    def test_invalid_manifest_rejected(self) -> None:
        manifest = build_sky_patch_manifest_payload(133.7951, -7.2451, 5.0, slug="wise_0855")
        bad = copy.deepcopy(manifest)
        bad["wcs"]["width"] = 128  # Must be 256
        with self.assertRaises(jsonschema.ValidationError):
            validate_sky_patch_manifest(bad)

    def test_catalogs_contract_endpoint(self) -> None:
        catalogs = self.service.get_catalogs(ra=133.7951, dec=-7.2451, fov=5.0)
        validated = validate_catalogs_response(catalogs)
        self.assertEqual(validated.wcs.width, 256)
        self.assertGreater(len(validated.catalog_overlays.known_objects), 0)

    def test_binary_frame_sizes_and_float16_3g_conversion(self) -> None:
        frames = generate_synthetic_epoch_frames("wise_0855")
        p1 = frames["pass_1.bin"]
        f1 = frames["pass_1_flags.bin"]

        count, min_v, max_v = validate_detector_binary_buffer(p1, precision="float32")
        self.assertEqual(len(p1), BINARY_DETECTOR_FLOAT32_BYTES)
        self.assertEqual(count, 6 * 256 * 256)
        self.assertGreater(max_v, min_v)

        f16 = convert_float32_bytes_to_float16_bytes(p1)
        self.assertEqual(len(f16), BINARY_DETECTOR_FLOAT16_BYTES)
        validate_detector_binary_buffer(f16, precision="float16")

        roundtrip_f32 = convert_float16_bytes_to_float32_bytes(f16)
        self.assertEqual(len(roundtrip_f32), BINARY_DETECTOR_FLOAT32_BYTES)

        f_len, nonzero = validate_flags_binary_buffer(f1)
        self.assertEqual(f_len, BINARY_FLAGS_UINT8_BYTES)
        self.assertGreater(nonzero, 0)

    def test_sqlite_spatial_cache_hit_and_lru_pruning(self) -> None:
        # First call: cache miss (cached=False)
        m1 = self.service.get_sky_patch(133.7951, -7.2451, 5.0)
        self.assertFalse(m1["query"]["cached"])

        # Second call within 0.02 deg: cache hit (cached=True)
        m2 = self.service.get_sky_patch(133.8010, -7.2490, 5.0)
        self.assertTrue(m2["query"]["cached"])
        self.assertEqual(m1["query"]["grid_key"], m2["query"]["grid_key"])

        # Frame streaming in float32 and float16 with immutable Cache-Control
        grid_key = m1["query"]["grid_key"]
        body32, headers32 = self.service.get_frame_bytes(
            grid_key, "pass_1.bin", precision="float32"
        )
        self.assertEqual(len(body32), BINARY_DETECTOR_FLOAT32_BYTES)
        self.assertIn("immutable", headers32["Cache-Control"])
        self.assertEqual(headers32["X-Binary-Dtype"], "float32")

        body16, headers16 = self.service.get_frame_bytes(
            grid_key, "pass_1.bin", precision="float16"
        )
        self.assertEqual(len(body16), BINARY_DETECTOR_FLOAT16_BYTES)
        self.assertEqual(headers16["X-Binary-Dtype"], "float16")

    def test_sqlite_lru_eviction_under_small_cap(self) -> None:
        # Measure compressed size of one patch, then cap cache at 1.4x one patch
        tiny_db = str(Path(self.temp_dir.name) / "tiny.db")
        tiny_cache = SpatialSqliteCache(db_path=tiny_db, max_cache_bytes=10_000_000)
        svc = StarHuntersBackendService(cache=tiny_cache)

        m_a = svc.get_sky_patch(10.0, 10.0, 5.0)
        one_patch_bytes = tiny_cache.get_patch_byte_size(m_a["query"]["grid_key"])
        self.assertGreater(one_patch_bytes, 0)
        tiny_cache.max_cache_bytes = int(one_patch_bytes * 1.4)

        m_b = svc.get_sky_patch(50.0, 20.0, 5.0)
        # First patch should have been evicted by LRU pruning
        self.assertIsNone(tiny_cache.get_manifest(m_a["query"]["grid_key"]))
        self.assertIsNotNone(tiny_cache.get_manifest(m_b["query"]["grid_key"]))

    def test_spectrum_102_channels_and_monotonic_order(self) -> None:
        spec = build_spectrum_payload(133.7951, -7.2451, "WISE 0855", slug="wise_0855")
        parsed = validate_spectrum_payload(spec)
        self.assertEqual(len(parsed.channels), 102)
        self.assertEqual(len(parsed.molecular_features), 4)

        # Verify that each showcase target has a distinct 102-band spectral profile
        signatures = set()
        for slug, meta in SHOWCASE_TARGETS.items():
            s = build_spectrum_payload(meta["ra"], meta["dec"], meta["name"], slug=slug)
            validate_spectrum_payload(s)
            flux_tuple = tuple(ch["flux"] for ch in s["channels"][:10])
            signatures.add(flux_tuple)
        self.assertEqual(len(signatures), len(SHOWCASE_TARGETS))

        # Verify SQLite spectrum caching round-trip via backend_service.get_spectrum
        s1 = self.service.get_spectrum(133.7951, -7.2451)
        s2 = self.service.get_spectrum(133.7951, -7.2451)
        self.assertEqual(s1["channels"][0]["flux"], s2["channels"][0]["flux"])

        # Reject non-monotonic channels
        bad_spec = copy.deepcopy(spec)
        bad_spec["channels"][10]["wavelength_um"] = 0.70
        with self.assertRaises(ValueError):
            validate_spectrum_payload(bad_spec)

    def test_earth_to_sky_zenith_bridge_random_capital_fallback_and_sqlite_cache(self) -> None:
        res1 = compute_zenith_icrs(lat=-0.0917, lon=34.7680, iso_time="2026-11-14T16:21:00Z")
        res2 = compute_zenith_icrs(lat=-0.0917, lon=49.7680, iso_time="2026-11-14T16:21:00Z")
        validate_earth_to_sky_response(res1)
        validate_earth_to_sky_response(res2)
        self.assertFalse(res1["earth"]["is_fallback_capital"])
        # +15 deg longitude at same UTC shifts Zenith RA by +15 deg
        dra = (res2["zenith_icrs"]["ra"] - res1["zenith_icrs"]["ra"]) % 360.0
        self.assertAlmostEqual(dra, 15.0, places=2)

        # When user location data is unavailable (lat/lon omitted), pick a random capital city
        # and cache both the Zenith lookup and the overhead sky patch in SQLite.
        fb1 = self.service.get_earth_to_sky(
            lat=None,
            lon=None,
            iso_time="2026-11-14T16:21:00Z",
            fallback_seed=7,
            prewarm_patch=True,
        )
        validate_earth_to_sky_response(fb1)
        self.assertTrue(fb1["earth"]["is_fallback_capital"])
        self.assertFalse(fb1["earth"]["cached"])
        self.assertIsNotNone(fb1["earth"]["city_name"])
        self.assertIsNotNone(fb1["earth"]["country"])
        capital_names = {c["city_name"] for c in WORLD_CAPITAL_CITIES}
        self.assertGreater(len(WORLD_CAPITAL_CITIES), 0)
        self.assertEqual(len({c["slug"] for c in WORLD_CAPITAL_CITIES}), len(WORLD_CAPITAL_CITIES))
        self.assertIn(fb1["earth"]["city_name"], capital_names)

        # Repeat lookup hits SQLite capital_zenith_cache (cached=True)
        fb2 = self.service.get_earth_to_sky(
            lat=None,
            lon=None,
            iso_time="2026-11-14T16:21:00Z",
            fallback_seed=7,
            prewarm_patch=True,
        )
        self.assertTrue(fb2["earth"]["cached"])
        self.assertEqual(fb1["earth"]["city_name"], fb2["earth"]["city_name"])

        # And the overhead sky patch for that capital city was pre-warmed in SQLite
        cap_grid_key, _, _ = compute_grid_key(
            fb1["zenith_icrs"]["ra"], fb1["zenith_icrs"]["dec"], 5.0
        )
        cached_patch = self.cache.get_manifest(cap_grid_key)
        self.assertIsNotNone(cached_patch)
        self.assertTrue(cached_patch["query"]["cached"])

        # Regression test: when fallback_seed is None (default production path),
        # earth coordinates and zenith_icrs coordinates must always match the SAME capital city.
        for i in range(15):
            unseeded_fb = self.service.get_earth_to_sky(
                lat=None,
                lon=None,
                iso_time=f"2026-11-14T16:{i:02d}:00Z",
                fallback_seed=None,
                prewarm_patch=False,
            )
            validate_earth_to_sky_response(unseeded_fb)
            self.assertTrue(unseeded_fb["earth"]["is_fallback_capital"])
            self.assertAlmostEqual(
                unseeded_fb["zenith_icrs"]["dec"],
                unseeded_fb["earth"]["lat"],
                places=4,
            )
            expected_zenith = compute_zenith_icrs(
                lat=unseeded_fb["earth"]["lat"],
                lon=unseeded_fb["earth"]["lon"],
                iso_time=unseeded_fb["earth"]["iso_time"],
            )
            self.assertAlmostEqual(
                unseeded_fb["zenith_icrs"]["ra"],
                expected_zenith["zenith_icrs"]["ra"],
                places=4,
            )
            self.assertEqual(
                unseeded_fb["zenith_icrs"]["constellation"],
                expected_zenith["zenith_icrs"]["constellation"],
            )

        with self.assertRaises(ValueError):
            compute_zenith_icrs(lat=95.0, lon=0.0)
        with self.assertRaises(ValueError):
            compute_zenith_icrs(lat=0.0, lon=195.0)


if __name__ == "__main__":
    unittest.main()
