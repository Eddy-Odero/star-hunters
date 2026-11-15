import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SkyExplorerProvider, useSkyExplorer } from './context/SkyExplorerContext';
import { computeViewportViewBox, screenToImageCoordinates } from './types/contracts';
import { TargetTourBar } from './components/TargetTourBar';
import { ViewportControlsBar } from './components/ViewportControlsBar';
import { KnownObjectsCheckboxMenu } from './components/KnownObjectsCheckboxMenu';
import { WhatsAboveMeBar } from './components/WhatsAboveMeBar';

const StarHuntersWorkspace: React.FC = () => {
  const {
    activePresetSlug,
    manifest,
    loadingState,
    renderSettings,
    setViewportZoomPan,
    knownObjects,
    selectedObject,
    trackedTargets,
    lastClickDiagnostic,
    removeTrackedTarget,
    clearTrackedTargets,
    selectPreset,
    inspectPixelOrCoord,
  } = useSkyExplorer();

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [zenithBanner, setZenithBanner] = useState<string | null>(null);

  useEffect(() => {
    if (activePresetSlug && !manifest && loadingState.stage === 'idle') {
      selectPreset(activePresetSlug);
    }
  }, [activePresetSlug, manifest, loadingState.stage, selectPreset]);

  const viewBox = useMemo(
    () =>
      computeViewportViewBox(
        renderSettings.zoom,
        renderSettings.panX,
        renderSettings.panY,
      ),
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

  const checkedKnownObjects = useMemo(
    () =>
      knownObjects.filter((obj) =>
        renderSettings.checkedObjectIds.includes(obj.object_id),
      ),
    [knownObjects, renderSettings.checkedObjectIds],
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Star Hunters — Planet X &amp; SPHEREx Blinker</h1>
          <p className="subtitle">
            Multi-Epoch Near-Infrared Blinker (0.75–5.0 &mu;m) &bull; SPHEREx + WISE/NEOWISE + Gaia DR3 + MOST
          </p>
        </div>

        {/* Telemetry Header Banner */}
        <div className="header-telemetry">
          {manifest?.data_source_summary && (
            <span className="telemetry-badge" title={manifest.data_source_summary.status_note}>
              🛰️ Baseline: {manifest.data_source_summary.baseline_days} days |{' '}
              {manifest.data_source_summary.uses_wise_fallback ? 'WISE Fallback' : 'Primary SPHEREx'}
            </span>
          )}
          <span className="telemetry-badge">
            ⚡ Stage: {loadingState.stage}
            {loadingState.fromClientCache ? ' (3G Browser Cache Hit)' : ' (Live Stream)'}
          </span>
        </div>
      </header>

      {/* Target Tour Carousel Component */}
      <TargetTourBar />

      {/* What's Above Me Zenith Discovery Flow */}
      <WhatsAboveMeBar onZenithResolved={(text) => setZenithBanner(text)} />

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
              Zoom: {renderSettings.zoom.toFixed(1)}&times; &bull; Pan: ({renderSettings.panX.toFixed(0)},{' '}
              {renderSettings.panY.toFixed(0)})
            </span>
          </div>

          <ViewportControlsBar />

          <div className="secondary-action-bar">
            <button
              type="button"
              className="mode-btn"
              onClick={() => inspectPixelOrCoord(124, 126, renderSettings.activeEpochIndex)}
            >
              Track Target (124, 126)
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
                const epPos =
                  obj.epoch_positions[renderSettings.activeEpochIndex] ?? obj;
                return (
                  <g key={obj.object_id}>
                    <circle
                      cx={epPos.x}
                      cy={epPos.y}
                      r={4.5}
                      fill="none"
                      stroke="#38bdf8"
                      strokeWidth={1.1}
                    />
                    <text
                      x={epPos.x + 6}
                      y={epPos.y - 4}
                      fill="#e2e8f0"
                      fontSize={7}
                    >
                      {obj.label}
                    </text>
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

          {selectedObject && (
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
                Origin Centroid: ({selectedObject.originCentroidX}, {selectedObject.originCentroidY})
                &bull; Proper Motion: {selectedObject.properMotionArcsecPerYr}&Prime;/yr &bull; Match:{' '}
                {selectedObject.matchedLabel ?? 'Uncataloged Mover Candidate'}
              </p>
              <ul>
                {selectedObject.waypoints.map((wp) => (
                  <li key={wp.epoch_id}>
                    {wp.epoch_id} (MJD {wp.mjd}): pixel ({wp.x}, {wp.y}) &bull; SNR {wp.snr} &bull;{' '}
                    status: {wp.status}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

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