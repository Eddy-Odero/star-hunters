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
  extractAvailableMissions,
  pickNearestAllowedEpoch,
  resolveFilteredEpochIndices,
  selectAllObjectIds,
  toggleObjectId,
} from '../utils/knownObjectSelection';
import { BENCHMARK_TARGET_OPTIONS } from '../utils/observatoryMath';
import { observatoryLogger } from '../utils/observatoryLogger';
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

const ALL_MISSIONS: MissionName[] = [
  'SPHEREx',
  'WISE',
  'NEOSSat',
  'SkyView',
  '2MASS',
  'DSS2',
  'Horizons',
  'Simulated',
];

const SkyExplorerContext = createContext<SkyExplorerContextValue | null>(null);

export const SkyExplorerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const notifications = useOptionalNotifications();
  const notificationsRef = useRef(notifications);
  useEffect(() => {
    notificationsRef.current = notifications;
  }, [notifications]);

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
      observatoryLogger.info('warmup', 'Waking backend /health and loading global object catalog');
      fetch('/health')
        .then((res) => {
          observatoryLogger.info('warmup', 'Backend health check complete', { status: res.status });
        })
        .catch(() => {
          observatoryLogger.warn(
            'warmup',
            'Backend health ping unreachable; operating offline/cached',
          );
        });

      let baselineObjects: GlobalKnownObjectEntry[] = [];
      try {
        const res = await fetch('/presets/global_known_objects.json');
        if (res.ok) {
          const payload = (await res.json()) as GlobalKnownObjectEntry[];
          if (!cancelled && Array.isArray(payload) && payload.length > 0) {
            baselineObjects = payload;
            setGlobalKnownObjects(payload);
            observatoryLogger.info('catalogs', 'Loaded preset global known objects', {
              count: payload.length,
            });
          }
        }
      } catch {
        // Fallback below
      }

      try {
        const apiRes = await fetch('/api/v1/catalogs/search?limit=200');
        if (apiRes.ok) {
          const apiData = (await apiRes.json()) as { results?: GlobalKnownObjectEntry[] };
          if (!cancelled && Array.isArray(apiData.results) && apiData.results.length > 0) {
            setGlobalKnownObjects((prev) => {
              const byId = new Map<string, GlobalKnownObjectEntry>();
              for (const item of prev.length > 0 ? prev : baselineObjects) {
                byId.set(item.object_id, item);
              }
              for (const liveItem of apiData.results ?? []) {
                byId.set(liveItem.object_id, liveItem);
              }
              return Array.from(byId.values());
            });
            observatoryLogger.info('catalogs', 'Merged live global known objects from backend', {
              count: apiData.results.length,
            });
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
      notificationsRef.current?.pushWarning({
        id: 'cross-mission-subtract',
        title: `Cross-mission subtraction (${epochA.mission} vs ${epochB.mission})`,
        detail: 'Subtraction requires two calibrated passes from the same mission instrument.',
        level: 'warning',
      });
    }
  }, [
    isBlinkerModalOpen,
    manifest,
    renderSettings.mode,
    renderSettings.passAIndex,
    renderSettings.passBIndex,
  ]);

  const toggleMissionFilter = useCallback(
    (mission: MissionName) => {
      const exists = activeMissions.includes(mission);
      const next = exists
        ? activeMissions.filter((m) => m !== mission)
        : [...activeMissions, mission];

      if (manifest && manifest.epochs.length > 0) {
        const presentMissions = extractAvailableMissions(manifest.epochs).map((m) => m.mission);
        const remainingPresent = presentMissions.filter((m) => next.includes(m));
        if (remainingPresent.length === 0) {
          notificationsRef.current?.pushWarning({
            id: 'mission-filter-empty',
            title: 'At least one mission source in this patch must stay enabled',
            level: 'warning',
          });
          return;
        }
        const allowed = resolveFilteredEpochIndices(manifest.epochs, next);
        setActiveMissions(next);
        setRenderSettings((prev) => ({
          ...prev,
          activeEpochIndex: pickNearestAllowedEpoch(prev.activeEpochIndex, allowed),
          passAIndex: allowed[0] ?? 0,
          passBIndex: allowed[allowed.length - 1] ?? 0,
          coaddIndices: allowed,
        }));
        observatoryLogger.info('blinker', 'Mission source filter updated', {
          mission,
          enabled: !exists,
          visibleEpochs: allowed.length,
        });
        return;
      }

      if (exists && next.length === 0) {
        notificationsRef.current?.pushWarning({
          id: 'mission-filter-empty',
          title: 'At least one mission source must stay enabled',
          level: 'warning',
        });
        return;
      }
      setActiveMissions(next);
    },
    [activeMissions, manifest],
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
    return resolveFilteredEpochIndices(manifest.epochs, activeMissions);
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
      setActiveMissions(ALL_MISSIONS);
      setRenderSettings((prev) => ({
        ...prev,
        activeEpochIndex: 0,
        passAIndex: 0,
        passBIndex: Math.max(0, result.manifest.epochs.length - 1),
        coaddIndices: result.manifest.epochs.map((_, idx) => idx),
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
      notificationsRef.current?.finishAsyncTask('sky-patch-load');
      observatoryLogger.info('patch', 'Sky patch ready for blinking', {
        gridKey: result.manifest.query.grid_key,
        mission: result.manifest.data_source_summary?.primary_mission,
        epochs: result.manifest.epochs.length,
        fromClientCache: result.fromClientCache,
      });
    },
    [],
  );

  const loadPresetBundle = useCallback(
    async (slug: string) => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      setStageAKnownObjects(null);
      observatoryLogger.info('patch', 'Loading benchmark preset bundle', { slug });
      notificationsRef.current?.startAsyncTask(
        'sky-patch-load',
        'Loading target frames...',
        'progress',
      );

      try {
        await loadPresetPatchFlow(slug, {
          cache: defaultClientPatchCache,
          signal: controller.signal,
          onStageChange: setLoadingState,
          onReady: (result) => applyLoadedPatch(result, true),
        });
      } catch (err) {
        notificationsRef.current?.finishAsyncTask('sky-patch-load');
        if ((err as Error).name === 'AbortError' || controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : 'Unknown error loading preset';
        observatoryLogger.error('patch', 'Preset bundle load failed', { slug, error: msg });
        setLoadingState({ stage: 'error', message: msg });
        notificationsRef.current?.pushWarning({
          id: 'patch-load-error',
          title: 'Failed to load preset patch',
          detail: msg,
          level: 'error',
        });
      }
    },
    [applyLoadedPatch],
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
      observatoryLogger.info('patch', 'Loading live sky patch', { ra, dec, fovArcmin });
      notificationsRef.current?.startAsyncTask(
        'sky-patch-load',
        'Streaming epoch frames...',
        'progress',
      );

      try {
        await loadLiveCoordinatesFlow(ra, dec, fovArcmin, {
          cache: defaultClientPatchCache,
          signal: controller.signal,
          onStageChange: setLoadingState,
          onCatalogsReady: (catData: CatalogsResponse) => {
            const stageAObjects = catData.catalog_overlays.known_objects ?? [];
            observatoryLogger.info('catalogs', 'Known objects loaded for patch', {
              count: stageAObjects.length,
              ra,
              dec,
            });
            setStageAKnownObjects(stageAObjects);
            setRenderSettings((prev) => ({
              ...prev,
              checkedObjectIds: getDefaultCheckedObjectIds(stageAObjects),
            }));
            notificationsRef.current?.startAsyncTask(
              'sky-patch-catalogs',
              'Known objects loaded',
              'success',
              2600,
            );
            notificationsRef.current?.startAsyncTask(
              'sky-patch-load',
              'Streaming epoch frames...',
              'progress',
            );
            setLoadingState({
              stage: 'loading_cutouts',
              message: 'Streaming epoch frames...',
            });
          },
          onReady: (result) => applyLoadedPatch(result, false),
        });
      } catch (err) {
        notificationsRef.current?.finishAsyncTask('sky-patch-load');
        if ((err as Error).name === 'AbortError' || controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : 'Unknown error loading sky patch';
        observatoryLogger.error('patch', 'Live sky patch stream interrupted', {
          ra,
          dec,
          error: msg,
        });
        setLoadingState({ stage: 'error', message: msg });
        notificationsRef.current?.pushWarning({
          id: 'patch-load-error',
          title: 'Sky patch stream interrupted',
          detail: msg,
          level: 'error',
        });
      }
    },
    [applyLoadedPatch],
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
    observatoryLogger.info('blinker', 'Blinker modal closed');
  }, []);

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
      notificationsRef.current?.startAsyncTask(
        'spectrum-fetch',
        'Loading 102-band spectrum...',
        'progress',
      );
      observatoryLogger.info('spectrum', 'Fetching 102-band spectrum', {
        ra: targetRa,
        dec: targetDec,
      });
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
            observatoryLogger.info('spectrum', 'Loaded 102-band spectrum', {
              channels: payload.channels.length,
              label: payload.source_label,
            });
            return;
          }
        }
        throw new Error(`Spectrum endpoint returned status ${res.status}`);
      } catch (err) {
        observatoryLogger.warn('spectrum', 'Spectrum request failed', {
          error: err instanceof Error ? err.message : 'unavailable',
        });
        if (!activeSpectrum) {
          notificationsRef.current?.pushWarning({
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
        notificationsRef.current?.finishAsyncTask('spectrum-fetch');
      }
    },
    [activeSpectrum, coordinates.dec, coordinates.ra, selectedObject],
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
        notificationsRef.current?.pushWarning({
          id: 'no-body-clicked',
          title: 'No source detected at cursor',
          detail: result.message,
          level: 'warning',
        });
        return;
      }

      observatoryLogger.info('tracking', 'Tracked target(s) on canvas click', {
        status: result.status,
        tracksAdded: result.tracks.length,
        labels: result.tracks.map((t) => t.matchedLabel || t.groupId),
      });

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
      filteredEpochIndices,
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
      filteredEpochIndices,
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
