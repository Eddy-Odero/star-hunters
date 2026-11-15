import React, { useEffect, useState } from 'react';
import { SkyExplorerProvider, useSkyExplorer } from './context/SkyExplorerContext';
import { TargetTourBar } from './components/TargetTourBar';
import { ViewportControlsBar } from './components/ViewportControlsBar';
import { KnownObjectsCheckboxMenu } from './components/KnownObjectsCheckboxMenu';
import { WhatsAboveMeBar } from './components/WhatsAboveMeBar';
import { SourceInspectorCard } from './components/SourceInspectorCard';
import { SpectrumDrawer } from './components/SpectrumDrawer';
import { SkyPatchViewport } from './components/SkyPatchViewport';

const StarHuntersWorkspace: React.FC = () => {
  const {
    activePresetSlug,
    manifest,
    loadingState,
    renderSettings,
    trackedTargets,
    lastClickDiagnostic,
    clearTrackedTargets,
    selectPreset,
    inspectPixelOrCoord,
  } = useSkyExplorer();

  const [showLabels, setShowLabels] = useState<boolean>(true);

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
            Multi-Epoch Near-Infrared Blinker (0.75–5.0 &mu;m) &bull; SPHEREx + WISE/NEOWISE + Gaia
            DR3 + MOST
          </p>
        </div>

        {/* Telemetry Header Banner */}
        <div className="header-telemetry">
          {manifest?.data_source_summary && (
            <span className="telemetry-badge" title={manifest.data_source_summary.status_note}>
              🛰️ Baseline: {manifest.data_source_summary.baseline_days} days |{' '}
              {manifest.data_source_summary.uses_wise_fallback
                ? 'WISE Fallback'
                : 'Primary SPHEREx'}
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
      <WhatsAboveMeBar />

      <main className="workspace-grid">
        <section className="viewport-panel">
          <div className="panel-header">
            <h2>
              256&times;256 Sky Patch Viewport{' '}
              {manifest ? `— ${manifest.target_metadata.name}` : ''}
            </h2>
            <span className="status-badge">
              Zoom: {renderSettings.zoom.toFixed(1)}&times; &bull; Pan: (
              {renderSettings.panX.toFixed(0)}, {renderSettings.panY.toFixed(0)})
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

          <SkyPatchViewport showLabels={showLabels} />

          {lastClickDiagnostic && lastClickDiagnostic.status === 'no_body_found' && (
            <div className="diagnostic-banner" role="status">
              {lastClickDiagnostic.message}
            </div>
          )}

          {/* Integrated Source Inspector Card */}
          <SourceInspectorCard />

          {/* Integrated Scientist Spectrum Drawer */}
          <SpectrumDrawer />
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
