import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SkyExplorerProvider, useSkyExplorer } from './context/SkyExplorerContext';
import {
  computeViewportViewBox,
  screenToImageCoordinates,
  type EarthToSkyResponse,
} from './types/contracts';
import { ViewportControlsBar } from './components/ViewportControlsBar';
import { KnownObjectsCheckboxMenu } from './components/KnownObjectsCheckboxMenu';
import {
  catalogBadgeLabel,
  inferObjectClass,
  isMovingSolarSystemObject,
  objectClassBadgeLabel,
  renderEpochBuffersToRgba,
} from './utils/knownObjectSelection';

const PRESET_SLUGS = [
  { slug: 'wise_0855', label: 'WISE 0855 (Brown Dwarf)' },
  { slug: 'barnards_star', label: "Barnard's Star (Fast Mover)" },
  { slug: 'epsilon_indi_b', label: 'Epsilon Indi B (T-Dwarf Pair)' },
  { slug: 'rw_aurigae', label: 'RW Aurigae (Variable Star)' },
  { slug: 'r_draconis', label: 'R Draconis (Mira Giant)' },
  { slug: 'comet_3i_atlas', label: 'Comet 3I/ATLAS (Solar System)' },
  { slug: 'luhman_16', label: 'Luhman 16 AB (Binary Brown Dwarf)' },
  { slug: 'wolf_359', label: 'Wolf 359 (Nearby Flare Star)' },
  { slug: 'teegardens_star', label: "Teegarden's Star (Ultracool M-Dwarf)" },
  { slug: 'cw_leonis', label: 'CW Leonis (Carbon AGB Star)' },
  { slug: 't_tauri', label: 'T Tauri (Prototype YSO)' },
  { slug: 'ceres_asteroid', label: '(1) Ceres (Dwarf Planet)' },
];

const StarHuntersWorkspace: React.FC = () => {
  const {
    activePresetSlug,
    manifest,
    epochBuffers,
    flagsBuffers,
    loadingState,
    renderSettings,
    knownObjects,
    objectHighlighterColors,
    selectedObject,
    trackedTargets,
    lastClickDiagnostic,
    removeTrackedTarget,
    clearTrackedTargets,
    selectPreset,
    navigateToCoordinates,
    inspectPixelOrCoord,
  } = useSkyExplorer();

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [zenithBanner, setZenithBanner] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState<boolean>(true);

  useEffect(() => {
    if (activePresetSlug && !manifest && loadingState.stage === 'idle') {
      selectPreset(activePresetSlug);
    }
  }, [activePresetSlug, manifest, loadingState.stage, selectPreset]);

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

  const viewBox = useMemo(
    () => computeViewportViewBox(renderSettings.zoom, renderSettings.panX, renderSettings.panY),
    [renderSettings.zoom, renderSettings.panX, renderSettings.panY],
  );

  const handleViewportClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const mapped = screenToImageCoordinates(
      e.clientX,
      e.clientY,
      rect,
      renderSettings.zoom,
      renderSettings.panX,
      renderSettings.panY,
    );
    if (mapped.inBounds) {
      inspectPixelOrCoord(mapped.x, mapped.y, renderSettings.activeEpochIndex);
    }
  };

  const handleWhatsAboveMe = async () => {
    try {
      const res = await fetch('/api/v1/earth-to-sky');
      if (!res.ok) return;
      const data = (await res.json()) as EarthToSkyResponse;
      const locLabel = data.earth.is_fallback_capital
        ? `${data.earth.city_name ?? 'Capital'}, ${data.earth.country ?? ''} (Random Capital Fallback)`
        : `(${data.earth.lat.toFixed(2)}°, ${data.earth.lon.toFixed(2)}°)`;
      setZenithBanner(
        `Zenith over ${locLabel}: RA ${data.zenith_icrs.ra.toFixed(2)}°, Dec ${data.zenith_icrs.dec.toFixed(2)}° (${data.zenith_icrs.constellation})`,
      );
      navigateToCoordinates(data.zenith_icrs.ra, data.zenith_icrs.dec, 5.0);
    } catch {
      // Offline fallback
    }
  };

  const checkedKnownObjects = useMemo(
    () => knownObjects.filter((obj) => renderSettings.checkedObjectIds.includes(obj.object_id)),
    [knownObjects, renderSettings.checkedObjectIds],
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Star Hunters — Planet X &amp; SPHEREx Blinker</h1>
          <p className="subtitle">
            Multi-Epoch Near-Infrared Blinker (0.75–5.0 &mu;m) &bull; SPHEREx + WISE/NEOWISE + Gaia
            DR3 + MOST
          </p>
        </div>
        <div className="preset-bar">
          {PRESET_SLUGS.map((p) => (
            <button
              key={p.slug}
              type="button"
              className={activePresetSlug === p.slug ? 'preset-btn active' : 'preset-btn'}
              onClick={() => selectPreset(p.slug)}
            >
              {p.label}
            </button>
          ))}
          <button type="button" className="preset-btn" onClick={() => void handleWhatsAboveMe()}>
            What&apos;s Above Me? (Zenith / Capital Fallback)
          </button>
        </div>
      </header>

      {zenithBanner && (
        <div className="diagnostic-banner" role="status">
          {zenithBanner}
        </div>
      )}

      <main className="workspace-grid">
        <section className="viewport-panel">
          <div className="panel-header">
            <h2>
              256&times;256 Sky Patch Viewport{' '}
              {manifest ? `— ${manifest.target_metadata.name}` : ''}
            </h2>
            <span className="status-badge">
              Stage: {loadingState.stage}
              {loadingState.fromClientCache ? ' (Cached in Browser)' : ''} &bull; Zoom:{' '}
              {renderSettings.zoom.toFixed(1)}&times; &bull; Pan: ({renderSettings.panX.toFixed(0)},{' '}
              {renderSettings.panY.toFixed(0)})
            </span>
          </div>

          {/* Viewport Controls Bar Component */}
          <ViewportControlsBar />

          <div className="secondary-action-bar">
            <button
              type="button"
              className="mode-btn"
              onClick={() => inspectPixelOrCoord(124, 126, renderSettings.activeEpochIndex)}
            >
              Track Target (124, 126)
            </button>
            <button
              type="button"
              className={showLabels ? 'mode-btn active' : 'mode-btn'}
              onClick={() => setShowLabels((prev) => !prev)}
            >
              Labels: {showLabels ? 'ON' : 'OFF'}
            </button>
            {trackedTargets.length > 0 && (
              <button type="button" className="mode-btn" onClick={clearTrackedTargets}>
                Clear Tracks ({trackedTargets.length})
              </button>
            )}
          </div>

          <div
            ref={viewportRef}
            className="sky-viewport-stage"
            onClick={handleViewportClick}
            style={{
              position: 'relative',
              width: 256,
              height: 256,
              overflow: 'hidden',
              border: '1px solid #334155',
              cursor: 'crosshair',
              marginBottom: 12,
            }}
          >
            <canvas
              ref={canvasRef}
              width={256}
              height={256}
              style={{
                width: '100%',
                height: '100%',
                display: 'block',
                transformOrigin: 'center center',
                transform: `scale(${renderSettings.zoom}) translate(${-renderSettings.panX}px, ${-renderSettings.panY}px)`,
              }}
            />
            <svg
              viewBox={viewBox.svgViewBox}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
              }}
            >
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

              {trackedTargets.map((track) => {
                const activeWp =
                  track.waypoints[renderSettings.activeEpochIndex] ??
                  track.waypoints[track.originEpochIndex];
                if (!activeWp) return null;
                const pointsAttr = track.waypoints
                  .filter((w) => w.visible)
                  .map((w) => `${w.x},${w.y}`)
                  .join(' ');
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
          </div>

          {lastClickDiagnostic && lastClickDiagnostic.status === 'no_body_found' && (
            <div className="diagnostic-banner" role="status">
              {lastClickDiagnostic.message}
            </div>
          )}

          {selectedObject &&
            (() => {
              const matchedKnown = selectedObject.matchedObjectId
                ? knownObjects.find((o) => o.object_id === selectedObject.matchedObjectId)
                : undefined;
              const matchedClass = matchedKnown ? inferObjectClass(matchedKnown) : null;
              return (
                <div className="traced-card">
                  <h3>
                    Focused Track ({selectedObject.trackId}) — Clicked Frame #
                    {selectedObject.originEpochIndex + 1}
                  </h3>
                  <p>
                    <span
                      style={{
                        display: 'inline-block',
                        width: 12,
                        height: 12,
                        border: `2px solid ${selectedObject.color}`,
                        marginRight: 6,
                      }}
                    />
                    Origin Centroid: ({selectedObject.originCentroidX},{' '}
                    {selectedObject.originCentroidY}) &bull; Proper Motion:{' '}
                    {selectedObject.properMotionArcsecPerYr}&Prime;/yr &bull; Match:{' '}
                    {selectedObject.matchedLabel ?? 'Uncataloged Mover Candidate'}
                    {selectedObject.isOverlappedAtOrigin ? ' • Overlapped Body Branch' : ''}
                  </p>
                  {matchedKnown && (
                    <p className="obj-meta">
                      Class: {matchedClass ? objectClassBadgeLabel(matchedClass) : 'Object'}
                      {matchedKnown.otype ? ` (${matchedKnown.otype})` : ''} &bull; Catalog:{' '}
                      {catalogBadgeLabel(matchedKnown.catalog)}
                      {matchedKnown.canonical_name
                        ? ` • Canonical ID: ${matchedKnown.canonical_name}`
                        : ''}
                      {matchedKnown.parallax_mas !== null && matchedKnown.parallax_mas !== undefined
                        ? ` • Parallax: ${matchedKnown.parallax_mas.toFixed(2)} mas`
                        : ''}
                      {matchedKnown.data_source ? ` • Source: ${matchedKnown.data_source}` : ''}
                    </p>
                  )}
                  <ul>
                    {selectedObject.waypoints.map((wp) => (
                      <li key={wp.epoch_id}>
                        {wp.epoch_id} (MJD {wp.mjd}): pixel ({wp.x}, {wp.y}) &bull; SNR {wp.snr}{' '}
                        &bull; status: {wp.status}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}

          {trackedTargets.length > 1 && (
            <div className="traced-card">
              <h4>All Tracked Targets ({trackedTargets.length})</h4>
              <ul>
                {trackedTargets.map((t) => (
                  <li key={t.trackId}>
                    <span style={{ color: t.color, fontWeight: 700 }}>■</span> {t.trackId}: (
                    {t.originCentroidX}, {t.originCentroidY}) &rarr; ({t.xN}, {t.yN}) [
                    {t.statusMessage}]{' '}
                    <button type="button" onClick={() => removeTrackedTarget(t.trackId)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* Known Celestial Objects Checkbox Menu Component */}
        <KnownObjectsCheckboxMenu />
      </main>
    </div>
  );
};

export const App: React.FC = () => (
  <SkyExplorerProvider>
    <StarHuntersWorkspace />
  </SkyExplorerProvider>
);

export default App;
