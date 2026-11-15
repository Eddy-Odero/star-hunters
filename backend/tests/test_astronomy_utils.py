"""Unit tests for shared astronomy utilities, JSON reference catalog, and app factory."""

from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from app.main import create_app
from app.models.contracts import DEFAULT_MOLECULAR_FEATURES, SHOWCASE_TARGETS
from app.models.global_sky_reference_catalog import (
    build_all_sky_reference_objects,
    extend_global_known_objects_index,
)
from app.services.backend_service import StarHuntersBackendService
from app.services.catalog_clients import fetch_simbad_objects
from app.services.spatial_cache import SpatialSqliteCache
from app.services.synthetic_patch import build_spectrum_payload
from app.utils.astronomy import (
    angular_separation_deg,
    build_tan_wcs_header,
    datetime_to_mjd,
    iso_to_mjd,
    mjd_to_date_bucket,
    mjd_to_iso,
    mjd_to_julian_year,
    offline_requested,
    pixel_to_sky,
    propagate_proper_motion,
    sky_to_pixel,
)


class TestAstronomyUtils(unittest.TestCase):
    def test_wcs_crpix_conventions_and_roundtrip(self) -> None:
        contract_wcs = build_tan_wcs_header(359.95, -10.5, fov_arcmin=5.0, crpix=128.0)
        self.assertEqual(contract_wcs["crpix"], [128.0, 128.0])
        self.assertEqual(contract_wcs["width"], 256)
        self.assertEqual(contract_wcs["height"], 256)

        px, py = sky_to_pixel(0.01, -10.5, contract_wcs)
        ra_back, dec_back = pixel_to_sky(px, py, contract_wcs)
        self.assertLess(angular_separation_deg(0.01, -10.5, ra_back, dec_back), 1e-4)

        fits_wcs = build_tan_wcs_header(
            120.0, -20.0, fov_arcmin=15.36, crpix=128.5, fits_keywords=True
        )
        self.assertEqual(fits_wcs["CRPIX1"], 128.5)
        self.assertEqual(fits_wcs["CRPIX2"], 128.5)
        self.assertEqual(fits_wcs["NAXIS1"], 256)

    def test_time_scales_and_invalid_iso(self) -> None:
        mjd = iso_to_mjd("2025-05-01T00:00:00Z")
        self.assertEqual(mjd_to_iso(mjd), "2025-05-01T00:00:00Z")
        self.assertEqual(mjd_to_date_bucket(mjd), "2025-05-01")
        self.assertAlmostEqual(mjd_to_julian_year(57388.5), 2016.0, places=5)
        self.assertAlmostEqual(iso_to_mjd("2025-May-01 00:00"), mjd, places=6)

        with self.assertRaises(ValueError):
            iso_to_mjd("not-a-timestamp")

    def test_proper_motion_wrap_and_clamping(self) -> None:
        ra_ep, dec_ep = propagate_proper_motion(
            ra_deg=359.999,
            dec_deg=89.999,
            pmra_mas_yr=5000.0,
            pmdec_mas_yr=5000.0,
            target_mjd=60810.5,
        )
        self.assertGreaterEqual(ra_ep, 0.0)
        self.assertLess(ra_ep, 360.0)
        self.assertLessEqual(dec_ep, 90.0)

    def test_offline_requested_env_variants(self) -> None:
        with patch.dict(os.environ, {"SPHEREX_OFFLINE": "true", "IRSA_OFFLINE": ""}, clear=False):
            self.assertTrue(offline_requested())
        with patch.dict(os.environ, {"IRSA_OFFLINE": "yes"}, clear=True):
            self.assertTrue(offline_requested())
        with patch.dict(os.environ, {"SPHEREX_OFFLINE": "", "IRSA_OFFLINE": "1"}, clear=True):
            self.assertTrue(offline_requested())
        with patch.dict(os.environ, {"SPHEREX_OFFLINE": "0", "IRSA_OFFLINE": "1"}, clear=True):
            self.assertFalse(offline_requested())
        with patch.dict(os.environ, {"SPHEREX_OFFLINE": "0", "IRSA_OFFLINE": "false"}, clear=False):
            self.assertFalse(offline_requested())

    def test_datetime_to_mjd(self) -> None:
        dt_utc = datetime(2025, 5, 1, 0, 0, 0, tzinfo=UTC)
        dt_naive = datetime(2025, 5, 1, 0, 0, 0)
        self.assertAlmostEqual(datetime_to_mjd(dt_utc), iso_to_mjd("2025-05-01T00:00:00Z"))
        self.assertAlmostEqual(datetime_to_mjd(dt_naive), datetime_to_mjd(dt_utc))
        self.assertGreater(datetime_to_mjd(), 60000.0)

    def test_spectrum_payload_deep_copies_features_and_preserves_query_coords(self) -> None:
        meta = SHOWCASE_TARGETS["wise_0855"]
        orig_label = DEFAULT_MOLECULAR_FEATURES[0]["label"]
        first = build_spectrum_payload(meta["ra"], meta["dec"], "WISE 0855", slug="wise_0855")
        first["molecular_features"][0]["label"] = "MUTATED"
        self.assertEqual(DEFAULT_MOLECULAR_FEATURES[0]["label"], orig_label)

        offset_ra = round(meta["ra"] + 0.0004, 4)
        offset_dec = round(meta["dec"] - 0.0004, 4)
        second = build_spectrum_payload(offset_ra, offset_dec, "Custom Label", slug="wise_0855")
        self.assertEqual(second["ra"], offset_ra)
        self.assertEqual(second["dec"], offset_dec)
        self.assertEqual(second["source_label"], "Custom Label")

    def test_parallel_tap_mirror_race_cancels_slower_mirror_cleanly(self) -> None:
        async def _handler(request: httpx.Request) -> httpx.Response:
            if "idia.ac.za" in request.url.host:
                await asyncio.sleep(0.25)
                return httpx.Response(503)
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
                    "data": [["V* Test", "V*", 10.0, 20.0, None, None]],
                },
            )

        async def _run() -> tuple[list[dict[str, object]], str]:
            transport = httpx.MockTransport(_handler)
            async with httpx.AsyncClient(transport=transport) as client:
                return await fetch_simbad_objects(
                    10.0, 20.0, 0.1, client=client, parallel_mirrors=True
                )

        rows, provider = asyncio.run(_run())
        self.assertEqual(provider, "simbad_cfa")
        self.assertEqual(len(rows), 1)

    def test_all_sky_reference_catalog_json_loader_and_dedup(self) -> None:
        refs = build_all_sky_reference_objects()
        self.assertEqual(len(refs), 50)
        duplicate = dict(refs[0])
        merged = extend_global_known_objects_index([duplicate])
        self.assertEqual(len(merged), 50)

    def test_create_app_lifespan_closes_cache(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cache = SpatialSqliteCache(db_path=str(Path(tmp) / "lifespan.db"))
            service = StarHuntersBackendService(cache=cache)
            with TestClient(create_app(service)) as client:
                resp = client.get("/health")
                self.assertEqual(resp.status_code, 200)
                self.assertEqual(len(cache._connections), 1)
            self.assertEqual(len(cache._connections), 0)
