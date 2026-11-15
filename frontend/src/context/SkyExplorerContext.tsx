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
  assignDeterministicHighlighterColors,
  clearCheckedObjectIds,
  extractAvailableMissions,
  pickNearestAllowedEpoch,
  resolveFilteredEpochIndices,
  selectAllObjectIds,
  toggleObjectId,
} from '../utils/knownObjectSelection';
import { observatoryLogger } from '../utils/observatoryLogger';
import { useBlinkerPlayback } from '../hooks/useBlinkerPlayback';
import { useObservatoryWarmup } from '../hooks/useObservatoryWarmup';
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

/**
 * Root React context provider coordinating 3D sky globe state, progressive
 * two-stage patch loading, client-side pixel rendering parameters, click-to-track
 * targets, and 102-band SPHEREx spectrum inspection.
 *
 * @param props - Provider props containing descendant React nodes.
 * @returns Context provider element wrapping the application tree.
 */
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
  const [selectedObject, setSelectedObject] = useState<TracedObjectSummary | null>(null);
  const [trackedTargets, setTrackedTargets] = useState<TracedObjectSummary[]>([]);
  const [lastClickDiagnostic, setLastClickDiagnostic] = useState<ClickDiagnosticInfo | null>(null);
  const [activeSpectrum, setActiveSpectrum] = useState<SpectrumPayload | null>(null);
  const [isSpectrumLoading, setIsSpectrumLoading] = useState<boolean>(false);
  const [globalKnownObjects, setGlobalKnownObjects] = useState<GlobalKnownObjectEntry[]>([]);
  const [stageAKnownObjects, setStageAKnownObjects] = useState<KnownCelestialObject[] | null>(null);
  const [objectHighlighterColors, setObjectHighlighterColors] = useState<Record<string, string>>(
    {},
  );

  const [isBlinkerModalOpen, setIsBlinkerModalOpen] = useState<boolean>(false);
  const [isSpectraModalOpen, setIsSpectraModalOpen] = useState<boolean>(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingFocusObjectIdRef = useRef<string | null>(null);

  const knownObjects: KnownCelestialObject[] = useMemo(
    () => stageAKnownObjects ?? manifest?.catalog_overlays?.known_objects ?? [],
    [stageAKnownObjects, manifest],
  );

  useObservatoryWarmup(setGlobalKnownObjects);

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

  const { isPlaying, isLooping, fps, setFps, play, pause, stepForward, stepBackward, toggleLoop } =
    useBlinkerPlayback({
      manifest,
      activeEpochIndex: renderSettings.activeEpochIndex,
      filteredEpochIndices,
      setRenderSettings,
    });

  /**
   * Apply a decoded Stage B patch bundle (manifest, detector planes, hygiene flags,
   * and optional spectrum) to context state and reset viewport/tracking overlays.
   *
   * @param result - Decoded sky patch payload from {@link loadPresetPatchFlow} or {@link loadLiveCoordinatesFlow}.
   * @param syncCoordinatesFromManifest - Whether to overwrite active sky coordinates from the manifest.
   * @param preserveStageAColors - Whether to retain existing Stage A `object_id -> color` mappings.
   */
  const applyLoadedPatch = useCallback(
    (
      result: LoadedPatchResult,
      syncCoordinatesFromManifest: boolean,
      preserveStageAColors: boolean,
    ) => {
      const nextKnownObjects = result.manifest.catalog_overlays.known_objects ?? [];
      setStageAKnownObjects(null);
      setObjectHighlighterColors((prev) =>
        assignDeterministicHighlighterColors(nextKnownObjects, preserveStageAColors ? prev : {}),
      );
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
        checkedObjectIds: getDefaultCheckedObjectIds(nextKnownObjects),
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

  /**
   * Shared abortable patch-load runner coordinating `AbortController` cancellation,
   * task indicator lifecycle, optional state reset, and non-abort error reporting.
   *
   * @param options - Task labels, logging callbacks, reset flag, and abortable execution body.
   * @returns Promise that settles once the load completes, aborts, or reports an error.
   */
  const runPatchLoad = useCallback(
    async (options: {
      taskMessage: string;
      errorTitle: string;
      fallbackErrorMessage: string;
      resetCurrentPatch?: boolean;
      logStart: () => void;
      logError: (errorMessage: string) => void;
      execute: (signal: AbortSignal) => Promise<void>;
    }) => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      setStageAKnownObjects(null);
      if (options.resetCurrentPatch) {
        setObjectHighlighterColors({});
        setManifest(null);
        setEpochBuffers(null);
        setFlagsBuffers(null);
        setSelectedObject(null);
        setTrackedTargets([]);
        setLastClickDiagnostic(null);
      }
      options.logStart();
      notificationsRef.current?.startAsyncTask('sky-patch-load', options.taskMessage, 'progress');

      try {
        await options.execute(controller.signal);
      } catch (err) {
        if ((err as { name?: string } | null)?.name === 'AbortError' || controller.signal.aborted) {
          return;
        }
        notificationsRef.current?.finishAsyncTask('sky-patch-load');
        const msg = err instanceof Error ? err.message : options.fallbackErrorMessage;
        options.logError(msg);
        setLoadingState({ stage: 'error', message: msg });
        notificationsRef.current?.pushWarning({
          id: 'patch-load-error',
          title: options.errorTitle,
          detail: msg,
          level: 'error',
        });
      }
    },
    [],
  );

  const loadPresetBundle = useCallback(
    async (slug: string) => {
      await runPatchLoad({
        taskMessage: 'Loading target frames...',
        errorTitle: 'Failed to load preset patch',
        fallbackErrorMessage: 'Unknown error loading preset',
        logStart: () =>
          observatoryLogger.info('patch', 'Loading benchmark preset bundle', { slug }),
        logError: (error) =>
          observatoryLogger.error('patch', 'Preset bundle load failed', { slug, error }),
        execute: async (signal) => {
          await loadPresetPatchFlow(slug, {
            cache: defaultClientPatchCache,
            signal,
            onStageChange: setLoadingState,
            onReady: (result) => applyLoadedPatch(result, true, false),
          });
        },
      });
    },
    [applyLoadedPatch, runPatchLoad],
  );

  const selectPreset = useCallback(
    (slug: string) => {
      pause();
      setActivePresetSlug(slug);
      setIsSpectraModalOpen(false);
      void loadPresetBundle(slug);
    },
    [loadPresetBundle, pause],
  );

  const loadLiveCoordinates = useCallback(
    async (ra: number, dec: number, fovArcmin: number) => {
      await runPatchLoad({
        taskMessage: 'Streaming epoch frames...',
        errorTitle: 'Sky patch stream interrupted',
        fallbackErrorMessage: 'Unknown error loading sky patch',
        resetCurrentPatch: true,
        logStart: () =>
          observatoryLogger.info('patch', 'Loading live sky patch', { ra, dec, fovArcmin }),
        logError: (error) =>
          observatoryLogger.error('patch', 'Live sky patch stream interrupted', {
            ra,
            dec,
            error,
          }),
        execute: async (signal) => {
          await loadLiveCoordinatesFlow(ra, dec, fovArcmin, {
            cache: defaultClientPatchCache,
            signal,
            onStageChange: setLoadingState,
            onCatalogsReady: (catData: CatalogsResponse) => {
              const stageAObjects = catData.catalog_overlays.known_objects ?? [];
              observatoryLogger.info('catalogs', 'Known objects loaded for patch', {
                count: stageAObjects.length,
                ra,
                dec,
              });
              setStageAKnownObjects(stageAObjects);
              setObjectHighlighterColors(assignDeterministicHighlighterColors(stageAObjects, {}));
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
            onReady: (result) => applyLoadedPatch(result, false, true),
          });
        },
      });
    },
    [applyLoadedPatch, runPatchLoad],
  );

  const navigateToCoordinates = useCallback(
    (ra: number, dec: number, fovArcmin = 5.0) => {
      pause();
      setActivePresetSlug(null);
      setIsSpectraModalOpen(false);
      setCoordinates({ ra, dec, fovArcmin });
      void loadLiveCoordinates(ra, dec, fovArcmin);
    },
    [loadLiveCoordinates, pause],
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
    pause();
    setIsSpectraModalOpen(false);
    setIsBlinkerModalOpen(false);
    observatoryLogger.info('blinker', 'Blinker modal closed');
  }, [pause]);

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
      setFps,
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

/**
 * Access the nearest {@link SkyExplorerProvider} context value.
 *
 * @returns Active {@link SkyExplorerContextValue}.
 * @throws {Error} When invoked outside a {@link SkyExplorerProvider}.
 */
export function useSkyExplorer(): SkyExplorerContextValue {
  const ctx = useContext(SkyExplorerContext);
  if (!ctx) {
    throw new Error('useSkyExplorer must be used inside a SkyExplorerProvider');
  }
  return ctx;
}
