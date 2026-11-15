import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSkyExplorer } from '../context/SkyExplorerContext';
import {
  clampViewportPanZoom,
  computeViewportViewBox,
  formatImageProvenanceBadge,
  GRID_HEIGHT,
  GRID_WIDTH,
  screenToImageCoordinates,
  type ComparisonMode,
  type ContrastStretch,
  type MissionName,
} from '../types/contracts';
import {
  computeSmartCalloutLayout,
  HOVER_DETAILS_DELAY_MS,
  type AvoidRect,
  type DetailsCalloutOrigin,
} from '../utils/calloutPlacement';
import {
  catalogBadgeLabel,
  formatMagnitude,
  formatProperMotion,
} from '../utils/knownObjectSelection';
import { observatoryLogger } from '../utils/observatoryLogger';
import {
  decodeHygieneFlagMask,
  formatRaDecCompact,
  getMarkerShapeKind,
} from '../utils/observatoryMath';
import { computeLocalPixelReadout, renderEpochBuffersToImageData } from '../utils/pixelEngine';
import { DualThumbRangeSlider } from './DualThumbRangeSlider';
import { SpectraModal } from './SpectraModal';
import {
  ChevronIcon,
  CloseIcon,
  PauseIcon,
  PlayIcon,
  RepeatLoopIcon,
  ResetViewIcon,
  SkipNextIcon,
  SkipPrevIcon,
  SpectrumWaveIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from './icons/ObservatoryIcons';

const BASE_MISSIONS_FILTER_LIST: ReadonlyArray<MissionName> = ['SPHEREx', 'WISE', 'NEOSSat'];

type CalloutRef = { kind: 'tracked'; trackId: string } | { kind: 'known'; objectId: string };

const BLINKER_CONTROLS_FOLDED_KEY = 'sh_blinker_controls_folded_v1';

interface HoverFlagTooltipState {
  stageX: number;
  stageY: number;
  ix: number;
  iy: number;
  flux: number;
  variance: number;
  flagByte: number;
}

export const BlinkerModal: React.FC = () => {
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

  const [controlsTab, setControlsTab] = useState<'controls' | 'objects'>('controls');
  const [lockedCalloutState, setLockedCalloutState] = useState<ScopedCalloutState | null>(null);
  const [hoverCalloutState, setHoverCalloutState] = useState<ScopedCalloutState | null>(null);
  const [autoTrackSelection, setAutoTrackSelection] = useState<{
    scopeKey: string;
    trackId: string | null;
  } | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const hoverCandidateKeyRef = useRef<string | null>(null);

  const selectedTrackId = selectedObject?.trackId ?? null;
  const isDismissedAutoTrack =
    autoTrackSelection?.scopeKey === currentCalloutScopeKey &&
    autoTrackSelection.trackId === selectedTrackId;
  const lockedCallout: CalloutRef | null = useMemo(
    () =>
      lockedCalloutState?.scopeKey === currentCalloutScopeKey
        ? lockedCalloutState.target
        : isBlinkerModalOpen &&
            selectedTrackId &&
            !isDismissedAutoTrack &&
            trackedTargets.some((t) => t.trackId === selectedTrackId)
          ? { kind: 'tracked', trackId: selectedTrackId }
          : null,
    [
      currentCalloutScopeKey,
      isBlinkerModalOpen,
      isDismissedAutoTrack,
      lockedCalloutState,
      selectedTrackId,
      trackedTargets,
    ],
  );
  const hoverCallout: CalloutRef | null =
    hoverCalloutState?.scopeKey === currentCalloutScopeKey ? hoverCalloutState.target : null;

  const setLockedCallout = useCallback(
    (next: CalloutRef | null) => {
      if (next) {
        setLockedCalloutState({ scopeKey: currentCalloutScopeKey, target: next });
      } else {
        setLockedCalloutState(null);
        setAutoTrackSelection({
          scopeKey: currentCalloutScopeKey,
          trackId: selectedTrackId,
        });
      }
    },
    [currentCalloutScopeKey, selectedTrackId],
  );

  const setHoverCallout = useCallback(
    (next: CalloutRef | null) => {
      setHoverCalloutState(next ? { scopeKey: currentCalloutScopeKey, target: next } : null);
    },
    [currentCalloutScopeKey],
  );

  const [controlsFolded, setControlsFolded] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(BLINKER_CONTROLS_FOLDED_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const stageRef = useRef<HTMLDivElement | null>(null);
  const controlsCardRef = useRef<HTMLElement | null>(null);
  const canvasFrameRef = useRef<HTMLDivElement | null>(null);
  const visibleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [controlsRect, setControlsRect] = useState<AvoidRect | null>(null);

  const [frameRect, setFrameRect] = useState<{
    width: number;
    height: number;
    leftInStage: number;
    topInStage: number;
    stageW: number;
    stageH: number;
  }>({
    width: 530,
    height: 530,
    leftInStage: 252,
    topInStage: 10,
    stageW: 1035,
    stageH: 618,
  });

  const [hoverFlagTooltip, setHoverFlagTooltip] = useState<HoverFlagTooltipState | null>(null);

  const panDragRef = useRef<{
    active: boolean;
    moved: boolean;
    startClientX: number;
    startClientY: number;
    startPanX: number;
    startPanY: number;
  }>({
    active: false,
    moved: false,
    startClientX: 0,
    startClientY: 0,
    startPanX: 0,
    startPanY: 0,
  });

  // Persist Controls Card collapse state
  const toggleControlsFold = () => {
    setControlsFolded((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(BLINKER_CONTROLS_FOLDED_KEY, String(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  };

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    hoverCandidateKeyRef.current = null;
  }, []);

  useEffect(() => () => clearHoverTimer(), [clearHoverTimer]);

  // Close Blinker Modal cleanly on Escape key (unlocks pinned callout first if open)
  useEffect(() => {
    if (!isBlinkerModalOpen) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (lockedCallout) {
          setLockedCallout(null);
          return;
        }
        closeBlinkerModal?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeBlinkerModal, isBlinkerModalOpen, lockedCallout, setLockedCallout]);

  // Measure canvas frame and controls geometry inside modal stage for pixel-exact SVG overlay & callouts
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
      const ctrl = controlsCardRef.current;
      if (ctrl) {
        const cRect = ctrl.getBoundingClientRect();
        setControlsRect({
          left: cRect.left - sRect.left,
          top: cRect.top - sRect.top,
          right: cRect.right - sRect.left,
          bottom: cRect.bottom - sRect.top,
        });
      }
    };

    const raf = window.requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
    };
  }, [controlsFolded, controlsTab, isBlinkerModalOpen, isSpectraModalOpen]);

  const viewBox = useMemo(
    () => computeViewportViewBox(renderSettings.zoom, renderSettings.panX, renderSettings.panY),
    [renderSettings.zoom, renderSettings.panX, renderSettings.panY],
  );

  // Blit active scientific frame onto visible pixelated 256x256 canvas
  useEffect(() => {
    if (!isBlinkerModalOpen) return;
    const canvas = visibleCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (!epochBuffers || epochBuffers.length === 0) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, GRID_WIDTH, GRID_HEIGHT);
      return;
    }

    if (!offscreenCanvasRef.current) {
      const off = document.createElement('canvas');
      off.width = GRID_WIDTH;
      off.height = GRID_HEIGHT;
      offscreenCanvasRef.current = off;
    }
    const offscreen = offscreenCanvasRef.current;
    const offCtx = offscreen.getContext('2d');
    if (!offCtx) return;

    const imageData = renderEpochBuffersToImageData({
      epochBuffers,
      flagsBuffers: flagsBuffers ?? undefined,
      activeEpochIndex: renderSettings.activeEpochIndex,
      comparisonMode: renderSettings.mode,
      contrastStretch: renderSettings.contrastStretch,
      wavelengthRangeUm: renderSettings.wavelengthRangeUm,
      passAIndex: renderSettings.passAIndex,
      passBIndex: renderSettings.passBIndex,
      coaddIndices: renderSettings.coaddIndices,
      showFlagsOverlay: false, // Contamination is inspected strictly via hover tooltip
    });

    offCtx.putImageData(imageData, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, GRID_WIDTH, GRID_HEIGHT);
    ctx.drawImage(
      offscreen,
      viewBox.minX,
      viewBox.minY,
      viewBox.viewWidth,
      viewBox.viewHeight,
      0,
      0,
      GRID_WIDTH,
      GRID_HEIGHT,
    );
  }, [
    epochBuffers,
    flagsBuffers,
    isBlinkerModalOpen,
    renderSettings.activeEpochIndex,
    renderSettings.coaddIndices,
    renderSettings.contrastStretch,
    renderSettings.mode,
    renderSettings.passAIndex,
    renderSettings.passBIndex,
    renderSettings.wavelengthRangeUm,
    viewBox,
  ]);

  const provenance = useMemo(
    () => formatImageProvenanceBadge(manifest?.data_source_summary),
    [manifest?.data_source_summary],
  );

  const missionFilterList = useMemo(() => {
    const ordered: MissionName[] = [...BASE_MISSIONS_FILTER_LIST];
    if (manifest) {
      for (const ep of manifest.epochs) {
        if (!ordered.includes(ep.mission)) {
          ordered.push(ep.mission);
        }
      }
    }
    return ordered;
  }, [manifest]);

  if (!isBlinkerModalOpen) {
    return null;
  }

  const totalEpochs = manifest?.epochs.length ?? 0;
  const activeEpoch =
    manifest?.epochs[Math.min(renderSettings.activeEpochIndex, Math.max(0, totalEpochs - 1))];
  const passAEpoch = manifest?.epochs[renderSettings.passAIndex];
  const passBEpoch = manifest?.epochs[renderSettings.passBIndex];

  const checkedIdSet = new Set(renderSettings.checkedObjectIds);
  const trackedObjectIdSet = new Set(
    trackedTargets.map((t) => t.matchedObjectId).filter((id): id is string => Boolean(id)),
  );

  // Project 256x256 image coords -> screen pixels inside canvas frame
  const imageToScreen = (imgX: number, imgY: number) => ({
    sx: ((imgX - viewBox.minX) / viewBox.viewWidth) * frameRect.width,
    sy: ((imgY - viewBox.minY) / viewBox.viewHeight) * frameRect.height,
  });

  // Hit-test visible labeled catalog objects and actively tracked targets near screen coordinates
  const findHitLabeledObject = (localX: number, localY: number): CalloutRef | null => {
    const epIdx = renderSettings.activeEpochIndex;
    for (const track of trackedTargets) {
      const wp = track.waypoints[epIdx] ??
        track.waypoints[track.originEpochIndex] ?? {
          x: track.originCentroidX,
          y: track.originCentroidY,
        };
      const { sx, sy } = imageToScreen(wp.x, wp.y);
      const nearMarker = Math.hypot(localX - sx, localY - sy) <= 18;
      const nearLabel =
        Boolean(track.matchedLabel) &&
        localX >= sx + 12 &&
        localX <= sx + 145 &&
        Math.abs(localY - sy) <= 11;
      if (nearMarker || nearLabel) {
        return { kind: 'tracked', trackId: track.trackId };
      }
    }

    for (const obj of knownObjects) {
      if (!checkedIdSet.has(obj.object_id) || trackedObjectIdSet.has(obj.object_id)) {
        continue;
      }
      const epPos =
        obj.epoch_positions?.[
          Math.min(epIdx, Math.max(0, (obj.epoch_positions?.length ?? 1) - 1))
        ] ?? obj;
      const { sx, sy } = imageToScreen(epPos.x, epPos.y);
      const nearMarker = Math.hypot(localX - sx, localY - sy) <= 18;
      const nearLabel = localX >= sx + 14 && localX <= sx + 150 && Math.abs(localY - sy) <= 11;
      if (nearMarker || nearLabel) {
        return { kind: 'known', objectId: obj.object_id };
      }
    }
    return null;
  };

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    panDragRef.current = {
      active: true,
      moved: false,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPanX: renderSettings.panX,
      startPanY: renderSettings.panY,
    };
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const frameEl = canvasFrameRef.current;
    const stageEl = stageRef.current;
    if (!frameEl || !stageEl) return;

    const fRect = frameEl.getBoundingClientRect();
    const sRect = stageEl.getBoundingClientRect();
    const localX = e.clientX - fRect.left;
    const localY = e.clientY - fRect.top;

    // Handle active zoom-pan drag
    const drag = panDragRef.current;
    if (drag.active) {
      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;
      if (Math.hypot(dx, dy) > 4) {
        drag.moved = true;
        clearHoverTimer();
        setHoverCallout(null);
      }
      if (drag.moved && renderSettings.zoom > 1.0) {
        const deltaImgX = -(dx / Math.max(1, fRect.width)) * viewBox.viewWidth;
        const deltaImgY = -(dy / Math.max(1, fRect.height)) * viewBox.viewHeight;
        const clamped = clampViewportPanZoom(
          renderSettings.zoom,
          drag.startPanX + deltaImgX,
          drag.startPanY + deltaImgY,
        );
        setViewportZoomPan(clamped.zoom, clamped.panX, clamped.panY);
        setHoverFlagTooltip(null);
        return;
      }
    }

    // Hover hygiene inspection (FLAGS + flux/variance)
    if (localX < 0 || localY < 0 || localX > fRect.width || localY > fRect.height) {
      setHoverFlagTooltip(null);
      clearHoverTimer();
      setHoverCallout(null);
      return;
    }

    // Hover-delay preview over labeled markers when no details box is locked
    if (!lockedCallout) {
      const hit = findHitLabeledObject(localX, localY);
      const hitKey = hit
        ? hit.kind === 'tracked'
          ? `t:${hit.trackId}`
          : `k:${hit.objectId}`
        : null;
      if (hit && hitKey !== hoverCandidateKeyRef.current) {
        clearHoverTimer();
        hoverCandidateKeyRef.current = hitKey;
        setHoverCallout(null);
        hoverTimerRef.current = window.setTimeout(() => {
          setHoverCallout(hit);
          observatoryLogger.info('blinker', 'callout_hover_show', { hitKey });
        }, HOVER_DETAILS_DELAY_MS);
      } else if (!hit && hoverCandidateKeyRef.current !== null) {
        clearHoverTimer();
        setHoverCallout(null);
      }
    }

    const { x: ix, y: iy } = screenToImageCoordinates(
      e.clientX,
      e.clientY,
      fRect,
      renderSettings.zoom,
      renderSettings.panX,
      renderSettings.panY,
    );
    const readout = computeLocalPixelReadout({
      epochBuffers,
      flagsBuffers,
      activeEpochIndex: renderSettings.activeEpochIndex,
      wavelengthRangeUm: renderSettings.wavelengthRangeUm,
      px: ix,
      py: iy,
    });

    if (readout.flagByte > 0) {
      setHoverFlagTooltip({
        stageX: e.clientX - sRect.left,
        stageY: e.clientY - sRect.top,
        ix: readout.x,
        iy: readout.y,
        flux: readout.flux,
        variance: readout.variance,
        flagByte: readout.flagByte,
      });
    } else {
      setHoverFlagTooltip(null);
    }
  };

  const handleCanvasPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = panDragRef.current;
    if (!drag.active) return;
    const wasMoved = drag.moved;
    panDragRef.current.active = false;
    if (wasMoved) return;

    const frameEl = canvasFrameRef.current;
    if (!frameEl) return;
    const fRect = frameEl.getBoundingClientRect();
    const localX = e.clientX - fRect.left;
    const localY = e.clientY - fRect.top;

    const hitLabeled = findHitLabeledObject(localX, localY);
    if (hitLabeled) {
      clearHoverTimer();
      setHoverCallout(null);
      setLockedCallout(hitLabeled);
      observatoryLogger.info('blinker', 'callout_click_lock', { ...hitLabeled });
      return;
    }

    if (lockedCallout) {
      setLockedCallout(null);
      observatoryLogger.info('blinker', 'callout_unlock_by_sky_click');
      return;
    }

    const { x: imgX, y: imgY } = screenToImageCoordinates(
      e.clientX,
      e.clientY,
      fRect,
      renderSettings.zoom,
      renderSettings.panX,
      renderSettings.panY,
    );
    observatoryLogger.info('blinker', 'click_to_track', {
      x: Number(imgX.toFixed(2)),
      y: Number(imgY.toFixed(2)),
      epoch: renderSettings.activeEpochIndex,
    });
    inspectPixelOrCoord(imgX, imgY, renderSettings.activeEpochIndex);
  };

  const handleCanvasWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.25 : 0.8;
    const clamped = clampViewportPanZoom(
      renderSettings.zoom * factor,
      renderSettings.panX,
      renderSettings.panY,
    );
    setViewportZoomPan(clamped.zoom, clamped.panX, clamped.panY);
  };

  const activeCalloutRef: CalloutRef | null = lockedCallout ?? hoverCallout;
  const activeCalloutOrigin: DetailsCalloutOrigin = lockedCallout ? 'click' : 'hover';

  interface CalloutDetail {
    title: string;
    subtitle: string;
    description: string;
    catalogBadge: string;
    ra: number;
    dec: number;
    properMotionText: string;
    magnitudeText: string;
    w1W2Text: string | null;
    color: string;
    imgX: number;
    imgY: number;
    trackId: string | null;
    objectId: string | null;
    isLocked: boolean;
  }

  let calloutDetail: CalloutDetail | null = null;
  let calloutGeometry: {
    markerStageX: number;
    markerStageY: number;
    lineStartX: number;
    lineStartY: number;
    kneeX: number;
    kneeY: number;
    cardLeft: number;
    cardTop: number;
    anchorX: number;
    anchorY: number;
    color: string;
  } | null = null;

  if (activeCalloutRef && manifest) {
    const epIdx = renderSettings.activeEpochIndex;
    const targetNameLower = manifest.target_metadata.name.trim().toLowerCase();

    if (activeCalloutRef.kind === 'tracked') {
      const track = trackedTargets.find((t) => t.trackId === activeCalloutRef.trackId);
      if (track) {
        const knownMatch = track.matchedObjectId
          ? knownObjects.find((k) => k.object_id === track.matchedObjectId)
          : undefined;
        const wp = track.waypoints[epIdx] ??
          track.waypoints[track.originEpochIndex] ?? {
            x: track.originCentroidX,
            y: track.originCentroidY,
          };
        const title = track.matchedLabel ?? 'Uncataloged Moving Source';
        const isPrimaryFieldTarget =
          Boolean(targetNameLower) && title.toLowerCase().includes(targetNameLower);
        const notesParts: string[] = [];
        if (isPrimaryFieldTarget && manifest.target_metadata.description) {
          notesParts.push(manifest.target_metadata.description);
        } else if (knownMatch) {
          const typeLabel = [knownMatch.canonical_name, knownMatch.otype, knownMatch.object_type]
            .filter(Boolean)
            .join(' · ');
          if (typeLabel) notesParts.push(typeLabel);
        }
        if (track.statusMessage && !notesParts.includes(track.statusMessage)) {
          notesParts.push(track.statusMessage);
        }
        if (knownMatch?.data_source) {
          notesParts.push(`Catalog provenance: ${knownMatch.data_source}`);
        }
        if (notesParts.length === 0 && manifest.target_metadata.description) {
          notesParts.push(
            `Field: ${manifest.target_metadata.name}. ${manifest.target_metadata.description}`,
          );
        }

        calloutDetail = {
          title,
          subtitle: `${formatRaDecCompact(track.ra, track.dec)} · Constellation: ${
            manifest.target_metadata.constellation || 'n/a'
          }`,
          description: notesParts.join(' '),
          catalogBadge: track.matchedCatalog ? track.matchedCatalog.toUpperCase() : 'CANDIDATE',
          ra: track.ra,
          dec: track.dec,
          properMotionText: `${track.properMotionArcsecPerYr.toFixed(2)}"/yr`,
          magnitudeText:
            knownMatch && knownMatch.magnitude !== null
              ? formatMagnitude(knownMatch.magnitude)
              : 'mag n/a',
          w1W2Text:
            knownMatch && knownMatch.w1_w2_color !== null
              ? `W1-W2 ${knownMatch.w1_w2_color >= 0 ? '+' : ''}${knownMatch.w1_w2_color.toFixed(2)}`
              : null,
          color: track.color,
          imgX: wp.x,
          imgY: wp.y,
          trackId: track.trackId,
          objectId: track.matchedObjectId ?? null,
          isLocked: activeCalloutOrigin === 'click',
        };
      }
    } else {
      const obj = knownObjects.find((k) => k.object_id === activeCalloutRef.objectId);
      if (obj) {
        const epPos =
          obj.epoch_positions?.[
            Math.min(epIdx, Math.max(0, (obj.epoch_positions?.length ?? 1) - 1))
          ] ?? obj;
        const color = objectHighlighterColors[obj.object_id] ?? '#38bdf8';
        const isPrimaryFieldTarget =
          Boolean(targetNameLower) && obj.label.toLowerCase().includes(targetNameLower);
        const notesParts: string[] = [];
        if (isPrimaryFieldTarget && manifest.target_metadata.description) {
          notesParts.push(manifest.target_metadata.description);
        }
        const typeMeta = [obj.canonical_name, obj.otype, obj.object_class ?? obj.object_type]
          .filter(Boolean)
          .join(' · ');
        if (typeMeta) {
          notesParts.push(`Classification: ${typeMeta}`);
        }
        if (obj.parallax_mas !== null && obj.parallax_mas !== undefined) {
          notesParts.push(`Parallax: ${obj.parallax_mas.toFixed(1)} mas`);
        }
        if (obj.data_source) {
          notesParts.push(`Source: ${obj.data_source}`);
        }

        calloutDetail = {
          title: obj.label,
          subtitle: `${formatRaDecCompact(epPos.ra, epPos.dec)} · Constellation: ${
            manifest.target_metadata.constellation || 'n/a'
          }`,
          description:
            notesParts.length > 0
              ? notesParts.join(' · ')
              : `Cataloged celestial source in the ${manifest.target_metadata.name} cutout.`,
          catalogBadge: catalogBadgeLabel(obj.catalog),
          ra: epPos.ra,
          dec: epPos.dec,
          properMotionText: formatProperMotion(obj.proper_motion_arcsec_yr),
          magnitudeText: formatMagnitude(obj.magnitude),
          w1W2Text:
            obj.w1_w2_color !== null
              ? `W1-W2 ${obj.w1_w2_color >= 0 ? '+' : ''}${obj.w1_w2_color.toFixed(2)}`
              : null,
          color,
          imgX: epPos.x,
          imgY: epPos.y,
          trackId: null,
          objectId: obj.object_id,
          isLocked: activeCalloutOrigin === 'click',
        };
      }
    }

    if (calloutDetail) {
      const { sx, sy } = imageToScreen(calloutDetail.imgX, calloutDetail.imgY);
      const markerStageX = frameRect.leftInStage + sx;
      const markerStageY = frameRect.topInStage + sy;

      const cardW = Math.min(316, Math.max(240, frameRect.stageW - 28));
      const cardH = 186;
      const smart = computeSmartCalloutLayout({
        markerStageX,
        markerStageY,
        stageW: frameRect.stageW,
        stageH: frameRect.stageH,
        cardW,
        cardH,
        avoidRects: controlsRect ? [controlsRect] : [],
      });

      let lineStartX = markerStageX + 14;
      let lineStartY = markerStageY;
      if (smart.side === 'left') {
        lineStartX = markerStageX - 14;
      } else if (smart.side === 'above') {
        lineStartX = markerStageX;
        lineStartY = markerStageY - 14;
      } else if (smart.side === 'below') {
        lineStartX = markerStageX;
        lineStartY = markerStageY + 14;
      }

      calloutGeometry = {
        markerStageX,
        markerStageY,
        lineStartX,
        lineStartY,
        kneeX: smart.kneeX,
        kneeY: smart.kneeY,
        cardLeft: smart.cardLeft,
        cardTop: smart.cardTop,
        anchorX: smart.anchorX,
        anchorY: smart.anchorY,
        color: calloutDetail.color,
      };
    }
  }

  const decodedHoverFlags = hoverFlagTooltip
    ? decodeHygieneFlagMask(hoverFlagTooltip.flagByte)
    : null;

  const sectionSubtitle = (() => {
    if (!manifest) return 'Loading calibrated infrared planes...';
    if (renderSettings.mode === 'subtract') {
      return `Diff: Pass ${renderSettings.passBIndex + 1} (${
        passBEpoch?.iso_date?.slice(0, 10) ?? 'n/a'
      }, ${passBEpoch?.mission ?? 'SPHEREx'}) - Pass ${renderSettings.passAIndex + 1} (${
        passAEpoch?.iso_date?.slice(0, 10) ?? 'n/a'
      }, ${passAEpoch?.mission ?? 'SPHEREx'})`;
    }
    if (renderSettings.mode === 'coadd') {
      const count = renderSettings.coaddIndices.length || totalEpochs;
      return `Co-Added Stack (${count} passes: #${renderSettings.passAIndex + 1}-#${
        renderSettings.passBIndex + 1
      }) · ${provenance.shortLabel}`;
    }
    return `Pass ${renderSettings.activeEpochIndex + 1}/${totalEpochs} · ${
      activeEpoch?.iso_date?.slice(0, 10) ?? 'n/a'
    } · ${activeEpoch?.mission ?? provenance.shortLabel}`;
  })();

  return (
    <div className="modal-backdrop" role="presentation" data-testid="blinker-modal-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Patch Inspector and Multi-Epoch Blinker"
        data-testid="blinker-modal"
        className={`blinker-modal ${isSpectraModalOpen ? 'with-spectra-open' : ''}`}
      >
        {/* Top Modal Header */}
        <header className="blinker-header">
          <div className="blinker-header-left">
            <button
              type="button"
              className="hud-icon-btn"
              aria-label="Zoom out cutout"
              onClick={() =>
                setViewportZoomPan(
                  renderSettings.zoom / 1.4,
                  renderSettings.panX,
                  renderSettings.panY,
                )
              }
            >
              <ZoomOutIcon size={14} />
            </button>
            <span className="mono" style={{ minWidth: 34, textAlign: 'center' }}>
              {renderSettings.zoom.toFixed(1)}×
            </span>
            <button
              type="button"
              className="hud-icon-btn"
              aria-label="Zoom in cutout"
              onClick={() =>
                setViewportZoomPan(
                  renderSettings.zoom * 1.4,
                  renderSettings.panX,
                  renderSettings.panY,
                )
              }
            >
              <ZoomInIcon size={14} />
            </button>
            {renderSettings.zoom > 1.01 && (
              <button
                type="button"
                className="hud-icon-btn"
                aria-label="Reset zoom and pan"
                onClick={resetViewportZoomPan}
              >
                <ResetViewIcon size={14} />
              </button>
            )}
            <select
              aria-label="Contrast stretch"
              className="hud-select"
              style={{ height: 26, fontSize: 11, marginLeft: 4 }}
              value={renderSettings.contrastStretch}
              onChange={(e) =>
                updateRenderSettings({
                  contrastStretch: e.target.value as ContrastStretch,
                })
              }
            >
              <option value="asinh">Asinh</option>
              <option value="zscale">ZScale</option>
              <option value="linear">Linear</option>
            </select>
          </div>

          <div className="blinker-section-label">
            <span className="blinker-section-title">
              {manifest?.target_metadata.name ?? 'SPHEREx Sky Patch'}
            </span>
            <span className="blinker-section-sub mono">
              {sectionSubtitle}
              {manifest ? ` · ${formatRaDecCompact(manifest.query.ra, manifest.query.dec)}` : ''}
            </span>
          </div>

          <div
            className="blinker-header-right"
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <span
              className={`provenance-pill provenance-pill--${provenance.tier}`}
              data-testid="blinker-provenance-badge"
              title={manifest?.data_source_summary?.status_note ?? provenance.label}
            >
              {provenance.label}
            </span>
            <button
              type="button"
              className="hud-icon-btn"
              aria-label="Close Blinker Modal"
              data-testid="blinker-close-btn"
              onClick={closeBlinkerModal}
            >
              <CloseIcon size={16} />
            </button>
          </div>
        </header>

        {/* Modal Main Stage */}
        <div
          ref={stageRef}
          className="blinker-stage"
          onPointerDown={(e) => {
            if (!lockedCallout) return;
            const target = e.target as HTMLElement | null;
            if (
              target &&
              (target.closest('.callout-card') ||
                target.closest('.blinker-controls-card') ||
                target.closest('.blinker-canvas-frame') ||
                target.closest('.blinker-transport-bar'))
            ) {
              return;
            }
            setLockedCallout(null);
          }}
        >
          {/* Top-Left Foldable Controls & Inline Objects Card */}
          <aside
            ref={controlsCardRef}
            className="blinker-controls-card"
            aria-label="Infrared Blinker, Wavelength & Known Objects Controls"
            data-testid="blinker-controls-card"
          >
            <div className="hud-drag-handle" style={{ cursor: 'default', padding: '9px 12px' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Pass &amp; Band Controls</span>
              <button
                type="button"
                className="hud-icon-btn"
                aria-label={controlsFolded ? 'Expand controls' : 'Fold controls'}
                aria-expanded={!controlsFolded}
                data-testid="blinker-controls-chevron"
                onClick={toggleControlsFold}
              >
                <ChevronIcon size={15} direction={controlsFolded ? 'down' : 'up'} />
              </button>
            </div>

            {!controlsFolded && (
              <div className="blinker-controls-body">
                <div
                  className="blinker-controls-tabs"
                  role="tablist"
                  aria-label="Blinker Side Panel Tabs"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={controlsTab === 'controls'}
                    data-testid="blinker-tab-controls"
                    className={`blinker-controls-tab-btn ${controlsTab === 'controls' ? 'active' : ''}`}
                    onClick={() => setControlsTab('controls')}
                  >
                    Controls
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={controlsTab === 'objects'}
                    data-testid="blinker-tab-objects"
                    className={`blinker-controls-tab-btn ${controlsTab === 'objects' ? 'active' : ''}`}
                    onClick={() => setControlsTab('objects')}
                  >
                    Known Objects ({checkedIdSet.size}/{knownObjects.length})
                  </button>
                </div>

                {controlsTab === 'controls' ? (
                  <>
                    {/* 1. Dual-Thumb Wavelength Slice Slider (Dim & Pop) */}
                    <div>
                      <DualThumbRangeSlider
                        label="Wavelength Slice"
                        min={0.75}
                        max={5.0}
                        step={0.05}
                        minGap={0.15}
                        value={renderSettings.wavelengthRangeUm}
                        formatReadout={(lo, hi) => `${lo.toFixed(2)}-${hi.toFixed(2)} µm`}
                        lowAriaLabel="Minimum wavelength micrometers"
                        highAriaLabel="Maximum wavelength micrometers"
                        testId="wavelength-dual-slider"
                        onChange={(next) => updateRenderSettings({ wavelengthRangeUm: next })}
                      />
                      <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                        {[
                          { label: 'All 0.75-5.0', range: [0.75, 5.0] as [number, number] },
                          { label: 'Cold 3.8-5.0', range: [3.8, 5.0] as [number, number] },
                          { label: 'Ice 2.4-3.8', range: [2.4, 3.8] as [number, number] },
                        ].map((preset) => (
                          <button
                            key={preset.label}
                            type="button"
                            className="hud-btn-secondary"
                            style={{ height: 22, padding: '0 6px', fontSize: 10 }}
                            onClick={() =>
                              updateRenderSettings({ wavelengthRangeUm: preset.range })
                            }
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* 2. Explicit [Blink | Subtract | Add] Mode Pill + Pass Dual-Thumb Slider */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div
                        className="mode-segmented-pill"
                        role="tablist"
                        aria-label="Comparison Mode"
                        data-testid="comparison-mode-pill"
                      >
                        {(
                          [
                            { id: 'blink', label: 'Blink' },
                            { id: 'subtract', label: 'Subtract' },
                            { id: 'coadd', label: 'Add' },
                          ] as Array<{ id: ComparisonMode; label: string }>
                        ).map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            role="tab"
                            aria-selected={renderSettings.mode === m.id}
                            data-testid={`mode-btn-${m.id}`}
                            className={`mode-segmented-btn ${
                              renderSettings.mode === m.id ? 'is-active' : ''
                            }`}
                            onClick={() => updateRenderSettings({ mode: m.id })}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>

                      {totalEpochs >= 2 && (
                        <DualThumbRangeSlider
                          label={
                            renderSettings.mode === 'coadd'
                              ? 'Co-Add Pass Span'
                              : 'Pass Pair Window'
                          }
                          min={1}
                          max={totalEpochs}
                          step={1}
                          minGap={1}
                          value={[
                            Math.min(renderSettings.passAIndex + 1, totalEpochs - 1),
                            Math.max(2, Math.min(totalEpochs, renderSettings.passBIndex + 1)),
                          ]}
                          formatReadout={(lo, hi) =>
                            renderSettings.mode === 'subtract'
                              ? `P${hi} − P${lo}`
                              : `P${lo} .. P${hi}`
                          }
                          lowAriaLabel="Left reference pass"
                          highAriaLabel="Right target pass"
                          testId="pass-dual-slider"
                          onChange={([lo, hi]) => {
                            const idxA = Math.max(0, Math.min(totalEpochs - 2, lo - 1));
                            const idxB = Math.max(idxA + 1, Math.min(totalEpochs - 1, hi - 1));
                            const span: number[] = [];
                            for (let i = idxA; i <= idxB; i += 1) span.push(i);
                            updateRenderSettings({
                              passAIndex: idxA,
                              passBIndex: idxB,
                              coaddIndices: span,
                            });
                          }}
                        />
                      )}
                    </div>

                    {/* 3. Mission Source Filter Pills (SPHEREx, WISE, NEOSSat, SkyView...) */}
                    <div>
                      <div className="control-section-header" style={{ marginBottom: 4 }}>
                        <span className="control-section-title">Mission Sources</span>
                      </div>
                      <div className="mission-filter-row" data-testid="mission-filter-row">
                        {missionFilterList.map((mission) => {
                          const enabled = activeMissions.includes(mission);
                          return (
                            <button
                              key={mission}
                              type="button"
                              aria-pressed={enabled}
                              data-testid={`mission-pill-${mission}`}
                              className={`mission-pill-btn ${enabled ? 'is-enabled' : ''}`}
                              onClick={() => toggleMissionFilter?.(mission)}
                            >
                              <span
                                style={{
                                  width: 7,
                                  height: 7,
                                  borderRadius: '50%',
                                  background: enabled
                                    ? 'var(--accent-cyan)'
                                    : 'rgba(148, 163, 184, 0.35)',
                                }}
                              />
                              <span>{mission}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </>
                ) : (
                  <div
                    style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                    data-testid="blinker-inline-objects-panel"
                  >
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      <button
                        type="button"
                        className="hud-btn-secondary"
                        style={{ flex: 1, height: 24, fontSize: 11, padding: '0 8px' }}
                        data-testid="blinker-objects-select-all"
                        onClick={() => checkAllKnownObjects?.()}
                      >
                        Select All
                      </button>
                      <button
                        type="button"
                        className="hud-btn-secondary"
                        style={{ flex: 1, height: 24, fontSize: 11, padding: '0 8px' }}
                        data-testid="blinker-objects-clear-all"
                        onClick={() => {
                          uncheckAllKnownObjects?.();
                          if (lockedCallout?.kind === 'known') {
                            setLockedCallout(null);
                          }
                        }}
                      >
                        Clear All
                      </button>
                      {trackedTargets.length > 0 && (
                        <button
                          type="button"
                          className="hud-btn-secondary"
                          style={{ height: 24, fontSize: 11, padding: '0 8px' }}
                          data-testid="blinker-objects-clear-pins"
                          onClick={() => {
                            clearTrackedTargets?.();
                            if (lockedCallout?.kind === 'tracked') {
                              setLockedCallout(null);
                            }
                          }}
                        >
                          Untrack ({trackedTargets.length})
                        </button>
                      )}
                    </div>

                    <div className="blinker-inline-objects-list">
                      {knownObjects.length === 0 ? (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 6 }}>
                          No cataloged objects inside this cutout boundary.
                        </div>
                      ) : (
                        knownObjects.map((obj) => {
                          const checked = checkedIdSet.has(obj.object_id);
                          const color = objectHighlighterColors[obj.object_id] ?? '#38bdf8';
                          return (
                            <div
                              key={obj.object_id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 7,
                                padding: '5px 7px',
                                borderRadius: 8,
                                background: checked
                                  ? 'rgba(30, 41, 59, 0.72)'
                                  : 'rgba(15, 23, 42, 0.42)',
                                border: `1px solid ${
                                  checked ? 'rgba(56, 189, 248, 0.35)' : 'var(--border-hairline)'
                                }`,
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                aria-label={`Toggle ${obj.label}`}
                                data-testid={`blinker-inline-obj-check-${obj.object_id}`}
                                onChange={() => toggleKnownObject?.(obj.object_id)}
                                style={{ accentColor: color, cursor: 'pointer', flexShrink: 0 }}
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  if (!checked) {
                                    toggleKnownObject?.(obj.object_id);
                                  }
                                  clearHoverTimer();
                                  setHoverCallout(null);
                                  setLockedCallout({ kind: 'known', objectId: obj.object_id });
                                }}
                                style={{
                                  flex: 1,
                                  textAlign: 'left',
                                  minWidth: 0,
                                  color: 'var(--text-primary)',
                                  fontSize: 11.5,
                                }}
                                title="Click to inspect details"
                              >
                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 5,
                                    fontWeight: 600,
                                  }}
                                >
                                  <span
                                    style={{
                                      width: 7,
                                      height: 7,
                                      borderRadius: '50%',
                                      background: color,
                                      flexShrink: 0,
                                    }}
                                  />
                                  <span style={{ overflowWrap: 'anywhere' }}>{obj.label}</span>
                                </div>
                                <div
                                  className="mono"
                                  style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}
                                >
                                  {catalogBadgeLabel(obj.catalog)} ·{' '}
                                  {formatMagnitude(obj.magnitude)} ·{' '}
                                  {formatProperMotion(obj.proper_motion_arcsec_yr)}
                                </div>
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </aside>

          {/* Aligned 256x256 Multi-Pass Scientific Canvas + Hollow 3-Shape Overlay */}
          <div
            ref={canvasFrameRef}
            className="blinker-canvas-frame"
            data-testid="blinker-canvas-frame"
            onPointerDown={handleCanvasPointerDown}
            onPointerMove={handleCanvasPointerMove}
            onPointerUp={handleCanvasPointerUp}
            onPointerLeave={() => {
              panDragRef.current.active = false;
              setHoverFlagTooltip(null);
              clearHoverTimer();
              setHoverCallout(null);
            }}
            onWheel={handleCanvasWheel}
          >
            <canvas
              ref={visibleCanvasRef}
              width={GRID_WIDTH}
              height={GRID_HEIGHT}
              className="blinker-pixel-canvas"
              data-testid="blinker-pixel-canvas"
            />

            {/* Open-Center 3-Shape SVG Overlay (>=16x16px inner clearance, NO crosshairs, NO stacking) */}
            <svg
              className="blinker-marker-svg"
              viewBox={`0 0 ${frameRect.width} ${frameRect.height}`}
              data-testid="blinker-marker-overlay"
            >
              {/* 1. Checked Known Catalog Objects NOT currently user-tracked -> △ or ◇ */}
              {knownObjects
                .filter(
                  (obj) =>
                    checkedIdSet.has(obj.object_id) && !trackedObjectIdSet.has(obj.object_id),
                )
                .map((obj) => {
                  const epPos =
                    obj.epoch_positions?.[
                      Math.min(
                        renderSettings.activeEpochIndex,
                        Math.max(0, (obj.epoch_positions?.length ?? 1) - 1),
                      )
                    ] ?? obj;
                  const { sx, sy } = imageToScreen(epPos.x, epPos.y);
                  if (
                    sx < -24 ||
                    sx > frameRect.width + 24 ||
                    sy < -24 ||
                    sy > frameRect.height + 24
                  ) {
                    return null;
                  }
                  const shape = getMarkerShapeKind(obj, false);
                  const color = objectHighlighterColors[obj.object_id] ?? '#38bdf8';

                  return (
                    <g
                      key={`known-${obj.object_id}`}
                      data-marker-shape={shape}
                      data-object-id={obj.object_id}
                    >
                      {shape === 'diamond' ? (
                        <polygon
                          points={`${sx},${sy - 15} ${sx + 15},${sy} ${sx},${sy + 15} ${
                            sx - 15
                          },${sy}`}
                          fill="none"
                          stroke={color}
                          strokeWidth={2}
                          strokeLinejoin="round"
                        />
                      ) : (
                        <polygon
                          points={`${sx},${sy - 16} ${sx + 15},${sy + 12} ${sx - 15},${sy + 12}`}
                          fill="none"
                          stroke={color}
                          strokeWidth={2}
                          strokeLinejoin="round"
                        />
                      )}
                      <text
                        x={sx + 17}
                        y={sy + 4}
                        fill={color}
                        fontSize={10}
                        fontWeight={600}
                        stroke="rgba(5, 8, 15, 0.92)"
                        strokeWidth={3}
                        paintOrder="stroke"
                        style={{
                          pointerEvents: 'none',
                          fontFamily: 'Inter, system-ui, sans-serif',
                        }}
                      >
                        {obj.label}
                      </text>
                    </g>
                  );
                })}

              {/* 2. Actively Tracked Targets -> Hollow Square □ (>=20x20px clearance) + Trajectory */}
              {trackedTargets.map((track) => {
                const wp = track.waypoints[renderSettings.activeEpochIndex] ??
                  track.waypoints[track.originEpochIndex] ?? {
                    x: track.originCentroidX,
                    y: track.originCentroidY,
                  };
                const { sx, sy } = imageToScreen(wp.x, wp.y);
                const polyPoints = track.waypoints
                  .map((w) => {
                    const p = imageToScreen(w.x, w.y);
                    return `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`;
                  })
                  .join(' ');

                return (
                  <g key={track.trackId} data-marker-shape="square" data-track-id={track.trackId}>
                    {track.waypoints.length > 1 && (
                      <polyline
                        points={polyPoints}
                        fill="none"
                        stroke={track.color}
                        strokeWidth={1.5}
                        strokeDasharray="3 3"
                        opacity={0.78}
                      />
                    )}
                    {track.waypoints.map((w, idx) => {
                      if (idx === renderSettings.activeEpochIndex) return null;
                      const p = imageToScreen(w.x, w.y);
                      return (
                        <circle
                          key={`${track.trackId}-${w.epoch_id}`}
                          cx={p.sx}
                          cy={p.sy}
                          r={2.5}
                          fill={track.color}
                          opacity={0.8}
                        />
                      );
                    })}
                    {/* Hollow Square Frame (24x24 outer -> 20x20 inner open aperture, NO crosshairs) */}
                    <rect
                      x={sx - 12}
                      y={sy - 12}
                      width={24}
                      height={24}
                      fill="none"
                      stroke={track.color}
                      strokeWidth={2}
                      rx={1.5}
                    />
                    {track.matchedLabel && (
                      <text
                        x={sx + 16}
                        y={sy + 4}
                        fill={track.color}
                        fontSize={10}
                        fontWeight={600}
                        stroke="rgba(5, 8, 15, 0.92)"
                        strokeWidth={3}
                        paintOrder="stroke"
                        style={{
                          pointerEvents: 'none',
                          fontFamily: 'Inter, system-ui, sans-serif',
                        }}
                      >
                        {track.matchedLabel}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>

          {/* Thin 1px Angled Leader Line connecting object perimeter to Callout Card */}
          {calloutGeometry && (
            <svg
              aria-hidden="true"
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                zIndex: 6,
              }}
            >
              <polyline
                points={`${calloutGeometry.lineStartX.toFixed(1)},${calloutGeometry.lineStartY.toFixed(1)} ${calloutGeometry.kneeX.toFixed(1)},${calloutGeometry.kneeY.toFixed(1)} ${calloutGeometry.anchorX.toFixed(1)},${calloutGeometry.anchorY.toFixed(1)}`}
                fill="none"
                stroke={calloutGeometry.color}
                strokeWidth={1}
                strokeLinejoin="round"
                opacity={0.92}
              />
            </svg>
          )}

          {/* Frosted Glass Non-Occluding Details Callout Card */}
          {calloutGeometry && calloutDetail && (
            <div
              className="callout-card"
              role="region"
              aria-label="Object Details Callout Card"
              data-testid="blinker-callout-card"
              data-callout-origin={activeCalloutOrigin}
              style={{
                left: calloutGeometry.cardLeft,
                top: calloutGeometry.cardTop,
                borderColor: `${calloutGeometry.color}88`,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: 'var(--text-primary)',
                      lineHeight: 1.3,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {calloutDetail.title}
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}
                  >
                    {calloutDetail.subtitle}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                  <span
                    className="mono"
                    style={{
                      fontSize: 9.5,
                      padding: '1px 6px',
                      borderRadius: 999,
                      border: `1px solid ${calloutGeometry.color}66`,
                      color: calloutDetail.isLocked
                        ? calloutGeometry.color
                        : 'var(--text-secondary)',
                    }}
                  >
                    {calloutDetail.isLocked ? 'Pinned' : 'Preview'}
                  </span>
                  <button
                    type="button"
                    className="hud-icon-btn"
                    style={{ width: 22, height: 22 }}
                    aria-label="Close object details"
                    data-testid="callout-close-btn"
                    onClick={() => {
                      clearHoverTimer();
                      setHoverCallout(null);
                      setLockedCallout(null);
                    }}
                  >
                    <CloseIcon size={12} />
                  </button>
                </div>
              </div>

              <p
                style={{
                  margin: 0,
                  fontSize: 11.5,
                  lineHeight: 1.42,
                  color: 'var(--text-secondary)',
                  overflowWrap: 'anywhere',
                }}
                data-testid="callout-description"
              >
                {calloutDetail.description}
              </p>

              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 10.5,
                }}
              >
                <span className="badge-pill">{calloutDetail.catalogBadge}</span>
                <span className="mono" style={{ color: 'var(--text-secondary)' }}>
                  {calloutDetail.magnitudeText}
                </span>
                <span className="mono" style={{ color: calloutGeometry.color }}>
                  {calloutDetail.properMotionText}
                </span>
                {calloutDetail.w1W2Text && (
                  <span className="mono" style={{ color: 'var(--text-muted)' }}>
                    {calloutDetail.w1W2Text}
                  </span>
                )}
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  paddingTop: 2,
                }}
              >
                {calloutDetail.trackId ? (
                  <button
                    type="button"
                    className="hud-btn-secondary"
                    style={{ height: 26, padding: '0 9px', fontSize: 11 }}
                    data-testid="callout-untrack-btn"
                    onClick={() => {
                      removeTrackedTarget?.(calloutDetail.trackId!);
                      setLockedCallout(null);
                    }}
                  >
                    Untrack
                  </button>
                ) : (
                  <button
                    type="button"
                    className="hud-btn-secondary"
                    style={{ height: 26, padding: '0 9px', fontSize: 11 }}
                    data-testid="callout-pin-track-btn"
                    onClick={() =>
                      inspectPixelOrCoord(
                        calloutDetail.imgX,
                        calloutDetail.imgY,
                        renderSettings.activeEpochIndex,
                      )
                    }
                  >
                    Pin Vector
                  </button>
                )}

                <button
                  type="button"
                  className="hud-btn-primary"
                  style={{ height: 28, padding: '0 10px', fontSize: 11 }}
                  data-testid="view-spectrum-btn"
                  onClick={() =>
                    openSelectedSpectrum?.({
                      ra: calloutDetail.ra,
                      dec: calloutDetail.dec,
                      label: calloutDetail.title,
                    })
                  }
                >
                  <SpectrumWaveIcon size={13} />
                  <span>View 102-Band Spectrum</span>
                </button>
              </div>
            </div>
          )}

          {/* Hover Tooltip for Pixel Contamination FLAGS (replaces toggle button) */}
          {hoverFlagTooltip && decodedHoverFlags && decodedHoverFlags.isFlagged && (
            <div
              className="flags-hover-tooltip"
              data-testid="contamination-hover-tooltip"
              style={{
                left: Math.min(frameRect.stageW - 260, Math.max(14, hoverFlagTooltip.stageX + 14)),
                top: Math.max(14, hoverFlagTooltip.stageY - 84),
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 4,
                }}
              >
                <span
                  style={{
                    fontWeight: 600,
                    color:
                      decodedHoverFlags.severity === 'critical'
                        ? 'var(--accent-danger)'
                        : 'var(--accent-amber-bright)',
                  }}
                >
                  HYGIENE FLAG (0x{hoverFlagTooltip.flagByte.toString(16).toUpperCase()})
                </span>
                <span className="mono" style={{ color: 'var(--text-muted)' }}>
                  ({hoverFlagTooltip.ix}, {hoverFlagTooltip.iy})
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 5 }}>
                {decodedHoverFlags.bits.map((b) => (
                  <div key={b.bit} style={{ color: 'var(--text-secondary)' }}>
                    • <strong style={{ color: 'var(--text-primary)' }}>{b.label}</strong>
                  </div>
                ))}
              </div>

              <div
                className="mono"
                style={{
                  borderTop: '1px solid var(--border-hairline)',
                  paddingTop: 4,
                  color: '#cbd5e1',
                  fontSize: 10,
                }}
              >
                Flux {hoverFlagTooltip.flux.toFixed(2)} · σ² {hoverFlagTooltip.variance.toFixed(2)}
              </div>
            </div>
          )}

          {/* Bottom-Center Transport Bar (Frame 8) */}
          <div
            className="blinker-transport-bar"
            role="toolbar"
            aria-label="Pass Playback Transport"
            data-testid="blinker-transport-bar"
          >
            <button
              type="button"
              className="transport-btn"
              aria-label="Previous pass"
              onClick={playback.stepBackward}
              data-testid="transport-prev-btn"
            >
              <SkipPrevIcon size={15} />
            </button>

            <button
              type="button"
              className={`transport-btn ${playback.isPlaying ? 'is-active' : ''}`}
              aria-label={playback.isPlaying ? 'Pause playback' : 'Play passes'}
              onClick={playback.isPlaying ? playback.pause : playback.play}
              data-testid="transport-play-btn"
            >
              {playback.isPlaying ? <PauseIcon size={15} /> : <PlayIcon size={15} />}
            </button>

            <button
              type="button"
              className="transport-btn"
              aria-label="Next pass"
              onClick={playback.stepForward}
              data-testid="transport-next-btn"
            >
              <SkipNextIcon size={15} />
            </button>

            <button
              type="button"
              className={`transport-btn ${playback.isLooping ? 'is-active' : ''}`}
              aria-label="Toggle loop playback"
              aria-pressed={playback.isLooping}
              onClick={playback.toggleLoop}
              data-testid="transport-loop-btn"
            >
              <RepeatLoopIcon size={14} />
            </button>

            <span className="globe-telemetry-divider" />

            <span
              className="mono"
              style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '0 4px' }}
            >
              {totalEpochs > 0 ? `${renderSettings.activeEpochIndex + 1}/${totalEpochs}` : '0/0'}
            </span>

            <select
              aria-label="Playback speed in FPS"
              className="hud-select"
              style={{ height: 26, fontSize: 11, borderRadius: 999, padding: '0 8px' }}
              value={playback.fps}
              onChange={(e) => playback.setFps(Number(e.target.value))}
              data-testid="transport-fps-select"
            >
              <option value={0.5}>FPS | 0.5×</option>
              <option value={1}>FPS | 1×</option>
              <option value={2}>FPS | 2×</option>
              <option value={4}>FPS | 4×</option>
              <option value={8}>FPS | 8×</option>
            </select>
          </div>
        </div>
      </div>

      <SpectraModal />
    </div>
  );
};
