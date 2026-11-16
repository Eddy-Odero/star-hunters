import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  GRID_HEIGHT,
  GRID_WIDTH,
  type KnownCelestialObject,
  type TracedObjectSummary,
  type ViewportRenderSettings,
} from '../../types/contracts';
import { HOVER_DETAILS_DELAY_MS } from '../../utils/calloutPlacement';
import { observatoryLogger } from '../../utils/observatoryLogger';
import { decodeHygieneFlagMask, getMarkerShapeKind } from '../../utils/observatoryMath';
import {
  computeLocalPixelReadout,
  renderEpochBuffersToRgba,
  type LocalPixelReadout,
} from '../../utils/pixelEngine';
import { clampViewportPanZoom, screenToImageCoordinates } from '../../utils/wcsViewport';
import { isImagePointInBounds, type CalloutRef, type CanvasFrameRect } from './calloutBuilder';

/** Local hover tooltip payload for pixels with non-zero hygiene flags. */
interface HoverFlagTooltipState {
  stageX: number;
  stageY: number;
  ix: number;
  iy: number;
  flux: number;
  variance: number;
  flagByte: number;
}

/** Cached pointer readout keyed by integer pixel coordinates and active buffer state. */
interface CachedPixelReadout {
  pxInt: number;
  pyInt: number;
  activeEpochIndex: number;
  wlMin: number;
  wlMax: number;
  epochBuffers: Float32Array[][] | null;
  flagsBuffers: Uint8Array[] | null;
  readout: LocalPixelReadout;
}

/** Props for {@link BlinkerCanvasViewport}. */
interface BlinkerCanvasViewportProps {
  stageRef: React.RefObject<HTMLDivElement>;
  canvasFrameRef: React.RefObject<HTMLDivElement>;
  frameRect: CanvasFrameRect;
  viewBox: { minX: number; minY: number; viewWidth: number; viewHeight: number };
  epochBuffers: Float32Array[][] | null;
  flagsBuffers: Uint8Array[] | null;
  renderSettings: ViewportRenderSettings;
  knownObjects: ReadonlyArray<KnownCelestialObject>;
  checkedIdSet: ReadonlySet<string>;
  trackedObjectIdSet: ReadonlySet<string>;
  trackedTargets: ReadonlyArray<TracedObjectSummary>;
  objectHighlighterColors: Readonly<Record<string, string>>;
  lockedCallout: CalloutRef | null;
  isCutoutLoading: boolean;
  isCutoutError?: boolean;
  loadingMessage?: string;
  errorMessage?: string;
  onSetViewportZoomPan: (zoom: number, panX: number, panY: number) => void;
  onResetViewportZoomPan?: () => void;
  onRetryLoad?: () => void;
  onCloseModal?: () => void;
  onSetLockedCallout: (next: CalloutRef | null) => void;
  onSetHoverCallout: (next: CalloutRef | null) => void;
  onClickLoadingCanvas: () => void;
  onClickToTrack: (imgX: number, imgY: number, activeEpochIndex: number) => void;
}

/**
 * Aligned 256x256 scientific pixel viewport with hollow 3-shape overlays,
 * non-blocking loading throbber, offscreen pixel-synthesis caching, and
 * isolated pixel hygiene tooltip state.
 *
 * @param props - Viewport refs, render settings, catalog/tracking overlays, and handlers.
 * @returns Rendered scientific canvas stage, SVG marker overlay, and hygiene tooltip.
 */
export const BlinkerCanvasViewport: React.FC<BlinkerCanvasViewportProps> = ({
  stageRef,
  canvasFrameRef,
  frameRect,
  viewBox,
  epochBuffers,
  flagsBuffers,
  renderSettings,
  knownObjects,
  checkedIdSet,
  trackedObjectIdSet,
  trackedTargets,
  objectHighlighterColors,
  lockedCallout,
  isCutoutLoading,
  isCutoutError = false,
  loadingMessage,
  errorMessage,
  onSetViewportZoomPan,
  onResetViewportZoomPan,
  onRetryLoad,
  onCloseModal,
  onSetLockedCallout,
  onSetHoverCallout,
  onClickLoadingCanvas,
  onClickToTrack,
}) => {
  const visibleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenImageDataRef = useRef<ImageData | null>(null);
  const hasOffscreenFrameRef = useRef<boolean>(false);
  const viewBoxRef = useRef(viewBox);
  const lastPixelReadoutRef = useRef<CachedPixelReadout | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const hoverCandidateKeyRef = useRef<string | null>(null);
  const panDragRef = useRef({
    active: false,
    moved: false,
    startClientX: 0,
    startClientY: 0,
    startPanX: 0,
    startPanY: 0,
  });
  const latestWheelZoomRef = useRef({
    zoom: renderSettings.zoom,
    panX: renderSettings.panX,
    panY: renderSettings.panY,
  });
  useEffect(() => {
    latestWheelZoomRef.current = {
      zoom: renderSettings.zoom,
      panX: renderSettings.panX,
      panY: renderSettings.panY,
    };
  }, [renderSettings.panX, renderSettings.panY, renderSettings.zoom]);

  useEffect(() => {
    const el = canvasFrameRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { zoom, panX, panY } = latestWheelZoomRef.current;
      const factor = e.deltaY < 0 ? 1.25 : 0.8;
      const clamped = clampViewportPanZoom(zoom * factor, panX, panY);
      onSetViewportZoomPan(clamped.zoom, clamped.panX, clamped.panY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [canvasFrameRef, onSetViewportZoomPan]);

  // Kept strictly local to BlinkerCanvasViewport so hover movement never re-renders the sidebar.
  const [hoverFlagTooltip, setHoverFlagTooltip] = useState<HoverFlagTooltipState | null>(null);

  const clearHoverTimer = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    hoverCandidateKeyRef.current = null;
  };

  useEffect(() => () => clearHoverTimer(), []);

  const blitOffscreenToVisible = useCallback(
    (vb: { minX: number; minY: number; viewWidth: number; viewHeight: number }) => {
      const canvas = visibleCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const offscreen = offscreenCanvasRef.current;
      if (!hasOffscreenFrameRef.current || !offscreen) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, GRID_WIDTH, GRID_HEIGHT);
        return;
      }

      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, GRID_WIDTH, GRID_HEIGHT);
      ctx.drawImage(
        offscreen,
        vb.minX,
        vb.minY,
        vb.viewWidth,
        vb.viewHeight,
        0,
        0,
        GRID_WIDTH,
        GRID_HEIGHT,
      );
    },
    [],
  );

  // Effect A: Crop & blit from the cached offscreen frame onto the visible canvas
  // whenever pan/zoom (`viewBox`) changes, avoiding any 65,536-pixel re-synthesis.
  useEffect(() => {
    viewBoxRef.current = viewBox;
    blitOffscreenToVisible(viewBox);
  }, [viewBox, blitOffscreenToVisible]);

  // Effect B: Synthesize 256x256 scientific RGBA pixels into the offscreen canvas
  // only when epoch data, comparison mode, wavelength slice, or stretch changes.
  useEffect(() => {
    if (!epochBuffers || epochBuffers.length === 0) {
      hasOffscreenFrameRef.current = false;
      blitOffscreenToVisible(viewBoxRef.current);
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

    let imageData = offscreenImageDataRef.current;
    if (!imageData) {
      imageData = offCtx.createImageData(GRID_WIDTH, GRID_HEIGHT);
      offscreenImageDataRef.current = imageData;
    }

    renderEpochBuffersToRgba({
      epochBuffers,
      flagsBuffers: flagsBuffers ?? undefined,
      activeEpochIndex: renderSettings.activeEpochIndex,
      comparisonMode: renderSettings.mode,
      contrastStretch: renderSettings.contrastStretch,
      wavelengthRangeUm: renderSettings.wavelengthRangeUm,
      passAIndex: renderSettings.passAIndex,
      passBIndex: renderSettings.passBIndex,
      coaddIndices: renderSettings.coaddIndices,
      showFlagsOverlay: false,
      outBuffer: imageData.data,
    });

    offCtx.putImageData(imageData, 0, 0);
    hasOffscreenFrameRef.current = true;
    blitOffscreenToVisible(viewBoxRef.current);
  }, [
    blitOffscreenToVisible,
    epochBuffers,
    flagsBuffers,
    renderSettings.activeEpochIndex,
    renderSettings.coaddIndices,
    renderSettings.contrastStretch,
    renderSettings.mode,
    renderSettings.passAIndex,
    renderSettings.passBIndex,
    renderSettings.wavelengthRangeUm,
  ]);

  const imageToScreen = (imgX: number, imgY: number) => ({
    sx: ((imgX - viewBox.minX) / viewBox.viewWidth) * frameRect.width,
    sy: ((imgY - viewBox.minY) / viewBox.viewHeight) * frameRect.height,
  });

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
      if (!checkedIdSet.has(obj.object_id) || trackedObjectIdSet.has(obj.object_id)) continue;
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

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement | null)?.closest?.('button, a, input, [role="button"]')) return;
    canvasFrameRef.current?.focus({ preventScroll: true });
    if (e.currentTarget.setPointerCapture) {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore capture errors in synthetic test environments
      }
    }
    panDragRef.current = {
      active: true,
      moved: false,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPanX: renderSettings.panX,
      startPanY: renderSettings.panY,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const frameEl = canvasFrameRef.current;
    const stageEl = stageRef.current;
    if (!frameEl || !stageEl) return;

    const fRect = frameEl.getBoundingClientRect();
    const sRect = stageEl.getBoundingClientRect();
    const localX = e.clientX - fRect.left;
    const localY = e.clientY - fRect.top;

    const drag = panDragRef.current;
    if (drag.active) {
      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;
      if (Math.hypot(dx, dy) > 4) {
        drag.moved = true;
        clearHoverTimer();
        onSetHoverCallout(null);
      }
      if (drag.moved && renderSettings.zoom > 1.0) {
        const deltaImgX = -(dx / Math.max(1, fRect.width)) * viewBox.viewWidth;
        const deltaImgY = -(dy / Math.max(1, fRect.height)) * viewBox.viewHeight;
        const clamped = clampViewportPanZoom(
          renderSettings.zoom,
          drag.startPanX + deltaImgX,
          drag.startPanY + deltaImgY,
        );
        onSetViewportZoomPan(clamped.zoom, clamped.panX, clamped.panY);
        setHoverFlagTooltip((prev) => (prev === null ? prev : null));
        return;
      }
    }

    if (localX < 0 || localY < 0 || localX > fRect.width || localY > fRect.height) {
      setHoverFlagTooltip((prev) => (prev === null ? prev : null));
      clearHoverTimer();
      onSetHoverCallout(null);
      return;
    }

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
        onSetHoverCallout(null);
        hoverTimerRef.current = window.setTimeout(() => {
          onSetHoverCallout(hit);
          observatoryLogger.info('blinker', 'callout_hover_show', { hitKey });
        }, HOVER_DETAILS_DELAY_MS);
      } else if (!hit && hoverCandidateKeyRef.current !== null) {
        clearHoverTimer();
        onSetHoverCallout(null);
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
    const pxInt = Math.max(0, Math.min(GRID_WIDTH - 1, Math.floor(ix)));
    const pyInt = Math.max(0, Math.min(GRID_HEIGHT - 1, Math.floor(iy)));
    const wlMin = renderSettings.wavelengthRangeUm[0];
    const wlMax = renderSettings.wavelengthRangeUm[1];

    const cached = lastPixelReadoutRef.current;
    const isSamePixelAndState =
      cached !== null &&
      cached.pxInt === pxInt &&
      cached.pyInt === pyInt &&
      cached.activeEpochIndex === renderSettings.activeEpochIndex &&
      cached.wlMin === wlMin &&
      cached.wlMax === wlMax &&
      cached.epochBuffers === epochBuffers &&
      cached.flagsBuffers === flagsBuffers;

    const readout = isSamePixelAndState
      ? cached.readout
      : computeLocalPixelReadout({
          epochBuffers,
          flagsBuffers,
          activeEpochIndex: renderSettings.activeEpochIndex,
          wavelengthRangeUm: renderSettings.wavelengthRangeUm,
          px: ix,
          py: iy,
        });

    if (!isSamePixelAndState) {
      lastPixelReadoutRef.current = {
        pxInt,
        pyInt,
        activeEpochIndex: renderSettings.activeEpochIndex,
        wlMin,
        wlMax,
        epochBuffers,
        flagsBuffers,
        readout,
      };
    }

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
      setHoverFlagTooltip((prev) => (prev === null ? prev : null));
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore release errors
      }
    }
    const drag = panDragRef.current;
    if (!drag.active) return;
    const wasMoved = drag.moved;
    panDragRef.current.active = false;
    if (wasMoved) return;

    if (isCutoutError) return;
    if (isCutoutLoading) {
      onClickLoadingCanvas();
      return;
    }

    const frameEl = canvasFrameRef.current;
    if (!frameEl) return;
    const fRect = frameEl.getBoundingClientRect();
    const localX = e.clientX - fRect.left;
    const localY = e.clientY - fRect.top;

    const hitLabeled = findHitLabeledObject(localX, localY);
    if (hitLabeled) {
      clearHoverTimer();
      onSetHoverCallout(null);
      onSetLockedCallout(hitLabeled);
      observatoryLogger.info('blinker', 'callout_click_lock', { ...hitLabeled });
      return;
    }

    if (lockedCallout) {
      onSetLockedCallout(null);
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
    if (!isImagePointInBounds(imgX, imgY)) return;

    observatoryLogger.info('blinker', 'click_to_track', {
      x: Number(imgX.toFixed(2)),
      y: Number(imgY.toFixed(2)),
      epoch: renderSettings.activeEpochIndex,
    });
    onClickToTrack(imgX, imgY, renderSettings.activeEpochIndex);
  };

  const handleCanvasKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      const clamped = clampViewportPanZoom(
        renderSettings.zoom * 1.25,
        renderSettings.panX,
        renderSettings.panY,
      );
      onSetViewportZoomPan(clamped.zoom, clamped.panX, clamped.panY);
      return;
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      const clamped = clampViewportPanZoom(
        renderSettings.zoom * 0.8,
        renderSettings.panX,
        renderSettings.panY,
      );
      onSetViewportZoomPan(clamped.zoom, clamped.panX, clamped.panY);
      return;
    }
    if (e.key === '0') {
      e.preventDefault();
      if (onResetViewportZoomPan) {
        onResetViewportZoomPan();
      } else {
        onSetViewportZoomPan(1.0, 0.0, 0.0);
      }
      return;
    }
    if (renderSettings.zoom <= 1.0) return;
    const stepFrac = e.shiftKey ? 0.05 : 0.15;
    const dxImg = viewBox.viewWidth * stepFrac;
    const dyImg = viewBox.viewHeight * stepFrac;
    let nextPanX = renderSettings.panX;
    let nextPanY = renderSettings.panY;
    if (e.key === 'ArrowLeft') nextPanX -= dxImg;
    else if (e.key === 'ArrowRight') nextPanX += dxImg;
    else if (e.key === 'ArrowUp') nextPanY -= dyImg;
    else if (e.key === 'ArrowDown') nextPanY += dyImg;
    else return;
    e.preventDefault();
    const clamped = clampViewportPanZoom(renderSettings.zoom, nextPanX, nextPanY);
    onSetViewportZoomPan(clamped.zoom, clamped.panX, clamped.panY);
  };

  const decodedHoverFlags = hoverFlagTooltip
    ? decodeHygieneFlagMask(hoverFlagTooltip.flagByte)
    : null;

  return (
    <>
      <div
        ref={canvasFrameRef}
        className="blinker-canvas-frame"
        data-testid="blinker-canvas-frame"
        tabIndex={0}
        aria-label="Sky Patch Blinker Canvas (use + and - to zoom, 0 to reset, Arrow keys to pan when zoomed)"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          panDragRef.current.active = false;
        }}
        onPointerLeave={() => {
          panDragRef.current.active = false;
          lastPixelReadoutRef.current = null;
          setHoverFlagTooltip((prev) => (prev === null ? prev : null));
          clearHoverTimer();
          onSetHoverCallout(null);
        }}
        onKeyDown={handleCanvasKeyDown}
      >
        <canvas
          ref={visibleCanvasRef}
          width={GRID_WIDTH}
          height={GRID_HEIGHT}
          className="blinker-pixel-canvas"
          data-testid="blinker-pixel-canvas"
        />

        <svg
          className="blinker-marker-svg"
          viewBox={`0 0 ${frameRect.width} ${frameRect.height}`}
          data-testid="blinker-marker-overlay"
        >
          {knownObjects
            .filter(
              (obj) => checkedIdSet.has(obj.object_id) && !trackedObjectIdSet.has(obj.object_id),
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
              if (sx < -24 || sx > frameRect.width + 24 || sy < -24 || sy > frameRect.height + 24) {
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
                      points={`${sx},${sy - 15} ${sx + 15},${sy} ${sx},${sy + 15} ${sx - 15},${sy}`}
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
                    style={{ pointerEvents: 'none', fontFamily: 'Inter, system-ui, sans-serif' }}
                  >
                    {obj.label}
                  </text>
                </g>
              );
            })}

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
                    style={{ pointerEvents: 'none', fontFamily: 'Inter, system-ui, sans-serif' }}
                  >
                    {track.matchedLabel}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {isCutoutError ? (
          <div
            className="blinker-loading-throbber blinker-error-overlay"
            data-testid="blinker-error-overlay"
            role="alert"
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            <div className="blinker-error-title">Unable to load sky patch</div>
            <div className="blinker-error-detail">
              {errorMessage || 'Upstream observatory archives failed to respond.'}
            </div>
            <div className="blinker-error-actions">
              {onRetryLoad && (
                <button
                  type="button"
                  className="hud-btn-primary"
                  data-testid="blinker-retry-btn"
                  onClick={onRetryLoad}
                >
                  Retry
                </button>
              )}
              {onCloseModal && (
                <button
                  type="button"
                  className="hud-btn-secondary"
                  data-testid="blinker-error-close-btn"
                  onClick={onCloseModal}
                >
                  Close
                </button>
              )}
            </div>
          </div>
        ) : (
          isCutoutLoading && (
            <div
              className="blinker-loading-throbber"
              data-testid="blinker-loading-throbber"
              role="status"
              aria-live="polite"
            >
              <div className="blinker-spinner-ring" aria-hidden="true" />
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                {loadingMessage || 'Calibrating archival infrared passes...'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Sidebar controls and Known Objects remain interactive
              </div>
            </div>
          )
        )}
      </div>

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
    </>
  );
};
