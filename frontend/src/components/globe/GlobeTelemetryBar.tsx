import React, { useState } from 'react';
import { getSurveyArchivalEra, wrapRaDeg } from '../../utils/observatoryMath';

interface GlobeTelemetryBarProps {
  ra: number;
  dec: number;
  fovDeg: number;
  activeSurveyLabel: string;
  isPanelGridVisible: boolean;
  onCommitCoordinates: (ra: number, dec: number) => void;
}

/** Bottom-left telemetry pill displaying editable Right Ascension, Declination, FoV, and LoD survey. */
export const GlobeTelemetryBar: React.FC<GlobeTelemetryBarProps> = ({
  ra,
  dec,
  fovDeg,
  activeSurveyLabel,
  isPanelGridVisible,
  onCommitCoordinates,
}) => {
  const [coordEditing, setCoordEditing] = useState<boolean>(false);
  const [raDraft, setRaDraft] = useState<string>('');
  const [decDraft, setDecDraft] = useState<string>('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const rawRa = coordEditing ? raDraft : ra.toFixed(4);
    const rawDec = coordEditing ? decDraft : dec.toFixed(4);
    const parsedRa = Number.parseFloat(rawRa);
    const parsedDec = Number.parseFloat(rawDec);
    if (
      !Number.isFinite(parsedRa) ||
      !Number.isFinite(parsedDec) ||
      parsedDec < -90 ||
      parsedDec > 90
    ) {
      setCoordEditing(false);
      return;
    }
    setCoordEditing(false);
    onCommitCoordinates(wrapRaDeg(parsedRa), Math.max(-89.9, Math.min(89.9, parsedDec)));
  };

  return (
    <form
      className="globe-telemetry-chip"
      data-testid="globe-telemetry-chip"
      onSubmit={handleSubmit}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <label className="telemetry-coord-label">
        <span>Right Ascension</span>
        <input
          type="text"
          inputMode="decimal"
          className="telemetry-coord-input mono"
          aria-label="Right Ascension in degrees"
          data-testid="telemetry-ra-input"
          value={coordEditing ? raDraft : ra.toFixed(4)}
          onFocus={() => {
            setRaDraft(ra.toFixed(4));
            setDecDraft(dec.toFixed(4));
            setCoordEditing(true);
          }}
          onChange={(e) => {
            if (!coordEditing) {
              setDecDraft(dec.toFixed(4));
              setCoordEditing(true);
            }
            setRaDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setCoordEditing(false);
          }}
        />
        <span>°</span>
      </label>

      <label className="telemetry-coord-label">
        <span>Declination</span>
        <input
          type="text"
          inputMode="decimal"
          className="telemetry-coord-input mono"
          aria-label="Declination in degrees"
          data-testid="telemetry-dec-input"
          value={coordEditing ? decDraft : `${dec >= 0 ? '+' : ''}${dec.toFixed(4)}`}
          onFocus={() => {
            setRaDraft(ra.toFixed(4));
            setDecDraft(dec.toFixed(4));
            setCoordEditing(true);
          }}
          onChange={(e) => {
            if (!coordEditing) {
              setRaDraft(ra.toFixed(4));
              setCoordEditing(true);
            }
            setDecDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setCoordEditing(false);
          }}
        />
        <span>°</span>
      </label>

      {coordEditing && (
        <button
          type="submit"
          className="hud-btn-primary"
          style={{ height: 22, padding: '0 8px', fontSize: 10 }}
          data-testid="telemetry-coord-go"
        >
          Go
        </button>
      )}

      <span className="globe-telemetry-divider" />
      <span className="mono">FoV {fovDeg.toFixed(1)}°</span>
      <span className="globe-telemetry-lod">
        <span className="globe-telemetry-divider" />
        <span title="All-sky background mosaics are archival stacked surveys (not live sky feeds) and exclude moving planets.">
          Sky Map: <strong>{activeSurveyLabel}</strong> · {getSurveyArchivalEra(activeSurveyLabel)}
        </span>
      </span>
      {isPanelGridVisible && (
        <span
          className="badge-pill is-star"
          style={{ fontSize: 10, padding: '2px 7px', textTransform: 'none' }}
        >
          Click any panel to inspect
        </span>
      )}
    </form>
  );
};
