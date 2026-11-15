"""FastAPI entrypoint and contract routes for Star Hunters."""

from __future__ import annotations

import math
import os
import random
import struct
from datetime import UTC, datetime
from typing import Any, Literal

from .models.contracts import (
    BINARY_FLAGS_UINT8_BYTES,
    DEFAULT_MOLECULAR_FEATURES,
    GRID_HEIGHT,
    GRID_WIDTH,
    NUM_DETECTORS,
    PIXELS_PER_PLANE,
    SHOWCASE_TARGETS,
    TOTAL_DETECTOR_VALUES,
    WORLD_CAPITAL_CITIES,
    convert_float32_bytes_to_float16_bytes,
    validate_catalogs_response,
    validate_earth_to_sky_response,
    validate_sky_patch_manifest,
    validate_spectrum_payload,
)
from .services.spatial_cache import SpatialSqliteCache, compute_grid_key

try:
    from fastapi import FastAPI, Header, HTTPException, Query, Response
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.middleware.gzip import GZipMiddleware

    HAS_FASTAPI = True
except ImportError:  # pragma: no cover
    HAS_FASTAPI = False


# ---------------------------------------------------------------------------
# Deterministic Astronomical Helpers & Contract Payload Builders
# ---------------------------------------------------------------------------

CONSTELLATION_BANDS: list[tuple[float, float, float, float, str]] = [
    (0.0, 90.0, 15.0, 90.0, "Cassiopeia"),
    (60.0, 100.0, 15.0, 45.0, "Auriga"),
    (110.0, 160.0, -25.0, 5.0, "Hydra"),
    (230.0, 265.0, 50.0, 80.0, "Draco"),
    (250.0, 280.0, -10.0, 15.0, "Ophiuchus"),
    (275.0, 305.0, -10.0, 15.0, "Aquila"),
    (280.0, 310.0, -35.0, -10.0, "Sagittarius"),
    (310.0, 350.0, -70.0, -40.0, "Indus"),
]


def lookup_constellation(ra: float, dec: float) -> str:
    """Resolve approximate constellation name for (ra, dec) in ICRS degrees."""
    ra_norm = ra % 360.0
    for ra_min, ra_max, dec_min, dec_max, name in CONSTELLATION_BANDS:
        if ra_min <= ra_norm <= ra_max and dec_min <= dec <= dec_max:
            return name
    if dec > 45.0:
        return "Ursa Major"
    if dec < -45.0:
        return "Carina"
    quadrant = int((ra_norm // 90.0) % 4)
    return ["Pegasus", "Orion", "Virgo", "Aquila"][quadrant]


def pick_random_capital_city(seed: int | None = None) -> dict[str, Any]:
    """Select a random world capital city when user geolocation is unavailable."""
    rng = random.Random(seed) if seed is not None else random
    return dict(rng.choice(WORLD_CAPITAL_CITIES))


def find_matching_capital_city(
    lat: float,
    lon: float,
    tolerance_deg: float = 0.08,
) -> dict[str, Any] | None:
    """Return capital city metadata if (lat, lon) matches a curated world capital."""
    for city in WORLD_CAPITAL_CITIES:
        if math.hypot(lat - city["lat"], lon - city["lon"]) <= tolerance_deg:
            return dict(city)
    return None


def compute_zenith_icrs(
    lat: float | None = None,
    lon: float | None = None,
    iso_time: str | None = None,
    fallback_seed: int | None = None,
) -> dict[str, Any]:
    """Compute overhead Zenith (RA, Dec) in ICRS for Earth (lat, lon, iso_time).

    If `lat` or `lon` is None (user location unavailable), picks a random capital city.
    """
    is_fallback_capital = False
    city_name: str | None = None
    country: str | None = None

    if lat is None or lon is None:
        capital = pick_random_capital_city(seed=fallback_seed)
        lat = float(capital["lat"])
        lon = float(capital["lon"])
        city_name = str(capital["city_name"])
        country = str(capital["country"])
        is_fallback_capital = True
    else:
        if not (-90.0 <= lat <= 90.0):
            raise ValueError("Latitude must be in [-90.0, 90.0]")
        if not (-180.0 <= lon <= 180.0):
            raise ValueError("Longitude must be in [-180.0, 180.0]")
        matched = find_matching_capital_city(lat, lon)
        if matched is not None:
            city_name = str(matched["city_name"])
            country = str(matched["country"])

    if iso_time:
        clean_iso = iso_time.replace("Z", "+00:00")
        dt = datetime.fromisoformat(clean_iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        else:
            dt = dt.astimezone(UTC)
        iso_out = dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    else:
        dt = datetime.now(UTC)
        iso_out = dt.strftime("%Y-%m-%dT%H:%M:%SZ")

    # Julian Date & Greenwich Mean Sidereal Time (GMST) in degrees
    unix_ts = dt.timestamp()
    jd = unix_ts / 86400.0 + 2440587.5
    d_j2000 = jd - 2451545.0
    gmst_deg = (280.46061837 + 360.98564736629 * d_j2000) % 360.0
    lst_deg = (gmst_deg + lon) % 360.0
    dec_deg = round(float(lat), 4)
    ra_deg = round(float(lst_deg), 4)

    payload = {
        "earth": {
            "lat": round(float(lat), 4),
            "lon": round(float(lon), 4),
            "iso_time": iso_out,
            "city_name": city_name,
            "country": country,
            "is_fallback_capital": is_fallback_capital,
            "cached": False,
        },
        "zenith_icrs": {
            "ra": ra_deg,
            "dec": dec_deg,
            "constellation": lookup_constellation(ra_deg, dec_deg),
        },
    }
    validate_earth_to_sky_response(payload)
    return payload


def build_wcs_header(ra: float, dec: float, fov_arcmin: float = 5.0) -> dict[str, Any]:
    """Build standard 256x256 TAN WCS header for a given sky patch."""
    fov_deg = fov_arcmin / 60.0
    scale_deg = round(fov_deg / float(GRID_WIDTH), 7)
    return {
        "width": GRID_WIDTH,
        "height": GRID_HEIGHT,
        "crval": [round(ra, 4), round(dec, 4)],
        "crpix": [128.0, 128.0],
        "cdelt": [-scale_deg, scale_deg],
    }


def sky_to_pixel(
    ra: float,
    dec: float,
    wcs: dict[str, Any],
) -> tuple[float, float]:
    """Project sky (ra, dec) to 256x256 TAN WCS pixel (x, y)."""
    ra0, dec0 = wcs["crval"]
    x0, y0 = wcs["crpix"]
    cdelt_x, cdelt_y = wcs["cdelt"]
    cos_dec = math.cos(math.radians(dec0))
    dra = ((ra - ra0 + 180.0) % 360.0) - 180.0
    x = x0 + (dra * cos_dec) / cdelt_x
    y = y0 + (dec - dec0) / cdelt_y
    return round(x, 2), round(y, 2)


def pixel_to_sky(
    x: float,
    y: float,
    wcs: dict[str, Any],
) -> tuple[float, float]:
    """Invert 256x256 TAN WCS pixel (x, y) to sky (ra, dec)."""
    ra0, dec0 = wcs["crval"]
    x0, y0 = wcs["crpix"]
    cdelt_x, cdelt_y = wcs["cdelt"]
    cos_dec = max(0.01, math.cos(math.radians(dec0)))
    ra = (ra0 + ((x - x0) * cdelt_x) / cos_dec) % 360.0
    dec = max(-90.0, min(90.0, dec0 + (y - y0) * cdelt_y))
    return round(ra, 5), round(dec, 5)


def build_catalog_overlays_for_patch(
    ra: float,
    dec: float,
    wcs: dict[str, Any],
    epochs_meta: list[dict[str, Any]],
    target_slug: str | None = None,
) -> dict[str, Any]:
    """Build epoch-aware known_objects (for the checkbox list UI) and raw catalog lists."""
    # Stationary field stars from Gaia DR3
    field_offsets = [
        ("57648291038471", -12.0, -12.6, 16.4, 1.25, -12.4, 4.1),
        ("57648291038472", 34.0, -28.0, 15.1, 0.92, 3.2, -5.0),
        ("57648291038473", -42.0, 31.0, 17.2, 1.68, -4.1, 2.8),
        ("57648291038474", 48.0, 39.0, 14.8, 0.78, 1.5, -1.9),
    ]
    gaia_dr3: list[dict[str, Any]] = []
    known_objects: list[dict[str, Any]] = []

    for sid, dx, dy, g_mag, bp_rp, pmra, pmdec in field_offsets:
        px = round(128.0 + dx, 1)
        py = round(128.0 + dy, 1)
        s_ra, s_dec = pixel_to_sky(px, py, wcs)
        pm_tot = round(math.hypot(pmra, pmdec) / 1000.0, 3)
        gaia_dr3.append(
            {
                "source_id": sid,
                "ra": s_ra,
                "dec": s_dec,
                "x": px,
                "y": py,
                "g_mag": g_mag,
                "bp_rp": bp_rp,
                "pmra": pmra,
                "pmdec": pmdec,
            }
        )
        epoch_positions = [
            {
                "epoch_id": ep["epoch_id"],
                "mjd": ep["mjd"],
                "ra": s_ra,
                "dec": s_dec,
                "x": px,
                "y": py,
            }
            for ep in epochs_meta
        ]
        known_objects.append(
            {
                "object_id": f"gaia:{sid}",
                "label": f"Gaia DR3 {sid}",
                "catalog": "gaia_dr3",
                "object_type": "star",
                "ra": s_ra,
                "dec": s_dec,
                "x": px,
                "y": py,
                "magnitude": g_mag,
                "proper_motion_arcsec_yr": pm_tot,
                "w1_w2_color": None,
                "default_checked": False,
                "epoch_positions": epoch_positions,
            }
        )

    wise_sources: list[dict[str, Any]] = []
    most_solar_system: list[dict[str, Any]] = []

    # Primary target / notable mover at patch center (checked by default!)
    slug = target_slug or "wise_0855"
    target_info = SHOWCASE_TARGETS.get(slug, SHOWCASE_TARGETS["wise_0855"])
    p1_x, p1_y = 124.0, 126.0
    p2_x, p2_y = 132.0, 130.0
    if slug in ("rw_aurigae", "r_draconis"):
        p1_x, p1_y = 128.0, 128.0
        p2_x, p2_y = 128.0, 128.0

    p1_ra, p1_dec = pixel_to_sky(p1_x, p1_y, wcs)
    p2_ra, p2_dec = pixel_to_sky(p2_x, p2_y, wcs)

    target_epoch_positions: list[dict[str, Any]] = []
    for idx, ep in enumerate(epochs_meta):
        frac = 0.0 if len(epochs_meta) <= 1 else idx / float(len(epochs_meta) - 1)
        ex = round(p1_x + frac * (p2_x - p1_x), 2)
        ey = round(p1_y + frac * (p2_y - p1_y), 2)
        era, edec = pixel_to_sky(ex, ey, wcs)
        target_epoch_positions.append(
            {
                "epoch_id": ep["epoch_id"],
                "mjd": ep["mjd"],
                "ra": era,
                "dec": edec,
                "x": ex,
                "y": ey,
            }
        )

    if slug == "comet_3i_atlas":
        for ep_pos in target_epoch_positions:
            most_solar_system.append(
                {
                    "object_name": "3I/ATLAS",
                    "epoch_id": ep_pos["epoch_id"],
                    "ra": ep_pos["ra"],
                    "dec": ep_pos["dec"],
                    "x": ep_pos["x"],
                    "y": ep_pos["y"],
                    "v_mag": 17.6,
                }
            )
        known_objects.insert(
            0,
            {
                "object_id": "most:3I/ATLAS",
                "label": "Comet 3I/ATLAS (Solar System Mover)",
                "catalog": "most",
                "object_type": "solar_system",
                "ra": p1_ra,
                "dec": p1_dec,
                "x": p1_x,
                "y": p1_y,
                "magnitude": 17.6,
                "proper_motion_arcsec_yr": 19.4,
                "w1_w2_color": 1.4,
                "default_checked": True,
                "epoch_positions": target_epoch_positions,
            },
        )
    elif slug == "barnards_star":
        gaia_dr3.insert(
            0,
            {
                "source_id": "4472832130942575872",
                "ra": p1_ra,
                "dec": p1_dec,
                "x": p1_x,
                "y": p1_y,
                "g_mag": 9.51,
                "bp_rp": 2.81,
                "pmra": -801.5,
                "pmdec": 10362.5,
            },
        )
        known_objects.insert(
            0,
            {
                "object_id": "gaia:4472832130942575872",
                "label": "Barnard's Star (High Proper Motion)",
                "catalog": "gaia_dr3",
                "object_type": "high_pm_star",
                "ra": p1_ra,
                "dec": p1_dec,
                "x": p1_x,
                "y": p1_y,
                "magnitude": 9.51,
                "proper_motion_arcsec_yr": 10.39,
                "w1_w2_color": 0.25,
                "default_checked": True,
                "epoch_positions": target_epoch_positions,
            },
        )
    else:
        wise_id = f"J{int(ra * 100):06d}{int(abs(dec) * 100):05d}"
        w1_mag = 17.8 if slug == "wise_0855" else 13.2
        w2_mag = 14.0 if slug == "wise_0855" else 11.4
        w1_w2 = round(w1_mag - w2_mag, 2)
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
        obj_type: Literal["brown_dwarf_candidate", "variable_star", "infrared_source"] = (
            "variable_star" if slug in ("rw_aurigae", "r_draconis") else "brown_dwarf_candidate"
        )
        pm_val = 0.02 if slug in ("rw_aurigae", "r_draconis") else 8.12
        known_objects.insert(
            0,
            {
                "object_id": f"wise:{wise_id}",
                "label": f"{target_info['name']} ({target_info['category']})",
                "catalog": "wise",
                "object_type": obj_type,
                "ra": p1_ra,
                "dec": p1_dec,
                "x": p1_x,
                "y": p1_y,
                "magnitude": w2_mag,
                "proper_motion_arcsec_yr": pm_val,
                "w1_w2_color": w1_w2,
                "default_checked": True,
                "epoch_positions": target_epoch_positions,
            },
        )

    return {
        "known_objects": known_objects,
        "gaia_dr3": gaia_dr3,
        "wise_sources": wise_sources,
        "most_solar_system": most_solar_system,
    }


def generate_synthetic_epoch_frames(
    slug: str = "wise_0855",
) -> dict[str, bytes]:
    """Generate deterministic (6, 256, 256) float32 and (256, 256) uint8 binary buffers."""
    # Stationary field stars at identical (x, y) across Pass 1 and Pass 2
    field_stars = [
        (116.0, 115.4, 2.8),
        (162.0, 100.0, 3.6),
        (86.0, 159.0, 2.2),
        (176.0, 167.0, 4.1),
    ]
    if slug in ("rw_aurigae", "r_draconis"):
        p1_pos = (128.0, 128.0)
        p2_pos = (128.0, 128.0)
        p1_scale, p2_scale = 2.0, 6.5
    else:
        p1_pos = (124.0, 126.0)
        p2_pos = (132.0, 130.0)
        p1_scale, p2_scale = 5.5, 5.5

    cold_only = slug in ("wise_0855", "epsilon_indi_b")

    def _build_pass(tx: float, ty: float, t_scale: float) -> bytes:
        planes: list[float] = [0.02] * TOTAL_DETECTOR_VALUES

        def _add_psf(cx: float, cy: float, det_idx: int, peak: float, sigma: float = 1.8) -> None:
            plane_offset = det_idx * PIXELS_PER_PLANE
            x_min = max(0, int(cx - 7))
            x_max = min(GRID_WIDTH - 1, int(cx + 7))
            y_min = max(0, int(cy - 7))
            y_max = min(GRID_HEIGHT - 1, int(cy + 7))
            two_sigma_sq = 2.0 * sigma * sigma
            for py in range(y_min, y_max + 1):
                dy_sq = (py - cy) * (py - cy)
                row_offset = plane_offset + py * GRID_WIDTH
                for px in range(x_min, x_max + 1):
                    dx_sq = (px - cx) * (px - cx)
                    val = peak * math.exp(-(dx_sq + dy_sq) / two_sigma_sq)
                    planes[row_offset + px] += val

        # Add stationary background stars (brighter in short-wavelength detectors 0..2)
        for sx, sy, s_flux in field_stars:
            for d in range(NUM_DETECTORS):
                det_weight = 1.4 - 0.18 * d
                _add_psf(sx, sy, d, s_flux * det_weight)

        # Add primary target
        for d in range(NUM_DETECTORS):
            if cold_only:
                det_weight = 0.03 if d < 3 else (0.45 if d == 3 else 1.8)
            else:
                det_weight = 1.1
            _add_psf(tx, ty, d, t_scale * det_weight)

        return struct.pack(f"<{TOTAL_DETECTOR_VALUES}f", *planes)

    flags = bytearray(BINARY_FLAGS_UINT8_BYTES)
    flags[10 * GRID_WIDTH + 10] = 1  # Sample transient/cosmic ray bit
    flags[240 * GRID_WIDTH + 240] = 2  # Sample saturation bit
    flags_bytes = bytes(flags)

    return {
        "pass_1.bin": _build_pass(p1_pos[0], p1_pos[1], p1_scale),
        "pass_2.bin": _build_pass(p2_pos[0], p2_pos[1], p2_scale),
        "pass_1_flags.bin": flags_bytes,
        "pass_2_flags.bin": flags_bytes,
    }


def build_sky_patch_manifest_payload(
    ra: float,
    dec: float,
    fov_arcmin: float = 5.0,
    slug: str | None = None,
    static_preset_urls: bool = False,
) -> dict[str, Any]:
    """Construct a complete, schema-validated SkyPatchManifest dictionary."""
    grid_key, _, _ = compute_grid_key(ra, dec, fov_arcmin)
    resolved_slug = slug
    if not resolved_slug:
        for cand_slug, meta in SHOWCASE_TARGETS.items():
            if math.hypot(ra - meta["ra"], dec - meta["dec"]) < 0.25:
                resolved_slug = cand_slug
                break
    target_meta = dict(
        SHOWCASE_TARGETS.get(
            resolved_slug or "wise_0855",
            {
                "slug": "custom_patch",
                "name": f"Sky Patch ({ra:.2f}, {dec:.2f})",
                "category": "Custom Sky Exploration",
                "description": "Multi-epoch near-infrared SPHEREx + WISE/Gaia exploration patch.",
                "constellation": lookup_constellation(ra, dec),
            },
        )
    )

    wcs = build_wcs_header(ra, dec, fov_arcmin)
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
            "primary_mission": "SPHEREx",
            "has_multi_epoch_spherex": True,
            "uses_wise_fallback": False,
            "baseline_days": 182.7,
            "status_note": "2 SPHEREx survey passes (6-month baseline)",
        },
        "wcs": wcs,
        "epochs": epochs,
        "default_spectrum_url": spectrum_url,
        "catalog_overlays": catalog_overlays,
    }
    validate_sky_patch_manifest(manifest)
    return manifest


def build_spectrum_payload(
    ra: float,
    dec: float,
    source_label: str = "WISE 0855",
    slug: str | None = None,
) -> dict[str, Any]:
    """Generate a target-tailored 102-channel SPHEREx spectrophotometry payload (0.75 - 5.0 um)."""
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

    channels: list[dict[str, Any]] = []
    for idx in range(102):
        band_index = idx + 1
        detector = min(6, (idx // 17) + 1)
        wl = round(0.75 + (4.25 * idx) / 101.0, 4)

        h2o_dip = 1.0 - 0.58 * math.exp(-((wl - 3.08) ** 2) / (2.0 * 0.09**2))
        ch4_dip = 1.0 - 0.68 * math.exp(-((wl - 3.35) ** 2) / (2.0 * 0.08**2))
        co_dip = 1.0 - 0.45 * math.exp(-((wl - 4.67) ** 2) / (2.0 * 0.07**2))
        co2_peak = 0.40 * math.exp(-((wl - 4.26) ** 2) / (2.0 * 0.04**2))

        if resolved_slug == "barnards_star":
            # M4V red dwarf: bright at short/mid NIR (1.0 - 2.2 um), declining Rayleigh-Jeans tail
            continuum = 4.6 * math.exp(-((wl - 1.35) ** 2) / (2.0 * 0.85**2)) + (1.8 / (wl**1.4))
            raw_flux = continuum * (0.75 + 0.25 * h2o_dip) * co_dip
        elif resolved_slug == "comet_3i_atlas":
            # Moving comet: reflected solar continuum + H2O (3.05 um) & CO2 (4.26 um) coma peaks
            solar_reflected = 1.2 * math.exp(-((wl - 1.1) ** 2) / (2.0 * 0.9**2))
            thermal_tail = 1.1 * math.exp(-((wl - 4.8) ** 2) / (2.0 * 0.65**2))
            h2o_emission = 1.85 * math.exp(-((wl - 3.05) ** 2) / (2.0 * 0.07**2))
            co2_coma = 3.20 * math.exp(-((wl - 4.26) ** 2) / (2.0 * 0.045**2))
            co_coma = 1.10 * math.exp(-((wl - 4.67) ** 2) / (2.0 * 0.05**2))
            raw_flux = solar_reflected + thermal_tail + h2o_emission + co2_coma + co_coma
        elif resolved_slug == "r_draconis":
            # Mira pulsating red giant: luminous cool giant with H2O (3.0 um) & CO (4.67 um) dips
            continuum = 3.2 * math.exp(-((wl - 2.1) ** 2) / (2.0 * 1.35**2)) + 1.4
            raw_flux = continuum * h2o_dip * co_dip
        elif resolved_slug == "rw_aurigae":
            # T Tauri variable star: stellar photosphere + warm circumstellar disk infrared excess
            photosphere = 2.4 * math.exp(-((wl - 1.5) ** 2) / (2.0 * 0.9**2))
            disk_excess = 2.6 * (1.0 - math.exp(-(((wl - 0.7) / 2.2) ** 2)))
            raw_flux = (photosphere + disk_excess) * (0.82 + 0.18 * h2o_dip) * co_dip
        elif resolved_slug == "epsilon_indi_b":
            # T1 + T6 binary brown dwarf: J/H/K peaks + 4.5 um peak + deep H2O & CH4 troughs
            nir_peaks = 1.35 * math.exp(-((wl - 1.25) ** 2) / (2.0 * 0.35**2))
            mid_ir_peak = 3.10 * math.exp(-((wl - 4.50) ** 2) / (2.0 * 0.48**2))
            raw_flux = (0.08 + nir_peaks + mid_ir_peak) * h2o_dip * ch4_dip * co_dip
        else:
            # Ultra-cold sub-brown dwarf (WISE 0855 ~250 K): faint short-IR, blazing 4.5 um peak
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
        "molecular_features": list(DEFAULT_MOLECULAR_FEATURES),
    }
    validate_spectrum_payload(payload)
    return payload


# ---------------------------------------------------------------------------
# Application Service Core & FastAPI / Local Client Adapter
# ---------------------------------------------------------------------------


class StarHuntersBackendService:
    """Core request handler used by both FastAPI routes and standalone tests."""

    def __init__(self, cache: SpatialSqliteCache | None = None) -> None:
        self.cache = cache or SpatialSqliteCache()
        self.admin_token = os.environ.get("ADMIN_TOKEN", "star-hunters-dev-token")

    def health(self) -> dict[str, str]:
        return {
            "status": "ok",
            "service": "star-hunters-backend",
            "version": "0.1.0",
        }

    def get_earth_to_sky(
        self,
        lat: float | None = None,
        lon: float | None = None,
        iso_time: str | None = None,
        fallback_seed: int | None = None,
        prewarm_patch: bool = True,
    ) -> dict[str, Any]:
        is_fallback = lat is None or lon is None
        city_slug: str | None = None
        selected_capital: dict[str, Any] | None = None
        if is_fallback:
            selected_capital = pick_random_capital_city(seed=fallback_seed)
            lat = float(selected_capital["lat"])
            lon = float(selected_capital["lon"])
            city_slug = str(selected_capital["slug"])

        assert lat is not None and lon is not None
        if not (-90.0 <= lat <= 90.0):
            raise ValueError("Latitude must be in [-90.0, 90.0]")
        if not (-180.0 <= lon <= 180.0):
            raise ValueError("Longitude must be in [-180.0, 180.0]")

        if iso_time:
            clean_iso = iso_time.replace("Z", "+00:00")
            dt = datetime.fromisoformat(clean_iso)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=UTC)
            else:
                dt = dt.astimezone(UTC)
            iso_utc = dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        else:
            dt = datetime.now(UTC)
            iso_utc = dt.strftime("%Y-%m-%dT%H:%M:%SZ")

        # Quantize UTC time bucket to 1-minute resolution for SQLite Zenith caching
        time_bucket = iso_utc[:16]
        cache_key = (
            f"zenith_{city_slug or 'coord'}_lat{lat:.2f}_lon{lon:.2f}"
            f"_t{time_bucket}_fb{int(is_fallback)}"
        )
        cached_zenith = self.cache.get_zenith_response(cache_key)
        if cached_zenith is not None:
            validate_earth_to_sky_response(cached_zenith)
            return cached_zenith

        # Pass the resolved (lat, lon) directly so compute_zenith_icrs computes the exact
        # overhead (RA, Dec, constellation) for the chosen capital city rather than drawing
        # a second random city when fallback_seed is None.
        payload = compute_zenith_icrs(
            lat=lat,
            lon=lon,
            iso_time=iso_utc,
        )
        if is_fallback and selected_capital is not None:
            payload["earth"]["lat"] = round(lat, 4)
            payload["earth"]["lon"] = round(lon, 4)
            payload["earth"]["city_name"] = str(selected_capital["city_name"])
            payload["earth"]["country"] = str(selected_capital["country"])
            payload["earth"]["is_fallback_capital"] = True

        self.cache.put_zenith_response(
            cache_key=cache_key,
            lat=payload["earth"]["lat"],
            lon=payload["earth"]["lon"],
            payload=payload,
            city_slug=city_slug,
        )
        if prewarm_patch and (
            is_fallback or city_slug is not None or find_matching_capital_city(lat, lon) is not None
        ):
            # Cache the capital city's overhead sky patch in SQLite for fast subsequent fetches
            self.get_sky_patch(
                ra=payload["zenith_icrs"]["ra"],
                dec=payload["zenith_icrs"]["dec"],
                fov=5.0,
            )
        return payload

    def get_catalogs(
        self,
        ra: float,
        dec: float,
        fov: float = 5.0,
    ) -> dict[str, Any]:
        grid_key, _, _ = compute_grid_key(ra, dec, fov)
        cached_catalogs = self.cache.get_catalogs(grid_key)
        if cached_catalogs is not None:
            validate_catalogs_response(cached_catalogs)
            return cached_catalogs

        manifest = build_sky_patch_manifest_payload(ra=ra, dec=dec, fov_arcmin=fov)
        response = {
            "query": manifest["query"],
            "wcs": manifest["wcs"],
            "catalog_overlays": manifest["catalog_overlays"],
        }
        validate_catalogs_response(response)
        return response

    def get_sky_patch(
        self,
        ra: float,
        dec: float,
        fov: float = 5.0,
    ) -> dict[str, Any]:
        grid_key, ra_q, dec_q = compute_grid_key(ra, dec, fov)
        cached_manifest = self.cache.get_manifest(grid_key)
        if cached_manifest is not None:
            validate_sky_patch_manifest(cached_manifest)
            return cached_manifest

        manifest = build_sky_patch_manifest_payload(ra=ra, dec=dec, fov_arcmin=fov)
        frames = generate_synthetic_epoch_frames(manifest["target_metadata"]["slug"])
        self.cache.put_sky_patch(
            grid_key=grid_key,
            ra_center=ra_q,
            dec_center=dec_q,
            fov_arcmin=fov,
            manifest=manifest,
            frames=frames,
        )
        return manifest

    def get_frame_bytes(
        self,
        grid_key: str,
        filename: str,
        precision: Literal["float32", "float16"] = "float32",
    ) -> tuple[bytes, dict[str, str]]:
        raw = self.cache.get_frame(grid_key, filename)
        if raw is None:
            frames = generate_synthetic_epoch_frames("wise_0855")
            if filename not in frames:
                raise KeyError(f"Frame not found: {grid_key}/{filename}")
            raw = frames[filename]

        is_flags = filename.endswith("_flags.bin")
        if is_flags:
            dtype_header = "uint8"
            body = raw
        elif precision == "float16":
            dtype_header = "float16"
            body = convert_float32_bytes_to_float16_bytes(raw)
        else:
            dtype_header = "float32"
            body = raw

        headers = {
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Binary-Dtype": dtype_header,
            "Content-Type": "application/octet-stream",
        }
        return body, headers

    def get_spectrum(
        self,
        ra: float,
        dec: float,
        label: str | None = None,
    ) -> dict[str, Any]:
        spectrum_key = f"spec_ra{round(ra, 4):.4f}_dec{round(dec, 4):.4f}"
        cached_spec = self.cache.get_spectrum(spectrum_key)
        if cached_spec is not None:
            validate_spectrum_payload(cached_spec)
            return cached_spec

        resolved_label = label or "WISE 0855"
        resolved_slug: str | None = None
        for cand_slug, meta in SHOWCASE_TARGETS.items():
            if math.hypot(ra - meta["ra"], dec - meta["dec"]) < 0.25:
                resolved_label = meta["name"]
                resolved_slug = cand_slug
                break
        payload = build_spectrum_payload(
            ra=ra,
            dec=dec,
            source_label=resolved_label,
            slug=resolved_slug,
        )
        self.cache.put_spectrum(spectrum_key=spectrum_key, ra=ra, dec=dec, payload=payload)
        return payload


backend_service = StarHuntersBackendService()


if HAS_FASTAPI:
    from pathlib import Path

    from fastapi.staticfiles import StaticFiles

    app = FastAPI(
        title="Star Hunters API (Planet X & SPHEREx Blinker)",
        version="0.1.0",
        description="Multi-epoch SPHEREx + WISE/Gaia/MOST sky blinker & 102-band spectral API.",
    )
    app.add_middleware(GZipMiddleware, minimum_size=512)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health_check() -> dict[str, str]:
        return backend_service.health()

    @app.get("/api/v1/earth-to-sky")
    async def earth_to_sky(
        lat: float | None = Query(None, ge=-90.0, le=90.0),
        lon: float | None = Query(None, ge=-180.0, le=180.0),
        iso_time: str | None = Query(None),
    ) -> dict[str, Any]:
        try:
            return backend_service.get_earth_to_sky(lat=lat, lon=lon, iso_time=iso_time)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/v1/catalogs")
    async def get_catalogs(
        response: Response,
        ra: float = Query(..., ge=0.0, le=360.0),
        dec: float = Query(..., ge=-90.0, le=90.0),
        fov: float = Query(5.0, gt=0.0, le=60.0),
    ) -> dict[str, Any]:
        response.headers["Cache-Control"] = "public, max-age=3600"
        return backend_service.get_catalogs(ra=ra, dec=dec, fov=fov)

    @app.get("/api/v1/sky-patch")
    async def get_sky_patch(
        response: Response,
        ra: float = Query(..., ge=0.0, le=360.0),
        dec: float = Query(..., ge=-90.0, le=90.0),
        fov: float = Query(5.0, gt=0.0, le=60.0),
    ) -> dict[str, Any]:
        response.headers["Cache-Control"] = "public, max-age=3600"
        return backend_service.get_sky_patch(ra=ra, dec=dec, fov=fov)

    @app.get("/api/v1/frames/{grid_key}/{filename}")
    async def get_binary_frame(
        grid_key: str,
        filename: str,
        precision: Literal["float32", "float16"] = Query("float32"),
    ) -> Response:
        try:
            body, headers = backend_service.get_frame_bytes(
                grid_key=grid_key,
                filename=filename,
                precision=precision,
            )
            return Response(
                content=body,
                media_type="application/octet-stream",
                headers=headers,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/v1/spectrum")
    async def get_spectrum(
        response: Response,
        ra: float = Query(..., ge=0.0, le=360.0),
        dec: float = Query(..., ge=-90.0, le=90.0),
    ) -> dict[str, Any]:
        response.headers["Cache-Control"] = "public, max-age=3600"
        return backend_service.get_spectrum(ra=ra, dec=dec)

    @app.post("/api/v1/admin/clear-cache")
    async def clear_cache(
        x_admin_token: str | None = Header(None),
    ) -> dict[str, str]:
        if x_admin_token != backend_service.admin_token:
            raise HTTPException(status_code=403, detail="Invalid X-Admin-Token")
        backend_service.cache.clear()
        return {"status": "cleared"}

    # Serve built Vite SPA (`frontend/dist`) in unified Docker / Fly.io deployment
    _frontend_dist = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
    if _frontend_dist.is_dir():
        app.mount(
            "/",
            StaticFiles(directory=str(_frontend_dist), html=True),
            name="frontend_spa",
        )
else:  # pragma: no cover
    app = None
