/**
 * 3G-Optimised Two-Tier Client Cache (In-Memory Map + Browser IndexedDB).
 *
 * Ensures that once a sky patch's raw binary frames, manifest, and catalog overlays
 * are downloaded, all user-configurable options (combining epochs, wavelength filtering,
 * checking/unchecking known objects, and click-to-track) execute locally without refetching.
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

const DB_NAME = 'star_hunters_patch_cache_v1';
const STORE_PATCHES = 'sky_patches';
const STORE_CATALOGS = 'catalogs';
const MAX_MEMORY_PATCHES = 16;

export class ClientPatchCache {
  private memoryPatches = new Map<string, CachedSkyPatchBundle>();
  private memoryCatalogs = new Map<string, CatalogsResponse>();
  private maxEntries: number;

  constructor(maxEntries: number = MAX_MEMORY_PATCHES) {
    this.maxEntries = maxEntries;
  }

  public async getPatch(cacheKey: string): Promise<CachedSkyPatchBundle | null> {
    const inMem = this.memoryPatches.get(cacheKey);
    if (inMem) {
      inMem.lastAccessed = Date.now();
      this.memoryPatches.delete(cacheKey);
      this.memoryPatches.set(cacheKey, inMem);
      return inMem;
    }

    const fromIdb = await this.readFromIndexedDb<CachedSkyPatchBundle>(STORE_PATCHES, cacheKey);
    if (fromIdb) {
      fromIdb.lastAccessed = Date.now();
      this.putMemoryPatch(cacheKey, fromIdb);
      return fromIdb;
    }
    return null;
  }

  public async putPatch(bundle: CachedSkyPatchBundle): Promise<void> {
    const entry: CachedSkyPatchBundle = {
      ...bundle,
      storedAt: bundle.storedAt || Date.now(),
      lastAccessed: Date.now(),
    };
    this.putMemoryPatch(entry.cacheKey, entry);
    await this.writeToIndexedDb(STORE_PATCHES, entry.cacheKey, entry);
  }

  public async getCatalogs(gridKey: string): Promise<CatalogsResponse | null> {
    const inMem = this.memoryCatalogs.get(gridKey);
    if (inMem) {
      return inMem;
    }
    const fromIdb = await this.readFromIndexedDb<CatalogsResponse>(STORE_CATALOGS, gridKey);
    if (fromIdb) {
      this.memoryCatalogs.set(gridKey, fromIdb);
      return fromIdb;
    }
    return null;
  }

  public async putCatalogs(gridKey: string, catalogs: CatalogsResponse): Promise<void> {
    this.memoryCatalogs.set(gridKey, catalogs);
    await this.writeToIndexedDb(STORE_CATALOGS, gridKey, catalogs);
  }

  public clearMemory(): void {
    this.memoryPatches.clear();
    this.memoryCatalogs.clear();
  }

  private putMemoryPatch(cacheKey: string, entry: CachedSkyPatchBundle): void {
    if (this.memoryPatches.has(cacheKey)) {
      this.memoryPatches.delete(cacheKey);
    }
    this.memoryPatches.set(cacheKey, entry);
    while (this.memoryPatches.size > this.maxEntries) {
      const oldestKey = this.memoryPatches.keys().next().value;
      if (oldestKey === undefined) break;
      this.memoryPatches.delete(oldestKey);
    }
  }

  private isIndexedDbAvailable(): boolean {
    return (
      typeof globalThis !== 'undefined' &&
      'indexedDB' in globalThis &&
      globalThis.indexedDB !== null
    );
  }

  private openDb(): Promise<IDBDatabase | null> {
    if (!this.isIndexedDbAvailable()) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      try {
        const req = globalThis.indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_PATCHES)) {
            db.createObjectStore(STORE_PATCHES);
          }
          if (!db.objectStoreNames.contains(STORE_CATALOGS)) {
            db.createObjectStore(STORE_CATALOGS);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
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
      } catch {
        resolve();
      }
    });
  }
}

export const defaultClientPatchCache = new ClientPatchCache();
