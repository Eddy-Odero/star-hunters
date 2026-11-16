"""Async HTTP clients for SIMBAD TAP, Gaia DR3 TAP/VizieR, JPL Horizons, and IRSA MOST."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

import httpx

from app.services.catalog_parsers import (
    normalize_gaia_rows,
    normalize_simbad_rows,
    parse_horizons_ephemeris_result,
    parse_ipac_brief_table,
    parse_tap_json_rows,
    parse_vizier_gaia_tsv,
)

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


async def _race_tap_mirrors(
    probes: Sequence[tuple[str, Callable[[], Awaitable[tuple[list[dict[str, Any]], str]]]]],
    *,
    parallel: bool = False,
) -> tuple[list[dict[str, Any]], str]:
    """Query TAP/catalog mirror callables either sequentially or in parallel race mode.

    Args:
        probes: Sequence of ``(provider_tag, coroutine_factory)`` pairs.
        parallel: When ``True`` and multiple probes exist, launch all probes
            concurrently and return the first non-empty result while cancelling
            slower mirrors.

    Returns:
        Tuple of ``(rows, provider_or_unavailable_status)``.
    """
    last_error = "unavailable"
    if parallel and len(probes) > 1:
        tasks = [asyncio.create_task(probe()) for _, probe in probes]
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
            pending = [task for task in tasks if not task.done()]
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
        if empty_fallback is not None:
            return empty_fallback
        return [], f"unavailable:{last_error}"

    error_parts: list[str] = []
    for provider_tag, probe in probes:
        try:
            return await probe()
        except Exception as exc:  # noqa: BLE001
            error_parts.append(f"{provider_tag}:{type(exc).__name__}")
            continue
    return [], f"unavailable:{'|'.join(error_parts) if error_parts else last_error}"


async def fetch_simbad_objects(
    ra_deg: float,
    dec_deg: float,
    radius_deg: float,
    client: httpx.AsyncClient | None = None,
    limit: int = 500,
    timeout_s: float = 12.0,
    parallel_mirrors: bool = False,
) -> tuple[list[dict[str, Any]], str]:
    """Query SIMBAD TAP via official mirrors (``simbad.idia.ac.za``, ``simbad.cfa.harvard.edu``).

    Never queries ``cds.unistra.fr``.

    Args:
        ra_deg: Cone-search center Right Ascension in degrees.
        dec_deg: Cone-search center Declination in degrees.
        radius_deg: Cone-search radius in degrees.
        client: Optional shared :class:`httpx.AsyncClient`.
        limit: Maximum number of rows requested (clamped to ``[1, 500]``).
        timeout_s: Per-request timeout in seconds.
        parallel_mirrors: Whether to race all mirrors concurrently.

    Returns:
        Tuple of ``(normalized_records, provider_tag)``.
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

    def _make_probe(
        endpoint: str,
    ) -> tuple[str, Callable[[], Awaitable[tuple[list[dict[str, Any]], str]]]]:
        assert "cds.unistra.fr" not in endpoint
        provider = "simbad_idia" if "idia.ac.za" in endpoint else "simbad_cfa"

        async def _query_one() -> tuple[list[dict[str, Any]], str]:
            resp = await http.get(endpoint, params=params, timeout=timeout_s)
            resp.raise_for_status()
            raw_rows = parse_tap_json_rows(resp.json())
            return normalize_simbad_rows(raw_rows, provider=provider), provider

        return provider, _query_one

    try:
        probes = [_make_probe(ep) for ep in SIMBAD_TAP_ENDPOINTS]
        return await _race_tap_mirrors(probes, parallel=parallel_mirrors)
    finally:
        if owns_client:
            await http.aclose()


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
    """Query ESA Gaia DR3 TAP with ARI Heidelberg TAP & VizieR CfA fallbacks.

    Args:
        ra_deg: Cone-search center Right Ascension in degrees.
        dec_deg: Cone-search center Declination in degrees.
        radius_deg: Cone-search radius in degrees.
        client: Optional shared :class:`httpx.AsyncClient`.
        limit: Maximum number of rows requested (clamped to ``[1, 1000]``).
        max_g_mag: Faint Gaia G-magnitude cutoff.
        timeout_s: Per-request timeout in seconds.
        parallel_mirrors: Whether to race TAP mirrors and VizieR concurrently.

    Returns:
        Tuple of ``(normalized_records, provider_tag)``.
    """
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

    def _make_tap_probe(
        endpoint: str,
    ) -> tuple[str, Callable[[], Awaitable[tuple[list[dict[str, Any]], str]]]]:
        assert "cds.unistra.fr" not in endpoint
        provider = "gaia_esa" if "esac.esa.int" in endpoint else "gaia_ari"

        async def _query_tap() -> tuple[list[dict[str, Any]], str]:
            resp = await http.get(endpoint, params=params, timeout=timeout_s)
            resp.raise_for_status()
            raw_rows = parse_tap_json_rows(resp.json())
            return normalize_gaia_rows(raw_rows, provider=provider), provider

        return provider, _query_tap

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
        return normalize_gaia_rows(parsed_tsv, provider="gaia_vizier_cfa"), "gaia_vizier_cfa"

    try:
        probes = [_make_tap_probe(ep) for ep in GAIA_DR3_TAP_ENDPOINTS]
        probes.append(("vizier_cfa", _query_vizier))
        return await _race_tap_mirrors(probes, parallel=parallel_mirrors)
    finally:
        if owns_client:
            await http.aclose()


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
    """Query NASA/JPL Horizons REST API for geocentric observer ephemerides.

    Args:
        naif_cmd: Horizons command string (e.g. ``"699"`` or ``"DES=C/2025 N1;"``).
        naif_id: NAIF / designation key stored in SQLite.
        body_name: Human-readable target label.
        body_class: Object classification (``"planet"``, ``"moon"``,
            ``"comet"``, ``"asteroid"``).
        start_date: Ephemeris window start date (``YYYY-MM-DD``).
        stop_date: Ephemeris window stop date (``YYYY-MM-DD``).
        step_size: Sampling cadence (e.g. ``"1d"``).
        client: Optional shared :class:`httpx.AsyncClient`.
        timeout_s: Request timeout in seconds.

    Returns:
        List of parsed ephemeris points, or ``[]`` on failure.
    """
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


async def fetch_most_spherex_matches(
    obj_name: str,
    client: httpx.AsyncClient | None = None,
    timeout_s: float = 12.0,
) -> dict[str, Any]:
    """Query NASA/IPAC IRSA MOST for SPHEREx exposures intersecting a Solar System object.

    Args:
        obj_name: Target name or alias (e.g. ``"Ceres"``, ``"3I/ATLAS"``, ``"Mars"``).
        client: Optional shared :class:`httpx.AsyncClient`.
        timeout_s: Request timeout in seconds.

    Returns:
        Dictionary with ``query_name``, ``status``, and ``matches``.
    """
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
