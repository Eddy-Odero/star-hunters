"""Quantized SQLite spatial cache for preprocessed sky patches, frames & spectra."""

from __future__ import annotations

import json
import math
import os
import sqlite3
import threading
import time
import weakref
import zlib
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Literal

from app.utils.astronomy import angular_separation_deg, mjd_to_date_bucket

DEFAULT_GRID_STEP_DEG = 0.05  # 3 arcminutes
DEFAULT_MAX_CACHE_BYTES = 750 * 1024 * 1024  # 750 MB
DEFAULT_CATALOG_TTL_SECONDS = 7 * 24 * 3600  # 7 days


def quantize_bucket(
    value: float, step: float = DEFAULT_GRID_STEP_DEG, wrap_360: bool = False
) -> float:
    """Quantize a celestial coordinate to a spatial bucket step in degrees.

    Args:
        value: Input coordinate in degrees.
        step: Quantization grid step in degrees.
        wrap_360: If True, wrap coordinate modulo 360 (Right Ascension);
            otherwise clamp to ``[-90, 90]`` (Declination).

    Returns:
        Quantized coordinate value in degrees.
    """
    val = float(value)
    if wrap_360:
        val = val % 360.0
    else:
        val = max(-90.0, min(90.0, val))
    q = round(round(val / step) * step, 4)
    return q % 360.0 if wrap_360 else max(-90.0, min(90.0, q))


def compute_grid_key(
    ra: float,
    dec: float,
    fov_arcmin: float = 5.0,
    grid_step_deg: float = DEFAULT_GRID_STEP_DEG,
) -> tuple[str, float, float]:
    """Quantize ``(ra, dec)`` to a 0.05-deg spatial grid and build its cache key.

    Args:
        ra: Right Ascension in degrees.
        dec: Declination in degrees.
        fov_arcmin: Field of view in arcminutes.
        grid_step_deg: Quantization step in degrees.

    Returns:
        Tuple of ``(grid_key, ra_quantized, dec_quantized)``.
    """
    normalized_ra = ra % 360.0
    clamped_dec = max(-90.0, min(90.0, dec))
    ra_q = round(round(normalized_ra / grid_step_deg) * grid_step_deg, 2) % 360.0
    dec_q = round(round(clamped_dec / grid_step_deg) * grid_step_deg, 2)
    fov_q = round(float(fov_arcmin), 1)
    grid_key = f"ra{ra_q:.2f}_dec{dec_q:.2f}_fov{fov_q:.1f}"
    return grid_key, ra_q, dec_q


class SpatialSqliteCache:
    """Two-tier SQLite spatial cache with per-thread connection pooling and LRU pruning."""

    def __init__(
        self,
        db_path: str | None = None,
        max_cache_bytes: int = DEFAULT_MAX_CACHE_BYTES,
        pinned_grid_keys: set[str] | None = None,
    ) -> None:
        """Initialize the SQLite spatial cache and schema.

        Args:
            db_path: Path to the SQLite database file. Defaults to
                ``SQLITE_DB_PATH`` or ``/tmp/star_hunters_cache.db``.
            max_cache_bytes: Maximum combined byte budget for cached sky patches
                and catalog regions before LRU eviction triggers.
            pinned_grid_keys: Optional set of showcase ``grid_key`` values that
                LRU eviction should preserve unless pinned entries alone exceed
                ``max_cache_bytes``.
        """
        self.db_path = db_path or os.environ.get("SQLITE_DB_PATH", "/tmp/star_hunters_cache.db")
        self.max_cache_bytes = max_cache_bytes
        self.pinned_grid_keys: set[str] = set(pinned_grid_keys or ())
        self._local = threading.local()
        self._pool_lock = threading.Lock()
        self._connections: list[sqlite3.Connection] = []
        self._finalizer = weakref.finalize(
            self,
            self._close_connections,
            self._connections,
            self._pool_lock,
        )
        self._init_db()

    @staticmethod
    def _close_connections(
        connections: list[sqlite3.Connection],
        lock: threading.Lock,
    ) -> None:
        """Close every pooled SQLite connection without holding a reference to ``self``."""
        with lock:
            conns = list(connections)
            connections.clear()
        for conn in conns:
            try:
                conn.close()
            except sqlite3.Error:
                pass

    def close(self) -> None:
        """Close all pooled SQLite connections across threads."""
        with self._pool_lock:
            self._local = threading.local()
            conns = list(self._connections)
            self._connections.clear()
        for conn in conns:
            try:
                conn.close()
            except sqlite3.Error:
                pass

    def pin_grid_key(self, grid_key: str) -> None:
        """Pin a showcase ``grid_key`` so LRU eviction prefers evicting non-pinned patches.

        Args:
            grid_key: Quantized spatial grid identifier to pin.
        """
        self.pinned_grid_keys.add(grid_key)

    def _get_thread_connection(self) -> sqlite3.Connection:
        """Return or open the current thread's pooled SQLite connection."""
        local = self._local
        conn: sqlite3.Connection | None = getattr(local, "conn", None)
        if conn is not None:
            return conn

        parent = os.path.dirname(os.path.abspath(self.db_path))
        if parent and not os.path.exists(parent):
            os.makedirs(parent, exist_ok=True)
        conn = sqlite3.connect(self.db_path, timeout=30.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        with self._pool_lock:
            self._connections.append(conn)
        local.conn = conn
        return conn

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        """Yield the current thread's pooled SQLite connection inside a transaction.

        Commits on normal exit and rolls back on exception without closing the
        pooled connection.

        Yields:
            Active thread-local :class:`sqlite3.Connection`.
        """
        conn = self._get_thread_connection()
        with conn:
            yield conn

    def _init_db(self) -> None:
        """Enable persistent WAL mode and create required tables and indices."""
        with self.connection() as conn:
            conn.execute("PRAGMA journal_mode=WAL;")
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

                CREATE TABLE IF NOT EXISTS catalog_region_cache (
                    region_key TEXT PRIMARY KEY,
                    source TEXT NOT NULL,
                    ra_bucket REAL NOT NULL,
                    dec_bucket REAL NOT NULL,
                    radius_bucket REAL NOT NULL,
                    payload_json TEXT NOT NULL,
                    byte_size INTEGER NOT NULL,
                    fetched_at REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    last_accessed REAL NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_catalog_region_lookup
                ON catalog_region_cache(source, ra_bucket, dec_bucket, radius_bucket);

                CREATE TABLE IF NOT EXISTS solar_system_ephemeris (
                    naif_id TEXT NOT NULL,
                    body_name TEXT NOT NULL,
                    body_class TEXT NOT NULL,
                    date_bucket TEXT NOT NULL,
                    mjd REAL NOT NULL,
                    ra REAL NOT NULL,
                    dec REAL NOT NULL,
                    vmag REAL,
                    ra_bucket REAL NOT NULL,
                    dec_bucket REAL NOT NULL,
                    source TEXT NOT NULL,
                    fetched_at REAL NOT NULL,
                    PRIMARY KEY (naif_id, date_bucket)
                );

                CREATE INDEX IF NOT EXISTS idx_ephem_lookup
                ON solar_system_ephemeris(date_bucket, ra_bucket, dec_bucket);
                """
            )

    def _get_json_row(
        self,
        table: Literal["sky_patches", "spectra_cache", "capital_zenith_cache"],
        json_column: Literal["manifest_json", "catalogs_json", "payload_json"],
        key_column: Literal["grid_key", "spectrum_key", "cache_key"],
        key_value: str,
    ) -> dict[str, Any] | None:
        """Fetch a JSON payload from a cache table and update ``last_accessed``.

        Args:
            table: Target SQLite cache table name.
            json_column: Column holding serialized JSON text.
            key_column: Primary key column name to filter on.
            key_value: Lookup key value.

        Returns:
            Deserialized JSON dictionary, or ``None`` on cache miss.
        """
        now = time.time()
        with self.connection() as conn:
            row = conn.execute(
                f"SELECT {json_column} FROM {table} WHERE {key_column} = ?",
                (key_value,),
            ).fetchone()
            if not row:
                return None
            conn.execute(
                f"UPDATE {table} SET last_accessed = ? WHERE {key_column} = ?",
                (now, key_value),
            )
            return json.loads(row[json_column])

    def get_manifest(self, grid_key: str) -> dict[str, Any] | None:
        """Fetch a cached sky-patch manifest and mark it as a cache hit.

        Args:
            grid_key: Quantized spatial grid identifier.

        Returns:
            Manifest dictionary with ``query.cached = True``, or ``None``.
        """
        manifest = self._get_json_row("sky_patches", "manifest_json", "grid_key", grid_key)
        if manifest is not None:
            manifest["query"]["cached"] = True
        return manifest

    def get_catalogs(self, grid_key: str) -> dict[str, Any] | None:
        """Fetch cached catalog overlays for a sky patch and mark as cached.

        Args:
            grid_key: Quantized spatial grid identifier.

        Returns:
            Catalogs dictionary with ``query.cached = True``, or ``None``.
        """
        payload = self._get_json_row("sky_patches", "catalogs_json", "grid_key", grid_key)
        if payload is not None:
            payload["query"]["cached"] = True
        return payload

    def get_frame(self, grid_key: str, filename: str) -> bytes | None:
        """Fetch and decompress a cached binary frame buffer.

        Args:
            grid_key: Quantized spatial grid identifier.
            filename: Frame filename (e.g. ``"pass_1.bin"``).

        Returns:
            Decompressed binary frame bytes, or ``None`` if missing.
        """
        now = time.time()
        with self.connection() as conn:
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
        manifest: dict[str, Any],
        frames: dict[str, bytes],
    ) -> None:
        """Persist a sky-patch manifest, catalog overlays, and compressed frames.

        Args:
            grid_key: Quantized spatial grid identifier.
            ra_center: Quantized Right Ascension center in degrees.
            dec_center: Quantized Declination center in degrees.
            fov_arcmin: Field of view in arcminutes.
            manifest: Validated sky-patch manifest dictionary.
            frames: Mapping of frame filename to raw little-endian bytes.
        """
        now = time.time()
        manifest_str = json.dumps(manifest)
        catalogs_payload = {
            "query": manifest["query"],
            "wcs": manifest["wcs"],
            "catalog_overlays": manifest["catalog_overlays"],
        }
        catalogs_str = json.dumps(catalogs_payload)

        frame_rows: list[tuple[str, str, bytes, int]] = []
        total_bytes = len(manifest_str.encode("utf-8")) + len(catalogs_str.encode("utf-8"))
        for fname, raw_bytes in frames.items():
            comp = zlib.compress(raw_bytes, level=6)
            frame_rows.append((grid_key, fname, comp, len(raw_bytes)))
            total_bytes += len(comp)

        with self.connection() as conn:
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
            if frame_rows:
                conn.executemany(
                    """
                    INSERT INTO binary_frames (grid_key, filename, compressed_blob, raw_byte_size)
                    VALUES (?, ?, ?, ?)
                    """,
                    frame_rows,
                )
            self._prune_if_needed(conn, preserve_grid_key=grid_key)

    def get_patch_byte_size(self, grid_key: str) -> int:
        """Return the stored compressed byte size of a cached sky patch.

        Args:
            grid_key: Quantized spatial grid identifier.

        Returns:
            Stored byte size, or ``0`` if the patch is not cached.
        """
        with self.connection() as conn:
            row = conn.execute(
                "SELECT byte_size FROM sky_patches WHERE grid_key = ?",
                (grid_key,),
            ).fetchone()
            return int(row["byte_size"]) if row else 0

    def get_spectrum(self, spectrum_key: str) -> dict[str, Any] | None:
        """Fetch a cached 102-band spectrum payload.

        Args:
            spectrum_key: Cache key for the sky position's spectrum.

        Returns:
            Cached spectrum payload dictionary, or ``None``.
        """
        return self._get_json_row("spectra_cache", "payload_json", "spectrum_key", spectrum_key)

    def put_spectrum(
        self,
        spectrum_key: str,
        ra: float,
        dec: float,
        payload: dict[str, Any],
    ) -> None:
        """Persist a 102-band spectrum payload in SQLite.

        Args:
            spectrum_key: Cache key for the sky position's spectrum.
            ra: Right Ascension in degrees.
            dec: Declination in degrees.
            payload: Spectrum payload dictionary.
        """
        now = time.time()
        payload_str = json.dumps(payload)
        with self.connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO spectra_cache (
                    spectrum_key, ra, dec, payload_json, created_at, last_accessed
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (spectrum_key, ra, dec, payload_str, now, now),
            )

    def get_zenith_response(self, cache_key: str) -> dict[str, Any] | None:
        """Fetch a cached Earth-to-Sky zenith lookup and mark it as cached.

        Args:
            cache_key: Quantized location/time zenith cache key.

        Returns:
            Zenith response dictionary with ``earth.cached = True``, or ``None``.
        """
        payload = self._get_json_row("capital_zenith_cache", "payload_json", "cache_key", cache_key)
        if payload is not None:
            payload["earth"]["cached"] = True
        return payload

    def put_zenith_response(
        self,
        cache_key: str,
        lat: float,
        lon: float,
        payload: dict[str, Any],
        city_slug: str | None = None,
    ) -> None:
        """Persist an Earth-to-Sky zenith response in SQLite.

        Args:
            cache_key: Quantized location/time zenith cache key.
            lat: Observer latitude in degrees.
            lon: Observer longitude in degrees.
            payload: Validated Earth-to-Sky response dictionary.
            city_slug: Optional matching capital city slug.
        """
        now = time.time()
        payload_str = json.dumps(payload)
        with self.connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO capital_zenith_cache (
                    cache_key, city_slug, lat, lon, payload_json, created_at, last_accessed
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (cache_key, city_slug, lat, lon, payload_str, now, now),
            )

    @staticmethod
    def _catalog_region_key(
        source: str,
        ra: float,
        dec: float,
        radius_deg: float,
    ) -> tuple[str, float, float, float]:
        """Build a quantized cache key and bucket tuple for a catalog region query."""
        ra_b = quantize_bucket(ra, DEFAULT_GRID_STEP_DEG, wrap_360=True)
        dec_b = quantize_bucket(dec, DEFAULT_GRID_STEP_DEG, wrap_360=False)
        rad_b = round(max(0.01, float(radius_deg)), 3)
        key = f"{source}:ra{ra_b:.2f}:dec{dec_b:.2f}:r{rad_b:.3f}"
        return key, ra_b, dec_b, rad_b

    def get_cached_catalog_region(
        self,
        source: str,
        ra: float,
        dec: float,
        radius_deg: float,
        allow_stale: bool = False,
    ) -> dict[str, Any] | None:
        """Fetch cached SIMBAD/Gaia/MOST region payload if present and valid.

        Args:
            source: Catalog source identifier (e.g. ``"simbad"``, ``"gaia_dr3"``).
            ra: Right Ascension center in degrees.
            dec: Declination center in degrees.
            radius_deg: Search radius in degrees.
            allow_stale: If True, return expired rows marked with ``stale=True``.

        Returns:
            Cached catalog region dictionary, or ``None`` if absent or expired.
        """
        now = time.time()
        region_key, _, _, _ = self._catalog_region_key(source, ra, dec, radius_deg)
        with self.connection() as conn:
            row = conn.execute(
                """
                SELECT payload_json, expires_at
                FROM catalog_region_cache
                WHERE region_key = ?
                """,
                (region_key,),
            ).fetchone()
            if not row:
                return None
            is_expired = float(row["expires_at"]) < now
            if is_expired and not allow_stale:
                return None
            conn.execute(
                "UPDATE catalog_region_cache SET last_accessed = ? WHERE region_key = ?",
                (now, region_key),
            )
            payload: dict[str, Any] = json.loads(row["payload_json"])
            payload["cache_hit"] = True
            payload["stale"] = is_expired
            return payload

    def put_cached_catalog_region(
        self,
        source: str,
        ra: float,
        dec: float,
        radius_deg: float,
        payload: dict[str, Any],
        ttl_seconds: float = DEFAULT_CATALOG_TTL_SECONDS,
    ) -> None:
        """Persist a quantized catalog query response in SQLite with TTL + LRU pruning.

        Args:
            source: Catalog source identifier.
            ra: Right Ascension center in degrees.
            dec: Declination center in degrees.
            radius_deg: Search radius in degrees.
            payload: JSON-serializable catalog response payload.
            ttl_seconds: Cache time-to-live in seconds (minimum 60s).
        """
        now = time.time()
        expires_at = now + max(60.0, float(ttl_seconds))
        region_key, ra_b, dec_b, rad_b = self._catalog_region_key(source, ra, dec, radius_deg)
        payload_str = json.dumps(payload, separators=(",", ":"))
        byte_size = len(payload_str.encode("utf-8"))
        with self.connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO catalog_region_cache (
                    region_key, source, ra_bucket, dec_bucket, radius_bucket,
                    payload_json, byte_size, fetched_at, expires_at, last_accessed
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    region_key,
                    source,
                    ra_b,
                    dec_b,
                    rad_b,
                    payload_str,
                    byte_size,
                    now,
                    expires_at,
                    now,
                ),
            )
            self._prune_if_needed(conn)

    def upsert_ephemeris_points(self, points: list[dict[str, Any]]) -> int:
        """Upsert JPL Horizons / MOST rows indexed by ``(date_bucket, ra_bucket, dec_bucket)``.

        Args:
            points: List of ephemeris point dictionaries containing ``naif_id``,
                ``body_name``, ``mjd``, ``ra``, and ``dec``.

        Returns:
            Number of rows upserted.
        """
        if not points:
            return 0
        now = time.time()
        rows_to_insert: list[tuple[Any, ...]] = []
        for pt in points:
            ra_val = float(pt["ra"]) % 360.0
            dec_val = max(-90.0, min(90.0, float(pt["dec"])))
            mjd_val = float(pt["mjd"])
            date_bucket = str(pt.get("date_bucket") or mjd_to_date_bucket(mjd_val))
            ra_b = quantize_bucket(ra_val, DEFAULT_GRID_STEP_DEG, wrap_360=True)
            dec_b = quantize_bucket(dec_val, DEFAULT_GRID_STEP_DEG, wrap_360=False)
            vmag_val = float(pt["vmag"]) if pt.get("vmag") is not None else None
            rows_to_insert.append(
                (
                    str(pt["naif_id"]),
                    str(pt["body_name"]),
                    str(pt.get("body_class", "solar_system")),
                    date_bucket,
                    mjd_val,
                    ra_val,
                    dec_val,
                    vmag_val,
                    ra_b,
                    dec_b,
                    str(pt.get("source", "jpl_horizons")),
                    float(pt.get("fetched_at", now)),
                )
            )
        with self.connection() as conn:
            conn.executemany(
                """
                INSERT OR REPLACE INTO solar_system_ephemeris (
                    naif_id, body_name, body_class, date_bucket, mjd,
                    ra, dec, vmag, ra_bucket, dec_bucket, source, fetched_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows_to_insert,
            )
        return len(rows_to_insert)

    def get_ephemeris_for_body(
        self,
        naif_id: str,
        mjd: float,
    ) -> dict[str, Any] | None:
        """Return interpolated cached ephemeris for ``naif_id`` near ``mjd``.

        Args:
            naif_id: NAIF / Horizons body identifier.
            mjd: Target Modified Julian Date.

        Returns:
            Interpolated ephemeris dictionary, or ``None`` if unavailable.
        """
        target_mjd = float(mjd)
        buckets = (
            mjd_to_date_bucket(target_mjd - 1.0),
            mjd_to_date_bucket(target_mjd),
            mjd_to_date_bucket(target_mjd + 1.0),
        )
        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT naif_id, body_name, body_class, date_bucket, mjd, ra, dec, vmag, source
                FROM solar_system_ephemeris
                WHERE naif_id = ?
                  AND date_bucket IN (?, ?, ?)
                ORDER BY mjd ASC
                """,
                (str(naif_id), *buckets),
            ).fetchall()
        if not rows:
            return None
        interp_ra, interp_dec, interp_vmag = self._interpolate_ephemeris_rows(rows, target_mjd)
        first = rows[0]
        return {
            "naif_id": str(first["naif_id"]),
            "body_name": str(first["body_name"]),
            "body_class": str(first["body_class"]),
            "mjd": target_mjd,
            "ra": round(interp_ra, 6),
            "dec": round(interp_dec, 6),
            "vmag": round(interp_vmag, 3) if interp_vmag is not None else None,
            "source": str(first["source"]),
        }

    def query_ephemeris_in_fov(
        self,
        mjd: float,
        ra: float,
        dec: float,
        radius_deg: float,
    ) -> list[dict[str, Any]]:
        """Query Solar System bodies in or traversing the FOV around ``mjd``.

        Linearly interpolates daily ephemeris positions around ``mjd`` (covering
        +/- 1 day so fast movers near day boundaries are caught accurately).

        Args:
            mjd: Target Modified Julian Date.
            ra: Field center Right Ascension in degrees.
            dec: Field center Declination in degrees.
            radius_deg: Search radius in degrees.

        Returns:
            List of matching Solar System body dictionaries sorted by angular
            separation.
        """
        norm_ra = float(ra) % 360.0
        clamped_dec = max(-90.0, min(90.0, float(dec)))
        target_mjd = float(mjd)
        date_prev = mjd_to_date_bucket(target_mjd - 1.0)
        date_curr = mjd_to_date_bucket(target_mjd)
        date_next = mjd_to_date_bucket(target_mjd + 1.0)

        # Pad bounding box generously (+2.0 deg) to catch fast motion prior to interpolation
        pad_deg = max(2.0, float(radius_deg) + 1.5)
        dec_min = max(-90.0, clamped_dec - pad_deg)
        dec_max = min(90.0, clamped_dec + pad_deg)

        cos_dec = math.cos(math.radians(clamped_dec))
        if abs(clamped_dec) + pad_deg >= 89.0 or cos_dec < 0.05:
            ra_clause = "1 = 1"
            ra_params: tuple[Any, ...] = ()
        else:
            dra = min(180.0, pad_deg / cos_dec)
            ra_low = (norm_ra - dra) % 360.0
            ra_high = (norm_ra + dra) % 360.0
            if norm_ra - dra >= 0.0 and norm_ra + dra < 360.0:
                ra_clause = "ra_bucket BETWEEN ? AND ?"
                ra_params = (ra_low, ra_high)
            else:
                ra_clause = "(ra_bucket >= ? OR ra_bucket <= ?)"
                ra_params = (ra_low, ra_high)

        sql = f"""
            SELECT naif_id, body_name, body_class, date_bucket, mjd, ra, dec, vmag, source
            FROM solar_system_ephemeris
            WHERE date_bucket IN (?, ?, ?)
              AND dec_bucket BETWEEN ? AND ?
              AND {ra_clause}
            ORDER BY naif_id ASC, mjd ASC
        """
        params: tuple[Any, ...] = (date_prev, date_curr, date_next, dec_min, dec_max, *ra_params)
        with self.connection() as conn:
            rows = conn.execute(sql, params).fetchall()

        grouped: dict[str, list[sqlite3.Row]] = {}
        for row in rows:
            grouped.setdefault(str(row["naif_id"]), []).append(row)

        matches: list[dict[str, Any]] = []
        for naif_id, body_rows in grouped.items():
            body_rows.sort(key=lambda r: float(r["mjd"]))
            interp_ra, interp_dec, interp_vmag = self._interpolate_ephemeris_rows(
                body_rows, target_mjd
            )
            sep_deg = angular_separation_deg(norm_ra, clamped_dec, interp_ra, interp_dec)
            if sep_deg <= float(radius_deg):
                first = body_rows[0]
                matches.append(
                    {
                        "naif_id": naif_id,
                        "body_name": str(first["body_name"]),
                        "body_class": str(first["body_class"]),
                        "mjd": target_mjd,
                        "ra": round(interp_ra, 6),
                        "dec": round(interp_dec, 6),
                        "vmag": round(interp_vmag, 3) if interp_vmag is not None else None,
                        "angular_sep_deg": round(sep_deg, 6),
                        "source": str(first["source"]),
                    }
                )
        matches.sort(key=lambda item: float(item["angular_sep_deg"]))
        return matches

    @staticmethod
    def _interpolate_ephemeris_rows(
        rows: list[sqlite3.Row],
        target_mjd: float,
    ) -> tuple[float, float, float | None]:
        """Linearly interpolate ``(ra, dec, vmag)`` across sorted ephemeris rows."""
        if len(rows) == 1:
            r0 = rows[0]
            vmag = float(r0["vmag"]) if r0["vmag"] is not None else None
            return float(r0["ra"]) % 360.0, float(r0["dec"]), vmag

        before = rows[0]
        after = rows[-1]
        for idx in range(len(rows) - 1):
            m1 = float(rows[idx]["mjd"])
            m2 = float(rows[idx + 1]["mjd"])
            if m1 <= target_mjd <= m2:
                before = rows[idx]
                after = rows[idx + 1]
                break
        if target_mjd <= float(rows[0]["mjd"]):
            r0 = rows[0]
            vmag = float(r0["vmag"]) if r0["vmag"] is not None else None
            return float(r0["ra"]) % 360.0, float(r0["dec"]), vmag
        if target_mjd >= float(rows[-1]["mjd"]):
            r_last = rows[-1]
            vmag = float(r_last["vmag"]) if r_last["vmag"] is not None else None
            return float(r_last["ra"]) % 360.0, float(r_last["dec"]), vmag

        m1 = float(before["mjd"])
        m2 = float(after["mjd"])
        span = m2 - m1
        t = 0.0 if span <= 1e-9 else max(0.0, min(1.0, (target_mjd - m1) / span))
        ra1 = float(before["ra"]) % 360.0
        ra2 = float(after["ra"]) % 360.0
        # Shortest wrapped angular interpolation in RA
        dra = (ra2 - ra1 + 540.0) % 360.0 - 180.0
        interp_ra = (ra1 + t * dra) % 360.0
        interp_dec = float(before["dec"]) + t * (float(after["dec"]) - float(before["dec"]))
        v1 = before["vmag"]
        v2 = after["vmag"]
        if v1 is not None and v2 is not None:
            interp_vmag: float | None = float(v1) + t * (float(v2) - float(v1))
        elif v1 is not None:
            interp_vmag = float(v1)
        elif v2 is not None:
            interp_vmag = float(v2)
        else:
            interp_vmag = None
        return interp_ra, interp_dec, interp_vmag

    def get_ephemeris_stats(self) -> dict[str, Any]:
        """Return count of stored ephemeris rows, bodies, and cached catalog regions.

        Returns:
            Summary statistics dictionary for ephemeris and catalog caches.
        """
        with self.connection() as conn:
            row = conn.execute(
                """
                SELECT COUNT(*) AS row_count,
                       COUNT(DISTINCT naif_id) AS body_count,
                       MIN(date_bucket) AS min_date,
                       MAX(date_bucket) AS max_date
                FROM solar_system_ephemeris
                """
            ).fetchone()
            cat_row = conn.execute(
                """
                SELECT COUNT(*) AS region_count,
                       COALESCE(SUM(byte_size), 0) AS catalog_bytes
                FROM catalog_region_cache
                """
            ).fetchone()
        return {
            "ephemeris_rows": int(row["row_count"]) if row else 0,
            "distinct_bodies": int(row["body_count"]) if row else 0,
            "min_date": row["min_date"] if row else None,
            "max_date": row["max_date"] if row else None,
            "catalog_regions": int(cat_row["region_count"]) if cat_row else 0,
            "catalog_bytes": int(cat_row["catalog_bytes"]) if cat_row else 0,
        }

    def _prune_if_needed(
        self,
        conn: sqlite3.Connection,
        preserve_grid_key: str | None = None,
    ) -> int:
        """Evict expired catalog entries and LRU patches until within ``max_cache_bytes``."""
        row = conn.execute(
            "SELECT COALESCE(SUM(byte_size), 0) AS total_bytes FROM sky_patches"
        ).fetchone()
        cat_row = conn.execute(
            "SELECT COALESCE(SUM(byte_size), 0) AS total_bytes FROM catalog_region_cache"
        ).fetchone()
        patch_bytes = int(row["total_bytes"]) if row else 0
        cat_bytes = int(cat_row["total_bytes"]) if cat_row else 0
        total_bytes = patch_bytes + cat_bytes
        evicted = 0
        if total_bytes <= self.max_cache_bytes:
            return evicted

        # Pass 0: Purge expired catalog_region_cache rows first, then oldest catalog rows if needed
        if cat_bytes > 0:
            now = time.time()
            expired = conn.execute(
                "SELECT region_key, byte_size FROM catalog_region_cache WHERE expires_at < ?",
                (now,),
            ).fetchall()
            for r in expired:
                conn.execute(
                    "DELETE FROM catalog_region_cache WHERE region_key = ?",
                    (r["region_key"],),
                )
                total_bytes -= int(r["byte_size"])
                evicted += 1
            if total_bytes > self.max_cache_bytes:
                cat_rows = conn.execute(
                    "SELECT region_key, byte_size FROM catalog_region_cache "
                    "ORDER BY last_accessed ASC, rowid ASC"
                ).fetchall()
                for r in cat_rows:
                    if total_bytes <= self.max_cache_bytes:
                        break
                    conn.execute(
                        "DELETE FROM catalog_region_cache WHERE region_key = ?",
                        (r["region_key"],),
                    )
                    total_bytes -= int(r["byte_size"])
                    evicted += 1

        if total_bytes <= self.max_cache_bytes:
            return evicted

        cursor = conn.execute(
            "SELECT grid_key, byte_size FROM sky_patches ORDER BY last_accessed ASC, rowid ASC"
        )
        rows = cursor.fetchall()
        # Pass 1: Evict non-pinned sky patches first so known showcase targets stay cached
        for r in rows:
            if total_bytes <= self.max_cache_bytes:
                break
            if preserve_grid_key and r["grid_key"] == preserve_grid_key:
                continue
            if r["grid_key"] in self.pinned_grid_keys:
                continue
            conn.execute("DELETE FROM sky_patches WHERE grid_key = ?", (r["grid_key"],))
            total_bytes -= int(r["byte_size"])
            evicted += 1
        # Pass 2: Only if pinned patches alone exceed max_cache_bytes, evict oldest pinned patches
        if total_bytes > self.max_cache_bytes:
            for r in rows:
                if total_bytes <= self.max_cache_bytes:
                    break
                if preserve_grid_key and r["grid_key"] == preserve_grid_key:
                    continue
                if r["grid_key"] not in self.pinned_grid_keys:
                    continue
                conn.execute("DELETE FROM sky_patches WHERE grid_key = ?", (r["grid_key"],))
                total_bytes -= int(r["byte_size"])
                evicted += 1
        return evicted

    def clear(self) -> None:
        """Delete all cached entries across every SQLite cache table."""
        with self.connection() as conn:
            conn.execute("DELETE FROM binary_frames")
            conn.execute("DELETE FROM sky_patches")
            conn.execute("DELETE FROM spectra_cache")
            conn.execute("DELETE FROM capital_zenith_cache")
            conn.execute("DELETE FROM catalog_region_cache")
            conn.execute("DELETE FROM solar_system_ephemeris")
