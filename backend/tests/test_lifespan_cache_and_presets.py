"""Tests for Phase 3/4 lifespan pooling, SQLite deduplication, preset_builder, and contracts."""

from __future__ import annotations

import asyncio
import copy
import importlib.util
import json
import re
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

from app.main import create_app
from app.models.contracts import (
    SHOWCASE_TARGETS,
    TRACKING_SQUARE_COLORS,
    validate_catalogs_response,
    validate_sky_patch_manifest,
)
from app.services import synthetic_patch
from app.services.backend_service import StarHuntersBackendService
from app.services.catalog_clients import HORIZONS_FEATURED_BODIES
from app.services.celestial_catalog_pipeline import AutomatedCelestialPipeline
from app.services.preset_builder import (
    PresetBundle,
    build_live_preset_bundle,
    build_synthetic_preset_bundle,
    generate_all_synthetic_presets,
    prewarm_cache_with_service,
    seed_ephemeris_for_bodies,
    seed_most_intersections,
    seed_showcase_regions,
    validate_preset_bundle,
    validate_written_presets,
    write_preset_bundle,
    write_summary_json,
)
from app.services.spatial_cache import SpatialSqliteCache, compute_grid_key
from app.services.synthetic_patch import (
    build_sky_patch_manifest_payload,
    generate_synthetic_epoch_frames,
)


class LifespanCacheAndPresetsTests(unittest.TestCase):
    """Verify ASGI HTTP pooling, SQLite JSON deduplication, preset_builder, and contract parity."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmpdir.name)
        self.db_path = str(self.tmp_path / "phase34_test.db")
        self.cache = SpatialSqliteCache(db_path=self.db_path, max_cache_bytes=64 * 1024 * 1024)

    def tearDown(self) -> None:
        self.cache.close()
        self._tmpdir.cleanup()

    def test_fastapi_lifespan_manages_pooled_http_client_and_closes_cache(self) -> None:
        service = StarHuntersBackendService(cache=self.cache)
        self.assertIsNone(service.catalog_pipeline.http_client)

        managed_client: httpx.AsyncClient | None = None
        with TestClient(create_app(service)) as client:
            resp = client.get("/health")
            self.assertEqual(resp.status_code, 200)
            managed_client = service.catalog_pipeline.http_client
            self.assertIsInstance(managed_client, httpx.AsyncClient)
            assert managed_client is not None
            self.assertFalse(managed_client.is_closed)

        self.assertIsNotNone(managed_client)
        assert managed_client is not None
        self.assertTrue(managed_client.is_closed)
        self.assertIsNone(service.catalog_pipeline.http_client)
        self.assertEqual(self.cache._connections, [])

    def test_fastapi_lifespan_preserves_injected_http_client(self) -> None:
        async def _run() -> None:
            transport = httpx.MockTransport(lambda _r: httpx.Response(200))
            injected = httpx.AsyncClient(transport=transport)
            pipeline = AutomatedCelestialPipeline(cache=self.cache, http_client=injected)
            service = StarHuntersBackendService(cache=self.cache, catalog_pipeline=pipeline)
            app = create_app(service)
            async with app.router.lifespan_context(app):
                self.assertIs(service.catalog_pipeline.http_client, injected)
                self.assertFalse(injected.is_closed)
            self.assertIs(service.catalog_pipeline.http_client, injected)
            self.assertFalse(injected.is_closed)
            await injected.aclose()

        asyncio.run(_run())

    def test_pipeline_creates_and_closes_transient_client_outside_lifespan(self) -> None:
        pipeline = AutomatedCelestialPipeline(cache=self.cache, http_client=None)
        observed_clients: list[httpx.AsyncClient] = []

        async def _fake_simbad(
            *,
            ra_deg: float,
            dec_deg: float,
            radius_deg: float,
            client: httpx.AsyncClient | None = None,
            parallel_mirrors: bool = False,
        ) -> tuple[list[dict[str, object]], str]:
            assert client is not None
            observed_clients.append(client)
            self.assertFalse(client.is_closed)
            return [], "simbad_mock"

        async def _fake_gaia(
            *,
            ra_deg: float,
            dec_deg: float,
            radius_deg: float,
            client: httpx.AsyncClient | None = None,
            parallel_mirrors: bool = False,
        ) -> tuple[list[dict[str, object]], str]:
            assert client is not None
            observed_clients.append(client)
            self.assertFalse(client.is_closed)
            return [], "gaia_mock"

        wcs = {
            "width": 256,
            "height": 256,
            "crval": [133.8, -7.25],
            "crpix": [128.0, 128.0],
            "cdelt": [-0.0003255, 0.0003255],
        }
        epochs = [{"epoch_id": "pass_1", "mjd": 60810.5}]

        with (
            patch(
                "app.services.celestial_catalog_pipeline.fetch_simbad_objects",
                side_effect=_fake_simbad,
            ),
            patch(
                "app.services.celestial_catalog_pipeline.fetch_gaia_dr3_objects",
                side_effect=_fake_gaia,
            ),
        ):
            asyncio.run(pipeline.resolve_patch_objects(133.8, -7.25, 5.0, wcs, epochs))

        self.assertEqual(len(observed_clients), 2)
        self.assertIs(observed_clients[0], observed_clients[1])
        self.assertTrue(observed_clients[0].is_closed)
        self.assertIsNone(pipeline.http_client)

    def test_sqlite_manifest_and_catalogs_deduplicated_round_trip(self) -> None:
        meta = SHOWCASE_TARGETS["wise_0855"]
        manifest = build_sky_patch_manifest_payload(
            ra=meta["ra"],
            dec=meta["dec"],
            fov_arcmin=5.0,
            slug="wise_0855",
        )
        original_overlays = copy.deepcopy(manifest["catalog_overlays"])
        frames = generate_synthetic_epoch_frames(slug="wise_0855", manifest=manifest)
        grid_key, ra_q, dec_q = compute_grid_key(meta["ra"], meta["dec"], 5.0)

        self.cache.put_sky_patch(
            grid_key=grid_key,
            ra_center=ra_q,
            dec_center=dec_q,
            fov_arcmin=5.0,
            manifest=manifest,
            frames=frames,
        )
        # Caller manifest must not be mutated
        self.assertIn("catalog_overlays", manifest)

        with self.cache.connection() as conn:
            row = conn.execute(
                "SELECT manifest_json, catalogs_json FROM sky_patches WHERE grid_key = ?",
                (grid_key,),
            ).fetchone()
        self.assertIsNotNone(row)
        stored_manifest = json.loads(row["manifest_json"])
        stored_catalogs = json.loads(row["catalogs_json"])
        self.assertNotIn("catalog_overlays", stored_manifest)
        self.assertIn("catalog_overlays", stored_catalogs)

        hydrated_manifest = self.cache.get_manifest(grid_key)
        self.assertIsNotNone(hydrated_manifest)
        assert hydrated_manifest is not None
        self.assertTrue(hydrated_manifest["query"]["cached"])
        self.assertEqual(hydrated_manifest["catalog_overlays"], original_overlays)
        validate_sky_patch_manifest(hydrated_manifest)

        cached_catalogs = self.cache.get_catalogs(grid_key)
        self.assertIsNotNone(cached_catalogs)
        assert cached_catalogs is not None
        self.assertTrue(cached_catalogs["query"]["cached"])
        self.assertEqual(cached_catalogs["catalog_overlays"], original_overlays)
        validate_catalogs_response(cached_catalogs)

        # Legacy rows that still store catalog_overlays inside manifest_json also hydrate cleanly
        legacy_grid_key = "ra10.00_dec10.00_fov5.0"
        with self.cache.connection() as conn:
            conn.execute(
                """
                INSERT INTO sky_patches (
                    grid_key, ra_center, dec_center, fov_arcmin,
                    manifest_json, catalogs_json, byte_size, created_at, last_accessed
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    legacy_grid_key,
                    10.0,
                    10.0,
                    5.0,
                    json.dumps(manifest),
                    json.dumps(stored_catalogs),
                    1024,
                    0.0,
                    0.0,
                ),
            )
        legacy_manifest = self.cache.get_manifest(legacy_grid_key)
        self.assertIsNotNone(legacy_manifest)
        assert legacy_manifest is not None
        self.assertEqual(legacy_manifest["catalog_overlays"], original_overlays)

    def test_synthetic_frame_lru_cache_is_bounded_during_prewarm(self) -> None:
        synthetic_patch._FRAME_LRU_CACHE.clear()
        service = StarHuntersBackendService(cache=self.cache)
        count = service.prewarm_known_data()
        self.assertEqual(count, len(SHOWCASE_TARGETS))
        self.assertLessEqual(
            len(synthetic_patch._FRAME_LRU_CACHE),
            synthetic_patch._MAX_CACHED_FRAME_SETS,
        )

        # Behavior of get_sky_patch and get_frame_bytes remains intact for every target
        for slug, meta in SHOWCASE_TARGETS.items():
            manifest = service.get_sky_patch(meta["ra"], meta["dec"], 5.0)
            self.assertEqual(manifest["target_metadata"]["slug"], slug)
            body, headers = service.get_frame_bytes(
                manifest["query"]["grid_key"],
                "pass_1.bin",
                precision="float32",
            )
            self.assertEqual(headers["X-Binary-Dtype"], "float32")
            self.assertGreater(len(body), 0)

    def test_preset_builder_generates_validates_and_cleans_bundles(self) -> None:
        presets_dir = self.tmp_path / "presets"
        stale_file = presets_dir / "wise_0855" / "wise_fallback.bin"
        stale_file.parent.mkdir(parents=True, exist_ok=True)
        stale_file.write_bytes(b"stale")

        generated = generate_all_synthetic_presets(output_root=presets_dir)
        self.assertEqual(set(generated), set(SHOWCASE_TARGETS))
        self.assertFalse(stale_file.exists())
        self.assertEqual(validate_written_presets(presets_dir, generated), generated)

        index_path = presets_dir / "global_known_objects.json"
        self.assertTrue(index_path.is_file())
        global_index = json.loads(index_path.read_text(encoding="utf-8"))
        object_ids = [entry["object_id"] for entry in global_index if entry.get("object_id")]
        self.assertGreater(len(object_ids), len(SHOWCASE_TARGETS))
        self.assertEqual(len(object_ids), len(set(object_ids)))

        # Validation error paths
        bad_bundle = build_synthetic_preset_bundle("wise_0855")
        bad_frames = copy.deepcopy(bad_bundle)
        bad_frames.frames["pass_1.bin"] = b"too_short"
        with self.assertRaises(ValueError):
            validate_preset_bundle(bad_frames)

        missing_frame = build_synthetic_preset_bundle("wise_0855")
        del missing_frame.frames["pass_2_flags.bin"]
        with self.assertRaises(ValueError):
            validate_preset_bundle(missing_frame)

        few_epochs = build_synthetic_preset_bundle("wise_0855")
        few_epochs.manifest["epochs"] = few_epochs.manifest["epochs"][:1]
        with self.assertRaises(ValueError):
            validate_preset_bundle(few_epochs)

        # Live bundle assembly & persistence
        live_bundle: PresetBundle = build_live_preset_bundle(
            slug="wise_0855",
            meta=SHOWCASE_TARGETS["wise_0855"],
            frames=bad_bundle.frames,
            epochs=bad_bundle.manifest["epochs"],
            summary={
                "primary_mission": "SPHEREx",
                "has_multi_epoch_spherex": True,
                "uses_wise_fallback": False,
                "baseline_days": 182.7,
                "status_note": "2 real SPHEREx comparison epoch(s)",
            },
        )
        validate_preset_bundle(live_bundle)
        write_preset_bundle(live_bundle, self.tmp_path / "live_presets")
        self.assertEqual(
            validate_written_presets(self.tmp_path / "live_presets", ["wise_0855"]),
            ["wise_0855"],
        )

    def test_preset_builder_seeding_and_summary_helpers(self) -> None:
        horizons_result = (
            "Date__(UT)__HR:MN, , ,R.A._(ICRF), DEC_(ICRF), APmag, S-brt,\n"
            "$$SOE\n"
            " 2025-May-01 00:00, , , 192.45000, +7.82000, 7.50, n.a.,\n"
            "$$EOE\n"
        )
        most_brief = (
            "|  ra_obj| dec_obj| vmag|         start_date|           end_date|"
            "  mjd_start|    mjd_end|                                 uri|\n"
            "|  double|  double|double|               char|               char|"
            "     double|     double|                                char|\n"
            "  192.45000  7.82000  7.50  2025-05-01T00:00:00  2025-05-01T00:05:00"
            "  60796.0  60796.003  test_most.fits\n"
        )

        def _handler(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            if "horizons.api" in url:
                return httpx.Response(200, json={"result": horizons_result})
            if "MOST" in url:
                return httpx.Response(200, text=most_brief)
            return httpx.Response(404)

        async def _run() -> tuple[
            dict[str, dict[str, object]],
            dict[str, dict[str, object]],
            dict[str, dict[str, object]],
        ]:
            async with httpx.AsyncClient(transport=httpx.MockTransport(_handler)) as client:
                ephem = await seed_ephemeris_for_bodies(
                    self.cache,
                    [HORIZONS_FEATURED_BODIES[-2]],
                    start_date="2025-05-01",
                    stop_date="2025-05-02",
                    step_size="1d",
                    client=client,
                )
                pipeline = AutomatedCelestialPipeline(cache=self.cache, http_client=client)
                regions = await seed_showcase_regions(
                    pipeline,
                    targets={"wise_0855": SHOWCASE_TARGETS["wise_0855"]},
                    allow_live=False,
                )
                most = await seed_most_intersections(
                    self.cache,
                    ["20000001:NID"],
                    client=client,
                )
            return ephem, regions, most

        ephem_summary, regions_summary, most_summary = asyncio.run(_run())
        self.assertEqual(ephem_summary[HORIZONS_FEATURED_BODIES[-2]["name"]]["rows"], 1)
        self.assertIn("wise_0855", regions_summary)
        self.assertEqual(most_summary["20000001:NID"]["matches"], 1)

        prewarm_info = prewarm_cache_with_service(self.cache)
        self.assertEqual(prewarm_info["prewarmed_patches"], len(SHOWCASE_TARGETS))

        summary_path = self.tmp_path / "nested" / "summary.json"
        write_summary_json(summary_path, {"ephemeris": ephem_summary, **prewarm_info})
        loaded = json.loads(summary_path.read_text(encoding="utf-8"))
        self.assertEqual(loaded["prewarmed_patches"], len(SHOWCASE_TARGETS))

    def test_tracking_square_colors_match_frontend_contracts(self) -> None:
        repo_root = Path(__file__).resolve().parent.parent.parent
        ts_contracts_path = repo_root / "frontend" / "src" / "types" / "contracts.ts"
        ts_text = ts_contracts_path.read_text(encoding="utf-8")
        match = re.search(
            r"export const TRACKING_SQUARE_COLORS\s*:[^=]*=\s*\[(.*?)\]\s*as const;",
            ts_text,
            re.DOTALL,
        )
        self.assertIsNotNone(match, "Could not locate TRACKING_SQUARE_COLORS in contracts.ts")
        assert match is not None
        ts_colors = re.findall(r"'#[0-9A-Fa-f]{6}'", match.group(1))
        ts_palette = [color.strip("'") for color in ts_colors]
        self.assertEqual(ts_palette, list(TRACKING_SQUARE_COLORS))

    def test_lifespan_closes_cache_if_aclose_raises_and_forwards_client_to_most(self) -> None:
        service = StarHuntersBackendService(cache=self.cache)
        observed_clients: list[httpx.AsyncClient | None] = []

        async def _fake_most(
            *,
            obj_name: str,
            client: httpx.AsyncClient | None = None,
        ) -> dict[str, object]:
            observed_clients.append(client)
            return {"query_name": obj_name, "status": "no_match", "matches": []}

        with (
            patch(
                "app.services.backend_service.fetch_most_spherex_matches",
                side_effect=_fake_most,
            ),
            TestClient(create_app(service)) as client,
        ):
            resp = client.get("/api/v1/solar-system/most", params={"obj_name": "Ceres"})
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(len(observed_clients), 1)
            self.assertIs(observed_clients[0], service.catalog_pipeline.http_client)

        async def _run_failing_aclose() -> None:
            svc = StarHuntersBackendService(cache=self.cache)
            app = create_app(svc)
            with self.assertRaises(RuntimeError):
                async with app.router.lifespan_context(app):
                    managed = svc.catalog_pipeline.http_client
                    assert managed is not None
                    managed.aclose = AsyncMock(side_effect=RuntimeError("close boom"))  # type: ignore[method-assign]
            self.assertEqual(self.cache._connections, [])

        asyncio.run(_run_failing_aclose())

    def test_synthetic_frame_lru_cache_is_thread_safe(self) -> None:
        synthetic_patch._FRAME_LRU_CACHE.clear()
        slugs = list(SHOWCASE_TARGETS)[:6]

        def _worker(target_slug: str) -> tuple[str, int]:
            frames = generate_synthetic_epoch_frames(slug=target_slug)
            return target_slug, len(frames["pass_1.bin"])

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(_worker, slugs * 2))

        self.assertEqual(len(results), len(slugs) * 2)
        for _slug, size in results:
            self.assertGreater(size, 0)
        self.assertLessEqual(
            len(synthetic_patch._FRAME_LRU_CACHE),
            synthetic_patch._MAX_CACHED_FRAME_SETS,
        )

    def test_scripts_generate_and_build_presets_subset_preserves_global_index(self) -> None:
        repo_root = Path(__file__).resolve().parent.parent.parent
        gen_spec = importlib.util.spec_from_file_location(
            "gen_presets_script",
            repo_root / "scripts" / "generate_synthetic_presets.py",
        )
        assert gen_spec is not None and gen_spec.loader is not None
        gen_mod = importlib.util.module_from_spec(gen_spec)
        gen_spec.loader.exec_module(gen_mod)

        fake_root = self.tmp_path / "script_repo"
        with patch.object(gen_mod, "REPO_ROOT", fake_root):
            self.assertEqual(gen_mod.main(), 0)
        self.assertTrue(
            (fake_root / "frontend" / "public" / "presets" / "global_known_objects.json").is_file()
        )

        build_spec = importlib.util.spec_from_file_location(
            "build_presets_script",
            repo_root / "scripts" / "build_presets.py",
        )
        assert build_spec is not None and build_spec.loader is not None
        build_mod = importlib.util.module_from_spec(build_spec)
        build_spec.loader.exec_module(build_mod)

        live_out = self.tmp_path / "live_subset_presets"
        sample_bundle = build_synthetic_preset_bundle("wise_0855")
        sample_frames = sample_bundle.frames
        sample_epochs = sample_bundle.manifest["epochs"]
        sample_summary = sample_bundle.manifest["data_source_summary"]

        with (
            patch.object(build_mod, "_probe_irsa", return_value=True),
            patch.object(
                build_mod,
                "_resolve_live_frames",
                return_value=(sample_frames, sample_epochs, sample_summary, sample_bundle.spectrum),
            ),
            patch.object(
                build_mod,
                "_fetch_live_catalog_overlays",
                new=AsyncMock(return_value={"known_objects": [], "gaia_dr3": []}),
            ),
        ):
            built = build_mod.build_presets(
                output_dir=live_out,
                fallback_synthetic=False,
                targets=["wise_0855"],
                live_catalogs=True,
            )

        self.assertEqual(built, ["wise_0855"])
        global_index = json.loads(
            (live_out / "global_known_objects.json").read_text(encoding="utf-8")
        )
        indexed_slugs = {
            entry.get("target_slug") for entry in global_index if entry.get("target_slug")
        }
        self.assertTrue(set(SHOWCASE_TARGETS).issubset(indexed_slugs))


if __name__ == "__main__":
    unittest.main()
