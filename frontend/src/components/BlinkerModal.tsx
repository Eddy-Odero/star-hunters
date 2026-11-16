import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNotifications } from '../context/NotificationContext';
import { useSkyExplorer } from '../context/SkyExplorerContext';
import {
  computeViewportViewBox,
  formatImageProvenanceBadge,
  type ContrastStretch,
} from '../types/contracts';
import type { DetailsCalloutOrigin } from '../utils/calloutPlacement';
import { extractAvailableMissions } from '../utils/knownObjectSelection';
import { formatRaDecCompact } from '../utils/observatoryMath';
import { SpectraModal } from './SpectraModal';
import { BlinkerCalloutOverlay } from './blinker/BlinkerCalloutOverlay';
import { BlinkerCanvasViewport } from './blinker/BlinkerCanvasViewport';
import { BlinkerHeader } from './blinker/BlinkerHeader';
import { BlinkerSidebar } from './blinker/BlinkerSidebar';
import { BlinkerTransportBar } from './blinker/BlinkerTransportBar';
import {
  buildCalloutDetailAndGeometry,
  formatBlinkerSubtitle,
  type CalloutRef,
  type CanvasFrameRect,
} from './blinker/calloutBuilder';

const BLINKER_SIDEBAR_COLLAPSED_KEY = 'sh_blinker_sidebar_collapsed_v1';
const BLINKER_SIDEBAR_WIDTH_KEY = 'sh_blinker_sidebar_width_v1';
const BLINKER_SPLIT_RATIO_KEY = 'sh_blinker_split_ratio_v1';

function readStoredNumber(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === 'undefined') return fallback;
  try {
    const val = Number(window.localStorage.getItem(key));
    return Number.isFinite(val) && val >= min && val <= max ? val : fallback;
  } catch {
    return fallback;
  }
}

export const BlinkerModal: React.FC = () => {
  const { startAsyncTask } = useNotifications();
  const {
    manifest,
    epochBuffers,
    flagsBuffers,
    renderSettings,
    updateRenderSettings,
    setViewportZoomPan,
    resetViewportZoomPan,
    knownObjects,
    objectHighlighterColors = {},
    toggleKnownObject,
    checkAllKnownObjects,
    uncheckAllKnownObjects,
    trackedTargets,
    removeTrackedTarget,
    clearTrackedTargets,
    selectedObject,
    inspectPixelOrCoord,
    playback,
    activeMissions = ['SPHEREx', 'WISE', 'NEOSSat'],
    filteredEpochIndices = [],
    loadingState,
    toggleMissionFilter,
    isBlinkerModalOpen = false,
    closeBlinkerModal,
    isSpectraModalOpen = false,
    openSelectedSpectrum,
  } = useSkyExplorer();

  type ScopedCalloutState = { scopeKey: string; target: CalloutRef };
  const currentCalloutScopeKey = isBlinkerModalOpen
    ? (manifest?.query.grid_key ?? 'open')
    : 'closed';

  const [lockedCalloutState, setLockedCalloutState] = useState<ScopedCalloutState | null>(null);
  const [hoverCalloutState, setHoverCalloutState] = useState<ScopedCalloutState | null>(null);
  const pendingTrackLockRef = useRef<{ scopeKey: string; prevTrackId: string | null } | null>(null);
  const loadingClickCountRef = useRef<number>(0);

  const selectedTrackId = selectedObject?.trackId ?? null;

  useEffect(() => {
    const pending = pendingTrackLockRef.current;
    if (!pending) return;
    if (pending.scopeKey !== currentCalloutScopeKey) {
      pendingTrackLockRef.current = null;
      return;
    }
    if (
      selectedTrackId &&
      selectedTrackId !== pending.prevTrackId &&
      trackedTargets.some((t) => t.trackId === selectedTrackId)
    ) {
      pendingTrackLockRef.current = null;
      setLockedCalloutState({
        scopeKey: currentCalloutScopeKey,
        target: { kind: 'tracked', trackId: selectedTrackId },
      });
    }
  }, [currentCalloutScopeKey, selectedTrackId, trackedTargets]);

  const lockedCallout: CalloutRef | null = useMemo(
    () =>
      lockedCalloutState?.scopeKey === currentCalloutScopeKey ? lockedCalloutState.target : null,
    [currentCalloutScopeKey, lockedCalloutState],
  );
  const hoverCallout: CalloutRef | null =
    hoverCalloutState?.scopeKey === currentCalloutScopeKey ? hoverCalloutState.target : null;

  const setLockedCallout = useCallback(
    (next: CalloutRef | null) => {
      pendingTrackLockRef.current = null;
      setLockedCalloutState(next ? { scopeKey: currentCalloutScopeKey, target: next } : null);
    },
    [currentCalloutScopeKey],
  );

  const setHoverCallout = useCallback(
    (next: CalloutRef | null) => {
      setHoverCalloutState(next ? { scopeKey: currentCalloutScopeKey, target: next } : null);
    },
    [currentCalloutScopeKey],
  );

  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(BLINKER_SIDEBAR_COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [sidebarWidth, setSidebarWidth] = useState<number>(() =>
    readStoredNumber(BLINKER_SIDEBAR_WIDTH_KEY, 292, 240, 420),
  );
  const [splitRatio, setSplitRatio] = useState<number>(() =>
    readStoredNumber(BLINKER_SPLIT_RATIO_KEY, 0.56, 0.25, 0.75),
  );
  const [controlsFolded, setControlsFolded] = useState<boolean>(false);
  const [objectsFolded, setObjectsFolded] = useState<boolean>(false);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasFrameRef = useRef<HTMLDivElement | null>(null);
  const [frameRect, setFrameRect] = useState<CanvasFrameRect>({
    width: 530,
    height: 530,
    leftInStage: 120,
    topInStage: 10,
    stageW: 780,
    stageH: 618,
  });

  const isCutoutLoading =
    loadingState?.stage === 'loading_catalogs' ||
    loadingState?.stage === 'loading_cutouts' ||
    !epochBuffers ||
    epochBuffers.length === 0;

  useEffect(() => {
    if (!isCutoutLoading) loadingClickCountRef.current = 0;
  }, [isCutoutLoading]);

  useEffect(() => {
    if (!isBlinkerModalOpen) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (lockedCallout) setLockedCallout(null);
        else closeBlinkerModal?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeBlinkerModal, isBlinkerModalOpen, lockedCallout, setLockedCallout]);

  useEffect(() => {
    if (!isBlinkerModalOpen) return undefined;
    const measure = () => {
      const stage = stageRef.current;
      const frame = canvasFrameRef.current;
      if (!stage || !frame) return;
      const sRect = stage.getBoundingClientRect();
      const fRect = frame.getBoundingClientRect();
      setFrameRect({
        width: Math.max(120, fRect.width),
        height: Math.max(120, fRect.height),
        leftInStage: fRect.left - sRect.left,
        topInStage: fRect.top - sRect.top,
        stageW: sRect.width,
        stageH: sRect.height,
      });
    };

    const raf = window.requestAnimationFrame(measure);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && stageRef.current) {
      ro = new ResizeObserver(measure);
      ro.observe(stageRef.current);
    }
    window.addEventListener('resize', measure);
    return () => {
      window.cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [
    controlsFolded,
    isBlinkerModalOpen,
    isSpectraModalOpen,
    objectsFolded,
    sidebarCollapsed,
    sidebarWidth,
  ]);

  const viewBox = useMemo(
    () => computeViewportViewBox(renderSettings.zoom, renderSettings.panX, renderSettings.panY),
    [renderSettings.zoom, renderSettings.panX, renderSettings.panY],
  );
  const provenance = useMemo(
    () => formatImageProvenanceBadge(manifest?.data_source_summary),
    [manifest?.data_source_summary],
  );
  const availableMissions = useMemo(
    () => extractAvailableMissions(manifest?.epochs ?? []),
    [manifest?.epochs],
  );
  const allowedEpochIndices = useMemo(() => {
    if (!manifest) return [] as number[];
    return filteredEpochIndices.length > 0
      ? filteredEpochIndices
      : manifest.epochs.map((_, idx) => idx);
  }, [filteredEpochIndices, manifest]);
  const checkedIdSet = useMemo(
    () => new Set(renderSettings.checkedObjectIds),
    [renderSettings.checkedObjectIds],
  );
  const trackedObjectIdSet = useMemo(
    () =>
      new Set(
        trackedTargets.map((t) => t.matchedObjectId).filter((id): id is string => Boolean(id)),
      ),
    [trackedTargets],
  );

  const activeCalloutRef: CalloutRef | null = lockedCallout ?? hoverCallout;
  const activeCalloutOrigin: DetailsCalloutOrigin = lockedCallout ? 'click' : 'hover';
  const calloutResult = useMemo(
    () =>
      buildCalloutDetailAndGeometry({
        activeCalloutRef,
        activeCalloutOrigin,
        manifest,
        activeEpochIndex: renderSettings.activeEpochIndex,
        trackedTargets,
        knownObjects,
        objectHighlighterColors,
        frameRect,
        viewBox,
      }),
    [
      activeCalloutOrigin,
      activeCalloutRef,
      frameRect,
      knownObjects,
      manifest,
      objectHighlighterColors,
      renderSettings.activeEpochIndex,
      trackedTargets,
      viewBox,
    ],
  );

  if (!isBlinkerModalOpen) return null;

  const totalEpochs = manifest?.epochs.length ?? 0;
  const fullSubtitleText = `${formatBlinkerSubtitle({
    manifest,
    renderSettings,
    provenanceShortLabel: provenance.shortLabel,
  })}${manifest ? ` · ${formatRaDecCompact(manifest.query.ra, manifest.query.dec)}` : ''}`;

  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(BLINKER_SIDEBAR_COLLAPSED_KEY, String(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  };

  const startSidebarWidthResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = sidebarWidth;
    let latestW = startW;
    const onMove = (ev: PointerEvent) => {
      latestW = Math.max(240, Math.min(420, Math.round(startW + (ev.clientX - startX))));
      setSidebarWidth(latestW);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try {
        window.localStorage.setItem(BLINKER_SIDEBAR_WIDTH_KEY, String(latestW));
      } catch {
        // Ignore storage errors
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startSplitRatioResize = (
    e: React.PointerEvent<HTMLDivElement>,
    sidebarEl: HTMLElement | null,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (!sidebarEl) return;
    const totalH = Math.max(160, sidebarEl.getBoundingClientRect().height);
    const startY = e.clientY;
    const startRatio = splitRatio;
    let latestRatio = startRatio;
    const onMove = (ev: PointerEvent) => {
      latestRatio = Math.max(0.25, Math.min(0.75, startRatio + (ev.clientY - startY) / totalH));
      setSplitRatio(latestRatio);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try {
        window.localStorage.setItem(BLINKER_SPLIT_RATIO_KEY, latestRatio.toFixed(3));
      } catch {
        // Ignore storage errors
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="modal-backdrop" role="presentation" data-testid="blinker-modal-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Patch Inspector and Multi-Epoch Blinker"
        data-testid="blinker-modal"
        className={`blinker-modal ${isSpectraModalOpen ? 'with-spectra-open' : ''}`}
      >
        <BlinkerHeader
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebarCollapsed}
          zoom={renderSettings.zoom}
          panX={renderSettings.panX}
          panY={renderSettings.panY}
          contrastStretch={renderSettings.contrastStretch}
          title={manifest?.target_metadata.name ?? 'SPHEREx Sky Patch'}
          fullSubtitleText={fullSubtitleText}
          provenance={provenance}
          statusNote={manifest?.data_source_summary?.status_note}
          onSetZoomPan={setViewportZoomPan}
          onResetZoomPan={resetViewportZoomPan}
          onChangeContrast={(contrastStretch: ContrastStretch) =>
            updateRenderSettings({ contrastStretch })
          }
          onClose={closeBlinkerModal}
        />

        <div
          className="blinker-stage"
          onPointerDown={(e) => {
            if (!lockedCallout) return;
            const target = e.target as HTMLElement | null;
            if (
              target?.closest(
                '.callout-card, .blinker-sidebar, .blinker-canvas-frame, .blinker-transport-bar',
              )
            ) {
              return;
            }
            setLockedCallout(null);
          }}
        >
          {!sidebarCollapsed && (
            <BlinkerSidebar
              sidebarWidth={sidebarWidth}
              splitRatio={splitRatio}
              controlsFolded={controlsFolded}
              objectsFolded={objectsFolded}
              onToggleControlsFold={() => setControlsFolded((p) => !p)}
              onToggleObjectsFold={() => setObjectsFolded((p) => !p)}
              onStartSidebarWidthResize={startSidebarWidthResize}
              onStartSplitRatioResize={startSplitRatioResize}
              renderSettings={renderSettings}
              updateRenderSettings={updateRenderSettings}
              allowedEpochIndices={allowedEpochIndices}
              availableMissions={availableMissions}
              activeMissions={activeMissions}
              toggleMissionFilter={toggleMissionFilter}
              knownObjects={knownObjects}
              checkedIdSet={checkedIdSet}
              objectHighlighterColors={objectHighlighterColors}
              trackedCount={trackedTargets.length}
              lockedCallout={lockedCallout}
              onSetLockedCallout={setLockedCallout}
              onClearHover={() => setHoverCallout(null)}
              onToggleKnownObject={toggleKnownObject}
              onCheckAllKnownObjects={checkAllKnownObjects}
              onUncheckAllKnownObjects={uncheckAllKnownObjects}
              onClearTrackedTargets={clearTrackedTargets}
            />
          )}

          <div ref={stageRef} className="blinker-canvas-stage">
            <BlinkerCanvasViewport
              stageRef={stageRef}
              canvasFrameRef={canvasFrameRef}
              frameRect={frameRect}
              viewBox={viewBox}
              epochBuffers={epochBuffers}
              flagsBuffers={flagsBuffers}
              renderSettings={renderSettings}
              knownObjects={knownObjects}
              checkedIdSet={checkedIdSet}
              trackedObjectIdSet={trackedObjectIdSet}
              trackedTargets={trackedTargets}
              objectHighlighterColors={objectHighlighterColors}
              lockedCallout={lockedCallout}
              isCutoutLoading={isCutoutLoading}
              loadingMessage={loadingState?.message}
              onSetViewportZoomPan={setViewportZoomPan}
              onSetLockedCallout={setLockedCallout}
              onSetHoverCallout={setHoverCallout}
              onClickLoadingCanvas={() => {
                loadingClickCountRef.current += 1;
                if (loadingClickCountRef.current >= 2) {
                  startAsyncTask(
                    'blinker-cutout-loading',
                    'Sky patch is still loading. Sidebar controls remain active.',
                    'progress',
                    3600,
                  );
                }
              }}
              onClickToTrack={(imgX, imgY, epochIdx) => {
                pendingTrackLockRef.current = {
                  scopeKey: currentCalloutScopeKey,
                  prevTrackId: selectedTrackId,
                };
                inspectPixelOrCoord(imgX, imgY, epochIdx);
              }}
            />

            {calloutResult && (
              <BlinkerCalloutOverlay
                calloutDetail={calloutResult.detail}
                calloutGeometry={calloutResult.geometry}
                activeCalloutOrigin={activeCalloutOrigin}
                isCutoutLoading={isCutoutLoading}
                activeEpochIndex={renderSettings.activeEpochIndex}
                onClose={() => {
                  setHoverCallout(null);
                  setLockedCallout(null);
                }}
                onUntrack={(trackId) => {
                  removeTrackedTarget?.(trackId);
                  setLockedCallout(null);
                }}
                onPinTrack={(imgX, imgY, epochIdx) => {
                  pendingTrackLockRef.current = {
                    scopeKey: currentCalloutScopeKey,
                    prevTrackId: selectedTrackId,
                  };
                  inspectPixelOrCoord(imgX, imgY, epochIdx);
                }}
                onOpenSpectrum={openSelectedSpectrum}
              />
            )}

            <BlinkerTransportBar
              isPlaying={playback.isPlaying}
              isLooping={playback.isLooping}
              fps={playback.fps}
              activeEpochIndex={renderSettings.activeEpochIndex}
              totalEpochs={totalEpochs}
              onPlay={playback.play}
              onPause={playback.pause}
              onStepForward={playback.stepForward}
              onStepBackward={playback.stepBackward}
              onToggleLoop={playback.toggleLoop}
              onSetFps={playback.setFps}
            />
          </div>
        </div>
      </div>

      <SpectraModal />
    </div>
  );
};
