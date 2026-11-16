import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useBlinkerPlayback } from '../hooks/useBlinkerPlayback';
import { useObservatoryWarmup } from '../hooks/useObservatoryWarmup';
import { usePatchLoader } from '../hooks/usePatchLoader';
import { useSpectrumInspector } from '../hooks/useSpectrumInspector';
import { useTargetTracking } from '../hooks/useTargetTracking';
import type {
  GlobalKnownObjectEntry,
  KnownCelestialObject,
  MissionName,
  SkyExplorerContextValue,
  SkyViewportFrustum,
  ViewportRenderSettings,
} from '../types/contracts';
import {
  clearCheckedObjectIds,
  extractAvailableMissions,
  getDefaultCheckedObjectIds,
  pickNearestAllowedEpoch,
  resolveFilteredEpochIndices,
  selectAllObjectIds,
  toggleObjectId,
} from '../utils/knownObjectSelection';
import { observatoryLogger } from '../utils/observatoryLogger';
import { clampViewportPanZoom } from '../utils/wcsViewport';
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

/** High-frequency 3D globe frustum & focus slice separated from patch/blinker state. */
export interface SkyFrustumContextValue {
  skyFrustum: SkyViewportFrustum;
  setSkyFrustum: (frustum: SkyViewportFrustum) => void;
  globeFocusRequest: { ra: number; dec: number; fovDeg: number; seq: number } | null;
  requestGlobeFocus: (ra: number, dec: number, fovDeg?: number) => void;
}

const SkyFrustumContext = createContext<SkyFrustumContextValue | null>(null);
const SkyExplorerContext = createContext<SkyExplorerContextValue | null>(null);

/**
 * Root React context provider coordinating 3D sky globe state, progressive
 * two-stage patch loading, client-side pixel rendering parameters, click-to-track
 * targets, and 102-band SPHEREx spectrum inspection.
 *
 * @param props - Provider props containing descendant React nodes.
 * @returns Context provider elements wrapping the application tree.
 */
export const SkyExplorerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const notifications = useOptionalNotifications();
  const notificationsRef = useRef(notifications);
  useEffect(() => {
    notificationsRef.current = notifications;
  }, [notifications]);

  const [skyFrustum, setSkyFrustum] = useState<SkyViewportFrustum>({
    ra: 133.7951,
    dec: -7.2451,
    fovDeg: 70,
    aspect: 1.4,
  });
  const skyFrustumRef = useRef<SkyViewportFrustum>(skyFrustum);
  useEffect(() => {
    skyFrustumRef.current = skyFrustum;
  }, [skyFrustum]);
  const getSkyFrustum = useCallback(() => skyFrustumRef.current, []);

  const [globeFocusRequest, setGlobeFocusRequest] = useState<{
    ra: number;
    dec: number;
    fovDeg: number;
    seq: number;
  } | null>(null);

  const [renderSettings, setRenderSettings] =
    useState<ViewportRenderSettings>(INITIAL_RENDER_SETTINGS);
  const [activeMissions, setActiveMissions] = useState<MissionName[]>(ALL_MISSIONS);
  const [globalKnownObjects, setGlobalKnownObjects] = useState<GlobalKnownObjectEntry[]>([]);
  const [isBlinkerModalOpen, setIsBlinkerModalOpen] = useState<boolean>(false);

  const pendingFocusObjectIdRef = useRef<string | null>(null);
  const patchResetBridgeRef = useRef<{
    clearTracking: () => void;
    setSpectrum: (spec: SkyExplorerContextValue['activeSpectrum']) => void;
  }>({
    clearTracking: () => undefined,
    setSpectrum: () => undefined,
  });

  useObservatoryWarmup(setGlobalKnownObjects);

  const {
    activePresetSlug,
    setActivePresetSlug,
    coordinates,
    setCoordinates,
    manifest,
    epochBuffers,
    flagsBuffers,
    loadingState,
    knownObjects,
    objectHighlighterColors,
    loadPresetBundle,
    loadLiveCoordinates,
    retryActivePatch,
  } = usePatchLoader({
    notificationsRef,
    onResetPatchDependents: () => {
      patchResetBridgeRef.current.clearTracking();
    },
    onStageACheckedIds: (defaultCheckedIds) => {
      setRenderSettings((prev) => ({
        ...prev,
        checkedObjectIds: defaultCheckedIds,
      }));
    },
    onStageBReady: (result, defaultCheckedIds) => {
      patchResetBridgeRef.current.setSpectrum(result.spectrum);
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
        checkedObjectIds: defaultCheckedIds,
      }));
      patchResetBridgeRef.current.clearTracking();
    },
  });

  const {
    selectedObject,
    trackedTargets,
    lastClickDiagnostic,
    inspectPixelOrCoord,
    removeTrackedTarget,
    untrackObjectById,
    clearTrackedTargets,
  } = useTargetTracking({
    epochBuffers,
    manifest,
    objectHighlighterColors,
    activeEpochIndex: renderSettings.activeEpochIndex,
    wavelengthRangeUm: renderSettings.wavelengthRangeUm,
    notificationsRef,
  });

  const {
    activeSpectrum,
    setActiveSpectrum,
    isSpectrumLoading,
    isSpectraModalOpen,
    setIsSpectraModalOpen,
    openSelectedSpectrum,
    closeSpectraModal,
  } = useSpectrumInspector({
    coordinates,
    selectedObject,
    notificationsRef,
  });

  useEffect(() => {
    patchResetBridgeRef.current = {
      clearTracking: clearTrackedTargets,
      setSpectrum: setActiveSpectrum,
    };
  }, [clearTrackedTargets, setActiveSpectrum]);

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

  const playbackValue = useMemo(
    () => ({
      isPlaying,
      isLooping,
      fps,
      play,
      pause,
      stepForward,
      stepBackward,
      toggleLoop,
      setFps,
    }),
    [fps, isLooping, isPlaying, pause, play, setFps, stepBackward, stepForward, toggleLoop],
  );

  const selectPreset = useCallback(
    (slug: string) => {
      pause();
      setActivePresetSlug(slug);
      setIsSpectraModalOpen(false);
      void loadPresetBundle(slug);
    },
    [loadPresetBundle, pause, setActivePresetSlug, setIsSpectraModalOpen],
  );

  const navigateToCoordinates = useCallback(
    (ra: number, dec: number, fovArcmin = 5.0) => {
      pause();
      setActivePresetSlug(null);
      setIsSpectraModalOpen(false);
      setCoordinates({ ra, dec, fovArcmin });
      void loadLiveCoordinates(ra, dec, fovArcmin);
    },
    [loadLiveCoordinates, pause, setActivePresetSlug, setCoordinates, setIsSpectraModalOpen],
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
    [navigateToCoordinates, selectPreset, setIsSpectraModalOpen],
  );

  const closeBlinkerModal = useCallback(() => {
    pause();
    setIsSpectraModalOpen(false);
    setIsBlinkerModalOpen(false);
    observatoryLogger.info('blinker', 'Blinker modal closed');
  }, [pause, setIsSpectraModalOpen]);

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
      setCoordinates,
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

  const frustumValue = useMemo<SkyFrustumContextValue>(
    () => ({
      skyFrustum,
      setSkyFrustum,
      globeFocusRequest,
      requestGlobeFocus,
    }),
    [globeFocusRequest, requestGlobeFocus, skyFrustum],
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
      objectHighlighterColors,
      globalKnownObjects,
      toggleKnownObject,
      checkAllKnownObjects,
      uncheckAllKnownObjects,
      resetDefaultKnownObjects,
      focusAndTrackKnownObject,
      playback: playbackValue,
      selectedObject,
      trackedTargets,
      lastClickDiagnostic,
      removeTrackedTarget,
      clearTrackedTargets,
      activeSpectrum,
      isSpectrumLoading,
      selectPreset,
      navigateToCoordinates,
      retryActivePatch,
      inspectPixelOrCoord,
      activeMissions,
      filteredEpochIndices,
      toggleMissionFilter,
      getSkyFrustum,
      isBlinkerModalOpen,
      openBlinkerModal,
      closeBlinkerModal,
      isSpectraModalOpen,
      openSelectedSpectrum,
      closeSpectraModal,
      untrackObjectById,
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
      playbackValue,
      selectedObject,
      trackedTargets,
      lastClickDiagnostic,
      removeTrackedTarget,
      clearTrackedTargets,
      activeSpectrum,
      isSpectrumLoading,
      selectPreset,
      navigateToCoordinates,
      retryActivePatch,
      inspectPixelOrCoord,
      activeMissions,
      filteredEpochIndices,
      toggleMissionFilter,
      getSkyFrustum,
      isBlinkerModalOpen,
      openBlinkerModal,
      closeBlinkerModal,
      isSpectraModalOpen,
      openSelectedSpectrum,
      closeSpectraModal,
      untrackObjectById,
      requestGlobeFocus,
    ],
  );

  return (
    <SkyFrustumContext.Provider value={frustumValue}>
      <SkyExplorerContext.Provider value={value}>{children}</SkyExplorerContext.Provider>
    </SkyFrustumContext.Provider>
  );
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

/**
 * Access the isolated high-frequency 3D globe frustum & focus context.
 *
 * @returns Active {@link SkyFrustumContextValue}.
 * @throws {Error} When invoked outside a {@link SkyExplorerProvider}.
 */
export function useSkyFrustum(): SkyFrustumContextValue {
  const ctx = useContext(SkyFrustumContext);
  if (!ctx) {
    throw new Error('useSkyFrustum must be used inside a SkyExplorerProvider');
  }
  return ctx;
}
