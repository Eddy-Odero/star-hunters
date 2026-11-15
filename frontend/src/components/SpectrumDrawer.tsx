import React, { useMemo } from 'react';
import { useSkyExplorer } from '../context/SkyExplorerContext';
import { downloadSpectrumCsv } from '../utils/csvExport';

const MOLECULAR_BANDS = [
  { name: 'H2O', min: 1.35, max: 1.45, color: 'rgba(56, 189, 248, 0.12)', stroke: '#38bdf8' },
  { name: 'CH4', min: 1.6, max: 1.75, color: 'rgba(244, 114, 182, 0.12)', stroke: '#f472b6' },
  { name: 'CO2', min: 2.65, max: 2.78, color: 'rgba(251, 191, 36, 0.12)', stroke: '#fbbf24' },
  { name: 'CO', min: 4.6, max: 4.8, color: 'rgba(167, 139, 250, 0.12)', stroke: '#a78bfa' },
];

export const SpectrumDrawer: React.FC = () => {
  const { activeSpectrum, isSpectrumLoading, activePresetSlug, selectedObject } = useSkyExplorer();

  const chartData = useMemo(() => {
    if (!activeSpectrum || activeSpectrum.channels.length === 0) return null;
    const sorted = [...activeSpectrum.channels].sort((a, b) => a.wavelength_um - b.wavelength_um);
    const minWave = 0.75;
    const maxWave = 5.0;
    const fluxes = sorted.map((ch) => ch.flux);
    const variances = sorted.map((ch) => ch.variance);
    const minFlux = Math.min(...fluxes.map((f, i) => f - Math.sqrt(variances[i])));
    const maxFlux = Math.max(...fluxes.map((f, i) => f + Math.sqrt(variances[i])));
    const fluxSpan = Math.max(1e-6, maxFlux - minFlux);

    return {
      sorted,
      minWave,
      maxWave,
      minFlux: minFlux - fluxSpan * 0.05,
      maxFlux: maxFlux + fluxSpan * 0.05,
    };
  }, [activeSpectrum]);

  if (!activeSpectrum && !isSpectrumLoading) {
    return null;
  }

  const handleDownloadCsv = () => {
    if (!activeSpectrum) return;
    const identifier = selectedObject?.matchedObjectId ?? activePresetSlug ?? 'spectrum';
    downloadSpectrumCsv(activeSpectrum, identifier);
  };

  const svgWidth = 650;
  const svgHeight = 260;
  const padLeft = 65;
  const padRight = 25;
  const padTop = 20;
  const padBottom = 40;
  const plotWidth = svgWidth - padLeft - padRight;
  const plotHeight = svgHeight - padTop - padBottom;

  const scaleX = (w: number) => {
    if (!chartData) return 0;
    return (
      padLeft + ((w - chartData.minWave) / (chartData.maxWave - chartData.minWave)) * plotWidth
    );
  };

  const scaleY = (f: number) => {
    if (!chartData) return 0;
    const span = chartData.maxFlux - chartData.minFlux;
    if (span === 0) return padTop + plotHeight / 2;
    return padTop + plotHeight - ((f - chartData.minFlux) / span) * plotHeight;
  };

  return (
    <aside className="spectrum-drawer" role="region" aria-label="Scientist Spectral Drawer">
      <div className="drawer-header">
        <div>
          <h3>Scientist Drawer — 102-Band NIR Spectrum</h3>
          <p className="drawer-subtitle">
            SPHEREx Spectrophotometry (0.75–5.0 &mu;m) with molecular absorption feature shading.
          </p>
        </div>
        {activeSpectrum && (
          <button type="button" className="mode-btn active" onClick={handleDownloadCsv}>
            Download 102-Band Spectrum CSV
          </button>
        )}
      </div>

      {isSpectrumLoading && <div className="loading-indicator">Loading 102-band spectrum...</div>}

      {chartData && (
        <div className="spectrum-chart-container">
          <svg
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            className="spectrum-svg"
            role="img"
            aria-label="102-band SPHEREx near-infrared spectrum from 0.75 to 5.0 micrometers"
          >
            {MOLECULAR_BANDS.map((band) => {
              const x1 = scaleX(band.min);
              const x2 = scaleX(band.max);
              return (
                <g key={band.name}>
                  <rect
                    x={x1}
                    y={padTop}
                    width={Math.max(4, x2 - x1)}
                    height={plotHeight}
                    fill={band.color}
                  />
                  <line
                    x1={x1}
                    y1={padTop}
                    x2={x1}
                    y2={padTop + plotHeight}
                    stroke={band.stroke}
                    strokeWidth={0.8}
                    strokeDasharray="2 2"
                  />
                  <text
                    x={(x1 + x2) / 2}
                    y={padTop + 12}
                    fill={band.stroke}
                    fontSize={9}
                    textAnchor="middle"
                    fontWeight="700"
                  >
                    {band.name}
                  </text>
                </g>
              );
            })}

            <line
              x1={padLeft}
              y1={padTop + plotHeight}
              x2={padLeft + plotWidth}
              y2={padTop + plotHeight}
              stroke="#334155"
              strokeWidth={1}
            />
            <line
              x1={padLeft}
              y1={padTop}
              x2={padLeft}
              y2={padTop + plotHeight}
              stroke="#334155"
              strokeWidth={1}
            />

            <path
              d={
                chartData.sorted
                  .map((ch, idx) => {
                    const x = scaleX(ch.wavelength_um);
                    const sigma = Math.sqrt(Math.max(0, ch.variance));
                    const yTop = scaleY(ch.flux + sigma);
                    return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${yTop.toFixed(1)}`;
                  })
                  .join(' ') +
                ' ' +
                chartData.sorted
                  .slice()
                  .reverse()
                  .map((ch) => {
                    const x = scaleX(ch.wavelength_um);
                    const sigma = Math.sqrt(Math.max(0, ch.variance));
                    const yBot = scaleY(ch.flux - sigma);
                    return `L ${x.toFixed(1)} ${yBot.toFixed(1)}`;
                  })
                  .join(' ') +
                ' Z'
              }
              fill="rgba(56, 189, 248, 0.15)"
            />

            <polyline
              points={chartData.sorted
                .map((ch) => `${scaleX(ch.wavelength_um).toFixed(1)},${scaleY(ch.flux).toFixed(1)}`)
                .join(' ')}
              fill="none"
              stroke="#38bdf8"
              strokeWidth={1.8}
            />

            {chartData.sorted.map((ch) => (
              <circle
                key={ch.band_index}
                cx={scaleX(ch.wavelength_um)}
                cy={scaleY(ch.flux)}
                r={2.2}
                fill={ch.flagged ? '#f87171' : '#38bdf8'}
              />
            ))}

            {[0.75, 1.5, 2.5, 3.5, 5.0].map((tick) => {
              const tx = scaleX(tick);
              return (
                <g key={tick}>
                  <line
                    x1={tx}
                    y1={padTop + plotHeight}
                    x2={tx}
                    y2={padTop + plotHeight + 4}
                    stroke="#475569"
                    strokeWidth={1}
                  />
                  <text
                    x={tx}
                    y={padTop + plotHeight + 15}
                    fill="#94a3b8"
                    fontSize={9}
                    textAnchor="middle"
                  >
                    {tick.toFixed(2)}
                  </text>
                </g>
              );
            })}
            {[
              chartData.minFlux,
              (chartData.minFlux + chartData.maxFlux) / 2,
              chartData.maxFlux,
            ].map((val, idx) => (
              <text
                key={idx}
                x={padLeft - 6}
                y={scaleY(val) + 3}
                fill="#94a3b8"
                fontSize={9}
                textAnchor="end"
              >
                {val.toExponential(1)}
              </text>
            ))}

            <text
              x={padLeft + plotWidth / 2}
              y={svgHeight - 6}
              fill="#94a3b8"
              fontSize={10}
              textAnchor="middle"
            >
              Wavelength (µm)
            </text>
            <text
              x={15}
              y={padTop + plotHeight / 2}
              fill="#94a3b8"
              fontSize={10}
              textAnchor="middle"
              transform={`rotate(-90 15 ${padTop + plotHeight / 2})`}
            >
              Flux (MJy/sr)
            </text>
          </svg>
          <div className="spectrum-legend">
            <span className="legend-item">
              <span
                className="legend-dot"
                style={{ backgroundColor: '#38bdf8' }}
                aria-hidden="true"
              />
              Flux &plusmn; 1&sigma; ({chartData.sorted.length} bands)
            </span>
            <span className="legend-item">
              <span
                className="legend-dot"
                style={{ backgroundColor: '#f87171' }}
                aria-hidden="true"
              />
              Flagged channel
            </span>
            <span className="legend-item">Bands: H2O, CH4, CO2, CO</span>
          </div>
        </div>
      )}
    </aside>
  );
};

export default SpectrumDrawer;
