import React from 'react';
import type { KnownCelestialObject } from '../../types/contracts';
import {
  catalogBadgeLabel,
  formatMagnitude,
  formatProperMotion,
} from '../../utils/knownObjectSelection';
import { ChevronIcon } from '../icons/ObservatoryIcons';
import type { CalloutRef } from './calloutBuilder';

/** Props for {@link BlinkerKnownObjectsSection}. */
export interface BlinkerKnownObjectsSectionProps {
  /** Whether the known-objects pane is collapsed. */
  objectsFolded: boolean;
  /** Whether the sibling controls pane is collapsed (controls flex sizing). */
  controlsFolded: boolean;
  /** Normalized `[0.25, 0.75]` height ratio allocated to the controls pane. */
  splitRatio: number;
  /** Toggle callback for the section header accordion button. */
  onToggleObjectsFold: () => void;
  /** Known celestial objects in the active sky patch. */
  knownObjects: ReadonlyArray<KnownCelestialObject>;
  /** Currently checked object IDs shown as markers in the viewport. */
  checkedIdSet: ReadonlySet<string>;
  /** Deterministic `object_id -> hexColor` marker color lookup. */
  objectHighlighterColors: Readonly<Record<string, string>>;
  /** Count of active click-tracked targets. */
  trackedCount: number;
  /** Currently pinned callout target, if any. */
  lockedCallout: CalloutRef | null;
  /** Update the pinned callout target. */
  onSetLockedCallout: (next: CalloutRef | null) => void;
  /** Dismiss any active hover callout preview. */
  onClearHover: () => void;
  /** Toggle visibility of a single known object marker. */
  onToggleKnownObject?: (objectId: string) => void;
  /** Check all known objects in the active patch. */
  onCheckAllKnownObjects?: () => void;
  /** Uncheck all known objects in the active patch. */
  onUncheckAllKnownObjects?: () => void;
  /** Clear all click-tracked Square targets. */
  onClearTrackedTargets?: () => void;
}

/**
 * Collapsible bottom pane of {@link BlinkerSidebar} displaying Select All / Clear All /
 * Untrack actions and the scrollable list of cataloged objects in the cutout.
 *
 * @param props - Known objects list, selection state, colors, and action callbacks.
 * @returns Rendered Known Objects sidebar section.
 */
export const BlinkerKnownObjectsSection: React.FC<BlinkerKnownObjectsSectionProps> = ({
  objectsFolded,
  controlsFolded,
  splitRatio,
  onToggleObjectsFold,
  knownObjects,
  checkedIdSet,
  objectHighlighterColors,
  trackedCount,
  lockedCallout,
  onSetLockedCallout,
  onClearHover,
  onToggleKnownObject,
  onCheckAllKnownObjects,
  onUncheckAllKnownObjects,
  onClearTrackedTargets,
}) => (
  <section
    className={`blinker-section-pane ${
      objectsFolded ? 'is-folded' : controlsFolded ? 'is-expanded' : ''
    }`}
    data-testid="blinker-inline-objects-panel"
    style={!objectsFolded && !controlsFolded ? { flex: `${1 - splitRatio} 1 0%` } : undefined}
  >
    <button
      type="button"
      className="blinker-section-header"
      aria-expanded={!objectsFolded}
      data-testid="blinker-objects-chevron"
      onClick={onToggleObjectsFold}
    >
      <ChevronIcon size={13} direction={objectsFolded ? 'right' : 'down'} />
      <span>
        Known Objects ({checkedIdSet.size}/{knownObjects.length})
      </span>
    </button>

    {!objectsFolded && (
      <div className="blinker-section-body blinker-section-body--objects">
        <div className="blinker-objects-actions">
          <button
            type="button"
            className="hud-btn-secondary blinker-objects-action-btn blinker-objects-action-btn--grow"
            data-testid="blinker-objects-select-all"
            onClick={() => onCheckAllKnownObjects?.()}
          >
            Select All
          </button>
          <button
            type="button"
            className="hud-btn-secondary blinker-objects-action-btn blinker-objects-action-btn--grow"
            data-testid="blinker-objects-clear-all"
            onClick={() => {
              onUncheckAllKnownObjects?.();
              if (lockedCallout?.kind === 'known') {
                onSetLockedCallout(null);
              }
            }}
          >
            Clear All
          </button>
          {trackedCount > 0 && (
            <button
              type="button"
              className="hud-btn-secondary blinker-objects-action-btn"
              data-testid="blinker-objects-clear-pins"
              onClick={() => {
                onClearTrackedTargets?.();
                if (lockedCallout?.kind === 'tracked') {
                  onSetLockedCallout(null);
                }
              }}
            >
              Untrack ({trackedCount})
            </button>
          )}
        </div>

        <div className="blinker-inline-objects-list">
          {knownObjects.length === 0 ? (
            <div className="blinker-objects-empty">
              No cataloged objects inside this cutout boundary.
            </div>
          ) : (
            knownObjects.map((obj) => {
              const checked = checkedIdSet.has(obj.object_id);
              const color = objectHighlighterColors[obj.object_id] ?? '#38bdf8';
              return (
                <div
                  key={obj.object_id}
                  className={`blinker-obj-row ${checked ? 'is-checked' : ''}`}
                >
                  <input
                    type="checkbox"
                    className="blinker-obj-checkbox"
                    checked={checked}
                    aria-label={`Toggle ${obj.label}`}
                    data-testid={`blinker-inline-obj-check-${obj.object_id}`}
                    onChange={() => onToggleKnownObject?.(obj.object_id)}
                    style={{ accentColor: color }}
                  />
                  <button
                    type="button"
                    className="blinker-obj-inspect-btn"
                    onClick={() => {
                      if (!checked) onToggleKnownObject?.(obj.object_id);
                      onClearHover();
                      onSetLockedCallout({ kind: 'known', objectId: obj.object_id });
                    }}
                    title="Click to inspect details"
                  >
                    <div className="blinker-obj-title-row">
                      <span className="blinker-obj-dot" style={{ background: color }} />
                      <span className="blinker-obj-label">{obj.label}</span>
                    </div>
                    <div className="mono blinker-obj-meta">
                      {catalogBadgeLabel(obj.catalog)} · {formatMagnitude(obj.magnitude)} ·{' '}
                      {formatProperMotion(obj.proper_motion_arcsec_yr)}
                    </div>
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    )}
  </section>
);
