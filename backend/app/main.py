"""FastAPI application factory and HTTP route definitions for Star Hunters."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, Header, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from app.services.backend_service import StarHuntersBackendService
from app.services.spectrum_extractor import SpectrumExtractionError


def create_app(service: StarHuntersBackendService | None = None) -> FastAPI:
    """Create and configure the Star Hunters FastAPI application.

    Args:
        service: Optional pre-configured :class:`StarHuntersBackendService`
            instance (useful for dependency-injected testing). When omitted, a
            default service backed by :class:`SpatialSqliteCache` is created.

    Returns:
        Configured :class:`fastapi.FastAPI` instance with API routes, middleware,
        lifespan cleanup, and optional built SPA static serving.
    """
    active_service = service or StarHuntersBackendService()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        """Manage SQLite connection pool cleanup on ASGI shutdown."""
        try:
            yield
        finally:
            active_service.cache.close()

    fastapi_app = FastAPI(
        title="Star Hunters API (Planet X & SPHEREx Blinker)",
        version="0.1.0",
        description="Multi-epoch SPHEREx + WISE/Gaia/MOST sky blinker & 102-band spectral API.",
        lifespan=lifespan,
    )
    fastapi_app.state.service = active_service
    fastapi_app.add_middleware(GZipMiddleware, minimum_size=512)
    fastapi_app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @fastapi_app.get("/health")
    async def health_check() -> dict[str, str]:
        """Return backend liveness status."""
        return active_service.health()

    @fastapi_app.get("/api/v1/earth-to-sky")
    @fastapi_app.get("/api/earth-to-sky")
    async def earth_to_sky(
        lat: float | None = Query(None),
        lon: float | None = Query(None),
        iso_time: str | None = Query(None),
        time: str | None = Query(None),
    ) -> dict[str, Any]:
        """Compute overhead ICRS zenith coordinates for an Earth location and UTC time.

        Args:
            lat: Observer latitude in degrees (falls back to random capital if omitted).
            lon: Observer longitude in degrees.
            iso_time: Primary ISO-8601 UTC observation timestamp.
            time: Optional alias fallback when ``iso_time`` is omitted.

        Returns:
            Validated ``EarthToSkyResponse`` dictionary.
        """
        resolved_time = iso_time or time
        try:
            return active_service.get_earth_to_sky(lat=lat, lon=lon, iso_time=resolved_time)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @fastapi_app.get("/api/v1/catalogs")
    @fastapi_app.get("/api/catalogs")
    async def get_catalogs(
        response: Response,
        ra: float = Query(..., ge=0.0, le=360.0),
        dec: float = Query(..., ge=-90.0, le=90.0),
        fov: float = Query(5.0, gt=0.0, le=60.0),
        live_catalogs: bool = Query(True),
    ) -> dict[str, Any]:
        """Return multi-catalog overlays (SIMBAD, Gaia DR3, Solar System) for a sky patch."""
        response.headers["Cache-Control"] = "public, max-age=3600"
        return await active_service.get_catalogs_async(
            ra=ra,
            dec=dec,
            fov=fov,
            live_catalogs=live_catalogs,
        )

    @fastapi_app.get("/api/v1/catalogs/search")
    @fastapi_app.get("/api/catalogs/search")
    async def search_catalog_objects(
        response: Response,
        q: str = Query("", description="Fuzzy search query for celestial object names/IDs"),
        limit: int = Query(30, ge=1, le=200),
    ) -> dict[str, Any]:
        """Fuzzy-search known celestial objects and refresh live Horizons ephemerides."""
        response.headers["Cache-Control"] = "public, max-age=3600"
        results = await active_service.search_known_objects_async(query=q, limit=limit)
        return {
            "query": q,
            "count": len(results),
            "results": results,
        }

    @fastapi_app.get("/api/v1/solar-system/in-fov")
    @fastapi_app.get("/api/solar-system/in-fov")
    async def solar_system_in_fov(
        ra: float = Query(..., ge=0.0, le=360.0),
        dec: float = Query(..., ge=-90.0, le=90.0),
        fov: float = Query(5.0, gt=0.0, le=60.0),
        mjd: float | None = Query(None),
    ) -> dict[str, Any]:
        """Query cached Solar System ephemerides falling within the requested FOV."""
        return active_service.get_solar_system_in_fov(ra=ra, dec=dec, fov=fov, mjd=mjd)

    @fastapi_app.get("/api/v1/solar-system/most")
    @fastapi_app.get("/api/solar-system/most")
    async def lookup_most_solar_system(
        response: Response,
        obj_name: str = Query(..., min_length=1),
    ) -> dict[str, Any]:
        """Query NASA/IPAC IRSA MOST for SPHEREx intersections with a Solar System body."""
        response.headers["Cache-Control"] = "public, max-age=3600"
        return await active_service.lookup_most_object(obj_name=obj_name)

    @fastapi_app.get("/api/v1/sky-patch")
    @fastapi_app.get("/api/sky-patch")
    async def get_sky_patch(
        response: Response,
        ra: float = Query(..., ge=0.0, le=360.0),
        dec: float = Query(..., ge=-90.0, le=90.0),
        fov: float = Query(5.0, gt=0.0, le=60.0),
        live_catalogs: bool = Query(True),
    ) -> dict[str, Any]:
        """Assemble or retrieve a cached multi-epoch ``SkyPatchManifest``."""
        response.headers["Cache-Control"] = "public, max-age=3600"
        return await active_service.get_sky_patch_async(
            ra=ra,
            dec=dec,
            fov=fov,
            live_catalogs=live_catalogs,
        )

    @fastapi_app.get("/api/v1/frames/{grid_key}/{filename}")
    @fastapi_app.get("/api/frames/{grid_key}/{filename}")
    async def get_binary_frame(
        grid_key: str,
        filename: str,
        precision: Literal["float32", "float16"] = Query("float32"),
    ) -> Response:
        """Stream a packed binary detector cube or uint8 hygiene mask."""
        try:
            body, headers = active_service.get_frame_bytes(
                grid_key=grid_key,
                filename=filename,
                precision=precision,
            )
            return Response(
                content=body,
                media_type="application/octet-stream",
                headers=headers,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @fastapi_app.get("/api/v1/spectrum")
    @fastapi_app.get("/api/spectrum")
    async def get_spectrum(
        response: Response,
        ra: float = Query(..., ge=0.0, le=360.0),
        dec: float = Query(..., ge=-90.0, le=90.0),
        label: str | None = Query(None),
    ) -> dict[str, Any]:
        """Extract or retrieve a 102-channel SPHEREx spectrum at ``(ra, dec)``.

        Args:
            response: FastAPI response object for cache-control headers.
            ra: Target Right Ascension in degrees.
            dec: Target Declination in degrees.
            label: Optional target label forwarded as ``source_label``.

        Returns:
            Validated 102-channel ``SpectrumPayload`` dictionary.
        """
        response.headers["Cache-Control"] = "public, max-age=3600"
        try:
            return active_service.get_forced_spectrum(ra=ra, dec=dec, label=label)
        except SpectrumExtractionError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(
                status_code=503, detail=f"SPHEREx spectrum unavailable: {exc}"
            ) from exc

    @fastapi_app.post("/api/v1/admin/clear-cache")
    async def clear_cache(
        x_admin_token: str | None = Header(None),
    ) -> dict[str, str]:
        """Clear all SQLite spatial cache tables when authorized via ``X-Admin-Token``."""
        if x_admin_token != active_service.admin_token:
            raise HTTPException(status_code=403, detail="Invalid X-Admin-Token")
        active_service.cache.clear()
        return {"status": "cleared"}

    frontend_dist = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
    if frontend_dist.is_dir():
        fastapi_app.mount(
            "/",
            StaticFiles(directory=str(frontend_dist), html=True),
            name="frontend_spa",
        )

    return fastapi_app


app = create_app()
