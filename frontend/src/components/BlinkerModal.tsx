import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSkyExplorer } from '../context/SkyExplorerContext';
import {
  clampViewportPanZoom,
  computeViewportViewBox,
  GRID_HEIGHT,
  GRID_WIDTH,
  screenToImageCoordinates,
  type ComparisonMode,
  type ContrastStretch,
  type MissionName,
} from '../types/contracts';
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
  SpinnerIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from './icons/ObservatoryIcons';

const MISSIONS_FILTER_LIST: ReadonlyArray<MissionName> = ['SPHEREx', 'WISE', 'NEOSSat'];

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
    loadingState,
    renderSettings,
    updateRenderSettings,
    setViewportZoomPan,
    resetViewportZoomPan,
    knownObjects,
    objectHighlighterColors = {},
    trackedTargets,
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

  const [controlsFolded, setControlsFolded] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(BLINKER_CONTROLS_FOLDED_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasFrameRef = useRef<HTMLDivElement | null>(null);
  const visibleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);

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

  // Close Blinker Modal cleanly on Escape key
  useEffect(() => {
    if (!isBlinkerModalOpen) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeBlinkerModal?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeBlinkerModal, isBlinkerModalOpen]);

  // Measure canvas frame geometry inside modal stage for pixel-exact SVG overlay & leader lines
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
    window.addEventListener('resize', measure);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
    };
  }, [isBlinkerModalOpen, isSpectraModalOpen]);

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
      return;
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
    const { x: imgX, y: imgY } = screenToImageCoordinates(
      e.clientX,
      e.clientY,
      fRect,
      renderSettings.zoom,
      renderSettings.panX,
      renderSettings.panY,
    );
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

  // Compute stage geometry for angled leader line (Vector 1) & 288x87px Callout Card (Frame 34)
  let calloutGeometry: {
    markerStageX: number;
    markerStageY: number;
    kneeX: number;
    kneeY: number;
    cardLeft: number;
    cardTop: number;
    anchorX: number;
    anchorY: number;
    color: string;
  } | null = null;

  if (selectedObject && manifest) {
    const wp = selectedObject.waypoints[renderSettings.activeEpochIndex] ??
      selectedObject.waypoints[selectedObject.originEpochIndex] ?? {
        x: selectedObject.originCentroidX,
        y: selectedObject.originCentroidY,
      };
    const { sx, sy } = imageToScreen(wp.x, wp.y);
    const markerStageX = frameRect.leftInStage + sx;
    const markerStageY = frameRect.topInStage + sy;

    const cardW = 288;
    const cardH = 87;
    const cardLeft = Math.max(
      14,
      Math.min(
        frameRect.stageW - cardW - 14,
        frameRect.leftInStage + frameRect.width + 18 > frameRect.stageW - cardW
          ? frameRect.stageW - cardW - 14
          : frameRect.leftInStage + frameRect.width - 24,
      ),
    );
    const cardTop = Math.max(
      14,
      Math.min(frameRect.stageH - cardH - 64, markerStageY - cardH * 0.5),
    );
    const anchorX = cardLeft;
    const anchorY = cardTop + cardH * 0.5;
    const kneeX = Math.max(markerStageX + 18, anchorX - 24);
    const kneeY = anchorY;

    calloutGeometry = {
      markerStageX,
      markerStageY,
      kneeX,
      kneeY,
      cardLeft,
      cardTop,
      anchorX,
      anchorY,
      color: selectedObject.color,
    };
  }

  const decodedHoverFlags = hoverFlagTooltip
    ? decodeHygieneFlagMask(hoverFlagTooltip.flagByte)
    : null;

  const sectionSubtitle = (() => {
    if (!manifest) return 'Loading calibrated SPHEREx planes...';
    if (renderSettings.mode === 'subtract') {
      return `Diff: Pass ${renderSettings.passBIndex + 1} (${
        passBEpoch?.iso_date?.slice(0, 10) ?? '—'
      }, ${passBEpoch?.mission ?? 'SPHEREx'}) − Pass ${renderSettings.passAIndex + 1} (${
        passAEpoch?.iso_date?.slice(0, 10) ?? '—'
      }, ${passAEpoch?.mission ?? 'SPHEREx'})`;
    }
    if (renderSettings.mode === 'coadd') {
      const count = renderSettings.coaddIndices.length || totalEpochs;
      return `Co-Added Stack (${count} passes: #${renderSettings.passAIndex + 1}–#${
        renderSettings.passBIndex + 1
      }) · ${manifest.data_source_summary.primary_mission ?? 'SPHEREx'}`;
    }
    return `Pass ${renderSettings.activeEpochIndex + 1}/${totalEpochs} · ${
      activeEpoch?.iso_date?.slice(0, 10) ?? '—'
    } · ${activeEpoch?.mission ?? 'SPHEREx'}`;
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

          <div className="blinker-header-right">
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
        <div ref={stageRef} className="blinker-stage">
          {/* Top-Left Foldable Controls Card (Frame 1 - 291px) */}
          <aside
            className="blinker-controls-card"
            aria-label="Infrared Blinker & Wavelength Controls"
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
                {/* 1. Dual-Thumb Wavelength Slice Slider (Dim & Pop) */}
                <div>
                  <DualThumbRangeSlider
                    label="Wavelength Slice"
                    min={0.75}
                    max={5.0}
                    step={0.05}
                    minGap={0.15}
                    value={renderSettings.wavelengthRangeUm}
                    formatReadout={(lo, hi) => `${lo.toFixed(2)}–${hi.toFixed(2)} µm`}
                    lowAriaLabel="Minimum wavelength micrometers"
                    highAriaLabel="Maximum wavelength micrometers"
                    testId="wavelength-dual-slider"
                    onChange={(next) => updateRenderSettings({ wavelengthRangeUm: next })}
                  />
                  <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                    {[
                      { label: 'All 0.75–5.0', range: [0.75, 5.0] as [number, number] },
                      { label: 'Cold 3.8–5.0', range: [3.8, 5.0] as [number, number] },
                      { label: 'Ice 2.4–3.8', range: [2.4, 3.8] as [number, number] },
                    ].map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        className="hud-btn-secondary"
                        style={{ height: 22, padding: '0 6px', fontSize: 10 }}
                        onClick={() => updateRenderSettings({ wavelengthRangeUm: preset.range })}
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
                        renderSettings.mode === 'coadd' ? 'Co-Add Pass Span' : 'Pass Pair Window'
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
                        renderSettings.mode === 'subtract' ? `P${hi} − P${lo}` : `P${lo} .. P${hi}`
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

                {/* 3. Mission Source Filter Pills (SPHEREx, WISE, NEOSSat) */}
                <div>
                  <div className="control-section-header" style={{ marginBottom: 4 }}>
                    <span className="control-section-title">Mission Sources</span>
                  </div>
                  <div className="mission-filter-row" data-testid="mission-filter-row">
                    {MISSIONS_FILTER_LIST.map((mission) => {
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

            {(!epochBuffers ||
              loadingState.stage === 'loading_catalogs' ||
              loadingState.stage === 'loading_cutouts') && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  background: 'rgba(0, 0, 0, 0.6)',
                  color: 'var(--text-secondary)',
                  fontSize: 13,
                }}
              >
                <SpinnerIcon size={20} />
                <span>{loadingState.message ?? 'Loading scientific detector planes...'}</span>
              </div>
            )}

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
                  </g>
                );
              })}
            </svg>
          </div>

          {/* Vector 1 Angled Leader Line Overlay connecting □ edge to Callout Card */}
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
                points={`${(calloutGeometry.markerStageX + 13).toFixed(1)},${calloutGeometry.markerStageY.toFixed(1)} ${calloutGeometry.kneeX.toFixed(1)},${calloutGeometry.kneeY.toFixed(1)} ${calloutGeometry.anchorX.toFixed(1)},${calloutGeometry.anchorY.toFixed(1)}`}
                fill="none"
                stroke={calloutGeometry.color}
                strokeWidth={1.75}
                strokeLinejoin="round"
                opacity={0.9}
              />
            </svg>
          )}

          {/* Callout Card (Frame 34 - 288x87px) with Speed & On-Demand Spectra Button */}
          {calloutGeometry && selectedObject && (
            <div
              className="callout-card"
              role="region"
              aria-label="Selected Target Callout Card"
              data-testid="blinker-callout-card"
              style={{
                left: calloutGeometry.cardLeft,
                top: calloutGeometry.cardTop,
                borderColor: `${calloutGeometry.color}88`,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 6,
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {selectedObject.matchedLabel ?? 'Uncataloged Moving Source'}
                </span>
                <span
                  className="mono"
                  style={{ fontSize: 11, color: calloutGeometry.color, flexShrink: 0 }}
                >
                  {selectedObject.properMotionArcsecPerYr.toFixed(2)}″/yr
                </span>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <span className="badge-pill">
                  {selectedObject.matchedCatalog
                    ? selectedObject.matchedCatalog.toUpperCase()
                    : 'CANDIDATE'}
                </span>
                <button
                  type="button"
                  className="hud-btn-primary"
                  style={{ height: 28, padding: '0 10px', fontSize: 11 }}
                  data-testid="view-spectrum-btn"
                  onClick={() => openSelectedSpectrum?.()}
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
