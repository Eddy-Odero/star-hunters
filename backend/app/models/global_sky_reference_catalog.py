"""All-sky reference catalog loader for planets, moons, comets, asteroids, and IR benchmarks.

Merged into ``global_known_objects.json`` and ``/api/v1/catalogs/search`` so the
viewport-filtered Known Objects panel stays populated across the entire 3D celestial sphere,
even when the user pans far outside the 12 static showcase patch centers.
"""

from __future__ import annotations

import copy
import json
from functools import lru_cache
from pathlib import Path
from typing import Any

_REFERENCE_CATALOG_PATH = Path(__file__).with_name("all_sky_reference_objects.json")


@lru_cache(maxsize=1)
def _load_reference_objects() -> tuple[dict[str, Any], ...]:
    """Load cached immutable reference objects from ``all_sky_reference_objects.json``."""
    raw = json.loads(_REFERENCE_CATALOG_PATH.read_text(encoding="utf-8"))
    return tuple(raw)


def build_all_sky_reference_objects() -> list[dict[str, Any]]:
    """Return curated Solar System and all-sky bright IR stars, nebulae, and galaxies.

    Returns:
        Deep-copied list of reference object dictionaries ready for search indexing.
    """
    return [copy.deepcopy(item) for item in _load_reference_objects()]


def extend_global_known_objects_index(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return a deduplicated global index preserving showcase items and adding all-sky targets.

    Args:
        entries: Existing showcase known-object index entries.

    Returns:
        Combined deduplicated list of known-object dictionaries.
    """
    merged: list[dict[str, Any]] = [copy.deepcopy(item) for item in entries]
    seen_ids = {str(item.get("object_id", "")) for item in merged if item.get("object_id")}
    seen_labels = {
        str(item.get("label", "")).strip().lower() for item in merged if item.get("label")
    }
    for ref in build_all_sky_reference_objects():
        oid = str(ref.get("object_id", ""))
        lbl = str(ref.get("label", "")).strip().lower()
        if (oid and oid in seen_ids) or (lbl and lbl in seen_labels):
            continue
        merged.append(ref)
        if oid:
            seen_ids.add(oid)
        if lbl:
            seen_labels.add(lbl)
    return merged
