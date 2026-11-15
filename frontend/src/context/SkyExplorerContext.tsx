import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  clampViewportPanZoom,
  computeGridKey,
  decodeDetectorBinaryBuffer,
  decodeFlagsBinaryBuffer,
  detectAndTrackBodiesAtClick,
  getDefaultCheckedObjectIds,
  type BinaryDtype,
  type CatalogsResponse,
  type ClickDiagnosticInfo,
  type KnownCelestialObject,
  type SkyExplorerContextValue,
  type SkyPatchManifest,
  type SpectrumPayload,
  type TracedObjectSummary,
  type ViewportRenderSettings,
} from '../types/contracts';
import { defaultClientPatchCache } from '../services/clientPatchCache';
import {
  clearCheckedObjectIds,
  selectAllObjectIds,
  toggleObjectId,
} from '../utils/knownObjectSelection';

const INITIAL_RENDER_SETTINGS: ViewportRenderSettings = {
  mode: 'blink',
  activeEpochIndex: 0,
  passAIndex: 0,
  passBIndex: 1,
  coaddIndices: [0, 1],
  wavelengthRangeUm: [0.75, 5.0],
  contrastStretch: 'asinh',
  showGaiaOverlay: true,
  showWiseOverlay: true,
  showMostOverlay: true,
  showFlagsOverlay: false,
  checkedObjectIds: [],
  zoom: 1.0,
  panX: 0.0,
  panY: 0.0,
};

const SkyExplorerContext = createContext<SkyExplorerContextValue | null>(null);

export const SkyExplorerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activePresetSlug, setActivePresetSlug] = useState<string | null>('wise_0855');
  const [coordinates, setCoordinates] = useState<{ ra: number; dec: number; fovArcmin: number }>({
    ra: 133.7951,
    dec: -7.2451,
    fovArcmin: 5.0,
  });
  const [manifest, setManifest] = useState<SkyPatchManifest | null>(null);
  const [epochBuffers, setEpochBuffers] = useState<Float32Array[][] | null>(null);
  const [flagsBuffers, setFlagsBuffers] = useState<Uint8Array[] | null>(null);
  const [loadingState, setLoadingState] = useState<SkyExplorerContextValue['loadingState']>({
    stage: 'idle',
  });
  const [renderSettings, setRenderSettings] =
    useState<ViewportRenderSettings>(INITIAL_RENDER_SETTINGS);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isLooping, setIsLooping] = useState<boolean>(false); // MUST default to false
  const [fps, setFps] = useState<number>(2);
  const [selectedObject, setSelectedObject] = useState<TracedObjectSummary | null>(null);
  const [trackedTargets, setTrackedTargets] = useState<TracedObjectSummary[]>([]);
  const [lastClickDiagnostic, setLastClickDiagnostic] = useState<ClickDiagnosticInfo | null>(null);
  const [activeSpectrum, setActiveSpectrum] = useState<SpectrumPayload | null>(null);
  const [isSpectrumLoading, setIsSpectrumLoading] = useState<boolean>(false);

  const abortControllerRef = useRef<AbortController | null>(null);

  const knownObjects: KnownCelestialObject[] = useMemo(
    () => manifest?.catalog_overlays?.known_objects ?? [],
    [manifest],
  );

  const updateRenderSettings = useCallback((partial: Partial<ViewportRenderSettings>) => {
    setRenderSettings((prev) => {
      const merged = { ...prev, ...partial };
      const clamped = clampViewportPanZoom(merged.zoom, merged.panX, merged.panY);
      return {
        ...merged,
        zoom: clamped.zoom,
        panX: clamped.panX,
        panY: clamped.panY,
      };
    });
  }, []);

  const setViewportZoomPan = useCallback((zoom: number, panX: number, panY: number) => {
    const clamped = clampViewportPanZoom(zoom, panX, panY);
    setRenderSettings((prev) => ({
      ...prev,
      zoom: clamped.zoom,
      panX: clamped.panX,
      panY: clamped.panY,
    }));
  }, []);

  const resetViewportZoomPan = useCallback(() => {
    setRenderSettings((prev) => ({
      ...prev,
      zoom: 1.0,
      panX: 0.0,
      panY: 0.0,
    }));
  }, []);

  const toggleKnownObject = useCallback((objectId: string) => {
    setRenderSettings((prev) => ({
      ...prev,
      checkedObjectIds: toggleObjectId(prev.checkedObjectIds, objectId),
    }));
  }, []);

  const checkAllKnownObjects = useCallback(() => {
    setRenderSettings((prev) => ({
      ...prev,
      checkedObjectIds: selectAllObjectIds(knownObjects),
    }));
  }, [knownObjects]);

  const uncheckAllKnownObjects = useCallback(() => {
    setRenderSettings((prev) => ({
      ...prev,
      checkedObjectIds: clearCheckedObjectIds(),
    }));
  }, []);

  const resetDefaultKnownObjects = useCallback(() => {
    setRenderSettings((prev) => ({
      ...prev,
      checkedObjectIds: getDefaultCheckedObjectIds(knownObjects),
    }));
  }, [knownObjects]);

  const removeTrackedTarget = useCallback((trackId: string) => {
    setTrackedTargets((prev) => {
      const next = prev.filter((t) => t.trackId !== trackId);
      setSelectedObject((curr) =>
        curr?.trackId === trackId ? (next[next.length - 1] ?? null) : curr,
      );
      return next;
    });
  }, []);

  const clearTrackedTargets = useCallback(() => {
    setTrackedTargets([]);
    setSelectedObject(null);
    setLastClickDiagnostic(null);
  }, []);

  // Non-looping playback timer
  useEffect(() => {
    if (!isPlaying || !manifest || manifest.epochs.length <= 1) {
      return undefined;
    }
    const intervalMs = Math.max(100, Math.round(1000 / Math.max(0.5, fps)));
    const timer = window.setInterval(() => {
      setRenderSettings((prev) => {
        const lastIdx = manifest.epochs.length - 1;
        if (prev.activeEpochIndex < lastIdx) {
          return { ...prev, activeEpochIndex: prev.activeEpochIndex + 1 };
        }
        if (isLooping) {
          return { ...prev, activeEpochIndex: 0 };
        }
        setIsPlaying(false);
        return prev;
      });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [isPlaying, isLooping, fps, manifest]);

  const play = useCallback(() => {
    setRenderSettings((prev) => {
      const total = manifest?.epochs.length ?? 0;
      if (total > 1 && prev.activeEpochIndex >= total - 1) {
        return { ...prev, activeEpochIndex: 0 };
      }
      return prev;
    });
    setIsPlaying(true);
  }, [manifest]);

  const pause = useCallback(() => setIsPlaying(false), []);

  const stepForward = useCallback(() => {
    setIsPlaying(false);
    setRenderSettings((prev) => {
      const total = manifest?.epochs.length ?? 1;
      return {
        ...prev,
        activeEpochIndex: Math.min(total - 1, prev.activeEpochIndex + 1),
      };
    });
  }, [manifest]);

  const stepBackward = useCallback(() => {
    setIsPlaying(false);
    setRenderSettings((prev) => ({
      ...prev,
      activeEpochIndex: Math.max(0, prev.activeEpochIndex - 1),
    }));
  }, []);

  const toggleLoop = useCallback(() => setIsLooping((prev) => !prev), []);

  const loadPresetBundle = useCallback(async (slug: string) => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const cacheKey = `preset:${slug}`;
    const cached = await defaultClientPatchCache.getPatch(cacheKey);
    if (cached) {
      setManifest(cached.manifest);
      setEpochBuffers(cached.epochBuffers);
      setFlagsBuffers(cached.flagsBuffers);
      setActiveSpectrum(cached.spectrum ?? null);
      setCoordinates({
        ra: cached.manifest.query.ra,
        dec: cached.manifest.query.dec,
        fovArcmin: cached.manifest.query.fov_arcmin,
      });
      setRenderSettings((prev) => ({
        ...prev,
        activeEpochIndex: 0,
        zoom: 1.0,
        panX: 0.0,
        panY: 0.0,
        checkedObjectIds: getDefaultCheckedObjectIds(
          cached.manifest.catalog_overlays.known_objects ?? [],
        ),
      }));
      setSelectedObject(null);
      setTrackedTargets([]);
      setLastClickDiagnostic(null);
      setLoadingState({ stage: 'ready', fromClientCache: true });
      return;
    }

    try {
      setLoadingState({ stage: 'loading_cutouts', message: `Loading preset ${slug}...` });
      const manifestRes = await fetch(`/presets/${slug}/manifest.json`, {
        signal: controller.signal,
      });
      if (!manifestRes.ok) {
        throw new Error(`Failed to load preset manifest (${manifestRes.status})`);
      }
      const loadedManifest = (await manifestRes.json()) as SkyPatchManifest;

      const decodedEpochs: Float32Array[][] = [];
      const decodedFlags: Uint8Array[] = [];

      for (const ep of loadedManifest.epochs) {
        const [detRes, flagRes] = await Promise.all([
          fetch(ep.detectors_data_url, { signal: controller.signal }),
          fetch(ep.flags_mask_url, { signal: controller.signal }),
        ]);
        const detBuf = await detRes.arrayBuffer();
        const flagBuf = await flagRes.arrayBuffer();
        const headerDtype = (detRes.headers.get('X-Binary-Dtype') ||
          ep.binary_dtype ||
          'float32') as BinaryDtype;
        decodedEpochs.push(decodeDetectorBinaryBuffer(detBuf, headerDtype));
        decodedFlags.push(decodeFlagsBinaryBuffer(flagBuf));
      }

      let loadedSpectrum: SpectrumPayload | null = null;
      if (loadedManifest.default_spectrum_url) {
        const specRes = await fetch(loadedManifest.default_spectrum_url, {
          signal: controller.signal,
        });
        if (specRes.ok) {
          loadedSpectrum = (await specRes.json()) as SpectrumPayload;
        }
      }

      await defaultClientPatchCache.putPatch({
        cacheKey,
        manifest: loadedManifest,
        epochBuffers: decodedEpochs,
        flagsBuffers: decodedFlags,
        spectrum: loadedSpectrum,
        storedAt: Date.now(),
        lastAccessed: Date.now(),
      });

      setManifest(loadedManifest);
      setEpochBuffers(decodedEpochs);
      setFlagsBuffers(decodedFlags);
      setActiveSpectrum(loadedSpectrum);
      setCoordinates({
        ra: loadedManifest.query.ra,
        dec: loadedManifest.query.dec,
        fovArcmin: loadedManifest.query.fov_arcmin,
      });
      setRenderSettings((prev) => ({
        ...prev,
        activeEpochIndex: 0,
        zoom: 1.0,
        panX: 0.0,
        panY: 0.0,
        checkedObjectIds: getDefaultCheckedObjectIds(
          loadedManifest.catalog_overlays.known_objects ?? [],
        ),
      }));
      setSelectedObject(null);
      setTrackedTargets([]);
      setLastClickDiagnostic(null);
      setLoadingState({ stage: 'ready', fromClientCache: false });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setLoadingState({
        stage: 'error',
        message: err instanceof Error ? err.message : 'Unknown error loading preset',
      });
    }
  }, []);

  const selectPreset = useCallback(
    (slug: string) => {
      setIsPlaying(false);
      setActivePresetSlug(slug);
      void loadPresetBundle(slug);
    },
    [loadPresetBundle],
  );

  const loadLiveCoordinates = useCallback(async (ra: number, dec: number, fovArcmin: number) => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const gridKey = computeGridKey(ra, dec, fovArcmin);
    const cached = await defaultClientPatchCache.getPatch(gridKey);
    if (cached) {
      setManifest(cached.manifest);
      setEpochBuffers(cached.epochBuffers);
      setFlagsBuffers(cached.flagsBuffers);
      setActiveSpectrum(cached.spectrum ?? null);
      setRenderSettings((prev) => ({
        ...prev,
        activeEpochIndex: 0,
        zoom: 1.0,
        panX: 0.0,
        panY: 0.0,
        checkedObjectIds: getDefaultCheckedObjectIds(
          cached.manifest.catalog_overlays.known_objects ?? [],
        ),
      }));
      setSelectedObject(null);
      setTrackedTargets([]);
      setLastClickDiagnostic(null);
      setLoadingState({ stage: 'ready', fromClientCache: true });
      return;
    }

    try {
      setLoadingState({
        stage: 'loading_catalogs',
        message: `Querying known celestial objects at (${ra.toFixed(2)}, ${dec.toFixed(2)})...`,
      });
      const qs = `ra=${encodeURIComponent(ra)}&dec=${encodeURIComponent(dec)}&fov=${encodeURIComponent(fovArcmin)}`;

      // Stage A (fast async catalogs) and Stage B (cutout manifest) run concurrently
      const catalogsPromise = fetch(`/api/v1/catalogs?${qs}`, {
        signal: controller.signal,
      }).then(async (res) => {
        if (!res.ok) return null;
        const catData = (await res.json()) as CatalogsResponse;
        await defaultClientPatchCache.putCatalogs(gridKey, catData);
        setRenderSettings((prev) => ({
          ...prev,
          checkedObjectIds: getDefaultCheckedObjectIds(
            catData.catalog_overlays.known_objects ?? [],
          ),
        }));
        setLoadingState({
          stage: 'loading_cutouts',
          message: 'Known objects loaded; streaming 3G-compressed epoch frames...',
        });
        return catData;
      });

      const patchRes = await fetch(`/api/v1/sky-patch?${qs}`, {
        signal: controller.signal,
      });
      if (!patchRes.ok) {
        throw new Error(`Failed to load sky patch (${patchRes.status})`);
      }
      const loadedManifest = (await patchRes.json()) as SkyPatchManifest;
      await catalogsPromise;

      const decodedEpochs: Float32Array[][] = [];
      const decodedFlags: Uint8Array[] = [];

      for (const ep of loadedManifest.epochs) {
        const detUrl = ep.detectors_data_url.includes('?')
          ? ep.detectors_data_url
          : `${ep.detectors_data_url}?precision=float16`;
        const [detRes, flagRes] = await Promise.all([
          fetch(detUrl, { signal: controller.signal }),
          fetch(ep.flags_mask_url, { signal: controller.signal }),
        ]);
        const detBuf = await detRes.arrayBuffer();
        const flagBuf = await flagRes.arrayBuffer();
        const headerDtype = (detRes.headers.get('X-Binary-Dtype') ||
          ep.binary_dtype ||
          'float16') as BinaryDtype;
        decodedEpochs.push(decodeDetectorBinaryBuffer(detBuf, headerDtype));
        decodedFlags.push(decodeFlagsBinaryBuffer(flagBuf));
      }

      let loadedSpectrum: SpectrumPayload | null = null;
      if (loadedManifest.default_spectrum_url) {
        const specRes = await fetch(loadedManifest.default_spectrum_url, {
          signal: controller.signal,
        });
        if (specRes.ok) {
          loadedSpectrum = (await specRes.json()) as SpectrumPayload;
        }
      }

      await defaultClientPatchCache.putPatch({
        cacheKey: gridKey,
        manifest: loadedManifest,
        epochBuffers: decodedEpochs,
        flagsBuffers: decodedFlags,
        spectrum: loadedSpectrum,
        storedAt: Date.now(),
        lastAccessed: Date.now(),
      });

      setManifest(loadedManifest);
      setEpochBuffers(decodedEpochs);
      setFlagsBuffers(decodedFlags);
      setActiveSpectrum(loadedSpectrum);
      setRenderSettings((prev) => ({
        ...prev,
        activeEpochIndex: 0,
        zoom: 1.0,
        panX: 0.0,
        panY: 0.0,
        checkedObjectIds: getDefaultCheckedObjectIds(
          loadedManifest.catalog_overlays.known_objects ?? [],
        ),
      }));
      setSelectedObject(null);
      setTrackedTargets([]);
      setLastClickDiagnostic(null);
      setLoadingState({ stage: 'ready', fromClientCache: false });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setLoadingState({
        stage: 'error',
        message: err instanceof Error ? err.message : 'Unknown error loading sky patch',
      });
    }
  }, []);

  const navigateToCoordinates = useCallback(
    (ra: number, dec: number, fovArcmin: number = 5.0) => {
      setIsPlaying(false);
      setActivePresetSlug(null);
      setCoordinates({ ra, dec, fovArcmin });
      void loadLiveCoordinates(ra, dec, fovArcmin);
    },
    [loadLiveCoordinates],
  );

  const inspectPixelOrCoord = useCallback(
    (x: number, y: number, originEpochIndex?: number) => {
      if (!manifest || !epochBuffers || epochBuffers.length === 0) return;
      const originIdx = originEpochIndex ?? renderSettings.activeEpochIndex;
      setTrackedTargets((prevTargets) => {
        const result = detectAndTrackBodiesAtClick({
          clickX: x,
          clickY: y,
          originEpochIndex: originIdx,
          epochBuffers,
          manifest,
          wavelengthRangeUm: renderSettings.wavelengthRangeUm,
          colorIndexOffset: prevTargets.length,
        });

        setLastClickDiagnostic({
          clickX: x,
          clickY: y,
          epochIndex: originIdx,
          status: result.status,
          message: result.message,
          tracksAdded: result.tracks.length,
        });

        if (result.status === 'no_body_found' || result.tracks.length === 0) {
          return prevTargets;
        }

        setSelectedObject(result.tracks[0]);
        setIsSpectrumLoading(false);

        // Append newly detected tracks (avoiding duplicate groupId if clicking the exact same spot)
        const incomingGroupId = result.tracks[0].groupId;
        const filteredPrev = prevTargets.filter((t) => t.groupId !== incomingGroupId);
        return [...filteredPrev, ...result.tracks];
      });
    },
    [manifest, epochBuffers, renderSettings.activeEpochIndex, renderSettings.wavelengthRangeUm],
  );

  const value: SkyExplorerContextValue = useMemo(
    () => ({
      activePresetSlug,
      coordinates,
      manifest,
      epochBuffers,
      flagsBuffers,
      loadingState,
      renderSettings,
      updateRenderSettings,
      setViewportZoomPan,
      resetViewportZoomPan,
      knownObjects,
      toggleKnownObject,
      checkAllKnownObjects,
      uncheckAllKnownObjects,
      resetDefaultKnownObjects,
      playback: {
        isPlaying,
        isLooping,
        fps,
        play,
        pause,
        stepForward,
        stepBackward,
        toggleLoop,
        setFps,
      },
      selectedObject,
      trackedTargets,
      lastClickDiagnostic,
      removeTrackedTarget,
      clearTrackedTargets,
      activeSpectrum,
      isSpectrumLoading,
      selectPreset,
      navigateToCoordinates,
      inspectPixelOrCoord,
    }),
    [
      activePresetSlug,
      coordinates,
      manifest,
      epochBuffers,
      flagsBuffers,
      loadingState,
      renderSettings,
      updateRenderSettings,
      setViewportZoomPan,
      resetViewportZoomPan,
      knownObjects,
      toggleKnownObject,
      checkAllKnownObjects,
      uncheckAllKnownObjects,
      resetDefaultKnownObjects,
      isPlaying,
      isLooping,
      fps,
      play,
      pause,
      stepForward,
      stepBackward,
      toggleLoop,
      selectedObject,
      trackedTargets,
      lastClickDiagnostic,
      removeTrackedTarget,
      clearTrackedTargets,
      activeSpectrum,
      isSpectrumLoading,
      selectPreset,
      navigateToCoordinates,
      inspectPixelOrCoord,
    ],
  );

  return <SkyExplorerContext.Provider value={value}>{children}</SkyExplorerContext.Provider>;
};

export function useSkyExplorer(): SkyExplorerContextValue {
  const ctx = useContext(SkyExplorerContext);
  if (!ctx) {
    throw new Error('useSkyExplorer must be used inside a SkyExplorerProvider');
  }
  return ctx;
}