"""Unit tests for SPHEREx IRSA cutout ingestion and hygiene preprocessing."""

from __future__ import annotations

import asyncio
import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from astropy.io import fits

from app.services import spherex_ingest as ingest


def build_test_hdul(
    shape: tuple[int, int] = (8, 8),
    mjd_obs: float = 60123.5,
    bandpass: str = "SPHEREx-D2",
) -> fits.HDUList:
    image = np.full(shape, 4.0, dtype=np.float32)
    zodi = np.ones(shape, dtype=np.float32)
    variance = np.full(shape, 0.25, dtype=np.float32)
    flags = np.zeros(shape, dtype=np.uint32)

    image[1, 1] = np.nan
    variance[2, 2] = np.nan
    flags[0, 0] |= np.uint32(1 << 0)
    flags[0, 1] |= np.uint32(1 << 1)
    flags[0, 2] |= np.uint32(1 << 6)
    flags[0, 3] |= np.uint32(1 << 22)

    primary = fits.PrimaryHDU()
    primary.header["MJD-OBS"] = mjd_obs
    primary.header["BANDPASS"] = bandpass

    image_hdu = fits.ImageHDU(image, name="IMAGE")
    image_hdu.header["BANDPASS"] = bandpass
    image_hdu.header["MJD-OBS"] = mjd_obs

    return fits.HDUList(
        [
            primary,
            image_hdu,
            fits.ImageHDU(flags.astype(np.int32), name="FLAGS"),
            fits.ImageHDU(variance, name="VARIANCE"),
            fits.ImageHDU(zodi, name="ZODI"),
        ]
    )


class TestSpherexValidationAndQuery(unittest.TestCase):
    def test_validate_coordinates(self) -> None:
        ingest.validate_coordinates(0.0, -90.0, 5.0)
        ingest.validate_coordinates(359.999, 90.0, 0.1)

        for ra, dec, fov in (
            (-0.1, 0.0, 5.0),
            (360.0, 0.0, 5.0),
            (0.0, -90.1, 5.0),
            (0.0, 90.1, 5.0),
            (0.0, 0.0, 0.0),
            (float("nan"), 0.0, 5.0),
        ):
            with self.assertRaises(ingest.SpherexValidationError):
                ingest.validate_coordinates(ra, dec, fov)

    def test_build_adql_query(self) -> None:
        query = ingest.build_adql_query(133.7951, -7.2451, 5.0)
        self.assertIn("spherex.artifact", query)
        self.assertIn("spherex.plane", query)
        self.assertIn("CONTAINS", query)
        self.assertIn("POINT('ICRS', 133.7951, -7.2451)", query)
        self.assertIn("p.poly", query)
        for band in ingest.SPHEREX_BANDPASSES:
            self.assertIn(f"'{band}'", query)
        self.assertIn("center=133.7951,-7.2451d", query)
        self.assertIn("size=0.08333333333333333", query)

        with self.assertRaises(ingest.SpherexValidationError):
            ingest.build_adql_query(10.0, 20.0, 5.0, bandpasses=())
        with self.assertRaises(ingest.SpherexValidationError):
            ingest.build_adql_query(10.0, 20.0, 5.0, bandpasses=("SPHEREx-D7",))

    def test_build_cutout_url(self) -> None:
        url = ingest.build_cutout_url("artifact/abc.fits", 10.0, 20.5, 6.0)
        self.assertEqual(
            url,
            "https://irsa.ipac.caltech.edu/artifact/abc.fits?center=10.0,20.5d&size=0.1",
        )

        existing = "https://irsa.ipac.caltech.edu/artifact/abc.fits?center=1,2d&size=0.1"
        self.assertEqual(
            ingest.build_cutout_url(existing, 10.0, 20.5, 6.0),
            existing,
        )


class TestFlagHygieneMapping(unittest.TestCase):
    def test_low_byte_maps_directly(self) -> None:
        flags = np.array([0, 1, 2, 4, 8, 15], dtype=np.uint32)
        np.testing.assert_array_equal(
            ingest.map_flags_to_hygiene(flags),
            np.array([0, 1, 2, 4, 8, 15], dtype=np.uint8),
        )

    def test_native_spherex_bits_map_semantically(self) -> None:
        flags = np.array(
            [
                1 << ingest.SPHEREX_FLAG_BITS["TRANSIENT"],
                1 << ingest.SPHEREX_FLAG_BITS["OVERFLOW"],
                1 << ingest.SPHEREX_FLAG_BITS["NONFUNC"],
                1 << ingest.SPHEREX_FLAG_BITS["GHOST"],
                1 << ingest.SPHEREX_FLAG_BITS["SNOWBALL"],
                1 << ingest.SPHEREX_FLAG_BITS["BLOOM"],
                1 << ingest.SPHEREX_FLAG_BITS["MISSING_DATA"],
                1 << ingest.SPHEREX_FLAG_BITS["HALO"],
            ],
            dtype=np.uint32,
        )
        np.testing.assert_array_equal(
            ingest.map_flags_to_hygiene(flags),
            np.array([1, 2, 4, 8, 1, 2, 4, 8], dtype=np.uint8),
        )

    def test_nan_flags_are_bad_reference(self) -> None:
        flags = np.array([np.nan, 0.0, np.inf], dtype=np.float32)
        np.testing.assert_array_equal(
            ingest.map_flags_to_hygiene(flags),
            np.array([4, 0, 4], dtype=np.uint8),
        )


class TestFitsProcessing(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)

    def test_clean_image_variance_mjd_and_flags(self) -> None:
        hdul = build_test_hdul()
        try:
            buffer = io.BytesIO()
            hdul.writeto(buffer)
        finally:
            hdul.close()

        cutout = ingest.process_spherex_fits(buffer.getvalue())

        self.assertEqual(cutout.clean_image.shape, (8, 8))
        self.assertEqual(cutout.clean_image.dtype, np.float32)
        self.assertEqual(cutout.flags_mask.dtype, np.uint8)
        self.assertEqual(cutout.variance.dtype, np.float32)
        self.assertEqual(cutout.weight_map.dtype, np.float32)
        self.assertEqual(cutout.mjd_obs, 60123.5)
        self.assertEqual(cutout.bandpass, "SPHEREx-D2")

        np.testing.assert_allclose(cutout.clean_image[3, 3], 3.0)
        np.testing.assert_allclose(cutout.variance[3, 3], 0.25)
        np.testing.assert_allclose(cutout.weight_map[3, 3], 4.0)

        self.assertTrue(np.isfinite(cutout.clean_image).all())
        self.assertTrue(np.isfinite(cutout.variance).all())
        self.assertTrue(np.isfinite(cutout.weight_map).all())

        self.assertEqual(int(cutout.flags_mask[0, 0]), 1)
        self.assertEqual(int(cutout.flags_mask[0, 1]), 2)
        self.assertEqual(int(cutout.flags_mask[0, 2]), 4)
        self.assertEqual(int(cutout.flags_mask[0, 3]), 8)
        self.assertEqual(cutout.weight_map[0, 0], 0.0)
        self.assertEqual(cutout.weight_map[0, 1], 0.0)
        self.assertEqual(cutout.weight_map[0, 2], 0.0)
        self.assertEqual(cutout.weight_map[0, 3], 0.0)

        self.assertEqual(int(cutout.flags_mask[1, 1]) & 4, 4)
        self.assertEqual(int(cutout.flags_mask[2, 2]) & 4, 4)
        self.assertEqual(cutout.weight_map[1, 1], 0.0)
        self.assertEqual(cutout.weight_map[2, 2], 0.0)
        self.assertEqual(cutout.clean_image[1, 1], 0.0)
        self.assertEqual(cutout.clean_image[2, 2], 0.0)

    def test_reads_path_fixture(self) -> None:
        path = ingest.write_synthetic_spherex_fits(
            Path(self.temp_dir.name) / "cutout.fits",
            ra=10.0,
            dec=20.0,
            bandpass="SPHEREx-D3",
        )
        cutout = ingest.process_spherex_fits(path)
        self.assertEqual(cutout.bandpass, "SPHEREx-D3")
        self.assertEqual(cutout.source, "fits")
        self.assertTrue(np.isfinite(cutout.clean_image).all())
        self.assertGreater(len(np.unique(cutout.flags_mask)), 1)

    def test_wcs_wave_extension_supplies_wavelength_metadata(self) -> None:
        hdul = build_test_hdul()
        wave_hdu = fits.ImageHDU(
            np.linspace(0.75, 1.10, 8, dtype=np.float32),
            name="WCS-WAVE",
        )
        wave_hdu.header["CRVAL3"] = 1.23
        wave_hdu.header["CTYPE3"] = "WAVE"
        hdul.append(wave_hdu)
        try:
            cutout = ingest.process_spherex_fits(hdul)
        finally:
            hdul.close()

        self.assertAlmostEqual(cutout.header["CRVAL3"], 1.23)
        self.assertEqual(cutout.header["CTYPE3"], "WAVE")

    def test_bandpass_and_mjd_header_fallbacks(self) -> None:
        hdul = build_test_hdul(mjd_obs=60200.25)
        hdul[0].header.remove("MJD-OBS")
        hdul[0].header.remove("BANDPASS")
        hdul["IMAGE"].header.remove("MJD-OBS")
        hdul["IMAGE"].header.remove("BANDPASS")
        hdul["IMAGE"].header["DETECTOR"] = 5
        hdul[0].header["MJD-BEG"] = 60200.0
        hdul[0].header["MJD-END"] = 60200.5
        try:
            cutout = ingest.process_spherex_fits(hdul, source_name="memory")
        finally:
            hdul.close()

        self.assertEqual(cutout.bandpass, "SPHEREx-D5")
        self.assertEqual(cutout.mjd_obs, 60200.25)
        self.assertEqual(cutout.source, "memory")

    def test_missing_extension_raises(self) -> None:
        hdul = build_test_hdul()
        hdul.pop(4)
        try:
            with self.assertRaises(ingest.SpherexProcessingError):
                ingest.process_spherex_fits(hdul)
        finally:
            hdul.close()

    def test_mismatched_shapes_raise(self) -> None:
        hdul = build_test_hdul()
        hdul["ZODI"].data = np.ones((4, 4), dtype=np.float32)
        try:
            with self.assertRaises(ingest.SpherexProcessingError):
                ingest.process_spherex_fits(hdul)
        finally:
            hdul.close()

    def test_synthetic_generator_is_deterministic(self) -> None:
        first = ingest.generate_synthetic_spherex_cutout(
            ra=10.0,
            dec=20.0,
            bandpass="SPHEREx-D4",
            seed=7,
        )
        second = ingest.generate_synthetic_spherex_cutout(
            ra=10.0,
            dec=20.0,
            bandpass="SPHEREx-D4",
            seed=7,
        )
        np.testing.assert_array_equal(first.clean_image, second.clean_image)
        np.testing.assert_array_equal(first.flags_mask, second.flags_mask)
        self.assertEqual(first.source, "synthetic")


class FakeResponse:
    def __init__(self, content: bytes = b"fits", status_error: bool = False):
        self.content = content
        self.status_error = status_error
        self.closed = False

    def raise_for_status(self) -> None:
        if self.status_error:
            raise RuntimeError("HTTP 500")

    def iter_content(self, chunk_size: int = 1024):
        yield self.content

    def close(self) -> None:
        self.closed = True


class FakeSession:
    def __init__(self, response: FakeResponse):
        self.response = response
        self.urls: list[str] = []

    def get(self, url: str, **kwargs):
        self.urls.append(url)
        return self.response


class TestDownloadsAndFallback(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)

    def test_download_cutout_uses_timeout_and_returns_bytes(self) -> None:
        response = FakeResponse(b"mef-payload")
        session = FakeSession(response)

        payload = ingest.download_cutout(
            "artifact/abc.fits",
            ra=10.0,
            dec=20.0,
            fov_arcmin=5.0,
            session=session,
            timeout=12.0,
        )

        self.assertEqual(payload, b"mef-payload")
        self.assertTrue(response.closed)
        self.assertIn("center=10.0,20.0d", session.urls[0])
        self.assertIn("size=0.08333333333333333", session.urls[0])

    def test_download_cutout_failure_raises_download_error(self) -> None:
        response = FakeResponse(status_error=True)
        session = FakeSession(response)
        with self.assertRaises(ingest.SpherexDownloadError):
            ingest.download_cutout(
                "artifact/abc.fits",
                ra=10.0,
                dec=20.0,
                fov_arcmin=5.0,
                session=session,
            )
        self.assertTrue(response.closed)

    def test_async_download_with_httpx_mock_transport(self) -> None:
        import httpx

        def handler(request: httpx.Request) -> httpx.Response:
            self.assertIn("center=10.0,20.0d", str(request.url))
            return httpx.Response(200, content=b"async-mef")

        async def run() -> bytes:
            transport = httpx.MockTransport(handler)
            async with httpx.AsyncClient(transport=transport) as client:
                return await ingest.download_cutout_async(
                    "artifact/abc.fits",
                    ra=10.0,
                    dec=20.0,
                    fov_arcmin=5.0,
                    client=client,
                )

        self.assertEqual(asyncio.run(run()), b"async-mef")

    def test_async_download_batch_returns_none_for_failures(self) -> None:
        import httpx

        def handler(request: httpx.Request) -> httpx.Response:
            if "bad" in str(request.url):
                return httpx.Response(500)
            return httpx.Response(200, content=b"ok")

        observations = [
            ingest.SpherexObservation(uri="artifact/good.fits", bandpass="SPHEREx-D1"),
            ingest.SpherexObservation(uri="artifact/bad.fits", bandpass="SPHEREx-D2"),
        ]

        async def run() -> list:
            transport = httpx.MockTransport(handler)
            async with httpx.AsyncClient(transport=transport) as client:
                return await ingest.download_cutouts_async(
                    observations,
                    ra=10.0,
                    dec=20.0,
                    fov_arcmin=5.0,
                    client=client,
                )

        self.assertEqual(asyncio.run(run()), [b"ok", None])

    def test_ingest_falls_back_to_synthetic_when_irsa_unreachable(self) -> None:
        with mock.patch.object(
            ingest,
            "query_observations",
            side_effect=ingest.SpherexIngestError("offline"),
        ):
            cutouts = ingest.ingest_spherex_cutouts(
                ra=10.0,
                dec=20.0,
                fov_arcmin=5.0,
                bandpasses=("SPHEREx-D1", "SPHEREx-D2"),
            )

        self.assertEqual(len(cutouts), 2)
        self.assertEqual([c.bandpass for c in cutouts], ["SPHEREx-D1", "SPHEREx-D2"])
        self.assertTrue(all(c.source == "synthetic" for c in cutouts))
        for cutout in cutouts:
            self.assertTrue(np.isfinite(cutout.clean_image).all())
            self.assertEqual(cutout.flags_mask.dtype, np.uint8)

    def test_ingest_falls_back_to_cached_fixture_after_download_error(self) -> None:
        fixture_dir = Path(self.temp_dir.name) / "fixtures"
        fixture_dir.mkdir()
        ingest.write_synthetic_spherex_fits(
            fixture_dir / "SPHEREx-D2.fits",
            ra=10.0,
            dec=20.0,
            bandpass="SPHEREx-D2",
        )
        observation = ingest.SpherexObservation(
            uri="artifact/abc.fits",
            bandpass="SPHEREx-D2",
            time_bounds_lower="2026-01-01T00:00:00Z",
            mjd_obs=61000.0,
        )

        with (
            mock.patch.object(
                ingest,
                "query_observations",
                return_value=[observation],
            ),
            mock.patch.object(
                ingest,
                "download_cutout",
                side_effect=ingest.SpherexDownloadError("offline"),
            ),
        ):
            cutouts = ingest.ingest_spherex_cutouts(
                ra=10.0,
                dec=20.0,
                fov_arcmin=5.0,
                bandpasses=("SPHEREx-D2",),
                fixture_dir=fixture_dir,
            )

        self.assertEqual(len(cutouts), 1)
        self.assertEqual(cutouts[0].source, "fixture-cache")
        self.assertEqual(cutouts[0].bandpass, "SPHEREx-D2")

    def test_ingest_without_fallback_raises(self) -> None:
        with mock.patch.object(
            ingest,
            "query_observations",
            side_effect=ingest.SpherexIngestError("offline"),
        ):
            with self.assertRaises(ingest.SpherexIngestError):
                ingest.ingest_spherex_cutouts(
                    ra=10.0,
                    dec=20.0,
                    fov_arcmin=5.0,
                    allow_synthetic_fallback=False,
                )

    def test_ingest_async_falls_back_to_synthetic_when_irsa_unreachable(self) -> None:
        with mock.patch.object(
            ingest,
            "query_observations",
            side_effect=ingest.SpherexIngestError("offline"),
        ):
            cutouts = asyncio.run(
                ingest.ingest_spherex_cutouts_async(
                    ra=10.0,
                    dec=20.0,
                    fov_arcmin=5.0,
                    bandpasses=("SPHEREx-D1", "SPHEREx-D2"),
                )
            )

        self.assertEqual(len(cutouts), 2)
        self.assertEqual([c.bandpass for c in cutouts], ["SPHEREx-D1", "SPHEREx-D2"])
        self.assertTrue(all(c.source == "synthetic" for c in cutouts))


if __name__ == "__main__":
    unittest.main()
