import React, { useEffect, useRef, useState } from 'react';
import { NotificationProvider } from './context/NotificationContext';
import { SkyExplorerProvider, useSkyExplorer } from './context/SkyExplorerContext';
import { BlinkerModal } from './components/BlinkerModal';
import { FloatingSearchZenithMenu } from './components/FloatingSearchZenithMenu';
import { KnownObjectsPanel } from './components/KnownObjectsPanel';
import { LandingCurtainOverlay } from './components/LandingCurtainOverlay';
import { NightSkyGlobe } from './components/NightSkyGlobe';
import { NotificationOverlay } from './components/NotificationOverlay';
import { SpotlightTourOverlay } from './components/SpotlightTourOverlay';
import { URL_STATE_DEFAULTS, parseUrlState, replaceUrlState } from './utils/urlStateSync';
import { observatoryLogger } from './utils/observatoryLogger';

const ObservatoryWorkspace: React.FC = () => {
  const {
    activePresetSlug,
    coordinates,
    manifest,
    loadingState,
    renderSettings,
    updateRenderSettings,
    selectPreset,
    navigateToCoordinates,
    requestGlobeFocus,
  } = useSkyExplorer();

  // Parse incoming URL query parameters once on load for silent browser address-bar sharing
  const [initialUrlState] = useState(() =>
    parseUrlState(typeof window === 'undefined' ? '' : window.location.search),
  );
  const urlInitializedRef = useRef(false);
  const skipFirstUrlWriteRef = useRef(true);
  const lastWrittenUrlSigRef = useRef<string>('');

  useEffect(() => {
    if (urlInitializedRef.current) return;
    urlInitializedRef.current = true;
    observatoryLogger.info('app', 'Workspace initialized', {
      hasUrlTarget: Boolean(initialUrlState.target),
      hasUrlCoords: initialUrlState.ra !== null && initialUrlState.dec !== null,
    });

    if (initialUrlState.target) {
      selectPreset(initialUrlState.target);
    } else if (initialUrlState.ra !== null && initialUrlState.dec !== null) {
      navigateToCoordinates(initialUrlState.ra, initialUrlState.dec, initialUrlState.fov);
      requestGlobeFocus?.(initialUrlState.ra, initialUrlState.dec, 2.2);
    }

    if (
      initialUrlState.mode !== URL_STATE_DEFAULTS.mode ||
      initialUrlState.wlMin !== URL_STATE_DEFAULTS.wlMin ||
      initialUrlState.wlMax !== URL_STATE_DEFAULTS.wlMax
    ) {
      updateRenderSettings({
        mode: initialUrlState.mode,
        wavelengthRangeUm: [initialUrlState.wlMin, initialUrlState.wlMax],
      });
    }
  }, [
    initialUrlState,
    navigateToCoordinates,
    requestGlobeFocus,
    selectPreset,
    updateRenderSettings,
  ]);

  useEffect(() => {
    if (skipFirstUrlWriteRef.current) {
      skipFirstUrlWriteRef.current = false;
      return;
    }
    if (typeof window === 'undefined') return;

    const sig = `${activePresetSlug ?? ''}|${coordinates.ra.toFixed(4)}|${coordinates.dec.toFixed(4)}|${coordinates.fovArcmin.toFixed(2)}|${renderSettings.mode}|${renderSettings.wavelengthRangeUm[0].toFixed(2)}|${renderSettings.wavelengthRangeUm[1].toFixed(2)}`;
    if (sig === lastWrittenUrlSigRef.current) return;

    const timer = window.setTimeout(() => {
      lastWrittenUrlSigRef.current = sig;
      replaceUrlState(
        {
          target: activePresetSlug,
          ra: coordinates.ra,
          dec: coordinates.dec,
          fov: coordinates.fovArcmin,
          mode: renderSettings.mode,
          wlMin: renderSettings.wavelengthRangeUm[0],
          wlMax: renderSettings.wavelengthRangeUm[1],
        },
        { baseSearch: window.location.search },
      );
    }, 300);

    return () => window.clearTimeout(timer);
  }, [activePresetSlug, coordinates, renderSettings.mode, renderSettings.wavelengthRangeUm]);

  // Pre-hydrate default showcase target immediately behind the Landing Curtain
  useEffect(() => {
    if (initialUrlState.target) return;
    if (initialUrlState.ra !== null && initialUrlState.dec !== null) return;
    if (activePresetSlug && !manifest && loadingState.stage === 'idle') {
      selectPreset(activePresetSlug);
    }
  }, [initialUrlState, activePresetSlug, manifest, loadingState.stage, selectPreset]);

  return (
    <main className="observatory-shell" aria-label="Star Hunters Infrared Observatory">
      {/* Full-bleed 3D Night-Sky Globe mounted immediately behind curtain */}
      <NightSkyGlobe />

      {/* Top-Left Search & Zenith Foldable Draggable HUD */}
      <FloatingSearchZenithMenu />

      {/* Top-Right Viewport-Filtered Known Objects Panel (291px) */}
      <KnownObjectsPanel />

      {/* Centered Patch Inspector / Blinker Modal + Collapsible 102-Band Spectra Modal */}
      <BlinkerModal />

      {/* Top-Center Warning Banner + Bottom-Right Async Toast + Persistent 40x40 Help Icon */}
      <NotificationOverlay />

      {/* 5-Step Spotlight Guided Tour */}
      <SpotlightTourOverlay />

      {/* z-index 50 NASA Photography Landing Curtain (<= 2s warmup lock + 600ms slide-out) */}
      <LandingCurtainOverlay />
    </main>
  );
};

export function App() {
  return (
    <NotificationProvider>
      <SkyExplorerProvider>
        <ObservatoryWorkspace />
      </SkyExplorerProvider>
    </NotificationProvider>
  );
}

export default App;
