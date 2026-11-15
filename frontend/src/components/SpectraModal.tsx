import React, { useMemo, useState } from 'react';
import { useSkyExplorer } from '../context/SkyExplorerContext';
import { DETECTOR_WAVELENGTH_BOUNDS_UM } from '../types/contracts';
import { downloadSpectrumCsv } from '../utils/csvExport';
import { ChevronIcon, CloseIcon, DownloadIcon, SpinnerIcon } from './icons/ObservatoryIcons';

const DEFAULT_MOLECULAR_BANDS = [
  { key: 'h2o', label: 'H2O Ice/Vapor', min_um: 2.95, max_um: 3.3 },
  { key: 'ch4', label: 'CH4 Methane', min_um: 3.2, max_um: 3.55 },
  { key: 'co2', label: 'CO2', min_um: 4.2, max_um: 4.35 },
  { key: 'co', label: 'CO', min_um: 4.55, max_um: 4.8 },
];

function shortFormulaLabel(key: string, label: string): string {
  const k = key.toLowerCase();
  const l = label.toLowerCase();
  if (k.includes('h2o') || l.includes('water')) return 'H₂O';
  if (k.includes('ch4') || l.includes('methane')) return 'CH₄';
  if (k.includes('co2') || l.includes('dioxide')) return 'CO₂';
  if (k === 'co' || l.includes('monoxide')) return 'CO';
  return label.split(' ')[0];
}

export const SpectraModal: React.FC = () => {
  const {
    activePresetSlug,
    activeSpectrum,
    isSpectrumLoading,
    isSpectraModalOpen = false,
    closeSpectraModal,
    renderSettings,
    selectedObject,
  } = useSkyExplorer();

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const plotGeometry = useMemo(() => {
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
      ? activeSpectrum.molecular_features.map((mf) => ({
          key: mf.molecule,
          label: mf.label || mf.molecule,
          min_um: mf.min_um,
          max_um: mf.max_um,
        }))
      : DEFAULT_MOLECULAR_BANDS;

  const hoverChannel = hoverIdx !== null && plotGeometry ? plotGeometry.channels[hoverIdx] : null;

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
            <span className="mono" style={{ fontSize: 11 }}>
              {activeSpectrum.channels.length} ch
            </span>
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
              ? `RA ${activeSpectrum.ra.toFixed(4)}°, Dec ${
                  activeSpectrum.dec >= 0 ? '+' : ''
                }${activeSpectrum.dec.toFixed(4)}° · Flux (${activeSpectrum.units?.flux ?? 'MJy/sr'})`
              : 'Loading forced-photometry spectrum...'}
          </span>
        </div>

        <div className="blinker-header-right">
          {activeSpectrum && (
            <button
              type="button"
              className="hud-btn-secondary"
              style={{ height: 28, padding: '0 9px', fontSize: 11 }}
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
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                fontSize: 13,
                color: 'var(--text-secondary)',
              }}
            >
              <SpinnerIcon size={16} />
              <span>Extracting 102-band spectrophotometry from SPHEREx cube...</span>
            </div>
          ) : plotGeometry ? (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  fontSize: 11,
                  color: 'var(--text-muted)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {features.slice(0, 4).map((feat) => (
                    <span key={feat.key} className="badge-pill" style={{ textTransform: 'none' }}>
                      {feat.label}: {feat.min_um.toFixed(2)}–{feat.max_um.toFixed(2)} µm
                    </span>
                  ))}
                </div>
                {hoverChannel && (
                  <span className="mono" style={{ color: 'var(--accent-amber-bright)' }}>
                    Band #{hoverChannel.band_index + 1} (D{hoverChannel.detector}) ·{' '}
                    {hoverChannel.wavelength_um.toFixed(3)} µm · Flux{' '}
                    {hoverChannel.flux.toExponential(2)}
                  </span>
                )}
              </div>

              <svg
                viewBox={`0 0 ${plotGeometry.w} ${plotGeometry.h}`}
                style={{ width: '100%', flex: 1, minHeight: 0, display: 'block' }}
                onMouseMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const xSvg = ((e.clientX - rect.left) / rect.width) * plotGeometry.w;
                  const lam =
                    plotGeometry.minLam +
                    ((xSvg - plotGeometry.padL) /
                      (plotGeometry.w - plotGeometry.padL - plotGeometry.padR)) *
                      (plotGeometry.maxLam - plotGeometry.minLam);
                  let bestIdx = 0;
                  let bestDiff = Infinity;
                  plotGeometry.channels.forEach((c, idx) => {
                    const diff = Math.abs(c.wavelength_um - lam);
                    if (diff < bestDiff) {
                      bestDiff = diff;
                      bestIdx = idx;
                    }
                  });
                  setHoverIdx(bestIdx);
                }}
                onMouseLeave={() => setHoverIdx(null)}
              >
                {/* Molecular band columns */}
                {features.map((feat) => {
                  const x0 = plotGeometry.toX(feat.min_um);
                  const x1 = plotGeometry.toX(feat.max_um);
                  return (
                    <g key={feat.key}>
                      <rect
                        x={x0}
                        y={plotGeometry.padT}
                        width={Math.max(2, x1 - x0)}
                        height={plotGeometry.h - plotGeometry.padT - plotGeometry.padB}
                        fill="rgba(56, 189, 248, 0.08)"
                      />
                      <text
                        x={(x0 + x1) * 0.5}
                        y={plotGeometry.padT + 10}
                        textAnchor="middle"
                        fill="#7dd3fc"
                        fontSize={9}
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {shortFormulaLabel(feat.key, feat.label)}
                      </text>
                    </g>
                  );
                })}

                {/* Active wavelength slice highlight */}
                <rect
                  x={plotGeometry.toX(renderSettings.wavelengthRangeUm[0])}
                  y={plotGeometry.padT}
                  width={Math.max(
                    4,
                    plotGeometry.toX(renderSettings.wavelengthRangeUm[1]) -
                      plotGeometry.toX(renderSettings.wavelengthRangeUm[0]),
                  )}
                  height={plotGeometry.h - plotGeometry.padT - plotGeometry.padB}
                  fill="rgba(245, 158, 11, 0.09)"
                  stroke="rgba(245, 158, 11, 0.32)"
                  strokeDasharray="3 3"
                />

                {/* Detector boundary ticks (D1..D6) */}
                {DETECTOR_WAVELENGTH_BOUNDS_UM.map(([, maxU], idx) => (
                  <line
                    key={idx}
                    x1={plotGeometry.toX(maxU)}
                    x2={plotGeometry.toX(maxU)}
                    y1={plotGeometry.padT}
                    y2={plotGeometry.h - plotGeometry.padB}
                    stroke="rgba(148, 163, 184, 0.14)"
                    strokeWidth={1}
                  />
                ))}

                {/* Axes */}
                <line
                  x1={plotGeometry.padL}
                  x2={plotGeometry.w - plotGeometry.padR}
                  y1={plotGeometry.h - plotGeometry.padB}
                  y2={plotGeometry.h - plotGeometry.padB}
                  stroke="rgba(148, 163, 184, 0.35)"
                />
                {[0.75, 1.5, 2.5, 3.5, 4.5, 5.0].map((tick) => (
                  <text
                    key={tick}
                    x={plotGeometry.toX(tick)}
                    y={plotGeometry.h - 8}
                    textAnchor="middle"
                    fill="#94a3b8"
                    fontSize={10}
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {tick.toFixed(2)} µm
                  </text>
                ))}

                {/* 102-band continuum curve */}
                <polyline
                  fill="none"
                  stroke="#fbbf24"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  points={plotGeometry.points}
                />

                {/* Individual channels + flagged points */}
                {plotGeometry.channels.map((ch, idx) => (
                  <circle
                    key={ch.band_index}
                    cx={plotGeometry.toX(ch.wavelength_um)}
                    cy={plotGeometry.toY(ch.flux)}
                    r={hoverIdx === idx ? 4 : ch.flagged ? 2.5 : 1.7}
                    fill={ch.flagged ? '#f87171' : hoverIdx === idx ? '#ffffff' : '#38bdf8'}
                  />
                ))}
              </svg>
            </>
          ) : (
            <div
              style={{ padding: 24, textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}
            >
              No spectral channels available for this target yet.
            </div>
          )}
        </div>
      )}
    </section>
  );
};
