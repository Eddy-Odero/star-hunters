"""Automated multi-catalog celestial caching, classification, and epoch-propagation pipeline.

Integrates zero-auth machine APIs without using any ``cds.unistra.fr`` endpoints:
  1. SIMBAD TAP (IDIA primary, Harvard CfA fallback) — canonical names & object types
  2. ESA Gaia DR3 TAP (with ARI Heidelberg TAP & VizieR CfA TSV fallback) — astrometry & J2016.0 PM
  3. NASA/JPL Horizons REST API — planets, major moons, comets & asteroids
  4. NASA/IPAC IRSA MOST API (Brief/VOTable IPAC table) — SPHEREx moving-object intersections
"""

from __future__ import annotations

import asyncio
import csv
import io
import math
import re
import time
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from .logging_config import get_logger
from .spatial_cache import (
    DEFAULT_CATALOG_TTL_SECONDS,
    SpatialSqliteCache,
    angular_separation_deg,
)

_logger = get_logger("celestial_pipeline")

# Official endpoints only — NEVER use cds.unistra.fr due to upstream outages.
SIMBAD_TAP_ENDPOINTS: tuple[str, ...] = (
    "https://simbad.idia.ac.za/simbad/sim-tap/sync",
    "https://simbad.cfa.harvard.edu/simbad/sim-tap/sync",
)

GAIA_DR3_TAP_ENDPOINTS: tuple[str, ...] = (
    "https://gea.esac.esa.int/tap-server/tap/sync",
    "https://gaia.ari.uni-heidelberg.de/tap/sync",
)

VIZIER_GAIA_CFA_ENDPOINT = "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv"
JPL_HORIZONS_ENDPOINT = "https://ssd.jpl.nasa.gov/api/horizons.api"
IRSA_MOST_ENDPOINT = "https://irsa.ipac.caltech.edu/cgi-bin/MOST/nph-most"

_MJD_EPOCH = datetime(1858, 11, 17, 0, 0, 0, tzinfo=UTC)
GAIA_DR3_REF_YEAR = 2016.0

HORIZONS_FEATURED_BODIES: tuple[dict[str, str], ...] = (
    # Major planets (Earth excluded because CENTER='500@399' is geocentric)
    {
        "naif_id": "199",
        "cmd": "199",
        "name": "Mercury",
        "body_class": "planet",
        "most_name": "Mercury",
    },
    {"naif_id": "299", "cmd": "299", "name": "Venus", "body_class": "planet", "most_name": "Venus"},
    {"naif_id": "499", "cmd": "499", "name": "Mars", "body_class": "planet", "most_name": "Mars"},
    {
        "naif_id": "599",
        "cmd": "599",
        "name": "Jupiter",
        "body_class": "planet",
        "most_name": "Jupiter",
    },
    {
        "naif_id": "699",
        "cmd": "699",
        "name": "Saturn",
        "body_class": "planet",
        "most_name": "Saturn",
    },
    {
        "naif_id": "799",
        "cmd": "799",
        "name": "Uranus",
        "body_class": "planet",
        "most_name": "Uranus",
    },
    {
        "naif_id": "899",
        "cmd": "899",
        "name": "Neptune",
        "body_class": "planet",
        "most_name": "Neptune",
    },
    # Major Jovian & Saturnian moons
    {"naif_id": "501", "cmd": "501", "name": "Io", "body_class": "moon", "most_name": "Io"},
    {"naif_id": "502", "cmd": "502", "name": "Europa", "body_class": "moon", "most_name": "Europa"},
    {
        "naif_id": "503",
        "cmd": "503",
        "name": "Ganymede",
        "body_class": "moon",
        "most_name": "Ganymede",
    },
    {
        "naif_id": "504",
        "cmd": "504",
        "name": "Callisto",
        "body_class": "moon",
        "most_name": "Callisto",
    },
    {"naif_id": "606", "cmd": "606", "name": "Titan", "body_class": "moon", "most_name": "Titan"},
    # Featured interstellar comet & main-belt asteroids
    {
        "naif_id": "C/2025 N1",
        "cmd": "DES=C/2025 N1;",
        "name": "3I/ATLAS (C/2025 N1)",
        "body_class": "comet",
        "most_name": "3I",
    },
    {
        "naif_id": "1",
        "cmd": "1;",
        "name": "(1) Ceres",
        "body_class": "asteroid",
        "most_name": "20000001:NID",
    },
    {
        "naif_id": "4",
        "cmd": "4;",
        "name": "(4) Vesta",
        "body_class": "asteroid",
        "most_name": "20000004:NID",
    },
)

MOST_NAME_ALIASES: dict[str, str] = {
    "ceres": "20000001:NID",
    "1 ceres": "20000001:NID",
    "(1) ceres": "20000001:NID",
    "vesta": "20000004:NID",
    "4 vesta": "20000004:NID",
    "(4) vesta": "20000004:NID",
    "3i/atlas": "3I",
    "comet 3i/atlas": "3I",
    "c/2025 n1": "3I",
    "3i": "3I",
}


def mjd_to_julian_year(mjd: float) -> float:
    """Convert Modified Julian Date (MJD) to Julian year (e.g. MJD 57388.0 -> J2016.0)."""
    return 2000.0 + (float(mjd) - 51544.5) / 365.25


def iso_datetime_to_mjd(iso_or_horizons_date: str) -> float:
    """Parse ISO ('2025-05-01T00:00:00') or Horizons ('2025-May-01 00:00') date into UTC MJD."""
    cleaned = iso_or_horizons_date.strip()
    for fmt in (
        "%Y-%b-%d %H:%M",
        "%Y-%b-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
    ):
        try:
            dt = datetime.strptime(cleaned, fmt).replace(tzinfo=UTC)
            return (dt - _MJD_EPOCH).total_seconds() / 86400.0
        except ValueError:
            continue
    dt = datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return (dt - _MJD_EPOCH).total_seconds() / 86400.0


def propagate_gaia_epoch(
    ra_deg: float,
    dec_deg: float,
    pmra_mas_yr: float | None,
    pmdec_mas_yr: float | None,
    target_mjd: float,
    ref_year: float = GAIA_DR3_REF_YEAR,
) -> tuple[float, float]:
    """Propagate ICRS coordinates from reference epoch (Gaia J2016.0) to `target_mjd`.

    Gaia DR3 `pmra` is already mu_alpha* = mu_alpha * cos(dec) in mas/yr.
    Returns `(ra_epoch_deg, dec_epoch_deg)` normalized to [0, 360) and [-90, 90].
    """
    dt_yr = mjd_to_julian_year(target_mjd) - ref_year
    pmra = float(pmra_mas_yr or 0.0)
    pmdec = float(pmdec_mas_yr or 0.0)
    cos_dec = max(1e-4, math.cos(math.radians(dec_deg)))
    ra_epoch = (float(ra_deg) + (pmra * dt_yr) / (3600000.0 * cos_dec)) % 360.0
    dec_epoch = max(-90.0, min(90.0, float(dec_deg) + (pmdec * dt_yr) / 3600000.0))
    return round(ra_epoch, 6), round(dec_epoch, 6)


def sky_to_pixel_tan(ra: float, dec: float, wcs: dict[str, Any]) -> tuple[float, float]:
    """Project ICRS (ra, dec) to 256x256 TAN WCS pixel coordinates `(x, y)`."""
    ra0, dec0 = float(wcs["crval"][0]), float(wcs["crval"][1])
    x0, y0 = float(wcs["crpix"][0]), float(wcs["crpix"][1])
    cdelt_x, cdelt_y = float(wcs["cdelt"][0]), float(wcs["cdelt"][1])
    cos_dec = math.cos(math.radians(dec0))
    dra = ((float(ra) - ra0 + 180.0) % 360.0) - 180.0
    x = x0 + (dra * cos_dec) / cdelt_x
    y = y0 + (float(dec) - dec0) / cdelt_y
    return round(x, 2), round(y, 2)


def map_simbad_otype(
    otype: str | None,
    total_pm_arcsec_yr: float | None = None,
) -> tuple[str, str]:
    """Map SIMBAD `otype` code to `(object_class, legacy_object_type)`.

    Preserves existing `KnownCelestialObject.object_type` compatibility while providing
    granular UI badge classes (`star`, `brown_dwarf`, `galaxy`, `nebula`, etc.).
    """
    raw = (otype or "").strip()
    low = raw.lower()
    if low in {"bd*", "brownd*", "bd?", "brownd?"} or "bd*" in low:
        return "brown_dwarf", "brown_dwarf_candidate"
    if raw in {
        "G",
        "GiG",
        "GiC",
        "BiC",
        "AGN",
        "QSO",
        "SyG",
        "Sy1",
        "Sy2",
        "LIN",
        "BZG",
        "Bla",
        "rG",
        "IG",
        "EmG",
        "LSB",
        "H2G",
        "ClG",
        "PaG",
    } or low.startswith(("gal", "qso", "agn")):
        return "galaxy", "infrared_source"
    if raw in {"PN", "PN?", "HII", "SNR", "Cld", "MoC", "DNe", "RNe", "BNe", "ISM", "GNe", "Neb"}:
        return "nebula", "infrared_source"
    if (
        raw
        in {
            "V*",
            "Mi*",
            "LP*",
            "OH*",
            "C*",
            "S*",
            "AB*",
            "pA*",
            "TT*",
            "Or*",
            "RI*",
            "RR*",
            "Ce*",
            "dS*",
            "BY*",
            "RS*",
            "Fl*",
            "No*",
            "SN*",
            "CV*",
            "Y*O",
            "Y*?",
            "PR*",
            "WV*",
        }
        or "*" in raw
        and ("v" in low or "mi" in low or "lp" in low or "y*o" in low)
    ):
        return "variable_star", "variable_star"
    if raw in {"IR", "MIR", "NIR", "FIR", "smm", "Rad", "Mas"}:
        return "infrared_source", "infrared_source"
    if total_pm_arcsec_yr is not None and total_pm_arcsec_yr >= 0.15:
        return "star", "high_pm_star"
    if raw in {"PM*"}:
        return "star", "high_pm_star"
    return "star", "star"


def _safe_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        fval = float(value)
        return fval if math.isfinite(fval) else None
    text = str(value).strip()
    if not text or text.lower() in {"null", "nan", "none", "---", "--"}:
        return None
    try:
        fval = float(text)
        return fval if math.isfinite(fval) else None
    except ValueError:
        return None


def parse_tap_json_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Normalize TAP JSON `data` payloads whether formatted as lists or dicts (IDIA/ESA vs ARI)."""
    data = payload.get("data")
    if not isinstance(data, list) or not data:
        return []
    first = data[0]
    if isinstance(first, dict):
        normalized: list[dict[str, Any]] = []
        for row in data:
            if isinstance(row, dict):
                normalized.append({str(k).lower(): v for k, v in row.items()})
        return normalized

    metadata = payload.get("metadata")
    if not isinstance(metadata, list):
        return []
    col_names = [str(col.get("name", f"col_{idx}")).lower() for idx, col in enumerate(metadata)]
    rows_out: list[dict[str, Any]] = []
    for row in data:
        if isinstance(row, list):
            rows_out.append({col_names[i]: row[i] for i in range(min(len(col_names), len(row)))})
    return rows_out


def parse_vizier_gaia_tsv(tsv_text: str) -> list[dict[str, Any]]:
    """Parse VizieR CfA `asu-tsv` output for Gaia DR3 (`I/355/gaiadr3`)."""
    headers: list[str] | None = None
    rows: list[dict[str, Any]] = []
    past_divider = False
    for raw_line in tsv_text.splitlines():
        line = raw_line.rstrip("\r\n")
        if not line or line.startswith("#"):
            continue
        if headers is None:
            headers = [h.strip() for h in line.split("\t")]
            continue
        if not past_divider:
            if set(line.replace("\t", "").strip()) <= {"-"}:
                past_divider = True
            continue
        parts = [p.strip() for p in line.split("\t")]
        if len(parts) < 3:
            continue
        rec = {headers[i]: parts[i] if i < len(parts) else "" for i in range(len(headers))}
        ra = _safe_float(rec.get("RA_ICRS"))
        dec = _safe_float(rec.get("DE_ICRS"))
        sid = str(rec.get("Source", "")).strip()
        if not sid or ra is None or dec is None:
            continue
        rows.append(
            {
                "source_id": sid,
                "ra": ra,
                "dec": dec,
                "pmra": _safe_float(rec.get("pmRA")),
                "pmdec": _safe_float(rec.get("pmDE")),
                "parallax": _safe_float(rec.get("Plx")),
                "phot_g_mean_mag": _safe_float(rec.get("Gmag")),
            }
        )
    return rows


def _normalize_simbad_rows(raw_rows: list[dict[str, Any]], provider: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in raw_rows:
        main_id = str(row.get("main_id") or "").strip()
        ra = _safe_float(row.get("ra"))
        dec = _safe_float(row.get("dec"))
        if not main_id or ra is None or dec is None:
            continue
        otype = str(row.get("otype") or "").strip() or None
        pmra = _safe_float(row.get("pmra"))
        pmdec = _safe_float(row.get("pmdec"))
        out.append(
            {
                "main_id": " ".join(main_id.split()),
                "otype": otype,
                "ra": ra % 360.0,
                "dec": dec,
                "pmra": pmra,
                "pmdec": pmdec,
                "provider": provider,
            }
        )
    return out


async def fetch_simbad_objects(
    ra_deg: float,
    dec_deg: float,
    radius_deg: float,
    client: httpx.AsyncClient | None = None,
    limit: int = 500,
    timeout_s: float = 12.0,
    parallel_mirrors: bool = False,
) -> tuple[list[dict[str, Any]], str]:
    """Query SIMBAD TAP via official mirrors (`simbad.idia.ac.za`, `simbad.cfa.harvard.edu`).

    Never queries `cds.unistra.fr`. Returns `(normalized_records, provider_tag)`.
    """
    clamped_limit = max(1, min(500, int(limit)))
    adql = (
        f"SELECT TOP {clamped_limit} main_id, otype, ra, dec, pmra, pmdec "
        "FROM basic "
        "WHERE CONTAINS(POINT('ICRS', ra, dec), "
        f"CIRCLE('ICRS', {ra_deg:.6f}, {dec_deg:.6f}, {radius_deg:.6f})) = 1"
    )
    params = {
        "request": "doQuery",
        "lang": "adql",
        "format": "json",
        "query": adql,
    }

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=timeout_s)
    last_error = "unavailable"

    async def _query_one(endpoint: str) -> tuple[list[dict[str, Any]], str]:
        assert "cds.unistra.fr" not in endpoint
        provider = "simbad_idia" if "idia.ac.za" in endpoint else "simbad_cfa"
        resp = await http.get(endpoint, params=params, timeout=timeout_s)
        resp.raise_for_status()
        raw_rows = parse_tap_json_rows(resp.json())
        return _normalize_simbad_rows(raw_rows, provider=provider), provider

    try:
        if parallel_mirrors and len(SIMBAD_TAP_ENDPOINTS) > 1:
            tasks = [asyncio.create_task(_query_one(ep)) for ep in SIMBAD_TAP_ENDPOINTS]
            empty_fallback: tuple[list[dict[str, Any]], str] | None = None
            try:
                for fut in asyncio.as_completed(tasks):
                    try:
                        rows, provider = await fut
                        if rows:
                            return rows, provider
                        empty_fallback = (rows, provider)
                    except Exception as exc:  # noqa: BLE001
                        last_error = f"{type(exc).__name__}"
                        continue
            finally:
                for t in tasks:
                    if not t.done():
                        t.cancel()
            if empty_fallback is not None:
                return empty_fallback
            return [], f"unavailable:{last_error}"

        for endpoint in SIMBAD_TAP_ENDPOINTS:
            provider = "simbad_idia" if "idia.ac.za" in endpoint else "simbad_cfa"
            try:
                return await _query_one(endpoint)
            except Exception as exc:  # noqa: BLE001
                last_error = f"{provider}:{type(exc).__name__}"
                continue
    finally:
        if owns_client:
            await http.aclose()
    return [], f"unavailable:{last_error}"


async def fetch_gaia_dr3_objects(
    ra_deg: float,
    dec_deg: float,
    radius_deg: float,
    client: httpx.AsyncClient | None = None,
    limit: int = 1000,
    max_g_mag: float = 18.0,
    timeout_s: float = 12.0,
    parallel_mirrors: bool = False,
) -> tuple[list[dict[str, Any]], str]:
    """Query ESA Gaia DR3 TAP (`gea.esac.esa.int`) with ARI TAP & VizieR CfA fallbacks."""
    clamped_limit = max(1, min(1000, int(limit)))
    adql = (
        f"SELECT TOP {clamped_limit} source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag "
        "FROM gaiadr3.gaia_source "
        "WHERE CONTAINS(POINT('ICRS', ra, dec), "
        f"CIRCLE('ICRS', {ra_deg:.6f}, {dec_deg:.6f}, {radius_deg:.6f})) = 1 "
        f"AND phot_g_mean_mag < {max_g_mag:.2f}"
    )
    params = {
        "request": "doQuery",
        "lang": "adql",
        "format": "json",
        "query": adql,
    }

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=timeout_s)
    last_error = "unavailable"

    async def _query_tap(endpoint: str) -> tuple[list[dict[str, Any]], str]:
        assert "cds.unistra.fr" not in endpoint
        provider = "gaia_esa" if "esac.esa.int" in endpoint else "gaia_ari"
        resp = await http.get(endpoint, params=params, timeout=timeout_s)
        resp.raise_for_status()
        raw_rows = parse_tap_json_rows(resp.json())
        return _normalize_gaia_rows(raw_rows, provider=provider), provider

    async def _query_vizier() -> tuple[list[dict[str, Any]], str]:
        assert "cds.unistra.fr" not in VIZIER_GAIA_CFA_ENDPOINT
        vz_params = {
            "-source": "I/355/gaiadr3",
            "-c": f"{ra_deg:.6f} {dec_deg:+.6f}",
            "-c.rd": f"{radius_deg:.6f}",
            "-out": "Source,RA_ICRS,DE_ICRS,pmRA,pmDE,Plx,Gmag",
            "-out.max": str(min(500, clamped_limit)),
            "Gmag": f"<{max_g_mag:.2f}",
        }
        resp = await http.get(VIZIER_GAIA_CFA_ENDPOINT, params=vz_params, timeout=timeout_s)
        resp.raise_for_status()
        parsed_tsv = parse_vizier_gaia_tsv(resp.text)
        return _normalize_gaia_rows(parsed_tsv, provider="gaia_vizier_cfa"), "gaia_vizier_cfa"

    try:
        if parallel_mirrors:
            tasks = [asyncio.create_task(_query_tap(ep)) for ep in GAIA_DR3_TAP_ENDPOINTS]
            tasks.append(asyncio.create_task(_query_vizier()))
            empty_fallback: tuple[list[dict[str, Any]], str] | None = None
            try:
                for fut in asyncio.as_completed(tasks):
                    try:
                        rows, provider = await fut
                        if rows:
                            return rows, provider
                        empty_fallback = (rows, provider)
                    except Exception as exc:  # noqa: BLE001
                        last_error = f"{type(exc).__name__}"
                        continue
            finally:
                for t in tasks:
                    if not t.done():
                        t.cancel()
            if empty_fallback is not None:
                return empty_fallback
            return [], f"unavailable:{last_error}"

        for endpoint in GAIA_DR3_TAP_ENDPOINTS:
            provider = "gaia_esa" if "esac.esa.int" in endpoint else "gaia_ari"
            try:
                return await _query_tap(endpoint)
            except Exception as exc:  # noqa: BLE001
                last_error = f"{provider}:{type(exc).__name__}"
                continue

        # Fallback: VizieR Harvard CfA ASU-TSV mirror (zero-auth, no cds.unistra.fr)
        try:
            return await _query_vizier()
        except Exception as exc:  # noqa: BLE001
            last_error = f"{last_error}|vizier_cfa:{type(exc).__name__}"
    finally:
        if owns_client:
            await http.aclose()
    return [], f"unavailable:{last_error}"


def _normalize_gaia_rows(raw_rows: list[dict[str, Any]], provider: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in raw_rows:
        sid = str(row.get("source_id") or "").strip()
        ra = _safe_float(row.get("ra"))
        dec = _safe_float(row.get("dec"))
        if not sid or ra is None or dec is None:
            continue
        out.append(
            {
                "source_id": sid,
                "ra": ra % 360.0,
                "dec": dec,
                "pmra": _safe_float(row.get("pmra")),
                "pmdec": _safe_float(row.get("pmdec")),
                "parallax": _safe_float(row.get("parallax")),
                "phot_g_mean_mag": _safe_float(row.get("phot_g_mean_mag")),
                "provider": provider,
            }
        )
    out.sort(
        key=lambda item: item["phot_g_mean_mag"] if item["phot_g_mean_mag"] is not None else 99.0
    )
    return out


def parse_horizons_ephemeris_result(
    result_text: str,
    naif_id: str,
    body_name: str,
    body_class: str,
) -> list[dict[str, Any]]:
    """Parse JPL Horizons ASCII/CSV result block between ``$$SOE`` and ``$$EOE``."""
    lines = result_text.splitlines()
    soe_idx: int | None = None
    eoe_idx: int | None = None
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped == "$$SOE" and soe_idx is None:
            soe_idx = idx
        elif stripped == "$$EOE" and soe_idx is not None:
            eoe_idx = idx
            break
    if soe_idx is None or eoe_idx is None or eoe_idx <= soe_idx + 1:
        return []

    # Locate the CSV column header immediately preceding $$SOE
    header_cols: list[str] = []
    for back in range(soe_idx - 1, max(-1, soe_idx - 8), -1):
        candidate = lines[back]
        if "R.A." in candidate and "DEC" in candidate and "," in candidate:
            header_cols = [col.strip() for col in candidate.split(",")]
            break

    ra_idx = 3
    dec_idx = 4
    mag_idx: int | None = 5
    if header_cols:
        for idx, col in enumerate(header_cols):
            if "R.A." in col:
                ra_idx = idx
            elif "DEC" in col:
                dec_idx = idx
            elif col in {"APmag", "Vmag", "T-mag", "N-mag"}:
                if col in {"APmag", "T-mag", "Vmag"} or mag_idx is None:
                    mag_idx = idx

    points: list[dict[str, Any]] = []
    csv_block = "\n".join(lines[soe_idx + 1 : eoe_idx])
    for row in csv.reader(io.StringIO(csv_block)):
        if len(row) <= max(ra_idx, dec_idx):
            continue
        date_str = row[0].strip()
        ra_val = _safe_float(row[ra_idx])
        dec_val = _safe_float(row[dec_idx])
        if not date_str or ra_val is None or dec_val is None:
            continue
        vmag = _safe_float(row[mag_idx]) if mag_idx is not None and mag_idx < len(row) else None
        try:
            mjd_val = iso_datetime_to_mjd(date_str)
        except ValueError:
            continue
        date_bucket = (_MJD_EPOCH + timedelta(days=mjd_val)).date().isoformat()
        points.append(
            {
                "naif_id": str(naif_id),
                "body_name": body_name,
                "body_class": body_class,
                "date_bucket": date_bucket,
                "mjd": round(mjd_val, 6),
                "ra": ra_val % 360.0,
                "dec": max(-90.0, min(90.0, dec_val)),
                "vmag": vmag,
                "source": "jpl_horizons",
            }
        )
    return points


async def fetch_horizons_ephemeris(
    naif_cmd: str,
    naif_id: str,
    body_name: str,
    body_class: str,
    start_date: str = "2025-05-01",
    stop_date: str = "2026-12-31",
    step_size: str = "1d",
    client: httpx.AsyncClient | None = None,
    timeout_s: float = 12.0,
) -> list[dict[str, Any]]:
    """Query NASA/JPL Horizons REST API (`ssd.jpl.nasa.gov/api/horizons.api`) ephemeris."""
    params = {
        "format": "json",
        "COMMAND": f"'{naif_cmd}'",
        "OBJ_DATA": "'NO'",
        "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'OBSERVER'",
        "CENTER": "'500@399'",
        "START_TIME": f"'{start_date}'",
        "STOP_TIME": f"'{stop_date}'",
        "STEP_SIZE": f"'{step_size}'",
        "QUANTITIES": "'1,9'",
        "ANG_FORMAT": "'DEG'",
        "CSV_FORMAT": "'YES'",
    }
    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=timeout_s)
    try:
        resp = await http.get(JPL_HORIZONS_ENDPOINT, params=params, timeout=timeout_s)
        resp.raise_for_status()
        payload = resp.json()
        if "error" in payload and not payload.get("result"):
            return []
        result_text = str(payload.get("result") or "")
        return parse_horizons_ephemeris_result(
            result_text=result_text,
            naif_id=naif_id,
            body_name=body_name,
            body_class=body_class,
        )
    except Exception:  # noqa: BLE001
        return []
    finally:
        if owns_client:
            await http.aclose()


def parse_ipac_brief_table(ipac_text: str) -> list[dict[str, Any]]:
    """Parse IPAC ASCII `Brief` fixed-width table returned by NASA/IPAC IRSA MOST."""
    lines = ipac_text.splitlines()
    col_header_line: str | None = None
    data_start_idx = 0

    for idx, line in enumerate(lines):
        if line.startswith("\\"):
            continue
        if line.startswith("|"):
            if col_header_line is None:
                col_header_line = line
            data_start_idx = idx + 1
            continue
        if col_header_line is not None and line.strip():
            data_start_idx = idx
            break

    if not col_header_line:
        return []

    # Extract fixed-width slices defined by pipe positions in the column header line
    pipe_positions = [m.start() for m in re.finditer(r"\|", col_header_line)]
    col_slices: list[tuple[str, int, int]] = []
    for i in range(len(pipe_positions) - 1):
        start = pipe_positions[i] + 1
        end = pipe_positions[i + 1]
        col_name = col_header_line[start:end].strip().lower()
        if col_name:
            col_slices.append((col_name, start, end))

    records: list[dict[str, Any]] = []
    for line in lines[data_start_idx:]:
        if not line.strip() or line.startswith("\\") or line.startswith("|"):
            continue
        row: dict[str, Any] = {}
        tokens = line.split()
        if len(tokens) == len(col_slices):
            for (col_name, _, _), raw_val in zip(col_slices, tokens, strict=True):
                row[col_name] = None if raw_val.lower() in {"", "null", "nan"} else raw_val
        else:
            for col_name, start, end in col_slices:
                raw_val = line[start : min(len(line), end)].strip() if start < len(line) else ""
                row[col_name] = None if raw_val.lower() in {"", "null", "nan"} else raw_val
        ra_obj = _safe_float(row.get("ra_obj"))
        dec_obj = _safe_float(row.get("dec_obj"))
        if ra_obj is None or dec_obj is None:
            continue
        records.append(
            {
                "ra": ra_obj % 360.0,
                "dec": dec_obj,
                "vmag": _safe_float(row.get("vmag")),
                "mjd_start": _safe_float(row.get("mjd_start")),
                "mjd_end": _safe_float(row.get("mjd_end")),
                "start_date": row.get("start_date"),
                "end_date": row.get("end_date"),
                "uri": row.get("uri"),
                "sun_dist": _safe_float(row.get("sun_dist")),
                "geo_dist": _safe_float(row.get("geo_dist")),
            }
        )
    return records


async def fetch_most_spherex_matches(
    obj_name: str,
    client: httpx.AsyncClient | None = None,
    timeout_s: float = 12.0,
) -> dict[str, Any]:
    """Query NASA/IPAC IRSA MOST for SPHEREx exposures intersecting a Solar System object."""
    raw_key = obj_name.strip().lower()
    query_name = MOST_NAME_ALIASES.get(raw_key, obj_name.strip())
    params = {
        "catalog": "spherex",
        "input_type": "name_input",
        "obj_name": query_name,
        "output_mode": "Brief",
    }
    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=timeout_s)
    try:
        resp = await http.get(IRSA_MOST_ENDPOINT, params=params, timeout=timeout_s)
        if resp.status_code == 400:
            return {
                "query_name": query_name,
                "status": "no_match",
                "matches": [],
            }
        resp.raise_for_status()
        matches = parse_ipac_brief_table(resp.text)
        return {
            "query_name": query_name,
            "status": "ok" if matches else "no_match",
            "matches": matches,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "query_name": query_name,
            "status": f"unavailable:{type(exc).__name__}",
            "matches": [],
        }
    finally:
        if owns_client:
            await http.aclose()


class AutomatedCelestialPipeline:
    """Cache-first orchestrator combining SIMBAD TAP, Gaia DR3, JPL Horizons, and IRSA MOST."""

    def __init__(
        self,
        cache: SpatialSqliteCache,
        http_client: httpx.AsyncClient | None = None,
        catalog_ttl_seconds: float = DEFAULT_CATALOG_TTL_SECONDS,
    ) -> None:
        self.cache = cache
        self.http_client = http_client
        self.catalog_ttl_seconds = catalog_ttl_seconds

    def _read_cached_region_sync(
        self,
        source: str,
        ra_deg: float,
        dec_deg: float,
        radius_deg: float,
        allow_stale: bool = False,
    ) -> tuple[list[dict[str, Any]], str] | None:
        cached = self.cache.get_cached_catalog_region(
            source, ra_deg, dec_deg, radius_deg, allow_stale=allow_stale
        )
        if cached is None:
            return None
        prefix = "stale" if cached.get("stale") else "cached"
        return list(cached.get("objects", [])), f"{prefix}:{cached.get('provider', source)}"

    async def _get_region(
        self,
        source: str,
        fetcher: Any,
        ra_deg: float,
        dec_deg: float,
        radius_deg: float,
        allow_live: bool = True,
    ) -> tuple[list[dict[str, Any]], str]:
        hit = self._read_cached_region_sync(source, ra_deg, dec_deg, radius_deg, allow_stale=False)
        if hit is not None:
            return hit
        if not allow_live:
            stale = self._read_cached_region_sync(
                source, ra_deg, dec_deg, radius_deg, allow_stale=True
            )
            return stale if stale is not None else ([], "cache_only")

        t0 = time.perf_counter()
        try:
            records, provider = await fetcher(
                ra_deg=ra_deg,
                dec_deg=dec_deg,
                radius_deg=radius_deg,
                client=self.http_client,
                parallel_mirrors=True,
            )
        except TypeError:
            records, provider = await fetcher(
                ra_deg=ra_deg,
                dec_deg=dec_deg,
                radius_deg=radius_deg,
                client=self.http_client,
            )
        _logger.info(
            "Catalog %s query at (%.4f, %.4f) returned %d row(s) via %s in %.2fs",
            source,
            ra_deg,
            dec_deg,
            len(records),
            provider,
            time.perf_counter() - t0,
        )
        if records:
            self.cache.put_cached_catalog_region(
                source,
                ra_deg,
                dec_deg,
                radius_deg,
                {"provider": provider, "objects": records},
                ttl_seconds=self.catalog_ttl_seconds,
            )
            return records, f"live:{provider}"

        stale = self._read_cached_region_sync(source, ra_deg, dec_deg, radius_deg, allow_stale=True)
        return stale if stale is not None else ([], provider)

    async def resolve_live_horizons_for_body(
        self,
        body_spec: dict[str, str],
        target_date: datetime | None = None,
    ) -> dict[str, Any] | None:
        """Fetch and cache live JPL Horizons ephemeris around the active observation window."""
        now_dt = target_date or datetime.now(UTC)
        now_mjd = (now_dt - _MJD_EPOCH).total_seconds() / 86400.0
        cached = self.cache.get_ephemeris_for_body(body_spec["naif_id"], now_mjd)
        if cached is not None:
            return cached
        start_str = (now_dt.date() - timedelta(days=3)).isoformat()
        stop_str = (now_dt.date() + timedelta(days=3)).isoformat()
        points = await fetch_horizons_ephemeris(
            naif_cmd=body_spec["cmd"],
            naif_id=body_spec["naif_id"],
            body_name=body_spec["name"],
            body_class=body_spec["body_class"],
            start_date=start_str,
            stop_date=stop_str,
            step_size="1d",
            client=self.http_client,
        )
        if not points:
            return None
        self.cache.upsert_ephemeris_points(points)
        closest = min(points, key=lambda pt: abs(float(pt["mjd"]) - now_mjd))
        _logger.info(
            "JPL Horizons resolved live ephemeris for %s (NAIF %s) at RA=%.4f Dec=%.4f",
            body_spec["name"],
            body_spec["naif_id"],
            closest["ra"],
            closest["dec"],
        )
        return closest

    async def get_simbad_region(
        self,
        ra_deg: float,
        dec_deg: float,
        radius_deg: float,
        allow_live: bool = True,
    ) -> tuple[list[dict[str, Any]], str]:
        return await self._get_region(
            "simbad", fetch_simbad_objects, ra_deg, dec_deg, radius_deg, allow_live=allow_live
        )

    async def get_gaia_region(
        self,
        ra_deg: float,
        dec_deg: float,
        radius_deg: float,
        allow_live: bool = True,
    ) -> tuple[list[dict[str, Any]], str]:
        return await self._get_region(
            "gaia_dr3", fetch_gaia_dr3_objects, ra_deg, dec_deg, radius_deg, allow_live=allow_live
        )

    @staticmethod
    def _fov_to_radius_deg(fov_arcmin: float) -> float:
        return max(0.06, min(0.5, (float(fov_arcmin) / 60.0) * 0.75))

    def resolve_cached_patch_objects(
        self,
        ra_deg: float,
        dec_deg: float,
        fov_arcmin: float,
        wcs: dict[str, Any],
        epochs_meta: list[dict[str, Any]],
        max_objects: int = 120,
    ) -> dict[str, Any]:
        """Synchronously resolve SQLite-cached SIMBAD/Gaia regions + Solar System ephemerides."""
        radius_deg = self._fov_to_radius_deg(fov_arcmin)
        simbad_hit = self._read_cached_region_sync(
            "simbad", ra_deg, dec_deg, radius_deg, allow_stale=True
        )
        gaia_hit = self._read_cached_region_sync(
            "gaia_dr3", ra_deg, dec_deg, radius_deg, allow_stale=True
        )
        simbad_rows, simbad_status = simbad_hit if simbad_hit is not None else ([], "cache_only")
        gaia_rows, gaia_status = gaia_hit if gaia_hit is not None else ([], "cache_only")
        return self._assemble_patch_objects(
            ra_deg=ra_deg,
            dec_deg=dec_deg,
            radius_deg=radius_deg,
            wcs=wcs,
            epochs_meta=epochs_meta,
            simbad_rows=simbad_rows,
            simbad_status=simbad_status,
            gaia_rows=gaia_rows,
            gaia_status=gaia_status,
            max_objects=max_objects,
        )

    async def resolve_patch_objects(
        self,
        ra_deg: float,
        dec_deg: float,
        fov_arcmin: float,
        wcs: dict[str, Any],
        epochs_meta: list[dict[str, Any]],
        allow_live: bool = True,
        max_objects: int = 120,
    ) -> dict[str, Any]:
        """Resolve cached/live SIMBAD, Gaia DR3 (propagated to pass MJDs), and SQLite ephemeris."""
        radius_deg = self._fov_to_radius_deg(fov_arcmin)

        (simbad_rows, simbad_status), (gaia_rows, gaia_status) = await asyncio.gather(
            self.get_simbad_region(ra_deg, dec_deg, radius_deg, allow_live=allow_live),
            self.get_gaia_region(ra_deg, dec_deg, radius_deg, allow_live=allow_live),
        )
        return self._assemble_patch_objects(
            ra_deg=ra_deg,
            dec_deg=dec_deg,
            radius_deg=radius_deg,
            wcs=wcs,
            epochs_meta=epochs_meta,
            simbad_rows=simbad_rows,
            simbad_status=simbad_status,
            gaia_rows=gaia_rows,
            gaia_status=gaia_status,
            max_objects=max_objects,
        )

    def _assemble_patch_objects(
        self,
        ra_deg: float,
        dec_deg: float,
        radius_deg: float,
        wcs: dict[str, Any],
        epochs_meta: list[dict[str, Any]],
        simbad_rows: list[dict[str, Any]],
        simbad_status: str,
        gaia_rows: list[dict[str, Any]],
        gaia_status: str,
        max_objects: int = 120,
    ) -> dict[str, Any]:

        # Query SQLite solar_system_ephemeris at each epoch MJD. If extension plates predate
        # modern Horizons windows (e.g. SkyView DSS2 MJD < 60000), resolve against the
        # active reference epoch MJDs so Solar System targets remain trackable in FOV.
        solar_grouped: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = {}
        now_mjd = (datetime.now(UTC) - _MJD_EPOCH).total_seconds() / 86400.0
        for ep_idx, ep in enumerate(epochs_meta):
            query_mjd = float(ep["mjd"])
            if query_mjd < 60000.0:
                query_mjd = now_mjd + (0.0 if ep_idx == 0 else 2.0)
            ep_matches = self.cache.query_ephemeris_in_fov(
                mjd=query_mjd,
                ra=ra_deg,
                dec=dec_deg,
                radius_deg=radius_deg,
            )
            for match in ep_matches:
                solar_grouped.setdefault(match["naif_id"], []).append((ep, match))

        known_objects: list[dict[str, Any]] = []
        gaia_overlay: list[dict[str, Any]] = []
        most_overlay: list[dict[str, Any]] = []

        # 1. Solar System bodies moving through the FOV
        for naif_id, ep_pairs in solar_grouped.items():
            ep_pos_list: list[dict[str, Any]] = []
            first_match = ep_pairs[0][1]
            for ep, match in ep_pairs:
                px, py = sky_to_pixel_tan(match["ra"], match["dec"], wcs)
                ep_pos_list.append(
                    {
                        "epoch_id": ep["epoch_id"],
                        "mjd": float(ep["mjd"]),
                        "ra": round(float(match["ra"]), 6),
                        "dec": round(float(match["dec"]), 6),
                        "x": px,
                        "y": py,
                    }
                )
                most_overlay.append(
                    {
                        "object_name": first_match["body_name"],
                        "epoch_id": ep["epoch_id"],
                        "ra": round(float(match["ra"]), 6),
                        "dec": round(float(match["dec"]), 6),
                        "x": px,
                        "y": py,
                        "v_mag": float(match["vmag"]) if match.get("vmag") is not None else 12.0,
                    }
                )
            p_first = ep_pos_list[0]
            p_last = ep_pos_list[-1]
            cos_dec0 = max(1e-4, math.cos(math.radians(p_first["dec"])))
            dra_arcsec = (
                (((p_last["ra"] - p_first["ra"] + 180.0) % 360.0) - 180.0) * 3600.0 * cos_dec0
            )
            ddec_arcsec = (p_last["dec"] - p_first["dec"]) * 3600.0
            known_objects.append(
                {
                    "object_id": f"ephem:{naif_id}",
                    "label": first_match["body_name"],
                    "catalog": "jpl_horizons",
                    "object_type": "solar_system",
                    "object_class": first_match.get("body_class", "planet"),
                    "canonical_name": first_match["body_name"],
                    "otype": str(first_match.get("body_class", "SolarSystem")).title(),
                    "ra": p_first["ra"],
                    "dec": p_first["dec"],
                    "x": p_first["x"],
                    "y": p_first["y"],
                    "magnitude": first_match.get("vmag"),
                    "proper_motion_arcsec_yr": None,
                    "pmra_mas_yr": None,
                    "pmdec_mas_yr": None,
                    "parallax_mas": None,
                    "w1_w2_color": None,
                    "default_checked": True,
                    "epoch_positions": ep_pos_list,
                    "motion_vector": {
                        "dx_px": round(p_last["x"] - p_first["x"], 2),
                        "dy_px": round(p_last["y"] - p_first["y"], 2),
                        "dra_arcsec": round(dra_arcsec, 3),
                        "ddec_arcsec": round(ddec_arcsec, 3),
                    },
                    "data_source": first_match.get("source", "jpl_horizons"),
                }
            )

        # 2. Cross-match SIMBAD + Gaia DR3 within 2.0 arcsec (0.00056 deg)
        used_gaia_indices: set[int] = set()
        crossmatch_deg = 2.5 / 3600.0
        for s_row in simbad_rows:
            if len(known_objects) >= max_objects:
                break
            best_idx: int | None = None
            best_sep = crossmatch_deg
            for g_idx, g_row in enumerate(gaia_rows):
                if g_idx in used_gaia_indices:
                    continue
                sep = angular_separation_deg(s_row["ra"], s_row["dec"], g_row["ra"], g_row["dec"])
                if sep <= best_sep:
                    best_sep = sep
                    best_idx = g_idx

            g_match = gaia_rows[best_idx] if best_idx is not None else None
            if best_idx is not None:
                used_gaia_indices.add(best_idx)

            base_ra = float(g_match["ra"]) if g_match is not None else float(s_row["ra"])
            base_dec = float(g_match["dec"]) if g_match is not None else float(s_row["dec"])
            pmra = (g_match.get("pmra") if g_match else None) or s_row.get("pmra")
            pmdec = (g_match.get("pmdec") if g_match else None) or s_row.get("pmdec")
            parallax = g_match.get("parallax") if g_match else None
            g_mag = g_match.get("phot_g_mean_mag") if g_match else None
            pm_total = (
                round(math.hypot(float(pmra or 0.0), float(pmdec or 0.0)) / 1000.0, 4)
                if (pmra is not None or pmdec is not None)
                else None
            )
            obj_class, legacy_type = map_simbad_otype(
                s_row.get("otype"), total_pm_arcsec_yr=pm_total
            )

            ep_pos_list = _build_propagated_epoch_positions(
                base_ra=base_ra,
                base_dec=base_dec,
                pmra=pmra,
                pmdec=pmdec,
                epochs_meta=epochs_meta,
                wcs=wcs,
                is_gaia_epoch=g_match is not None,
            )
            if not ep_pos_list:
                continue
            p0 = ep_pos_list[0]
            if not (-20.0 <= p0["x"] <= 276.0 and -20.0 <= p0["y"] <= 276.0):
                continue

            p_last = ep_pos_list[-1]
            cos_d = max(1e-4, math.cos(math.radians(p0["dec"])))
            dra_arcsec = (((p_last["ra"] - p0["ra"] + 180.0) % 360.0) - 180.0) * 3600.0 * cos_d
            ddec_arcsec = (p_last["dec"] - p0["dec"]) * 3600.0

            if g_match is not None:
                gaia_overlay.append(
                    {
                        "source_id": str(g_match["source_id"]),
                        "ra": p0["ra"],
                        "dec": p0["dec"],
                        "x": p0["x"],
                        "y": p0["y"],
                        "g_mag": float(g_mag) if g_mag is not None else 15.0,
                        "bp_rp": None,
                        "pmra": float(pmra) if pmra is not None else None,
                        "pmdec": float(pmdec) if pmdec is not None else None,
                    }
                )

            safe_id = re.sub(r"[^a-zA-Z0-9._:-]+", "_", s_row["main_id"]).strip("_")
            known_objects.append(
                {
                    "object_id": f"simbad:{safe_id}" if safe_id else f"simbad:{len(known_objects)}",
                    "label": s_row["main_id"],
                    "catalog": "simbad",
                    "object_type": legacy_type,
                    "object_class": obj_class,
                    "canonical_name": s_row["main_id"],
                    "otype": s_row.get("otype"),
                    "ra": p0["ra"],
                    "dec": p0["dec"],
                    "x": p0["x"],
                    "y": p0["y"],
                    "magnitude": round(float(g_mag), 3) if g_mag is not None else None,
                    "proper_motion_arcsec_yr": pm_total,
                    "pmra_mas_yr": round(float(pmra), 3) if pmra is not None else None,
                    "pmdec_mas_yr": round(float(pmdec), 3) if pmdec is not None else None,
                    "parallax_mas": round(float(parallax), 3) if parallax is not None else None,
                    "w1_w2_color": None,
                    "default_checked": len(known_objects) < 4,
                    "epoch_positions": ep_pos_list,
                    "motion_vector": {
                        "dx_px": round(p_last["x"] - p0["x"], 2),
                        "dy_px": round(p_last["y"] - p0["y"], 2),
                        "dra_arcsec": round(dra_arcsec, 3),
                        "ddec_arcsec": round(ddec_arcsec, 3),
                    },
                    "data_source": s_row.get("provider", "simbad"),
                }
            )

        # 3. Remaining Gaia DR3 stars within the 256x256 FOV
        for g_idx, g_row in enumerate(gaia_rows):
            if g_idx in used_gaia_indices:
                continue
            if len(known_objects) >= max_objects:
                break
            pmra = g_row.get("pmra")
            pmdec = g_row.get("pmdec")
            parallax = g_row.get("parallax")
            g_mag = g_row.get("phot_g_mean_mag")
            pm_total = (
                round(math.hypot(float(pmra or 0.0), float(pmdec or 0.0)) / 1000.0, 4)
                if (pmra is not None or pmdec is not None)
                else None
            )
            ep_pos_list = _build_propagated_epoch_positions(
                base_ra=float(g_row["ra"]),
                base_dec=float(g_row["dec"]),
                pmra=pmra,
                pmdec=pmdec,
                epochs_meta=epochs_meta,
                wcs=wcs,
                is_gaia_epoch=True,
            )
            if not ep_pos_list:
                continue
            p0 = ep_pos_list[0]
            if not (0.0 <= p0["x"] <= 256.0 and 0.0 <= p0["y"] <= 256.0):
                continue
            p_last = ep_pos_list[-1]
            cos_d = max(1e-4, math.cos(math.radians(p0["dec"])))
            dra_arcsec = (((p_last["ra"] - p0["ra"] + 180.0) % 360.0) - 180.0) * 3600.0 * cos_d
            ddec_arcsec = (p_last["dec"] - p0["dec"]) * 3600.0

            sid = str(g_row["source_id"])
            gaia_overlay.append(
                {
                    "source_id": sid,
                    "ra": p0["ra"],
                    "dec": p0["dec"],
                    "x": p0["x"],
                    "y": p0["y"],
                    "g_mag": float(g_mag) if g_mag is not None else 16.0,
                    "bp_rp": None,
                    "pmra": float(pmra) if pmra is not None else None,
                    "pmdec": float(pmdec) if pmdec is not None else None,
                }
            )
            is_high_pm = pm_total is not None and pm_total >= 0.15
            known_objects.append(
                {
                    "object_id": f"gaia:{sid}",
                    "label": f"Gaia DR3 {sid}",
                    "catalog": "gaia_dr3",
                    "object_type": "high_pm_star" if is_high_pm else "star",
                    "object_class": "star",
                    "canonical_name": f"Gaia DR3 {sid}",
                    "otype": "PM*" if is_high_pm else "*",
                    "ra": p0["ra"],
                    "dec": p0["dec"],
                    "x": p0["x"],
                    "y": p0["y"],
                    "magnitude": round(float(g_mag), 3) if g_mag is not None else None,
                    "proper_motion_arcsec_yr": pm_total,
                    "pmra_mas_yr": round(float(pmra), 3) if pmra is not None else None,
                    "pmdec_mas_yr": round(float(pmdec), 3) if pmdec is not None else None,
                    "parallax_mas": round(float(parallax), 3) if parallax is not None else None,
                    "w1_w2_color": None,
                    "default_checked": bool(is_high_pm),
                    "epoch_positions": ep_pos_list,
                    "motion_vector": {
                        "dx_px": round(p_last["x"] - p0["x"], 2),
                        "dy_px": round(p_last["y"] - p0["y"], 2),
                        "dra_arcsec": round(dra_arcsec, 3),
                        "ddec_arcsec": round(ddec_arcsec, 3),
                    },
                    "data_source": g_row.get("provider", "gaia_dr3"),
                }
            )

        return {
            "known_objects": known_objects,
            "gaia_dr3": gaia_overlay,
            "most_solar_system": most_overlay,
            "source_status": {
                "simbad": simbad_status,
                "gaia_dr3": gaia_status,
                "horizons_ephemeris": "ok" if solar_grouped else "empty_in_fov",
            },
        }


def _build_propagated_epoch_positions(
    base_ra: float,
    base_dec: float,
    pmra: float | None,
    pmdec: float | None,
    epochs_meta: list[dict[str, Any]],
    wcs: dict[str, Any],
    is_gaia_epoch: bool,
) -> list[dict[str, Any]]:
    ref_year = GAIA_DR3_REF_YEAR if is_gaia_epoch else 2000.0
    out: list[dict[str, Any]] = []
    for ep in epochs_meta:
        mjd = float(ep["mjd"])
        ra_ep, dec_ep = propagate_gaia_epoch(
            ra_deg=base_ra,
            dec_deg=base_dec,
            pmra_mas_yr=pmra,
            pmdec_mas_yr=pmdec,
            target_mjd=mjd,
            ref_year=ref_year,
        )
        px, py = sky_to_pixel_tan(ra_ep, dec_ep, wcs)
        out.append(
            {
                "epoch_id": ep["epoch_id"],
                "mjd": mjd,
                "ra": ra_ep,
                "dec": dec_ep,
                "x": px,
                "y": py,
            }
        )
    return out
