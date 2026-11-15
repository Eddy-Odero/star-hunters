"""Shared preset bundle assembly, validation, disk persistence, and cache-seeding helpers."""

from __future__ import annotations

import copy
import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from app.models.contracts import (
    SHOWCASE_TARGETS,
    validate_detector_binary_buffer,
    validate_flags_binary_buffer,
    validate_sky_patch_manifest,
    validate_spectrum_payload,
)
from app.models.global_sky_reference_catalog import extend_global_known_objects_index
from app.services.archival_resolver import merge_pipeline_overlays
from app.services.backend_service import StarHuntersBackendService
from app.services.catalog_clients import (
    fetch_horizons_ephemeris,
    fetch_most_spherex_matches,
)
from app.services.celestial_catalog_pipeline import AutomatedCelestialPipeline
from app.services.object_search import get_global_known_objects_index
from app.services.spatial_cache import SpatialSqliteCache
from app.services.synthetic_patch import (
    build_catalog_overlays_for_patch,
    build_sky_patch_manifest_payload,
    build_spectrum_payload,
    generate_synthetic_epoch_frames,
)

DEFAULT_FOV_ARCMIN = 5.0
GENERATED_BINARY_PATTERNS: tuple[str, ...] = (
    "pass_*.bin",
    "pass_*_flags.bin",
    "wise_fallback.bin",
    "wise_fallback_flags.bin",
)


@dataclass
class PresetBundle:
    """In-memory preset bundle paired with manifest, spectrum, and binary frames."""

    slug: str
    manifest: dict[str, Any]
    spectrum: dict[str, Any]
    frames: dict[str, bytes]
    source: str


def build_synthetic_preset_bundle(
    slug: str,
    meta: Mapping[str, Any] | None = None,
    *,
    fov_arcmin: float = DEFAULT_FOV_ARCMIN,
) -> PresetBundle:
    """Build a deterministic synthetic preset bundle for a showcase target.

    Args:
        slug: Showcase target slug present in :data:`SHOWCASE_TARGETS`.
        meta: Optional showcase metadata override; defaults to
            ``SHOWCASE_TARGETS[slug]``.
        fov_arcmin: Field of view in arcminutes.

    Returns:
        Assembled :class:`PresetBundle` with ``source="synthetic"``.
    """
    target_meta = meta if meta is not None else SHOWCASE_TARGETS[slug]
    ra = float(target_meta["ra"])
    dec = float(target_meta["dec"])
    name = str(target_meta["name"])

    manifest = build_sky_patch_manifest_payload(
        ra=ra,
        dec=dec,
        fov_arcmin=fov_arcmin,
        slug=slug,
        static_preset_urls=True,
    )
    spectrum = build_spectrum_payload(
        ra=ra,
        dec=dec,
        source_label=name,
        slug=slug,
    )
    frames = generate_synthetic_epoch_frames(slug=slug, manifest=manifest)
    return PresetBundle(
        slug=slug,
        manifest=manifest,
        spectrum=spectrum,
        frames=frames,
        source="synthetic",
    )


def build_live_preset_bundle(
    slug: str,
    meta: Mapping[str, Any],
    frames: dict[str, bytes],
    epochs: list[dict[str, Any]],
    summary: dict[str, Any],
    *,
    fov_arcmin: float = DEFAULT_FOV_ARCMIN,
    live_overlays: dict[str, Any] | None = None,
    live_spectrum: dict[str, Any] | None = None,
) -> PresetBundle:
    """Assemble a live archival preset bundle with optional pipeline overlays and spectrum.

    Args:
        slug: Showcase target slug.
        meta: Showcase target metadata dictionary.
        frames: Mapping of binary frame filenames to raw byte buffers.
        epochs: Epoch metadata entries matching ``frames``.
        summary: Mission provenance summary dictionary.
        fov_arcmin: Field of view in arcminutes.
        live_overlays: Optional live catalog pipeline output to merge.
        live_spectrum: Optional extracted 102-band archival spectrum payload.

    Returns:
        Assembled :class:`PresetBundle` with ``source="live"``.
    """
    ra = float(meta["ra"])
    dec = float(meta["dec"])
    manifest = build_sky_patch_manifest_payload(
        ra=ra,
        dec=dec,
        fov_arcmin=fov_arcmin,
        slug=slug,
        static_preset_urls=True,
    )
    manifest["epochs"] = epochs
    manifest["data_source_summary"] = summary
    manifest["catalog_overlays"] = build_catalog_overlays_for_patch(
        ra=ra,
        dec=dec,
        wcs=manifest["wcs"],
        epochs_meta=epochs,
        target_slug=slug,
    )
    manifest["default_spectrum_url"] = f"/presets/{slug}/spectrum.json"

    if live_overlays is not None:
        manifest = merge_pipeline_overlays(
            manifest,
            live_overlays,
            prefer_pipeline_when_uncached=False,
        )

    spectrum = live_spectrum or build_spectrum_payload(
        ra=ra,
        dec=dec,
        source_label=str(meta["name"]),
        slug=slug,
    )
    return PresetBundle(
        slug=slug,
        manifest=manifest,
        spectrum=spectrum,
        frames=frames,
        source="live",
    )


def validate_preset_bundle(bundle: PresetBundle) -> None:
    """Validate every JSON contract, epoch coverage, and binary buffer in ``bundle``.

    Args:
        bundle: In-memory :class:`PresetBundle` to validate.

    Raises:
        ValueError: If fewer than 2 epochs exist, ``known_objects`` is empty,
            an object lacks epoch positions, or any referenced binary frame is
            missing or malformed.
    """
    validate_sky_patch_manifest(bundle.manifest)
    validate_spectrum_payload(bundle.spectrum)

    epochs = bundle.manifest["epochs"]
    if len(epochs) < 2:
        raise ValueError(f"{bundle.slug}: expected at least 2 epochs, found {len(epochs)}")
    epoch_ids = {str(epoch["epoch_id"]) for epoch in epochs}
    known_objects = bundle.manifest["catalog_overlays"].get("known_objects", [])
    if not known_objects:
        raise ValueError(f"{bundle.slug}: catalog_overlays.known_objects is empty")
    for obj in known_objects:
        position_ids = {str(pos.get("epoch_id")) for pos in obj.get("epoch_positions", [])}
        if not epoch_ids.issubset(position_ids):
            raise ValueError(
                f"{bundle.slug}: {obj.get('object_id')} is missing epoch positions "
                f"for {sorted(epoch_ids - position_ids)}"
            )

    for filename, raw in bundle.frames.items():
        if filename.endswith("_flags.bin"):
            validate_flags_binary_buffer(raw)
        else:
            precision = "float32"
            for epoch in epochs:
                if filename == epoch["detectors_data_url"].rsplit("/", 1)[-1]:
                    precision = str(epoch.get("binary_dtype", "float32"))
                    break
            validate_detector_binary_buffer(raw, precision=precision)

    for epoch in epochs:
        for url_key in ("detectors_data_url", "flags_mask_url"):
            filename = str(epoch[url_key]).rsplit("/", 1)[-1]
            if filename not in bundle.frames:
                raise ValueError(f"{bundle.slug}: manifest references missing frame {filename}")


def clean_generated_preset_files(target_dir: Path) -> None:
    """Remove previously generated binary frame files inside ``target_dir``.

    Args:
        target_dir: Showcase preset directory (e.g. ``frontend/public/presets/wise_0855``).
    """
    if not target_dir.is_dir():
        return
    for pattern in GENERATED_BINARY_PATTERNS:
        for path in target_dir.glob(pattern):
            if path.is_file():
                path.unlink()


def write_preset_bundle(bundle: PresetBundle, output_dir: Path) -> Path:
    """Clean stale binary frames and write a validated preset bundle to disk.

    Args:
        bundle: Validated :class:`PresetBundle` to persist.
        output_dir: Root presets directory (e.g. ``frontend/public/presets``).

    Returns:
        Path to the target directory ``output_dir / bundle.slug``.
    """
    target_dir = output_dir / bundle.slug
    target_dir.mkdir(parents=True, exist_ok=True)
    clean_generated_preset_files(target_dir)

    for filename, raw in bundle.frames.items():
        (target_dir / filename).write_bytes(raw)
    (target_dir / "manifest.json").write_text(
        json.dumps(bundle.manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    (target_dir / "spectrum.json").write_text(
        json.dumps(bundle.spectrum, indent=2) + "\n",
        encoding="utf-8",
    )
    return target_dir


def validate_written_presets(output_dir: Path, slugs: Sequence[str]) -> list[str]:
    """Read back and validate persisted preset bundles on disk for ``slugs``.

    Args:
        output_dir: Root presets directory.
        slugs: Showcase target slugs to inspect.

    Returns:
        List of validated slugs.

    Raises:
        FileNotFoundError: If ``manifest.json``, ``spectrum.json``, or a
            referenced binary frame is absent on disk.
    """
    validated: list[str] = []
    for slug in slugs:
        target_dir = output_dir / slug
        manifest_path = target_dir / "manifest.json"
        spectrum_path = target_dir / "spectrum.json"
        if not manifest_path.is_file() or not spectrum_path.is_file():
            raise FileNotFoundError(f"{slug}: manifest.json or spectrum.json is missing")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        spectrum = json.loads(spectrum_path.read_text(encoding="utf-8"))

        frames: dict[str, bytes] = {}
        for epoch in manifest["epochs"]:
            for url_key in ("detectors_data_url", "flags_mask_url"):
                filename = str(epoch[url_key]).rsplit("/", 1)[-1]
                frame_path = target_dir / filename
                if not frame_path.is_file():
                    raise FileNotFoundError(f"{slug}: missing binary frame {filename}")
                frames[filename] = frame_path.read_bytes()

        validate_preset_bundle(
            PresetBundle(
                slug=slug,
                manifest=manifest,
                spectrum=spectrum,
                frames=frames,
                source="written",
            )
        )
        validated.append(slug)
    return validated


def write_global_known_objects_index(
    output_dir: Path,
    manifests: Mapping[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Build and write ``global_known_objects.json`` inside ``output_dir``.

    Args:
        output_dir: Root presets directory.
        manifests: Optional mapping of showcase slugs to their built manifests.
            When omitted, :func:`get_global_known_objects_index` is used directly
            without re-applying :func:`extend_global_known_objects_index`.

    Returns:
        Final global known-object index written to ``global_known_objects.json``.
    """
    if manifests is None:
        index = copy.deepcopy(get_global_known_objects_index())
    else:
        entries: list[dict[str, Any]] = []
        for slug, manifest in manifests.items():
            meta = SHOWCASE_TARGETS[slug]
            for obj in manifest["catalog_overlays"].get("known_objects", []):
                entry = copy.deepcopy(obj)
                entry["target_slug"] = slug
                entry["target_name"] = meta["name"]
                entry["constellation"] = meta["constellation"]
                entry["patch_ra"] = meta["ra"]
                entry["patch_dec"] = meta["dec"]
                entries.append(entry)
        index = extend_global_known_objects_index(entries)

    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "global_known_objects.json").write_text(
        json.dumps(index, indent=2) + "\n",
        encoding="utf-8",
    )
    return index


def generate_all_synthetic_presets(
    output_root: Path,
    slugs: Sequence[str] | None = None,
) -> list[str]:
    """Generate, validate, and write synthetic preset bundles for showcase targets.

    Args:
        output_root: Target directory for static preset bundles.
        slugs: Optional subset of showcase slugs (defaults to all
            :data:`SHOWCASE_TARGETS`).

    Returns:
        List of generated and validated showcase target slugs.
    """
    output_root.mkdir(parents=True, exist_ok=True)
    requested_slugs = list(slugs) if slugs is not None else list(SHOWCASE_TARGETS)
    manifests: dict[str, dict[str, Any]] = {}
    generated_slugs: list[str] = []

    for slug in requested_slugs:
        bundle = build_synthetic_preset_bundle(slug, SHOWCASE_TARGETS[slug])
        validate_preset_bundle(bundle)
        write_preset_bundle(bundle, output_root)
        manifests[slug] = bundle.manifest
        generated_slugs.append(slug)

    if set(generated_slugs) == set(SHOWCASE_TARGETS):
        write_global_known_objects_index(output_root, manifests)
    else:
        write_global_known_objects_index(output_root)
    validate_written_presets(output_root, generated_slugs)
    return generated_slugs


def write_summary_json(summary_path: Path, summary: Mapping[str, Any]) -> Path:
    """Persist a formatted JSON summary dictionary to ``summary_path``.

    Args:
        summary_path: Destination JSON file path.
        summary: Summary mapping to serialize.

    Returns:
        Resolved ``summary_path`` after writing.
    """
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(dict(summary), indent=2) + "\n", encoding="utf-8")
    return summary_path


async def seed_ephemeris_for_bodies(
    cache: SpatialSqliteCache,
    bodies: Sequence[Mapping[str, str]],
    *,
    start_date: str,
    stop_date: str,
    step_size: str,
    client: httpx.AsyncClient,
    timeout_s: float = 12.0,
    on_body: Callable[[Mapping[str, str], int], None] | None = None,
) -> dict[str, dict[str, Any]]:
    """Fetch JPL Horizons ephemerides for ``bodies`` and upsert them into SQLite.

    Args:
        cache: SQLite spatial cache instance.
        bodies: Sequence of Horizons body specs (``cmd``, ``naif_id``, ``name``,
            ``body_class``).
        start_date: Ephemeris window start date (``YYYY-MM-DD``).
        stop_date: Ephemeris window stop date (``YYYY-MM-DD``).
        step_size: Sampling cadence (e.g. ``"1d"``).
        client: Shared :class:`httpx.AsyncClient`.
        timeout_s: Per-request timeout in seconds.
        on_body: Optional callback invoked with ``(body_spec, row_count)``.

    Returns:
        Per-body summary dictionary keyed by body name.
    """
    ephemeris_summary: dict[str, dict[str, Any]] = {}
    for body in bodies:
        points = await fetch_horizons_ephemeris(
            naif_cmd=body["cmd"],
            naif_id=body["naif_id"],
            body_name=body["name"],
            body_class=body["body_class"],
            start_date=start_date,
            stop_date=stop_date,
            step_size=step_size,
            client=client,
            timeout_s=timeout_s,
        )
        count = cache.upsert_ephemeris_points(points)
        ephemeris_summary[body["name"]] = {
            "naif_id": body["naif_id"],
            "body_class": body["body_class"],
            "rows": count,
        }
        if on_body is not None:
            on_body(body, count)
    return ephemeris_summary


async def seed_showcase_regions(
    pipeline: AutomatedCelestialPipeline,
    targets: Mapping[str, Mapping[str, Any]] | None = None,
    *,
    radius_deg: float = 0.0625,
    allow_live: bool = True,
    on_region: Callable[[str, int, str, int, str], None] | None = None,
) -> dict[str, dict[str, Any]]:
    """Populate SQLite SIMBAD and Gaia DR3 region caches for showcase targets.

    Args:
        pipeline: Configured :class:`AutomatedCelestialPipeline`.
        targets: Optional target mapping; defaults to :data:`SHOWCASE_TARGETS`.
        radius_deg: Cone-search radius in degrees.
        allow_live: Whether live upstream catalog queries are permitted.
        on_region: Optional callback invoked with
            ``(slug, simbad_count, simbad_status, gaia_count, gaia_status)``.

    Returns:
        Per-target region seeding summary dictionary keyed by slug.
    """
    selected_targets = targets if targets is not None else SHOWCASE_TARGETS
    regions_summary: dict[str, dict[str, Any]] = {}
    for slug, meta in selected_targets.items():
        ra = float(meta["ra"])
        dec = float(meta["dec"])
        simbad_rows, simbad_status = await pipeline.get_simbad_region(
            ra_deg=ra,
            dec_deg=dec,
            radius_deg=radius_deg,
            allow_live=allow_live,
        )
        gaia_rows, gaia_status = await pipeline.get_gaia_region(
            ra_deg=ra,
            dec_deg=dec,
            radius_deg=radius_deg,
            allow_live=allow_live,
        )
        regions_summary[slug] = {
            "ra": ra,
            "dec": dec,
            "simbad_count": len(simbad_rows),
            "simbad_status": simbad_status,
            "gaia_count": len(gaia_rows),
            "gaia_status": gaia_status,
        }
        if on_region is not None:
            on_region(slug, len(simbad_rows), simbad_status, len(gaia_rows), gaia_status)
    return regions_summary


async def seed_most_intersections(
    cache: SpatialSqliteCache,
    queries: Sequence[str],
    *,
    client: httpx.AsyncClient,
    ttl_seconds: float = 7 * 24 * 3600,
    timeout_s: float = 12.0,
    on_query: Callable[[str, int, str], None] | None = None,
) -> dict[str, dict[str, Any]]:
    """Fetch IRSA MOST SPHEREx intersections for ``queries`` and cache non-empty results.

    Args:
        cache: SQLite spatial cache instance.
        queries: Sequence of MOST object queries (e.g. ``"3I"``, ``"Mars"``).
        client: Shared :class:`httpx.AsyncClient`.
        ttl_seconds: Cache TTL in seconds.
        timeout_s: Per-request timeout in seconds.
        on_query: Optional callback invoked with ``(query_name, match_count, status)``.

    Returns:
        Per-query MOST summary dictionary keyed by query string.
    """
    most_summary: dict[str, dict[str, Any]] = {}
    for qname in queries:
        res = await fetch_most_spherex_matches(qname, client=client, timeout_s=timeout_s)
        matches = res["matches"]
        if matches:
            cache.put_cached_catalog_region(
                f"most:{qname.lower()}",
                0.0,
                0.0,
                1.0,
                res,
                ttl_seconds=ttl_seconds,
            )
        most_summary[qname] = {
            "status": res["status"],
            "matches": len(matches),
        }
        if on_query is not None:
            on_query(qname, len(matches), str(res["status"]))
    return most_summary


def prewarm_cache_with_service(cache: SpatialSqliteCache) -> dict[str, Any]:
    """Prewarm showcase sky patches, spectra, and search index in ``cache``.

    Args:
        cache: Target :class:`SpatialSqliteCache` instance.

    Returns:
        Dictionary containing ``prewarmed_patches`` count and ``cache_stats``.
    """
    service = StarHuntersBackendService(cache=cache)
    prewarm_count = service.prewarm_known_data()
    return {
        "prewarmed_patches": prewarm_count,
        "cache_stats": cache.get_ephemeris_stats(),
    }
