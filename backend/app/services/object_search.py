"""Global known-object index, fuzzy search, and live JPL Horizons coordinate refresh."""

from __future__ import annotations

import asyncio
import copy
from typing import Any

from app.models.contracts import SHOWCASE_TARGETS
from app.models.global_sky_reference_catalog import extend_global_known_objects_index
from app.services.catalog_clients import HORIZONS_FEATURED_BODIES
from app.services.celestial_catalog_pipeline import AutomatedCelestialPipeline
from app.services.logging_config import get_logger
from app.services.spatial_cache import SpatialSqliteCache
from app.services.synthetic_patch import build_sky_patch_manifest_payload
from app.services.zenith_bridge import lookup_constellation
from app.utils.astronomy import datetime_to_mjd

_logger = get_logger("object_search")
_GLOBAL_KNOWN_OBJECTS_INDEX: list[dict[str, Any]] = []


def fuzzy_score_text(query: str, candidate: str) -> float:
    """Compute a normalized ``[0.0, 1.0]`` fuzzy match score between query and candidate.

    Args:
        query: User search string.
        candidate: Candidate label or identifier string.

    Returns:
        Similarity score in ``[0.0, 1.0]``.
    """
    q = query.strip().lower()
    if not q:
        return 1.0
    c = candidate.strip().lower()
    if not c:
        return 0.0
    if q == c:
        return 1.0
    if c.startswith(q):
        return 0.96
    if q in c:
        return 0.90 - min(0.12, (c.index(q) / max(1, len(c))) * 0.12)

    q_tokens = [tok for tok in q.replace("-", " ").replace("_", " ").split() if tok]
    c_tokens = [tok for tok in c.replace("-", " ").replace("_", " ").split() if tok]
    if q_tokens and all(any(ct.startswith(qt) or qt in ct for ct in c_tokens) for qt in q_tokens):
        return 0.84

    q_idx = 0
    gaps = 0
    last_match = -1
    for idx, ch in enumerate(c):
        if q_idx < len(q) and ch == q[q_idx]:
            if last_match >= 0:
                gaps += idx - last_match - 1
            last_match = idx
            q_idx += 1
    if q_idx == len(q) and len(q) >= 3:
        return max(0.52, 0.78 - min(0.24, gaps * 0.02))

    best_token_score = 0.0
    for ct in c_tokens:
        if abs(len(ct) - len(q)) > 3:
            continue
        prev = list(range(len(ct) + 1))
        for i, qc in enumerate(q, start=1):
            curr = [i]
            for j, cc in enumerate(ct, start=1):
                cost = 0 if qc == cc else 1
                curr.append(min(curr[-1] + 1, prev[j] + 1, prev[j - 1] + cost))
            prev = curr
        dist = prev[-1]
        max_len = max(len(q), len(ct), 1)
        sim = 1.0 - (dist / max_len)
        if sim >= 0.65:
            best_token_score = max(best_token_score, sim * 0.74)
    return best_token_score


def get_global_known_objects_index() -> list[dict[str, Any]]:
    """Build or return the pre-warmed global index of showcase and all-sky celestial objects.

    Returns:
        List of known-object dictionaries enriched with showcase metadata.
    """
    if _GLOBAL_KNOWN_OBJECTS_INDEX:
        return _GLOBAL_KNOWN_OBJECTS_INDEX

    for slug, meta in SHOWCASE_TARGETS.items():
        manifest = build_sky_patch_manifest_payload(
            ra=meta["ra"],
            dec=meta["dec"],
            fov_arcmin=5.0,
            slug=slug,
        )
        for obj in manifest["catalog_overlays"]["known_objects"]:
            entry = dict(obj)
            entry["target_slug"] = slug
            entry["target_name"] = meta["name"]
            entry["constellation"] = meta["constellation"]
            entry["patch_ra"] = meta["ra"]
            entry["patch_dec"] = meta["dec"]
            _GLOBAL_KNOWN_OBJECTS_INDEX.append(entry)
    _GLOBAL_KNOWN_OBJECTS_INDEX[:] = extend_global_known_objects_index(_GLOBAL_KNOWN_OBJECTS_INDEX)
    return _GLOBAL_KNOWN_OBJECTS_INDEX


def _infer_object_class(obj: dict[str, Any]) -> str:
    """Map legacy ``object_type`` / ``label`` onto standardized celestial badge classes.

    Args:
        obj: Known celestial object dictionary.

    Returns:
        Standardized badge class string (e.g. ``"brown_dwarf"``, ``"comet"``, ``"star"``).
    """
    existing = obj.get("object_class")
    if isinstance(existing, str) and existing:
        return existing
    otype = str(obj.get("object_type", "star"))
    label_low = str(obj.get("label", "")).lower()
    if otype == "brown_dwarf_candidate":
        return "brown_dwarf"
    if otype == "solar_system":
        if "comet" in label_low or "3i" in label_low or "atlas" in label_low:
            return "comet"
        if any(a in label_low for a in ("ceres", "vesta", "apophis", "asteroid")):
            return "asteroid"
        if any(m in label_low for m in ("io", "europa", "ganymede", "callisto", "titan")):
            return "moon"
        return "planet"
    if otype in {"variable_star", "infrared_source"}:
        return otype
    return "star"


def search_known_objects(
    query: str = "",
    limit: int = 30,
) -> list[dict[str, Any]]:
    """Fuzzy-search known celestial objects across all indexed sky targets.

    Args:
        query: Search string matched against labels, IDs, types, and constellations.
        limit: Maximum number of results to return (clamped to ``[1, 200]``).

    Returns:
        Ranked list of matching known-object dictionaries.
    """
    index = get_global_known_objects_index()
    clean_q = query.strip()
    if not clean_q:
        sorted_default = sorted(
            index,
            key=lambda item: (
                0 if item.get("object_id", "").startswith("primary_") else 1,
                float(item.get("magnitude") or 20.0),
            ),
        )
        return copy.deepcopy(sorted_default[: max(1, min(limit, 200))])

    scored: list[tuple[float, int, float, dict[str, Any]]] = []
    for item in index:
        searchable_fields = [
            str(item.get("label", "")),
            str(item.get("object_id", "")),
            str(item.get("source_id", "")),
            str(item.get("object_type", "")),
            str(item.get("catalog", "")),
            str(item.get("target_name", "")),
            str(item.get("target_slug", "")),
            str(item.get("constellation", "")),
        ]
        best = max(fuzzy_score_text(clean_q, field) for field in searchable_fields if field)
        if best >= 0.45:
            is_primary = 0 if str(item.get("object_id", "")).startswith("primary_") else 1
            mag = float(item.get("magnitude") or 20.0)
            scored.append((best, -is_primary, -mag, item))

    scored.sort(key=lambda t: (t[0], t[1], t[2]), reverse=True)
    results: list[dict[str, Any]] = []
    for score, _, _, item in scored[: max(1, min(limit, 200))]:
        entry = copy.deepcopy(item)
        entry["match_score"] = round(score, 4)
        results.append(entry)
    return results


async def search_known_objects_async(
    query: str = "",
    limit: int = 30,
    *,
    cache: SpatialSqliteCache,
    catalog_pipeline: AutomatedCelestialPipeline,
    enable_archival_data: bool,
) -> list[dict[str, Any]]:
    """Fuzzy-search known objects and refresh live JPL Horizons coordinates for matches.

    Args:
        query: Search string.
        limit: Maximum number of results to return.
        cache: Quantized SQLite spatial cache for cached ephemeris lookups.
        catalog_pipeline: Celestial catalog pipeline used for live Horizons queries.
        enable_archival_data: Whether live upstream Horizons queries are permitted.

    Returns:
        Ranked list of matching known-object dictionaries with updated ephemeris
        coordinates where available.
    """
    results = search_known_objects(query=query, limit=limit)
    if not results:
        return results

    clean_q = query.strip().lower()
    body_by_naif = {spec["naif_id"]: spec for spec in HORIZONS_FEATURED_BODIES}
    now_mjd = datetime_to_mjd()

    async def _refresh_item(item: dict[str, Any]) -> dict[str, Any]:
        oid = str(item.get("object_id", ""))
        if not oid.startswith("horizons:"):
            return item
        naif_id = oid.split(":", 1)[1]
        spec = body_by_naif.get(naif_id)
        if spec is None:
            return item

        ephem_match = cache.get_ephemeris_for_body(naif_id, now_mjd)
        if ephem_match is None and clean_q and enable_archival_data:
            try:
                ephem_match = await catalog_pipeline.resolve_live_horizons_for_body(spec)
            except Exception:
                ephem_match = None
        if ephem_match is None:
            return item

        ra_live = round(float(ephem_match["ra"]), 5)
        dec_live = round(float(ephem_match["dec"]), 5)
        enriched = copy.deepcopy(item)
        enriched["ra"] = ra_live
        enriched["dec"] = dec_live
        enriched["patch_ra"] = round(ra_live, 4)
        enriched["patch_dec"] = round(dec_live, 4)
        enriched["constellation"] = lookup_constellation(ra_live, dec_live)
        if ephem_match.get("vmag") is not None:
            enriched["magnitude"] = round(float(ephem_match["vmag"]), 2)
        enriched["data_source"] = "jpl_horizons_live"
        _logger.debug(
            "Applied Horizons ephemeris for %s -> RA=%.4f Dec=%.4f",
            enriched.get("label"),
            ra_live,
            dec_live,
        )
        return enriched

    return list(await asyncio.gather(*(_refresh_item(item) for item in results)))
