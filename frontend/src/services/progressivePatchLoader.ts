import {
  computeGridKey,
  decodeDetectorBinaryBuffer,
  decodeFlagsBinaryBuffer,
  type BinaryDtype,
  type CatalogsResponse,
  type SkyPatchManifest,
  type SpectrumPayload,
} from '../types/contracts.ts';
import type { ClientPatchCache } from './clientPatchCache.ts';
import { observatoryLogger } from '../utils/observatoryLogger.ts';

export type ProgressiveLoadingStage =
  | { stage: 'idle' }
  | { stage: 'loading_catalogs'; message: string }
  | { stage: 'loading_cutouts'; message: string }
  | { stage: 'ready'; fromClientCache: boolean }
  | { stage: 'error'; message: string };

export interface LoadedPatchResult {
  manifest: SkyPatchManifest;
  epochBuffers: Float32Array[][];
  flagsBuffers: Uint8Array[];
  spectrum: SpectrumPayload | null;
  fromClientCache: boolean;
}

export interface FlowOutcome {
  aborted: boolean;
  fromClientCache?: boolean;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PresetFlowOptions {
  cache: ClientPatchCache;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  onStageChange?: (state: ProgressiveLoadingStage) => void;
  onReady: (result: LoadedPatchResult) => void;
}

export interface LiveFlowOptions {
  cache: ClientPatchCache;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  onStageChange?: (state: ProgressiveLoadingStage) => void;
  onCatalogsReady?: (catalogs: CatalogsResponse) => void;
  onReady: (result: LoadedPatchResult) => void;
}

export async function loadPresetPatchFlow(
  slug: string,
  options: PresetFlowOptions,
): Promise<FlowOutcome> {
  const { cache, fetchImpl = fetch, signal, onStageChange, onReady } = options;
  const cacheKey = `preset:${slug}`;

  const cached = await cache.getPatch(cacheKey);
  if (signal?.aborted) return { aborted: true };

  if (cached) {
    onReady({
      manifest: cached.manifest,
      epochBuffers: cached.epochBuffers,
      flagsBuffers: cached.flagsBuffers,
      spectrum: cached.spectrum ?? null,
      fromClientCache: true,
    });
    return { aborted: false, fromClientCache: true };
  }

  onStageChange?.({ stage: 'loading_cutouts', message: `Loading preset ${slug}...` });
  const manifestRes = await fetchImpl(`/presets/${slug}/manifest.json`, { signal });
  if (signal?.aborted) return { aborted: true };
  if (!manifestRes.ok) {
    throw new Error(`Failed to load preset manifest (${manifestRes.status})`);
  }
  const loadedManifest = (await manifestRes.json()) as SkyPatchManifest;
  if (signal?.aborted) return { aborted: true };

  const decodedEpochs: Float32Array[][] = [];
  const decodedFlags: Uint8Array[] = [];

  for (const ep of loadedManifest.epochs) {
    const [detRes, flagRes] = await Promise.all([
      fetchImpl(ep.detectors_data_url, { signal }),
      fetchImpl(ep.flags_mask_url, { signal }),
    ]);
    if (signal?.aborted) return { aborted: true };
    if (!detRes.ok) {
      throw new Error(`Failed to load detector frame (${detRes.status})`);
    }
    if (!flagRes.ok) {
      throw new Error(`Failed to load flags frame (${flagRes.status})`);
    }
    const [detBuf, flagBuf] = await Promise.all([detRes.arrayBuffer(), flagRes.arrayBuffer()]);
    if (signal?.aborted) return { aborted: true };
    const headerDtype = (detRes.headers.get('X-Binary-Dtype') ||
      ep.binary_dtype ||
      'float32') as BinaryDtype;
    decodedEpochs.push(decodeDetectorBinaryBuffer(detBuf, headerDtype));
    decodedFlags.push(decodeFlagsBinaryBuffer(flagBuf));
  }

  let loadedSpectrum: SpectrumPayload | null = null;
  if (loadedManifest.default_spectrum_url) {
    const specRes = await fetchImpl(loadedManifest.default_spectrum_url, { signal });
    if (signal?.aborted) return { aborted: true };
    if (specRes.ok) {
      loadedSpectrum = (await specRes.json()) as SpectrumPayload;
    }
  }

  if (signal?.aborted) return { aborted: true };

  await cache.putPatch({
    cacheKey,
    manifest: loadedManifest,
    epochBuffers: decodedEpochs,
    flagsBuffers: decodedFlags,
    spectrum: loadedSpectrum,
    storedAt: Date.now(),
    lastAccessed: Date.now(),
  });
  if (signal?.aborted) return { aborted: true };

  onReady({
    manifest: loadedManifest,
    epochBuffers: decodedEpochs,
    flagsBuffers: decodedFlags,
    spectrum: loadedSpectrum,
    fromClientCache: false,
  });
  return { aborted: false, fromClientCache: false };
}

export async function loadLiveCoordinatesFlow(
  ra: number,
  dec: number,
  fovArcmin: number,
  options: LiveFlowOptions,
): Promise<FlowOutcome> {
  const { cache, fetchImpl = fetch, signal, onStageChange, onCatalogsReady, onReady } = options;
  const gridKey = computeGridKey(ra, dec, fovArcmin);

  const cached = await cache.getPatch(gridKey);
  if (signal?.aborted) return { aborted: true };

  if (cached) {
    observatoryLogger.info('patch_loader', 'Live patch cache hit', { gridKey });
    onReady({
      manifest: cached.manifest,
      epochBuffers: cached.epochBuffers,
      flagsBuffers: cached.flagsBuffers,
      spectrum: cached.spectrum ?? null,
      fromClientCache: true,
    });
    return { aborted: false, fromClientCache: true };
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
  const catalogsPromise = fetchImpl(`/api/v1/catalogs?${qs}`, { signal })
    .then(async (res) => {
      if (signal?.aborted || !res.ok) return null;
      const catData = (await res.json()) as CatalogsResponse;
      if (signal?.aborted) return null;
      await cache.putCatalogs(gridKey, catData);
      if (signal?.aborted) return null;
      onCatalogsReady?.(catData);
      return catData;
    })
    .catch((err) => {
      if ((err as Error)?.name === 'AbortError') throw err;
      return null;
    });

  const patchPromise = fetchImpl(`/api/v1/sky-patch?${qs}`, { signal });
  const patchRes = await patchPromise;
  if (signal?.aborted) return { aborted: true };
  if (!patchRes.ok) {
    throw new Error(`Failed to load sky patch (${patchRes.status})`);
  }
  const loadedManifest = (await patchRes.json()) as SkyPatchManifest;
  if (signal?.aborted) return { aborted: true };

  await catalogsPromise;
  if (signal?.aborted) return { aborted: true };

  const decodedEpochs: Float32Array[][] = [];
  const decodedFlags: Uint8Array[] = [];

  for (const ep of loadedManifest.epochs) {
    const detUrl = ep.detectors_data_url.includes('?')
      ? ep.detectors_data_url
      : `${ep.detectors_data_url}?precision=float16`;
    const [detRes, flagRes] = await Promise.all([
      fetchImpl(detUrl, { signal }),
      fetchImpl(ep.flags_mask_url, { signal }),
    ]);
    if (signal?.aborted) return { aborted: true };
    if (!detRes.ok) {
      throw new Error(`Failed to load detector frame (${detRes.status})`);
    }
    if (!flagRes.ok) {
      throw new Error(`Failed to load flags frame (${flagRes.status})`);
    }
    const [detBuf, flagBuf] = await Promise.all([detRes.arrayBuffer(), flagRes.arrayBuffer()]);
    if (signal?.aborted) return { aborted: true };
    const headerDtype = (detRes.headers.get('X-Binary-Dtype') ||
      ep.binary_dtype ||
      'float16') as BinaryDtype;
    decodedEpochs.push(decodeDetectorBinaryBuffer(detBuf, headerDtype));
    decodedFlags.push(decodeFlagsBinaryBuffer(flagBuf));
  }

  let loadedSpectrum: SpectrumPayload | null = null;
  if (loadedManifest.default_spectrum_url) {
    const specRes = await fetchImpl(loadedManifest.default_spectrum_url, { signal });
    if (signal?.aborted) return { aborted: true };
    if (specRes.ok) {
      loadedSpectrum = (await specRes.json()) as SpectrumPayload;
    }
  }

  if (signal?.aborted) return { aborted: true };

  await cache.putPatch({
    cacheKey: gridKey,
    manifest: loadedManifest,
    epochBuffers: decodedEpochs,
    flagsBuffers: decodedFlags,
    spectrum: loadedSpectrum,
    storedAt: Date.now(),
    lastAccessed: Date.now(),
  });
  if (signal?.aborted) return { aborted: true };

  onReady({
    manifest: loadedManifest,
    epochBuffers: decodedEpochs,
    flagsBuffers: decodedFlags,
    spectrum: loadedSpectrum,
    fromClientCache: false,
  });
  return { aborted: false, fromClientCache: false };
}
