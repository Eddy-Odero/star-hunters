"""Automated multi-catalog celestial caching, classification, and epoch-propagation pipeline.

Integrates zero-auth machine APIs without using any ``cds.unistra.fr`` endpoints:
  1. SIMBAD TAP (IDIA primary, Harvard CfA fallback) — canonical names & object types
  2. ESA Gaia DR3 TAP (with ARI Heidelberg TAP & VizieR CfA TSV fallback) — astrometry & J2016.0 PM
  3. NASA/JPL Horizons REST API — planets, major moons, comets & asteroids
  4. NASA/IPAC IRSA MOST API (Brief/VOTable IPAC table) — SPHEREx moving-object intersections
"""

from __future__ import annotations

import asyncio
import math
import re
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

import httpx

from app.models.contracts import GRID_HEIGHT, GRID_WIDTH
from app.services.catalog_clients import (
    fetch_gaia_dr3_objects,
    fetch_horizons_ephemeris,
    fetch_simbad_objects,
)
from app.services.catalog_parsers import map_simbad_otype
from app.services.logging_config import get_logger
from app.services.spatial_cache import DEFAULT_CATALOG_TTL_SECONDS, SpatialSqliteCache
from app.utils.astronomy import (
    GAIA_DR3_REF_YEAR,
    angular_separation_deg,
    datetime_to_mjd,
    propagate_proper_motion,
    sky_to_pixel,
)

_logger = get_logger("celestial_pipeline")


def _compute_motion_vector(p_first: dict[str, Any], p_last: dict[str, Any]) -> dict[str, float]:
    """Compute pixel and sky motion deltas between the first and last epoch positions."""
    cos_dec = max(1e-4, math.cos(math.radians(float(p_first["dec"]))))
    dra_arcsec = (
        (((float(p_last["ra"]) - float(p_first["ra"]) + 180.0) % 360.0) - 180.0) * 3600.0 * cos_dec
    )
    ddec_arcsec = (float(p_last["dec"]) - float(p_first["dec"])) * 3600.0
    return {
        "dx_px": round(float(p_last["x"]) - float(p_first["x"]), 2),
        "dy_px": round(float(p_last["y"]) - float(p_first["y"]), 2),
        "dra_arcsec": round(dra_arcsec, 3),
        "ddec_arcsec": round(ddec_arcsec, 3),
    }


def _build_propagated_epoch_positions(
    base_ra: float,
    base_dec: float,
    pmra: float | None,
    pmdec: float | None,
    epochs_meta: list[dict[str, Any]],
    wcs: dict[str, Any],
    is_gaia_epoch: bool,
) -> list[dict[str, Any]]:
    """Propagate ``(base_ra, base_dec)`` via proper motion onto each epoch's MJD and WCS pixel."""
    ref_year = GAIA_DR3_REF_YEAR if is_gaia_epoch else 2000.0
    out: list[dict[str, Any]] = []
    for ep in epochs_meta:
        mjd = float(ep["mjd"])
        ra_ep, dec_ep = propagate_proper_motion(
            ra_deg=base_ra,
            dec_deg=base_dec,
            pmra_mas_yr=pmra,
            pmdec_mas_yr=pmdec,
            target_mjd=mjd,
            ref_year=ref_year,
        )
        px, py = sky_to_pixel(ra_ep, dec_ep, wcs)
        out.append(
            {
                "epoch_id": ep["epoch_id"],
                "mjd": mjd,
                "ra": ra_ep,
                "dec": dec_ep,
                "x": px,
                "y": py,
            }
        )
    return out


def _build_known_object_entry(
    *,
    object_id: str,
    label: str,
    catalog: str,
    object_type: str,
    object_class: str,
    canonical_name: str,
    otype: str | None,
    ep_pos_list: list[dict[str, Any]],
    g_mag: float | None,
    pmra: float | None,
    pmdec: float | None,
    parallax: float | None,
    pm_total: float | None,
    default_checked: bool,
    data_source: str,
    gaia_source_id: str | None = None,
    default_gaia_mag: float = 15.0,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Build a unified ``KnownCelestialObject`` entry and optional Gaia DR3 overlay record."""
    p0 = ep_pos_list[0]
    p_last = ep_pos_list[-1]
    known_entry = {
        "object_id": object_id,
        "label": label,
        "catalog": catalog,
        "object_type": object_type,
        "object_class": object_class,
        "canonical_name": canonical_name,
        "otype": otype,
        "ra": p0["ra"],
        "dec": p0["dec"],
        "x": p0["x"],
        "y": p0["y"],
        "magnitude": round(float(g_mag), 3) if g_mag is not None else None,
        "proper_motion_arcsec_yr": pm_total,
        "pmra_mas_yr": round(float(pmra), 3) if pmra is not None else None,
        "pmdec_mas_yr": round(float(pmdec), 3) if pmdec is not None else None,
        "parallax_mas": round(float(parallax), 3) if parallax is not None else None,
        "w1_w2_color": None,
        "default_checked": default_checked,
        "epoch_positions": ep_pos_list,
        "motion_vector": _compute_motion_vector(p0, p_last),
        "data_source": data_source,
    }
    gaia_entry: dict[str, Any] | None = None
    if gaia_source_id is not None:
        gaia_entry = {
            "source_id": gaia_source_id,
            "ra": p0["ra"],
            "dec": p0["dec"],
            "x": p0["x"],
            "y": p0["y"],
            "g_mag": float(g_mag) if g_mag is not None else default_gaia_mag,
            "bp_rp": None,
            "pmra": float(pmra) if pmra is not None else None,
            "pmdec": float(pmdec) if pmdec is not None else None,
        }
    return known_entry, gaia_entry


class AutomatedCelestialPipeline:
    """Cache-first orchestrator combining SIMBAD TAP, Gaia DR3, JPL Horizons, and IRSA MOST."""

    def __init__(
        self,
        cache: SpatialSqliteCache,
        http_client: httpx.AsyncClient | None = None,
        catalog_ttl_seconds: float = DEFAULT_CATALOG_TTL_SECONDS,
    ) -> None:
        """Initialize the celestial catalog pipeline.

        Args:
            cache: Quantized SQLite spatial cache instance.
            http_client: Optional shared :class:`httpx.AsyncClient` for live queries.
            catalog_ttl_seconds: TTL in seconds for cached catalog region responses.
        """
        self.cache = cache
        self.http_client = http_client
        self.catalog_ttl_seconds = catalog_ttl_seconds

    @asynccontextmanager
    async def _http_client_scope(
        self,
        client_override: httpx.AsyncClient | None = None,
    ) -> AsyncIterator[httpx.AsyncClient]:
        """Yield an injected ``httpx.AsyncClient`` or a short-lived fallback client.

        Args:
            client_override: Optional caller-supplied client taking precedence
                over ``self.http_client``.

        Yields:
            Active :class:`httpx.AsyncClient` instance; transient clients are
            closed automatically on exit.
        """
        active = client_override or self.http_client
        if active is not None:
            yield active
            return
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(12.0, connect=5.0),
            follow_redirects=True,
        ) as transient_client:
            yield transient_client

    def _read_cached_region_sync(
        self,
        source: str,
        ra_deg: float,
        dec_deg: float,
        radius_deg: float,
        allow_stale: bool = False,
    ) -> tuple[list[dict[str, Any]], str] | None:
        """Read a cached SIMBAD or Gaia region from SQLite."""
        cached = self.cache.get_cached_catalog_region(
            source, ra_deg, dec_deg, radius_deg, allow_stale=allow_stale
        )
        if cached is None:
            return None
        prefix = "stale" if cached.get("stale") else "cached"
        return list(cached.get("objects", [])), f"{prefix}:{cached.get('provider', source)}"

    async def _get_region(
        self,
        source: str,
        fetcher: Any,
        ra_deg: float,
        dec_deg: float,
        radius_deg: float,
        allow_live: bool = True,
        client: httpx.AsyncClient | None = None,
    ) -> tuple[list[dict[str, Any]], str]:
        """Resolve a catalog region cache-first, falling back to live fetch and stale rows.

        Args:
            source: Catalog source key (e.g. ``"simbad"`` or ``"gaia_dr3"``).
            fetcher: Async catalog query coroutine matching ``fetch_simbad_objects``.
            ra_deg: Cone-search center Right Ascension in degrees.
            dec_deg: Cone-search center Declination in degrees.
            radius_deg: Cone-search radius in degrees.
            allow_live: Whether live upstream queries are permitted on cache miss.
            client: Optional shared :class:`httpx.AsyncClient` override.

        Returns:
            Tuple of ``(records, status_tag)``.
        """
        hit = self._read_cached_region_sync(source, ra_deg, dec_deg, radius_deg, allow_stale=False)
        if hit is not None:
            return hit
        if not allow_live:
            stale = self._read_cached_region_sync(
                source, ra_deg, dec_deg, radius_deg, allow_stale=True
            )
            return stale if stale is not None else ([], "cache_only")

        t0 = time.perf_counter()
        async with self._http_client_scope(client) as active_client:
            try:
                records, provider = await fetcher(
                    ra_deg=ra_deg,
                    dec_deg=dec_deg,
                    radius_deg=radius_deg,
                    client=active_client,
                    parallel_mirrors=True,
                )
            except TypeError:
                records, provider = await fetcher(
                    ra_deg=ra_deg,
                    dec_deg=dec_deg,
                    radius_deg=radius_deg,
                    client=active_client,
                )
        _logger.info(
            "Catalog %s query at (%.4f, %.4f) returned %d row(s) via %s in %.2fs",
            source,
            ra_deg,
            dec_deg,
            len(records),
            provider,
            time.perf_counter() - t0,
        )
        if records:
            self.cache.put_cached_catalog_region(
                source,
                ra_deg,
                dec_deg,
                radius_deg,
                {"provider": provider, "objects": records},
                ttl_seconds=self.catalog_ttl_seconds,
            )
            return records, f"live:{provider}"

        stale = self._read_cached_region_sync(source, ra_deg, dec_deg, radius_deg, allow_stale=True)
        return stale if stale is not None else ([], provider)

    async def resolve_live_horizons_for_body(
        self,
        body_spec: dict[str, str],
        target_date: datetime | None = None,
    ) -> dict[str, Any] | None:
        """Fetch and cache live JPL Horizons ephemeris around the active observation window.

        Args:
            body_spec: Entry from :data:`HORIZONS_FEATURED_BODIES`.
            target_date: Optional UTC reference datetime (defaults to current UTC time).

        Returns:
            Interpolated or closest ephemeris dictionary, or ``None`` if unavailable.
        """
        from datetime import UTC, timedelta

        now_dt = target_date or datetime.now(UTC)
        now_mjd = datetime_to_mjd(now_dt)
        cached = self.cache.get_ephemeris_for_body(body_spec["naif_id"], now_mjd)
        if cached is not None:
            return cached
        start_str = (now_dt.date() - timedelta(days=3)).isoformat()
        stop_str = (now_dt.date() + timedelta(days=3)).isoformat()
        async with self._http_client_scope() as active_client:
            points = await fetch_horizons_ephemeris(
                naif_cmd=body_spec["cmd"],
                naif_id=body_spec["naif_id"],
                body_name=body_spec["name"],
                body_class=body_spec["body_class"],
                start_date=start_str,
                stop_date=stop_str,
                step_size="1d",
                client=active_client,
            )
        if not points:
            return None
        self.cache.upsert_ephemeris_points(points)
        closest = min(points, key=lambda pt: abs(float(pt["mjd"]) - now_mjd))
        _logger.info(
            "JPL Horizons resolved live ephemeris for %s (NAIF %s) at RA=%.4f Dec=%.4f",
            body_spec["name"],
            body_spec["naif_id"],
            closest["ra"],
            closest["dec"],
        )
        return closest

    async def get_simbad_region(
        self,
        ra_deg: float,
        dec_deg: float,
        radius_deg: float,
        allow_live: bool = True,
        client: httpx.AsyncClient | None = None,
    ) -> tuple[list[dict[str, Any]], str]:
        """Fetch cached or live SIMBAD objects within a cone-search region.

        Args:
            ra_deg: Cone-search center Right Ascension in degrees.
            dec_deg: Cone-search center Declination in degrees.
            radius_deg: Cone-search radius in degrees.
            allow_live: Whether live upstream SIMBAD TAP queries are permitted.
            client: Optional shared :class:`httpx.AsyncClient` override.

        Returns:
            Tuple of ``(simbad_records, status_tag)``.
        """
        return await self._get_region(
            "simbad",
            fetch_simbad_objects,
            ra_deg,
            dec_deg,
            radius_deg,
            allow_live=allow_live,
            client=client,
        )

    async def get_gaia_region(
        self,
        ra_deg: float,
        dec_deg: float,
        radius_deg: float,
        allow_live: bool = True,
        client: httpx.AsyncClient | None = None,
    ) -> tuple[list[dict[str, Any]], str]:
        """Fetch cached or live Gaia DR3 sources within a cone-search region.

        Args:
            ra_deg: Cone-search center Right Ascension in degrees.
            dec_deg: Cone-search center Declination in degrees.
            radius_deg: Cone-search radius in degrees.
            allow_live: Whether live upstream Gaia DR3 TAP/VizieR queries are permitted.
            client: Optional shared :class:`httpx.AsyncClient` override.

        Returns:
            Tuple of ``(gaia_records, status_tag)``.
        """
        return await self._get_region(
            "gaia_dr3",
            fetch_gaia_dr3_objects,
            ra_deg,
            dec_deg,
            radius_deg,
            allow_live=allow_live,
            client=client,
        )

    @staticmethod
    def fov_to_radius_deg(fov_arcmin: float) -> float:
        """Convert field of view in arcminutes to a bounded cone-search radius in degrees."""
        return max(0.06, min(0.5, (float(fov_arcmin) / 60.0) * 0.75))

    def resolve_cached_patch_objects(
        self,
        ra_deg: float,
        dec_deg: float,
        fov_arcmin: float,
        wcs: dict[str, Any],
        epochs_meta: list[dict[str, Any]],
        max_objects: int = 120,
    ) -> dict[str, Any]:
        """Synchronously resolve SQLite-cached SIMBAD/Gaia regions and Solar System ephemerides.

        Args:
            ra_deg: Field center Right Ascension in degrees.
            dec_deg: Field center Declination in degrees.
            fov_arcmin: Field of view in arcminutes.
            wcs: Patch contract WCS dictionary.
            epochs_meta: List of epoch metadata dictionaries.
            max_objects: Maximum number of known objects to assemble.

        Returns:
            Dictionary containing ``known_objects``, ``gaia_dr3``,
            ``most_solar_system``, and ``source_status``.
        """
        radius_deg = self.fov_to_radius_deg(fov_arcmin)
        simbad_hit = self._read_cached_region_sync(
            "simbad", ra_deg, dec_deg, radius_deg, allow_stale=True
        )
        gaia_hit = self._read_cached_region_sync(
            "gaia_dr3", ra_deg, dec_deg, radius_deg, allow_stale=True
        )
        simbad_rows, simbad_status = simbad_hit if simbad_hit is not None else ([], "cache_only")
        gaia_rows, gaia_status = gaia_hit if gaia_hit is not None else ([], "cache_only")
        return self.assemble_patch_objects(
            ra_deg=ra_deg,
            dec_deg=dec_deg,
            radius_deg=radius_deg,
            wcs=wcs,
            epochs_meta=epochs_meta,
            simbad_rows=simbad_rows,
            simbad_status=simbad_status,
            gaia_rows=gaia_rows,
            gaia_status=gaia_status,
            max_objects=max_objects,
        )

    async def resolve_patch_objects(
        self,
        ra_deg: float,
        dec_deg: float,
        fov_arcmin: float,
        wcs: dict[str, Any],
        epochs_meta: list[dict[str, Any]],
        allow_live: bool = True,
        max_objects: int = 120,
    ) -> dict[str, Any]:
        """Resolve cached or live SIMBAD, Gaia DR3, and SQLite Solar System ephemerides.

        Args:
            ra_deg: Field center Right Ascension in degrees.
            dec_deg: Field center Declination in degrees.
            fov_arcmin: Field of view in arcminutes.
            wcs: Patch contract WCS dictionary.
            epochs_meta: List of epoch metadata dictionaries.
            allow_live: Whether live upstream catalog queries are permitted.
            max_objects: Maximum number of known objects to assemble.

        Returns:
            Dictionary containing ``known_objects``, ``gaia_dr3``,
            ``most_solar_system``, and ``source_status``.
        """
        radius_deg = self.fov_to_radius_deg(fov_arcmin)
        needs_transient_client = (
            allow_live
            and self.http_client is None
            and (
                self._read_cached_region_sync("simbad", ra_deg, dec_deg, radius_deg) is None
                or self._read_cached_region_sync("gaia_dr3", ra_deg, dec_deg, radius_deg) is None
            )
        )
        if needs_transient_client:
            async with self._http_client_scope() as active_client:
                (simbad_rows, simbad_status), (gaia_rows, gaia_status) = await asyncio.gather(
                    self.get_simbad_region(
                        ra_deg, dec_deg, radius_deg, allow_live=True, client=active_client
                    ),
                    self.get_gaia_region(
                        ra_deg, dec_deg, radius_deg, allow_live=True, client=active_client
                    ),
                )
        else:
            (simbad_rows, simbad_status), (gaia_rows, gaia_status) = await asyncio.gather(
                self.get_simbad_region(ra_deg, dec_deg, radius_deg, allow_live=allow_live),
                self.get_gaia_region(ra_deg, dec_deg, radius_deg, allow_live=allow_live),
            )
        return self.assemble_patch_objects(
            ra_deg=ra_deg,
            dec_deg=dec_deg,
            radius_deg=radius_deg,
            wcs=wcs,
            epochs_meta=epochs_meta,
            simbad_rows=simbad_rows,
            simbad_status=simbad_status,
            gaia_rows=gaia_rows,
            gaia_status=gaia_status,
            max_objects=max_objects,
        )

    def assemble_patch_objects(
        self,
        ra_deg: float,
        dec_deg: float,
        radius_deg: float,
        wcs: dict[str, Any],
        epochs_meta: list[dict[str, Any]],
        simbad_rows: list[dict[str, Any]],
        simbad_status: str,
        gaia_rows: list[dict[str, Any]],
        gaia_status: str,
        max_objects: int = 120,
    ) -> dict[str, Any]:
        """Cross-match SIMBAD + Gaia DR3 and append Solar System bodies in FOV.

        Args:
            ra_deg: Field center Right Ascension in degrees.
            dec_deg: Field center Declination in degrees.
            radius_deg: Cone-search radius in degrees.
            wcs: Patch contract WCS dictionary.
            epochs_meta: List of epoch metadata dictionaries.
            simbad_rows: Normalized SIMBAD rows.
            simbad_status: SIMBAD source status string.
            gaia_rows: Normalized Gaia DR3 rows.
            gaia_status: Gaia DR3 source status string.
            max_objects: Maximum number of known objects to assemble.

        Returns:
            Dictionary containing ``known_objects``, ``gaia_dr3``,
            ``most_solar_system``, and ``source_status``.
        """
        solar_grouped: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = {}
        now_mjd = datetime_to_mjd()
        for ep_idx, ep in enumerate(epochs_meta):
            query_mjd = float(ep["mjd"])
            if query_mjd < 60000.0:
                query_mjd = now_mjd + (0.0 if ep_idx == 0 else 2.0)
            ep_matches = self.cache.query_ephemeris_in_fov(
                mjd=query_mjd,
                ra=ra_deg,
                dec=dec_deg,
                radius_deg=radius_deg,
            )
            for match in ep_matches:
                solar_grouped.setdefault(match["naif_id"], []).append((ep, match))

        known_objects: list[dict[str, Any]] = []
        gaia_overlay: list[dict[str, Any]] = []
        most_overlay: list[dict[str, Any]] = []

        # 1. Solar System bodies moving through the FOV
        for naif_id, ep_pairs in solar_grouped.items():
            ep_pos_list: list[dict[str, Any]] = []
            first_match = ep_pairs[0][1]
            for ep, match in ep_pairs:
                px, py = sky_to_pixel(match["ra"], match["dec"], wcs)
                ep_pos_list.append(
                    {
                        "epoch_id": ep["epoch_id"],
                        "mjd": float(ep["mjd"]),
                        "ra": round(float(match["ra"]), 6),
                        "dec": round(float(match["dec"]), 6),
                        "x": px,
                        "y": py,
                    }
                )
                most_overlay.append(
                    {
                        "object_name": first_match["body_name"],
                        "epoch_id": ep["epoch_id"],
                        "ra": round(float(match["ra"]), 6),
                        "dec": round(float(match["dec"]), 6),
                        "x": px,
                        "y": py,
                        "v_mag": float(match["vmag"]) if match.get("vmag") is not None else 12.0,
                    }
                )
            p_first = ep_pos_list[0]
            p_last = ep_pos_list[-1]
            known_objects.append(
                {
                    "object_id": f"ephem:{naif_id}",
                    "label": first_match["body_name"],
                    "catalog": "jpl_horizons",
                    "object_type": "solar_system",
                    "object_class": first_match.get("body_class", "planet"),
                    "canonical_name": first_match["body_name"],
                    "otype": str(first_match.get("body_class", "SolarSystem")).title(),
                    "ra": p_first["ra"],
                    "dec": p_first["dec"],
                    "x": p_first["x"],
                    "y": p_first["y"],
                    "magnitude": first_match.get("vmag"),
                    "proper_motion_arcsec_yr": None,
                    "pmra_mas_yr": None,
                    "pmdec_mas_yr": None,
                    "parallax_mas": None,
                    "w1_w2_color": None,
                    "default_checked": True,
                    "epoch_positions": ep_pos_list,
                    "motion_vector": _compute_motion_vector(p_first, p_last),
                    "data_source": first_match.get("source", "jpl_horizons"),
                }
            )

        # 2. Cross-match SIMBAD + Gaia DR3 within 2.5 arcsec
        used_gaia_indices: set[int] = set()
        crossmatch_deg = 2.5 / 3600.0
        for s_row in simbad_rows:
            if len(known_objects) >= max_objects:
                break
            best_idx: int | None = None
            best_sep = crossmatch_deg
            for g_idx, g_row in enumerate(gaia_rows):
                if g_idx in used_gaia_indices:
                    continue
                sep = angular_separation_deg(s_row["ra"], s_row["dec"], g_row["ra"], g_row["dec"])
                if sep <= best_sep:
                    best_sep = sep
                    best_idx = g_idx

            g_match = gaia_rows[best_idx] if best_idx is not None else None
            if best_idx is not None:
                used_gaia_indices.add(best_idx)

            base_ra = float(g_match["ra"]) if g_match is not None else float(s_row["ra"])
            base_dec = float(g_match["dec"]) if g_match is not None else float(s_row["dec"])
            pmra = (g_match.get("pmra") if g_match else None) or s_row.get("pmra")
            pmdec = (g_match.get("pmdec") if g_match else None) or s_row.get("pmdec")
            parallax = g_match.get("parallax") if g_match else None
            g_mag = g_match.get("phot_g_mean_mag") if g_match else None
            pm_total = (
                round(math.hypot(float(pmra or 0.0), float(pmdec or 0.0)) / 1000.0, 4)
                if (pmra is not None or pmdec is not None)
                else None
            )
            obj_class, legacy_type = map_simbad_otype(
                s_row.get("otype"), total_pm_arcsec_yr=pm_total
            )

            ep_pos_list = _build_propagated_epoch_positions(
                base_ra=base_ra,
                base_dec=base_dec,
                pmra=pmra,
                pmdec=pmdec,
                epochs_meta=epochs_meta,
                wcs=wcs,
                is_gaia_epoch=g_match is not None,
            )
            if not ep_pos_list:
                continue
            p0 = ep_pos_list[0]
            if not (
                -20.0 <= p0["x"] <= GRID_WIDTH + 20.0 and -20.0 <= p0["y"] <= GRID_HEIGHT + 20.0
            ):
                continue

            safe_id = re.sub(r"[^a-zA-Z0-9._:-]+", "_", s_row["main_id"]).strip("_")
            known_entry, gaia_entry = _build_known_object_entry(
                object_id=f"simbad:{safe_id}" if safe_id else f"simbad:{len(known_objects)}",
                label=s_row["main_id"],
                catalog="simbad",
                object_type=legacy_type,
                object_class=obj_class,
                canonical_name=s_row["main_id"],
                otype=s_row.get("otype"),
                ep_pos_list=ep_pos_list,
                g_mag=g_mag,
                pmra=pmra,
                pmdec=pmdec,
                parallax=parallax,
                pm_total=pm_total,
                default_checked=len(known_objects) < 4,
                data_source=str(s_row.get("provider", "simbad")),
                gaia_source_id=str(g_match["source_id"]) if g_match is not None else None,
                default_gaia_mag=15.0,
            )
            known_objects.append(known_entry)
            if gaia_entry is not None:
                gaia_overlay.append(gaia_entry)

        # 3. Remaining Gaia DR3 stars within the 256x256 FOV
        for g_idx, g_row in enumerate(gaia_rows):
            if g_idx in used_gaia_indices:
                continue
            if len(known_objects) >= max_objects:
                break
            pmra = g_row.get("pmra")
            pmdec = g_row.get("pmdec")
            parallax = g_row.get("parallax")
            g_mag = g_row.get("phot_g_mean_mag")
            pm_total = (
                round(math.hypot(float(pmra or 0.0), float(pmdec or 0.0)) / 1000.0, 4)
                if (pmra is not None or pmdec is not None)
                else None
            )
            ep_pos_list = _build_propagated_epoch_positions(
                base_ra=float(g_row["ra"]),
                base_dec=float(g_row["dec"]),
                pmra=pmra,
                pmdec=pmdec,
                epochs_meta=epochs_meta,
                wcs=wcs,
                is_gaia_epoch=True,
            )
            if not ep_pos_list:
                continue
            p0 = ep_pos_list[0]
            if not (0.0 <= p0["x"] <= float(GRID_WIDTH) and 0.0 <= p0["y"] <= float(GRID_HEIGHT)):
                continue

            sid = str(g_row["source_id"])
            is_high_pm = pm_total is not None and pm_total >= 0.15
            known_entry, gaia_entry = _build_known_object_entry(
                object_id=f"gaia:{sid}",
                label=f"Gaia DR3 {sid}",
                catalog="gaia_dr3",
                object_type="high_pm_star" if is_high_pm else "star",
                object_class="star",
                canonical_name=f"Gaia DR3 {sid}",
                otype="PM*" if is_high_pm else "*",
                ep_pos_list=ep_pos_list,
                g_mag=g_mag,
                pmra=pmra,
                pmdec=pmdec,
                parallax=parallax,
                pm_total=pm_total,
                default_checked=bool(is_high_pm),
                data_source=str(g_row.get("provider", "gaia_dr3")),
                gaia_source_id=sid,
                default_gaia_mag=16.0,
            )
            known_objects.append(known_entry)
            if gaia_entry is not None:
                gaia_overlay.append(gaia_entry)

        return {
            "known_objects": known_objects,
            "gaia_dr3": gaia_overlay,
            "most_solar_system": most_overlay,
            "source_status": {
                "simbad": simbad_status,
                "gaia_dr3": gaia_status,
                "horizons_ephemeris": "ok" if solar_grouped else "empty_in_fov",
            },
        }
