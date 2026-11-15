import type {
  BinaryDtype,
  CatalogsResponse,
  EpochManifestEntry,
  SkyPatchManifest,
  SpectrumPayload,
} from '../types/contracts.ts';
import { decodeDetectorBinaryBuffer, decodeFlagsBinaryBuffer } from '../utils/binaryDecoder.ts';
import { observatoryLogger } from '../utils/observatoryLogger.ts';
import { computeGridKey } from '../utils/wcsViewport.ts';
import type { ClientPatchCache } from './clientPatchCache.ts';

/** Progressive two-stage loading state emitted during preset and live sky patch loads. */
export type ProgressiveLoadingStage =
  | { stage: 'idle' }
  | { stage: 'loading_catalogs'; message: string }
  | { stage: 'loading_cutouts'; message: string }
  | { stage: 'ready'; fromClientCache: boolean }
  | { stage: 'error'; message: string };

/** Fully decoded sky patch payload delivered to {@link PresetFlowOptions.onReady} / {@link LiveFlowOptions.onReady}. */
export interface LoadedPatchResult {
  manifest: SkyPatchManifest;
  epochBuffers: Float32Array[][];
  flagsBuffers: Uint8Array[];
  spectrum: SpectrumPayload | null;
  fromClientCache: boolean;
}

/** Terminal outcome of a progressive patch loading flow. */
export interface FlowOutcome {
  aborted: boolean;
  fromClientCache?: boolean;
}

/** Minimal `fetch` function signature accepted for dependency injection in tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Options for {@link loadPresetPatchFlow}. */
export interface PresetFlowOptions {
  cache: ClientPatchCache;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  onStageChange?: (state: ProgressiveLoadingStage) => void;
  onReady: (result: LoadedPatchResult) => void;
}

/** Options for {@link loadLiveCoordinatesFlow}. */
export interface LiveFlowOptions {
  cache: ClientPatchCache;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  onStageChange?: (state: ProgressiveLoadingStage) => void;
  onCatalogsReady?: (catalogs: CatalogsResponse) => void;
  onReady: (result: LoadedPatchResult) => void;
  timeouts?: {
    catalogsMs?: number;
    patchMs?: number;
    frameMs?: number;
  };
}

export const CATALOGS_FETCH_TIMEOUT_MS = 15_000;
export const SKY_PATCH_FETCH_TIMEOUT_MS = 28_000;
export const FRAME_FETCH_TIMEOUT_MS = 15_000;
export const PRESET_FETCH_TIMEOUT_MS = 15_000;

/** Options for {@link fetchAndCachePatchBundle}. */
interface FetchPatchBundleOptions {
  cache: ClientPatchCache;
  cacheKey: string;
  manifest: SkyPatchManifest;
  fetchImpl: FetchLike;
  signal?: AbortSignal;
  preferFloat16: boolean;
  defaultDtype: BinaryDtype;
  prefetchSpectrum: boolean;
  frameTimeoutMs?: number;
  onReady: (result: LoadedPatchResult) => void;
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  input: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  if (signal?.aborted) {
    const abortErr = new Error('Aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  }
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });
  const timerId = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetchImpl(input, { signal: controller.signal });
    if (signal?.aborted) {
      const abortErr = new Error('Aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    return res;
  } catch (err) {
    if (timedOut && !signal?.aborted) {
      throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`, { cause: err });
    }
    throw err;
  } finally {
    globalThis.clearTimeout(timerId);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

async function readErrorDetail(res: Response, fallbackPrefix: string): Promise<string> {
  try {
    const contentType = res.headers?.get?.('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = (await res.json()) as { detail?: unknown; message?: unknown };
      const msg =
        typeof body?.detail === 'string'
          ? body.detail
          : typeof body?.message === 'string'
            ? body.message
            : '';
      if (msg.trim()) {
        return `${fallbackPrefix} (${res.status}): ${msg.trim()}`;
      }
    }
  } catch {
    // Fall back to HTTP status string
  }
  return `${fallbackPrefix} (${res.status})`;
}

/**
 * Attempt to satisfy a patch load directly from the two-tier client cache.
 *
 * @param cache - Client patch cache instance.
 * @param cacheKey - Canonical cache key (`preset:{slug}` or quantized `grid_key`).
 * @param signal - Optional abort signal.
 * @param onReady - Callback invoked on cache hit.
 * @returns A resolved {@link FlowOutcome} on hit or abort, or `null` on cache miss.
 */
async function tryServeCachedPatch(
  cache: ClientPatchCache,
  cacheKey: string,
  signal: AbortSignal | undefined,
  onReady: (result: LoadedPatchResult) => void,
): Promise<FlowOutcome | null> {
  const cached = await cache.getPatch(cacheKey);
  if (signal?.aborted) return { aborted: true };
  if (!cached) return null;

  onReady({
    manifest: cached.manifest,
    epochBuffers: cached.epochBuffers,
    flagsBuffers: cached.flagsBuffers,
    spectrum: cached.spectrum ?? null,
    fromClientCache: true,
  });
  return { aborted: false, fromClientCache: true };
}

/**
 * Fetch and decode the 6-detector binary cube and 8-bit hygiene flags mask for one epoch.
 *
 * @param epoch - Epoch descriptor from a {@link SkyPatchManifest}.
 * @param options - Fetch implementation, abort signal, and binary precision hints.
 * @returns Decoded detector planes (`Float32Array[6]`) and hygiene flag mask (`Uint8Array`).
 * @throws {Error} When either the detector frame or flags frame HTTP request fails.
 */
async function fetchDecodedEpoch(
  epoch: EpochManifestEntry,
  options: {
    fetchImpl: FetchLike;
    signal?: AbortSignal;
    preferFloat16: boolean;
    defaultDtype: BinaryDtype;
    frameTimeoutMs?: number;
  },
): Promise<{ detectors: Float32Array[]; flags: Uint8Array }> {
  const {
    fetchImpl,
    signal,
    preferFloat16,
    defaultDtype,
    frameTimeoutMs = FRAME_FETCH_TIMEOUT_MS,
  } = options;
  const detUrl =
    preferFloat16 && !epoch.detectors_data_url.includes('?')
      ? `${epoch.detectors_data_url}?precision=float16`
      : epoch.detectors_data_url;

  const [detRes, flagRes] = await Promise.all([
    fetchWithTimeout(fetchImpl, detUrl, signal, frameTimeoutMs, 'Detector frame'),
    fetchWithTimeout(fetchImpl, epoch.flags_mask_url, signal, frameTimeoutMs, 'Flags frame'),
  ]);
  if (signal?.aborted) {
    const abortErr = new Error('Aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  }
  if (!detRes.ok) {
    throw new Error(await readErrorDetail(detRes, 'Failed to load detector frame'));
  }
  if (!flagRes.ok) {
    throw new Error(await readErrorDetail(flagRes, 'Failed to load flags frame'));
  }

  const [detBuf, flagBuf] = await Promise.all([detRes.arrayBuffer(), flagRes.arrayBuffer()]);
  if (signal?.aborted) {
    const abortErr = new Error('Aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  }
  const headerDtype = (detRes.headers.get('X-Binary-Dtype') ||
    epoch.binary_dtype ||
    defaultDtype) as BinaryDtype;

  return {
    detectors: decodeDetectorBinaryBuffer(detBuf, headerDtype),
    flags: decodeFlagsBinaryBuffer(flagBuf),
  };
}

/**
 * Concurrently fetch and decode all epoch binary buffers and optional default
 * spectrum for a manifest, persist the bundle in {@link ClientPatchCache}, and
 * invoke `onReady`.
 *
 * @param options - Manifest, cache target, fetch implementation, and callbacks.
 * @returns Flow completion status (`aborted: true` if cancelled before completion).
 */
async function fetchAndCachePatchBundle(options: FetchPatchBundleOptions): Promise<FlowOutcome> {
  const {
    cache,
    cacheKey,
    manifest,
    fetchImpl,
    signal,
    preferFloat16,
    defaultDtype,
    prefetchSpectrum,
    frameTimeoutMs,
    onReady,
  } = options;

  const epochPromises = manifest.epochs.map((epoch) =>
    fetchDecodedEpoch(epoch, { fetchImpl, signal, preferFloat16, defaultDtype, frameTimeoutMs }),
  );
  const spectrumPromise =
    prefetchSpectrum && manifest.default_spectrum_url
      ? fetchWithTimeout(
          fetchImpl,
          manifest.default_spectrum_url,
          signal,
          PRESET_FETCH_TIMEOUT_MS,
          'Preset spectrum',
        )
          .then(async (res) => (res.ok ? ((await res.json()) as SpectrumPayload) : null))
          .catch(() => null)
      : Promise.resolve(null);

  const [decodedEpochs, loadedSpectrum] = await Promise.all([
    Promise.all(epochPromises),
    spectrumPromise,
  ]);
  if (signal?.aborted) return { aborted: true };

  const epochBuffers = decodedEpochs.map((entry) => entry.detectors);
  const flagsBuffers = decodedEpochs.map((entry) => entry.flags);

  const now = Date.now();
  await cache.putPatch({
    cacheKey,
    manifest,
    epochBuffers,
    flagsBuffers,
    spectrum: loadedSpectrum,
    storedAt: now,
    lastAccessed: now,
  });
  if (signal?.aborted) return { aborted: true };

  onReady({
    manifest,
    epochBuffers,
    flagsBuffers,
    spectrum: loadedSpectrum,
    fromClientCache: false,
  });
  return { aborted: false, fromClientCache: false };
}

/**
 * Load a static benchmark preset bundle (`/presets/{slug}/manifest.json` plus
 * epoch binary frames and default spectrum), serving from {@link ClientPatchCache}
 * when already cached.
 *
 * @param slug - Benchmark preset identifier (e.g., `'wise_0855'`).
 * @param options - Cache instance, abort signal, stage callback, and completion callback.
 * @returns Outcome indicating whether the flow was aborted or served from cache.
 * @throws {Error} When the manifest or any epoch binary frame fails to load.
 */
export async function loadPresetPatchFlow(
  slug: string,
  options: PresetFlowOptions,
): Promise<FlowOutcome> {
  const { cache, fetchImpl = fetch, signal, onStageChange, onReady } = options;
  const cacheKey = `preset:${slug}`;

  const cacheOutcome = await tryServeCachedPatch(cache, cacheKey, signal, onReady);
  if (cacheOutcome) return cacheOutcome;

  onStageChange?.({ stage: 'loading_cutouts', message: `Loading preset ${slug}...` });
  const manifestRes = await fetchWithTimeout(
    fetchImpl,
    `/presets/${slug}/manifest.json`,
    signal,
    PRESET_FETCH_TIMEOUT_MS,
    'Preset manifest',
  );
  if (signal?.aborted) return { aborted: true };
  if (!manifestRes.ok) {
    throw new Error(await readErrorDetail(manifestRes, 'Failed to load preset manifest'));
  }
  const loadedManifest = (await manifestRes.json()) as SkyPatchManifest;
  if (signal?.aborted) return { aborted: true };

  return fetchAndCachePatchBundle({
    cache,
    cacheKey,
    manifest: loadedManifest,
    fetchImpl,
    signal,
    preferFloat16: false,
    defaultDtype: 'float32',
    prefetchSpectrum: true,
    onReady,
  });
}

/**
 * Load a live sky patch at `(ra, dec, fovArcmin)` using a two-stage progressive
 * pipeline: Stage A fetches `/api/v1/catalogs` concurrently with Stage B
 * `/api/v1/sky-patch`, then fetches all epoch frames in parallel with `?precision=float16`.
 *
 * @param ra - Right Ascension in decimal degrees `[0, 360)`.
 * @param dec - Declination in decimal degrees `[-90, 90]`.
 * @param fovArcmin - Field-of-view width in arcminutes.
 * @param options - Cache instance, abort signal, and Stage A / Stage B callbacks.
 * @returns Outcome indicating whether the flow was aborted or served from cache.
 * @throws {Error} When `/api/v1/sky-patch` or any epoch binary frame fails to load.
 */
export async function loadLiveCoordinatesFlow(
  ra: number,
  dec: number,
  fovArcmin: number,
  options: LiveFlowOptions,
): Promise<FlowOutcome> {
  const {
    cache,
    fetchImpl = fetch,
    signal,
    onStageChange,
    onCatalogsReady,
    onReady,
    timeouts,
  } = options;
  const catalogsTimeoutMs = timeouts?.catalogsMs ?? CATALOGS_FETCH_TIMEOUT_MS;
  const patchTimeoutMs = timeouts?.patchMs ?? SKY_PATCH_FETCH_TIMEOUT_MS;
  const frameTimeoutMs = timeouts?.frameMs ?? FRAME_FETCH_TIMEOUT_MS;
  const gridKey = computeGridKey(ra, dec, fovArcmin);

  const cacheOutcome = await tryServeCachedPatch(cache, gridKey, signal, onReady);
  if (cacheOutcome) {
    if (!cacheOutcome.aborted) {
      observatoryLogger.info('patch_loader', 'Live patch cache hit', { gridKey });
    }
    return cacheOutcome;
  }

  observatoryLogger.info('patch_loader', 'Fetching live sky patch & catalogs', {
    gridKey,
    ra,
    dec,
    fovArcmin,
  });
  onStageChange?.({
    stage: 'loading_catalogs',
    message: 'Querying sky catalogs...',
  });
  const qs = `ra=${encodeURIComponent(ra)}&dec=${encodeURIComponent(dec)}&fov=${encodeURIComponent(fovArcmin)}`;

  // Stage A (fast async catalogs) and Stage B (cutout manifest) run concurrently
  const catalogsPromise = fetchWithTimeout(
    fetchImpl,
    `/api/v1/catalogs?${qs}`,
    signal,
    catalogsTimeoutMs,
    'Catalogs lookup',
  )
    .then(async (res) => {
      if (signal?.aborted || !res.ok) return null;
      const catData = (await res.json()) as CatalogsResponse;
      if (signal?.aborted) return null;
      await cache.putCatalogs(gridKey, catData);
      if (signal?.aborted) return null;
      onCatalogsReady?.(catData);
      return catData;
    })
    .catch(() => null);

  const patchRes = await fetchWithTimeout(
    fetchImpl,
    `/api/v1/sky-patch?${qs}`,
    signal,
    patchTimeoutMs,
    'Sky patch request',
  );
  if (signal?.aborted) return { aborted: true };
  if (!patchRes.ok) {
    throw new Error(await readErrorDetail(patchRes, 'Failed to load sky patch'));
  }
  const loadedManifest = (await patchRes.json()) as SkyPatchManifest;
  if (signal?.aborted) return { aborted: true };

  await catalogsPromise;
  if (signal?.aborted) return { aborted: true };

  return fetchAndCachePatchBundle({
    cache,
    cacheKey: gridKey,
    manifest: loadedManifest,
    fetchImpl,
    signal,
    preferFloat16: true,
    defaultDtype: 'float16',
    prefetchSpectrum: false,
    frameTimeoutMs,
    onReady,
  });
}
