import React, { useState, useMemo } from 'react';
import { useSkyExplorer } from '../context/SkyExplorerContext';
import {
  catalogBadgeLabel,
  formatMagnitude,
  formatProperMotion,
} from '../utils/knownObjectSelection';

export const KnownObjectsCheckboxMenu: React.FC = () => {
  const {
    knownObjects,
    renderSettings,
    toggleKnownObject,
    checkAllKnownObjects,
    uncheckAllKnownObjects,
    resetDefaultKnownObjects,
  } = useSkyExplorer();

  const [filterQuery, setFilterQuery] = useState('');

  const filteredObjects = useMemo(() => {
    if (!filterQuery.trim()) return knownObjects;
    const q = filterQuery.toLowerCase();
    return knownObjects.filter(
      (obj) =>
        obj.label.toLowerCase().includes(q) ||
        obj.catalog.toLowerCase().includes(q) ||
        obj.object_type.toLowerCase().includes(q) ||
        obj.object_id.toLowerCase().includes(q),
    );
  }, [knownObjects, filterQuery]);

  return (
    <aside className="known-objects-panel">
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
          placeholder="Filter catalog objects..."
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          className="known-filter-input"
        />
      </div>

      <ul className="known-object-list">
        {filteredObjects.length === 0 ? (
          <li className="no-objects-item">No matching celestial objects found.</li>
        ) : (
          filteredObjects.map((obj) => {
            const checked = renderSettings.checkedObjectIds.includes(obj.object_id);
            return (
              <li key={obj.object_id} className="known-object-row">
                <label className="known-object-label">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleKnownObject(obj.object_id)}
                  />
                  <div className="known-object-details">
                    <span className="obj-name">{obj.label}</span>
                    <span className="obj-meta">
                      <span className={`catalog-badge catalog-badge-${obj.catalog}`}>
                        {catalogBadgeLabel(obj.catalog)}
                      </span>{' '}
                      {obj.object_type} • {formatMagnitude(obj.magnitude)} •{' '}
                      {formatProperMotion(obj.proper_motion_arcsec_yr)}
                    </span>
                  </div>
                </label>
              </li>
            );
          })
        )}
      </ul>
    </aside>
  );
};

export default KnownObjectsCheckboxMenu;