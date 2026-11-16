"""Core backend service orchestrating spatial caching, catalogs, frames, and spectra."""

from __future__ import annotations

import asyncio
import gzip
import math
import os
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any, Literal

from app.models.contracts import (
    SHOWCASE_TARGETS,
    convert_float32_bytes_to_float16_bytes,
    validate_catalogs_response,
    validate_earth_to_sky_response,
    validate_sky_patch_manifest,
    validate_spectrum_payload,
)
from app.services.archival_resolver import (
    ArchivalResolver,
    apply_solar_system_ephemeris_to_frames,
    merge_pipeline_overlays,
)
from app.services.catalog_clients import fetch_most_spherex_matches
from app.services.celestial_catalog_pipeline import AutomatedCelestialPipeline
from app.services.logging_config import configure_backend_logging, get_logger
from app.services.object_epochs import resolve_object_observation_epochs
from app.services.object_search import (
    get_global_known_objects_index,
    search_known_objects,
    search_known_objects_async,
)
from app.services.skyview_fallback import fetch_skyview_fallback
from app.services.spatial_cache import SpatialSqliteCache, compute_grid_key
from app.services.spectrum_extractor import extract_forced_spectrum
from app.services.spherex_coadd import build_target_wcs_header, coadd_spherex_epochs
from app.services.spherex_ingest import (
    DEFAULT_MAX_SPECTRUM_CUTOUTS,
    _env_float,
    ingest_spherex_cutouts,
)
from app.services.synthetic_patch import (
    build_sky_patch_manifest_payload,
    build_spectrum_payload,
    generate_synthetic_epoch_frames,
)
from app.services.wise_fallback import fetch_wise_fallback
from app.services.zenith_bridge import (
    compute_zenith_icrs,
    find_matching_capital_city,
    pick_random_capital_city,
)
from app.utils.astronomy import datetime_to_mjd

_logger = get_logger("backend")


class StarHuntersBackendService:
    """Core request handler used by both FastAPI routes and standalone tests."""

    def __init__(
        self,
        cache: SpatialSqliteCache | None = None,
        enable_archival_data: bool | None = None,
        wise_fallback_fetcher: Callable[..., Any] = fetch_wise_fallback,
        skyview_fallback_fetcher: Callable[..., Any] = fetch_skyview_fallback,
        spherex_cutout_fetcher: Callable[..., list[Any]] = ingest_spherex_cutouts,
        spherex_coadder: Callable[..., Any] = coadd_spherex_epochs,
        wcs_header_builder: Callable[..., dict[str, Any]] = build_target_wcs_header,
        spectrum_extractor: Callable[..., dict[str, Any]] = extract_forced_spectrum,
        catalog_pipeline: AutomatedCelestialPipeline | None = None,
        archival_resolver: ArchivalResolver | None = None,
    ) -> None:
        """Initialize the backend service with optional injected dependencies.

        Args:
            cache: SQLite spatial cache instance (defaults to a new
                :class:`SpatialSqliteCache`).
            enable_archival_data: Whether live archival IRSA/WISE/SkyView queries
                are enabled; defaults to ``ENABLE_ARCHIVAL_DATA`` env var.
            wise_fallback_fetcher: Callable fetching WISE/NEOWISE fallback epochs.
            skyview_fallback_fetcher: Callable fetching NASA SkyView fallback epochs.
            spherex_cutout_fetcher: Callable ingesting SPHEREx cutouts.
            spherex_coadder: Callable clustering and co-adding SPHEREx cutouts.
            wcs_header_builder: Callable constructing FITS TAN WCS headers.
            spectrum_extractor: Callable extracting 102-band forced spectra.
            catalog_pipeline: Optional pre-configured :class:`AutomatedCelestialPipeline`.
            archival_resolver: Optional pre-configured :class:`ArchivalResolver`.
        """
        configure_backend_logging()
        self.cache = cache or SpatialSqliteCache()
        self.admin_token = os.environ.get("ADMIN_TOKEN", "star-hunters-dev-token")
        self.catalog_pipeline = catalog_pipeline or AutomatedCelestialPipeline(cache=self.cache)
        if enable_archival_data is None:
            configured = os.environ.get("ENABLE_ARCHIVAL_DATA", "false").strip().lower()
            enable_archival_data = configured in {"1", "true", "yes", "on"}
        self.enable_archival_data = enable_archival_data
        self.wise_fallback_fetcher = wise_fallback_fetcher
        self.skyview_fallback_fetcher = skyview_fallback_fetcher
        self.spherex_cutout_fetcher = spherex_cutout_fetcher
        self.spherex_coadder = spherex_coadder
        self.wcs_header_builder = wcs_header_builder
        self.spectrum_extractor = spectrum_extractor
        self.archival_resolver = archival_resolver or ArchivalResolver(
            spherex_cutout_fetcher=spherex_cutout_fetcher,
            spherex_coadder=spherex_coadder,
            wcs_header_builder=wcs_header_builder,
            wise_fallback_fetcher=wise_fallback_fetcher,
            skyview_fallback_fetcher=skyview_fallback_fetcher,
        )
        self._inflight_tasks: dict[str, asyncio.Future[Any]] = {}
        _logger.info(
            "StarHuntersBackendService initialized (enable_archival_data=%s)",
            self.enable_archival_data,
        )

    def prewarm_known_data(self) -> int:
        """Pre-warm all showcase manifests, spectra, frames, and the search index.

        Returns:
            Number of showcase targets written to SQLite.
        """
        get_global_known_objects_index()
        count = 0
        for slug, meta in SHOWCASE_TARGETS.items():
            grid_key, ra_q, dec_q = compute_grid_key(meta["ra"], meta["dec"], 5.0)
            self.cache.pin_grid_key(grid_key)
            manifest = build_sky_patch_manifest_payload(
                ra=meta["ra"],
                dec=meta["dec"],
                fov_arcmin=5.0,
                slug=slug,
            )
            manifest = self._apply_cached_pipeline_sync(
                manifest,
                ra=meta["ra"],
                dec=meta["dec"],
                fov=5.0,
            )
            frames = generate_synthetic_epoch_frames(slug=slug, manifest=manifest)
            self.cache.put_sky_patch(
                grid_key=grid_key,
                ra_center=ra_q,
                dec_center=dec_q,
                fov_arcmin=5.0,
                manifest=manifest,
                frames=frames,
            )
            spec = build_spectrum_payload(
                ra=meta["ra"],
                dec=meta["dec"],
                source_label=meta["name"],
                slug=slug,
            )
            spec_key = f"spec_ra{round(meta['ra'], 4):.4f}_dec{round(meta['dec'], 4):.4f}"
            self.cache.put_spectrum(
                spectrum_key=spec_key,
                ra=meta["ra"],
                dec=meta["dec"],
                payload=spec,
            )
            count += 1
        return count

    def search_known_objects(
        self,
        query: str = "",
        limit: int = 30,
    ) -> list[dict[str, Any]]:
        """Fuzzy-search known celestial objects across all indexed targets.

        Args:
            query: Search string.
            limit: Maximum number of results to return.

        Returns:
            Ranked list of matching known-object dictionaries.
        """
        return search_known_objects(query=query, limit=limit)

    async def search_known_objects_async(
        self,
        query: str = "",
        limit: int = 30,
    ) -> list[dict[str, Any]]:
        """Fuzzy-search known objects and refresh live JPL Horizons coordinates.

        Args:
            query: Search string.
            limit: Maximum number of results to return.

        Returns:
            Ranked list of matching known-object dictionaries.
        """
        return await search_known_objects_async(
            query=query,
            limit=limit,
            cache=self.cache,
            catalog_pipeline=self.catalog_pipeline,
            enable_archival_data=self.enable_archival_data,
        )

    async def get_object_observation_epochs_async(
        self,
        *,
        object_id: str = "",
        label: str = "",
        object_type: str | None = None,
        object_class: str | None = None,
        target_slug: str | None = None,
        ra: float | None = None,
        dec: float | None = None,
    ) -> dict[str, Any]:
        """Resolve constrained observation epochs (Current Time + SPHEREx passes only)."""
        return await resolve_object_observation_epochs(
            object_id=object_id,
            label=label,
            object_type=object_type,
            object_class=object_class,
            target_slug=target_slug,
            ra=ra,
            dec=dec,
            cache=self.cache,
            catalog_pipeline=self.catalog_pipeline,
            enable_archival_data=self.enable_archival_data,
            lookup_most_fn=self.lookup_most_object,
        )

    def health(self) -> dict[str, str]:
        """Return service health status payload."""
        return {
            "status": "ok",
            "service": "star-hunters-backend",
            "version": "0.1.0",
        }

    def get_earth_to_sky(
        self,
        lat: float | None = None,
        lon: float | None = None,
        iso_time: str | None = None,
        fallback_seed: int | None = None,
        prewarm_patch: bool = True,
    ) -> dict[str, Any]:
        """Compute or retrieve cached Earth-to-Sky zenith coordinates.

        Args:
            lat: Observer latitude in degrees, or ``None`` for random capital fallback.
            lon: Observer longitude in degrees, or ``None`` for random capital fallback.
            iso_time: Optional ISO-8601 UTC timestamp.
            fallback_seed: Optional deterministic seed for capital city selection.
            prewarm_patch: Whether to populate the overhead sky patch in SQLite.

        Returns:
            Validated ``EarthToSkyResponse`` dictionary.

        Raises:
            ValueError: If ``lat`` or ``lon`` are out of valid geographic bounds.
        """
        is_fallback = lat is None or lon is None
        city_slug: str | None = None
        selected_capital: dict[str, Any] | None = None
        if is_fallback:
            selected_capital = pick_random_capital_city(seed=fallback_seed)
            lat = float(selected_capital["lat"])
            lon = float(selected_capital["lon"])
            city_slug = str(selected_capital["slug"])

        assert lat is not None and lon is not None
        if not (-90.0 <= lat <= 90.0):
            raise ValueError("Latitude must be in [-90.0, 90.0]")
        if not (-180.0 <= lon <= 180.0):
            raise ValueError("Longitude must be in [-180.0, 180.0]")

        if iso_time:
            clean_iso = iso_time.replace("Z", "+00:00")
            dt = datetime.fromisoformat(clean_iso)
            dt = dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)
            iso_utc = dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        else:
            dt = datetime.now(UTC)
            iso_utc = dt.strftime("%Y-%m-%dT%H:%M:%SZ")

        time_bucket = iso_utc[:16]
        cache_key = (
            f"zenith_{city_slug or 'coord'}_lat{lat:.2f}_lon{lon:.2f}"
            f"_t{time_bucket}_fb{int(is_fallback)}"
        )
        cached_zenith = self.cache.get_zenith_response(cache_key)
        if cached_zenith is not None:
            validate_earth_to_sky_response(cached_zenith)
            if prewarm_patch:
                cached_ra = float(cached_zenith["zenith_icrs"]["ra"])
                cached_dec = float(cached_zenith["zenith_icrs"]["dec"])
                cached_grid_key, _, _ = compute_grid_key(cached_ra, cached_dec, 5.0)
                cached_patch = self.cache.get_manifest(cached_grid_key)
                needs_archival_refresh = (
                    self.enable_archival_data and self._is_pending_archival_demo(cached_patch)
                )
                if cached_patch is None or needs_archival_refresh:
                    self.get_sky_patch(cached_ra, cached_dec, fov=5.0)
            return cached_zenith

        payload = compute_zenith_icrs(
            lat=lat,
            lon=lon,
            iso_time=iso_utc,
        )
        if is_fallback and selected_capital is not None:
            payload["earth"]["lat"] = round(lat, 4)
            payload["earth"]["lon"] = round(lon, 4)
            payload["earth"]["city_name"] = str(selected_capital["city_name"])
            payload["earth"]["country"] = str(selected_capital["country"])
            payload["earth"]["is_fallback_capital"] = True

        self.cache.put_zenith_response(
            cache_key=cache_key,
            lat=payload["earth"]["lat"],
            lon=payload["earth"]["lon"],
            payload=payload,
            city_slug=city_slug,
        )
        if prewarm_patch and (
            is_fallback or city_slug is not None or find_matching_capital_city(lat, lon) is not None
        ):
            self.get_sky_patch(
                ra=payload["zenith_icrs"]["ra"],
                dec=payload["zenith_icrs"]["dec"],
                fov=5.0,
            )
        return payload

    async def get_earth_to_sky_async(
        self,
        lat: float | None = None,
        lon: float | None = None,
        iso_time: str | None = None,
        fallback_seed: int | None = None,
        prewarm_patch: bool = True,
        timeout_s: float = 24.0,
    ) -> dict[str, Any]:
        """Offload Earth-to-Sky zenith lookup off the ASGI event loop."""
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(
                    self.get_earth_to_sky,
                    lat=lat,
                    lon=lon,
                    iso_time=iso_time,
                    fallback_seed=fallback_seed,
                    prewarm_patch=prewarm_patch,
                ),
                timeout=timeout_s,
            )
        except TimeoutError:
            _logger.warning(
                "Earth-to-Sky prewarm exceeded %.1fs; returning zenith coordinates without prewarm",
                timeout_s,
            )
            return await asyncio.to_thread(
                self.get_earth_to_sky,
                lat=lat,
                lon=lon,
                iso_time=iso_time,
                fallback_seed=fallback_seed,
                prewarm_patch=False,
            )

    def _apply_cached_pipeline_sync(
        self,
        manifest: dict[str, Any],
        ra: float,
        dec: float,
        fov: float,
    ) -> dict[str, Any]:
        """Merge cached SIMBAD/Gaia/Horizons overlays into ``manifest`` synchronously."""
        pipeline_result = self.catalog_pipeline.resolve_cached_patch_objects(
            ra_deg=ra,
            dec_deg=dec,
            fov_arcmin=fov,
            wcs=manifest["wcs"],
            epochs_meta=manifest["epochs"],
        )
        return merge_pipeline_overlays(
            manifest,
            pipeline_result,
            prefer_pipeline_when_uncached=bool(pipeline_result.get("known_objects")),
        )

    def get_catalogs(
        self,
        ra: float,
        dec: float,
        fov: float = 5.0,
    ) -> dict[str, Any]:
        """Synchronously resolve cached catalog overlays for a sky patch.

        Args:
            ra: Field center Right Ascension in degrees.
            dec: Field center Declination in degrees.
            fov: Field of view in arcminutes.

        Returns:
            Schema-validated ``CatalogsResponse`` dictionary.
        """
        grid_key, _, _ = compute_grid_key(ra, dec, fov)
        cached_catalogs = self.cache.get_catalogs(grid_key)
        if cached_catalogs is not None:
            validate_catalogs_response(cached_catalogs)
            return cached_catalogs

        manifest = build_sky_patch_manifest_payload(ra=ra, dec=dec, fov_arcmin=fov)
        manifest = self._apply_cached_pipeline_sync(manifest, ra=ra, dec=dec, fov=fov)
        response = {
            "query": manifest["query"],
            "wcs": manifest["wcs"],
            "catalog_overlays": manifest["catalog_overlays"],
        }
        validate_catalogs_response(response)
        return response

    async def _run_singleflight(
        self,
        key: str,
        coro_factory: Callable[[], Awaitable[Any]],
    ) -> Any:
        """Coalesce concurrent async requests sharing ``key`` onto a single future."""
        loop = asyncio.get_running_loop()
        existing = self._inflight_tasks.get(key)
        if existing is not None and not existing.done() and existing.get_loop() is loop:
            _logger.info("Single-flight coalescing hit for %s", key)
            return await asyncio.shield(existing)

        fut: asyncio.Future[Any] = loop.create_future()
        self._inflight_tasks[key] = fut
        try:
            result = await coro_factory()
            if not fut.done():
                fut.set_result(result)
            return result
        except BaseException as exc:
            if not fut.done():
                fut.set_exception(exc)
            raise
        finally:
            if self._inflight_tasks.get(key) is fut:
                self._inflight_tasks.pop(key, None)

    @staticmethod
    def _is_pending_archival_demo(manifest: dict[str, Any] | None) -> bool:
        """Return True if ``manifest`` is a placeholder simulated patch awaiting archival fetch."""
        if not manifest:
            return False
        summary = manifest.get("data_source_summary", {})
        note = str(summary.get("status_note", ""))
        return (
            note == "2 SPHEREx survey passes (6-month baseline)"
            or "archival lookup pending" in note.lower()
        )

    async def get_catalogs_async(
        self,
        ra: float,
        dec: float,
        fov: float = 5.0,
        live_catalogs: bool = True,
    ) -> dict[str, Any]:
        """Asynchronously resolve catalog overlays with single-flight coalescing.

        Args:
            ra: Field center Right Ascension in degrees.
            dec: Field center Declination in degrees.
            fov: Field of view in arcminutes.
            live_catalogs: Whether live SIMBAD/Gaia queries are allowed on cache miss.

        Returns:
            Schema-validated ``CatalogsResponse`` dictionary.
        """
        grid_key, _, _ = compute_grid_key(ra, dec, fov)
        cached_catalogs = self.cache.get_catalogs(grid_key)
        if cached_catalogs is not None:
            _logger.info("Catalogs cache hit for %s", grid_key)
            validate_catalogs_response(cached_catalogs)
            return cached_catalogs

        async def _build_catalogs() -> dict[str, Any]:
            cached_again = self.cache.get_catalogs(grid_key)
            if cached_again is not None:
                validate_catalogs_response(cached_again)
                return cached_again
            manifest = build_sky_patch_manifest_payload(ra=ra, dec=dec, fov_arcmin=fov)
            pipeline_result = await self._run_singleflight(
                f"catalog_pipeline:{grid_key}:live{int(live_catalogs)}",
                lambda: self.catalog_pipeline.resolve_patch_objects(
                    ra_deg=ra,
                    dec_deg=dec,
                    fov_arcmin=fov,
                    wcs=manifest["wcs"],
                    epochs_meta=manifest["epochs"],
                    allow_live=live_catalogs,
                ),
            )
            merged = merge_pipeline_overlays(
                manifest,
                pipeline_result,
                prefer_pipeline_when_uncached=bool(pipeline_result.get("known_objects")),
            )
            response = {
                "query": merged["query"],
                "wcs": merged["wcs"],
                "catalog_overlays": merged["catalog_overlays"],
            }
            validate_catalogs_response(response)
            return response

        return await self._run_singleflight(
            f"catalogs:{grid_key}:live{int(live_catalogs)}",
            _build_catalogs,
        )

    def get_sky_patch(
        self,
        ra: float,
        dec: float,
        fov: float = 5.0,
    ) -> dict[str, Any]:
        """Synchronously resolve, validate, and cache a sky-patch manifest and frames.

        Args:
            ra: Field center Right Ascension in degrees.
            dec: Field center Declination in degrees.
            fov: Field of view in arcminutes.

        Returns:
            Validated ``SkyPatchManifest`` dictionary.
        """
        grid_key, ra_q, dec_q = compute_grid_key(ra, dec, fov)
        cached_manifest = self.cache.get_manifest(grid_key)
        if cached_manifest is not None:
            is_legacy_demo = self._is_pending_archival_demo(cached_manifest)
            if not (self.enable_archival_data and is_legacy_demo):
                validate_sky_patch_manifest(cached_manifest)
                return cached_manifest

        manifest = build_sky_patch_manifest_payload(ra=ra, dec=dec, fov_arcmin=fov)
        manifest = self._apply_cached_pipeline_sync(manifest, ra=ra, dec=dec, fov=fov)
        slug = manifest["target_metadata"]["slug"]
        if slug in SHOWCASE_TARGETS:
            self.cache.pin_grid_key(grid_key)
        frames = generate_synthetic_epoch_frames(slug=slug, manifest=manifest)

        if self.enable_archival_data:
            manifest, frames = self.archival_resolver.resolve_archival_patch_sync(
                manifest=manifest,
                grid_key=grid_key,
                ra=ra,
                dec=dec,
                fov=fov,
                fallback_frames=frames,
            )
            manifest = self._apply_cached_pipeline_sync(manifest, ra=ra, dec=dec, fov=fov)
            manifest, frames = apply_solar_system_ephemeris_to_frames(manifest, frames)

        validate_sky_patch_manifest(manifest)
        self.cache.put_sky_patch(
            grid_key=grid_key,
            ra_center=ra_q,
            dec_center=dec_q,
            fov_arcmin=fov,
            manifest=manifest,
            frames=frames,
        )
        return manifest

    async def get_sky_patch_async(
        self,
        ra: float,
        dec: float,
        fov: float = 5.0,
        live_catalogs: bool = True,
    ) -> dict[str, Any]:
        """Asynchronously resolve, validate, and cache a sky-patch manifest and frames.

        Args:
            ra: Field center Right Ascension in degrees.
            dec: Field center Declination in degrees.
            fov: Field of view in arcminutes.
            live_catalogs: Whether live SIMBAD/Gaia queries are allowed on cache miss.

        Returns:
            Validated ``SkyPatchManifest`` dictionary.
        """
        t0 = time.perf_counter()
        grid_key, ra_q, dec_q = compute_grid_key(ra, dec, fov)
        cached_manifest = self.cache.get_manifest(grid_key)
        if cached_manifest is not None:
            is_legacy_demo = self._is_pending_archival_demo(cached_manifest)
            if not (self.enable_archival_data and is_legacy_demo):
                _logger.info("Sky patch cache hit for %s", grid_key)
                validate_sky_patch_manifest(cached_manifest)
                return cached_manifest

        async def _compute_patch() -> dict[str, Any]:
            base_manifest = build_sky_patch_manifest_payload(ra=ra, dec=dec, fov_arcmin=fov)
            slug = base_manifest["target_metadata"]["slug"]
            if slug in SHOWCASE_TARGETS:
                self.cache.pin_grid_key(grid_key)
            synthetic_frames = generate_synthetic_epoch_frames(slug=slug, manifest=base_manifest)

            catalog_coro = self._run_singleflight(
                f"catalog_pipeline:{grid_key}:live{int(live_catalogs)}",
                lambda: self.catalog_pipeline.resolve_patch_objects(
                    ra_deg=ra,
                    dec_deg=dec,
                    fov_arcmin=fov,
                    wcs=base_manifest["wcs"],
                    epochs_meta=base_manifest["epochs"],
                    allow_live=live_catalogs,
                ),
            )

            if self.enable_archival_data:
                archival_timeout_s = _env_float("ARCHIVAL_RESOLVE_BUDGET_S", 18.0) + 6.0

                async def _resolve_archival_bounded() -> tuple[dict[str, Any], dict[str, bytes]]:
                    try:
                        return await asyncio.wait_for(
                            asyncio.to_thread(
                                self.archival_resolver.resolve_archival_patch_sync,
                                manifest=base_manifest,
                                grid_key=grid_key,
                                ra=ra,
                                dec=dec,
                                fov=fov,
                                fallback_frames=synthetic_frames,
                            ),
                            timeout=archival_timeout_s,
                        )
                    except TimeoutError:
                        _logger.warning(
                            "Archival resolution for %s exceeded %.1fs; "
                            "serving labeled simulated baseline",
                            grid_key,
                            archival_timeout_s,
                        )
                        timed_out_manifest = dict(base_manifest)
                        timed_out_manifest["data_source_summary"] = {
                            "primary_mission": "Simulated",
                            "has_multi_epoch_spherex": False,
                            "uses_wise_fallback": False,
                            "baseline_days": float(
                                base_manifest["data_source_summary"].get("baseline_days", 182.7)
                            ),
                            "status_note": (
                                f"Archival retrieval timed out after {archival_timeout_s:.0f}s; "
                                "simulated baseline"
                            ),
                            "provenance_tier": "simulated",
                            "survey_name": "Simulated Multi-Band Baseline",
                        }
                        return timed_out_manifest, dict(synthetic_frames)

                pipeline_result, (resolved_manifest, frames) = await asyncio.gather(
                    catalog_coro, _resolve_archival_bounded()
                )
            else:
                pipeline_result = await catalog_coro
                resolved_manifest = base_manifest
                frames = synthetic_frames

            epoch_ids_before = [e["epoch_id"] for e in base_manifest["epochs"]]
            epoch_ids_after = [e["epoch_id"] for e in resolved_manifest["epochs"]]
            if epoch_ids_after != epoch_ids_before:
                realigned = self.catalog_pipeline.resolve_cached_patch_objects(
                    ra_deg=ra,
                    dec_deg=dec,
                    fov_arcmin=fov,
                    wcs=resolved_manifest["wcs"],
                    epochs_meta=resolved_manifest["epochs"],
                )
                if realigned.get("known_objects"):
                    pipeline_result = realigned

            merged_manifest = merge_pipeline_overlays(
                resolved_manifest,
                pipeline_result,
                prefer_pipeline_when_uncached=bool(pipeline_result.get("known_objects")),
            )
            if self.enable_archival_data:
                merged_manifest, frames = apply_solar_system_ephemeris_to_frames(
                    merged_manifest, frames
                )

            self.cache.put_sky_patch(
                grid_key=grid_key,
                ra_center=ra_q,
                dec_center=dec_q,
                fov_arcmin=fov,
                manifest=merged_manifest,
                frames=frames,
            )
            validate_sky_patch_manifest(merged_manifest)
            _logger.info(
                "Sky patch %s assembled (mission=%s, tier=%s, epochs=%d, known=%d, note=%s) "
                "in %.2fs",
                grid_key,
                merged_manifest["data_source_summary"].get("primary_mission"),
                merged_manifest["data_source_summary"].get("provenance_tier"),
                len(merged_manifest.get("epochs", [])),
                len(merged_manifest["catalog_overlays"].get("known_objects", [])),
                merged_manifest["data_source_summary"].get("status_note", ""),
                time.perf_counter() - t0,
            )
            return merged_manifest

        return await self._run_singleflight(
            f"patch:{grid_key}:arch{int(self.enable_archival_data)}:live{int(live_catalogs)}",
            _compute_patch,
        )

    def get_solar_system_in_fov(
        self,
        ra: float,
        dec: float,
        fov: float = 5.0,
        mjd: float | None = None,
    ) -> dict[str, Any]:
        """Query cached Solar System ephemerides falling within the given field of view.

        Args:
            ra: Field center Right Ascension in degrees.
            dec: Field center Declination in degrees.
            fov: Field of view in arcminutes.
            mjd: Target Modified Julian Date (defaults to current UTC MJD).

        Returns:
            Dictionary containing matching ``bodies`` and ephemeris cache stats.
        """
        target_mjd = float(mjd) if mjd is not None else datetime_to_mjd()
        radius_deg = self.catalog_pipeline.fov_to_radius_deg(fov)
        matches = self.cache.query_ephemeris_in_fov(
            mjd=target_mjd,
            ra=ra,
            dec=dec,
            radius_deg=radius_deg,
        )
        return {
            "ra": round(float(ra), 5),
            "dec": round(float(dec), 5),
            "fov_arcmin": float(fov),
            "radius_deg": round(radius_deg, 4),
            "mjd": round(target_mjd, 6),
            "count": len(matches),
            "bodies": matches,
            "ephemeris_cache": self.cache.get_ephemeris_stats(),
        }

    async def lookup_most_object(self, obj_name: str) -> dict[str, Any]:
        """Query cached or live NASA/IPAC IRSA MOST intersections for a Solar System target.

        Args:
            obj_name: Target name or alias.

        Returns:
            Dictionary containing ``query_name``, ``status``, ``count``, and ``matches``.
        """
        cache_key = f"most:{obj_name.strip().lower()}"
        cached = self.cache.get_cached_catalog_region(cache_key, 0.0, 0.0, 1.0)
        if cached is not None:
            return {
                "query_name": cached.get("query_name", obj_name),
                "status": "cached",
                "count": len(cached.get("matches", [])),
                "matches": cached.get("matches", []),
            }
        result = await fetch_most_spherex_matches(
            obj_name=obj_name,
            client=self.catalog_pipeline.http_client,
        )
        if result["matches"]:
            self.cache.put_cached_catalog_region(
                cache_key,
                0.0,
                0.0,
                1.0,
                result,
                ttl_seconds=24 * 3600,
            )
        return {
            "query_name": result["query_name"],
            "status": result["status"],
            "count": len(result["matches"]),
            "matches": result["matches"],
        }

    def get_frame_bytes(
        self,
        grid_key: str,
        filename: str,
        precision: Literal["float32", "float16"] = "float32",
        accept_gzip: bool = False,
    ) -> tuple[bytes, dict[str, str]]:
        """Retrieve raw binary detector or flag bytes for a cached or synthetic frame.

        Args:
            grid_key: Quantized spatial grid identifier.
            filename: Binary frame filename (e.g. ``"pass_1.bin"``).
            precision: Output floating-point precision (``"float32"`` or ``"float16"``).
            accept_gzip: When True, serve pre-gzipped bytes with ``Content-Encoding: gzip``.

        Returns:
            Tuple of ``(body_bytes, response_headers)``.

        Raises:
            KeyError: If ``filename`` does not exist in cache or synthetic fallback.
        """
        if accept_gzip:
            cached_gz = self.cache.get_frame_gzip(grid_key, filename, precision=precision)
            if cached_gz is not None:
                gz_bytes, dtype_header = cached_gz
                return gz_bytes, {
                    "Cache-Control": "public, max-age=31536000, immutable",
                    "X-Binary-Dtype": dtype_header,
                    "Content-Type": "application/octet-stream",
                    "Content-Encoding": "gzip",
                    "Vary": "Accept-Encoding",
                }

        raw = self.cache.get_frame(grid_key, filename)
        if raw is None:
            cached_manifest = self.cache.get_manifest(grid_key)
            if cached_manifest is not None:
                frames = generate_synthetic_epoch_frames(
                    slug=cached_manifest["target_metadata"]["slug"],
                    manifest=cached_manifest,
                )
            else:
                frames = generate_synthetic_epoch_frames("wise_0855")
            if filename not in frames:
                raise KeyError(f"Frame not found: {grid_key}/{filename}")
            raw = frames[filename]

        is_flags = filename.endswith("_flags.bin")
        if is_flags:
            dtype_header = "uint8"
            body = raw
        elif precision == "float16":
            dtype_header = "float16"
            body = convert_float32_bytes_to_float16_bytes(raw)
        else:
            dtype_header = "float32"
            body = raw

        headers = {
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Binary-Dtype": dtype_header,
            "Content-Type": "application/octet-stream",
        }
        if accept_gzip:
            body = gzip.compress(body, compresslevel=6)
            headers["Content-Encoding"] = "gzip"
            headers["Vary"] = "Accept-Encoding"
        return body, headers

    def get_forced_spectrum(
        self,
        ra: float,
        dec: float,
        label: str | None = None,
    ) -> dict[str, Any]:
        """Ingest SPHEREx cutouts and measure a forced 102-band spectrum at ``(ra, dec)``.

        Args:
            ra: Target Right Ascension in degrees.
            dec: Target Declination in degrees.
            label: Optional human-readable target label; defaults to
                ``"Selected sky position"`` when omitted or blank.

        Returns:
            Validated 102-channel ``SpectrumPayload`` dictionary.
        """
        clean_label = label.strip() if label and label.strip() else None
        resolved_label = clean_label or "Selected sky position"
        spectrum_key = f"spec_forced_ra{round(ra, 4):.4f}_dec{round(dec, 4):.4f}"
        cached_spec = self.cache.get_spectrum(spectrum_key)
        if cached_spec is not None:
            cached_spec["source_label"] = resolved_label
            validate_spectrum_payload(cached_spec)
            return cached_spec

        try:
            cutouts = self.spherex_cutout_fetcher(
                ra=ra,
                dec=dec,
                fov_arcmin=5.0,
                allow_synthetic_fallback=True,
                max_cutouts=DEFAULT_MAX_SPECTRUM_CUTOUTS,
                budget_seconds=13.0,
            )
        except TypeError:
            cutouts = self.spherex_cutout_fetcher(
                ra=ra,
                dec=dec,
                fov_arcmin=5.0,
                allow_synthetic_fallback=True,
            )
        payload = self.spectrum_extractor(
            ra=ra,
            dec=dec,
            cutouts=cutouts,
            source_label=resolved_label,
        )
        self.cache.put_spectrum(spectrum_key=spectrum_key, ra=ra, dec=dec, payload=payload)
        return payload

    async def get_forced_spectrum_async(
        self,
        ra: float,
        dec: float,
        label: str | None = None,
        timeout_s: float = 20.0,
    ) -> dict[str, Any]:
        """Asynchronously compute/fetch a 102-band forced spectrum off the event loop."""
        clean_label = label.strip() if label and label.strip() else None
        resolved_label = clean_label or "Selected sky position"
        spectrum_key = f"spec_forced_ra{round(ra, 4):.4f}_dec{round(dec, 4):.4f}"
        cached_spec = self.cache.get_spectrum(spectrum_key)
        if cached_spec is not None:
            cached_spec["source_label"] = resolved_label
            validate_spectrum_payload(cached_spec)
            return cached_spec

        async def _compute() -> dict[str, Any]:
            return await asyncio.wait_for(
                asyncio.to_thread(
                    self.get_forced_spectrum,
                    ra=ra,
                    dec=dec,
                    label=resolved_label,
                ),
                timeout=timeout_s,
            )

        payload = await self._run_singleflight(f"spectrum:{spectrum_key}", _compute)
        if payload.get("source_label") != resolved_label:
            payload = dict(payload)
            payload["source_label"] = resolved_label
        return payload

    def get_spectrum(
        self,
        ra: float,
        dec: float,
        label: str | None = None,
    ) -> dict[str, Any]:
        """Return a cached or showcase-tailored 102-band spectrum at ``(ra, dec)``.

        Args:
            ra: Target Right Ascension in degrees.
            dec: Target Declination in degrees.
            label: Optional target label.

        Returns:
            Validated 102-channel ``SpectrumPayload`` dictionary.
        """
        spectrum_key = f"spec_ra{round(ra, 4):.4f}_dec{round(dec, 4):.4f}"
        cached_spec = self.cache.get_spectrum(spectrum_key)
        if cached_spec is not None:
            validate_spectrum_payload(cached_spec)
            return cached_spec

        resolved_label = label or "WISE 0855"
        resolved_slug: str | None = None
        for cand_slug, meta in SHOWCASE_TARGETS.items():
            if math.hypot(ra - meta["ra"], dec - meta["dec"]) < 0.25:
                resolved_label = meta["name"]
                resolved_slug = cand_slug
                break
        payload = build_spectrum_payload(
            ra=ra,
            dec=dec,
            source_label=resolved_label,
            slug=resolved_slug,
        )
        self.cache.put_spectrum(spectrum_key=spectrum_key, ra=ra, dec=dec, payload=payload)
        return payload
