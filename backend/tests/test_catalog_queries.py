"""Unit tests for asynchronous multi-mission catalog queries (Gaia DR3, WISE & NASA MOST)."""

from __future__ import annotations

import asyncio
import json
import unittest

import httpx

from app.models.contracts import CatalogOverlays
from app.services.catalog_queries import (
    build_tan_wcs_256,
    query_all_catalogs,
)

SAMPLE_IPAC_MOST = """\\fixlen=T
|object_name|ra_obj  |dec_obj  |vmag |
|char       |double  |double   |double|
Ceres        133.7951 -7.2451   7.4
"""


class TestCatalogQueries(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_queries_project_to_256_wcs_and_validate(self) -> None:
        ra0, dec0 = 133.7951, -7.2451
        wcs = build_tan_wcs_256(ra0, dec0, fov_arcmin=5.0)
        seen_urls: list[str] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            seen_urls.append(url)
            if "gea.esac.esa.int" in url or "gaia.ari" in url:
                return httpx.Response(
                    200,
                    json={
                        "metadata": [
                            {"name": "source_id"},
                            {"name": "ra"},
                            {"name": "dec"},
                            {"name": "g_mag"},
                            {"name": "bp_rp"},
                            {"name": "pmra"},
                            {"name": "pmdec"},
                        ],
                        "data": [
                            ["5761985432616501888", ra0, dec0, 14.25, 1.12, -12.4, 5.1],
                        ],
                    },
                )
            if "irsa.ipac.caltech.edu/TAP" in url:
                return httpx.Response(
                    200,
                    json={
                        "metadata": [
                            {"name": "source_id"},
                            {"name": "ra"},
                            {"name": "dec"},
                            {"name": "w1mpro"},
                            {"name": "w2mpro"},
                        ],
                        "data": [
                            ["J085510.83-071442.5", ra0, dec0, 15.8, 13.9],
                        ],
                    },
                )
            if "MOST/nph-most" in url:
                return httpx.Response(200, text=SAMPLE_IPAC_MOST)
            return httpx.Response(404, text="not found")

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            payload = await query_all_catalogs(
                ra0, dec0, fov_arcmin=5.0, wcs=wcs, timeout_sec=3.0, client=client
            )

        validated = CatalogOverlays._from_dict(payload)
        self.assertEqual(len(validated.gaia_dr3), 1)
        self.assertEqual(len(validated.wise_sources), 1)
        self.assertEqual(len(validated.most_solar_system), 1)
        self.assertEqual(payload["source_status"]["gaia_dr3"], "ok")
        self.assertEqual(payload["source_status"]["wise_sources"], "ok")
        self.assertEqual(payload["source_status"]["most_solar_system"], "ok")

        # Center coordinate must project to (128.0, 128.0) on the 256x256 TAN WCS grid
        self.assertAlmostEqual(validated.gaia_dr3[0].x, 128.0, places=2)
        self.assertAlmostEqual(validated.gaia_dr3[0].y, 128.0, places=2)
        self.assertAlmostEqual(validated.wise_sources[0].x, 128.0, places=2)
        self.assertAlmostEqual(validated.wise_sources[0].y, 128.0, places=2)
        self.assertAlmostEqual(validated.most_solar_system[0].x, 128.0, places=2)
        self.assertAlmostEqual(validated.most_solar_system[0].y, 128.0, places=2)
        self.assertAlmostEqual(validated.wise_sources[0].w1_w2_color, 1.9, places=2)
        self.assertTrue(all("cds.unistra.fr" not in u for u in seen_urls))

    async def test_archive_timeout_and_failure_degrade_gracefully(self) -> None:
        ra0, dec0 = 133.7951, -7.2451

        async def handler(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            if "gea.esac.esa.int" in url or "gaia.ari" in url:
                await asyncio.sleep(0.25)
                return httpx.Response(200, json={"metadata": [], "data": []})
            if "irsa.ipac.caltech.edu/TAP" in url:
                return httpx.Response(503, json={"error": "IRSA unavailable"})
            if "MOST/nph-most" in url:
                return httpx.Response(200, text=SAMPLE_IPAC_MOST)
            return httpx.Response(404)

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            payload = await query_all_catalogs(
                ra0, dec0, fov_arcmin=5.0, timeout_sec=0.05, client=client
            )

        validated = CatalogOverlays._from_dict(payload)
        self.assertEqual(validated.gaia_dr3, [])
        self.assertEqual(validated.wise_sources, [])
        self.assertEqual(len(validated.most_solar_system), 1)
        self.assertEqual(payload["source_status"]["gaia_dr3"], "timeout")
        self.assertEqual(payload["source_status"]["wise_sources"], "error")
        self.assertEqual(payload["source_status"]["most_solar_system"], "ok")


if __name__ == "__main__":
    unittest.main()
