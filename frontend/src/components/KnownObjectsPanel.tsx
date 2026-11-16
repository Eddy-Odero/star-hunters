import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSkyExplorer, useSkyFrustum } from '../context/SkyExplorerContext';
import { useDraggablePanel } from '../hooks/useDraggablePanel';
import { useOnClickOutside } from '../hooks/useOnClickOutside';
import {
  TRACKING_SQUARE_COLORS,
  type GlobalKnownObjectEntry,
  type KnownCelestialObject,
} from '../types/contracts';
import {
  catalogBadgeLabel,
  formatMagnitude,
  formatProperMotion,
  inferObjectClass,
  objectClassBadgeLabel,
} from '../utils/knownObjectSelection';
import {
  BENCHMARK_TARGET_OPTIONS,
  getMarkerShapeKind,
  isObjectInPatchViewBox,
  isObjectInSkyFrustum,
  sortKnownObjectsCheckedFirst,
} from '../utils/observatoryMath';
import { computeViewportViewBox } from '../utils/wcsViewport';
import { ChevronIcon, DragGripIcon, HollowShapeBadge } from './icons/ObservatoryIcons';

type PanelItem = KnownCelestialObject | GlobalKnownObjectEntry;

/**
 * Floating draggable Known Celestial Objects HUD panel (`291px` top-right default)
 * filtered live by either the 3D globe frustum or the zoomed Blinker viewBox.
 *
 * Uses deferred checked-item sorting so checked rows only float to the top when
 * clicking outside the panel or changing view frustum.
 *
 * @returns Rendered draggable Known Objects panel.
 */
export const KnownObjectsPanel: React.FC = () => {
  const {
    activePresetSlug,
    manifest,
    knownObjects,
    globalKnownObjects = [],
    objectHighlighterColors = {},
    renderSettings,
    toggleKnownObject,
    checkAllKnownObjects,
    uncheckAllKnownObjects,
    resetDefaultKnownObjects,
    focusAndTrackKnownObject,
    trackedTargets,
    isBlinkerModalOpen = false,
    openBlinkerModal,
  } = useSkyExplorer();
  const { skyFrustum, requestGlobeFocus } = useSkyFrustum();

  const { panelRef, x, y, isFolded, isDragging, toggleFolded, dragHandleProps } = useDraggablePanel(
    {
      storageKey: 'sh_hud_known_objects_v1',
      defaultAnchor: 'top-right',
      defaultWidth: 291,
      defaultHeight: 460,
      defaultFolded: false,
      mobileDefaultY: 78,
      margin: 16,
      snapThreshold: 24,
    },
  );

  // Dynamically filter the list based on the active view frustum or Blinker viewBox
  const viewportFilteredItems = useMemo<PanelItem[]>(() => {
    if (isBlinkerModalOpen && manifest) {
      const viewBox = computeViewportViewBox(
        renderSettings.zoom,
        renderSettings.panX,
        renderSettings.panY,
      );
      const epIdx = Math.min(
        renderSettings.activeEpochIndex,
        Math.max(0, manifest.epochs.length - 1),
      );
      return knownObjects.filter((obj) => {
        const epPos = obj.epoch_positions?.[Math.min(epIdx, obj.epoch_positions.length - 1)] ?? obj;
        return isObjectInPatchViewBox(epPos.x, epPos.y, viewBox);
      });
    }

    const frustum = skyFrustum ?? {
      ra: 133.7951,
      dec: -7.2451,
      fovDeg: 70,
      aspect: 1.4,
    };

    const inView = globalKnownObjects.filter((obj) =>
      isObjectInSkyFrustum(obj.ra, obj.dec, frustum),
    );

    // Prioritize primary showcase, all-sky planets/moons/comets/nebulae, then brighter stars
    const prioritized = [...inView].sort((a, b) => {
      const aPrimary = a.object_id.startsWith('primary_') || a.default_checked ? 0 : 1;
      const bPrimary = b.object_id.startsWith('primary_') || b.default_checked ? 0 : 1;
      if (aPrimary !== bPrimary) return aPrimary - bPrimary;
      const aRef = a.data_source === 'all_sky_reference_catalog' ? 0 : 1;
      const bRef = b.data_source === 'all_sky_reference_catalog' ? 0 : 1;
      if (aRef !== bRef) return aRef - bRef;
      return (a.magnitude ?? 25) - (b.magnitude ?? 25);
    });

    return prioritized.slice(0, 120);
  }, [
    globalKnownObjects,
    isBlinkerModalOpen,
    knownObjects,
    manifest,
    renderSettings.activeEpochIndex,
    renderSettings.panX,
    renderSettings.panY,
    renderSettings.zoom,
    skyFrustum,
  ]);

  // Deferred Checked-Item Sorting:
  // Record committed order only when view changes initially OR when clicking OUTSIDE the panel.
  const [committedOrderIds, setCommittedOrderIds] = useState<string[]>([]);
  const latestCheckedRef = useRef<string[]>(renderSettings.checkedObjectIds);
  const latestFilteredRef = useRef<PanelItem[]>(viewportFilteredItems);
  const userToggledInsideRef = useRef<boolean>(false);

  useEffect(() => {
    latestCheckedRef.current = renderSettings.checkedObjectIds;
    latestFilteredRef.current = viewportFilteredItems;
  }, [renderSettings.checkedObjectIds, viewportFilteredItems]);

  const commitSortedOrder = useCallback(() => {
    const sorted = sortKnownObjectsCheckedFirst(
      latestFilteredRef.current,
      latestCheckedRef.current,
    );
    userToggledInsideRef.current = false;
    setCommittedOrderIds(sorted.map((item) => item.object_id));
  }, []);

  // Re-initialize display order when the filtered viewport objects change (e.g. target switch or pan)
  const filterSignature = useMemo(
    () => viewportFilteredItems.map((o) => o.object_id).join('|'),
    [viewportFilteredItems],
  );

  useEffect(() => {
    if (!userToggledInsideRef.current) {
      commitSortedOrder();
    }
  }, [filterSignature, commitSortedOrder]);

  // Sort checked items to the top ONLY after the user clicks outside the panel
  useOnClickOutside(
    panelRef,
    () => {
      if (userToggledInsideRef.current) {
        commitSortedOrder();
      }
    },
    !isFolded,
  );

  const displayItems = useMemo(() => {
    if (committedOrderIds.length === 0) return viewportFilteredItems;
    const rank = new Map<string, number>();
    committedOrderIds.forEach((id, idx) => rank.set(id, idx));
    return [...viewportFilteredItems].sort((a, b) => {
      const ra = rank.get(a.object_id);
      const rb = rank.get(b.object_id);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return 0;
    });
  }, [committedOrderIds, viewportFilteredItems]);

  const trackedIdSet = useMemo(() => {
    const s = new Set<string>();
    for (const t of trackedTargets) {
      if (t.matchedObjectId) s.add(t.matchedObjectId);
    }
    return s;
  }, [trackedTargets]);

  const handleBenchmarkJump = (slug: string) => {
    const opt = BENCHMARK_TARGET_OPTIONS.find((b) => b.slug === slug);
    if (!opt) return;
    requestGlobeFocus?.(opt.ra, opt.dec, 2.2);
    if (isBlinkerModalOpen) {
      openBlinkerModal?.(opt.slug);
    }
  };

  return (
    <aside
      ref={panelRef}
      data-testid="known-objects-panel"
      aria-label="Known Celestial Objects"
      className={`hud-panel known-objects-panel ${isDragging ? 'is-dragging' : ''} ${
        isFolded ? 'is-folded' : ''
      }`}
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      <div className="hud-drag-handle" {...dragHandleProps}>
        <div className="hud-title-group">
          <span className="hud-grip-icon">
            <DragGripIcon size={14} />
          </span>
          <h2 className="hud-title">Known Objects</h2>
          <span
            className="badge-pill mono"
            data-testid="known-objects-visible-count"
            title="Objects visible inside the current sky view"
          >
            {displayItems.length}
          </span>
        </div>

        <button
          type="button"
          className="hud-icon-btn"
          onClick={toggleFolded}
          aria-expanded={!isFolded}
          aria-label={isFolded ? 'Expand Known Objects panel' : 'Collapse Known Objects panel'}
          data-testid="known-objects-chevron"
        >
          <ChevronIcon size={15} direction={isFolded ? 'down' : 'up'} />
        </button>
      </div>

      {!isFolded && (
        <>
          <div className="known-panel-toolbar">
            <div className="known-benchmark-row">
              <label htmlFor="benchmark-jump-select" className="known-benchmark-label">
                Benchmark
              </label>
              <select
                id="benchmark-jump-select"
                data-testid="benchmark-jump-select"
                className="hud-select known-benchmark-select"
                value={activePresetSlug ?? ''}
                onChange={(e) => {
                  if (e.target.value) handleBenchmarkJump(e.target.value);
                }}
              >
                <option value="" disabled>
                  Jump to target...
                </option>
                {BENCHMARK_TARGET_OPTIONS.map((b) => (
                  <option key={b.slug} value={b.slug}>
                    {b.label} ({b.subtitle})
                  </option>
                ))}
              </select>
            </div>

            {isBlinkerModalOpen && (
              <div className="known-selection-bar">
                <span className="known-selection-count">
                  {renderSettings.checkedObjectIds.length} active
                </span>
                <div className="known-selection-actions">
                  <button
                    type="button"
                    className="hud-btn-secondary known-selection-btn"
                    onClick={checkAllKnownObjects}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className="hud-btn-secondary known-selection-btn"
                    onClick={resetDefaultKnownObjects}
                  >
                    Notable
                  </button>
                  <button
                    type="button"
                    className="hud-btn-secondary known-selection-btn"
                    onClick={uncheckAllKnownObjects}
                  >
                    None
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="known-objects-scroll" role="list" data-testid="known-objects-list">
            {displayItems.length === 0 ? (
              <div className="known-objects-empty">
                No cataloged objects fall within this sky frustum. Pan or jump to a benchmark
                target.
              </div>
            ) : (
              displayItems.map((obj, idx) => {
                const isChecked = renderSettings.checkedObjectIds.includes(obj.object_id);
                const isTracked = trackedIdSet.has(obj.object_id);
                const shapeKind = getMarkerShapeKind(obj, isTracked);
                const color =
                  objectHighlighterColors[obj.object_id] ??
                  TRACKING_SQUARE_COLORS[idx % TRACKING_SQUARE_COLORS.length];
                const objClass = inferObjectClass(obj);
                const isMoverClass =
                  objClass === 'planet' ||
                  objClass === 'moon' ||
                  objClass === 'comet' ||
                  objClass === 'asteroid' ||
                  objClass === 'brown_dwarf';

                return (
                  <div
                    key={obj.object_id}
                    role="listitem"
                    data-object-id={obj.object_id}
                    data-testid="known-object-card"
                    className={`known-object-card ${isChecked ? 'is-checked' : ''}`}
                    onClick={() => focusAndTrackKnownObject?.(obj)}
                  >
                    <input
                      type="checkbox"
                      className="known-object-checkbox"
                      checked={isChecked}
                      aria-label={`Highlight ${obj.label}`}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => {
                        userToggledInsideRef.current = true;
                        toggleKnownObject(obj.object_id);
                      }}
                    />

                    <div className="known-object-body">
                      <div className="known-object-header">
                        <span className="known-object-name" title={obj.label}>
                          {obj.label}
                        </span>
                        <HollowShapeBadge shape={shapeKind} color={color} size={14} />
                      </div>

                      <div className="known-object-pills">
                        <span className={`badge-pill ${isMoverClass ? 'is-mover' : 'is-star'}`}>
                          {objectClassBadgeLabel(objClass)}
                        </span>
                        <span className="badge-pill">{catalogBadgeLabel(obj.catalog)}</span>
                      </div>

                      <div className="known-object-meta mono">
                        {formatMagnitude(obj.magnitude)} ·{' '}
                        {formatProperMotion(obj.proper_motion_arcsec_yr)}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </aside>
  );
};
