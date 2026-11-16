import React from 'react';
import {
  DETECTOR_WAVELENGTH_BOUNDS_UM,
  type MolecularFeature,
  type SpectrumChannel,
} from '../../types/contracts';

/** Precomputed SVG coordinate mapping and polyline path for the 102-band SED plot. */
export interface SpectraPlotGeometry {
  w: number;
  h: number;
  padL: number;
  padR: number;
  padT: number;
  padB: number;
  minLam: number;
  maxLam: number;
  minFlux: number;
  maxFlux: number;
  toX: (lam: number) => number;
  toY: (flux: number) => number;
  points: string;
  channels: ReadonlyArray<SpectrumChannel>;
}

/** Props for {@link SpectraPlotSvg}. */
export interface SpectraPlotSvgProps {
  /** Precomputed SVG plot bounds, scaling functions, and channels. */
  plotGeometry: SpectraPlotGeometry;
  /** Molecular absorption bands rendered as vertical shaded columns. */
  features: ReadonlyArray<MolecularFeature>;
  /** Active Dim & Pop wavelength range `[minUm, maxUm]`. */
  wavelengthRangeUm: readonly [number, number];
  /** Currently hovered channel index (`null` when pointer is outside the plot). */
  hoverIdx: number | null;
  /** Update callback when the pointer moves across channels or leaves the SVG. */
  onHoverIdxChange: (idx: number | null) => void;
}

/**
 * Format a molecular band identifier into a compact chemical formula label.
 *
 * @param key - Canonical molecule key (e.g., `"h2o"`, `"ch4"`, `"co2"`, `"co"`).
 * @param label - Human-readable band label fallback.
 * @returns Compact subscripted chemical formula string for SVG column labels.
 */
function shortFormulaLabel(key: string, label: string): string {
  const k = key.toLowerCase();
  const l = label.toLowerCase();
  if (k.includes('h2o') || l.includes('water')) return 'H₂O';
  if (k.includes('ch4') || l.includes('methane')) return 'CH₄';
  if (k.includes('co2') || l.includes('dioxide')) return 'CO₂';
  if (k === 'co' || l.includes('monoxide')) return 'CO';
  return label.split(' ')[0];
}

/**
 * Interactive 102-band SPHEREx SVG continuum plot with molecular absorption
 * columns, Dim & Pop wavelength window highlight, detector ticks, and hover probe.
 *
 * @param props - Plot geometry, molecular annotations, active slice, and hover handlers.
 * @returns Interactive SVG element.
 */
export const SpectraPlotSvg: React.FC<SpectraPlotSvgProps> = ({
  plotGeometry,
  features,
  wavelengthRangeUm,
  hoverIdx,
  onHoverIdxChange,
}) => (
  <svg
    data-testid="spectra-plot-svg"
    aria-label="102-Band SPHEREx Spectrum Plot"
    viewBox={`0 0 ${plotGeometry.w} ${plotGeometry.h}`}
    className="spectra-plot-svg"
    onMouseMove={(e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const xSvg = ((e.clientX - rect.left) / rect.width) * plotGeometry.w;
      const lam =
        plotGeometry.minLam +
        ((xSvg - plotGeometry.padL) / (plotGeometry.w - plotGeometry.padL - plotGeometry.padR)) *
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
      onHoverIdxChange(bestIdx);
    }}
    onMouseLeave={() => onHoverIdxChange(null)}
  >
    {/* Molecular band columns */}
    {features.map((feat) => {
      const x0 = plotGeometry.toX(feat.min_um);
      const x1 = plotGeometry.toX(feat.max_um);
      return (
        <g key={feat.molecule}>
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
            {shortFormulaLabel(feat.molecule, feat.label || feat.molecule)}
          </text>
        </g>
      );
    })}

    {/* Active wavelength slice highlight */}
    <rect
      x={plotGeometry.toX(wavelengthRangeUm[0])}
      y={plotGeometry.padT}
      width={Math.max(
        4,
        plotGeometry.toX(wavelengthRangeUm[1]) - plotGeometry.toX(wavelengthRangeUm[0]),
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
);
