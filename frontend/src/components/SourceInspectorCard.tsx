import React from 'react';
import { useSkyExplorer } from '../context/SkyExplorerContext';

export const SourceInspectorCard: React.FC = () => {
  const {
    trackedTargets,
    selectedObject,
    lastClickDiagnostic,
    removeTrackedTarget,
    clearTrackedTargets,
  } = useSkyExplorer();

  if (trackedTargets.length === 0 && !lastClickDiagnostic) {
    return (
      <div className="source-inspector-card" role="region" aria-label="Source Inspector">
        <h3>Source Inspector &amp; Astrometric Tracking</h3>
        <p className="inspector-empty">
          Click any point on the sky viewport to detect and track stationary stars or moving bodies
          across epochs.
        </p>
      </div>
    );
  }

  return (
    <div className="source-inspector-card" role="region" aria-label="Source Inspector">
      <div className="inspector-header">
        <h3>Source Inspector &amp; Astrometric Tracking</h3>
        {trackedTargets.length > 0 && (
          <button type="button" className="mode-btn" onClick={clearTrackedTargets}>
            Clear All Tracks ({trackedTargets.length})
          </button>
        )}
      </div>

      {lastClickDiagnostic && lastClickDiagnostic.status === 'no_body_found' && (
        <div className="diagnostic-banner warning" role="status">
          <strong>No Body Found:</strong> {lastClickDiagnostic.message} (Clicked at pixel [
          {lastClickDiagnostic.clickX.toFixed(1)}, {lastClickDiagnostic.clickY.toFixed(1)}], Frame #
          {lastClickDiagnostic.epochIndex + 1})
        </div>
      )}

      {trackedTargets.length > 0 && (
        <div className="tracked-targets-summary">
          <h4>Active Tracked Targets ({trackedTargets.length})</h4>
          <div className="tracked-chips">
            {trackedTargets.map((track) => {
              const isSelected = selectedObject?.trackId === track.trackId;
              return (
                <div
                  key={track.trackId}
                  className={isSelected ? 'tracked-chip active' : 'tracked-chip'}
                >
                  <span
                    className="track-swatch"
                    style={{ backgroundColor: track.color }}
                    aria-hidden="true"
                  />
                  <span className="track-chip-label">
                    {track.matchedLabel ?? `Mover #${track.trackId.slice(0, 6)}`}
                  </span>
                  {track.isOverlappedAtOrigin && (
                    <span
                      className="branch-badge"
                      title="Separated from overlapped sources at origin"
                    >
                      Overlapped Branch
                    </span>
                  )}
                  <button
                    type="button"
                    className="remove-chip-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeTrackedTarget(track.trackId);
                    }}
                    aria-label={`Remove ${track.matchedLabel ?? `track ${track.trackId.slice(0, 6)}`}`}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {selectedObject && (
        <div className="selected-object-details">
          <div className="selected-title-row">
            <h4>
              Focused Track Details:{' '}
              {selectedObject.matchedLabel ?? 'Uncataloged Infrared Mover Candidate'}
            </h4>
            <span
              className="catalog-badge"
              style={{ borderColor: selectedObject.color, color: selectedObject.color }}
            >
              {selectedObject.matchedCatalog
                ? selectedObject.matchedCatalog.toUpperCase()
                : 'CANDIDATE'}
            </span>
          </div>

          <p className="selected-metrics">
            <strong>Proper Motion:</strong> {selectedObject.properMotionArcsecPerYr.toFixed(3)}
            &Prime;/yr &bull; <strong>Origin Centroid:</strong> (
            {selectedObject.originCentroidX.toFixed(1)}, {selectedObject.originCentroidY.toFixed(1)}
            ) &bull; <strong>Status:</strong> {selectedObject.status}
          </p>

          <div className="waypoints-table-container">
            <table className="waypoints-table">
              <thead>
                <tr>
                  <th>Epoch ID</th>
                  <th>MJD</th>
                  <th>Pixel (X, Y)</th>
                  <th>Sky (RA, Dec)</th>
                  <th>SNR</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {selectedObject.waypoints.map((wp) => (
                  <tr key={wp.epoch_id} className={`wp-status-${wp.status}`}>
                    <td>{wp.epoch_id}</td>
                    <td>{wp.mjd.toFixed(1)}</td>
                    <td>
                      ({wp.x.toFixed(1)}, {wp.y.toFixed(1)})
                    </td>
                    <td>
                      ({wp.ra.toFixed(4)}&deg;, {wp.dec.toFixed(4)}&deg;)
                    </td>
                    <td>{wp.snr.toFixed(1)}</td>
                    <td>
                      <span className={`status-pill ${wp.status}`}>{wp.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default SourceInspectorCard;
