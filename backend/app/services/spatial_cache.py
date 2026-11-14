"""Quantized SQLite spatial cache for preprocessed sky patches, frames & spectra."""

from __future__ import annotations

from contextlib import closing
import json
import os
import sqlite3
import time
from typing import Any, Dict, Optional, Tuple
import zlib


DEFAULT_GRID_STEP_DEG = 0.05  # 3 arcminutes
DEFAULT_MAX_CACHE_BYTES = 750 * 1024 * 1024  # 750 MB


def compute_grid_key(
    ra: float,
    dec: float,
    fov_arcmin: float = 5.0,
    grid_step_deg: float = DEFAULT_GRID_STEP_DEG,
) -> Tuple[str, float, float]:
    """Quantize (ra, dec) to a 0.05-deg spatial grid and return (grid_key, ra_q, dec_q)."""
    normalized_ra = ra % 360.0
    clamped_dec = max(-90.0, min(90.0, dec))
    ra_q = round(round(normalized_ra / grid_step_deg) * grid_step_deg, 2) % 360.0
    dec_q = round(round(clamped_dec / grid_step_deg) * grid_step_deg, 2)
    fov_q = round(float(fov_arcmin), 1)
    grid_key = f"ra{ra_q:.2f}_dec{dec_q:.2f}_fov{fov_q:.1f}"
    return grid_key, ra_q, dec_q


class SpatialSqliteCache:
    """Two-Tier Backend Cache: SQLite in WAL mode with automatic LRU byte-cap pruning."""

    def __init__(
        self,
        db_path: Optional[str] = None,
        max_cache_bytes: int = DEFAULT_MAX_CACHE_BYTES,
    ) -> None:
        self.db_path = db_path or os.environ.get(
            "SQLITE_DB_PATH", "/tmp/star_hunters_cache.db"
        )
        self.max_cache_bytes = max_cache_bytes
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        parent = os.path.dirname(os.path.abspath(self.db_path))
        if parent and not os.path.exists(parent):
            os.makedirs(parent, exist_ok=True)
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        return conn

    def _init_db(self) -> None:
        with closing(self._connect()) as conn, conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS sky_patches (
                    grid_key TEXT PRIMARY KEY,
                    ra_center REAL NOT NULL,
                    dec_center REAL NOT NULL,
                    fov_arcmin REAL NOT NULL,
                    manifest_json TEXT NOT NULL,
                    catalogs_json TEXT NOT NULL,
                    byte_size INTEGER NOT NULL,
                    created_at REAL NOT NULL,
                    last_accessed REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS binary_frames (
                    grid_key TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    compressed_blob BLOB NOT NULL,
                    raw_byte_size INTEGER NOT NULL,
                    PRIMARY KEY (grid_key, filename),
                    FOREIGN KEY (grid_key) REFERENCES sky_patches(grid_key) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS spectra_cache (
                    spectrum_key TEXT PRIMARY KEY,
                    ra REAL NOT NULL,
                    dec REAL NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    last_accessed REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS capital_zenith_cache (
                    cache_key TEXT PRIMARY KEY,
                    city_slug TEXT,
                    lat REAL NOT NULL,
                    lon REAL NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    last_accessed REAL NOT NULL
                );
                """
            )

    def get_manifest(self, grid_key: str) -> Optional[Dict[str, Any]]:
        now = time.time()
        with closing(self._connect()) as conn, conn:
            row = conn.execute(
                "SELECT manifest_json FROM sky_patches WHERE grid_key = ?",
                (grid_key,),
            ).fetchone()
            if not row:
                return None
            conn.execute(
                "UPDATE sky_patches SET last_accessed = ? WHERE grid_key = ?",
                (now, grid_key),
            )
            manifest = json.loads(row["manifest_json"])
            manifest["query"]["cached"] = True
            return manifest

    def get_catalogs(self, grid_key: str) -> Optional[Dict[str, Any]]:
        now = time.time()
        with closing(self._connect()) as conn, conn:
            row = conn.execute(
                "SELECT catalogs_json FROM sky_patches WHERE grid_key = ?",
                (grid_key,),
            ).fetchone()
            if not row:
                return None
            conn.execute(
                "UPDATE sky_patches SET last_accessed = ? WHERE grid_key = ?",
                (now, grid_key),
            )
            payload = json.loads(row["catalogs_json"])
            payload["query"]["cached"] = True
            return payload

    def get_frame(self, grid_key: str, filename: str) -> Optional[bytes]:
        now = time.time()
        with closing(self._connect()) as conn, conn:
            row = conn.execute(
                "SELECT compressed_blob FROM binary_frames WHERE grid_key = ? AND filename = ?",
                (grid_key, filename),
            ).fetchone()
            if not row:
                return None
            conn.execute(
                "UPDATE sky_patches SET last_accessed = ? WHERE grid_key = ?",
                (now, grid_key),
            )
            return zlib.decompress(row["compressed_blob"])

    def put_sky_patch(
        self,
        grid_key: str,
        ra_center: float,
        dec_center: float,
        fov_arcmin: float,
        manifest: Dict[str, Any],
        frames: Dict[str, bytes],
    ) -> None:
        now = time.time()
        manifest_str = json.dumps(manifest)
        catalogs_payload = {
            "query": manifest["query"],
            "wcs": manifest["wcs"],
            "catalog_overlays": manifest["catalog_overlays"],
        }
        catalogs_str = json.dumps(catalogs_payload)

        compressed_frames: Dict[str, Tuple[bytes, int]] = {}
        total_bytes = len(manifest_str.encode("utf-8")) + len(catalogs_str.encode("utf-8"))
        for fname, raw_bytes in frames.items():
            comp = zlib.compress(raw_bytes, level=6)
            compressed_frames[fname] = (comp, len(raw_bytes))
            total_bytes += len(comp)

        with closing(self._connect()) as conn, conn:
            conn.execute(
                "DELETE FROM sky_patches WHERE grid_key = ?",
                (grid_key,),
            )
            conn.execute(
                """
                INSERT INTO sky_patches (
                    grid_key, ra_center, dec_center, fov_arcmin,
                    manifest_json, catalogs_json, byte_size, created_at, last_accessed
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    grid_key,
                    ra_center,
                    dec_center,
                    fov_arcmin,
                    manifest_str,
                    catalogs_str,
                    total_bytes,
                    now,
                    now,
                ),
            )
            for fname, (comp_blob, raw_len) in compressed_frames.items():
                conn.execute(
                    """
                    INSERT INTO binary_frames (grid_key, filename, compressed_blob, raw_byte_size)
                    VALUES (?, ?, ?, ?)
                    """,
                    (grid_key, fname, comp_blob, raw_len),
                )
            self._prune_if_needed(conn, preserve_grid_key=grid_key)

    def get_patch_byte_size(self, grid_key: str) -> int:
        with closing(self._connect()) as conn:
            row = conn.execute(
                "SELECT byte_size FROM sky_patches WHERE grid_key = ?",
                (grid_key,),
            ).fetchone()
            return int(row["byte_size"]) if row else 0

    def get_spectrum(self, spectrum_key: str) -> Optional[Dict[str, Any]]:
        now = time.time()
        with closing(self._connect()) as conn, conn:
            row = conn.execute(
                "SELECT payload_json FROM spectra_cache WHERE spectrum_key = ?",
                (spectrum_key,),
            ).fetchone()
            if not row:
                return None
            conn.execute(
                "UPDATE spectra_cache SET last_accessed = ? WHERE spectrum_key = ?",
                (now, spectrum_key),
            )
            return json.loads(row["payload_json"])

    def put_spectrum(
        self,
        spectrum_key: str,
        ra: float,
        dec: float,
        payload: Dict[str, Any],
    ) -> None:
        now = time.time()
        payload_str = json.dumps(payload)
        with closing(self._connect()) as conn, conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO spectra_cache (
                    spectrum_key, ra, dec, payload_json, created_at, last_accessed
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (spectrum_key, ra, dec, payload_str, now, now),
            )

    def get_zenith_response(self, cache_key: str) -> Optional[Dict[str, Any]]:
        now = time.time()
        with closing(self._connect()) as conn, conn:
            row = conn.execute(
                "SELECT payload_json FROM capital_zenith_cache WHERE cache_key = ?",
                (cache_key,),
            ).fetchone()
            if not row:
                return None
            conn.execute(
                "UPDATE capital_zenith_cache SET last_accessed = ? WHERE cache_key = ?",
                (now, cache_key),
            )
            payload = json.loads(row["payload_json"])
            payload["earth"]["cached"] = True
            return payload

    def put_zenith_response(
        self,
        cache_key: str,
        lat: float,
        lon: float,
        payload: Dict[str, Any],
        city_slug: Optional[str] = None,
    ) -> None:
        now = time.time()
        payload_str = json.dumps(payload)
        with closing(self._connect()) as conn, conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO capital_zenith_cache (
                    cache_key, city_slug, lat, lon, payload_json, created_at, last_accessed
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (cache_key, city_slug, lat, lon, payload_str, now, now),
            )

    def _prune_if_needed(
        self,
        conn: sqlite3.Connection,
        preserve_grid_key: Optional[str] = None,
    ) -> int:
        row = conn.execute(
            "SELECT COALESCE(SUM(byte_size), 0) AS total_bytes FROM sky_patches"
        ).fetchone()
        total_bytes = int(row["total_bytes"]) if row else 0
        evicted = 0
        if total_bytes <= self.max_cache_bytes:
            return evicted

        cursor = conn.execute(
            "SELECT grid_key, byte_size FROM sky_patches ORDER BY last_accessed ASC, rowid ASC"
        )
        rows = cursor.fetchall()
        for r in rows:
            if total_bytes <= self.max_cache_bytes:
                break
            if preserve_grid_key and r["grid_key"] == preserve_grid_key:
                continue
            conn.execute("DELETE FROM sky_patches WHERE grid_key = ?", (r["grid_key"],))
            total_bytes -= int(r["byte_size"])
            evicted += 1
        return evicted

    def clear(self) -> None:
        with closing(self._connect()) as conn, conn:
            conn.execute("DELETE FROM binary_frames")
            conn.execute("DELETE FROM sky_patches")
            conn.execute("DELETE FROM spectra_cache")
            conn.execute("DELETE FROM capital_zenith_cache")
