import React, { useEffect, useRef, useState } from 'react';
import {
  clampViewportPanZoom,
  GRID_HEIGHT,
  GRID_WIDTH,
  screenToImageCoordinates,
  type KnownCelestialObject,
  type TracedObjectSummary,
  type ViewportRenderSettings,
} from '../../types/contracts';
import { HOVER_DETAILS_DELAY_MS } from '../../utils/calloutPlacement';
import { observatoryLogger } from '../../utils/observatoryLogger';
import { decodeHygieneFlagMask, getMarkerShapeKind } from '../../utils/observatoryMath';
import { computeLocalPixelReadout, renderEpochBuffersToImageData } from '../../utils/pixelEngine';
import { isImagePointInBounds, type CalloutRef, type CanvasFrameRect } from './calloutBuilder';

interface HoverFlagTooltipState {
  stageX: number;
  stageY: number;
  ix: number;
  iy: number;
  flux: number;
  variance: number;
  flagByte: number;
}

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
  loadingMessage?: string;
  onSetViewportZoomPan: (zoom: number, panX: number, panY: number) => void;
  onSetLockedCallout: (next: CalloutRef | null) => void;
  onSetHoverCallout: (next: CalloutRef | null) => void;
  onClickLoadingCanvas: () => void;
  onClickToTrack: (imgX: number, imgY: number, activeEpochIndex: number) => void;
}

/**
 * Aligned 256x256 scientific pixel viewport with hollow 3-shape overlays,
 * non-blocking loading throbber, and isolated pixel hygiene tooltip state.
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
  loadingMessage,
  onSetViewportZoomPan,
  onSetLockedCallout,
  onSetHoverCallout,
  onClickLoadingCanvas,
  onClickToTrack,
}) => {
  const visibleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
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

  useEffect(() => {
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
      showFlagsOverlay: false,
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
    renderSettings.activeEpochIndex,
    renderSettings.coaddIndices,
    renderSettings.contrastStretch,
    renderSettings.mode,
    renderSettings.passAIndex,
    renderSettings.passBIndex,
    renderSettings.wavelengthRangeUm,
    viewBox,
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
        setHoverFlagTooltip(null);
        return;
      }
    }

    if (localX < 0 || localY < 0 || localX > fRect.width || localY > fRect.height) {
      setHoverFlagTooltip(null);
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

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = panDragRef.current;
    if (!drag.active) return;
    const wasMoved = drag.moved;
    panDragRef.current.active = false;
    if (wasMoved) return;

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

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.25 : 0.8;
    const clamped = clampViewportPanZoom(
      renderSettings.zoom * factor,
      renderSettings.panX,
      renderSettings.panY,
    );
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
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => {
          panDragRef.current.active = false;
          setHoverFlagTooltip(null);
          clearHoverTimer();
          onSetHoverCallout(null);
        }}
        onWheel={handleWheel}
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

        {isCutoutLoading && (
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
