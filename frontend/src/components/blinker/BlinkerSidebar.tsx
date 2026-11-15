import React, { useRef } from 'react';
import type {
  KnownCelestialObject,
  MissionName,
  TracedObjectSummary,
  ViewportRenderSettings,
} from '../../types/contracts';
import type { MissionSourceCount } from '../../utils/knownObjectSelection';
import { BlinkerControlsSection } from './BlinkerControlsSection';
import { BlinkerKnownObjectsSection } from './BlinkerKnownObjectsSection';
import type { CalloutRef } from './calloutBuilder';

/** Props for {@link BlinkerSidebar}. */
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

/**
 * Docked VS Code-style left sidebar composing {@link BlinkerControlsSection},
 * a horizontal split resizer, {@link BlinkerKnownObjectsSection}, and a vertical
 * sidebar-width resizer.
 *
 * @param props - Sidebar geometry, fold/resize handlers, render settings, and catalog state.
 * @returns Rendered Blinker sidebar and width-resize handle.
 */
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
        <BlinkerControlsSection
          controlsFolded={controlsFolded}
          objectsFolded={objectsFolded}
          splitRatio={splitRatio}
          onToggleControlsFold={onToggleControlsFold}
          renderSettings={renderSettings}
          updateRenderSettings={updateRenderSettings}
          allowedEpochIndices={allowedEpochIndices}
          availableMissions={availableMissions}
          activeMissions={activeMissions}
          toggleMissionFilter={toggleMissionFilter}
        />

        <div
          className="blinker-split-resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize Controls and Known Objects height split"
          data-testid="blinker-split-resizer"
          onPointerDown={(e) => onStartSplitRatioResize(e, sidebarRef.current)}
        />

        <BlinkerKnownObjectsSection
          objectsFolded={objectsFolded}
          controlsFolded={controlsFolded}
          splitRatio={splitRatio}
          onToggleObjectsFold={onToggleObjectsFold}
          knownObjects={knownObjects}
          checkedIdSet={checkedIdSet}
          objectHighlighterColors={objectHighlighterColors}
          trackedCount={trackedCount}
          lockedCallout={lockedCallout}
          onSetLockedCallout={onSetLockedCallout}
          onClearHover={onClearHover}
          onToggleKnownObject={onToggleKnownObject}
          onCheckAllKnownObjects={onCheckAllKnownObjects}
          onUncheckAllKnownObjects={onUncheckAllKnownObjects}
          onClearTrackedTargets={onClearTrackedTargets}
        />
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
