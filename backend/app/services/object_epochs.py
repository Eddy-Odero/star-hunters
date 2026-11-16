"""Observation epoch resolution restricted to Current Time and SPHEREx passes."""

from __future__ import annotations

import asyncio
import json
import math
from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path
from typing import Any

from app.models.contracts import SHOWCASE_TARGETS
from app.services.catalog_clients import HORIZONS_FEATURED_BODIES
from app.services.celestial_catalog_pipeline import AutomatedCelestialPipeline
from app.services.spatial_cache import SpatialSqliteCache, compute_grid_key
from app.services.spherex_fits import SpherexObservation
from app.services.spherex_ingest import query_observations
from app.services.zenith_bridge import lookup_constellation
from app.utils.astronomy import datetime_to_mjd, mjd_to_iso

DEFAULT_MOST_PASS_GAP_DAYS = 15.0
DEFAULT_SPHEREX_PASS_GAP_DAYS = 60.0
DEFAULT_PRESETS_DIR = Path(__file__).resolve().parents[3] / "frontend" / "public" / "presets"


def resolve_horizons_body_spec(
    *,
    object_id: str = "",
    label: str = "",
    target_slug: str | None = None,
) -> dict[str, str] | None:
    """Match a searchable object onto a known ``HORIZONS_FEATURED_BODIES`` entry."""
    oid = object_id.strip()
    if oid.startswith("horizons:"):
        naif_id = oid.split(":", 1)[1].strip()
        for spec in HORIZONS_FEATURED_BODIES:
            if spec["naif_id"].lower() == naif_id.lower():
                return spec

    low_label = label.strip().lower()
    if target_slug == "comet_3i_atlas" or "3i/atlas" in low_label or "c/2025 n1" in low_label:
        return next((s for s in HORIZONS_FEATURED_BODIES if s["naif_id"] == "C/2025 N1"), None)
    if target_slug == "ceres_asteroid" or "ceres" in low_label:
        return next((s for s in HORIZONS_FEATURED_BODIES if s["naif_id"] == "1"), None)
    for spec in HORIZONS_FEATURED_BODIES:
        if (
            low_label == spec["name"].lower()
            or low_label == spec["most_name"].lower()
            or spec["name"].lower() in low_label
        ):
            return spec
    return None


def is_solar_system_object(
    *,
    object_id: str = "",
    label: str = "",
    object_type: str | None = None,
    object_class: str | None = None,
    target_slug: str | None = None,
) -> bool:
    """Return ``True`` when the object represents a moving Solar System body."""
    if object_id.startswith(("horizons:", "most:", "ephem:")):
        return True
    if object_type == "solar_system":
        return True
    if object_class in {"planet", "moon", "comet", "asteroid"}:
        return True
    if target_slug in {"comet_3i_atlas", "ceres_asteroid"}:
        return True
    return resolve_horizons_body_spec(object_id=object_id, label=label) is not None


def cluster_most_matches_into_passes(
    matches: Sequence[dict[str, Any]],
    gap_days: float = DEFAULT_MOST_PASS_GAP_DAYS,
) -> list[dict[str, Any]]:
    """Group IRSA MOST SPHEREx matches into chronological pass windows.

    Args:
        matches: Parsed MOST match dictionaries containing ``mjd_start``, ``ra``, ``dec``.
        gap_days: Minimum time gap (days) separating distinct SPHEREx passes.

    Returns:
        Chronological list of SPHEREx pass epoch descriptors using real median-MJD
        intersected sky coordinates.
    """
    valid: list[dict[str, Any]] = []
    for item in matches:
        try:
            mjd = float(item["mjd_start"])
            ra = float(item["ra"]) % 360.0
            dec = float(item["dec"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (math.isfinite(mjd) and math.isfinite(ra) and math.isfinite(dec)):
            continue
        if not -90.0 <= dec <= 90.0:
            continue
        valid.append({"mjd": mjd, "ra": ra, "dec": dec})

    if not valid:
        return []

    valid.sort(key=lambda row: row["mjd"])
    clusters: list[list[dict[str, Any]]] = [[valid[0]]]
    for row in valid[1:]:
        if row["mjd"] - clusters[-1][-1]["mjd"] > gap_days:
            clusters.append([row])
        else:
            clusters[-1].append(row)

    passes: list[dict[str, Any]] = []
    for idx, cluster in enumerate(clusters, start=1):
        rep = cluster[len(cluster) // 2]
        iso_date = mjd_to_iso(rep["mjd"])
        ra_val = round(float(rep["ra"]), 5)
        dec_val = round(float(rep["dec"]), 5)
        passes.append(
            {
                "epoch_key": f"spherex_pass_{idx}",
                "kind": "spherex_pass",
                "label": f"SPHEREx Pass {idx} · {iso_date[:10]}",
                "iso_date": iso_date,
                "mjd": round(float(rep["mjd"]), 5),
                "ra": ra_val,
                "dec": dec_val,
                "constellation": lookup_constellation(ra_val, dec_val),
                "source": "irsa_most_spherex",
                "exposure_count": len(cluster),
                "can_view_in_blinker": True,
                "note": f"{len(cluster)} SPHEREx archival exposure(s) intersect this object.",
            }
        )
    return passes


def cluster_spherex_obs_into_passes(
    observations: Sequence[SpherexObservation],
    *,
    ra: float,
    dec: float,
    gap_days: float = DEFAULT_SPHEREX_PASS_GAP_DAYS,
) -> list[dict[str, Any]]:
    """Cluster SPHEREx IRSA observation metadata into distinct pass dates."""
    valid = [
        obs for obs in observations if obs.mjd_obs is not None and math.isfinite(float(obs.mjd_obs))
    ]
    if not valid:
        return []

    valid.sort(key=lambda obs: float(obs.mjd_obs or 0.0))
    clusters: list[list[SpherexObservation]] = [[valid[0]]]
    for obs in valid[1:]:
        prev_mjd = float(clusters[-1][-1].mjd_obs or 0.0)
        curr_mjd = float(obs.mjd_obs or 0.0)
        if curr_mjd - prev_mjd > gap_days:
            clusters.append([obs])
        else:
            clusters[-1].append(obs)

    ra_val = round(float(ra) % 360.0, 5)
    dec_val = round(float(dec), 5)
    constellation = lookup_constellation(ra_val, dec_val)
    passes: list[dict[str, Any]] = []
    for idx, cluster in enumerate(clusters, start=1):
        rep = cluster[len(cluster) // 2]
        mjd = float(rep.mjd_obs or 0.0)
        iso_date = mjd_to_iso(mjd)
        passes.append(
            {
                "epoch_key": f"spherex_pass_{idx}",
                "kind": "spherex_pass",
                "label": f"SPHEREx Pass {idx} · {iso_date[:10]}",
                "iso_date": iso_date,
                "mjd": round(mjd, 5),
                "ra": ra_val,
                "dec": dec_val,
                "constellation": constellation,
                "source": "irsa_spherex_archive",
                "exposure_count": len(cluster),
                "can_view_in_blinker": True,
                "note": f"{len(cluster)} SPHEREx archival exposure(s) cover this sky patch.",
            }
        )
    return passes


def _passes_from_manifest(
    manifest: dict[str, Any],
    *,
    ra: float,
    dec: float,
    source: str,
) -> list[dict[str, Any]]:
    """Extract SPHEREx-only pass entries from a cached or preset manifest."""
    summary = manifest.get("data_source_summary") or {}
    if summary.get("provenance_tier") == "simulated":
        return []
    ra_val = round(float(ra) % 360.0, 5)
    dec_val = round(float(dec), 5)
    constellation = lookup_constellation(ra_val, dec_val)
    passes: list[dict[str, Any]] = []
    for ep in manifest.get("epochs", []):
        if ep.get("mission") != "SPHEREx":
            continue
        mjd = float(ep.get("mjd", 0.0))
        iso_date = str(ep.get("iso_date") or mjd_to_iso(mjd))
        idx = len(passes) + 1
        passes.append(
            {
                "epoch_key": f"spherex_pass_{idx}",
                "kind": "spherex_pass",
                "label": f"SPHEREx Pass {idx} · {iso_date[:10]}",
                "iso_date": iso_date,
                "mjd": round(mjd, 5),
                "ra": ra_val,
                "dec": dec_val,
                "constellation": constellation,
                "source": source,
                "exposure_count": 1,
                "can_view_in_blinker": True,
                "note": "Real SPHEREx archival pass available in Blinker.",
            }
        )
    return passes


def _load_preset_manifest(target_slug: str | None, presets_dir: Path) -> dict[str, Any] | None:
    """Read a static preset ``manifest.json`` when present on disk."""
    if not target_slug:
        return None
    safe_slug = Path(target_slug).name
    if safe_slug != target_slug:
        return None
    manifest_path = presets_dir / safe_slug / "manifest.json"
    if not manifest_path.is_file():
        return None
    try:
        return json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


async def resolve_object_observation_epochs(
    *,
    object_id: str,
    label: str,
    object_type: str | None,
    object_class: str | None,
    target_slug: str | None,
    ra: float | None,
    dec: float | None,
    cache: SpatialSqliteCache,
    catalog_pipeline: AutomatedCelestialPipeline,
    enable_archival_data: bool,
    lookup_most_fn: Callable[[str], Awaitable[dict[str, Any]]],
    query_observations_fn: Callable[..., list[SpherexObservation]] = query_observations,
    presets_dir: Path = DEFAULT_PRESETS_DIR,
) -> dict[str, Any]:
    """Resolve constrained observation epochs (Current Time + SPHEREx passes only)."""
    spec = resolve_horizons_body_spec(
        object_id=object_id,
        label=label,
        target_slug=target_slug,
    )
    solar_system = is_solar_system_object(
        object_id=object_id,
        label=label,
        object_type=object_type,
        object_class=object_class,
        target_slug=target_slug,
    )

    fallback_ra = float(ra) if ra is not None else 0.0
    fallback_dec = float(dec) if dec is not None else 0.0
    if ra is None or dec is None:
        if target_slug and target_slug in SHOWCASE_TARGETS:
            fallback_ra = float(SHOWCASE_TARGETS[target_slug]["ra"])
            fallback_dec = float(SHOWCASE_TARGETS[target_slug]["dec"])

    now_mjd = datetime_to_mjd()
    now_iso = mjd_to_iso(now_mjd)

    if solar_system:
        cur_ra = fallback_ra % 360.0
        cur_dec = fallback_dec
        cur_source = "catalog_reference"
        if spec is not None:
            ephem = cache.get_ephemeris_for_body(spec["naif_id"], now_mjd)
            if ephem is None and enable_archival_data:
                try:
                    ephem = await catalog_pipeline.resolve_live_horizons_for_body(spec)
                except Exception:  # noqa: BLE001
                    ephem = None
            if ephem is not None:
                cur_ra = round(float(ephem["ra"]) % 360.0, 5)
                cur_dec = round(float(ephem["dec"]), 5)
                cur_source = (
                    "jpl_horizons_cached"
                    if "seed" in str(ephem.get("source", "")).lower()
                    else "jpl_horizons_live"
                )
        current_entry = {
            "epoch_key": "current",
            "kind": "current",
            "label": f"Current Time (Now · {now_iso[:10]})",
            "iso_date": now_iso,
            "mjd": round(now_mjd, 5),
            "ra": round(cur_ra, 5),
            "dec": round(cur_dec, 5),
            "constellation": lookup_constellation(cur_ra, cur_dec),
            "source": cur_source,
            "exposure_count": None,
            "can_view_in_blinker": False,
            "note": (
                "Predicted current sky position (JPL Horizons). Background globe maps are "
                "archival; select a SPHEREx pass date to inspect telescope frames in Blinker."
            ),
        }

        most_query = spec["most_name"] if spec is not None else label
        pass_entries: list[dict[str, Any]] = []
        passes_status = "no_spherex_passes"
        try:
            most_res = await lookup_most_fn(most_query)
            pass_entries = cluster_most_matches_into_passes(most_res.get("matches", []))
            if pass_entries:
                passes_status = "ok"
            elif str(most_res.get("status", "")).startswith("unavailable:"):
                passes_status = "unavailable"
        except Exception:  # noqa: BLE001
            passes_status = "unavailable"

        return {
            "object_id": object_id,
            "label": label,
            "is_solar_system": True,
            "passes_status": passes_status,
            "epochs": [current_entry, *pass_entries],
        }

    cur_ra = round(fallback_ra % 360.0, 5)
    cur_dec = round(fallback_dec, 5)
    current_entry = {
        "epoch_key": "current",
        "kind": "current",
        "label": f"Current Time (Now · {now_iso[:10]})",
        "iso_date": now_iso,
        "mjd": round(now_mjd, 5),
        "ra": cur_ra,
        "dec": cur_dec,
        "constellation": lookup_constellation(cur_ra, cur_dec),
        "source": "catalog_reference",
        "exposure_count": None,
        "can_view_in_blinker": True,
        "note": (
            "Sky coordinates for this fixed/stellar target; Blinker displays archival "
            "multi-pass SPHEREx cutouts."
        ),
    }

    pass_entries = []
    preset_manifest = _load_preset_manifest(target_slug, presets_dir)
    if preset_manifest is not None:
        pass_entries = _passes_from_manifest(
            preset_manifest,
            ra=cur_ra,
            dec=cur_dec,
            source="preset_spherex_archive",
        )

    if not pass_entries:
        grid_key, _, _ = compute_grid_key(cur_ra, cur_dec, 5.0)
        cached_manifest = cache.get_manifest(grid_key)
        if cached_manifest is not None:
            pass_entries = _passes_from_manifest(
                cached_manifest,
                ra=cur_ra,
                dec=cur_dec,
                source="cached_spherex_archive",
            )

    passes_status = "ok" if pass_entries else "no_spherex_passes"
    if not pass_entries and enable_archival_data:
        grid_key, _, _ = compute_grid_key(cur_ra, cur_dec, 5.0)
        region_key = f"spherex_pass_dates:{grid_key}"
        cached_passes = cache.get_cached_catalog_region(region_key, cur_ra, cur_dec, 0.1)
        if cached_passes is not None and isinstance(cached_passes.get("passes"), list):
            pass_entries = list(cached_passes["passes"])
            passes_status = "ok" if pass_entries else "no_spherex_passes"
        else:
            try:
                obs = await asyncio.to_thread(query_observations_fn, cur_ra, cur_dec, 5.0)
                pass_entries = cluster_spherex_obs_into_passes(obs, ra=cur_ra, dec=cur_dec)
                passes_status = "ok" if pass_entries else "no_spherex_passes"
                if pass_entries:
                    cache.put_cached_catalog_region(
                        region_key,
                        cur_ra,
                        cur_dec,
                        0.1,
                        {"passes": pass_entries},
                        ttl_seconds=24 * 3600,
                    )
            except Exception:  # noqa: BLE001
                passes_status = "unavailable"

    return {
        "object_id": object_id,
        "label": label,
        "is_solar_system": False,
        "passes_status": passes_status,
        "epochs": [current_entry, *pass_entries],
    }
