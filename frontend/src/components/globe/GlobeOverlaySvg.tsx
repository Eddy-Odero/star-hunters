import React from 'react';

export interface GlobeKnownMarker {
  id: string;
  label: string;
  px: number;
  py: number;
  shape: 'triangle' | 'diamond';
  color: string;
}

export interface GlobeOverlayGeometry {
  constellationLines: Array<{ key: string; x1: number; y1: number; x2: number; y2: number }>;
  constellationLabels: Array<{ abbr: string; name: string; px: number; py: number }>;
  knownMarkers: GlobeKnownMarker[];
}

interface GlobeOverlaySvgProps {
  geometry: GlobeOverlayGeometry;
  isPanelGridVisible: boolean;
  hoverPatchPoints: string | null;
}

/** SVG overlay rendering IAU constellations, checked Known Object shapes, and hover reticle. */
export const GlobeOverlaySvg: React.FC<GlobeOverlaySvgProps> = ({
  geometry,
  isPanelGridVisible,
  hoverPatchPoints,
}) => (
  <svg className="globe-reticle-overlay" aria-hidden="true">
    {geometry.constellationLines.map((line) => (
      <line
        key={line.key}
        x1={line.x1}
        y1={line.y1}
        x2={line.x2}
        y2={line.y2}
        stroke="rgba(148, 163, 184, 0.30)"
        strokeWidth={1}
      />
    ))}
    {geometry.constellationLabels.map((lbl) => (
      <text
        key={lbl.abbr}
        x={lbl.px}
        y={lbl.py}
        textAnchor="middle"
        fill="rgba(186, 230, 253, 0.62)"
        fontSize={10}
        fontFamily="Jost, system-ui, sans-serif"
        letterSpacing="0.06em"
      >
        {lbl.name.toUpperCase()}
      </text>
    ))}

    {geometry.knownMarkers.map((m) => (
      <g key={m.id} data-globe-marker={m.id}>
        {m.shape === 'diamond' ? (
          <polygon
            points={`${m.px},${m.py - 8} ${m.px + 8},${m.py} ${m.px},${m.py + 8} ${
              m.px - 8
            },${m.py}`}
            fill="none"
            stroke={m.color}
            strokeWidth={1.6}
          />
        ) : (
          <polygon
            points={`${m.px},${m.py - 8} ${m.px + 8},${m.py + 7} ${m.px - 8},${m.py + 7}`}
            fill="none"
            stroke={m.color}
            strokeWidth={1.6}
          />
        )}
        <text
          x={m.px + 11}
          y={m.py + 3}
          fill={m.color}
          fontSize={10}
          fontWeight={600}
          stroke="rgba(5, 8, 15, 0.9)"
          strokeWidth={2.8}
          paintOrder="stroke"
          style={{ fontFamily: 'Inter, system-ui, sans-serif' }}
        >
          {m.label}
        </text>
      </g>
    ))}

    {isPanelGridVisible && hoverPatchPoints && (
      <polygon
        data-testid="globe-hover-panel"
        points={hoverPatchPoints}
        fill="rgba(245, 158, 11, 0.08)"
        stroke="rgba(251, 191, 36, 0.92)"
        strokeWidth={1.5}
      />
    )}
  </svg>
);
