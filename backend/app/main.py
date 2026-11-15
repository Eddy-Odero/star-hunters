"""FastAPI entrypoint and contract routes for Star Hunters."""

from __future__ import annotations

import copy
import json
import math
import os
import random
import struct
from datetime import UTC, datetime, timedelta
from pathlib import Path
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
from .services.celestial_catalog_pipeline import (
    AutomatedCelestialPipeline,
    fetch_most_spherex_matches,
)
from .services.spatial_cache import (
    SpatialSqliteCache,
    angular_separation_deg,
    compute_grid_key,
)
from .services.spectrum_extractor import SpectrumExtractionError, extract_forced_spectrum
from .services.wise_fallback import fetch_wise_fallback

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
    (30.0, 55.0, 10.0, 28.0, "Aries"),
    (55.0, 75.0, 12.0, 28.0, "Taurus"),
    (60.0, 100.0, 15.0, 45.0, "Auriga"),
    (110.0, 160.0, -25.0, 5.0, "Hydra"),
    (140.0, 175.0, 0.0, 28.0, "Leo"),
    (150.0, 175.0, -60.0, -40.0, "Vela"),
    (180.0, 210.0, -15.0, 20.0, "Virgo"),
    (230.0, 265.0, 50.0, 80.0, "Draco"),
    (250.0, 280.0, -10.0, 15.0, "Ophiuchus"),
    (275.0, 305.0, -10.0, 15.0, "Aquila"),
    (280.0, 310.0, -35.0, -10.0, "Sagittarius"),
    (310.0, 350.0, -70.0, -40.0, "Indus"),
]


def _load_celestial_catalog_data() -> dict[str, dict[str, Any]]:
    data_path = Path(__file__).resolve().parent / "models" / "celestial_catalog_data.json"
    if not data_path.is_file():
        return {}
    return json.loads(data_path.read_text(encoding="utf-8"))


CELESTIAL_CATALOG_DATA: dict[str, dict[str, Any]] = _load_celestial_catalog_data()
_PREWARMED_MANIFESTS: dict[tuple[str, bool], dict[str, Any]] = {}
_PREWARMED_FRAMES: dict[str, dict[str, bytes]] = {}
_PREWARMED_SPECTRA: dict[str, dict[str, Any]] = {}
_GLOBAL_KNOWN_OBJECTS_INDEX: list[dict[str, Any]] = []


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


def mjd_to_iso(mjd: float) -> str:
    """Convert a Modified Julian Date to an ISO-8601 UTC timestamp."""
    epoch = datetime(1858, 11, 17, tzinfo=UTC)
    return (epoch + timedelta(days=float(mjd))).strftime("%Y-%m-%dT%H:%M:%SZ")


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


def _format_wise_designation(ra: float, dec: float) -> str:
    """Format ICRS (ra, dec) into standard WISE Jhhmmss.ss±ddmmss.s designation."""
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


def _build_coordinate_seeded_catalog(
    ra: float,
    dec: float,
    wcs: dict[str, Any],
    epochs_meta: list[dict[str, Any]],
) -> dict[str, Any]:
    """Generate a rich, deterministic, SPHEREx-trackable multi-catalog field for any (ra, dec)."""
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

    # Populate trackable Gaia DR3 stars and AllWISE infrared sources across the 256x256 field
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
    """Build epoch-aware known_objects (for the checkbox list UI) and raw catalog lists."""
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
    p2_x, p2_y = float(prim["p2_x"]), float(prim["p2_y"])
    p1_ra, p1_dec = pixel_to_sky(p1_x, p1_y, wcs)

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
    """Generate deterministic (6, 256, 256) float32 and (256, 256) uint8 binary buffers
    rendering every KnownCelestialObject in the sky patch across passes."""
    if manifest is None and slug in _PREWARMED_FRAMES:
        return _PREWARMED_FRAMES[slug]

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
    cold_only_primary = resolved_slug in ("wise_0855", "epsilon_indi_b", "luhman_16")
    variable_primary = resolved_slug in ("rw_aurigae", "r_draconis", "cw_leonis", "t_tauri")

    def _build_pass(pass_idx: int) -> bytes:
        planes: list[float] = [0.02] * TOTAL_DETECTOR_VALUES

        def _add_psf(cx: float, cy: float, det_idx: int, peak: float, sigma: float = 1.65) -> None:
            plane_offset = det_idx * PIXELS_PER_PLANE
            x_min = max(0, int(cx - 6))
            x_max = min(GRID_WIDTH - 1, int(cx + 6))
            y_min = max(0, int(cy - 6))
            y_max = min(GRID_HEIGHT - 1, int(cy + 6))
            two_sigma_sq = 2.0 * sigma * sigma
            for py in range(y_min, y_max + 1):
                dy_sq = (py - cy) * (py - cy)
                row_offset = plane_offset + py * GRID_WIDTH
                for px in range(x_min, x_max + 1):
                    dx_sq = (px - cx) * (px - cx)
                    val = peak * math.exp(-(dx_sq + dy_sq) / two_sigma_sq)
                    planes[row_offset + px] += val

        for obj_idx, obj in enumerate(known_objects):
            ep_positions = obj.get("epoch_positions", [])
            if not ep_positions:
                continue
            ep_pos = ep_positions[min(pass_idx, len(ep_positions) - 1)]
            cx = float(ep_pos["x"])
            cy = float(ep_pos["y"])

            if obj_idx == 0:
                if variable_primary:
                    t_scale = 2.0 if pass_idx == 0 else 6.5
                else:
                    t_scale = 5.8
                for d in range(NUM_DETECTORS):
                    if cold_only_primary:
                        det_weight = 0.03 if d < 3 else (0.45 if d == 3 else 1.85)
                    else:
                        det_weight = 1.15
                    _add_psf(cx, cy, d, t_scale * det_weight, sigma=1.75)
            else:
                mag = float(obj.get("magnitude") or 15.5)
                base_flux = max(1.85, min(4.6, 2.4 + (16.2 - mag) * 0.32))
                cat = obj.get("catalog", "gaia_dr3")
                for d in range(NUM_DETECTORS):
                    if cat == "wise":
                        det_weight = 0.65 + 0.16 * d
                    else:
                        det_weight = 1.38 - 0.15 * d
                    _add_psf(cx, cy, d, base_flux * det_weight, sigma=1.60)

        return struct.pack(f"<{TOTAL_DETECTOR_VALUES}f", *planes)

    flags = bytearray(BINARY_FLAGS_UINT8_BYTES)
    flags[10 * GRID_WIDTH + 10] = 1  # Sample transient/cosmic ray bit
    flags[240 * GRID_WIDTH + 240] = 2  # Sample saturation bit
    flags_bytes = bytes(flags)

    result = {
        "pass_1.bin": _build_pass(0),
        "pass_2.bin": _build_pass(1),
        "pass_1_flags.bin": flags_bytes,
        "pass_2_flags.bin": flags_bytes,
    }
    if resolved_slug in SHOWCASE_TARGETS:
        _PREWARMED_FRAMES[resolved_slug] = result
    return result


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

    if (
        resolved_slug in _PREWARMED_SPECTRA
        and math.hypot(
            ra - SHOWCASE_TARGETS[resolved_slug]["ra"],
            dec - SHOWCASE_TARGETS[resolved_slug]["dec"],
        )
        < 1e-3
    ):
        cached = copy.deepcopy(_PREWARMED_SPECTRA[resolved_slug])
        cached["source_label"] = source_label
        return cached

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
        elif resolved_slug == "luhman_16":
            # L7.5 + T0.5 binary brown dwarf: strong J/H/K emission + 4.1 um peak + CH4/CO troughs
            nir_peaks = 2.15 * math.exp(-((wl - 1.55) ** 2) / (2.0 * 0.48**2))
            mid_ir_peak = 2.85 * math.exp(-((wl - 4.10) ** 2) / (2.0 * 0.52**2))
            raw_flux = (0.14 + nir_peaks + mid_ir_peak) * (0.65 + 0.35 * h2o_dip) * ch4_dip * co_dip
        elif resolved_slug == "wolf_359":
            # M6.5Ve flare star: cool M-dwarf continuum peaking near 1.65 um with steam bands
            continuum = 3.85 * math.exp(-((wl - 1.65) ** 2) / (2.0 * 0.78**2)) + (1.45 / (wl**1.25))
            raw_flux = continuum * (0.68 + 0.32 * h2o_dip) * co_dip
        elif resolved_slug == "teegardens_star":
            # M7.0V ultracool dwarf: redder M-dwarf continuum peaking at 1.80 um
            continuum = 3.45 * math.exp(-((wl - 1.80) ** 2) / (2.0 * 0.82**2)) + (1.30 / (wl**1.15))
            raw_flux = continuum * (0.62 + 0.38 * h2o_dip) * (0.85 + 0.15 * ch4_dip) * co_dip
        elif resolved_slug == "cw_leonis":
            # Extreme carbon AGB star: steep warm dust continuum rising strongly to 4.8 um + CO
            dust_continuum = 0.35 + 4.85 * ((wl / 5.0) ** 2.15)
            c2h2_dip = 1.0 - 0.52 * math.exp(-((wl - 3.05) ** 2) / (2.0 * 0.08**2))
            raw_flux = dust_continuum * c2h2_dip * co_dip
        elif resolved_slug == "t_tauri":
            # Prototype YSO with icy circumstellar envelope: 3.08 um H2O ice & 4.26 um CO2 ice
            photosphere = 2.1 * math.exp(-((wl - 1.65) ** 2) / (2.0 * 0.85**2))
            envelope_ir = 3.15 * ((wl / 4.5) ** 1.35)
            co2_ice_dip = 1.0 - 0.48 * math.exp(-((wl - 4.27) ** 2) / (2.0 * 0.045**2))
            raw_flux = (photosphere + envelope_ir) * h2o_dip * co2_ice_dip * co_dip
        elif resolved_slug == "ceres_asteroid":
            # Main-belt dwarf planet: solar reflected light + 3.06 um ammoniated phyllosilicate dip
            solar_reflected = 2.65 * math.exp(-((wl - 1.20) ** 2) / (2.0 * 0.95**2)) + (0.85 / wl)
            thermal_tail = 1.75 * math.exp(-((wl - 4.85) ** 2) / (2.0 * 0.55**2))
            nh4_dip = 1.0 - 0.42 * math.exp(-((wl - 3.06) ** 2) / (2.0 * 0.11**2))
            carbonate_dip = 1.0 - 0.35 * math.exp(-((wl - 3.95) ** 2) / (2.0 * 0.09**2))
            raw_flux = (solar_reflected + thermal_tail) * nh4_dip * carbonate_dip
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


def fuzzy_score_text(query: str, candidate: str) -> float:
    """Compute a normalized [0.0, 1.0] fuzzy match score between query and candidate string."""
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

    # Ordered subsequence match (e.g. "w0855" -> "wise 0855-0714")
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

    # Bounded Levenshtein edit distance against candidate tokens for typo tolerance
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
    """Build or return the pre-warmed global index of all showcase known celestial objects."""
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
    return _GLOBAL_KNOWN_OBJECTS_INDEX


# ---------------------------------------------------------------------------
# Application Service Core & FastAPI / Local Client Adapter
# ---------------------------------------------------------------------------


def _infer_object_class(obj: dict[str, Any]) -> str:
    """Map legacy object_type / label onto standardized celestial badge classes."""
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


def _merge_pipeline_overlays(
    manifest: dict[str, Any],
    pipeline_result: dict[str, Any],
    prefer_pipeline_when_uncached: bool = False,
) -> dict[str, Any]:
    """Merge cached/live SIMBAD + Gaia + Horizons ephemeris into manifest catalog overlays."""
    overlays = copy.deepcopy(manifest["catalog_overlays"])
    base_known = list(overlays.get("known_objects", []))
    for item in base_known:
        item.setdefault("object_class", _infer_object_class(item))

    pipe_known = list(pipeline_result.get("known_objects", []))
    is_showcase = manifest.get("target_metadata", {}).get("slug") in SHOWCASE_TARGETS

    # For non-showcase coordinates where real catalog objects exist, prioritize real catalog entries
    if prefer_pipeline_when_uncached and not is_showcase and pipe_known:
        merged_known = list(pipe_known)
        existing_known = merged_known
    else:
        merged_known = base_known
        existing_known = merged_known
        dedup_deg = 2.5 / 3600.0
        for cand in pipe_known:
            cand_id = str(cand.get("object_id", ""))
            cand_ra = float(cand.get("ra", 0.0))
            cand_dec = float(cand.get("dec", 0.0))
            duplicate = any(
                str(ex.get("object_id", "")) == cand_id
                or angular_separation_deg(cand_ra, cand_dec, float(ex["ra"]), float(ex["dec"]))
                <= dedup_deg
                for ex in existing_known
            )
            if not duplicate:
                merged_known.append(cand)

    # Merge raw overlay arrays without duplicates
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


class StarHuntersBackendService:
    """Core request handler used by both FastAPI routes and standalone tests."""

    def __init__(
        self,
        cache: SpatialSqliteCache | None = None,
        enable_archival_data: bool | None = None,
        wise_fallback_fetcher: Any = fetch_wise_fallback,
    ) -> None:
        self.cache = cache or SpatialSqliteCache()
        self.admin_token = os.environ.get("ADMIN_TOKEN", "star-hunters-dev-token")
        self.catalog_pipeline = AutomatedCelestialPipeline(cache=self.cache)
        # Keep offline tests/local development deterministic. Enable live IRSA
        # ingestion explicitly with ENABLE_ARCHIVAL_DATA=true in deployment.
        if enable_archival_data is None:
            configured = os.environ.get("ENABLE_ARCHIVAL_DATA", "false").strip().lower()
            enable_archival_data = configured in {"1", "true", "yes", "on"}
        self.enable_archival_data = enable_archival_data
        self.wise_fallback_fetcher = wise_fallback_fetcher

    def prewarm_known_data(self) -> int:
        """Aggressively pre-warm all showcase manifests, spectra, frames, and search index."""
        get_global_known_objects_index()
        count = 0
        for slug, meta in SHOWCASE_TARGETS.items():
            grid_key, ra_q, dec_q = compute_grid_key(meta["ra"], meta["dec"], 5.0)
            self.cache.pin_grid_key(grid_key)
            manifest = build_sky_patch_manifest_payload(
                ra=meta["ra"],
                dec=meta["dec"],
                fov_arcmin=5.0,
                slug=slug,
            )
            manifest = self._apply_cached_pipeline_sync(
                manifest,
                ra=meta["ra"],
                dec=meta["dec"],
                fov=5.0,
            )
            frames = generate_synthetic_epoch_frames(slug=slug, manifest=manifest)
            self.cache.put_sky_patch(
                grid_key=grid_key,
                ra_center=ra_q,
                dec_center=dec_q,
                fov_arcmin=5.0,
                manifest=manifest,
                frames=frames,
            )
            spec = build_spectrum_payload(
                ra=meta["ra"],
                dec=meta["dec"],
                source_label=meta["name"],
                slug=slug,
            )
            spec_key = f"spec_ra{round(meta['ra'], 4):.4f}_dec{round(meta['dec'], 4):.4f}"
            self.cache.put_spectrum(
                spectrum_key=spec_key,
                ra=meta["ra"],
                dec=meta["dec"],
                payload=spec,
            )
            count += 1
        return count

    def search_known_objects(
        self,
        query: str = "",
        limit: int = 30,
    ) -> list[dict[str, Any]]:
        """Fuzzy-search known celestial objects across all cached showcase sky patches."""
        index = get_global_known_objects_index()
        clean_q = query.strip()
        if not clean_q:
            # Return primary targets first, followed by brightest companions/stars
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
            if prewarm_patch:
                cached_ra = float(cached_zenith["zenith_icrs"]["ra"])
                cached_dec = float(cached_zenith["zenith_icrs"]["dec"])
                cached_grid_key, _, _ = compute_grid_key(cached_ra, cached_dec, 5.0)
                cached_patch = self.cache.get_manifest(cached_grid_key)
                cached_summary = (cached_patch or {}).get("data_source_summary", {})
                cached_note = str(cached_summary.get("status_note", ""))
                needs_archival_refresh = (
                    self.enable_archival_data
                    and cached_note == "2 SPHEREx survey passes (6-month baseline)"
                )
                if cached_patch is None or needs_archival_refresh:
                    self.get_sky_patch(cached_ra, cached_dec, fov=5.0)
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

    def _apply_cached_pipeline_sync(
        self,
        manifest: dict[str, Any],
        ra: float,
        dec: float,
        fov: float,
    ) -> dict[str, Any]:
        pipeline_result = self.catalog_pipeline.resolve_cached_patch_objects(
            ra_deg=ra,
            dec_deg=dec,
            fov_arcmin=fov,
            wcs=manifest["wcs"],
            epochs_meta=manifest["epochs"],
        )
        enriched = _merge_pipeline_overlays(
            manifest,
            pipeline_result,
            prefer_pipeline_when_uncached=bool(pipeline_result.get("known_objects")),
        )
        return enriched

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
        manifest = self._apply_cached_pipeline_sync(manifest, ra=ra, dec=dec, fov=fov)
        response = {
            "query": manifest["query"],
            "wcs": manifest["wcs"],
            "catalog_overlays": manifest["catalog_overlays"],
        }
        validate_catalogs_response(response)
        return response

    async def get_catalogs_async(
        self,
        ra: float,
        dec: float,
        fov: float = 5.0,
        live_catalogs: bool = True,
    ) -> dict[str, Any]:
        manifest = await self.get_sky_patch_async(
            ra=ra,
            dec=dec,
            fov=fov,
            live_catalogs=live_catalogs,
        )
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
            # Do not let pre-ISS-12 synthetic demo patches mask the archival
            # fetch path after the backend is upgraded/configured for real data.
            cached_summary = cached_manifest.get("data_source_summary", {})
            cached_note = str(cached_summary.get("status_note", ""))
            is_legacy_demo = cached_note == "2 SPHEREx survey passes (6-month baseline)"
            if not (self.enable_archival_data and is_legacy_demo):
                validate_sky_patch_manifest(cached_manifest)
                return cached_manifest

        manifest = build_sky_patch_manifest_payload(ra=ra, dec=dec, fov_arcmin=fov)
        manifest = self._apply_cached_pipeline_sync(manifest, ra=ra, dec=dec, fov=fov)
        slug = manifest["target_metadata"]["slug"]
        if slug in SHOWCASE_TARGETS:
            self.cache.pin_grid_key(grid_key)
        frames = generate_synthetic_epoch_frames(slug=slug, manifest=manifest)

        if self.enable_archival_data:
            try:
                from .services.spherex_coadd import (
                    build_target_wcs_header,
                    coadd_spherex_epochs,
                )
                from .services.spherex_ingest import ingest_spherex_cutouts

                fov_deg = float(fov) / 60.0
                try:
                    cutouts = ingest_spherex_cutouts(
                        ra=ra, dec=dec, fov_arcmin=fov, allow_synthetic_fallback=False
                    )
                except Exception:
                    # An empty SPHEREx result is exactly the condition ISS-12
                    # is intended to recover from; proceed to archival WISE.
                    cutouts = []
                coadd = coadd_spherex_epochs(cutouts, ra, dec, fov_deg)
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
                            "detectors_data_url": (f"/api/v1/frames/{grid_key}/{filename}"),
                            "flags_mask_url": (f"/api/v1/frames/{grid_key}/{flags_filename}"),
                            "available_detectors": epoch.available_detectors or [1],
                            "binary_dtype": "float32",
                        }
                    )

                if coadd.needs_wise_fallback:
                    target_header = build_target_wcs_header(ra, dec, fov_deg)
                    wise = self.wise_fallback_fetcher(
                        ra=ra, dec=dec, fov_arcmin=fov, target_wcs_header=target_header
                    )
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
                            "detectors_data_url": (f"/api/v1/frames/{grid_key}/{wise_data_name}"),
                            "flags_mask_url": (f"/api/v1/frames/{grid_key}/{wise_flags_name}"),
                            "available_detectors": wise.available_detectors or [4, 5, 6],
                            "binary_dtype": "float32",
                        }
                    )
                    all_mjds = epoch_mjds + [
                        float(wise.mjd_start),
                        float(wise.mjd_end),
                    ]
                    baseline_days = (
                        max(all_mjds) - min(all_mjds) if all_mjds else wise.baseline_days
                    )
                    manifest["data_source_summary"] = {
                        "primary_mission": "WISE",
                        "has_multi_epoch_spherex": False,
                        "uses_wise_fallback": True,
                        "baseline_days": max(float(wise.baseline_days), float(baseline_days)),
                        "status_note": (
                            f"WISE/NEOWISE W1/W2 fallback; {len(coadd.epochs)} SPHEREx epoch(s)"
                        ),
                    }
                    manifest["epochs"] = epoch_entries
                    frames = actual_frames
                elif len(coadd.epochs) >= 2:
                    manifest["epochs"] = epoch_entries
                    manifest["data_source_summary"] = {
                        "primary_mission": "SPHEREx",
                        "has_multi_epoch_spherex": True,
                        "uses_wise_fallback": False,
                        "baseline_days": float(coadd.baseline_days),
                        "status_note": f"{len(coadd.epochs)} real SPHEREx comparison epoch(s)",
                    }
                    frames = actual_frames
            except Exception as exc:
                # A missing IRSA dependency/network response must not fabricate WISE
                # measurements or label a synthetic fixture as archival data.
                # Preserve the existing demo patch, but keep its source summary intact.
                manifest["data_source_summary"]["status_note"] = (
                    "Archival SPHEREx/WISE data unavailable; demo patch returned "
                    f"({type(exc).__name__})"
                )

        validate_sky_patch_manifest(manifest)
        self.cache.put_sky_patch(
            grid_key=grid_key,
            ra_center=ra_q,
            dec_center=dec_q,
            fov_arcmin=fov,
            manifest=manifest,
            frames=frames,
        )
        validate_sky_patch_manifest(manifest)
        return manifest

    async def get_sky_patch_async(
        self,
        ra: float,
        dec: float,
        fov: float = 5.0,
        live_catalogs: bool = True,
    ) -> dict[str, Any]:
        grid_key, ra_q, dec_q = compute_grid_key(ra, dec, fov)
        cached_manifest = self.cache.get_manifest(grid_key)
        if cached_manifest is not None:
            validate_sky_patch_manifest(cached_manifest)
            return cached_manifest

        manifest = build_sky_patch_manifest_payload(ra=ra, dec=dec, fov_arcmin=fov)
        pipeline_result = await self.catalog_pipeline.resolve_patch_objects(
            ra_deg=ra,
            dec_deg=dec,
            fov_arcmin=fov,
            wcs=manifest["wcs"],
            epochs_meta=manifest["epochs"],
            allow_live=live_catalogs,
        )
        manifest = _merge_pipeline_overlays(
            manifest,
            pipeline_result,
            prefer_pipeline_when_uncached=bool(pipeline_result.get("known_objects")),
        )
        slug = manifest["target_metadata"]["slug"]
        if slug in SHOWCASE_TARGETS:
            self.cache.pin_grid_key(grid_key)
        frames = generate_synthetic_epoch_frames(slug=slug, manifest=manifest)
        self.cache.put_sky_patch(
            grid_key=grid_key,
            ra_center=ra_q,
            dec_center=dec_q,
            fov_arcmin=fov,
            manifest=manifest,
            frames=frames,
        )
        validate_sky_patch_manifest(manifest)
        return manifest

    def get_solar_system_in_fov(
        self,
        ra: float,
        dec: float,
        fov: float = 5.0,
        mjd: float | None = None,
    ) -> dict[str, Any]:
        target_mjd = (
            float(mjd)
            if mjd is not None
            else (datetime.now(UTC) - datetime(1858, 11, 17, tzinfo=UTC)).total_seconds() / 86400.0
        )
        radius_deg = self.catalog_pipeline._fov_to_radius_deg(fov)
        matches = self.cache.query_ephemeris_in_fov(
            mjd=target_mjd,
            ra=ra,
            dec=dec,
            radius_deg=radius_deg,
        )
        return {
            "ra": round(float(ra), 5),
            "dec": round(float(dec), 5),
            "fov_arcmin": float(fov),
            "radius_deg": round(radius_deg, 4),
            "mjd": round(target_mjd, 6),
            "count": len(matches),
            "bodies": matches,
            "ephemeris_cache": self.cache.get_ephemeris_stats(),
        }

    async def lookup_most_object(self, obj_name: str) -> dict[str, Any]:
        cache_key = f"most:{obj_name.strip().lower()}"
        cached = self.cache.get_cached_catalog_region(cache_key, 0.0, 0.0, 1.0)
        if cached is not None:
            return {
                "query_name": cached.get("query_name", obj_name),
                "status": "cached",
                "count": len(cached.get("matches", [])),
                "matches": cached.get("matches", []),
            }
        result = await fetch_most_spherex_matches(obj_name=obj_name)
        if result["matches"]:
            self.cache.put_cached_catalog_region(
                cache_key,
                0.0,
                0.0,
                1.0,
                result,
                ttl_seconds=24 * 3600,
            )
        return {
            "query_name": result["query_name"],
            "status": result["status"],
            "count": len(result["matches"]),
            "matches": result["matches"],
        }

    def get_frame_bytes(
        self,
        grid_key: str,
        filename: str,
        precision: Literal["float32", "float16"] = "float32",
    ) -> tuple[bytes, dict[str, str]]:
        raw = self.cache.get_frame(grid_key, filename)
        if raw is None:
            cached_manifest = self.cache.get_manifest(grid_key)
            if cached_manifest is not None:
                frames = generate_synthetic_epoch_frames(
                    slug=cached_manifest["target_metadata"]["slug"],
                    manifest=cached_manifest,
                )
            else:
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

    def get_forced_spectrum(
        self,
        ra: float,
        dec: float,
        label: str | None = None,
    ) -> dict[str, Any]:
        """Ingest SPHEREx cutouts and measure the selected sky position.

        Wavelength-resolved planes are used directly when supplied. Otherwise the
        six detector-band cutouts are measured with aperture photometry and
        interpolated onto the 102-channel contract grid. The ISS-04 synthetic
        fixture fallback keeps this endpoint available when IRSA is offline.
        """
        spectrum_key = f"spec_forced_ra{round(ra, 4):.4f}_dec{round(dec, 4):.4f}"
        cached_spec = self.cache.get_spectrum(spectrum_key)
        if cached_spec is not None:
            validate_spectrum_payload(cached_spec)
            return cached_spec

        try:
            from .services.spherex_ingest import ingest_spherex_cutouts

            cutouts = ingest_spherex_cutouts(
                ra=ra,
                dec=dec,
                fov_arcmin=5.0,
                allow_synthetic_fallback=True,
            )
        except ImportError as exc:
            raise SpectrumExtractionError(
                "SPHEREx ingestion dependencies are unavailable; install backend/requirements.txt."
            ) from exc
        payload = extract_forced_spectrum(
            ra=ra,
            dec=dec,
            cutouts=cutouts,
            source_label=label or "Selected sky position",
        )
        self.cache.put_spectrum(spectrum_key=spectrum_key, ra=ra, dec=dec, payload=payload)
        return payload

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
    @app.get("/api/earth-to-sky")
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
    @app.get("/api/catalogs")
    async def get_catalogs(
        response: Response,
        ra: float = Query(..., ge=0.0, le=360.0),
        dec: float = Query(..., ge=-90.0, le=90.0),
        fov: float = Query(5.0, gt=0.0, le=60.0),
        live_catalogs: bool = Query(True),
    ) -> dict[str, Any]:
        response.headers["Cache-Control"] = "public, max-age=3600"
        return await backend_service.get_catalogs_async(
            ra=ra,
            dec=dec,
            fov=fov,
            live_catalogs=live_catalogs,
        )

    @app.get("/api/v1/catalogs/search")
    @app.get("/api/catalogs/search")
    async def search_catalog_objects(
        response: Response,
        q: str = Query("", description="Fuzzy search query for celestial object names/IDs"),
        limit: int = Query(30, ge=1, le=200),
    ) -> dict[str, Any]:
        response.headers["Cache-Control"] = "public, max-age=86400"
        results = backend_service.search_known_objects(query=q, limit=limit)
        return {
            "query": q,
            "count": len(results),
            "results": results,
        }

    @app.get("/api/v1/solar-system/in-fov")
    @app.get("/api/solar-system/in-fov")
    async def solar_system_in_fov(
        ra: float = Query(..., ge=0.0, le=360.0),
        dec: float = Query(..., ge=-90.0, le=90.0),
        fov: float = Query(5.0, gt=0.0, le=60.0),
        mjd: float | None = Query(None),
    ) -> dict[str, Any]:
        return backend_service.get_solar_system_in_fov(ra=ra, dec=dec, fov=fov, mjd=mjd)

    @app.get("/api/v1/solar-system/most")
    @app.get("/api/solar-system/most")
    async def lookup_most_solar_system(
        response: Response,
        obj_name: str = Query(..., min_length=1),
    ) -> dict[str, Any]:
        response.headers["Cache-Control"] = "public, max-age=3600"
        return await backend_service.lookup_most_object(obj_name=obj_name)

    @app.get("/api/v1/sky-patch")
    @app.get("/api/sky-patch")
    async def get_sky_patch(
        response: Response,
        ra: float = Query(..., ge=0.0, le=360.0),
        dec: float = Query(..., ge=-90.0, le=90.0),
        fov: float = Query(5.0, gt=0.0, le=60.0),
        live_catalogs: bool = Query(True),
    ) -> dict[str, Any]:
        response.headers["Cache-Control"] = "public, max-age=3600"
        return await backend_service.get_sky_patch_async(
            ra=ra,
            dec=dec,
            fov=fov,
            live_catalogs=live_catalogs,
        )

    @app.get("/api/v1/frames/{grid_key}/{filename}")
    @app.get("/api/frames/{grid_key}/{filename}")
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
    @app.get("/api/spectrum")
    async def get_spectrum(
        response: Response,
        ra: float = Query(..., ge=0.0, le=360.0),
        dec: float = Query(..., ge=-90.0, le=90.0),
    ) -> dict[str, Any]:
        response.headers["Cache-Control"] = "public, max-age=3600"
        try:
            return backend_service.get_forced_spectrum(ra=ra, dec=dec)
        except SpectrumExtractionError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(
                status_code=503, detail=f"SPHEREx spectrum unavailable: {exc}"
            ) from exc

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
