import React, { useMemo, useRef } from 'react';
import type {
  ComparisonMode,
  KnownCelestialObject,
  MissionName,
  TracedObjectSummary,
  ViewportRenderSettings,
} from '../../types/contracts';
import {
  catalogBadgeLabel,
  formatMagnitude,
  formatProperMotion,
  type MissionSourceCount,
} from '../../utils/knownObjectSelection';
import { DualThumbRangeSlider } from '../DualThumbRangeSlider';
import { ChevronIcon } from '../icons/ObservatoryIcons';
import type { CalloutRef } from './calloutBuilder';

interface BlinkerSidebarProps {
  sidebarWidth: number;
  splitRatio: number;
  controlsFolded: boolean;
  objectsFolded: boolean;
  onToggleControlsFold: () => void;
  onToggleObjectsFold: () => void;
  onStartSidebarWidthResize: (e: React.PointerEvent<HTMLDivElement>) => void;
  onStartSplitRatioResize: (
    e: React.PointerEvent<HTMLDivElement>,
    sidebarEl: HTMLElement | null,
  ) => void;
  renderSettings: ViewportRenderSettings;
  updateRenderSettings: (partial: Partial<ViewportRenderSettings>) => void;
  allowedEpochIndices: readonly number[];
  availableMissions: ReadonlyArray<MissionSourceCount>;
  activeMissions: ReadonlyArray<MissionName>;
  toggleMissionFilter?: (mission: MissionName) => void;
  knownObjects: ReadonlyArray<KnownCelestialObject>;
  checkedIdSet: ReadonlySet<string>;
  objectHighlighterColors: Readonly<Record<string, string>>;
  trackedCount: number;
  lockedCallout: CalloutRef | null;
  onSetLockedCallout: (next: CalloutRef | null) => void;
  onClearHover: () => void;
  onToggleKnownObject?: (objectId: string) => void;
  onCheckAllKnownObjects?: () => void;
  onUncheckAllKnownObjects?: () => void;
  onClearTrackedTargets?: () => void;
}

const WAVELENGTH_PRESETS: ReadonlyArray<{ label: string; range: [number, number] }> = [
  { label: 'All 0.75-5.0', range: [0.75, 5.0] },
  { label: 'Cold 3.8-5.0', range: [3.8, 5.0] },
  { label: 'Ice 2.4-3.8', range: [2.4, 3.8] },
];

/** Docked VS Code-style left sidebar containing Pass & Band Controls and Known Objects sections. */
export const BlinkerSidebar: React.FC<BlinkerSidebarProps> = ({
  sidebarWidth,
  splitRatio,
  controlsFolded,
  objectsFolded,
  onToggleControlsFold,
  onToggleObjectsFold,
  onStartSidebarWidthResize,
  onStartSplitRatioResize,
  renderSettings,
  updateRenderSettings,
  allowedEpochIndices,
  availableMissions,
  activeMissions,
  toggleMissionFilter,
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
}) => {
  const sidebarRef = useRef<HTMLElement | null>(null);

  const onlyOneMissionActive = useMemo(
    () => availableMissions.filter((m) => activeMissions.includes(m.mission)).length <= 1,
    [activeMissions, availableMissions],
  );

  const passPosA = Math.max(0, allowedEpochIndices.indexOf(renderSettings.passAIndex));
  const passPosB = Math.max(passPosA + 1, allowedEpochIndices.indexOf(renderSettings.passBIndex));

  return (
    <>
      <aside
        ref={sidebarRef}
        className="blinker-sidebar"
        style={{ width: sidebarWidth }}
        aria-label="Infrared Blinker, Wavelength & Known Objects Sidebar"
        data-testid="blinker-controls-card"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      >
        <section
          className="blinker-section-pane"
          style={
            controlsFolded
              ? { flex: '0 0 auto' }
              : objectsFolded
                ? { flex: '1 1 auto' }
                : { flex: `${splitRatio} 1 0%` }
          }
        >
          <button
            type="button"
            className="blinker-section-header"
            aria-expanded={!controlsFolded}
            data-testid="blinker-controls-chevron"
            onClick={onToggleControlsFold}
          >
            <ChevronIcon size={13} direction={controlsFolded ? 'right' : 'down'} />
            <span>Pass &amp; Band Controls</span>
          </button>

          {!controlsFolded && (
            <div className="blinker-section-body">
              <div>
                <DualThumbRangeSlider
                  label="Wavelength Slice"
                  variant="spectrum"
                  min={0.75}
                  max={5.0}
                  step={0.05}
                  minGap={0.15}
                  value={renderSettings.wavelengthRangeUm}
                  formatReadout={(lo, hi) => `${lo.toFixed(2)}-${hi.toFixed(2)} µm`}
                  lowAriaLabel="Minimum wavelength micrometers"
                  highAriaLabel="Maximum wavelength micrometers"
                  testId="wavelength-dual-slider"
                  onChange={(next) => updateRenderSettings({ wavelengthRangeUm: next })}
                />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                  {WAVELENGTH_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      className="hud-btn-secondary"
                      style={{ height: 22, padding: '0 6px', fontSize: 10 }}
                      onClick={() => updateRenderSettings({ wavelengthRangeUm: preset.range })}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div
                  className="mode-segmented-pill"
                  role="tablist"
                  aria-label="Comparison Mode"
                  data-testid="comparison-mode-pill"
                >
                  {(
                    [
                      { id: 'blink', label: 'Blink' },
                      { id: 'subtract', label: 'Subtract' },
                      { id: 'coadd', label: 'Add' },
                    ] as Array<{ id: ComparisonMode; label: string }>
                  ).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="tab"
                      aria-selected={renderSettings.mode === m.id}
                      data-testid={`mode-btn-${m.id}`}
                      className={`mode-segmented-btn ${
                        renderSettings.mode === m.id ? 'is-active' : ''
                      }`}
                      onClick={() => updateRenderSettings({ mode: m.id })}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>

                {allowedEpochIndices.length >= 2 && (
                  <DualThumbRangeSlider
                    label={
                      renderSettings.mode === 'coadd' ? 'Co-Add Pass Span' : 'Pass Pair Window'
                    }
                    variant="plain"
                    min={1}
                    max={allowedEpochIndices.length}
                    step={1}
                    minGap={1}
                    value={[
                      Math.min(passPosA + 1, allowedEpochIndices.length - 1),
                      Math.max(2, Math.min(allowedEpochIndices.length, passPosB + 1)),
                    ]}
                    formatReadout={(lo, hi) => {
                      const idxA = allowedEpochIndices[lo - 1] ?? 0;
                      const idxB =
                        allowedEpochIndices[hi - 1] ??
                        allowedEpochIndices[allowedEpochIndices.length - 1] ??
                        1;
                      return renderSettings.mode === 'subtract'
                        ? `P${idxB + 1} - P${idxA + 1}`
                        : `P${idxA + 1} .. P${idxB + 1}`;
                    }}
                    lowAriaLabel="Left reference pass"
                    highAriaLabel="Right target pass"
                    testId="pass-dual-slider"
                    onChange={([lo, hi]) => {
                      const posA = Math.max(0, Math.min(allowedEpochIndices.length - 2, lo - 1));
                      const posB = Math.max(
                        posA + 1,
                        Math.min(allowedEpochIndices.length - 1, hi - 1),
                      );
                      const idxA = allowedEpochIndices[posA] ?? 0;
                      const idxB = allowedEpochIndices[posB] ?? idxA;
                      updateRenderSettings({
                        passAIndex: idxA,
                        passBIndex: idxB,
                        coaddIndices: allowedEpochIndices.slice(posA, posB + 1),
                      });
                    }}
                  />
                )}
              </div>

              <div>
                <div className="control-section-header" style={{ marginBottom: 4 }}>
                  <span className="control-section-title">Mission Sources</span>
                </div>
                <div className="mission-filter-row" data-testid="mission-filter-row">
                  {availableMissions.map(({ mission, count }) => {
                    const enabled = activeMissions.includes(mission);
                    const isLockedLast = enabled && onlyOneMissionActive;
                    return (
                      <button
                        key={mission}
                        type="button"
                        aria-pressed={enabled}
                        data-testid={`mission-pill-${mission}`}
                        className={`mission-pill-btn ${enabled ? 'is-enabled' : ''}`}
                        disabled={isLockedLast}
                        title={
                          isLockedLast
                            ? 'At least one active mission source must remain enabled'
                            : `${enabled ? 'Hide' : 'Show'} ${mission} (${count} passes)`
                        }
                        onClick={() => toggleMissionFilter?.(mission)}
                      >
                        <span
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: '50%',
                            background: enabled
                              ? 'var(--accent-cyan)'
                              : 'rgba(148, 163, 184, 0.35)',
                          }}
                        />
                        <span>
                          {mission} ({count})
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </section>

        <div
          className="blinker-split-resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize Controls and Known Objects height split"
          data-testid="blinker-split-resizer"
          onPointerDown={(e) => onStartSplitRatioResize(e, sidebarRef.current)}
        />

        <section
          className="blinker-section-pane"
          data-testid="blinker-inline-objects-panel"
          style={
            objectsFolded
              ? { flex: '0 0 auto' }
              : controlsFolded
                ? { flex: '1 1 auto' }
                : { flex: `${1 - splitRatio} 1 0%` }
          }
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
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, flexShrink: 0 }}>
                <button
                  type="button"
                  className="hud-btn-secondary"
                  style={{ flex: 1, height: 24, fontSize: 11, padding: '0 8px' }}
                  data-testid="blinker-objects-select-all"
                  onClick={() => onCheckAllKnownObjects?.()}
                >
                  Select All
                </button>
                <button
                  type="button"
                  className="hud-btn-secondary"
                  style={{ flex: 1, height: 24, fontSize: 11, padding: '0 8px' }}
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
                    className="hud-btn-secondary"
                    style={{ height: 24, fontSize: 11, padding: '0 8px' }}
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
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 6 }}>
                    No cataloged objects inside this cutout boundary.
                  </div>
                ) : (
                  knownObjects.map((obj) => {
                    const checked = checkedIdSet.has(obj.object_id);
                    const color = objectHighlighterColors[obj.object_id] ?? '#38bdf8';
                    return (
                      <div
                        key={obj.object_id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 7,
                          padding: '5px 7px',
                          borderRadius: 8,
                          background: checked ? 'rgba(30, 41, 59, 0.72)' : 'rgba(15, 23, 42, 0.42)',
                          border: `1px solid ${
                            checked ? 'rgba(56, 189, 248, 0.35)' : 'var(--border-hairline)'
                          }`,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          aria-label={`Toggle ${obj.label}`}
                          data-testid={`blinker-inline-obj-check-${obj.object_id}`}
                          onChange={() => onToggleKnownObject?.(obj.object_id)}
                          style={{ accentColor: color, cursor: 'pointer', flexShrink: 0 }}
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
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 5,
                              fontWeight: 600,
                            }}
                          >
                            <span
                              style={{
                                width: 7,
                                height: 7,
                                borderRadius: '50%',
                                background: color,
                                flexShrink: 0,
                              }}
                            />
                            <span style={{ overflowWrap: 'anywhere' }}>{obj.label}</span>
                          </div>
                          <div
                            className="mono"
                            style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}
                          >
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
      </aside>

      <div
        className="blinker-sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Blinker Sidebar Width"
        data-testid="blinker-sidebar-resizer"
        onPointerDown={onStartSidebarWidthResize}
      />
    </>
  );
};

export type { TracedObjectSummary };
