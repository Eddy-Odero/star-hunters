"""Deterministic synthetic sky-patch manifests, binary cubes, and 102-band spectra."""

from __future__ import annotations

import copy
import json
import math
import random
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

import numpy as np

from app.models.contracts import (
    DEFAULT_MOLECULAR_FEATURES,
    GRID_HEIGHT,
    GRID_WIDTH,
    NUM_DETECTORS,
    SHOWCASE_TARGETS,
    validate_sky_patch_manifest,
    validate_spectrum_payload,
)
from app.services.spatial_cache import compute_grid_key
from app.services.zenith_bridge import lookup_constellation
from app.utils.astronomy import build_tan_wcs_header, pixel_to_sky


def _load_celestial_catalog_data() -> dict[str, dict[str, Any]]:
    """Load curated showcase field catalog overlays from ``celestial_catalog_data.json``."""
    data_path = Path(__file__).resolve().parent.parent / "models" / "celestial_catalog_data.json"
    if not data_path.is_file():
        return {}
    return json.loads(data_path.read_text(encoding="utf-8"))


CELESTIAL_CATALOG_DATA: dict[str, dict[str, Any]] = _load_celestial_catalog_data()
_MAX_CACHED_FRAME_SETS = 2
_PREWARMED_MANIFESTS: dict[tuple[str, bool], dict[str, Any]] = {}
_FRAME_LRU_CACHE: OrderedDict[tuple[str, tuple[Any, ...]], dict[str, bytes]] = OrderedDict()
_FRAME_CACHE_LOCK = threading.Lock()
_PREWARMED_SPECTRA: dict[str, dict[str, Any]] = {}


def _frame_cache_signature(known_objects: list[dict[str, Any]]) -> tuple[Any, ...]:
    """Compute a deterministic hashable key of objects affecting synthetic PSF synthesis.

    Args:
        known_objects: List of ``KnownCelestialObject`` dictionaries in the patch.

    Returns:
        Immutable tuple uniquely identifying the PSF-relevant object attributes.
    """
    return tuple(
        (
            str(obj.get("catalog", "gaia_dr3")),
            float(obj.get("magnitude") or 15.5),
            tuple(
                (float(ep["x"]), float(ep["y"]))
                for ep in (obj.get("epoch_positions") or [])
                if "x" in ep and "y" in ep
            ),
        )
        for obj in known_objects
    )


def _format_wise_designation(ra: float, dec: float) -> str:
    """Format ICRS ``(ra, dec)`` into standard ``Jhhmmss.ss±ddmmss.s`` WISE notation."""
    ra_norm = (ra % 360.0) / 15.0
    rh = int(ra_norm)
    rm = int((ra_norm - rh) * 60.0)
    rs = ((ra_norm - rh) * 60.0 - rm) * 60.0
    sign = "+" if dec >= 0 else "-"
    adec = abs(dec)
    dd = int(adec)
    dm = int((adec - dd) * 60.0)
    ds = ((adec - dd) * 60.0 - dm) * 60.0
    return f"J{rh:02d}{rm:02d}{rs:05.2f}{sign}{dd:02d}{dm:02d}{ds:04.1f}"


def _epoch_positions_linear(
    p1_x: float,
    p1_y: float,
    p2_x: float,
    p2_y: float,
    wcs: dict[str, Any],
    epochs_meta: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Linearly interpolate pixel/sky coordinates between ``(p1_x, p1_y)`` and ``(p2_x, p2_y)``."""
    positions: list[dict[str, Any]] = []
    num_epochs = len(epochs_meta)
    for idx, ep in enumerate(epochs_meta):
        frac = 0.0 if num_epochs <= 1 else idx / float(num_epochs - 1)
        ex = round(p1_x + frac * (p2_x - p1_x), 2)
        ey = round(p1_y + frac * (p2_y - p1_y), 2)
        era, edec = pixel_to_sky(ex, ey, wcs)
        positions.append(
            {
                "epoch_id": ep["epoch_id"],
                "mjd": ep["mjd"],
                "ra": era,
                "dec": edec,
                "x": ex,
                "y": ey,
            }
        )
    return positions


def _build_coordinate_seeded_catalog(
    ra: float,
    dec: float,
    wcs: dict[str, Any],
    epochs_meta: list[dict[str, Any]],
) -> dict[str, Any]:
    """Generate a deterministic, SPHEREx-trackable multi-catalog field for any ``(ra, dec)``."""
    seed_val = int(round((ra % 360.0) * 1000.0) * 1_000_000 + round((dec + 90.0) * 1000.0))
    rng = random.Random(seed_val)

    gaia_dr3: list[dict[str, Any]] = []
    wise_sources: list[dict[str, Any]] = []
    most_solar_system: list[dict[str, Any]] = []
    known_objects: list[dict[str, Any]] = []

    p1_x, p1_y = 124.0, 126.0
    p2_x, p2_y = 132.0, 130.0
    placed: list[tuple[float, float]] = [(p1_x, p1_y), (p2_x, p2_y)]

    def _can_place(x: float, y: float, min_dist: float = 11.2) -> bool:
        if not (14.0 <= x <= 242.0 and 14.0 <= y <= 242.0):
            return False
        return all(math.hypot(x - px, y - py) >= min_dist for px, py in placed)

    p1_ra, p1_dec = pixel_to_sky(p1_x, p1_y, wcs)
    target_epoch_positions = _epoch_positions_linear(p1_x, p1_y, p2_x, p2_y, wcs, epochs_meta)

    constellation = lookup_constellation(ra, dec)
    wise_id = _format_wise_designation(p1_ra, p1_dec)
    w1_mag = round(14.8 + rng.uniform(-1.2, 1.8), 2)
    w2_mag = round(w1_mag - rng.uniform(1.4, 2.8), 2)
    w1_w2 = round(w1_mag - w2_mag, 2)
    pm_primary = round(rng.uniform(2.4, 7.8), 2)

    wise_sources.append(
        {
            "source_id": wise_id,
            "ra": p1_ra,
            "dec": p1_dec,
            "x": p1_x,
            "y": p1_y,
            "w1_mag": w1_mag,
            "w2_mag": w2_mag,
            "w1_w2_color": w1_w2,
        }
    )
    known_objects.append(
        {
            "object_id": f"wise:{wise_id}",
            "label": f"WISE {wise_id} ({constellation} IR Mover)",
            "catalog": "wise",
            "object_type": "brown_dwarf_candidate",
            "ra": p1_ra,
            "dec": p1_dec,
            "x": p1_x,
            "y": p1_y,
            "magnitude": w2_mag,
            "proper_motion_arcsec_yr": pm_primary,
            "w1_w2_color": w1_w2,
            "default_checked": True,
            "epoch_positions": target_epoch_positions,
        }
    )

    base_gaia_id = 4000000000000000000 + (seed_val % 900000000000000000)
    for idx in range(90):
        cand_x = round(rng.uniform(16.0, 240.0), 2)
        cand_y = round(rng.uniform(16.0, 240.0), 2)
        if not _can_place(cand_x, cand_y):
            continue
        placed.append((cand_x, cand_y))
        s_ra, s_dec = pixel_to_sky(cand_x, cand_y, wcs)
        ep_positions = [
            {
                "epoch_id": ep["epoch_id"],
                "mjd": ep["mjd"],
                "ra": s_ra,
                "dec": s_dec,
                "x": cand_x,
                "y": cand_y,
            }
            for ep in epochs_meta
        ]
        if idx % 4 != 3:
            sid = str(base_gaia_id + idx * 131071)
            g_mag = round(rng.uniform(11.8, 17.8), 2)
            bp_rp = round(rng.uniform(0.55, 2.65), 2)
            is_high_pm = idx == 0
            pmra = round(rng.uniform(-220.0, 220.0) if is_high_pm else rng.uniform(-18.0, 18.0), 2)
            pmdec = round(rng.uniform(-220.0, 220.0) if is_high_pm else rng.uniform(-18.0, 18.0), 2)
            pm_tot = round(math.hypot(pmra, pmdec) / 1000.0, 3)
            gaia_dr3.append(
                {
                    "source_id": sid,
                    "ra": s_ra,
                    "dec": s_dec,
                    "x": cand_x,
                    "y": cand_y,
                    "g_mag": g_mag,
                    "bp_rp": bp_rp,
                    "pmra": pmra,
                    "pmdec": pmdec,
                }
            )
            known_objects.append(
                {
                    "object_id": f"gaia:{sid}",
                    "label": (
                        f"Gaia DR3 {sid} (High-PM Star)" if pm_tot >= 0.15 else f"Gaia DR3 {sid}"
                    ),
                    "catalog": "gaia_dr3",
                    "object_type": "high_pm_star" if pm_tot >= 0.15 else "star",
                    "ra": s_ra,
                    "dec": s_dec,
                    "x": cand_x,
                    "y": cand_y,
                    "magnitude": g_mag,
                    "proper_motion_arcsec_yr": pm_tot,
                    "w1_w2_color": None,
                    "default_checked": pm_tot >= 0.15,
                    "epoch_positions": ep_positions,
                }
            )
        else:
            wid = _format_wise_designation(s_ra, s_dec)
            fw1 = round(rng.uniform(12.2, 16.0), 2)
            fw2 = round(fw1 - rng.uniform(-0.15, 1.15), 2)
            f_color = round(fw1 - fw2, 2)
            is_bd = f_color >= 0.85
            wise_sources.append(
                {
                    "source_id": wid,
                    "ra": s_ra,
                    "dec": s_dec,
                    "x": cand_x,
                    "y": cand_y,
                    "w1_mag": fw1,
                    "w2_mag": fw2,
                    "w1_w2_color": f_color,
                }
            )
            known_objects.append(
                {
                    "object_id": f"wise:{wid}",
                    "label": (
                        f"AllWISE {wid} (IR Brown Dwarf Candidate)" if is_bd else f"AllWISE {wid}"
                    ),
                    "catalog": "wise",
                    "object_type": "brown_dwarf_candidate" if is_bd else "infrared_source",
                    "ra": s_ra,
                    "dec": s_dec,
                    "x": cand_x,
                    "y": cand_y,
                    "magnitude": fw2,
                    "proper_motion_arcsec_yr": 0.025,
                    "w1_w2_color": f_color,
                    "default_checked": is_bd,
                    "epoch_positions": ep_positions,
                }
            )

    return {
        "known_objects": known_objects,
        "gaia_dr3": gaia_dr3,
        "wise_sources": wise_sources,
        "most_solar_system": most_solar_system,
    }


def build_catalog_overlays_for_patch(
    ra: float,
    dec: float,
    wcs: dict[str, Any],
    epochs_meta: list[dict[str, Any]],
    target_slug: str | None = None,
) -> dict[str, Any]:
    """Build epoch-aware ``known_objects`` and raw catalog overlay lists for a patch.

    Args:
        ra: Field center Right Ascension in degrees.
        dec: Field center Declination in degrees.
        wcs: Contract TAN WCS dictionary.
        epochs_meta: Epoch metadata dictionaries for trajectory projection.
        target_slug: Optional showcase target slug override.

    Returns:
        Dictionary with ``known_objects``, ``gaia_dr3``, ``wise_sources``, and
        ``most_solar_system``.
    """
    resolved_slug = target_slug
    if not resolved_slug:
        for cand_slug, meta in SHOWCASE_TARGETS.items():
            if math.hypot(ra - meta["ra"], dec - meta["dec"]) < 0.25:
                resolved_slug = cand_slug
                break

    if not resolved_slug or resolved_slug not in CELESTIAL_CATALOG_DATA:
        return _build_coordinate_seeded_catalog(ra=ra, dec=dec, wcs=wcs, epochs_meta=epochs_meta)

    field_data = CELESTIAL_CATALOG_DATA[resolved_slug]
    prim = field_data["primary"]
    gaia_dr3: list[dict[str, Any]] = []
    wise_sources: list[dict[str, Any]] = []
    most_solar_system: list[dict[str, Any]] = []
    known_objects: list[dict[str, Any]] = []

    p1_x, p1_y = float(prim["p1_x"]), float(prim["p1_y"])
    p1_ra, p1_dec = pixel_to_sky(p1_x, p1_y, wcs)

    if prim["catalog"] == "most" or len(epochs_meta) <= 1:
        p2_x, p2_y = float(prim["p2_x"]), float(prim["p2_y"])
    else:
        baseline_years = (float(epochs_meta[-1]["mjd"]) - float(epochs_meta[0]["mjd"])) / 365.25
        scale_arcsec_per_px = abs(float(wcs["cdelt"][1])) * 3600.0

        if "pmra" in prim and "pmdec" in prim and (prim["pmra"] or prim["pmdec"]):
            pm_ra_arcsec_yr = float(prim["pmra"]) / 1000.0
            pm_dec_arcsec_yr = float(prim["pmdec"]) / 1000.0
        else:
            dx_stub = float(prim["p2_x"]) - p1_x
            dy_stub = float(prim["p2_y"]) - p1_y
            angle = math.atan2(dy_stub, dx_stub) if (dx_stub or dy_stub) else 0.0
            pm_tot_arcsec_yr = float(prim.get("proper_motion_arcsec_yr", 0.0))
            pm_ra_arcsec_yr = -pm_tot_arcsec_yr * math.cos(angle)
            pm_dec_arcsec_yr = pm_tot_arcsec_yr * math.sin(angle)

        dx_px = -(pm_ra_arcsec_yr * baseline_years) / scale_arcsec_per_px
        dy_px = (pm_dec_arcsec_yr * baseline_years) / scale_arcsec_per_px
        p2_x = round(p1_x + dx_px, 2)
        p2_y = round(p1_y + dy_px, 2)

    target_epoch_positions = _epoch_positions_linear(p1_x, p1_y, p2_x, p2_y, wcs, epochs_meta)

    prim_cat = prim["catalog"]
    if prim_cat == "most":
        for ep_pos in target_epoch_positions:
            most_solar_system.append(
                {
                    "object_name": str(prim["source_id"]),
                    "epoch_id": ep_pos["epoch_id"],
                    "ra": ep_pos["ra"],
                    "dec": ep_pos["dec"],
                    "x": ep_pos["x"],
                    "y": ep_pos["y"],
                    "v_mag": float(prim.get("v_mag", prim["magnitude"])),
                }
            )
    elif prim_cat == "gaia_dr3":
        gaia_dr3.append(
            {
                "source_id": str(prim["source_id"]),
                "ra": p1_ra,
                "dec": p1_dec,
                "x": p1_x,
                "y": p1_y,
                "g_mag": float(prim.get("g_mag", prim["magnitude"])),
                "bp_rp": float(prim.get("bp_rp", 2.8)),
                "pmra": float(prim.get("pmra", 0.0)),
                "pmdec": float(prim.get("pmdec", 0.0)),
            }
        )
    else:
        wise_sources.append(
            {
                "source_id": str(prim["source_id"]),
                "ra": p1_ra,
                "dec": p1_dec,
                "x": p1_x,
                "y": p1_y,
                "w1_mag": float(prim.get("w1_mag", prim["magnitude"])),
                "w2_mag": float(prim.get("w2_mag", prim["magnitude"])),
                "w1_w2_color": float(prim.get("w1_w2_color", 1.2)),
            }
        )

    known_objects.append(
        {
            "object_id": str(prim["object_id"]),
            "label": str(prim["label"]),
            "catalog": prim_cat,
            "object_type": str(prim["object_type"]),
            "ra": p1_ra,
            "dec": p1_dec,
            "x": p1_x,
            "y": p1_y,
            "magnitude": float(prim["magnitude"]),
            "proper_motion_arcsec_yr": float(prim["proper_motion_arcsec_yr"]),
            "w1_w2_color": prim.get("w1_w2_color"),
            "default_checked": True,
            "epoch_positions": target_epoch_positions,
        }
    )

    notable_count = 1
    for g in field_data.get("gaia_dr3", []):
        gx, gy = float(g["x"]), float(g["y"])
        s_ra, s_dec = pixel_to_sky(gx, gy, wcs)
        sid = str(g["source_id"])
        g_mag = float(g["g_mag"])
        bp_rp = float(g["bp_rp"]) if g.get("bp_rp") is not None else None
        pmra = float(g.get("pmra") or 0.0)
        pmdec = float(g.get("pmdec") or 0.0)
        pm_tot = round(math.hypot(pmra, pmdec) / 1000.0, 3)
        is_high_pm = pm_tot >= 0.05
        is_checked = is_high_pm and notable_count < 6
        if is_checked:
            notable_count += 1
        gaia_dr3.append(
            {
                "source_id": sid,
                "ra": s_ra,
                "dec": s_dec,
                "x": gx,
                "y": gy,
                "g_mag": g_mag,
                "bp_rp": bp_rp,
                "pmra": pmra,
                "pmdec": pmdec,
            }
        )
        ep_positions = [
            {
                "epoch_id": ep["epoch_id"],
                "mjd": ep["mjd"],
                "ra": s_ra,
                "dec": s_dec,
                "x": gx,
                "y": gy,
            }
            for ep in epochs_meta
        ]
        known_objects.append(
            {
                "object_id": f"gaia:{sid}",
                "label": (f"Gaia DR3 {sid} (High-PM Star)" if is_high_pm else f"Gaia DR3 {sid}"),
                "catalog": "gaia_dr3",
                "object_type": "high_pm_star" if is_high_pm else "star",
                "ra": s_ra,
                "dec": s_dec,
                "x": gx,
                "y": gy,
                "magnitude": g_mag,
                "proper_motion_arcsec_yr": pm_tot,
                "w1_w2_color": None,
                "default_checked": is_checked,
                "epoch_positions": ep_positions,
            }
        )

    for w in field_data.get("wise_sources", []):
        wx, wy = float(w["x"]), float(w["y"])
        w_ra, w_dec = pixel_to_sky(wx, wy, wcs)
        wid = str(w["source_id"])
        w1 = float(w["w1_mag"])
        w2 = float(w["w2_mag"])
        w_color = float(w["w1_w2_color"])
        is_bd = w_color >= 0.75
        is_checked = is_bd and notable_count < 6
        if is_checked:
            notable_count += 1
        wise_sources.append(
            {
                "source_id": wid,
                "ra": w_ra,
                "dec": w_dec,
                "x": wx,
                "y": wy,
                "w1_mag": w1,
                "w2_mag": w2,
                "w1_w2_color": w_color,
            }
        )
        ep_positions = [
            {
                "epoch_id": ep["epoch_id"],
                "mjd": ep["mjd"],
                "ra": w_ra,
                "dec": w_dec,
                "x": wx,
                "y": wy,
            }
            for ep in epochs_meta
        ]
        known_objects.append(
            {
                "object_id": f"wise:{wid}",
                "label": (f"AllWISE {wid} (Red IR Candidate)" if is_bd else f"AllWISE {wid}"),
                "catalog": "wise",
                "object_type": "brown_dwarf_candidate" if is_bd else "infrared_source",
                "ra": w_ra,
                "dec": w_dec,
                "x": wx,
                "y": wy,
                "magnitude": w2,
                "proper_motion_arcsec_yr": 0.015,
                "w1_w2_color": w_color,
                "default_checked": is_checked,
                "epoch_positions": ep_positions,
            }
        )

    return {
        "known_objects": known_objects,
        "gaia_dr3": gaia_dr3,
        "wise_sources": wise_sources,
        "most_solar_system": most_solar_system,
    }


def generate_synthetic_epoch_frames(
    slug: str = "wise_0855",
    manifest: dict[str, Any] | None = None,
) -> dict[str, bytes]:
    """Generate deterministic ``(6, 256, 256)`` float32 and ``(256, 256)`` uint8 buffers.

    Renders every ``KnownCelestialObject`` in the sky patch across survey passes
    using vectorized NumPy PSF synthesis.

    Args:
        slug: Showcase target slug used for cache lookup and SED weighting.
        manifest: Optional pre-built sky-patch manifest dictionary.

    Returns:
        Mapping of frame filenames (``pass_1.bin``, ``pass_2.bin``,
        ``pass_1_flags.bin``, ``pass_2_flags.bin``) to raw little-endian bytes.
    """
    if manifest is None:
        meta = SHOWCASE_TARGETS.get(slug, SHOWCASE_TARGETS["wise_0855"])
        manifest = build_sky_patch_manifest_payload(
            ra=meta["ra"],
            dec=meta["dec"],
            fov_arcmin=5.0,
            slug=slug if slug in SHOWCASE_TARGETS else None,
        )

    resolved_slug = manifest.get("target_metadata", {}).get("slug", slug)
    known_objects = manifest.get("catalog_overlays", {}).get("known_objects", [])
    cache_key = (str(resolved_slug), _frame_cache_signature(known_objects))
    with _FRAME_CACHE_LOCK:
        cached_frames = _FRAME_LRU_CACHE.get(cache_key)
        if cached_frames is not None:
            _FRAME_LRU_CACHE.move_to_end(cache_key)
            return dict(cached_frames)
    cold_only_primary = resolved_slug in ("wise_0855", "epsilon_indi_b", "luhman_16")
    variable_primary = resolved_slug in ("rw_aurigae", "r_draconis", "cw_leonis", "t_tauri")
    det_indices = np.arange(NUM_DETECTORS, dtype=np.float32)

    if cold_only_primary:
        primary_weights_base = np.array([0.03, 0.03, 0.03, 0.45, 1.85, 1.85], dtype=np.float32)
    else:
        primary_weights_base = np.full(NUM_DETECTORS, 1.15, dtype=np.float32)
    wise_weights_base = (0.65 + 0.16 * det_indices).astype(np.float32)
    gaia_weights_base = (1.38 - 0.15 * det_indices).astype(np.float32)

    def _build_pass(pass_idx: int) -> bytes:
        cube = np.full((NUM_DETECTORS, GRID_HEIGHT, GRID_WIDTH), 0.02, dtype="<f4")

        def _add_psf_all_detectors(
            cx: float,
            cy: float,
            det_weights: np.ndarray,
            sigma: float,
        ) -> None:
            x_min = max(0, int(cx - 6))
            x_max = min(GRID_WIDTH - 1, int(cx + 6))
            y_min = max(0, int(cy - 6))
            y_max = min(GRID_HEIGHT - 1, int(cy + 6))
            if x_min > x_max or y_min > y_max:
                return
            xs = np.arange(x_min, x_max + 1, dtype=np.float32) - np.float32(cx)
            ys = np.arange(y_min, y_max + 1, dtype=np.float32) - np.float32(cy)
            r2 = ys[:, None] ** 2 + xs[None, :] ** 2
            psf = np.exp(-r2 / np.float32(2.0 * sigma * sigma))
            cube[:, y_min : y_max + 1, x_min : x_max + 1] += (
                det_weights[:, None, None] * psf[None, :, :]
            )

        for obj_idx, obj in enumerate(known_objects):
            ep_positions = obj.get("epoch_positions", [])
            if not ep_positions:
                continue
            ep_pos = ep_positions[min(pass_idx, len(ep_positions) - 1)]
            cx = float(ep_pos["x"])
            cy = float(ep_pos["y"])

            if obj_idx == 0:
                t_scale = (
                    2.0
                    if (variable_primary and pass_idx == 0)
                    else (6.5 if variable_primary else 5.8)
                )
                _add_psf_all_detectors(cx, cy, primary_weights_base * np.float32(t_scale), 1.75)
            else:
                mag = float(obj.get("magnitude") or 15.5)
                base_flux = np.float32(max(1.85, min(4.6, 2.4 + (16.2 - mag) * 0.32)))
                is_wise = obj.get("catalog", "gaia_dr3") == "wise"
                base_weights = wise_weights_base if is_wise else gaia_weights_base
                _add_psf_all_detectors(cx, cy, base_weights * base_flux, 1.60)

        return cube.tobytes(order="C")

    flags = np.zeros((GRID_HEIGHT, GRID_WIDTH), dtype=np.uint8)
    flags[10, 10] = 1
    flags[240, 240] = 2
    flags_bytes = flags.tobytes(order="C")

    result = {
        "pass_1.bin": _build_pass(0),
        "pass_2.bin": _build_pass(1),
        "pass_1_flags.bin": flags_bytes,
        "pass_2_flags.bin": flags_bytes,
    }
    with _FRAME_CACHE_LOCK:
        _FRAME_LRU_CACHE[cache_key] = result
        _FRAME_LRU_CACHE.move_to_end(cache_key)
        while len(_FRAME_LRU_CACHE) > _MAX_CACHED_FRAME_SETS:
            _FRAME_LRU_CACHE.popitem(last=False)
    return dict(result)


def build_sky_patch_manifest_payload(
    ra: float,
    dec: float,
    fov_arcmin: float = 5.0,
    slug: str | None = None,
    static_preset_urls: bool = False,
) -> dict[str, Any]:
    """Construct a complete, schema-validated ``SkyPatchManifest`` dictionary.

    Args:
        ra: Field center Right Ascension in degrees.
        dec: Field center Declination in degrees.
        fov_arcmin: Field of view in arcminutes.
        slug: Optional showcase target slug override.
        static_preset_urls: Whether frame and spectrum URLs target ``/presets/...``.

    Returns:
        Schema-validated ``SkyPatchManifest`` dictionary.
    """
    grid_key, _, _ = compute_grid_key(ra, dec, fov_arcmin)
    resolved_slug = slug
    if not resolved_slug:
        for cand_slug, meta in SHOWCASE_TARGETS.items():
            if math.hypot(ra - meta["ra"], dec - meta["dec"]) < 0.25:
                resolved_slug = cand_slug
                break

    if (
        resolved_slug in SHOWCASE_TARGETS
        and abs(fov_arcmin - 5.0) < 1e-4
        and math.hypot(
            ra - SHOWCASE_TARGETS[resolved_slug]["ra"],
            dec - SHOWCASE_TARGETS[resolved_slug]["dec"],
        )
        < 1e-3
    ):
        cache_tuple = (resolved_slug, static_preset_urls)
        if cache_tuple in _PREWARMED_MANIFESTS:
            return copy.deepcopy(_PREWARMED_MANIFESTS[cache_tuple])

    target_meta = dict(
        SHOWCASE_TARGETS.get(
            resolved_slug or "",
            {
                "slug": "custom_patch",
                "name": f"Sky Patch ({ra:.2f}, {dec:.2f})",
                "category": "Custom Sky Exploration",
                "description": "Multi-epoch near-infrared SPHEREx + WISE/Gaia exploration patch.",
                "constellation": lookup_constellation(ra, dec),
            },
        )
    )

    wcs = build_tan_wcs_header(ra, dec, fov_arcmin, crpix=128.0, fits_keywords=False)
    base_prefix = (
        f"/presets/{target_meta['slug']}" if static_preset_urls else f"/api/v1/frames/{grid_key}"
    )
    epochs = [
        {
            "epoch_id": "pass_1",
            "label": "Pass 1 (SPHEREx)",
            "mission": "SPHEREx",
            "mjd": 60810.5,
            "iso_date": "2025-05-15T12:00:00Z",
            "detectors_data_url": f"{base_prefix}/pass_1.bin",
            "flags_mask_url": f"{base_prefix}/pass_1_flags.bin",
            "available_detectors": [1, 2, 3, 4, 5, 6],
            "binary_dtype": "float32",
        },
        {
            "epoch_id": "pass_2",
            "label": "Pass 2 (SPHEREx)",
            "mission": "SPHEREx",
            "mjd": 60993.2,
            "iso_date": "2025-11-14T04:48:00Z",
            "detectors_data_url": f"{base_prefix}/pass_2.bin",
            "flags_mask_url": f"{base_prefix}/pass_2_flags.bin",
            "available_detectors": [1, 2, 3, 4, 5, 6],
            "binary_dtype": "float32",
        },
    ]

    catalog_overlays = build_catalog_overlays_for_patch(
        ra=ra,
        dec=dec,
        wcs=wcs,
        epochs_meta=epochs,
        target_slug=resolved_slug,
    )

    spectrum_url = (
        f"/presets/{target_meta['slug']}/spectrum.json"
        if static_preset_urls
        else f"/api/v1/spectrum?ra={ra:.4f}&dec={dec:.4f}"
    )

    manifest = {
        "query": {
            "ra": round(ra, 4),
            "dec": round(dec, 4),
            "fov_arcmin": round(fov_arcmin, 2),
            "grid_key": grid_key,
            "cached": False,
        },
        "target_metadata": {
            "slug": target_meta["slug"],
            "name": target_meta["name"],
            "category": target_meta["category"],
            "description": target_meta["description"],
            "constellation": target_meta["constellation"],
        },
        "data_source_summary": {
            "primary_mission": (
                "SPHEREx"
                if (static_preset_urls or resolved_slug in SHOWCASE_TARGETS)
                else "Simulated"
            ),
            "has_multi_epoch_spherex": bool(resolved_slug in SHOWCASE_TARGETS),
            "uses_wise_fallback": False,
            "baseline_days": 182.7,
            "status_note": (
                "2 SPHEREx survey passes (6-month baseline)"
                if resolved_slug in SHOWCASE_TARGETS
                else "Simulated multi-band reference baseline (archival lookup pending)"
            ),
            "provenance_tier": "simulated",
            "survey_name": (
                "Simulated SPHEREx Showcase Baseline"
                if resolved_slug in SHOWCASE_TARGETS
                else "Simulated Multi-Band Reference"
            ),
        },
        "wcs": wcs,
        "epochs": epochs,
        "default_spectrum_url": spectrum_url,
        "catalog_overlays": catalog_overlays,
    }
    validate_sky_patch_manifest(manifest)
    if (
        resolved_slug in SHOWCASE_TARGETS
        and abs(fov_arcmin - 5.0) < 1e-4
        and math.hypot(
            ra - SHOWCASE_TARGETS[resolved_slug]["ra"],
            dec - SHOWCASE_TARGETS[resolved_slug]["dec"],
        )
        < 1e-3
    ):
        _PREWARMED_MANIFESTS[(resolved_slug, static_preset_urls)] = copy.deepcopy(manifest)
    return manifest


def build_spectrum_payload(
    ra: float,
    dec: float,
    source_label: str = "WISE 0855",
    slug: str | None = None,
) -> dict[str, Any]:
    """Generate a target-tailored 102-channel SPHEREx spectrophotometry payload (0.75-5.0 um).

    Args:
        ra: Target Right Ascension in degrees.
        dec: Target Declination in degrees.
        source_label: Human-readable label recorded on the payload.
        slug: Optional showcase target slug override.

    Returns:
        Schema-validated 102-channel ``SpectrumPayload`` dictionary.
    """
    resolved_slug = slug
    if not resolved_slug:
        for cand_slug, meta in SHOWCASE_TARGETS.items():
            if (
                cand_slug == source_label.lower()
                or meta["name"].lower() in source_label.lower()
                or math.hypot(ra - meta["ra"], dec - meta["dec"]) < 0.25
            ):
                resolved_slug = cand_slug
                break

    if (
        resolved_slug in _PREWARMED_SPECTRA
        and math.hypot(
            ra - SHOWCASE_TARGETS[resolved_slug]["ra"],
            dec - SHOWCASE_TARGETS[resolved_slug]["dec"],
        )
        < 1e-3
    ):
        cached = copy.deepcopy(_PREWARMED_SPECTRA[resolved_slug])
        cached["ra"] = round(ra, 4)
        cached["dec"] = round(dec, 4)
        cached["source_label"] = source_label
        return cached

    channels: list[dict[str, Any]] = []
    for idx in range(102):
        band_index = idx + 1
        detector = min(NUM_DETECTORS, (idx // 17) + 1)
        wl = round(0.75 + (4.25 * idx) / 101.0, 4)

        h2o_dip = 1.0 - 0.58 * math.exp(-((wl - 3.08) ** 2) / (2.0 * 0.09**2))
        ch4_dip = 1.0 - 0.68 * math.exp(-((wl - 3.35) ** 2) / (2.0 * 0.08**2))
        co_dip = 1.0 - 0.45 * math.exp(-((wl - 4.67) ** 2) / (2.0 * 0.07**2))
        co2_peak = 0.40 * math.exp(-((wl - 4.26) ** 2) / (2.0 * 0.04**2))

        if resolved_slug == "barnards_star":
            continuum = 4.6 * math.exp(-((wl - 1.35) ** 2) / (2.0 * 0.85**2)) + (1.8 / (wl**1.4))
            raw_flux = continuum * (0.75 + 0.25 * h2o_dip) * co_dip
        elif resolved_slug == "comet_3i_atlas":
            solar_reflected = 1.2 * math.exp(-((wl - 1.1) ** 2) / (2.0 * 0.9**2))
            thermal_tail = 1.1 * math.exp(-((wl - 4.8) ** 2) / (2.0 * 0.65**2))
            h2o_emission = 1.85 * math.exp(-((wl - 3.05) ** 2) / (2.0 * 0.07**2))
            co2_coma = 3.20 * math.exp(-((wl - 4.26) ** 2) / (2.0 * 0.045**2))
            co_coma = 1.10 * math.exp(-((wl - 4.67) ** 2) / (2.0 * 0.05**2))
            raw_flux = solar_reflected + thermal_tail + h2o_emission + co2_coma + co_coma
        elif resolved_slug == "r_draconis":
            continuum = 3.2 * math.exp(-((wl - 2.1) ** 2) / (2.0 * 1.35**2)) + 1.4
            raw_flux = continuum * h2o_dip * co_dip
        elif resolved_slug == "rw_aurigae":
            photosphere = 2.4 * math.exp(-((wl - 1.5) ** 2) / (2.0 * 0.9**2))
            disk_excess = 2.6 * (1.0 - math.exp(-(((wl - 0.7) / 2.2) ** 2)))
            raw_flux = (photosphere + disk_excess) * (0.82 + 0.18 * h2o_dip) * co_dip
        elif resolved_slug == "epsilon_indi_b":
            nir_peaks = 1.35 * math.exp(-((wl - 1.25) ** 2) / (2.0 * 0.35**2))
            mid_ir_peak = 3.10 * math.exp(-((wl - 4.50) ** 2) / (2.0 * 0.48**2))
            raw_flux = (0.08 + nir_peaks + mid_ir_peak) * h2o_dip * ch4_dip * co_dip
        elif resolved_slug == "luhman_16":
            nir_peaks = 2.15 * math.exp(-((wl - 1.55) ** 2) / (2.0 * 0.48**2))
            mid_ir_peak = 2.85 * math.exp(-((wl - 4.10) ** 2) / (2.0 * 0.52**2))
            raw_flux = (0.14 + nir_peaks + mid_ir_peak) * (0.65 + 0.35 * h2o_dip) * ch4_dip * co_dip
        elif resolved_slug == "wolf_359":
            continuum = 3.85 * math.exp(-((wl - 1.65) ** 2) / (2.0 * 0.78**2)) + (1.45 / (wl**1.25))
            raw_flux = continuum * (0.68 + 0.32 * h2o_dip) * co_dip
        elif resolved_slug == "teegardens_star":
            continuum = 3.45 * math.exp(-((wl - 1.80) ** 2) / (2.0 * 0.82**2)) + (1.30 / (wl**1.15))
            raw_flux = continuum * (0.62 + 0.38 * h2o_dip) * (0.85 + 0.15 * ch4_dip) * co_dip
        elif resolved_slug == "cw_leonis":
            dust_continuum = 0.35 + 4.85 * ((wl / 5.0) ** 2.15)
            c2h2_dip = 1.0 - 0.52 * math.exp(-((wl - 3.05) ** 2) / (2.0 * 0.08**2))
            raw_flux = dust_continuum * c2h2_dip * co_dip
        elif resolved_slug == "t_tauri":
            photosphere = 2.1 * math.exp(-((wl - 1.65) ** 2) / (2.0 * 0.85**2))
            envelope_ir = 3.15 * ((wl / 4.5) ** 1.35)
            co2_ice_dip = 1.0 - 0.48 * math.exp(-((wl - 4.27) ** 2) / (2.0 * 0.045**2))
            raw_flux = (photosphere + envelope_ir) * h2o_dip * co2_ice_dip * co_dip
        elif resolved_slug == "ceres_asteroid":
            solar_reflected = 2.65 * math.exp(-((wl - 1.20) ** 2) / (2.0 * 0.95**2)) + (0.85 / wl)
            thermal_tail = 1.75 * math.exp(-((wl - 4.85) ** 2) / (2.0 * 0.55**2))
            nh4_dip = 1.0 - 0.42 * math.exp(-((wl - 3.06) ** 2) / (2.0 * 0.11**2))
            carbonate_dip = 1.0 - 0.35 * math.exp(-((wl - 3.95) ** 2) / (2.0 * 0.09**2))
            raw_flux = (solar_reflected + thermal_tail) * nh4_dip * carbonate_dip
        else:
            continuum = 0.03 + 4.2 * math.exp(-((wl - 4.55) ** 2) / (2.0 * 0.42**2))
            raw_flux = continuum * h2o_dip * ch4_dip + 0.15 * co2_peak

        flux = round(max(0.005, raw_flux), 4)
        variance = round(max(0.0004, (0.04 * flux) ** 2), 6)

        channels.append(
            {
                "band_index": band_index,
                "detector": detector,
                "wavelength_um": wl,
                "flux": flux,
                "variance": variance,
                "flagged": False,
            }
        )

    payload = {
        "ra": round(ra, 4),
        "dec": round(dec, 4),
        "source_label": source_label,
        "spectrum_origin": "SPHEREx 102-Band Forced Photometry",
        "units": {"wavelength": "um", "flux": "MJy/sr"},
        "channels": channels,
        "molecular_features": [dict(feature) for feature in DEFAULT_MOLECULAR_FEATURES],
    }
    validate_spectrum_payload(payload)
    if (
        resolved_slug in SHOWCASE_TARGETS
        and math.hypot(
            ra - SHOWCASE_TARGETS[resolved_slug]["ra"],
            dec - SHOWCASE_TARGETS[resolved_slug]["dec"],
        )
        < 1e-3
    ):
        _PREWARMED_SPECTRA[resolved_slug] = copy.deepcopy(payload)
    return payload
