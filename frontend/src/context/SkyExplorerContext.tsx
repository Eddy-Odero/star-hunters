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
  detectAndTrackBodiesAtClick,
  getDefaultCheckedObjectIds,
  mergeTrackedTargets,
  pickDistinctHighlighterColors,
  type CatalogsResponse,
  type ClickDiagnosticInfo,
  type GlobalKnownObjectEntry,
  type KnownCelestialObject,
  type SkyExplorerContextValue,
  type SkyPatchManifest,
  type SpectrumPayload,
  type TracedObjectSummary,
  type ViewportRenderSettings,
} from '../types/contracts';
import { defaultClientPatchCache } from '../services/clientPatchCache';
import {
  loadLiveCoordinatesFlow,
  loadPresetPatchFlow,
  type LoadedPatchResult,
} from '../services/progressivePatchLoader';
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
  const [globalKnownObjects, setGlobalKnownObjects] = useState<GlobalKnownObjectEntry[]>([]);
  const [stageAKnownObjects, setStageAKnownObjects] = useState<KnownCelestialObject[] | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingFocusObjectIdRef = useRef<string | null>(null);

  const knownObjects: KnownCelestialObject[] = useMemo(
    () => stageAKnownObjects ?? manifest?.catalog_overlays?.known_objects ?? [],
    [stageAKnownObjects, manifest],
  );

  // Randomly assign a distinct highlighter color from the 20-color palette to each object in the patch
  const objectHighlighterColors: Record<string, string> = useMemo(() => {
    if (knownObjects.length === 0) return {};
    const palette = pickDistinctHighlighterColors(knownObjects.length);
    const map: Record<string, string> = {};
    knownObjects.forEach((obj, idx) => {
      map[obj.object_id] = palette[idx];
    });
    return map;
  }, [knownObjects]);

  // Aggressively load and cache the global known celestial objects index on mount
  useEffect(() => {
    let cancelled = false;
    const loadGlobalIndex = async () => {
      try {
        const res = await fetch('/presets/global_known_objects.json');
        if (res.ok) {
          const data = (await res.json()) as GlobalKnownObjectEntry[];
          if (!cancelled && Array.isArray(data)) {
            setGlobalKnownObjects(data);
            return;
          }
        }
      } catch {
        // Fall back to API endpoint if static bundle not served
      }
      try {
        const apiRes = await fetch('/api/v1/catalogs/search?limit=200');
        if (apiRes.ok) {
          const payload = (await apiRes.json()) as { results?: GlobalKnownObjectEntry[] };
          if (!cancelled && Array.isArray(payload.results)) {
            setGlobalKnownObjects(payload.results);
          }
        }
      } catch {
        // Ignore offline fallback errors in unit tests
      }
    };
    void loadGlobalIndex();
    return () => {
      cancelled = true;
    };
  }, []);

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

  const applyLoadedPatch = useCallback(
    (result: LoadedPatchResult, syncCoordinatesFromManifest: boolean) => {
      setStageAKnownObjects(null);
      setManifest(result.manifest);
      setEpochBuffers(result.epochBuffers);
      setFlagsBuffers(result.flagsBuffers);
      setActiveSpectrum(result.spectrum);
      if (syncCoordinatesFromManifest) {
        setCoordinates({
          ra: result.manifest.query.ra,
          dec: result.manifest.query.dec,
          fovArcmin: result.manifest.query.fov_arcmin,
        });
      }
      setRenderSettings((prev) => ({
        ...prev,
        activeEpochIndex: 0,
        zoom: 1.0,
        panX: 0.0,
        panY: 0.0,
        checkedObjectIds: getDefaultCheckedObjectIds(
          result.manifest.catalog_overlays.known_objects ?? [],
        ),
      }));
      setSelectedObject(null);
      setTrackedTargets([]);
      setLastClickDiagnostic(null);
      setLoadingState({ stage: 'ready', fromClientCache: result.fromClientCache });
    },
    [],
  );

  const loadPresetBundle = useCallback(
    async (slug: string) => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      setStageAKnownObjects(null);

      try {
        await loadPresetPatchFlow(slug, {
          cache: defaultClientPatchCache,
          signal: controller.signal,
          onStageChange: setLoadingState,
          onReady: (result) => applyLoadedPatch(result, true),
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError' || controller.signal.aborted) return;
        setLoadingState({
          stage: 'error',
          message: err instanceof Error ? err.message : 'Unknown error loading preset',
        });
      }
    },
    [applyLoadedPatch],
  );

  const selectPreset = useCallback(
    (slug: string) => {
      setIsPlaying(false);
      setActivePresetSlug(slug);
      void loadPresetBundle(slug);
    },
    [loadPresetBundle],
  );

  const loadLiveCoordinates = useCallback(
    async (ra: number, dec: number, fovArcmin: number) => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      setStageAKnownObjects(null);

      try {
        await loadLiveCoordinatesFlow(ra, dec, fovArcmin, {
          cache: defaultClientPatchCache,
          signal: controller.signal,
          onStageChange: setLoadingState,
          onCatalogsReady: (catData: CatalogsResponse) => {
            const stageAObjects = catData.catalog_overlays.known_objects ?? [];
            setStageAKnownObjects(stageAObjects);
            setRenderSettings((prev) => ({
              ...prev,
              checkedObjectIds: getDefaultCheckedObjectIds(stageAObjects),
            }));
            setLoadingState({
              stage: 'loading_cutouts',
              message: 'Known objects loaded; streaming 3G-compressed epoch frames...',
            });
          },
          onReady: (result) => applyLoadedPatch(result, false),
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError' || controller.signal.aborted) return;
        setLoadingState({
          stage: 'error',
          message: err instanceof Error ? err.message : 'Unknown error loading sky patch',
        });
      }
    },
    [applyLoadedPatch],
  );

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

        const matchedKnownIdsToAutoCheck: string[] = [];
        const enrichedTracks = result.tracks.map((track) => {
          if (!track.matchedObjectId) return track;
          matchedKnownIdsToAutoCheck.push(track.matchedObjectId);
          const matchedObj = knownObjects.find((o) => o.object_id === track.matchedObjectId);
          return {
            ...track,
            matchedLabel: matchedObj?.label ?? track.matchedLabel,
            matchedCatalog: matchedObj?.catalog ?? track.matchedCatalog,
          };
        });

        // If the user clicked a known celestial object that wasn't checked in the Known Objects list,
        // automatically turn on its tracking from the list instead of giving it an arbitrary label.
        if (matchedKnownIdsToAutoCheck.length > 0) {
          setRenderSettings((prev) => {
            const nextChecked = new Set(prev.checkedObjectIds);
            let changed = false;
            for (const id of matchedKnownIdsToAutoCheck) {
              if (!nextChecked.has(id)) {
                nextChecked.add(id);
                changed = true;
              }
            }
            return changed ? { ...prev, checkedObjectIds: Array.from(nextChecked) } : prev;
          });
        }

        // Accumulate multi-spot targets with distinct tracking-square colors.
        // Re-clicking an existing group/object replaces its old branches.
        const incomingGroupId = enrichedTracks[0].groupId;
        const nextTargets = mergeTrackedTargets(prevTargets, enrichedTracks, {
          checkedObjectIds: renderSettings.checkedObjectIds,
          objectHighlighterColors,
        });
        const selectedTrack =
          nextTargets.find((t) => t.groupId === incomingGroupId && t.branchIndex === 0) ??
          nextTargets[nextTargets.length - 1] ??
          null;
        setSelectedObject(selectedTrack);
        setIsSpectrumLoading(false);
        return nextTargets;
      });
    },
    [
      manifest,
      epochBuffers,
      knownObjects,
      objectHighlighterColors,
      renderSettings.activeEpochIndex,
      renderSettings.checkedObjectIds,
      renderSettings.wavelengthRangeUm,
    ],
  );

  const focusAndTrackKnownObject = useCallback(
    (obj: KnownCelestialObject | GlobalKnownObjectEntry, targetSlug?: string) => {
      const resolvedSlug = targetSlug ?? (obj as GlobalKnownObjectEntry).target_slug;
      if (resolvedSlug && resolvedSlug !== activePresetSlug) {
        pendingFocusObjectIdRef.current = obj.object_id;
        selectPreset(resolvedSlug);
        return;
      }

      setRenderSettings((prev) => ({
        ...prev,
        checkedObjectIds: prev.checkedObjectIds.includes(obj.object_id)
          ? prev.checkedObjectIds
          : [...prev.checkedObjectIds, obj.object_id],
      }));

      const epIdx = renderSettings.activeEpochIndex;
      const epPos = obj.epoch_positions?.[Math.min(epIdx, obj.epoch_positions.length - 1)] ?? obj;
      inspectPixelOrCoord(epPos.x, epPos.y, epIdx);
    },
    [activePresetSlug, selectPreset, renderSettings.activeEpochIndex, inspectPixelOrCoord],
  );

  // Fulfill pending focus-and-track request after switching to another showcase preset
  useEffect(() => {
    const pendingId = pendingFocusObjectIdRef.current;
    if (!pendingId || loadingState.stage !== 'ready' || !manifest || !epochBuffers) return;
    const targetObj = knownObjects.find((o) => o.object_id === pendingId);
    if (!targetObj) return;
    pendingFocusObjectIdRef.current = null;
    const epPos = targetObj.epoch_positions?.[0] ?? targetObj;
    inspectPixelOrCoord(epPos.x, epPos.y, 0);
  }, [loadingState.stage, manifest, epochBuffers, knownObjects, inspectPixelOrCoord]);

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
      objectHighlighterColors,
      globalKnownObjects,
      toggleKnownObject,
      checkAllKnownObjects,
      uncheckAllKnownObjects,
      resetDefaultKnownObjects,
      focusAndTrackKnownObject,
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
      objectHighlighterColors,
      globalKnownObjects,
      toggleKnownObject,
      checkAllKnownObjects,
      uncheckAllKnownObjects,
      resetDefaultKnownObjects,
      focusAndTrackKnownObject,
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
