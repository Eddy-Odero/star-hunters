"""Tests for automated celestial caching, SIMBAD/Gaia/Horizons/MOST pipeline & SQLite lookups."""

from __future__ import annotations

import asyncio
import math
import os
import sys
import tempfile
import unittest

import httpx

BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.main import HAS_FASTAPI, StarHuntersBackendService, backend_service  # noqa: E402
from app.models.contracts import (  # noqa: E402
    validate_catalogs_response,
    validate_sky_patch_manifest,
)
from app.services.celestial_catalog_pipeline import (  # noqa: E402
    GAIA_DR3_TAP_ENDPOINTS,
    IRSA_MOST_ENDPOINT,
    JPL_HORIZONS_ENDPOINT,
    SIMBAD_TAP_ENDPOINTS,
    VIZIER_GAIA_CFA_ENDPOINT,
    AutomatedCelestialPipeline,
    fetch_gaia_dr3_objects,
    fetch_horizons_ephemeris,
    fetch_most_spherex_matches,
    fetch_simbad_objects,
    map_simbad_otype,
    parse_horizons_ephemeris_result,
    parse_ipac_brief_table,
    propagate_gaia_epoch,
)
from app.services.spatial_cache import SpatialSqliteCache, mjd_to_date_bucket  # noqa: E402

SAMPLE_MOST_BRIEF = (
    "\\catalog = spherex\n"
    "\\date = 2026-11-15\n"
    "|  ra_obj| dec_obj| vmag|         start_date|           end_date|"
    "  mjd_start|    mjd_end|                                 uri|\n"
    "|  double|  double|double|               char|               char|"
    "     double|     double|                                char|\n"
    "  135.12345  -12.54321  14.82  2025-07-04T11:22:33  2025-07-04T11:26:00"
    "  60860.47399  60860.47639  level2_2025W27_test_exposure.fits\n"
)

SAMPLE_HORIZONS_PLANET_RESULT = """
Date__(UT)__HR:MN, , ,R.A._(ICRF), DEC_(ICRF), APmag, S-brt,
$$SOE
 2025-May-01 00:00, , , 359.90000, +15.00000, -1.90, n.a.,
 2025-May-02 00:00, , , 0.10000, +15.20000, -1.92, n.a.,
$$EOE
"""

SAMPLE_HORIZONS_COMET_RESULT = """
Date__(UT)__HR:MN, , ,R.A._(ICRF), DEC_(ICRF), T-mag, N-mag,
$$SOE
 2025-Nov-10 00:00, , , 198.25000, -5.10000, 11.40, 15.20,
 2025-Nov-11 00:00, , , 198.27000, -5.08500, 11.35, 15.15,
$$EOE
"""


class CelestialPipelineTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self._tmpdir.name, "pipeline_test.db")
        self.cache = SpatialSqliteCache(db_path=self.db_path, max_cache_bytes=10 * 1024 * 1024)

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    def test_no_cds_unistra_endpoints_configured(self) -> None:
        all_urls = [
            *SIMBAD_TAP_ENDPOINTS,
            *GAIA_DR3_TAP_ENDPOINTS,
            VIZIER_GAIA_CFA_ENDPOINT,
            JPL_HORIZONS_ENDPOINT,
            IRSA_MOST_ENDPOINT,
        ]
        for url in all_urls:
            self.assertNotIn("cds.unistra.fr", url.lower())
        self.assertEqual(SIMBAD_TAP_ENDPOINTS[0], "https://simbad.idia.ac.za/simbad/sim-tap/sync")
        self.assertEqual(
            SIMBAD_TAP_ENDPOINTS[1], "https://simbad.cfa.harvard.edu/simbad/sim-tap/sync"
        )
        self.assertEqual(GAIA_DR3_TAP_ENDPOINTS[0], "https://gea.esac.esa.int/tap-server/tap/sync")

    def test_propagate_gaia_epoch_math_accounts_for_cos_dec(self) -> None:
        # Dec=60 deg (cos=0.5): +1000 mas/yr * 10 yr -> +20" RA, -10" Dec.
        mjd_j2026 = 57388.0 + 3652.5  # J2026.0 (+10 Julian years from J2016.0)
        ra_out, dec_out = propagate_gaia_epoch(
            ra_deg=180.0,
            dec_deg=60.0,
            pmra_mas_yr=1000.0,
            pmdec_mas_yr=-500.0,
            target_mjd=mjd_j2026,
        )
        expected_ra = 180.0 + (1000.0 * 10.0) / (3600000.0 * math.cos(math.radians(60.0)))
        expected_dec = 60.0 - (500.0 * 10.0) / 3600000.0
        self.assertAlmostEqual(ra_out, expected_ra, places=5)
        self.assertAlmostEqual(dec_out, expected_dec, places=5)

    def test_simbad_fallback_from_idia_to_cfa_and_otype_mapping(self) -> None:
        self.assertEqual(map_simbad_otype("BD*"), ("brown_dwarf", "brown_dwarf_candidate"))
        self.assertEqual(map_simbad_otype("G"), ("galaxy", "infrared_source"))
        self.assertEqual(map_simbad_otype("PN"), ("nebula", "infrared_source"))
        self.assertEqual(map_simbad_otype("V*"), ("variable_star", "variable_star"))
        self.assertEqual(map_simbad_otype("*", 0.3), ("star", "high_pm_star"))

        called_hosts: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            called_hosts.append(request.url.host)
            if "idia.ac.za" in request.url.host:
                return httpx.Response(503, json={"error": "mirror busy"})
            return httpx.Response(
                200,
                json={
                    "metadata": [
                        {"name": "main_id"},
                        {"name": "otype"},
                        {"name": "ra"},
                        {"name": "dec"},
                        {"name": "pmra"},
                        {"name": "pmdec"},
                    ],
                    "data": [
                        ["WISE J085510.83-071442.5", "BD*", 133.786, -7.244, -8118.0, 680.0],
                        ["2MASS J0855-0715", "G", 133.801, -7.251, None, None],
                    ],
                },
            )

        async def _run() -> tuple[list[dict[str, object]], str]:
            transport = httpx.MockTransport(handler)
            async with httpx.AsyncClient(transport=transport) as client:
                return await fetch_simbad_objects(133.78, -7.24, 0.08, client=client)

        rows, provider = asyncio.run(_run())
        self.assertEqual(called_hosts, ["simbad.idia.ac.za", "simbad.cfa.harvard.edu"])
        self.assertEqual(provider, "simbad_cfa")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["otype"], "BD*")

    def test_gaia_dr3_handles_esa_and_ari_dict_formats_and_vizier_fallback(self) -> None:
        # Case 1: ESA times out -> ARI Heidelberg returns list-of-dicts format
        def handler_ari(request: httpx.Request) -> httpx.Response:
            if "esac.esa.int" in request.url.host:
                raise httpx.ConnectTimeout("ESA timeout")
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "source_id": 5761985432616501376,
                            "ra": 133.79,
                            "dec": -7.23,
                            "pmra": -12.4,
                            "pmdec": 8.1,
                            "parallax": 3.2,
                            "phot_g_mean_mag": 14.5,
                        }
                    ]
                },
            )

        async def _run_ari() -> tuple[list[dict[str, object]], str]:
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler_ari)) as client:
                return await fetch_gaia_dr3_objects(133.78, -7.24, 0.08, client=client)

        rows, provider = asyncio.run(_run_ari())
        self.assertEqual(provider, "gaia_ari")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["source_id"], "5761985432616501376")

        # Case 2: Both ESA & ARI fail -> VizieR CfA ASU-TSV fallback
        def handler_vizier(request: httpx.Request) -> httpx.Response:
            if "vizier.cfa.harvard.edu" not in request.url.host:
                return httpx.Response(502)
            tsv = (
                "# Gaia DR3 subset\n"
                "Source\tRA_ICRS\tDE_ICRS\tpmRA\tpmDE\tPlx\tGmag\n"
                "\tdeg\tdeg\tmas/yr\tmas/yr\tmas\tmag\n"
                "------\t-------\t-------\t-----\t-----\t---\t----\n"
                "123456789\t269.452\t4.693\t-798.5\t10328.1\t548.3\t9.51\n"
            )
            return httpx.Response(200, text=tsv)

        async def _run_vz() -> tuple[list[dict[str, object]], str]:
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler_vizier)) as client:
                return await fetch_gaia_dr3_objects(269.45, 4.69, 0.08, client=client)

        rows_vz, provider_vz = asyncio.run(_run_vz())
        self.assertEqual(provider_vz, "gaia_vizier_cfa")
        self.assertEqual(len(rows_vz), 1)
        self.assertAlmostEqual(float(rows_vz[0]["pmdec"]), 10328.1, places=1)

    def test_horizons_csv_parsing_sqlite_ephemeris_and_wrapped_interpolation(self) -> None:
        planet_pts = parse_horizons_ephemeris_result(
            SAMPLE_HORIZONS_PLANET_RESULT,
            naif_id="499",
            body_name="Mars",
            body_class="planet",
        )
        comet_pts = parse_horizons_ephemeris_result(
            SAMPLE_HORIZONS_COMET_RESULT,
            naif_id="C/2025 N1",
            body_name="3I/ATLAS (C/2025 N1)",
            body_class="comet",
        )
        self.assertEqual(len(planet_pts), 2)
        self.assertEqual(planet_pts[0]["vmag"], -1.9)
        self.assertEqual(len(comet_pts), 2)
        self.assertEqual(comet_pts[0]["vmag"], 11.4)

        inserted = self.cache.upsert_ephemeris_points(planet_pts + comet_pts)
        self.assertEqual(inserted, 4)

        # Midpoint between May 1 (RA=359.9) and May 2 (RA=0.1) wraps cleanly to RA ~ 0.0
        mid_mjd = float(planet_pts[0]["mjd"]) + 0.5
        matches = self.cache.query_ephemeris_in_fov(
            mjd=mid_mjd,
            ra=0.0,
            dec=15.1,
            radius_deg=0.25,
        )
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["body_name"], "Mars")
        self.assertLess(matches[0]["ra"], 0.01)
        self.assertAlmostEqual(matches[0]["dec"], 15.1, places=3)

        # Live Horizons REST mock test
        def horizons_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"result": SAMPLE_HORIZONS_COMET_RESULT})

        async def _run_h() -> list[dict[str, object]]:
            async with httpx.AsyncClient(transport=httpx.MockTransport(horizons_handler)) as client:
                return await fetch_horizons_ephemeris(
                    "DES=C/2025 N1;", "C/2025 N1", "3I/ATLAS", "comet", client=client
                )

        h_pts = asyncio.run(_run_h())
        self.assertEqual(len(h_pts), 2)

    def test_most_ipac_brief_parser_and_name_aliases(self) -> None:
        parsed = parse_ipac_brief_table(SAMPLE_MOST_BRIEF)
        self.assertEqual(len(parsed), 1)
        self.assertAlmostEqual(parsed[0]["ra"], 135.12345, places=5)
        self.assertEqual(parsed[0]["uri"], "level2_2025W27_test_exposure.fits")

        captured_params: list[dict[str, str]] = []

        def most_handler(request: httpx.Request) -> httpx.Response:
            captured_params.append(dict(request.url.params))
            return httpx.Response(200, text=SAMPLE_MOST_BRIEF)

        async def _run_most() -> dict[str, object]:
            async with httpx.AsyncClient(transport=httpx.MockTransport(most_handler)) as client:
                return await fetch_most_spherex_matches("Ceres", client=client)

        res = asyncio.run(_run_most())
        self.assertEqual(res["status"], "ok")
        self.assertEqual(captured_params[0]["output_mode"], "Brief")
        self.assertEqual(captured_params[0]["obj_name"], "20000001:NID")

    def test_catalog_region_cache_ttl_and_unified_pipeline_crossmatch_and_degradation(self) -> None:
        self.cache.put_cached_catalog_region(
            "simbad",
            ra=133.78,
            dec=-7.24,
            radius_deg=0.063,
            payload={"provider": "simbad_idia", "objects": []},
            ttl_seconds=3600,
        )
        hit = self.cache.get_cached_catalog_region("simbad", 133.79, -7.25, 0.063)
        self.assertIsNotNone(hit)
        self.assertTrue(hit["cache_hit"])

        # Clear catalog cache and test cross-matching + ephemeris + graceful upstream error handling
        self.cache.clear()
        comet_pts = parse_horizons_ephemeris_result(
            SAMPLE_HORIZONS_COMET_RESULT,
            naif_id="C/2025 N1",
            body_name="3I/ATLAS (C/2025 N1)",
            body_class="comet",
        )
        self.cache.upsert_ephemeris_points(comet_pts)

        # Seed SIMBAD + Gaia DR3 matching a star near (198.26, -5.09)
        simbad_obj = {
            "main_id": "* Test Star A",
            "otype": "V*",
            "ra": 198.2600,
            "dec": -5.0900,
            "pmra": 120.0,
            "pmdec": -80.0,
            "provider": "simbad_idia",
        }
        gaia_obj = {
            "source_id": "3629000000001",
            "ra": 198.2601,  # within ~0.36" of SIMBAD object
            "dec": -5.0901,
            "pmra": 120.0,
            "pmdec": -80.0,
            "parallax": 15.2,
            "phot_g_mean_mag": 12.1,
            "provider": "gaia_ari",
        }

        def all_fail_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503)

        self.cache.put_cached_catalog_region(
            "simbad", 198.25, -5.10, 0.0625, {"provider": "simbad_idia", "objects": [simbad_obj]}
        )
        self.cache.put_cached_catalog_region(
            "gaia_dr3", 198.25, -5.10, 0.0625, {"provider": "gaia_ari", "objects": [gaia_obj]}
        )

        pipeline = AutomatedCelestialPipeline(
            cache=self.cache,
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(all_fail_handler)),
        )
        wcs = {
            "width": 256,
            "height": 256,
            "crval": [198.25, -5.10],
            "crpix": [128.0, 128.0],
            "cdelt": [-0.0003255, 0.0003255],
        }
        epochs_meta = [
            {
                "epoch_id": "pass_1",
                "mjd": float(comet_pts[0]["mjd"]),
                "iso_date": "2025-11-10T00:00:00Z",
            },
            {
                "epoch_id": "pass_2",
                "mjd": float(comet_pts[1]["mjd"]),
                "iso_date": "2025-11-11T00:00:00Z",
            },
        ]

        async def _run_pipeline() -> dict[str, object]:
            try:
                return await pipeline.resolve_patch_objects(198.25, -5.10, 5.0, wcs, epochs_meta)
            finally:
                if pipeline.http_client:
                    await pipeline.http_client.aclose()

        resolved = asyncio.run(_run_pipeline())
        ids = [o["object_id"] for o in resolved["known_objects"]]
        self.assertIn("ephem:C/2025 N1", ids)
        self.assertTrue(any(oid.startswith("simbad:") for oid in ids))
        # Deduplicated: merged SIMBAD+Gaia single object instead of creating separate gaia: row
        self.assertFalse(any(oid == "gaia:3629000000001" for oid in ids))

        comet_entry = next(
            o for o in resolved["known_objects"] if o["object_id"] == "ephem:C/2025 N1"
        )
        self.assertEqual(comet_entry["object_class"], "comet")
        self.assertNotEqual(comet_entry["motion_vector"]["dx_px"], 0.0)

        # Verify backend service integration produces valid contracts even when upstream is down
        service = StarHuntersBackendService(cache=self.cache)
        manifest = service.get_sky_patch(ra=198.25, dec=-5.10, fov=5.0)
        validate_sky_patch_manifest(manifest)
        cat_resp = service.get_catalogs(ra=198.25, dec=-5.10, fov=5.0)
        validate_catalogs_response(cat_resp)

        # Also check Solar System FOV service helper around comet pass 1 date bucket
        fov_res = service.get_solar_system_in_fov(
            ra=198.25,
            dec=-5.10,
            fov=5.0,
            mjd=float(comet_pts[0]["mjd"]),
        )
        self.assertGreaterEqual(fov_res["count"], 1)
        self.assertEqual(mjd_to_date_bucket(float(comet_pts[0]["mjd"])), "2025-11-10")

    def test_fastapi_routes_and_unversioned_aliases(self) -> None:
        if not HAS_FASTAPI:
            self.skipTest("FastAPI not installed")
        from fastapi.testclient import TestClient

        from app.main import app

        assert app is not None
        orig_cache = backend_service.cache
        orig_pipeline_cache = backend_service.catalog_pipeline.cache
        try:
            backend_service.cache = self.cache
            backend_service.catalog_pipeline.cache = self.cache
            client = TestClient(app)
            for prefix in ("/api/v1", "/api"):
                r_patch = client.get(
                    f"{prefix}/sky-patch",
                    params={
                        "ra": 133.7868,
                        "dec": -7.2451,
                        "fov": 5.0,
                        "live_catalogs": "false",
                    },
                )
                self.assertEqual(r_patch.status_code, 200)
                validate_sky_patch_manifest(r_patch.json())

                r_cat = client.get(
                    f"{prefix}/catalogs",
                    params={
                        "ra": 133.7868,
                        "dec": -7.2451,
                        "fov": 5.0,
                        "live_catalogs": "false",
                    },
                )
                self.assertEqual(r_cat.status_code, 200)
                validate_catalogs_response(r_cat.json())

                r_fov = client.get(
                    f"{prefix}/solar-system/in-fov",
                    params={"ra": 133.7868, "dec": -7.2451, "fov": 5.0},
                )
                self.assertEqual(r_fov.status_code, 200)
                self.assertIn("bodies", r_fov.json())
        finally:
            backend_service.cache = orig_cache
            backend_service.catalog_pipeline.cache = orig_pipeline_cache


if __name__ == "__main__":
    unittest.main()
