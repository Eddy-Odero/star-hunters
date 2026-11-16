#!/usr/bin/env python3
"""Pre-seed SQLite spatial cache with JPL Horizons ephemerides, SIMBAD/Gaia regions & IRSA MOST."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path
from typing import Any

import httpx

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "backend"))

from app.services.catalog_clients import HORIZONS_FEATURED_BODIES  # noqa: E402
from app.services.celestial_catalog_pipeline import AutomatedCelestialPipeline  # noqa: E402
from app.services.preset_builder import (  # noqa: E402
    prewarm_cache_with_service,
    seed_ephemeris_for_bodies,
    seed_most_intersections,
    seed_showcase_regions,
    write_summary_json,
)
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
    """Populate SQLite cache tables across all showcase fields and Solar System ephemerides.

    Args:
        db_path: Destination SQLite database file path.
        summary_path: Optional path to write the JSON seeding summary.
        start_date: Ephemeris window start date (``YYYY-MM-DD``).
        stop_date: Ephemeris window stop date (``YYYY-MM-DD``).
        step_size: Horizons sampling cadence (e.g. ``"1d"``).
        skip_ephemeris: Skip live JPL Horizons ephemeris seeding when ``True``.
        skip_regions: Skip live SIMBAD/Gaia region seeding when ``True``.
        skip_most: Skip live IRSA MOST intersection seeding when ``True``.

    Returns:
        Summary dictionary recording seeded counts and final cache statistics.
    """
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
                summary["ephemeris"] = await seed_ephemeris_for_bodies(
                    cache,
                    HORIZONS_FEATURED_BODIES,
                    start_date=start_date,
                    stop_date=stop_date,
                    step_size=step_size,
                    client=client,
                    on_body=lambda body, count: print(
                        f"[horizons] {body['name']} ({body['naif_id']}): {count} daily rows"
                    ),
                )

            if not skip_regions:
                summary["regions"] = await seed_showcase_regions(
                    pipeline,
                    on_region=lambda slug, scount, sstat, gcount, gstat: print(
                        f"[region] {slug}: SIMBAD={scount} ({sstat}), Gaia={gcount} ({gstat})"
                    ),
                )

            if not skip_most:
                most_queries = ["3I", "20000001:NID", "20000004:NID", "Mars", "Jupiter"]
                summary["most"] = await seed_most_intersections(
                    cache,
                    most_queries,
                    client=client,
                    on_query=lambda qname, count, status: print(
                        f"[most] {qname}: {count} SPHEREx intersections ({status})"
                    ),
                )

        summary.update(prewarm_cache_with_service(cache))

        if summary_path is not None:
            write_summary_json(summary_path, summary)
            print(f"[seed] Wrote summary JSON to {summary_path}")

        return summary
    finally:
        cache.close()


def main() -> int:
    """CLI entrypoint for seeding the SQLite spatial cache."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db-path",
        default=os.environ.get("SQLITE_DB_PATH", "/tmp/star_hunters_cache.db"),
        help="Path to SQLite spatial cache database.",
    )
    parser.add_argument(
        "--summary-json",
        type=Path,
        default=REPO_ROOT / "backend" / "app" / "models" / "seeded_ephemeris_summary.json",
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
