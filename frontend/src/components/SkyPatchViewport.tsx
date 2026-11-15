import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSkyExplorer } from '../context/SkyExplorerContext';
import {
  clampViewportPanZoom,
  computeViewportViewBox,
  pixelToSkyWcs,
  screenToImageCoordinates,
} from '../types/contracts';
import {
  inferObjectClass,
  isMovingSolarSystemObject,
  renderEpochBuffersToRgba,
} from '../utils/knownObjectSelection';

interface SkyPatchViewportProps {
  showLabels: boolean;
}

interface HoverReadout {
  x: number;
  y: number;
  ra?: number;
  dec?: number;
}

export const SkyPatchViewport: React.FC<SkyPatchViewportProps> = ({ showLabels }) => {
  const {
    manifest,
    epochBuffers,
    flagsBuffers,
    renderSettings,
    knownObjects,
    objectHighlighterColors,
    trackedTargets,
    inspectPixelOrCoord,
    setViewportZoomPan,
  } = useSkyExplorer();

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragStateRef = useRef<{
    active: boolean;
    didDrag: boolean;
    startClientX: number;
    startClientY: number;
    startPanX: number;
    startPanY: number;
  }>({
    active: false,
    didDrag: false,
    startClientX: 0,
    startClientY: 0,
    startPanX: 0,
    startPanY: 0,
  });

  const [isDragging, setIsDragging] = useState(false);
  const [hoverReadout, setHoverReadout] = useState<HoverReadout | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rgba = renderEpochBuffersToRgba({
      epochBuffers,
      flagsBuffers,
      activeEpochIndex: renderSettings.activeEpochIndex,
      comparisonMode: renderSettings.mode,
      contrastStretch: renderSettings.contrastStretch,
      wavelengthRangeUm: renderSettings.wavelengthRangeUm,
    });
    const imageData = new ImageData(new Uint8ClampedArray(rgba), 256, 256);
    ctx.putImageData(imageData, 0, 0);
  }, [
    epochBuffers,
    flagsBuffers,
    renderSettings.activeEpochIndex,
    renderSettings.mode,
    renderSettings.contrastStretch,
    renderSettings.wavelengthRangeUm,
  ]);

  const clampedPanZoom = useMemo(
    () => clampViewportPanZoom(renderSettings.zoom, renderSettings.panX, renderSettings.panY),
    [renderSettings.zoom, renderSettings.panX, renderSettings.panY],
  );

  const viewBox = useMemo(
    () => computeViewportViewBox(clampedPanZoom.zoom, clampedPanZoom.panX, clampedPanZoom.panY),
    [clampedPanZoom.zoom, clampedPanZoom.panX, clampedPanZoom.panY],
  );

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      const nextZoom = Math.max(1.0, Math.min(8.0, clampedPanZoom.zoom * factor));
      setViewportZoomPan(nextZoom, clampedPanZoom.panX, clampedPanZoom.panY);
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [clampedPanZoom.zoom, clampedPanZoom.panX, clampedPanZoom.panY, setViewportZoomPan]);

  const checkedKnownObjects = useMemo(
    () => knownObjects.filter((obj) => renderSettings.checkedObjectIds.includes(obj.object_id)),
    [knownObjects, renderSettings.checkedObjectIds],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragStateRef.current = {
      active: clampedPanZoom.zoom > 1.0,
      didDrag: false,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPanX: clampedPanZoom.panX,
      startPanY: clampedPanZoom.panY,
    };
    if (clampedPanZoom.zoom > 1.0) {
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();

    if (dragStateRef.current.active && rect.width > 0 && rect.height > 0) {
      const dx = e.clientX - dragStateRef.current.startClientX;
      const dy = e.clientY - dragStateRef.current.startClientY;
      if (Math.hypot(dx, dy) > 4) {
        dragStateRef.current.didDrag = true;
        setIsDragging(true);
      }
      if (dragStateRef.current.didDrag) {
        const nextPanX = dragStateRef.current.startPanX - (dx / rect.width) * viewBox.viewWidth;
        const nextPanY = dragStateRef.current.startPanY - (dy / rect.height) * viewBox.viewHeight;
        setViewportZoomPan(clampedPanZoom.zoom, nextPanX, nextPanY);
        return;
      }
    }

    const mapped = screenToImageCoordinates(
      e.clientX,
      e.clientY,
      rect,
      clampedPanZoom.zoom,
      clampedPanZoom.panX,
      clampedPanZoom.panY,
    );
    if (mapped.inBounds) {
      const sky = manifest?.wcs ? pixelToSkyWcs(mapped.x, mapped.y, manifest.wcs) : undefined;
      setHoverReadout({
        x: mapped.x,
        y: mapped.y,
        ra: sky?.ra,
        dec: sky?.dec,
      });
    } else {
      setHoverReadout(null);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current.active && e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const wasDrag = dragStateRef.current.didDrag;
    dragStateRef.current.active = false;
    setIsDragging(false);
    if (wasDrag) {
      return;
    }

    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const mapped = screenToImageCoordinates(
      e.clientX,
      e.clientY,
      rect,
      clampedPanZoom.zoom,
      clampedPanZoom.panX,
      clampedPanZoom.panY,
    );
    if (mapped.inBounds) {
      inspectPixelOrCoord(mapped.x, mapped.y, renderSettings.activeEpochIndex);
    }
  };

  const handlePointerLeave = () => {
    dragStateRef.current.active = false;
    setIsDragging(false);
    setHoverReadout(null);
  };

  const epochsCount = manifest?.epochs?.length ?? 0;

  return (
    <div
      ref={viewportRef}
      className={`sky-viewport-stage${isDragging ? ' is-dragging' : ''}`}
      role="application"
      aria-label="Interactive 256 by 256 Sky Patch Viewport. Click to track a celestial source, scroll to zoom, or drag when zoomed in to pan."
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    >
      <canvas
        ref={canvasRef}
        width={256}
        height={256}
        className="sky-viewport-canvas"
        style={{
          transformOrigin: 'center center',
          transform: `scale(${clampedPanZoom.zoom}) translate(${-(clampedPanZoom.panX / 256) * 100}%, ${-(clampedPanZoom.panY / 256) * 100}%)`,
        }}
      />

      <svg viewBox={viewBox.svgViewBox} className="sky-viewport-svg" aria-hidden="true">
        <defs>
          {trackedTargets.map((track, idx) => (
            <marker
              key={`marker-${track.trackId}`}
              id={`track-arrow-${idx}`}
              markerWidth="5"
              markerHeight="5"
              refX="4"
              refY="2.5"
              orient="auto"
            >
              <path d="M0,0 L5,2.5 L0,5 Z" fill={track.color} />
            </marker>
          ))}
        </defs>

        {checkedKnownObjects.map((obj) => {
          const epPos = obj.epoch_positions[renderSettings.activeEpochIndex] ?? obj;
          const highlighterColor = objectHighlighterColors?.[obj.object_id] ?? '#00F5D4';
          const objClass = inferObjectClass(obj);
          const isMover = isMovingSolarSystemObject(obj);
          const trailPoints =
            isMover && obj.epoch_positions.length >= 2
              ? obj.epoch_positions.map((p) => `${p.x},${p.y}`).join(' ')
              : '';
          return (
            <g key={obj.object_id}>
              {trailPoints && (
                <polyline
                  points={trailPoints}
                  fill="none"
                  stroke={highlighterColor}
                  strokeWidth={1.1}
                  strokeDasharray="3 2"
                  opacity={0.85}
                />
              )}
              {objClass === 'brown_dwarf' ? (
                <polygon
                  points={`${epPos.x},${epPos.y - 5.5} ${epPos.x + 5.5},${epPos.y} ${epPos.x},${epPos.y + 5.5} ${epPos.x - 5.5},${epPos.y}`}
                  fill="none"
                  stroke={highlighterColor}
                  strokeWidth={1.3}
                />
              ) : objClass === 'galaxy' || objClass === 'nebula' ? (
                <ellipse
                  cx={epPos.x}
                  cy={epPos.y}
                  rx={6}
                  ry={3.5}
                  fill="none"
                  stroke={highlighterColor}
                  strokeWidth={1.3}
                />
              ) : isMover ? (
                <>
                  <circle
                    cx={epPos.x}
                    cy={epPos.y}
                    r={6}
                    fill="none"
                    stroke={highlighterColor}
                    strokeWidth={1.3}
                    strokeDasharray="2 1.5"
                  />
                  <circle
                    cx={epPos.x}
                    cy={epPos.y}
                    r={2.5}
                    fill="none"
                    stroke={highlighterColor}
                    strokeWidth={1.2}
                  />
                </>
              ) : (
                <circle
                  cx={epPos.x}
                  cy={epPos.y}
                  r={4.5}
                  fill="none"
                  stroke={highlighterColor}
                  strokeWidth={1.3}
                />
              )}
              {showLabels && (
                <text x={epPos.x + 6} y={epPos.y - 4} fill={highlighterColor} fontSize={7}>
                  {obj.label}
                </text>
              )}
            </g>
          );
        })}

        {trackedTargets.map((track, idx) => {
          const activeWp =
            track.waypoints[renderSettings.activeEpochIndex] ??
            track.waypoints[track.originEpochIndex];
          if (!activeWp) return null;
          const visibleWaypoints = track.waypoints.filter((w) => w.visible);
          const pointsAttr = visibleWaypoints.map((w) => `${w.x},${w.y}`).join(' ');
          const firstWp = visibleWaypoints[0];
          const lastWp = visibleWaypoints[visibleWaypoints.length - 1];
          const showVectorArrow =
            Boolean(firstWp && lastWp) &&
            Math.hypot(lastWp.x - firstWp.x, lastWp.y - firstWp.y) > 0.5;
          return (
            <g key={track.trackId}>
              {pointsAttr && (
                <polyline
                  points={pointsAttr}
                  fill="none"
                  stroke={track.color}
                  strokeWidth={1.2}
                  strokeDasharray="2 2"
                />
              )}
              {showVectorArrow && (
                <line
                  x1={firstWp.x}
                  y1={firstWp.y}
                  x2={lastWp.x}
                  y2={lastWp.y}
                  stroke={track.color}
                  strokeWidth={1.3}
                  markerEnd={`url(#track-arrow-${idx})`}
                  opacity={0.9}
                />
              )}
              <rect
                x={activeWp.x - 5}
                y={activeWp.y - 5}
                width={10}
                height={10}
                fill="none"
                stroke={track.color}
                strokeWidth={1.6}
                strokeDasharray={activeWp.status === 'tracked' ? undefined : '2 2'}
              />
            </g>
          );
        })}
      </svg>

      {/* Non-blocking Telemetry HUD */}
      <div className="viewport-hud-top" aria-hidden="true">
        <span className="hud-pill">
          Epoch {epochsCount > 0 ? renderSettings.activeEpochIndex + 1 : 0}/{epochsCount}
        </span>
        <span className="hud-pill">{clampedPanZoom.zoom.toFixed(1)}&times;</span>
      </div>

      {hoverReadout && (
        <div className="viewport-hud-bottom" aria-hidden="true">
          <span className="hud-pill">
            px ({hoverReadout.x.toFixed(1)}, {hoverReadout.y.toFixed(1)})
            {hoverReadout.ra !== undefined && hoverReadout.dec !== undefined
              ? ` • RA ${hoverReadout.ra.toFixed(4)}° Dec ${hoverReadout.dec.toFixed(4)}°`
              : ''}
          </span>
        </div>
      )}
    </div>
  );
};

export default SkyPatchViewport;
