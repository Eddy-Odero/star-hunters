"""Asynchronous multi-mission catalog queries (Gaia DR3, AllWISE & NASA MOST)."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from ..models.contracts import GRID_HEIGHT, GRID_WIDTH, CatalogOverlays
from .celestial_catalog_pipeline import (
    GAIA_DR3_TAP_ENDPOINTS,
    IRSA_MOST_ENDPOINT,
    _safe_float,
    parse_ipac_brief_table,
    parse_tap_json_rows,
    sky_to_pixel_tan,
)

IRSA_TAP_ENDPOINT = "https://irsa.ipac.caltech.edu/TAP/sync"
DEFAULT_ARCHIVE_TIMEOUT_SEC = 3.0


def build_tan_wcs_256(ra: float, dec: float, fov_arcmin: float = 5.0) -> dict[str, Any]:
    """Build standard 256x256 TAN WCS header centered at (128.0, 128.0)."""
    fov_deg = float(fov_arcmin) / 60.0
    scale_deg = round(fov_deg / float(GRID_WIDTH), 7)
    return {
        "width": GRID_WIDTH,
        "height": GRID_HEIGHT,
        "crval": [round(float(ra) % 360.0, 6), round(max(-90.0, min(90.0, float(dec))), 6)],
        "crpix": [128.0, 128.0],
        "cdelt": [-scale_deg, scale_deg],
    }


def _build_gaia_adql(ra: float, dec: float, radius_deg: float, limit: int = 80) -> str:
    return (
        f"SELECT TOP {int(limit)} source_id, ra, dec, phot_g_mean_mag AS g_mag, "
        f"bp_rp, pmra, pmdec "
        f"FROM gaiadr3.gaia_source "
        f"WHERE 1=CONTAINS(POINT('ICRS', ra, dec), "
        f"CIRCLE('ICRS', {float(ra):.6f}, {float(dec):.6f}, {float(radius_deg):.6f})) "
        f"AND phot_g_mean_mag < 20.5 "
        f"ORDER BY phot_g_mean_mag ASC"
    )


def _build_wise_adql(ra: float, dec: float, radius_deg: float, limit: int = 80) -> str:
    return (
        f"SELECT TOP {int(limit)} designation AS source_id, ra, dec, w1mpro, w2mpro "
        f"FROM allwise_p3as_psd "
        f"WHERE CONTAINS(POINT('ICRS', ra, dec), "
        f"CIRCLE('ICRS', {float(ra):.6f}, {float(dec):.6f}, {float(radius_deg):.6f})) = 1"
    )


async def query_gaia_dr3(
    ra: float,
    dec: float,
    radius_deg: float,
    wcs: dict[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
    timeout_sec: float = DEFAULT_ARCHIVE_TIMEOUT_SEC,
) -> list[dict[str, Any]]:
    """Query ESA Gaia DR3 TAP for sources with G < 20.5 and project onto 256x256 WCS."""
    adql = _build_gaia_adql(ra, dec, radius_deg)
    params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "json", "QUERY": adql}

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=timeout_sec)
    last_exc: Exception | None = None
    try:
        for endpoint in GAIA_DR3_TAP_ENDPOINTS:
            try:
                resp = await http.post(endpoint, data=params, timeout=timeout_sec)
                resp.raise_for_status()
                raw_rows = parse_tap_json_rows(resp.json())
                results: list[dict[str, Any]] = []
                for row in raw_rows:
                    src_ra = _safe_float(row.get("ra"))
                    src_dec = _safe_float(row.get("dec"))
                    g_mag = _safe_float(row.get("g_mag") or row.get("phot_g_mean_mag"))
                    if src_ra is None or src_dec is None or g_mag is None:
                        continue
                    px, py = sky_to_pixel_tan(src_ra, src_dec, wcs)
                    results.append(
                        {
                            "source_id": str(row.get("source_id", "")),
                            "ra": round(src_ra, 6),
                            "dec": round(src_dec, 6),
                            "x": px,
                            "y": py,
                            "g_mag": round(g_mag, 3),
                            "bp_rp": (
                                round(bp, 3)
                                if (bp := _safe_float(row.get("bp_rp"))) is not None
                                else None
                            ),
                            "pmra": (
                                round(pmra, 3)
                                if (pmra := _safe_float(row.get("pmra"))) is not None
                                else None
                            ),
                            "pmdec": (
                                round(pmdec, 3)
                                if (pmdec := _safe_float(row.get("pmdec"))) is not None
                                else None
                            ),
                        }
                    )
                return results
            except Exception as exc:
                last_exc = exc
        if last_exc is not None:
            raise last_exc
        return []
    finally:
        if owns_client:
            await http.aclose()


async def query_wise_sources(
    ra: float,
    dec: float,
    radius_deg: float,
    wcs: dict[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
    timeout_sec: float = DEFAULT_ARCHIVE_TIMEOUT_SEC,
) -> list[dict[str, Any]]:
    """Query IRSA AllWISE TAP (`allwise_p3as_psd`) and project onto 256x256 WCS."""
    adql = _build_wise_adql(ra, dec, radius_deg)
    params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "json", "QUERY": adql}

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=timeout_sec)
    try:
        resp = await http.post(IRSA_TAP_ENDPOINT, data=params, timeout=timeout_sec)
        resp.raise_for_status()
        raw_rows = parse_tap_json_rows(resp.json())
        results: list[dict[str, Any]] = []
        for row in raw_rows:
            src_ra = _safe_float(row.get("ra"))
            src_dec = _safe_float(row.get("dec"))
            w1 = _safe_float(row.get("w1mpro") or row.get("w1_mag"))
            w2 = _safe_float(row.get("w2mpro") or row.get("w2_mag"))
            if src_ra is None or src_dec is None or w1 is None or w2 is None:
                continue
            px, py = sky_to_pixel_tan(src_ra, src_dec, wcs)
            results.append(
                {
                    "source_id": str(row.get("source_id") or row.get("designation") or ""),
                    "ra": round(src_ra, 6),
                    "dec": round(src_dec, 6),
                    "x": px,
                    "y": py,
                    "w1_mag": round(w1, 3),
                    "w2_mag": round(w2, 3),
                    "w1_w2_color": round(w1 - w2, 3),
                }
            )
        return results
    finally:
        if owns_client:
            await http.aclose()


async def query_most_solar_system(
    ra: float,
    dec: float,
    radius_deg: float,
    wcs: dict[str, Any],
    *,
    obj_name: str = "1",
    epoch_id: str = "pass_1",
    catalog: str = "wise",
    client: httpx.AsyncClient | None = None,
    timeout_sec: float = DEFAULT_ARCHIVE_TIMEOUT_SEC,
) -> list[dict[str, Any]]:
    """Query NASA/IPAC IRSA MOST moving-object service and project onto 256x256 WCS."""
    params = {
        "catalog": catalog,
        "input_type": "name_input",
        "obj_name": obj_name,
        "output_mode": "Brief",
    }
    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=timeout_sec)
    try:
        resp = await http.get(IRSA_MOST_ENDPOINT, params=params, timeout=timeout_sec)
        resp.raise_for_status()
        rows = parse_ipac_brief_table(resp.text)
        results: list[dict[str, Any]] = []
        for row in rows:
            src_ra = _safe_float(row.get("ra_obj") or row.get("ra"))
            src_dec = _safe_float(row.get("dec_obj") or row.get("dec"))
            if src_ra is None or src_dec is None:
                continue
            v_mag = _safe_float(row.get("v_mag") or row.get("vmag") or row.get("mag"))
            px, py = sky_to_pixel_tan(src_ra, src_dec, wcs)
            results.append(
                {
                    "object_name": str(row.get("object_name") or obj_name),
                    "epoch_id": epoch_id,
                    "ra": round(src_ra % 360.0, 6),
                    "dec": round(max(-90.0, min(90.0, src_dec)), 6),
                    "x": px,
                    "y": py,
                    "v_mag": round(v_mag if v_mag is not None else 15.0, 3),
                }
            )
        return results
    finally:
        if owns_client:
            await http.aclose()


async def query_all_catalogs(
    ra: float,
    dec: float,
    fov_arcmin: float = 5.0,
    wcs: dict[str, Any] | None = None,
    *,
    timeout_sec: float = DEFAULT_ARCHIVE_TIMEOUT_SEC,
    client: httpx.AsyncClient | None = None,
    most_obj_name: str = "1",
    epoch_id: str = "pass_1",
) -> dict[str, Any]:
    """Query Gaia DR3, AllWISE, and NASA MOST concurrently with strict per-archive timeout."""
    target_wcs = wcs or build_tan_wcs_256(ra, dec, fov_arcmin=fov_arcmin)
    radius_deg = max(0.02, (float(fov_arcmin) / 60.0) * 0.75)

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=timeout_sec)
    try:
        gaia_coro = asyncio.wait_for(
            query_gaia_dr3(ra, dec, radius_deg, target_wcs, client=http, timeout_sec=timeout_sec),
            timeout=timeout_sec,
        )
        wise_coro = asyncio.wait_for(
            query_wise_sources(
                ra, dec, radius_deg, target_wcs, client=http, timeout_sec=timeout_sec
            ),
            timeout=timeout_sec,
        )
        most_coro = asyncio.wait_for(
            query_most_solar_system(
                ra,
                dec,
                radius_deg,
                target_wcs,
                obj_name=most_obj_name,
                epoch_id=epoch_id,
                client=http,
                timeout_sec=timeout_sec,
            ),
            timeout=timeout_sec,
        )
        gaia_res, wise_res, most_res = await asyncio.gather(
            gaia_coro, wise_coro, most_coro, return_exceptions=True
        )
    finally:
        if owns_client:
            await http.aclose()

    source_status: dict[str, str] = {}

    def _unwrap(res: Any, key: str) -> list[dict[str, Any]]:
        if isinstance(res, TimeoutError):
            source_status[key] = "timeout"
            return []
        if isinstance(res, BaseException):
            source_status[key] = "error"
            return []
        source_status[key] = "ok"
        return list(res)

    payload: dict[str, Any] = {
        "gaia_dr3": _unwrap(gaia_res, "gaia_dr3"),
        "wise_sources": _unwrap(wise_res, "wise_sources"),
        "most_solar_system": _unwrap(most_res, "most_solar_system"),
        "known_objects": [],
        "source_status": source_status,
    }
    CatalogOverlays._from_dict(payload)
    return payload
