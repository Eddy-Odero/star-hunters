#!/usr/bin/env python3
"""Pre-seed SQLite spatial cache with JPL Horizons ephemerides, SIMBAD/Gaia regions & IRSA MOST."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

import httpx

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "backend"))

from app.models.contracts import SHOWCASE_TARGETS  # noqa: E402
from app.services.backend_service import StarHuntersBackendService  # noqa: E402
from app.services.catalog_clients import (  # noqa: E402
    HORIZONS_FEATURED_BODIES,
    fetch_horizons_ephemeris,
    fetch_most_spherex_matches,
)
from app.services.celestial_catalog_pipeline import AutomatedCelestialPipeline  # noqa: E402
from app.services.spatial_cache import SpatialSqliteCache  # noqa: E402


async def seed_all(
    db_path: str,
    summary_path: Path | None,
    start_date: str,
    stop_date: str,
    step_size: str,
    skip_ephemeris: bool = False,
    skip_regions: bool = False,
    skip_most: bool = False,
) -> dict[str, Any]:
    """Populate SQLite cache tables across all showcase fields and Solar System ephemerides."""
    cache = SpatialSqliteCache(db_path=db_path)
    try:
        pipeline = AutomatedCelestialPipeline(cache=cache)
        summary: dict[str, Any] = {
            "db_filename": Path(db_path).name,
            "ephemeris": {},
            "regions": {},
            "most": {},
        }

        async with httpx.AsyncClient(timeout=15.0) as client:
            pipeline.http_client = client

            if not skip_ephemeris:
                for body in HORIZONS_FEATURED_BODIES:
                    points = await fetch_horizons_ephemeris(
                        naif_cmd=body["cmd"],
                        naif_id=body["naif_id"],
                        body_name=body["name"],
                        body_class=body["body_class"],
                        start_date=start_date,
                        stop_date=stop_date,
                        step_size=step_size,
                        client=client,
                    )
                    count = cache.upsert_ephemeris_points(points)
                    summary["ephemeris"][body["name"]] = {
                        "naif_id": body["naif_id"],
                        "body_class": body["body_class"],
                        "rows": count,
                    }
                    print(
                        f"[horizons] {body['name']} ({body['naif_id']}): {count} daily rows"
                    )

            if not skip_regions:
                for slug, meta in SHOWCASE_TARGETS.items():
                    ra = float(meta["ra"])
                    dec = float(meta["dec"])
                    simbad_rows, simbad_status = await pipeline.get_simbad_region(
                        ra_deg=ra,
                        dec_deg=dec,
                        radius_deg=0.0625,
                        allow_live=True,
                    )
                    gaia_rows, gaia_status = await pipeline.get_gaia_region(
                        ra_deg=ra,
                        dec_deg=dec,
                        radius_deg=0.0625,
                        allow_live=True,
                    )
                    summary["regions"][slug] = {
                        "ra": ra,
                        "dec": dec,
                        "simbad_count": len(simbad_rows),
                        "simbad_status": simbad_status,
                        "gaia_count": len(gaia_rows),
                        "gaia_status": gaia_status,
                    }
                    print(
                        f"[region] {slug}: SIMBAD={len(simbad_rows)} ({simbad_status}), "
                        f"Gaia={len(gaia_rows)} ({gaia_status})"
                    )

            if not skip_most:
                most_queries = ["3I", "20000001:NID", "20000004:NID", "Mars", "Jupiter"]
                for qname in most_queries:
                    res = await fetch_most_spherex_matches(qname, client=client)
                    matches = res["matches"]
                    if matches:
                        cache.put_cached_catalog_region(
                            f"most:{qname.lower()}",
                            0.0,
                            0.0,
                            1.0,
                            res,
                            ttl_seconds=7 * 24 * 3600,
                        )
                    summary["most"][qname] = {
                        "status": res["status"],
                        "matches": len(matches),
                    }
                    print(
                        f"[most] {qname}: {len(matches)} SPHEREx intersections ({res['status']})"
                    )

        # Prewarm showcase sky patches & search index into SQLite
        service = StarHuntersBackendService(cache=cache)
        prewarm_count = service.prewarm_known_data()
        summary["prewarmed_patches"] = prewarm_count
        summary["cache_stats"] = cache.get_ephemeris_stats()

        if summary_path is not None:
            summary_path.parent.mkdir(parents=True, exist_ok=True)
            summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
            print(f"[seed] Wrote summary JSON to {summary_path}")

        return summary
    finally:
        cache.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db-path",
        default=os.environ.get("SQLITE_DB_PATH", "/tmp/star_hunters_cache.db"),
        help="Path to SQLite spatial cache database.",
    )
    parser.add_argument(
        "--summary-json",
        type=Path,
        default=REPO_ROOT
        / "backend"
        / "app"
        / "models"
        / "seeded_ephemeris_summary.json",
        help="Optional output path for lightweight seeding summary JSON.",
    )
    parser.add_argument("--start-date", default="2025-05-01")
    parser.add_argument("--stop-date", default="2026-12-31")
    parser.add_argument("--step-size", default="1d")
    parser.add_argument("--skip-ephemeris", action="store_true")
    parser.add_argument("--skip-regions", action="store_true")
    parser.add_argument("--skip-most", action="store_true")
    args = parser.parse_args()

    summary = asyncio.run(
        seed_all(
            db_path=args.db_path,
            summary_path=args.summary_json,
            start_date=args.start_date,
            stop_date=args.stop_date,
            step_size=args.step_size,
            skip_ephemeris=args.skip_ephemeris,
            skip_regions=args.skip_regions,
            skip_most=args.skip_most,
        )
    )
    print(f"[seed] Complete: {summary['cache_stats']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
