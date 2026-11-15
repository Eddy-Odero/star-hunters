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
  type MissionName,
  type SkyExplorerContextValue,
  type SkyPatchManifest,
  type SkyViewportFrustum,
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
import { BENCHMARK_TARGET_OPTIONS } from '../utils/observatoryMath';
import { useOptionalNotifications } from './NotificationContext';

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

const ALL_MISSIONS: MissionName[] = ['SPHEREx', 'WISE', 'NEOSSat'];

const SkyExplorerContext = createContext<SkyExplorerContextValue | null>(null);

export const SkyExplorerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const notifications = useOptionalNotifications();

  const [activePresetSlug, setActivePresetSlug] = useState<string | null>('wise_0855');
  const [coordinates, setCoordinates] = useState<{
    ra: number;
    dec: number;
    fovArcmin: number;
  }>({
    ra: 133.7951,
    dec: -7.2451,
    fovArcmin: 5.0,
  });
  const [skyFrustum, setSkyFrustum] = useState<SkyViewportFrustum>({
    ra: 133.7951,
    dec: -7.2451,
    fovDeg: 70,
    aspect: 1.4,
  });
  const [globeFocusRequest, setGlobeFocusRequest] = useState<{
    ra: number;
    dec: number;
    fovDeg: number;
    seq: number;
  } | null>(null);

  const [manifest, setManifest] = useState<SkyPatchManifest | null>(null);
  const [epochBuffers, setEpochBuffers] = useState<Float32Array[][] | null>(null);
  const [flagsBuffers, setFlagsBuffers] = useState<Uint8Array[] | null>(null);
  const [loadingState, setLoadingState] = useState<SkyExplorerContextValue['loadingState']>({
    stage: 'idle',
  });
  const [renderSettings, setRenderSettings] =
    useState<ViewportRenderSettings>(INITIAL_RENDER_SETTINGS);
  const [activeMissions, setActiveMissions] = useState<MissionName[]>(ALL_MISSIONS);
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

  const [isBlinkerModalOpen, setIsBlinkerModalOpen] = useState<boolean>(false);
  const [isSpectraModalOpen, setIsSpectraModalOpen] = useState<boolean>(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingFocusObjectIdRef = useRef<string | null>(null);

  const knownObjects: KnownCelestialObject[] = useMemo(
    () => stageAKnownObjects ?? manifest?.catalog_overlays?.known_objects ?? [],
    [stageAKnownObjects, manifest],
  );

  // Assign distinct highlighter colors from the palette for every object in the active patch
  const objectHighlighterColors: Record<string, string> = useMemo(() => {
    if (knownObjects.length === 0) return {};
    const palette = pickDistinctHighlighterColors(knownObjects.length);
    const map: Record<string, string> = {};
    knownObjects.forEach((obj, idx) => {
      map[obj.object_id] = palette[idx];
    });
    return map;
  }, [knownObjects]);

  // Pre-emptively wake up backend and warm global catalog index on mount
  useEffect(() => {
    let cancelled = false;

    const wakeHealthAndGlobalCatalog = async () => {
      // Wake scale-to-zero Fly.io backend quietly
      fetch('/health').catch(() => undefined);

      try {
        const res = await fetch('/presets/global_known_objects.json');
        if (res.ok) {
          const payload = (await res.json()) as GlobalKnownObjectEntry[];
          if (!cancelled && Array.isArray(payload) && payload.length > 0) {
            setGlobalKnownObjects(payload);
            return;
          }
        }
      } catch {
        // Fallback below
      }

      try {
        const apiRes = await fetch('/api/v1/catalogs/search?limit=200');
        if (apiRes.ok) {
          const apiData = (await apiRes.json()) as { results?: GlobalKnownObjectEntry[] };
          if (!cancelled && Array.isArray(apiData.results)) {
            setGlobalKnownObjects(apiData.results);
          }
        }
      } catch {
        // Ignore offline startup failures
      }
    };

    void wakeHealthAndGlobalCatalog();
    return () => {
      cancelled = true;
    };
  }, []);

  // Pre-fetch the 5 mandatory benchmark targets + Comet 3I/ATLAS sequentially behind curtain
  useEffect(() => {
    let cancelled = false;
    const warmupController = new AbortController();

    const prewarmBenchmarks = async () => {
      for (const target of BENCHMARK_TARGET_OPTIONS) {
        if (cancelled) return;
        try {
          await loadPresetPatchFlow(target.slug, {
            cache: defaultClientPatchCache,
            signal: warmupController.signal,
            onStageChange: () => undefined,
            onReady: () => undefined,
          });
        } catch {
          // Warmup skips individual failures silently so user navigation stays unaffected
        }
      }
    };

    void prewarmBenchmarks();
    return () => {
      cancelled = true;
      warmupController.abort();
    };
  }, []);

  const requestGlobeFocus = useCallback((ra: number, dec: number, fovDeg = 2.0) => {
    setGlobeFocusRequest((prev) => ({
      ra,
      dec,
      fovDeg,
      seq: (prev?.seq ?? 0) + 1,
    }));
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

  // Warn via top-center Frame 32 alert if Subtract mode mixes distinct missions
  useEffect(() => {
    if (!isBlinkerModalOpen || !manifest || renderSettings.mode !== 'subtract') {
      return;
    }
    const epochA = manifest.epochs[renderSettings.passAIndex];
    const epochB = manifest.epochs[renderSettings.passBIndex];
    if (epochA && epochB && epochA.mission !== epochB.mission) {
      notifications?.pushWarning({
        id: 'cross-mission-subtract',
        title: `Cross-mission subtraction (${epochA.mission} vs ${epochB.mission})`,
        detail: 'Subtraction requires two calibrated passes from the same mission instrument.',
        level: 'warning',
      });
    }
  }, [
    isBlinkerModalOpen,
    manifest,
    notifications,
    renderSettings.mode,
    renderSettings.passAIndex,
    renderSettings.passBIndex,
  ]);

  const toggleMissionFilter = useCallback(
    (mission: MissionName) => {
      setActiveMissions((prev) => {
        const exists = prev.includes(mission);
        if (exists && prev.length <= 1) {
          notifications?.pushWarning({
            id: 'mission-filter-empty',
            title: 'At least one mission source must stay enabled',
            level: 'warning',
          });
          return prev;
        }
        return exists ? prev.filter((m) => m !== mission) : [...prev, mission];
      });
    },
    [notifications],
  );

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

  const untrackObjectById = useCallback((objectId: string) => {
    setTrackedTargets((prev) => {
      const next = prev.filter((t) => t.matchedObjectId !== objectId);
      setSelectedObject((curr) =>
        curr?.matchedObjectId === objectId ? (next[next.length - 1] ?? null) : curr,
      );
      return next;
    });
  }, []);

  const clearTrackedTargets = useCallback(() => {
    setTrackedTargets([]);
    setSelectedObject(null);
    setLastClickDiagnostic(null);
  }, []);

  // Mission-aware non-looping playback timer
  const filteredEpochIndices = useMemo(() => {
    if (!manifest) return [];
    const indices: number[] = [];
    manifest.epochs.forEach((ep, idx) => {
      if (activeMissions.includes(ep.mission)) {
        indices.push(idx);
      }
    });
    return indices.length > 0 ? indices : manifest.epochs.map((_, idx) => idx);
  }, [manifest, activeMissions]);

  useEffect(() => {
    if (!isPlaying || !manifest || filteredEpochIndices.length <= 1) {
      return undefined;
    }
    const intervalMs = Math.max(100, Math.round(1000 / Math.max(0.5, fps)));
    const timer = window.setInterval(() => {
      setRenderSettings((prev) => {
        const pos = filteredEpochIndices.indexOf(prev.activeEpochIndex);
        if (pos >= 0 && pos < filteredEpochIndices.length - 1) {
          return { ...prev, activeEpochIndex: filteredEpochIndices[pos + 1] };
        }
        if (pos === -1) {
          return { ...prev, activeEpochIndex: filteredEpochIndices[0] };
        }
        if (isLooping) {
          return { ...prev, activeEpochIndex: filteredEpochIndices[0] };
        }
        setIsPlaying(false);
        return prev;
      });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [isPlaying, isLooping, fps, manifest, filteredEpochIndices]);

  const play = useCallback(() => {
    if (filteredEpochIndices.length === 0) return;
    setRenderSettings((prev) => {
      const lastValid = filteredEpochIndices[filteredEpochIndices.length - 1];
      if (
        !filteredEpochIndices.includes(prev.activeEpochIndex) ||
        prev.activeEpochIndex === lastValid
      ) {
        return { ...prev, activeEpochIndex: filteredEpochIndices[0] };
      }
      return prev;
    });
    setIsPlaying(true);
  }, [filteredEpochIndices]);

  const pause = useCallback(() => setIsPlaying(false), []);

  const stepForward = useCallback(() => {
    setIsPlaying(false);
    if (filteredEpochIndices.length === 0) return;
    setRenderSettings((prev) => {
      const pos = filteredEpochIndices.indexOf(prev.activeEpochIndex);
      const nextIdx =
        pos < 0
          ? filteredEpochIndices[0]
          : filteredEpochIndices[Math.min(filteredEpochIndices.length - 1, pos + 1)];
      return { ...prev, activeEpochIndex: nextIdx };
    });
  }, [filteredEpochIndices]);

  const stepBackward = useCallback(() => {
    setIsPlaying(false);
    if (filteredEpochIndices.length === 0) return;
    setRenderSettings((prev) => {
      const pos = filteredEpochIndices.indexOf(prev.activeEpochIndex);
      const prevIdx =
        pos < 0 ? filteredEpochIndices[0] : filteredEpochIndices[Math.max(0, pos - 1)];
      return { ...prev, activeEpochIndex: prevIdx };
    });
  }, [filteredEpochIndices]);

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
        passAIndex: 0,
        passBIndex: Math.max(0, result.manifest.epochs.length - 1),
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
      notifications?.finishAsyncTask('sky-patch-load');
    },
    [notifications],
  );

  const loadPresetBundle = useCallback(
    async (slug: string) => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      setStageAKnownObjects(null);
      notifications?.startAsyncTask(
        'sky-patch-load',
        `Loading ${slug.replace(/_/g, ' ')} patch...`,
      );

      try {
        await loadPresetPatchFlow(slug, {
          cache: defaultClientPatchCache,
          signal: controller.signal,
          onStageChange: setLoadingState,
          onReady: (result) => applyLoadedPatch(result, true),
        });
      } catch (err) {
        notifications?.finishAsyncTask('sky-patch-load');
        if ((err as Error).name === 'AbortError' || controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : 'Unknown error loading preset';
        setLoadingState({ stage: 'error', message: msg });
        notifications?.pushWarning({
          id: 'patch-load-error',
          title: 'Failed to load preset patch',
          detail: msg,
          level: 'error',
        });
      }
    },
    [applyLoadedPatch, notifications],
  );

  const selectPreset = useCallback(
    (slug: string) => {
      setIsPlaying(false);
      setActivePresetSlug(slug);
      setIsSpectraModalOpen(false);
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
      notifications?.startAsyncTask(
        'sky-patch-load',
        `Streaming cutouts at ${ra.toFixed(2)}°, ${dec >= 0 ? '+' : ''}${dec.toFixed(2)}°...`,
      );

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
        notifications?.finishAsyncTask('sky-patch-load');
        if ((err as Error).name === 'AbortError' || controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : 'Unknown error loading sky patch';
        setLoadingState({ stage: 'error', message: msg });
        notifications?.pushWarning({
          id: 'patch-load-error',
          title: 'Sky patch stream interrupted',
          detail: msg,
          level: 'error',
        });
      }
    },
    [applyLoadedPatch, notifications],
  );

  const navigateToCoordinates = useCallback(
    (ra: number, dec: number, fovArcmin = 5.0) => {
      setIsPlaying(false);
      setActivePresetSlug(null);
      setIsSpectraModalOpen(false);
      setCoordinates({ ra, dec, fovArcmin });
      void loadLiveCoordinates(ra, dec, fovArcmin);
    },
    [loadLiveCoordinates],
  );

  const openBlinkerModal = useCallback(
    (target?: string | { ra: number; dec: number; fovArcmin?: number }) => {
      setIsSpectraModalOpen(false);
      if (typeof target === 'string') {
        selectPreset(target);
      } else if (target && typeof target === 'object') {
        navigateToCoordinates(target.ra, target.dec, target.fovArcmin ?? 5.0);
      }
      setIsBlinkerModalOpen(true);
    },
    [navigateToCoordinates, selectPreset],
  );

  const closeBlinkerModal = useCallback(() => {
    setIsPlaying(false);
    setIsSpectraModalOpen(false);
    setIsBlinkerModalOpen(false);
    // Pull back above the 0.5° patch-entry FoV threshold to avoid immediate re-triggering
    if (skyFrustum.fovDeg < 0.65) {
      requestGlobeFocus(coordinates.ra, coordinates.dec, 1.5);
    }
  }, [coordinates.dec, coordinates.ra, requestGlobeFocus, skyFrustum.fovDeg]);

  const openSelectedSpectrum = useCallback(
    async (coords?: { ra: number; dec: number; label?: string }) => {
      setIsSpectraModalOpen(true);
      const targetRa = coords?.ra ?? selectedObject?.ra ?? coordinates.ra;
      const targetDec = coords?.dec ?? selectedObject?.dec ?? coordinates.dec;

      // Reuse already-loaded matching spectrum when clicking near patch center
      if (
        activeSpectrum &&
        Math.abs(activeSpectrum.ra - targetRa) < 0.002 &&
        Math.abs(activeSpectrum.dec - targetDec) < 0.002
      ) {
        return;
      }

      setIsSpectrumLoading(true);
      notifications?.startAsyncTask('spectrum-fetch', 'Fetching 102-band SPHEREx spectrum...');
      try {
        const params = new URLSearchParams({
          ra: targetRa.toFixed(5),
          dec: targetDec.toFixed(5),
        });
        if (coords?.label ?? selectedObject?.matchedLabel) {
          params.set('label', coords?.label ?? selectedObject?.matchedLabel ?? '');
        }
        const res = await fetch(`/api/v1/spectrum?${params.toString()}`);
        if (res.ok) {
          const payload = (await res.json()) as SpectrumPayload;
          if (payload && Array.isArray(payload.channels) && payload.channels.length > 0) {
            setActiveSpectrum(payload);
            return;
          }
        }
        throw new Error(`Spectrum endpoint returned status ${res.status}`);
      } catch (err) {
        if (!activeSpectrum) {
          notifications?.pushWarning({
            id: 'spectrum-error',
            title: '102-band spectrum unavailable',
            detail:
              err instanceof Error
                ? err.message
                : 'Backend spectrum extractor could not be reached.',
            level: 'warning',
          });
        }
      } finally {
        setIsSpectrumLoading(false);
        notifications?.finishAsyncTask('spectrum-fetch');
      }
    },
    [activeSpectrum, coordinates.dec, coordinates.ra, notifications, selectedObject],
  );

  const closeSpectraModal = useCallback(() => {
    setIsSpectraModalOpen(false);
  }, []);

  const inspectPixelOrCoord = useCallback(
    (x: number, y: number, originEpochIndex?: number) => {
      if (!epochBuffers || !manifest || epochBuffers.length === 0) return;
      const originEpoch = originEpochIndex ?? renderSettings.activeEpochIndex;

      // Second-click untrack: hitting an already-tracked target removes its Square frame
      const hitExisting = trackedTargets.find((t) => {
        const wp = t.waypoints[originEpoch] ??
          t.waypoints[t.originEpochIndex] ?? {
            x: t.originCentroidX,
            y: t.originCentroidY,
          };
        return Math.hypot(wp.x - x, wp.y - y) <= 10;
      });
      if (hitExisting) {
        removeTrackedTarget(hitExisting.trackId);
        setLastClickDiagnostic(null);
        return;
      }

      const result = detectAndTrackBodiesAtClick({
        clickX: x,
        clickY: y,
        originEpochIndex: originEpoch,
        epochBuffers,
        manifest,
        wavelengthRangeUm: renderSettings.wavelengthRangeUm,
      });

      setLastClickDiagnostic({
        clickX: x,
        clickY: y,
        epochIndex: originEpoch,
        status: result.status,
        message: result.message,
        tracksAdded: result.tracks.length,
      });

      if (result.status === 'no_body_found' || result.tracks.length === 0) {
        notifications?.pushWarning({
          id: 'no-body-clicked',
          title: 'No source detected at cursor',
          detail: result.message,
          level: 'warning',
        });
        return;
      }

      // Preserve the known object's assigned marker color when converting in-place to Square
      const colorMatchedTracks = result.tracks.map((track) => {
        if (track.matchedObjectId && objectHighlighterColors[track.matchedObjectId]) {
          return { ...track, color: objectHighlighterColors[track.matchedObjectId] };
        }
        return track;
      });

      setTrackedTargets((prev) => {
        const merged = mergeTrackedTargets(prev, colorMatchedTracks);
        const primary =
          merged.find((t) => t.groupId === colorMatchedTracks[0].groupId) ??
          merged[merged.length - 1];
        if (primary) {
          setSelectedObject(primary);
        }
        return merged;
      });
    },
    [
      epochBuffers,
      manifest,
      notifications,
      objectHighlighterColors,
      removeTrackedTarget,
      renderSettings.activeEpochIndex,
      renderSettings.wavelengthRangeUm,
      trackedTargets,
    ],
  );

  const focusAndTrackKnownObject = useCallback(
    (obj: KnownCelestialObject | GlobalKnownObjectEntry, targetSlug?: string) => {
      const resolvedSlug = targetSlug ?? (obj as GlobalKnownObjectEntry).target_slug;
      const validPresetSlug =
        resolvedSlug && !resolvedSlug.startsWith('all_sky') ? resolvedSlug : null;

      if (isBlinkerModalOpen) {
        if (validPresetSlug && validPresetSlug !== activePresetSlug) {
          pendingFocusObjectIdRef.current = obj.object_id;
          selectPreset(validPresetSlug);
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
        return;
      }

      // On the 3D globe: fly smoothly to the target coordinates
      requestGlobeFocus(obj.ra, obj.dec, 2.2);
      if (validPresetSlug) {
        selectPreset(validPresetSlug);
      } else {
        setCoordinates({ ra: obj.ra, dec: obj.dec, fovArcmin: 5.0 });
      }
    },
    [
      activePresetSlug,
      inspectPixelOrCoord,
      isBlinkerModalOpen,
      renderSettings.activeEpochIndex,
      requestGlobeFocus,
      selectPreset,
    ],
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
      activeMissions,
      toggleMissionFilter,
      skyFrustum,
      setSkyFrustum,
      isBlinkerModalOpen,
      openBlinkerModal,
      closeBlinkerModal,
      isSpectraModalOpen,
      openSelectedSpectrum,
      closeSpectraModal,
      untrackObjectById,
      globeFocusRequest,
      requestGlobeFocus,
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
      activeMissions,
      toggleMissionFilter,
      skyFrustum,
      isBlinkerModalOpen,
      openBlinkerModal,
      closeBlinkerModal,
      isSpectraModalOpen,
      openSelectedSpectrum,
      closeSpectraModal,
      untrackObjectById,
      globeFocusRequest,
      requestGlobeFocus,
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
