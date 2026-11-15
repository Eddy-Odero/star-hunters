"""Response parsers and row normalizers for SIMBAD, Gaia DR3, JPL Horizons, and IRSA MOST."""

from __future__ import annotations

import csv
import io
import math
import re
from datetime import timedelta
from typing import Any

from app.utils.astronomy import MJD_EPOCH, iso_to_mjd


def map_simbad_otype(
    otype: str | None,
    total_pm_arcsec_yr: float | None = None,
) -> tuple[str, str]:
    """Map a SIMBAD ``otype`` code to ``(object_class, legacy_object_type)``.

    Preserves ``KnownCelestialObject.object_type`` compatibility while
    supplying granular UI badge classes (``star``, ``brown_dwarf``, ``galaxy``,
    ``nebula``, ``variable_star``, ``infrared_source``).

    Args:
        otype: Raw SIMBAD object type string, or ``None``.
        total_pm_arcsec_yr: Optional total proper motion in arcseconds/year.

    Returns:
        Tuple of ``(object_class, legacy_object_type)``.
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


def safe_float(value: Any) -> float | None:
    """Convert a scalar value to a finite float, returning ``None`` for nulls/NaNs.

    Args:
        value: Arbitrary cell value from JSON, TSV, or fixed-width tables.

    Returns:
        Finite floating-point value, or ``None`` if unparseable or non-finite.
    """
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
    """Normalize TAP JSON ``data`` payloads formatted as either lists or dicts.

    Handles both IVOA list-of-lists with ``metadata`` (SIMBAD IDIA, ESA Gaia)
    and list-of-dicts (ARI Heidelberg Gaia TAP).

    Args:
        payload: Parsed JSON dictionary from a TAP ``sync`` endpoint.

    Returns:
        List of lowercase-keyed row dictionaries.
    """
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
    """Parse VizieR CfA ``asu-tsv`` output for Gaia DR3 (``I/355/gaiadr3``).

    Args:
        tsv_text: Raw TSV text payload returned by VizieR ``asu-tsv``.

    Returns:
        List of normalized Gaia DR3 source dictionaries.
    """
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
        ra = safe_float(rec.get("RA_ICRS"))
        dec = safe_float(rec.get("DE_ICRS"))
        sid = str(rec.get("Source", "")).strip()
        if not sid or ra is None or dec is None:
            continue
        rows.append(
            {
                "source_id": sid,
                "ra": ra,
                "dec": dec,
                "pmra": safe_float(rec.get("pmRA")),
                "pmdec": safe_float(rec.get("pmDE")),
                "parallax": safe_float(rec.get("Plx")),
                "phot_g_mean_mag": safe_float(rec.get("Gmag")),
            }
        )
    return rows


def normalize_simbad_rows(raw_rows: list[dict[str, Any]], provider: str) -> list[dict[str, Any]]:
    """Normalize SIMBAD TAP rows into canonical astrometric records.

    Args:
        raw_rows: Lowercase-keyed rows from :func:`parse_tap_json_rows`.
        provider: Mirror identifier (e.g. ``"simbad_idia"`` or ``"simbad_cfa"``).

    Returns:
        List of sanitized SIMBAD object dictionaries.
    """
    out: list[dict[str, Any]] = []
    for row in raw_rows:
        main_id = str(row.get("main_id") or "").strip()
        ra = safe_float(row.get("ra"))
        dec = safe_float(row.get("dec"))
        if not main_id or ra is None or dec is None:
            continue
        otype = str(row.get("otype") or "").strip() or None
        pmra = safe_float(row.get("pmra"))
        pmdec = safe_float(row.get("pmdec"))
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


def normalize_gaia_rows(raw_rows: list[dict[str, Any]], provider: str) -> list[dict[str, Any]]:
    """Normalize Gaia DR3 rows and sort brightest-first by G-band magnitude.

    Args:
        raw_rows: Raw rows from TAP JSON or VizieR TSV parsers.
        provider: Mirror identifier (e.g. ``"gaia_esa"``, ``"gaia_ari"``).

    Returns:
        Normalized Gaia DR3 source dictionaries sorted ascending by ``phot_g_mean_mag``.
    """
    out: list[dict[str, Any]] = []
    for row in raw_rows:
        sid = str(row.get("source_id") or "").strip()
        ra = safe_float(row.get("ra"))
        dec = safe_float(row.get("dec"))
        if not sid or ra is None or dec is None:
            continue
        out.append(
            {
                "source_id": sid,
                "ra": ra % 360.0,
                "dec": dec,
                "pmra": safe_float(row.get("pmra")),
                "pmdec": safe_float(row.get("pmdec")),
                "parallax": safe_float(row.get("parallax")),
                "phot_g_mean_mag": safe_float(row.get("phot_g_mean_mag")),
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
    """Parse JPL Horizons ASCII/CSV result block between ``$$SOE`` and ``$$EOE``.

    Args:
        result_text: Raw ``result`` text field from the JPL Horizons REST API.
        naif_id: NAIF / designation identifier for the Solar System body.
        body_name: Human-readable body name.
        body_class: Standardized object class (``"planet"``, ``"moon"``,
            ``"comet"``, ``"asteroid"``).

    Returns:
        List of ephemeris point dictionaries ready for SQLite upsert.
    """
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
        ra_val = safe_float(row[ra_idx])
        dec_val = safe_float(row[dec_idx])
        if not date_str or ra_val is None or dec_val is None:
            continue
        vmag = safe_float(row[mag_idx]) if mag_idx is not None and mag_idx < len(row) else None
        try:
            mjd_val = iso_to_mjd(date_str)
        except ValueError:
            continue
        date_bucket = (MJD_EPOCH + timedelta(days=mjd_val)).date().isoformat()
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


def parse_ipac_brief_table(ipac_text: str) -> list[dict[str, Any]]:
    """Parse IPAC ASCII ``Brief`` fixed-width table returned by NASA/IPAC IRSA MOST.

    Args:
        ipac_text: Raw IPAC ASCII table text.

    Returns:
        List of moving-object intersection records with ``ra``, ``dec``, and metadata.
    """
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
        ra_obj = safe_float(row.get("ra_obj"))
        dec_obj = safe_float(row.get("dec_obj"))
        if ra_obj is None or dec_obj is None:
            continue
        records.append(
            {
                "ra": ra_obj % 360.0,
                "dec": dec_obj,
                "vmag": safe_float(row.get("vmag")),
                "mjd_start": safe_float(row.get("mjd_start")),
                "mjd_end": safe_float(row.get("mjd_end")),
                "start_date": row.get("start_date"),
                "end_date": row.get("end_date"),
                "uri": row.get("uri"),
                "sun_dist": safe_float(row.get("sun_dist")),
                "geo_dist": safe_float(row.get("geo_dist")),
            }
        )
    return records
