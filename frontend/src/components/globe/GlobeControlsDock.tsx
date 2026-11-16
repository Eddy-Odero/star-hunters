import React from 'react';
import { SUPPORTED_GLOBE_PROJECTIONS, type GlobeProjection } from '../../utils/globeNavigation';

interface GlobeControlsDockProps {
  showConstellations: boolean;
  projection: GlobeProjection;
  onPan: (dir: 'north' | 'south' | 'east' | 'west') => void;
  onZoom: (factor: number | 'reset') => void;
  onToggleConstellations: () => void;
  onChangeProjection: (nextProj: GlobeProjection) => void;
}

/** Accessible pan/zoom cross, constellation toggle, and Aladin projection selector dock. */
export const GlobeControlsDock: React.FC<GlobeControlsDockProps> = ({
  showConstellations,
  projection,
  onPan,
  onZoom,
  onToggleConstellations,
  onChangeProjection,
}) => (
  <div
    className="globe-controls-dock"
    data-testid="globe-nav-controls"
    role="group"
    aria-label="Sky Globe Pan, Zoom and Overlay Controls"
    onPointerDown={(e) => e.stopPropagation()}
    onPointerUp={(e) => e.stopPropagation()}
    onClick={(e) => e.stopPropagation()}
  >
    <div className="globe-pan-cross" aria-label="Pan Sky Coordinates">
      <span />
      <button
        type="button"
        className="globe-nav-btn"
        aria-label="Pan North (Increase Declination)"
        title="Pan North"
        data-testid="globe-pan-north"
        onClick={() => onPan('north')}
      >
        N
      </button>
      <span />
      <button
        type="button"
        className="globe-nav-btn"
        aria-label="Pan West (Decrease Right Ascension)"
        title="Pan West"
        data-testid="globe-pan-west"
        onClick={() => onPan('west')}
      >
        W
      </button>
      <button
        type="button"
        className="globe-nav-btn"
        aria-label="Pan South (Decrease Declination)"
        title="Pan South"
        data-testid="globe-pan-south"
        onClick={() => onPan('south')}
      >
        S
      </button>
      <button
        type="button"
        className="globe-nav-btn"
        aria-label="Pan East (Increase Right Ascension)"
        title="Pan East"
        data-testid="globe-pan-east"
        onClick={() => onPan('east')}
      >
        E
      </button>
    </div>

    <span className="globe-telemetry-divider" style={{ height: 24 }} />

    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <button
        type="button"
        className="globe-nav-btn"
        aria-label="Zoom In"
        title="Zoom In"
        data-testid="globe-zoom-in"
        onClick={() => onZoom(0.62)}
      >
        +
      </button>
      <button
        type="button"
        className="globe-nav-btn"
        aria-label="Zoom Out"
        title="Zoom Out"
        data-testid="globe-zoom-out"
        onClick={() => onZoom(1.48)}
      >
        -
      </button>
      <button
        type="button"
        className="globe-nav-btn"
        aria-label="Reset Sky Zoom"
        title="Reset View (70 deg FoV)"
        data-testid="globe-zoom-reset"
        onClick={() => onZoom('reset')}
      >
        Reset
      </button>
    </div>

    <span className="globe-telemetry-divider" style={{ height: 24 }} />

    <button
      type="button"
      className={`globe-nav-btn ${showConstellations ? 'is-active' : ''}`}
      aria-pressed={showConstellations}
      aria-label="Toggle Constellation Lines and Labels"
      data-testid="globe-constellations-toggle"
      onClick={onToggleConstellations}
    >
      Constellations
    </button>

    <select
      aria-label="Sky Globe Projection"
      data-testid="globe-projection-select"
      className="globe-nav-btn"
      style={{ paddingRight: 6 }}
      value={projection}
      onChange={(e) => onChangeProjection(e.target.value as GlobeProjection)}
    >
      {SUPPORTED_GLOBE_PROJECTIONS.map((opt) => (
        <option key={opt.id} value={opt.id}>
          {opt.label}
        </option>
      ))}
    </select>
  </div>
);
