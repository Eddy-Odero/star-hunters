"""Multi-tier archival sky-patch resolution (SPHEREx -> WISE -> SkyView -> Simulated)."""

from __future__ import annotations

import copy
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import wait as wait_futures
from typing import Any

import numpy as np

from app.models.contracts import (
    BINARY_DETECTOR_FLOAT32_BYTES,
    GRID_HEIGHT,
    GRID_WIDTH,
    NUM_DETECTORS,
    SHOWCASE_TARGETS,
)
from app.services.logging_config import get_logger
from app.services.object_search import _infer_object_class
from app.services.skyview_fallback import (
    fetch_skyview_fallback,
    inject_solar_system_ephemeris_overlay,
)
from app.services.spherex_coadd import build_target_wcs_header, coadd_spherex_epochs
from app.services.spherex_ingest import ingest_spherex_cutouts
from app.services.wise_fallback import fetch_wise_fallback
from app.utils.astronomy import angular_separation_deg, mjd_to_iso

_logger = get_logger("archival_resolver")


def merge_pipeline_overlays(
    manifest: dict[str, Any],
    pipeline_result: dict[str, Any],
    prefer_pipeline_when_uncached: bool = False,
) -> dict[str, Any]:
    """Merge cached/live SIMBAD + Gaia + Horizons ephemeris into manifest catalog overlays.

    Args:
        manifest: Baseline sky-patch manifest dictionary.
        pipeline_result: Output from :class:`AutomatedCelestialPipeline`.
        prefer_pipeline_when_uncached: When ``True`` and the patch is not a
            showcase target, replace synthetic seeded entries with real pipeline
            objects if any are present.

    Returns:
        Deep-copied manifest dictionary with merged ``catalog_overlays``.
    """
    overlays = copy.deepcopy(manifest["catalog_overlays"])
    base_known = list(overlays.get("known_objects", []))
    for item in base_known:
        item.setdefault("object_class", _infer_object_class(item))

    pipe_known = list(pipeline_result.get("known_objects", []))
    is_showcase = manifest.get("target_metadata", {}).get("slug") in SHOWCASE_TARGETS

    if prefer_pipeline_when_uncached and not is_showcase and pipe_known:
        merged_known = list(pipe_known)
    else:
        merged_known = base_known
        dedup_deg = 2.5 / 3600.0
        for cand in pipe_known:
            cand_id = str(cand.get("object_id", ""))
            cand_ra = float(cand.get("ra", 0.0))
            cand_dec = float(cand.get("dec", 0.0))
            duplicate = any(
                str(ex.get("object_id", "")) == cand_id
                or angular_separation_deg(cand_ra, cand_dec, float(ex["ra"]), float(ex["dec"]))
                <= dedup_deg
                for ex in merged_known
            )
            if not duplicate:
                merged_known.append(cand)

    gaia_existing_ids = {str(g.get("source_id")) for g in overlays.get("gaia_dr3", [])}
    gaia_merged = list(overlays.get("gaia_dr3", []))
    for g in pipeline_result.get("gaia_dr3", []):
        if str(g.get("source_id")) not in gaia_existing_ids:
            gaia_merged.append(g)
            gaia_existing_ids.add(str(g.get("source_id")))

    most_existing = {
        (str(m.get("object_name")), str(m.get("epoch_id")))
        for m in overlays.get("most_solar_system", [])
    }
    most_merged = list(overlays.get("most_solar_system", []))
    for m in pipeline_result.get("most_solar_system", []):
        key = (str(m.get("object_name")), str(m.get("epoch_id")))
        if key not in most_existing:
            most_merged.append(m)
            most_existing.add(key)

    overlays["known_objects"] = merged_known[:120]
    overlays["gaia_dr3"] = gaia_merged
    overlays["most_solar_system"] = most_merged
    if pipeline_result.get("source_status"):
        overlays["source_status"] = dict(pipeline_result["source_status"])

    updated = copy.deepcopy(manifest)
    updated["catalog_overlays"] = overlays
    return updated


def apply_solar_system_ephemeris_to_frames(
    manifest: dict[str, Any],
    frames: dict[str, bytes],
) -> tuple[dict[str, Any], dict[str, bytes]]:
    """Inject live JPL Horizons planetary markers onto historical WISE/SkyView plates.

    Args:
        manifest: Resolved sky-patch manifest dictionary.
        frames: Mapping of frame filenames to raw little-endian bytes.

    Returns:
        Tuple of ``(updated_manifest, updated_frames)``.
    """
    primary = manifest.get("data_source_summary", {}).get("primary_mission")
    if primary not in {"WISE", "SkyView"}:
        return manifest, frames
    known = list(manifest.get("catalog_overlays", {}).get("known_objects", []))
    solar_bodies = [
        obj
        for obj in known
        if (
            str(obj.get("object_id", "")).startswith("ephem:")
            or obj.get("object_class") in {"planet", "moon", "comet", "asteroid"}
        )
        and obj.get("epoch_positions")
    ]
    if not solar_bodies:
        return manifest, frames

    updated_frames = dict(frames)
    epochs = list(manifest.get("epochs", []))
    applied_names: list[str] = []
    for ep in epochs:
        ep_id = str(ep.get("epoch_id", ""))
        det_url = str(ep.get("detectors_data_url", ""))
        filename = det_url.rsplit("/", 1)[-1]
        raw = updated_frames.get(filename)
        if not raw or len(raw) != BINARY_DETECTOR_FLOAT32_BYTES:
            continue
        cube = (
            np.frombuffer(raw, dtype="<f4").reshape((NUM_DETECTORS, GRID_HEIGHT, GRID_WIDTH)).copy()
        )
        ep_avail = list(ep.get("available_detectors") or [1, 2])
        for body in solar_bodies:
            pos = next(
                (p for p in body["epoch_positions"] if str(p.get("epoch_id")) == ep_id),
                body["epoch_positions"][0],
            )
            cube = inject_solar_system_ephemeris_overlay(
                cube,
                x_px=float(pos["x"]),
                y_px=float(pos["y"]),
                body_name=str(body.get("label", "Solar System Target")),
                body_class=str(body.get("object_class", "planet")),
                available_detectors=ep_avail,
            )
            if str(body.get("label")) not in applied_names:
                applied_names.append(str(body.get("label")))
        updated_frames[filename] = np.ascontiguousarray(cube, dtype="<f4").tobytes(order="C")

    if applied_names:
        out_manifest = copy.deepcopy(manifest)
        summary = out_manifest["data_source_summary"]
        base_survey = str(summary.get("survey_name") or summary.get("primary_mission"))
        summary["survey_name"] = f"JPL Horizons Ephemeris + {base_survey}"
        summary["status_note"] = (
            f"{summary.get('status_note', '')}; Horizons ({', '.join(applied_names[:2])})"
        ).strip("; ")
        _logger.info(
            "Injected JPL Horizons ephemeris marker for %s onto %s frames",
            applied_names,
            primary,
        )
        return out_manifest, updated_frames
    return manifest, frames


class ArchivalResolver:
    """Constructor-injected archival retrieval chain (SPHEREx -> WISE -> SkyView -> Simulated)."""

    def __init__(
        self,
        *,
        spherex_cutout_fetcher: Callable[..., list[Any]] = ingest_spherex_cutouts,
        spherex_coadder: Callable[..., Any] = coadd_spherex_epochs,
        wcs_header_builder: Callable[..., dict[str, Any]] = build_target_wcs_header,
        wise_fallback_fetcher: Callable[..., Any] = fetch_wise_fallback,
        skyview_fallback_fetcher: Callable[..., Any] = fetch_skyview_fallback,
    ) -> None:
        """Initialize the archival resolver with injectable data providers.

        Args:
            spherex_cutout_fetcher: Callable ingesting raw SPHEREx cutouts.
            spherex_coadder: Callable clustering and co-adding SPHEREx cutouts.
            wcs_header_builder: Callable building the target 256x256 FITS WCS header.
            wise_fallback_fetcher: Callable fetching WISE/NEOWISE fallback cubes.
            skyview_fallback_fetcher: Callable fetching NASA SkyView fallback epochs.
        """
        self.spherex_cutout_fetcher = spherex_cutout_fetcher
        self.spherex_coadder = spherex_coadder
        self.wcs_header_builder = wcs_header_builder
        self.wise_fallback_fetcher = wise_fallback_fetcher
        self.skyview_fallback_fetcher = skyview_fallback_fetcher

    def resolve_archival_patch_sync(
        self,
        *,
        manifest: dict[str, Any],
        grid_key: str,
        ra: float,
        dec: float,
        fov: float,
        fallback_frames: dict[str, bytes],
    ) -> tuple[dict[str, Any], dict[str, bytes]]:
        """Run archival retrieval chain: SPHEREx -> WISE -> NASA SkyView -> Simulated.

        Args:
            manifest: Baseline sky-patch manifest dictionary.
            grid_key: Quantized spatial grid identifier.
            ra: Field center Right Ascension in degrees.
            dec: Field center Declination in degrees.
            fov: Field of view in arcminutes.
            fallback_frames: Synthetic fallback frame buffers used if all
                archival providers fail.

        Returns:
            Tuple of ``(resolved_manifest, resolved_frames)``.
        """
        out_manifest = copy.deepcopy(manifest)
        frames = dict(fallback_frames)
        fallback_errors: list[str] = []
        t0 = time.perf_counter()

        try:
            fov_deg = float(fov) / 60.0
            target_header = self.wcs_header_builder(ra, dec, fov_deg)

            pool = ThreadPoolExecutor(max_workers=3)
            fut_wise = None
            fut_skyview = None
            try:
                fut_spherex = pool.submit(
                    self.spherex_cutout_fetcher,
                    ra=ra,
                    dec=dec,
                    fov_arcmin=fov,
                    allow_synthetic_fallback=False,
                )
                wait_futures([fut_spherex], timeout=0.15)
                spherex_fast_ok = False
                fast_coadd = None
                if fut_spherex.done():
                    try:
                        cutouts = fut_spherex.result()
                        fast_coadd = self.spherex_coadder(cutouts, ra, dec, fov_deg)
                        spherex_fast_ok = (
                            len(fast_coadd.epochs) >= 2 and not fast_coadd.needs_wise_fallback
                        )
                    except Exception:
                        fast_coadd = None
                        spherex_fast_ok = False

                if not spherex_fast_ok:
                    fut_wise = pool.submit(
                        self.wise_fallback_fetcher,
                        ra=ra,
                        dec=dec,
                        fov_arcmin=fov,
                        target_wcs_header=target_header,
                    )
                    wait_futures([fut_wise], timeout=0.15)
                    wise_fast_ok = False
                    if fut_wise.done():
                        try:
                            fut_wise.result()
                            wise_fast_ok = True
                        except Exception:
                            wise_fast_ok = False
                    if not wise_fast_ok:
                        fut_skyview = pool.submit(
                            self.skyview_fallback_fetcher,
                            ra=ra,
                            dec=dec,
                            fov_arcmin=fov,
                            target_wcs_header=target_header,
                        )

                if fast_coadd is not None:
                    coadd = fast_coadd
                else:
                    wait_futures([fut_spherex], timeout=22.0)
                    if fut_spherex.done():
                        try:
                            cutouts = fut_spherex.result()
                        except Exception as exc:
                            fallback_errors.append(f"SPHEREx:{type(exc).__name__}")
                            cutouts = []
                    else:
                        fallback_errors.append("SPHEREx:TimeoutError")
                        fut_spherex.cancel()
                        cutouts = []

                    coadd = self.spherex_coadder(cutouts, ra, dec, fov_deg)

                epoch_entries: list[dict[str, Any]] = []
                actual_frames: dict[str, bytes] = {}
                epoch_mjds: list[float] = []
                for index, epoch in enumerate(coadd.epochs, start=1):
                    filename = f"pass_{index}.bin"
                    flags_filename = f"pass_{index}_flags.bin"
                    actual_frames[filename] = epoch.detector_buffer
                    actual_frames[flags_filename] = epoch.flags_buffer
                    epoch_mjds.append(float(epoch.mjd))
                    epoch_entries.append(
                        {
                            "epoch_id": epoch.epoch_id,
                            "label": f"Pass {index} (SPHEREx)",
                            "mission": "SPHEREx",
                            "mjd": float(epoch.mjd),
                            "iso_date": mjd_to_iso(epoch.mjd),
                            "detectors_data_url": f"/api/v1/frames/{grid_key}/{filename}",
                            "flags_mask_url": f"/api/v1/frames/{grid_key}/{flags_filename}",
                            "available_detectors": epoch.available_detectors or [1],
                            "binary_dtype": "float32",
                        }
                    )

                if coadd.needs_wise_fallback:
                    try:
                        if fut_wise is None:
                            wise = self.wise_fallback_fetcher(
                                ra=ra,
                                dec=dec,
                                fov_arcmin=fov,
                                target_wcs_header=target_header,
                            )
                        else:
                            wise = fut_wise.result(timeout=15.0)
                        wise_data_name = "wise_fallback.bin"
                        wise_flags_name = "wise_fallback_flags.bin"
                        actual_frames[wise_data_name] = wise.detector_buffer
                        actual_frames[wise_flags_name] = wise.flags_buffer
                        epoch_entries.append(
                            {
                                "epoch_id": "wise_fallback",
                                "label": "WISE/NEOWISE archival fallback (W1/W2)",
                                "mission": "WISE",
                                "mjd": float(wise.mjd),
                                "iso_date": mjd_to_iso(wise.mjd),
                                "detectors_data_url": f"/api/v1/frames/{grid_key}/{wise_data_name}",
                                "flags_mask_url": f"/api/v1/frames/{grid_key}/{wise_flags_name}",
                                "available_detectors": wise.available_detectors or [4, 5, 6],
                                "binary_dtype": "float32",
                            }
                        )
                        all_mjds = epoch_mjds + [float(wise.mjd_start), float(wise.mjd_end)]
                        baseline_days = (
                            max(all_mjds) - min(all_mjds) if all_mjds else wise.baseline_days
                        )
                        out_manifest["data_source_summary"] = {
                            "primary_mission": "WISE",
                            "has_multi_epoch_spherex": False,
                            "uses_wise_fallback": True,
                            "baseline_days": max(float(wise.baseline_days), float(baseline_days)),
                            "status_note": (
                                f"WISE/NEOWISE W1/W2 fallback; {len(coadd.epochs)} SPHEREx epoch(s)"
                            ),
                            "provenance_tier": "extension",
                            "survey_name": "WISE / NEOWISE W1-W2",
                        }
                        out_manifest["epochs"] = epoch_entries
                        frames = actual_frames
                        _logger.info(
                            "Archival patch %s served from WISE/NEOWISE (%d SPHEREx + WISE) "
                            "in %.2fs",
                            grid_key,
                            len(coadd.epochs),
                            time.perf_counter() - t0,
                        )
                        return out_manifest, frames
                    except Exception as wise_exc:
                        fallback_errors.append(f"WISE:{type(wise_exc).__name__}")

                if len(coadd.epochs) >= 2:
                    out_manifest["epochs"] = epoch_entries
                    out_manifest["data_source_summary"] = {
                        "primary_mission": "SPHEREx",
                        "has_multi_epoch_spherex": True,
                        "uses_wise_fallback": False,
                        "baseline_days": float(coadd.baseline_days),
                        "status_note": f"{len(coadd.epochs)} real SPHEREx comparison epoch(s)",
                        "provenance_tier": "primary",
                        "survey_name": "SPHEREx IRSA Archival",
                    }
                    frames = actual_frames
                    _logger.info(
                        "Archival patch %s served from primary SPHEREx (%d epochs) in %.2fs",
                        grid_key,
                        len(coadd.epochs),
                        time.perf_counter() - t0,
                    )
                    return out_manifest, frames

                if not epoch_entries:
                    try:
                        if fut_skyview is None:
                            sv_epochs = self.skyview_fallback_fetcher(
                                ra=ra,
                                dec=dec,
                                fov_arcmin=fov,
                                target_wcs_header=target_header,
                            )
                        else:
                            sv_epochs = fut_skyview.result(timeout=15.0)
                        sv_entries: list[dict[str, Any]] = []
                        sv_frames: dict[str, bytes] = {}
                        sv_mjds: list[float] = []
                        for ep_res in sv_epochs:
                            dname = f"{ep_res.epoch_id}.bin"
                            fname = f"{ep_res.epoch_id}_flags.bin"
                            sv_frames[dname] = ep_res.detector_buffer
                            sv_frames[fname] = ep_res.flags_buffer
                            sv_mjds.append(float(ep_res.mjd))
                            sv_entries.append(
                                {
                                    "epoch_id": ep_res.epoch_id,
                                    "label": ep_res.label,
                                    "mission": "SkyView",
                                    "mjd": float(ep_res.mjd),
                                    "iso_date": mjd_to_iso(ep_res.mjd),
                                    "detectors_data_url": f"/api/v1/frames/{grid_key}/{dname}",
                                    "flags_mask_url": f"/api/v1/frames/{grid_key}/{fname}",
                                    "available_detectors": list(
                                        ep_res.available_detectors or [1, 2]
                                    ),
                                    "binary_dtype": "float32",
                                }
                            )
                        baseline_sv = (max(sv_mjds) - min(sv_mjds)) if len(sv_mjds) >= 2 else 365.0
                        out_manifest["epochs"] = sv_entries
                        out_manifest["data_source_summary"] = {
                            "primary_mission": "SkyView",
                            "has_multi_epoch_spherex": False,
                            "uses_wise_fallback": False,
                            "baseline_days": max(1.0, float(baseline_sv)),
                            "status_note": (
                                f"NASA SkyView archival extension ({len(sv_entries)} plate(s))"
                            ),
                            "provenance_tier": "extension",
                            "survey_name": "NASA SkyView (DSS2 IR / Red)",
                        }
                        frames = sv_frames
                        _logger.info(
                            "Archival patch %s served from NASA SkyView (%d plate(s)) in %.2fs",
                            grid_key,
                            len(sv_entries),
                            time.perf_counter() - t0,
                        )
                        return out_manifest, frames
                    except Exception as sv_exc:
                        fallback_errors.append(f"SkyView:{type(sv_exc).__name__}")
                elif len(coadd.epochs) == 1:
                    out_manifest["epochs"] = epoch_entries
                    out_manifest["data_source_summary"] = {
                        "primary_mission": "SPHEREx",
                        "has_multi_epoch_spherex": False,
                        "uses_wise_fallback": False,
                        "baseline_days": 0.0,
                        "status_note": "1 real SPHEREx epoch (WISE/SkyView unavailable)",
                        "provenance_tier": "primary",
                        "survey_name": "SPHEREx Single-Epoch Archival",
                    }
                    frames = actual_frames
                    return out_manifest, frames
            finally:
                pool.shutdown(wait=False, cancel_futures=True)
        except Exception as exc:
            fallback_errors.append(f"Archival:{type(exc).__name__}")

        err_text = "; ".join(fallback_errors) or "no archival coverage"
        out_manifest["data_source_summary"] = {
            "primary_mission": "Simulated",
            "has_multi_epoch_spherex": False,
            "uses_wise_fallback": False,
            "baseline_days": float(out_manifest["data_source_summary"].get("baseline_days", 182.7)),
            "status_note": (
                f"Archival SPHEREx/WISE/SkyView unavailable; simulated baseline ({err_text})"
            ),
            "provenance_tier": "simulated",
            "survey_name": "Simulated Multi-Band Baseline",
        }
        _logger.warning(
            "All archival providers exhausted for %s (%s); returning labeled simulated baseline",
            grid_key,
            err_text,
        )
        return out_manifest, frames
