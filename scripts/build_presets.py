#!/usr/bin/env python3
"""Build validated static preset bundles for every showcase target.

The builder runs the complete SPHEREx + WISE/NEOWISE fallback + Gaia/MOST
known-object pipeline for each entry in ``SHOWCASE_TARGETS`` and writes the
result to ``frontend/public/presets/{slug}/``.

When IRSA is unreachable (or ``--fallback-synthetic`` is supplied) the script
falls back to deterministic synthetic bundles via
``app.services.preset_builder``. Every manifest, spectrum, and binary buffer
is validated before it is written to disk.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "backend"))

from app.models.contracts import SHOWCASE_TARGETS  # noqa: E402
from app.services.archival_resolver import merge_pipeline_overlays  # noqa: E402
from app.services.catalog_clients import (  # noqa: E402
    HORIZONS_FEATURED_BODIES,
    fetch_gaia_dr3_objects,
    fetch_horizons_ephemeris,
    fetch_most_spherex_matches,
    fetch_simbad_objects,
)
from app.services.celestial_catalog_pipeline import AutomatedCelestialPipeline  # noqa: E402
from app.services.preset_builder import (  # noqa: E402
    DEFAULT_FOV_ARCMIN,
    build_live_preset_bundle,
    build_synthetic_preset_bundle,
    generate_all_synthetic_presets,
    validate_preset_bundle,
    validate_written_presets,
    write_global_known_objects_index,
    write_preset_bundle,
)
from app.services.spatial_cache import SpatialSqliteCache  # noqa: E402
from app.utils.astronomy import (  # noqa: E402
    mjd_to_iso,
    offline_requested,
    sky_to_pixel,
)

DEFAULT_TIMEOUT_SECONDS = float(os.environ.get("PRESET_BUILD_TIMEOUT", "20"))
PROBE_TIMEOUT_SECONDS = 5.0


def _log(message: str) -> None:
    """Print a flushed status line for preset build progress."""
    print(f"[build_presets] {message}", flush=True)


def _probe_irsa(timeout: float) -> bool:
    """Return True when the IRSA archive responds within a short timeout."""
    if offline_requested():
        return False
    try:
        import httpx

        probe_timeout = max(0.5, min(float(timeout), PROBE_TIMEOUT_SECONDS))
        with httpx.Client(
            timeout=httpx.Timeout(probe_timeout),
            follow_redirects=True,
        ) as client:
            response = client.get("https://irsa.ipac.caltech.edu/")
        return response.status_code < 500
    except Exception:  # noqa: BLE001
        return False


def _horizons_body_for(slug: str) -> dict[str, str] | None:
    """Return the Horizons body spec matching ``slug`` if applicable."""
    if slug == "comet_3i_atlas":
        return next(
            (body for body in HORIZONS_FEATURED_BODIES if "3I" in body["name"]),
            None,
        )
    if slug == "ceres_asteroid":
        return next(
            (body for body in HORIZONS_FEATURED_BODIES if "Ceres" in body["name"]),
            None,
        )
    return None


def _resolve_live_frames(
    slug: str,
    meta: dict[str, Any],
    fov_arcmin: float,
    timeout: float,
) -> (
    tuple[
        dict[str, bytes],
        list[dict[str, Any]],
        dict[str, Any],
        dict[str, Any] | None,
    ]
    | None
):
    """Attempt to ingest real SPHEREx cutouts (with a WISE fallback epoch)."""
    from app.services import wise_fallback as wise_module
    from app.services.spherex_coadd import (
        build_target_wcs_header,
        coadd_spherex_epochs,
    )
    from app.services.spherex_ingest import ingest_spherex_cutouts

    ra = float(meta["ra"])
    dec = float(meta["dec"])
    fov_deg = fov_arcmin / 60.0
    frames: dict[str, bytes] = {}
    epochs: list[dict[str, Any]] = []
    spherex_mjds: list[float] = []
    cutouts: list[Any] = []
    live_spectrum: dict[str, Any] | None = None

    previous_wise_timeout = getattr(wise_module, "IRSA_TIMEOUT", None)
    try:
        wise_module.IRSA_TIMEOUT = float(timeout)
        try:
            cutouts = ingest_spherex_cutouts(
                ra=ra,
                dec=dec,
                fov_arcmin=fov_arcmin,
                allow_synthetic_fallback=False,
                timeout=timeout,
            )
        except Exception as exc:  # noqa: BLE001
            _log(f"{slug}: SPHEREx ingestion failed ({type(exc).__name__}: {exc})")
            cutouts = []

        coadd = None
        if cutouts:
            try:
                coadd = coadd_spherex_epochs(cutouts, ra, dec, fov_deg)
            except Exception as exc:  # noqa: BLE001
                _log(f"{slug}: SPHEREx co-add failed ({type(exc).__name__}: {exc})")

        needs_wise = True
        if coadd is not None and coadd.epochs:
            needs_wise = bool(coadd.needs_wise_fallback) or len(coadd.epochs) < 2
            for index, epoch in enumerate(coadd.epochs, start=1):
                data_name = f"pass_{index}.bin"
                flags_name = f"pass_{index}_flags.bin"
                frames[data_name] = epoch.detector_buffer
                frames[flags_name] = epoch.flags_buffer
                spherex_mjds.append(float(epoch.mjd))
                epochs.append(
                    {
                        "epoch_id": epoch.epoch_id,
                        "label": f"Pass {index} (SPHEREx)",
                        "mission": "SPHEREx",
                        "mjd": float(epoch.mjd),
                        "iso_date": mjd_to_iso(epoch.mjd),
                        "detectors_data_url": f"/presets/{slug}/{data_name}",
                        "flags_mask_url": f"/presets/{slug}/{flags_name}",
                        "available_detectors": epoch.available_detectors or [1, 2, 3, 4, 5, 6],
                        "binary_dtype": "float32",
                    }
                )

        used_wise = False
        if needs_wise:
            try:
                wise = wise_module.fetch_wise_fallback(
                    ra=ra,
                    dec=dec,
                    fov_arcmin=fov_arcmin,
                    target_wcs_header=build_target_wcs_header(ra, dec, fov_deg),
                )
            except Exception as exc:  # noqa: BLE001
                _log(f"{slug}: WISE fallback failed ({type(exc).__name__}: {exc})")
                wise = None
            if wise is not None:
                used_wise = True
                frames["wise_fallback.bin"] = wise.detector_buffer
                frames["wise_fallback_flags.bin"] = wise.flags_buffer
                epochs.append(
                    {
                        "epoch_id": "wise_fallback",
                        "label": "WISE/NEOWISE archival fallback (W1/W2)",
                        "mission": "WISE",
                        "mjd": float(wise.mjd),
                        "iso_date": mjd_to_iso(wise.mjd),
                        "detectors_data_url": f"/presets/{slug}/wise_fallback.bin",
                        "flags_mask_url": f"/presets/{slug}/wise_fallback_flags.bin",
                        "available_detectors": wise.available_detectors or [4, 5, 6],
                        "binary_dtype": "float32",
                    }
                )
    finally:
        if previous_wise_timeout is not None:
            wise_module.IRSA_TIMEOUT = previous_wise_timeout

    if cutouts:
        try:
            from app.services.spectrum_extractor import extract_forced_spectrum

            live_spectrum = extract_forced_spectrum(
                ra=ra,
                dec=dec,
                cutouts=cutouts,
                source_label=str(meta["name"]),
            )
            live_spectrum["spectrum_origin"] = (
                "SPHEREx 102-Band Forced Photometry (IRSA archival cutouts)"
            )
        except Exception as exc:  # noqa: BLE001
            _log(f"{slug}: forced photometry failed ({type(exc).__name__}: {exc})")
            live_spectrum = None

    if len(epochs) < 2:
        _log(
            f"{slug}: live archive yielded {len(epochs)} usable epoch(s); using synthetic fallback"
        )
        return None

    epochs.sort(key=lambda entry: float(entry["mjd"]))
    all_mjds = [float(entry["mjd"]) for entry in epochs]
    baseline_days = max(all_mjds) - min(all_mjds) if len(all_mjds) >= 2 else 0.0
    if used_wise:
        summary = {
            "primary_mission": "WISE",
            "has_multi_epoch_spherex": len(spherex_mjds) >= 2,
            "uses_wise_fallback": True,
            "baseline_days": baseline_days,
            "status_note": f"WISE/NEOWISE W1/W2 fallback; {len(spherex_mjds)} SPHEREx epoch(s)",
        }
    else:
        summary = {
            "primary_mission": "SPHEREx",
            "has_multi_epoch_spherex": True,
            "uses_wise_fallback": False,
            "baseline_days": baseline_days,
            "status_note": f"{len(spherex_mjds)} real SPHEREx comparison epoch(s)",
        }
    return frames, epochs, summary, live_spectrum


async def _fetch_live_catalog_overlays(
    slug: str,
    meta: dict[str, Any],
    ra: float,
    dec: float,
    fov_arcmin: float,
    wcs: dict[str, Any],
    epochs_meta: list[dict[str, Any]],
    cache: SpatialSqliteCache,
    timeout: float,
) -> dict[str, Any]:
    """Query live SIMBAD, Gaia DR3, JPL Horizons, and IRSA MOST for one target.

    Args:
        slug: Showcase target slug.
        meta: Showcase target metadata mapping.
        ra: Field center Right Ascension in degrees.
        dec: Field center Declination in degrees.
        fov_arcmin: Field of view in arcminutes.
        wcs: Patch contract WCS dictionary.
        epochs_meta: Resolved epoch metadata list.
        cache: Ephemeral SQLite cache for Horizons ephemeris upserts.
        timeout: Per-request HTTP timeout in seconds.

    Returns:
        Assembled pipeline catalog overlay dictionary.
    """
    import httpx

    radius_deg = AutomatedCelestialPipeline.fov_to_radius_deg(fov_arcmin)
    pipeline = AutomatedCelestialPipeline(cache=cache)

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(float(timeout)),
        follow_redirects=True,
    ) as client:
        simbad_result, gaia_result = await asyncio.gather(
            fetch_simbad_objects(
                ra_deg=ra,
                dec_deg=dec,
                radius_deg=radius_deg,
                client=client,
                timeout_s=timeout,
            ),
            fetch_gaia_dr3_objects(
                ra_deg=ra,
                dec_deg=dec,
                radius_deg=radius_deg,
                client=client,
                timeout_s=timeout,
            ),
            return_exceptions=True,
        )

        simbad_rows, simbad_status = (
            simbad_result
            if isinstance(simbad_result, tuple)
            else ([], f"unavailable:{type(simbad_result).__name__}")
        )
        gaia_rows, gaia_status = (
            gaia_result
            if isinstance(gaia_result, tuple)
            else ([], f"unavailable:{type(gaia_result).__name__}")
        )

        horizons_body = _horizons_body_for(slug)
        if horizons_body is not None:
            mjds = [float(epoch["mjd"]) for epoch in epochs_meta] or [60000.0]
            try:
                points = await fetch_horizons_ephemeris(
                    naif_cmd=horizons_body["cmd"],
                    naif_id=horizons_body["naif_id"],
                    body_name=horizons_body["name"],
                    body_class=horizons_body["body_class"],
                    start_date=mjd_to_iso(min(mjds) - 5.0)[:10],
                    stop_date=mjd_to_iso(max(mjds) + 5.0)[:10],
                    step_size="1d",
                    client=client,
                    timeout_s=timeout,
                )
                if points:
                    cache.upsert_ephemeris_points(points)
            except Exception as exc:  # noqa: BLE001
                _log(f"{slug}: JPL Horizons fetch failed ({type(exc).__name__}: {exc})")

        result = pipeline.assemble_patch_objects(
            ra_deg=ra,
            dec_deg=dec,
            radius_deg=radius_deg,
            wcs=wcs,
            epochs_meta=epochs_meta,
            simbad_rows=simbad_rows,
            simbad_status=simbad_status,
            gaia_rows=gaia_rows,
            gaia_status=gaia_status,
        )

        most_body = _horizons_body_for(slug)
        most_query = most_body["most_name"] if most_body is not None else meta["name"]
        try:
            most_result = await fetch_most_spherex_matches(
                most_query,
                client=client,
                timeout_s=timeout,
            )
        except Exception as exc:  # noqa: BLE001
            most_result = {
                "status": f"unavailable:{type(exc).__name__}",
                "matches": [],
            }
        result.setdefault("source_status", {})["most"] = str(most_result.get("status", "unknown"))
        for match in most_result.get("matches", []):
            try:
                match_ra = float(match["ra"])
                match_dec = float(match["dec"])
            except (KeyError, TypeError, ValueError):
                continue
            x, y = sky_to_pixel(match_ra, match_dec, wcs)
            mjd_start = match.get("mjd_start")
            epoch_suffix = (
                f"{int(round(float(mjd_start)))}"
                if mjd_start is not None and str(mjd_start).strip()
                else "archive"
            )
            result.setdefault("most_solar_system", []).append(
                {
                    "object_name": str(most_result.get("query_name", most_query)),
                    "epoch_id": f"most_{epoch_suffix}",
                    "ra": match_ra % 360.0,
                    "dec": match_dec,
                    "x": x,
                    "y": y,
                    "v_mag": (float(match["vmag"]) if match.get("vmag") is not None else 12.0),
                }
            )

        return result


def _parse_targets(raw_targets: str | None) -> list[str]:
    """Parse and validate a comma-separated list of showcase slugs."""
    if not raw_targets:
        return list(SHOWCASE_TARGETS)
    slugs = [slug.strip() for slug in raw_targets.split(",") if slug.strip()]
    unknown = [slug for slug in slugs if slug not in SHOWCASE_TARGETS]
    if unknown:
        raise SystemExit(
            f"Unknown showcase target(s): {', '.join(unknown)}. "
            f"Valid targets: {', '.join(SHOWCASE_TARGETS)}"
        )
    return slugs


def build_presets(
    output_dir: Path,
    *,
    fallback_synthetic: bool = False,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    targets: list[str] | None = None,
    live_catalogs: bool = True,
) -> list[str]:
    """Build every requested preset bundle and return the generated slugs.

    Args:
        output_dir: Root directory where per-target preset directories are written.
        fallback_synthetic: When ``True``, skip IRSA probing and generate
            deterministic synthetic bundles directly.
        timeout: Per-request archive timeout in seconds.
        targets: Optional subset of showcase slugs (defaults to all targets).
        live_catalogs: Whether to augment live image frames with live catalog
            overlays from SIMBAD, Gaia DR3, JPL Horizons, and IRSA MOST.

    Returns:
        List of generated and validated showcase target slugs.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    slugs = targets or list(SHOWCASE_TARGETS)
    live_enabled = not fallback_synthetic and _probe_irsa(timeout)

    if fallback_synthetic:
        _log("Synthetic fallback requested; skipping live archive ingestion")
    elif live_enabled:
        _log(f"IRSA reachable; attempting live ingestion (timeout={timeout:.1f}s)")
    else:
        _log("IRSA unreachable/disabled; using deterministic synthetic fallback")

    if not live_enabled:
        generated = generate_all_synthetic_presets(output_root=output_dir, slugs=slugs)
        _log(f"Built and validated {len(generated)} preset bundle(s)")
        return generated

    manifests: dict[str, dict[str, Any]] = {}
    built: list[str] = []
    with tempfile.TemporaryDirectory(prefix="star_hunters_presets_") as temp_dir:
        cache = SpatialSqliteCache(db_path=str(Path(temp_dir) / "preset_cache.db"))
        try:
            for slug in slugs:
                meta = SHOWCASE_TARGETS[slug]
                _log(f"{slug}: ingesting live SPHEREx/WISE frames")
                live_frames = _resolve_live_frames(
                    slug=slug,
                    meta=meta,
                    fov_arcmin=DEFAULT_FOV_ARCMIN,
                    timeout=timeout,
                )
                if live_frames is None:
                    bundle = build_synthetic_preset_bundle(slug, meta)
                else:
                    frames, epochs, summary, live_spectrum = live_frames
                    bundle = build_live_preset_bundle(
                        slug=slug,
                        meta=meta,
                        frames=frames,
                        epochs=epochs,
                        summary=summary,
                        live_spectrum=live_spectrum,
                    )
                    if live_catalogs:
                        try:
                            live_overlays = asyncio.run(
                                _fetch_live_catalog_overlays(
                                    slug=slug,
                                    meta=meta,
                                    ra=float(meta["ra"]),
                                    dec=float(meta["dec"]),
                                    fov_arcmin=DEFAULT_FOV_ARCMIN,
                                    wcs=bundle.manifest["wcs"],
                                    epochs_meta=epochs,
                                    cache=cache,
                                    timeout=timeout,
                                )
                            )
                        except Exception as exc:  # noqa: BLE001
                            _log(
                                f"{slug}: live catalog ingestion failed "
                                f"({type(exc).__name__}: {exc})"
                            )
                            live_overlays = None
                        if live_overlays is not None:
                            bundle.manifest = merge_pipeline_overlays(
                                bundle.manifest,
                                live_overlays,
                                prefer_pipeline_when_uncached=False,
                            )
                validate_preset_bundle(bundle)
                write_preset_bundle(bundle, output_dir)
                validate_written_presets(output_dir, [slug])
                manifests[slug] = bundle.manifest
                built.append(slug)
                _log(f"{slug}: wrote validated {bundle.source} preset")
        finally:
            cache.close()

    index = write_global_known_objects_index(
        output_dir,
        manifests if set(manifests) == set(SHOWCASE_TARGETS) else None,
    )
    _log(f"Wrote global known-object index with {len(index)} entries")
    _log(f"Built and validated {len(built)} preset bundle(s)")
    return built


def main() -> int:
    """CLI entrypoint for building static showcase presets."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fallback-synthetic",
        action="store_true",
        help=(
            "Skip live IRSA/Gaia/MOST ingestion and generate deterministic "
            "synthetic presets instead."
        ),
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_SECONDS,
        help=(
            "Per-request archive timeout in seconds "
            f"(default: {DEFAULT_TIMEOUT_SECONDS:g}, env: PRESET_BUILD_TIMEOUT)."
        ),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=REPO_ROOT / "frontend" / "public" / "presets",
        help="Target directory for static preset bundles.",
    )
    parser.add_argument(
        "--targets",
        default=None,
        help="Optional comma-separated subset of showcase slugs (default: all).",
    )
    parser.add_argument(
        "--no-live-catalogs",
        action="store_true",
        help="Fetch live SPHEREx/WISE frames but keep deterministic catalog overlays.",
    )
    args = parser.parse_args()

    if args.timeout <= 0:
        parser.error("--timeout must be a positive number of seconds")

    slugs = _parse_targets(args.targets)
    try:
        built = build_presets(
            output_dir=args.output_dir,
            fallback_synthetic=args.fallback_synthetic,
            timeout=args.timeout,
            targets=slugs,
            live_catalogs=not args.no_live_catalogs,
        )
    except Exception as exc:  # noqa: BLE001
        _log(f"Preset build failed: {type(exc).__name__}: {exc}")
        return 1

    _log(f"Complete: {', '.join(built)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
