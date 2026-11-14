import React, { useEffect } from 'react';
import { SkyExplorerProvider, useSkyExplorer } from './context/SkyExplorerContext';

const PRESET_SLUGS = [
  { slug: 'wise_0855', label: 'WISE 0855 (Brown Dwarf)' },
  { slug: 'barnards_star', label: "Barnard's Star (Fast Mover)" },
  { slug: 'epsilon_indi_b', label: 'Epsilon Indi B (T-Dwarf Pair)' },
  { slug: 'rw_aurigae', label: 'RW Aurigae (Variable Star)' },
  { slug: 'r_draconis', label: 'R Draconis (Mira Giant)' },
  { slug: 'comet_3i_atlas', label: 'Comet 3I/ATLAS (Solar System)' },
];

const StarHuntersWorkspace: React.FC = () => {
  const {
    activePresetSlug,
    manifest,
    loadingState,
    renderSettings,
    updateRenderSettings,
    setViewportZoomPan,
    resetViewportZoomPan,
    knownObjects,
    toggleKnownObject,
    checkAllKnownObjects,
    uncheckAllKnownObjects,
    resetDefaultKnownObjects,
    selectedObject,
    trackedTargets,
    lastClickDiagnostic,
    removeTrackedTarget,
    clearTrackedTargets,
    selectPreset,
    inspectPixelOrCoord,
  } = useSkyExplorer();

  useEffect(() => {
    if (activePresetSlug && !manifest && loadingState.stage === 'idle') {
      selectPreset(activePresetSlug);
    }
  }, [activePresetSlug, manifest, loadingState.stage, selectPreset]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Star Hunters — Planet X &amp; SPHEREx Blinker</h1>
          <p className="subtitle">
            Multi-Epoch Near-Infrared Blinker (0.75–5.0 &mu;m) &bull; SPHEREx + WISE/NEOWISE + Gaia DR3 + MOST
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
        </div>
      </header>

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
              {renderSettings.zoom.toFixed(1)}&times;
            </span>
          </div>

          <div className="mode-controls">
            {(['blink', 'subtract', 'coadd'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={renderSettings.mode === m ? 'mode-btn active' : 'mode-btn'}
                onClick={() => updateRenderSettings({ mode: m })}
              >
                Mode: {m.toUpperCase()}
              </button>
            ))}
            <button
              type="button"
              className="mode-btn"
              onClick={() =>
                setViewportZoomPan(
                  Math.min(8.0, renderSettings.zoom * 1.5),
                  renderSettings.panX,
                  renderSettings.panY,
                )
              }
            >
              Zoom In (+)
            </button>
            <button
              type="button"
              className="mode-btn"
              onClick={() =>
                setViewportZoomPan(
                  Math.max(1.0, renderSettings.zoom / 1.5),
                  renderSettings.panX,
                  renderSettings.panY,
                )
              }
            >
              Zoom Out (-)
            </button>
            <button type="button" className="mode-btn" onClick={resetViewportZoomPan}>
              Reset Pan/Zoom (1&times;)
            </button>
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
                {selectedObject.isOverlappedAtOrigin ? ' • Overlapped Body Branch' : ''}
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

        <aside className="known-objects-panel">
          <div className="panel-header">
            <h2>Known Celestial Objects ({knownObjects.length})</h2>
            <div className="checkbox-actions">
              <button type="button" onClick={checkAllKnownObjects}>
                Check All
              </button>
              <button type="button" onClick={uncheckAllKnownObjects}>
                Uncheck All
              </button>
              <button type="button" onClick={resetDefaultKnownObjects}>
                Notable Only
              </button>
            </div>
          </div>
          <ul className="known-object-list">
            {knownObjects.map((obj) => {
              const checked = renderSettings.checkedObjectIds.includes(obj.object_id);
              return (
                <li key={obj.object_id} className="known-object-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleKnownObject(obj.object_id)}
                    />
                    <span className="obj-label">{obj.label}</span>
                    <span className="obj-meta">
                      [{obj.catalog}] ({obj.x}, {obj.y})
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </aside>
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
