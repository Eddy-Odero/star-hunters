"""Known-object synthesis: Gaia DR3 + WISE + NASA MOST -> ``KnownCelestialObject[]`` (ISS-07).

Pure, dependency-free (stdlib only) so it can be unit-tested without the rest of the backend.

Pipeline:
1. Cross-match WISE sources against Gaia DR3 within 2.5 arcsec. A matched WISE source is the
   same physical star as its Gaia counterpart (optical + IR), so it is folded into the Gaia
   object. An unmatched WISE source with ``w1_w2_color >= 0.8`` is an infrared-only brown dwarf
   candidate; any other unmatched WISE source is a plain infrared source.
2. For every object compute ``epoch_positions`` for *every* epoch: Gaia/WISE proper motions are
   propagated linearly from the epoch at which the catalog position is valid to each epoch MJD,
   and MOST ephemeris rows are used directly (interpolated/extrapolated by MJD when an epoch has
   no ephemeris row).
3. Rank objects and set ``default_checked`` on the notable ones only (central target, MOST
   movers, brown dwarf candidates, high proper motion stars), capped at the top 8.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from typing import Any

GAIA_J2016_MJD = 57388.5  # Gaia DR3 reference epoch J2016.0 (JD 2457389.0)
DAYS_PER_YEAR = 365.25
WISE_GAIA_MATCH_ARCSEC = 2.5
BROWN_DWARF_MIN_W1_W2 = 0.8
HIGH_PM_ARCSEC_YR = 0.15
MAX_DEFAULT_CHECKED = 8

_MAS_PER_DEG = 3_600_000.0
_ARCSEC_PER_DEG = 3600.0

# Lower number = higher priority when more than MAX_DEFAULT_CHECKED objects are notable.
_RANK_CENTRAL = 0
_RANK_MOVER = 1
_RANK_BROWN_DWARF = 2
_RANK_HIGH_PM = 3


def angular_separation_arcsec(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    """Great-circle separation in arcseconds (haversine; stable for tiny angles)."""
    p1, p2 = math.radians(dec1), math.radians(dec2)
    dphi = p2 - p1
    dlam = math.radians(((ra2 - ra1 + 180.0) % 360.0) - 180.0)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlam / 2.0) ** 2
    return math.degrees(2.0 * math.asin(min(1.0, math.sqrt(a)))) * _ARCSEC_PER_DEG


def propagate_position(
    ra: float,
    dec: float,
    pmra_mas_yr: float,
    pmdec_mas_yr: float,
    dt_years: float,
) -> tuple[float, float]:
    """Linear proper-motion propagation. ``pmra_mas_yr`` is Gaia's pmra* (= mu_alpha cos dec)."""
    cos_dec = max(1e-6, math.cos(math.radians(dec)))
    new_dec = dec + (pmdec_mas_yr / _MAS_PER_DEG) * dt_years
    new_ra = ra + (pmra_mas_yr / _MAS_PER_DEG) * dt_years / cos_dec
    return new_ra % 360.0, max(-90.0, min(90.0, new_dec))


def project_to_pixel(ra: float, dec: float, wcs: dict[str, Any]) -> tuple[float, float]:
    """Project (ra, dec) to 256x256 WCS pixel (x, y); same convention as ``sky_to_pixel``."""
    ra0, dec0 = wcs["crval"]
    x0, y0 = wcs["crpix"]
    cdelt_x, cdelt_y = wcs["cdelt"]
    dra = ((ra - ra0 + 180.0) % 360.0) - 180.0
    x = x0 + (dra * math.cos(math.radians(dec0))) / cdelt_x
    y = y0 + (dec - dec0) / cdelt_y
    return round(x, 3), round(y, 3)


def match_wise_to_gaia(
    wise_sources: Sequence[dict[str, Any]],
    gaia_sources: Sequence[dict[str, Any]],
    radius_arcsec: float = WISE_GAIA_MATCH_ARCSEC,
    wise_epoch_mjd: float | None = None,
    gaia_epoch_mjd: float = GAIA_J2016_MJD,
) -> dict[str, tuple[str, float]]:
    """One-to-one nearest-neighbour match; returns ``{wise_source_id: (gaia_source_id, sep")}``.

    If ``wise_epoch_mjd`` is given, Gaia positions are propagated to that epoch first so fast
    movers still match (a 10"/yr star moves ~60" between WISE and Gaia epochs).
    """
    pairs: list[tuple[float, str, str]] = []
    for w in wise_sources:
        for g in gaia_sources:
            g_ra, g_dec = float(g["ra"]), float(g["dec"])
            if wise_epoch_mjd is not None:
                g_ra, g_dec = propagate_position(
                    g_ra,
                    g_dec,
                    float(g.get("pmra") or 0.0),
                    float(g.get("pmdec") or 0.0),
                    (wise_epoch_mjd - gaia_epoch_mjd) / DAYS_PER_YEAR,
                )
            sep = angular_separation_arcsec(float(w["ra"]), float(w["dec"]), g_ra, g_dec)
            if sep <= radius_arcsec:
                pairs.append((sep, str(w["source_id"]), str(g["source_id"])))
    pairs.sort()
    used_w: set[str] = set()
    used_g: set[str] = set()
    matches: dict[str, tuple[str, float]] = {}
    for sep, wid, gid in pairs:
        if wid in used_w or gid in used_g:
            continue
        used_w.add(wid)
        used_g.add(gid)
        matches[wid] = (gid, round(sep, 3))
    return matches


def classify_wise_source(row: dict[str, Any], has_gaia_match: bool) -> str:
    """'optical_ir_star' | 'brown_dwarf_candidate' | 'infrared_source'."""
    if has_gaia_match:
        return "optical_ir_star"
    if float(row["w1_w2_color"]) >= BROWN_DWARF_MIN_W1_W2:
        return "brown_dwarf_candidate"
    return "infrared_source"


def compute_epoch_positions(
    ra: float,
    dec: float,
    pmra_mas_yr: float,
    pmdec_mas_yr: float,
    position_epoch_mjd: float,
    epochs: Sequence[dict[str, Any]],
    wcs: dict[str, Any],
) -> list[dict[str, Any]]:
    """One ``KnownObjectEpochPosition`` dict per epoch, in epoch order."""
    out: list[dict[str, Any]] = []
    for ep in epochs:
        mjd = float(ep["mjd"])
        e_ra, e_dec = propagate_position(
            ra, dec, pmra_mas_yr, pmdec_mas_yr, (mjd - position_epoch_mjd) / DAYS_PER_YEAR
        )
        x, y = project_to_pixel(e_ra, e_dec, wcs)
        out.append(
            {
                "epoch_id": ep["epoch_id"],
                "mjd": mjd,
                "ra": round(e_ra, 7),
                "dec": round(e_dec, 7),
                "x": x,
                "y": y,
            }
        )
    return out


def _motion_vector(positions: Sequence[dict[str, Any]]) -> dict[str, float]:
    """Displacement first -> last epoch in pixels and arcseconds."""
    if len(positions) < 2:
        return {"dx_px": 0.0, "dy_px": 0.0, "dra_arcsec": 0.0, "ddec_arcsec": 0.0}
    a, b = positions[0], positions[-1]
    dra = ((b["ra"] - a["ra"] + 180.0) % 360.0) - 180.0
    cos_dec = math.cos(math.radians(a["dec"]))
    return {
        "dx_px": round(b["x"] - a["x"], 3),
        "dy_px": round(b["y"] - a["y"], 3),
        "dra_arcsec": round(dra * cos_dec * _ARCSEC_PER_DEG, 4),
        "ddec_arcsec": round((b["dec"] - a["dec"]) * _ARCSEC_PER_DEG, 4),
    }


def _most_epoch_positions(
    rows: Sequence[dict[str, Any]],
    epochs: Sequence[dict[str, Any]],
    wcs: dict[str, Any],
) -> list[dict[str, Any]]:
    """Ephemeris position at every epoch; interpolate/extrapolate linearly in MJD if missing."""
    mjd_by_epoch = {str(ep["epoch_id"]): float(ep["mjd"]) for ep in epochs}
    known = sorted(
        (mjd_by_epoch[str(r["epoch_id"])], float(r["ra"]), float(r["dec"]))
        for r in rows
        if str(r["epoch_id"]) in mjd_by_epoch
    )
    if not known:
        return []
    out: list[dict[str, Any]] = []
    for ep in epochs:
        mjd = float(ep["mjd"])
        exact = [k for k in known if abs(k[0] - mjd) < 1e-9]
        if exact:
            _, ra, dec = exact[0]
        elif len(known) == 1:
            _, ra, dec = known[0]
        else:
            lo, hi = known[0], known[-1]
            for i in range(len(known) - 1):
                if known[i][0] <= mjd <= known[i + 1][0]:
                    lo, hi = known[i], known[i + 1]
                    break
            else:
                if mjd > known[-1][0]:
                    lo, hi = known[-2], known[-1]
            t = (mjd - lo[0]) / (hi[0] - lo[0])
            dra = ((hi[1] - lo[1] + 180.0) % 360.0) - 180.0
            ra = (lo[1] + t * dra) % 360.0
            dec = max(-90.0, min(90.0, lo[2] + t * (hi[2] - lo[2])))
        x, y = project_to_pixel(ra, dec, wcs)
        out.append(
            {
                "epoch_id": ep["epoch_id"],
                "mjd": mjd,
                "ra": round(ra, 7),
                "dec": round(dec, 7),
                "x": x,
                "y": y,
            }
        )
    return out


def _pm_from_positions(positions: Sequence[dict[str, Any]]) -> tuple[float, float]:
    """(pmra*, pmdec) in mas/yr implied by first -> last epoch displacement."""
    if len(positions) < 2:
        return 0.0, 0.0
    a, b = positions[0], positions[-1]
    years = (b["mjd"] - a["mjd"]) / DAYS_PER_YEAR
    if abs(years) < 1e-9:
        return 0.0, 0.0
    dra = ((b["ra"] - a["ra"] + 180.0) % 360.0) - 180.0
    pmra = dra * math.cos(math.radians(a["dec"])) * _MAS_PER_DEG / years
    pmdec = (b["dec"] - a["dec"]) * _MAS_PER_DEG / years
    return pmra, pmdec


def _assemble(
    *,
    object_id: str,
    label: str,
    catalog: str,
    object_type: str,
    positions: list[dict[str, Any]],
    magnitude: float | None,
    pmra: float,
    pmdec: float,
    w1_w2_color: float | None,
    data_source: str,
) -> dict[str, Any]:
    first = positions[0]
    return {
        "object_id": object_id,
        "label": label,
        "catalog": catalog,
        "object_type": object_type,
        "ra": first["ra"],
        "dec": first["dec"],
        "x": first["x"],
        "y": first["y"],
        "magnitude": magnitude,
        "proper_motion_arcsec_yr": round(math.hypot(pmra, pmdec) / 1000.0, 4),
        "w1_w2_color": w1_w2_color,
        "default_checked": False,
        "epoch_positions": positions,
        "pmra_mas_yr": round(pmra, 3),
        "pmdec_mas_yr": round(pmdec, 3),
        "motion_vector": _motion_vector(positions),
        "data_source": data_source,
    }


def _rank(obj: dict[str, Any], central_object_id: str | None) -> int | None:
    """Notability rank (lower = more notable) or None for a stationary field object."""
    if central_object_id is not None and obj["object_id"] == central_object_id:
        return _RANK_CENTRAL
    if obj["object_type"] == "solar_system":
        return _RANK_MOVER
    if obj["object_type"] == "brown_dwarf_candidate":
        return _RANK_BROWN_DWARF
    if (obj["proper_motion_arcsec_yr"] or 0.0) >= HIGH_PM_ARCSEC_YR:
        return _RANK_HIGH_PM
    return None


def build_known_objects(
    gaia_sources: Iterable[dict[str, Any]],
    wise_sources: Iterable[dict[str, Any]],
    most_rows: Iterable[dict[str, Any]],
    wcs: dict[str, Any],
    epochs: Sequence[dict[str, Any]],
    *,
    central_object_id: str | None = None,
    gaia_position_epoch_mjd: float = GAIA_J2016_MJD,
    wise_position_epoch_mjd: float | None = None,
    max_checked: int = MAX_DEFAULT_CHECKED,
) -> list[dict[str, Any]]:
    """Synthesize the unified ``known_objects`` list for one sky patch.

    Input rows follow the ``catalog_overlays`` shapes (``gaia_dr3``, ``wise_sources``,
    ``most_solar_system``) and may carry optional in-memory keys: ``pmra`` / ``pmdec`` (mas/yr,
    Gaia and WISE rows), ``object_id``, ``label``, ``object_type``.

    ``gaia_position_epoch_mjd`` is the epoch at which the Gaia/WISE (ra, dec) are valid
    (J2016.0 for real Gaia rows; pass the first patch epoch for positions already placed there).
    Every returned object has exactly one ``epoch_positions`` entry per epoch in ``epochs``.
    """
    gaia = list(gaia_sources)
    wise = list(wise_sources)
    most = list(most_rows)
    if not epochs:
        raise ValueError("epochs must contain at least one epoch")
    wise_epoch = wise_position_epoch_mjd if wise_position_epoch_mjd is not None else None
    matches = match_wise_to_gaia(
        wise, gaia, wise_epoch_mjd=wise_epoch, gaia_epoch_mjd=gaia_position_epoch_mjd
    )
    wise_by_gaia = {gid: (wid, sep) for wid, (gid, sep) in matches.items()}
    wise_by_id = {str(w["source_id"]): w for w in wise}

    objects: list[dict[str, Any]] = []

    for g in gaia:
        sid = str(g["source_id"])
        pmra, pmdec = float(g.get("pmra") or 0.0), float(g.get("pmdec") or 0.0)
        partner = wise_by_gaia.get(sid)
        color = float(wise_by_id[partner[0]]["w1_w2_color"]) if partner else None
        pm_tot = math.hypot(pmra, pmdec) / 1000.0
        high_pm = pm_tot >= HIGH_PM_ARCSEC_YR
        positions = compute_epoch_positions(
            float(g["ra"]), float(g["dec"]), pmra, pmdec, gaia_position_epoch_mjd, epochs, wcs
        )
        objects.append(
            _assemble(
                object_id=str(g.get("object_id") or f"gaia:{sid}"),
                label=str(
                    g.get("label") or f"Gaia DR3 {sid}{' (High-PM Star)' if high_pm else ''}"
                ),
                catalog="gaia_dr3",
                object_type=str(g.get("object_type") or ("high_pm_star" if high_pm else "star")),
                positions=positions,
                magnitude=float(g["g_mag"]),
                pmra=pmra,
                pmdec=pmdec,
                w1_w2_color=color,
                data_source=(
                    f'Gaia DR3 + AllWISE (matched within {WISE_GAIA_MATCH_ARCSEC}")'
                    if partner
                    else "Gaia DR3"
                ),
            )
        )

    for w in wise:
        wid = str(w["source_id"])
        if wid in matches:
            continue  # same star as its Gaia counterpart; already represented above
        color = float(w["w1_w2_color"])
        kind = classify_wise_source(w, has_gaia_match=False)
        pmra, pmdec = float(w.get("pmra") or 0.0), float(w.get("pmdec") or 0.0)
        positions = compute_epoch_positions(
            float(w["ra"]),
            float(w["dec"]),
            pmra,
            pmdec,
            gaia_position_epoch_mjd if wise_epoch is None else wise_epoch,
            epochs,
            wcs,
        )
        is_bd = kind == "brown_dwarf_candidate"
        objects.append(
            _assemble(
                object_id=str(w.get("object_id") or f"wise:{wid}"),
                label=str(
                    w.get("label") or f"AllWISE {wid}{' (Red IR Candidate)' if is_bd else ''}"
                ),
                catalog="wise",
                object_type=str(w.get("object_type") or kind),
                positions=positions,
                magnitude=float(w["w2_mag"]),
                pmra=pmra,
                pmdec=pmdec,
                w1_w2_color=color,
                data_source='AllWISE (no Gaia counterpart within 2.5")',
            )
        )

    rows_by_name: dict[str, list[dict[str, Any]]] = {}
    for r in most:
        rows_by_name.setdefault(str(r["object_name"]), []).append(r)
    for name, rows in rows_by_name.items():
        positions = _most_epoch_positions(rows, epochs, wcs)
        if not positions:
            continue
        pmra, pmdec = _pm_from_positions(positions)
        objects.append(
            _assemble(
                object_id=str(rows[0].get("object_id") or f"most:{name}"),
                label=str(rows[0].get("label") or name),
                catalog="most",
                object_type="solar_system",
                positions=positions,
                magnitude=float(rows[0]["v_mag"]),
                pmra=pmra,
                pmdec=pmdec,
                w1_w2_color=None,
                data_source="NASA MOST ephemeris",
            )
        )

    return rank_and_flag_objects(objects, central_object_id, max_checked)


def rank_and_flag_objects(
    objects: list[dict[str, Any]],
    central_object_id: str | None = None,
    max_checked: int = MAX_DEFAULT_CHECKED,
) -> list[dict[str, Any]]:
    """Set ``default_checked`` on the top ``max_checked`` notable objects; order them first."""
    ranked: list[tuple[tuple[int, float, float, str], dict[str, Any]]] = []
    rest: list[dict[str, Any]] = []
    for obj in objects:
        rank = _rank(obj, central_object_id)
        if rank is None:
            obj["default_checked"] = False
            rest.append(obj)
        else:
            mag = obj["magnitude"] if obj["magnitude"] is not None else 99.0
            ranked.append(
                ((rank, -(obj["proper_motion_arcsec_yr"] or 0.0), mag, obj["object_id"]), obj)
            )
    ranked.sort(key=lambda item: item[0])
    for i, (_, obj) in enumerate(ranked):
        obj["default_checked"] = i < max_checked
    rest.sort(
        key=lambda o: (o["magnitude"] if o["magnitude"] is not None else 99.0, o["object_id"])
    )
    ordered = [obj for _, obj in ranked]
    # Notable-but-over-the-cap objects stay unchecked, listed after the checked ones.
    return ordered + rest