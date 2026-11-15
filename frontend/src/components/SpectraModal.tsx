import React, { useMemo, useState } from 'react';
import { useSkyExplorer } from '../context/SkyExplorerContext';
import { DEFAULT_MOLECULAR_BANDS, type MolecularFeature } from '../types/contracts';
import { downloadSpectrumCsv } from '../utils/csvExport';
import { formatImageProvenanceBadge, formatRaDecCompact } from '../utils/observatoryMath';
import { ChevronIcon, CloseIcon, DownloadIcon, SpinnerIcon } from './icons/ObservatoryIcons';
import { SpectraPlotSvg, type SpectraPlotGeometry } from './spectra/SpectraPlotSvg';

/**
 * Interactive 102-band SPHEREx spectral energy distribution (SED) inspector modal.
 *
 * Displays continuum flux across Detectors 1–6 (0.75–5.0 µm), molecular absorption
 * columns, active wavelength Dim & Pop slice, hover band readout, and CSV export.
 *
 * @returns The rendered spectra modal section, or `null` when closed.
 */
export const SpectraModal: React.FC = () => {
  const {
    activePresetSlug,
    manifest,
    activeSpectrum,
    isSpectrumLoading,
    isSpectraModalOpen = false,
    closeSpectraModal,
    renderSettings,
    updateRenderSettings,
    selectedObject,
  } = useSkyExplorer();

  const provenance = useMemo(
    () => formatImageProvenanceBadge(manifest?.data_source_summary),
    [manifest?.data_source_summary],
  );

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const plotGeometry = useMemo<SpectraPlotGeometry | null>(() => {
    if (!activeSpectrum || activeSpectrum.channels.length === 0) return null;
    const channels = activeSpectrum.channels;
    const w = 960;
    const h = 158;
    const padL = 48;
    const padR = 16;
    const padT = 14;
    const padB = 26;
    const minLam = 0.75;
    const maxLam = 5.0;

    let minFlux = Infinity;
    let maxFlux = -Infinity;
    for (const c of channels) {
      if (Number.isFinite(c.flux)) {
        if (c.flux < minFlux) minFlux = c.flux;
        if (c.flux > maxFlux) maxFlux = c.flux;
      }
    }
    if (!Number.isFinite(minFlux) || !Number.isFinite(maxFlux)) return null;
    if (Math.abs(maxFlux - minFlux) < 1e-12) {
      minFlux -= 1;
      maxFlux += 1;
    }
    const fluxPad = (maxFlux - minFlux) * 0.1;
    minFlux -= fluxPad;
    maxFlux += fluxPad;

    const toX = (lam: number) => padL + ((lam - minLam) / (maxLam - minLam)) * (w - padL - padR);
    const toY = (f: number) => padT + (1 - (f - minFlux) / (maxFlux - minFlux)) * (h - padT - padB);

    const points = channels
      .map((c) => `${toX(c.wavelength_um).toFixed(1)},${toY(c.flux).toFixed(1)}`)
      .join(' ');

    return {
      w,
      h,
      padL,
      padR,
      padT,
      padB,
      minLam,
      maxLam,
      minFlux,
      maxFlux,
      toX,
      toY,
      points,
      channels,
    };
  }, [activeSpectrum]);

  if (!isSpectraModalOpen) {
    return null;
  }

  const features =
    activeSpectrum?.molecular_features && activeSpectrum.molecular_features.length > 0
      ? activeSpectrum.molecular_features
      : DEFAULT_MOLECULAR_BANDS;

  const hoverChannel = hoverIdx !== null && plotGeometry ? plotGeometry.channels[hoverIdx] : null;

  const isFeatureActive = (feat: MolecularFeature): boolean =>
    Math.abs(renderSettings.wavelengthRangeUm[0] - feat.min_um) < 0.02 &&
    Math.abs(renderSettings.wavelengthRangeUm[1] - feat.max_um) < 0.02;

  const handleSelectMolecularFeature = (feat: MolecularFeature) => {
    if (isFeatureActive(feat)) {
      updateRenderSettings({ wavelengthRangeUm: [0.75, 5.0] });
    } else {
      updateRenderSettings({ wavelengthRangeUm: [feat.min_um, feat.max_um] });
    }
  };

  return (
    <section
      className="spectra-modal"
      role="region"
      aria-label="102-Band SPHEREx Spectrum Inspector"
      data-testid="spectra-modal"
    >
      <div className="blinker-header">
        <div className="blinker-header-left">
          <span className="badge-pill is-star">102-Band SED</span>
          {activeSpectrum && (
            <span className="mono spectra-channel-count">{activeSpectrum.channels.length} ch</span>
          )}
        </div>

        <div className="blinker-section-label">
          <span className="blinker-section-title">
            {selectedObject?.matchedLabel ??
              activeSpectrum?.source_label ??
              'SPHEREx Spectral Energy Distribution'}
          </span>
          <span className="blinker-section-sub mono">
            {activeSpectrum
              ? `${formatRaDecCompact(activeSpectrum.ra, activeSpectrum.dec)} · Flux (${
                  activeSpectrum.units?.flux ?? 'MJy/sr'
                })`
              : 'Loading forced-photometry spectrum...'}
          </span>
        </div>

        <div className="blinker-header-right">
          {activeSpectrum && (
            <button
              type="button"
              className="hud-btn-secondary spectra-csv-btn"
              onClick={() =>
                downloadSpectrumCsv(activeSpectrum, activePresetSlug ?? activeSpectrum.source_label)
              }
              data-testid="spectra-csv-btn"
            >
              <DownloadIcon size={13} />
              <span>CSV</span>
            </button>
          )}
          <button
            type="button"
            className="hud-icon-btn"
            aria-label={isCollapsed ? 'Expand Spectra Modal' : 'Collapse Spectra Modal'}
            aria-expanded={!isCollapsed}
            data-testid="spectra-collapse-chevron"
            onClick={() => setIsCollapsed((prev) => !prev)}
          >
            <ChevronIcon size={15} direction={isCollapsed ? 'up' : 'down'} />
          </button>
          <button
            type="button"
            className="hud-icon-btn"
            aria-label="Close Spectra Modal"
            data-testid="spectra-close-btn"
            onClick={closeSpectraModal}
          >
            <CloseIcon size={15} />
          </button>
        </div>
      </div>

      {!isCollapsed && (
        <div className="spectra-modal-body">
          {isSpectrumLoading && !plotGeometry ? (
            <div className="spectra-loading-state">
              <SpinnerIcon size={16} />
              <span>Extracting 102-band spectrophotometry from SPHEREx cube...</span>
            </div>
          ) : plotGeometry ? (
            <>
              <div className="spectra-feature-bar">
                <div className="spectra-feature-pills">
                  {features.slice(0, 4).map((feat) => {
                    const active = isFeatureActive(feat);
                    return (
                      <button
                        key={feat.molecule}
                        type="button"
                        className={`badge-pill spectra-feature-pill${active ? ' is-active' : ''}`}
                        aria-pressed={active}
                        data-testid={`spectra-feature-pill-${feat.molecule}`}
                        title={
                          active
                            ? `Reset wavelength filter to full 0.75–5.00 µm spectrum`
                            : `Filter image to ${feat.label || feat.molecule} (${feat.min_um.toFixed(2)}–${feat.max_um.toFixed(2)} µm)`
                        }
                        onClick={() => handleSelectMolecularFeature(feat)}
                      >
                        {feat.label || feat.molecule}: {feat.min_um.toFixed(2)}-
                        {feat.max_um.toFixed(2)} µm
                      </button>
                    );
                  })}
                </div>
              </div>

              <SpectraPlotSvg
                plotGeometry={plotGeometry}
                features={features}
                wavelengthRangeUm={renderSettings.wavelengthRangeUm}
                hoverIdx={hoverIdx}
                onHoverIdxChange={setHoverIdx}
                onSelectFeature={handleSelectMolecularFeature}
              />

              <div className="spectra-hover-readout" data-testid="spectra-hover-readout">
                {hoverChannel ? (
                  <span className="mono spectra-readout-active">
                    Band #{hoverChannel.band_index} (Detector {hoverChannel.detector}) ·{' '}
                    {hoverChannel.wavelength_um.toFixed(3)} µm · Flux{' '}
                    {hoverChannel.flux.toExponential(2)} {activeSpectrum?.units?.flux ?? 'MJy/sr'}
                    {hoverChannel.flagged ? ' · FLAGGED' : ''}
                  </span>
                ) : (
                  <span className="spectra-readout-hint">
                    Hover over the spectrum curve to inspect band wavelength and flux
                  </span>
                )}
                <span className="mono spectra-readout-origin">
                  {activeSpectrum?.spectrum_origin === 'spherex_forced_photometry'
                    ? 'Forced Photometry'
                    : provenance.shortLabel}
                </span>
              </div>
            </>
          ) : (
            <div className="spectra-empty-state">
              No spectral channels available for this target yet.
            </div>
          )}
        </div>
      )}
    </section>
  );
};
