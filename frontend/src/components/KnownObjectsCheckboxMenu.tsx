import React, { useState, useMemo } from 'react';
import { useSkyExplorer } from '../context/SkyExplorerContext';
import {
  catalogBadgeLabel,
  formatMagnitude,
  formatProperMotion,
  fuzzySearchKnownObjects,
  inferObjectClass,
  isMovingSolarSystemObject,
  objectClassBadgeLabel,
} from '../utils/knownObjectSelection';

export const KnownObjectsCheckboxMenu: React.FC = () => {
  const {
    activePresetSlug,
    knownObjects,
    objectHighlighterColors,
    globalKnownObjects,
    renderSettings,
    toggleKnownObject,
    checkAllKnownObjects,
    uncheckAllKnownObjects,
    resetDefaultKnownObjects,
    focusAndTrackKnownObject,
  } = useSkyExplorer();

  const [filterQuery, setFilterQuery] = useState('');

  const filteredObjects = useMemo(
    () => fuzzySearchKnownObjects(knownObjects, filterQuery),
    [knownObjects, filterQuery],
  );

  const crossPatchMatches = useMemo(() => {
    const clean = filterQuery.trim();
    if (!clean || !globalKnownObjects || globalKnownObjects.length === 0) return [];
    const localIds = new Set(knownObjects.map((o) => o.object_id));
    return fuzzySearchKnownObjects(globalKnownObjects, clean)
      .filter((entry) => !localIds.has(entry.object_id) && entry.target_slug !== activePresetSlug)
      .slice(0, 12);
  }, [filterQuery, globalKnownObjects, knownObjects, activePresetSlug]);

  return (
    <aside className="known-objects-panel" aria-label="Known Celestial Objects">
      <div className="panel-header">
        <h2>Known Celestial Objects ({knownObjects.length})</h2>
        <div className="checkbox-actions">
          <button type="button" onClick={checkAllKnownObjects}>
            Check All
          </button>
          <button type="button" onClick={uncheckAllKnownObjects}>
            Uncheck All
          </button>
          <button type="button" onClick={resetDefaultKnownObjects}>
            Notable Only
          </button>
        </div>
      </div>

      <div className="known-filter-container">
        <input
          type="text"
          aria-label="Filter known celestial objects"
          placeholder="Fuzzy search celestial objects by name, Gaia/WISE ID, or type..."
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          className="known-filter-input"
        />
      </div>

      <ul className="known-object-list">
        {filteredObjects.length === 0 && crossPatchMatches.length === 0 ? (
          <li className="no-objects-item">No matching celestial objects found.</li>
        ) : (
          filteredObjects.map((obj) => {
            const checked = renderSettings.checkedObjectIds.includes(obj.object_id);
            const swatchColor = objectHighlighterColors?.[obj.object_id] ?? '#00F5D4';
            return (
              <li key={obj.object_id} className="known-object-row">
                <label className="known-object-label">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleKnownObject(obj.object_id)}
                  />
                  <span
                    className="highlighter-color-swatch"
                    style={{
                      display: 'inline-block',
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      backgroundColor: swatchColor,
                      marginRight: 6,
                      flexShrink: 0,
                    }}
                    aria-hidden="true"
                  />
                  <div className="known-object-details">
                    <span className="obj-name">{obj.label}</span>
                    <span className="obj-meta">
                      <span className={`catalog-badge catalog-badge-${obj.catalog}`}>
                        {catalogBadgeLabel(obj.catalog)}
                      </span>{' '}
                      <span className={`class-badge class-badge-${inferObjectClass(obj)}`}>
                        {objectClassBadgeLabel(inferObjectClass(obj))}
                      </span>
                      {isMovingSolarSystemObject(obj) ? ' • Mover' : ''} •{' '}
                      {formatMagnitude(obj.magnitude)} •{' '}
                      {formatProperMotion(obj.proper_motion_arcsec_yr)}
                    </span>
                  </div>
                </label>
                {focusAndTrackKnownObject && (
                  <button
                    type="button"
                    className="track-object-btn"
                    onClick={() => focusAndTrackKnownObject(obj)}
                    title={`Lock and track ${obj.label} across SPHEREx passes`}
                  >
                    Track
                  </button>
                )}
              </li>
            );
          })
        )}

        {crossPatchMatches.length > 0 && (
          <>
            <li className="cross-patch-divider">
              Global Catalogue Matches ({crossPatchMatches.length})
            </li>
            {crossPatchMatches.map((entry) => (
              <li
                key={`${entry.target_slug ?? 'global'}_${entry.object_id}`}
                className="known-object-row cross-patch-row"
              >
                <div className="known-object-details">
                  <span className="obj-name">{entry.label}</span>
                  <span className="obj-meta">
                    <span className={`catalog-badge catalog-badge-${entry.catalog}`}>
                      {catalogBadgeLabel(entry.catalog)}
                    </span>{' '}
                    {entry.target_name ?? entry.target_slug} ({entry.constellation}) •{' '}
                    {formatMagnitude(entry.magnitude)} •{' '}
                    {formatProperMotion(entry.proper_motion_arcsec_yr)}
                  </span>
                </div>
                {focusAndTrackKnownObject && (
                  <button
                    type="button"
                    className="track-object-btn"
                    onClick={() => focusAndTrackKnownObject(entry, entry.target_slug)}
                  >
                    Jump &amp; Track
                  </button>
                )}
              </li>
            ))}
          </>
        )}
      </ul>
    </aside>
  );
};

export default KnownObjectsCheckboxMenu;
