/**
 * 3G-Optimised Two-Tier Client Cache (In-Memory LRU Map + Browser IndexedDB).
 *
 * Ensures that once a sky patch's raw binary frames, manifest, and catalog overlays
 * are downloaded, all user-configurable options (combining epochs, wavelength filtering,
 * checking/unchecking known objects, pan/zoom, and click-to-track) execute locally
 * without refetching.
 *
 * Tier 1 — `memoryPatches` / `memoryCatalogs`: insertion-ordered `Map`s that act as
 *          O(1) LRU caches. A warm hit is synchronous in practice (well under 5 ms),
 *          so hot UI interactions never touch the network or disk.
 * Tier 2 — IndexedDB database `star_hunters_patch_cache_v1` with the `sky_patches`
 *          and `catalogs` object stores. Typed-array buffers survive page reloads.
 *
 * The cache is intentionally network-agnostic: `getPatch`/`getCatalogs` never call
 * `fetch`. Use `getOrFetchPatch`/`getOrFetchCatalogs` when a loader is required —
 * the loader is only invoked on a true cache miss, guaranteeing zero network
 * requests for a previously cached `grid_key` or `preset:{slug}`.
 *
 * In headless/Node test environments `indexedDB` is absent, so every operation
 * gracefully degrades to the in-memory tier instead of throwing.
 */

import type { CatalogsResponse, SkyPatchManifest, SpectrumPayload } from '../types/contracts.ts';

export interface CachedSkyPatchBundle {
  cacheKey: string;
  manifest: SkyPatchManifest;
  epochBuffers: Float32Array[][];
  flagsBuffers: Uint8Array[];
  spectrum?: SpectrumPayload | null;
  storedAt: number;
  lastAccessed: number;
}

/** A loaded sky patch bundle before it receives cache bookkeeping fields. */
export type SkyPatchBundleInput = Omit<
  CachedSkyPatchBundle,
  'cacheKey' | 'storedAt' | 'lastAccessed'
> &
  Partial<Pick<CachedSkyPatchBundle, 'storedAt' | 'lastAccessed'>>;

export interface ClientPatchCacheStats {
  memoryPatches: number;
  memoryCatalogs: number;
  maxEntries: number;
  indexedDbAvailable: boolean;
  patchHits: number;
  patchMisses: number;
  catalogHits: number;
  catalogMisses: number;
}

interface CatalogCacheEntry {
  value: CatalogsResponse;
  storedAt: number;
  lastAccessed: number;
}

/** Canonical `preset:{slug}` cache key used by the preset tour. */
export function presetCacheKey(slug: string): string {
  return `preset:${slug.trim()}`;
}

/**
 * Canonical cache key for a live `ra/dec/fov` query. The backend `grid_key`
 * (see `computeGridKey`) is already stable and URL-safe, so it is used verbatim.
 */
export function gridCacheKey(gridKey: string): string {
  return gridKey.trim();
}

export const PATCH_CACHE_DB_NAME = 'star_hunters_patch_cache_v1';
export const PATCH_CACHE_STORE_PATCHES = 'sky_patches';
export const PATCH_CACHE_STORE_CATALOGS = 'catalogs';
export const DEFAULT_MAX_MEMORY_PATCHES = 16;

export class ClientPatchCache {
  private memoryPatches = new Map<string, CachedSkyPatchBundle>();
  private memoryCatalogs = new Map<string, CatalogCacheEntry>();
  /** Session-local LRU stamps, used to prune IndexedDB even before access writes flush. */
  private patchAccessOrder = new Map<string, number>();
  private catalogAccessOrder = new Map<string, number>();
  private maxEntries: number;
  private accessClock = 0;
  private patchHits = 0;
  private patchMisses = 0;
  private catalogHits = 0;
  private catalogMisses = 0;
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  constructor(maxEntries: number = DEFAULT_MAX_MEMORY_PATCHES) {
    this.maxEntries = Number.isFinite(maxEntries)
      ? Math.max(0, Math.floor(maxEntries))
      : DEFAULT_MAX_MEMORY_PATCHES;
  }

  // -------------------------------------------------------------------------
  // Sky patch bundle — Tier 1 + Tier 2
  // -------------------------------------------------------------------------

  public async getPatch(cacheKey: string): Promise<CachedSkyPatchBundle | null> {
    const inMem = this.memoryPatches.get(cacheKey);
    if (inMem) {
      this.patchHits += 1;
      // Hot path: touch memory only. Re-serializing a multi-megabyte bundle to
      // IndexedDB on every read would defeat the <5 ms requirement; the
      // session access order is enough to rank persistent LRU pruning.
      this.touchMemoryPatch(cacheKey, inMem);
      return inMem;
    }

    const fromIdb = await this.readFromIndexedDb<CachedSkyPatchBundle>(
      PATCH_CACHE_STORE_PATCHES,
      cacheKey,
    );
    if (fromIdb) {
      this.patchHits += 1;
      const stamp = this.nextAccessStamp();
      fromIdb.lastAccessed = stamp;
      this.patchAccessOrder.set(cacheKey, stamp);
      this.putMemoryPatch(cacheKey, fromIdb);
      return fromIdb;
    }

    this.patchMisses += 1;
    return null;
  }

  /**
   * Memory-only synchronous lookup (no promise, no IndexedDB). Useful for
   * 60 FPS render loops that must never await storage.
   */
  public getPatchSync(cacheKey: string): CachedSkyPatchBundle | null {
    const inMem = this.memoryPatches.get(cacheKey);
    if (!inMem) {
      this.patchMisses += 1;
      return null;
    }
    this.patchHits += 1;
    this.touchMemoryPatch(cacheKey, inMem);
    return inMem;
  }

  public async hasPatch(cacheKey: string): Promise<boolean> {
    if (this.memoryPatches.has(cacheKey)) return true;
    const fromIdb = await this.readFromIndexedDb<CachedSkyPatchBundle>(
      PATCH_CACHE_STORE_PATCHES,
      cacheKey,
    );
    return fromIdb !== null;
  }

  public async putPatch(bundle: CachedSkyPatchBundle): Promise<void> {
    const stamp = this.nextAccessStamp();
    const entry: CachedSkyPatchBundle = {
      ...bundle,
      storedAt: bundle.storedAt || Date.now(),
      lastAccessed: stamp,
    };
    this.patchAccessOrder.set(entry.cacheKey, stamp);
    this.putMemoryPatch(entry.cacheKey, entry);
    await this.writeToIndexedDb(PATCH_CACHE_STORE_PATCHES, entry.cacheKey, entry);
    await this.pruneIndexedDb(PATCH_CACHE_STORE_PATCHES, this.patchAccessOrder);
  }

  public async deletePatch(cacheKey: string): Promise<void> {
    this.memoryPatches.delete(cacheKey);
    this.patchAccessOrder.delete(cacheKey);
    await this.deleteFromIndexedDb(PATCH_CACHE_STORE_PATCHES, cacheKey);
  }

  /**
   * Return the cached patch, or invoke `loader` exactly once on a miss and cache
   * its result. A warm cache therefore performs **zero network requests**.
   */
  public async getOrFetchPatch(
    cacheKey: string,
    loader: () => Promise<SkyPatchBundleInput | null>,
  ): Promise<CachedSkyPatchBundle | null> {
    const cached = await this.getPatch(cacheKey);
    if (cached) return cached;

    const loaded = await loader();
    if (!loaded) return null;

    const entry: CachedSkyPatchBundle = {
      ...loaded,
      cacheKey,
      storedAt: loaded.storedAt || Date.now(),
      lastAccessed: this.nextAccessStamp(),
    };
    await this.putPatch(entry);
    return entry;
  }

  // -------------------------------------------------------------------------
  // Catalog overlays — Tier 1 + Tier 2
  // -------------------------------------------------------------------------

  public async getCatalogs(gridKey: string): Promise<CatalogsResponse | null> {
    const inMem = this.memoryCatalogs.get(gridKey);
    if (inMem) {
      this.catalogHits += 1;
      this.touchMemoryCatalog(gridKey, inMem);
      return inMem.value;
    }

    const fromIdb = await this.readFromIndexedDb<CatalogCacheEntry>(
      PATCH_CACHE_STORE_CATALOGS,
      gridKey,
    );
    if (fromIdb) {
      this.catalogHits += 1;
      const stamp = this.nextAccessStamp();
      fromIdb.lastAccessed = stamp;
      this.catalogAccessOrder.set(gridKey, stamp);
      this.putMemoryCatalog(gridKey, fromIdb);
      return fromIdb.value;
    }

    this.catalogMisses += 1;
    return null;
  }

  public async hasCatalogs(gridKey: string): Promise<boolean> {
    if (this.memoryCatalogs.has(gridKey)) return true;
    const fromIdb = await this.readFromIndexedDb<CatalogCacheEntry>(
      PATCH_CACHE_STORE_CATALOGS,
      gridKey,
    );
    return fromIdb !== null;
  }

  public async putCatalogs(gridKey: string, catalogs: CatalogsResponse): Promise<void> {
    const stamp = this.nextAccessStamp();
    const entry: CatalogCacheEntry = {
      value: catalogs,
      storedAt: Date.now(),
      lastAccessed: stamp,
    };
    this.catalogAccessOrder.set(gridKey, stamp);
    this.putMemoryCatalog(gridKey, entry);
    await this.writeToIndexedDb(PATCH_CACHE_STORE_CATALOGS, gridKey, entry);
    await this.pruneIndexedDb(PATCH_CACHE_STORE_CATALOGS, this.catalogAccessOrder);
  }

  public async deleteCatalogs(gridKey: string): Promise<void> {
    this.memoryCatalogs.delete(gridKey);
    this.catalogAccessOrder.delete(gridKey);
    await this.deleteFromIndexedDb(PATCH_CACHE_STORE_CATALOGS, gridKey);
  }

  /** Return cached catalogs, or load them once on a miss. */
  public async getOrFetchCatalogs(
    gridKey: string,
    loader: () => Promise<CatalogsResponse | null>,
  ): Promise<CatalogsResponse | null> {
    const cached = await this.getCatalogs(gridKey);
    if (cached) return cached;

    const loaded = await loader();
    if (!loaded) return null;
    await this.putCatalogs(gridKey, loaded);
    return loaded;
  }

  // -------------------------------------------------------------------------
  // Housekeeping & diagnostics
  // -------------------------------------------------------------------------

  public clearMemory(): void {
    this.memoryPatches.clear();
    this.memoryCatalogs.clear();
    this.patchAccessOrder.clear();
    this.catalogAccessOrder.clear();
  }

  /** Clear both tiers (memory + persistent IndexedDB stores). */
  public async clearAll(): Promise<void> {
    this.clearMemory();
    const db = await this.openDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(
          [PATCH_CACHE_STORE_PATCHES, PATCH_CACHE_STORE_CATALOGS],
          'readwrite',
        );
        tx.objectStore(PATCH_CACHE_STORE_PATCHES).clear();
        tx.objectStore(PATCH_CACHE_STORE_CATALOGS).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  public get size(): { patches: number; catalogs: number } {
    return {
      patches: this.memoryPatches.size,
      catalogs: this.memoryCatalogs.size,
    };
  }

  public get capacity(): number {
    return this.maxEntries;
  }

  public getStats(): ClientPatchCacheStats {
    return {
      memoryPatches: this.memoryPatches.size,
      memoryCatalogs: this.memoryCatalogs.size,
      maxEntries: this.maxEntries,
      indexedDbAvailable: this.isIndexedDbAvailable(),
      patchHits: this.patchHits,
      patchMisses: this.patchMisses,
      catalogHits: this.catalogHits,
      catalogMisses: this.catalogMisses,
    };
  }

  /** True only when the browser exposes a usable IndexedDB implementation. */
  public isPersistentStorageAvailable(): boolean {
    return this.isIndexedDbAvailable();
  }

  // -------------------------------------------------------------------------
  // In-memory LRU internals
  // -------------------------------------------------------------------------

  private nextAccessStamp(): number {
    this.accessClock = Math.max(Date.now(), this.accessClock + 1);
    return this.accessClock;
  }

  private touchMemoryPatch(cacheKey: string, entry: CachedSkyPatchBundle): number {
    const stamp = this.nextAccessStamp();
    entry.lastAccessed = stamp;
    this.memoryPatches.delete(cacheKey);
    this.memoryPatches.set(cacheKey, entry);
    this.patchAccessOrder.set(cacheKey, stamp);
    return stamp;
  }

  private touchMemoryCatalog(cacheKey: string, entry: CatalogCacheEntry): number {
    const stamp = this.nextAccessStamp();
    entry.lastAccessed = stamp;
    this.memoryCatalogs.delete(cacheKey);
    this.memoryCatalogs.set(cacheKey, entry);
    this.catalogAccessOrder.set(cacheKey, stamp);
    return stamp;
  }

  private putMemoryPatch(cacheKey: string, entry: CachedSkyPatchBundle): void {
    this.memoryPatches.delete(cacheKey);
    this.memoryPatches.set(cacheKey, entry);
    while (this.memoryPatches.size > this.maxEntries) {
      const oldestKey = this.memoryPatches.keys().next().value;
      if (oldestKey === undefined) break;
      this.memoryPatches.delete(oldestKey);
      this.patchAccessOrder.delete(oldestKey);
    }
  }

  private putMemoryCatalog(cacheKey: string, entry: CatalogCacheEntry): void {
    this.memoryCatalogs.delete(cacheKey);
    this.memoryCatalogs.set(cacheKey, entry);
    while (this.memoryCatalogs.size > this.maxEntries) {
      const oldestKey = this.memoryCatalogs.keys().next().value;
      if (oldestKey === undefined) break;
      this.memoryCatalogs.delete(oldestKey);
      this.catalogAccessOrder.delete(oldestKey);
    }
  }

  // -------------------------------------------------------------------------
  // IndexedDB internals (gracefully absent in Node/headless tests)
  // -------------------------------------------------------------------------

  private isIndexedDbAvailable(): boolean {
    return (
      typeof globalThis !== 'undefined' &&
      'indexedDB' in globalThis &&
      globalThis.indexedDB !== null &&
      globalThis.indexedDB !== undefined
    );
  }

  private openDb(): Promise<IDBDatabase | null> {
    if (!this.isIndexedDbAvailable()) {
      return Promise.resolve(null);
    }
    if (this.dbPromise) {
      return this.dbPromise;
    }
    this.dbPromise = new Promise((resolve) => {
      try {
        const req = globalThis.indexedDB.open(PATCH_CACHE_DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(PATCH_CACHE_STORE_PATCHES)) {
            db.createObjectStore(PATCH_CACHE_STORE_PATCHES);
          }
          if (!db.objectStoreNames.contains(PATCH_CACHE_STORE_CATALOGS)) {
            db.createObjectStore(PATCH_CACHE_STORE_CATALOGS);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.dbPromise;
  }

  private async readFromIndexedDb<T>(storeName: string, key: string): Promise<T | null> {
    const db = await this.openDb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.get(key);
        req.onsuccess = () => resolve((req.result as T) ?? null);
        req.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  private async writeToIndexedDb<T>(storeName: string, key: string, value: T): Promise<void> {
    const db = await this.openDb();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        store.put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  private async deleteFromIndexedDb(storeName: string, key: string): Promise<void> {
    const db = await this.openDb();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  /**
   * Bound the persistent store to `maxEntries`, deleting the least-recently-used
   * rows first. Session access stamps take precedence over persisted timestamps
   * so an access performed earlier in this page session is never mis-ranked just
   * because its IndexedDB write has not flushed yet.
   */
  private async pruneIndexedDb(storeName: string, accessOrder: Map<string, number>): Promise<void> {
    const db = await this.openDb();
    if (!db) return;

    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const rows: Array<{ key: IDBValidKey; stamp: number }> = [];
        const cursorReq = store.openCursor();

        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) {
            if (rows.length > this.maxEntries) {
              rows.sort((a, b) => a.stamp - b.stamp);
              const excess = rows.length - this.maxEntries;
              for (let i = 0; i < excess; i += 1) {
                store.delete(rows[i].key);
                accessOrder.delete(String(rows[i].key));
              }
            }
            return;
          }

          const keyStr = String(cursor.key);
          const value = cursor.value as { storedAt?: number; lastAccessed?: number } | null;
          const stamp = accessOrder.get(keyStr) ?? value?.lastAccessed ?? value?.storedAt ?? 0;
          rows.push({ key: cursor.key, stamp });
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }
}

export const defaultClientPatchCache = new ClientPatchCache();
