import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSkyExplorer } from '../context/SkyExplorerContext';
import { useOptionalNotifications } from '../context/NotificationContext';
import { useDraggablePanel } from '../hooks/useDraggablePanel';
import type {
  GlobalKnownObjectEntry,
  ObjectObservationEpoch,
  ObjectObservationEpochsResponse,
} from '../types/contracts';
import { fuzzySearchKnownObjects, isMovingSolarSystemObject } from '../utils/knownObjectSelection';
import {
  angularSeparationDeg,
  BENCHMARK_TARGET_OPTIONS,
  formatRaDecCompact,
  parseSkySearchInput,
} from '../utils/observatoryMath';
import { observatoryLogger } from '../utils/observatoryLogger';
import {
  ChevronIcon,
  CloseIcon,
  CompassZenithIcon,
  DragGripIcon,
  SearchIcon,
} from './icons/ObservatoryIcons';
import { ZenithConverterDrawer } from './hud/ZenithConverterDrawer';

/**
 * Top-left draggable Search & Earth-to-Sky Zenith HUD panel providing coordinate/text
 * fuzzy sky search (merged with live `/api/v1/catalogs/search` results) and the
 * collapsible {@link ZenithConverterDrawer}.
 *
 * @returns Rendered floating search and zenith HUD menu.
 */
export const FloatingSearchZenithMenu: React.FC = () => {
  const {
    globalKnownObjects = [],
    requestGlobeFocus,
    navigateToCoordinates,
    selectPreset,
    openBlinkerModal,
    getSkyFrustum,
  } = useSkyExplorer();
  const notifications = useOptionalNotifications();

  const { panelRef, x, y, isFolded, isDragging, toggleFolded, dragHandleProps } = useDraggablePanel(
    {
      storageKey: 'sh_hud_search_zenith_v1',
      defaultAnchor: 'top-left',
      defaultWidth: 368,
      defaultHeight: 54,
      defaultFolded: true,
      margin: 16,
      snapThreshold: 24,
    },
  );

  const [searchExpanded, setSearchExpanded] = useState<boolean>(true);
  const [searchText, setSearchText] = useState<string>('');
  const [searchFocused, setSearchFocused] = useState<boolean>(false);
  const [liveSearchState, setLiveSearchState] = useState<{
    query: string;
    results: GlobalKnownObjectEntry[];
  }>({ query: '', results: [] });
  const [selectedSearchTarget, setSelectedSearchTarget] = useState<GlobalKnownObjectEntry | null>(
    null,
  );
  const [targetEpochs, setTargetEpochs] = useState<ObjectObservationEpoch[]>([]);
  const [selectedEpochKey, setSelectedEpochKey] = useState<string>('current');
  const [passesStatus, setPassesStatus] = useState<string | null>(null);
  const [epochsLoading, setEpochsLoading] = useState<boolean>(false);
  const epochsAbortRef = useRef<AbortController | null>(null);

  useEffect(() => () => epochsAbortRef.current?.abort(), []);

  useEffect(() => {
    const q = searchText.trim();
    if (q.length < 2 || parseSkySearchInput(q).kind === 'coords') {
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/v1/catalogs/search?q=${encodeURIComponent(q)}&limit=10`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const payload = (await res.json()) as { results?: GlobalKnownObjectEntry[] };
        if (Array.isArray(payload.results)) {
          setLiveSearchState({ query: q.toLowerCase(), results: payload.results });
          observatoryLogger.debug('search', 'Live catalog search updated', {
            query: q,
            count: payload.results.length,
          });
        }
      } catch {
        // Offline / aborted searches fall back silently to local catalog list.
      }
    }, 180);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [searchText]);

  const searchSuggestions = useMemo(() => {
    const q = searchText.trim();
    if (!q || parseSkySearchInput(q).kind === 'coords') return [];
    const byId = new Map<string, GlobalKnownObjectEntry>();
    for (const item of globalKnownObjects) {
      byId.set(item.object_id, item);
    }
    // Live backend search overrides static Solar System coordinates with current-epoch JPL Horizons coords.
    if (liveSearchState.query === q.toLowerCase()) {
      for (const liveItem of liveSearchState.results) {
        byId.set(liveItem.object_id, liveItem);
      }
    }
    return fuzzySearchKnownObjects(Array.from(byId.values()), q).slice(0, 6);
  }, [globalKnownObjects, liveSearchState, searchText]);

  const activeEpochOption = useMemo(
    () => targetEpochs.find((ep) => ep.epoch_key === selectedEpochKey) ?? targetEpochs[0] ?? null,
    [selectedEpochKey, targetEpochs],
  );

  const applyEpochSelection = (
    entry: GlobalKnownObjectEntry,
    epoch: ObjectObservationEpoch,
    openInBlinker = true,
  ) => {
    setSelectedEpochKey(epoch.epoch_key);
    const solarSystem = isMovingSolarSystemObject(entry) || entry.object_id.startsWith('horizons:');
    if (epoch.kind === 'current') {
      requestGlobeFocus?.(epoch.ra, epoch.dec, solarSystem ? 4.0 : 2.2);
      if (!solarSystem) {
        if (entry.target_slug && !entry.target_slug.startsWith('all_sky')) {
          selectPreset(entry.target_slug);
        } else {
          navigateToCoordinates(epoch.ra, epoch.dec, 5.0);
        }
      }
      return;
    }

    requestGlobeFocus?.(epoch.ra, epoch.dec, 2.2);
    if (!solarSystem && entry.target_slug && !entry.target_slug.startsWith('all_sky')) {
      selectPreset(entry.target_slug, epoch.mjd);
    } else {
      navigateToCoordinates(epoch.ra, epoch.dec, 5.0, epoch.mjd);
    }
    if (openInBlinker) {
      openBlinkerModal?.();
    }
  };

  const handleSelectSuggestion = (entry: GlobalKnownObjectEntry) => {
    observatoryLogger.info('search', 'Selected target from search', {
      label: entry.label,
      ra: entry.ra,
      dec: entry.dec,
      source: entry.data_source,
    });
    setSearchText(entry.label);
    setSearchFocused(false);

    const solarSystem = isMovingSolarSystemObject(entry) || entry.object_id.startsWith('horizons:');
    const nowIso = entry.ephemeris_iso_date ?? new Date().toISOString();
    const fallbackCurrentEpoch: ObjectObservationEpoch = {
      epoch_key: 'current',
      kind: 'current',
      label: `Current Time (Now · ${nowIso.slice(0, 10)})`,
      iso_date: nowIso,
      mjd: 0,
      ra: entry.ra,
      dec: entry.dec,
      constellation: entry.constellation ?? '',
      source: entry.data_source ?? 'catalog_reference',
      can_view_in_blinker: !solarSystem,
      note: solarSystem
        ? 'Predicted current sky position (JPL Horizons). Background sky maps are archival; pick a SPHEREx pass date to view in Blinker.'
        : 'Sky coordinates for this target; Blinker displays archival multi-pass SPHEREx cutouts.',
    };

    setSelectedSearchTarget(entry);
    setTargetEpochs([fallbackCurrentEpoch]);
    setSelectedEpochKey('current');
    setPassesStatus(null);
    requestGlobeFocus?.(entry.ra, entry.dec, solarSystem ? 4.0 : 2.2);
    if (!solarSystem) {
      if (entry.target_slug && !entry.target_slug.startsWith('all_sky')) {
        selectPreset(entry.target_slug);
      } else {
        navigateToCoordinates(entry.ra, entry.dec, 5.0);
      }
    }

    epochsAbortRef.current?.abort();
    const controller = new AbortController();
    epochsAbortRef.current = controller;
    setEpochsLoading(true);
    const params = new URLSearchParams({
      object_id: entry.object_id,
      label: entry.label,
      ra: String(entry.ra),
      dec: String(entry.dec),
    });
    if (entry.object_type) params.set('object_type', entry.object_type);
    if (entry.object_class) params.set('object_class', entry.object_class);
    if (entry.target_slug) params.set('target_slug', entry.target_slug);

    void fetch(`/api/v1/catalogs/object-epochs?${params.toString()}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) return;
        const payload = (await res.json()) as ObjectObservationEpochsResponse;
        if (Array.isArray(payload.epochs) && payload.epochs.length > 0) {
          setTargetEpochs(payload.epochs);
          setPassesStatus(payload.passes_status);
          const cur = payload.epochs[0];
          if (cur && cur.kind === 'current') {
            requestGlobeFocus?.(cur.ra, cur.dec, payload.is_solar_system ? 4.0 : 2.2);
          }
        }
      })
      .catch(() => {
        // Offline / aborted requests retain fallback current-epoch descriptor.
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setEpochsLoading(false);
        }
      });
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseSkySearchInput(searchText);
    if (parsed.kind === 'coords') {
      requestGlobeFocus?.(parsed.ra, parsed.dec, 2.2);
      const nearbyPreset = BENCHMARK_TARGET_OPTIONS.find(
        (b) => angularSeparationDeg(parsed.ra, parsed.dec, b.ra, b.dec) <= 0.25,
      );
      if (nearbyPreset) {
        selectPreset(nearbyPreset.slug);
      } else if ((getSkyFrustum?.().fovDeg ?? 70) <= 15) {
        navigateToCoordinates(parsed.ra, parsed.dec, 5.0);
      }
      setSearchFocused(false);
      return;
    }

    if (parsed.kind === 'text') {
      const top = searchSuggestions[0];
      if (top) {
        handleSelectSuggestion(top);
      } else {
        notifications?.pushWarning({
          id: 'search-no-match',
          title: `No target found matching "${parsed.query}"`,
          detail: 'Try decimal coordinates (e.g. 133.795, -7.245) or a catalog star/planet name.',
          level: 'warning',
        });
      }
    }
  };

  return (
    <section
      ref={panelRef}
      data-testid="search-zenith-hud"
      aria-label="Sky Search and Earth-to-Sky Zenith Controls"
      className={`hud-panel search-hud-panel ${isDragging ? 'is-dragging' : ''} ${
        isFolded ? 'is-folded' : ''
      }`}
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      <div className="hud-drag-handle" {...dragHandleProps} style={{ padding: '7px 10px' }}>
        <div className="hud-title-group" style={{ gap: 6 }}>
          <span style={{ color: 'var(--text-muted)', display: 'inline-flex' }}>
            <DragGripIcon size={14} />
          </span>

          <button
            type="button"
            className="hud-icon-btn"
            aria-label={searchExpanded ? 'Shrink search bar' : 'Expand search bar'}
            title={searchExpanded ? 'Collapse search bar' : 'Expand search bar'}
            data-testid="toggle-search-bar-btn"
            onClick={() => setSearchExpanded((prev) => !prev)}
            style={{
              background: searchExpanded ? 'rgba(56, 189, 248, 0.14)' : 'transparent',
              color: searchExpanded ? '#bae6fd' : 'var(--text-secondary)',
            }}
          >
            <SearchIcon size={15} />
          </button>

          <form
            onSubmit={handleSearchSubmit}
            className={`search-input-wrap ${searchExpanded ? '' : 'is-collapsed'}`}
            data-no-drag="true"
          >
            <input
              type="text"
              className="hud-input"
              placeholder="Search object or Right Ascension, Declination..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => {
                window.setTimeout(() => setSearchFocused(false), 180);
              }}
              aria-label="Search target name or sky coordinates"
              data-testid="sky-search-input"
            />
            {searchText.trim().length > 0 && (
              <button type="submit" className="hud-btn-primary" style={{ height: 34 }}>
                Go
              </button>
            )}
          </form>
        </div>

        <button
          type="button"
          className={`hud-btn-secondary ${!isFolded ? 'is-active' : ''}`}
          onClick={toggleFolded}
          aria-expanded={!isFolded}
          aria-label="Toggle What's Above Me zenith converter"
          data-testid="toggle-zenith-drawer-btn"
          style={{ height: 30, padding: '0 9px', gap: 5 }}
        >
          <CompassZenithIcon size={14} />
          <span>Zenith</span>
          <ChevronIcon size={13} direction={isFolded ? 'down' : 'up'} />
        </button>
      </div>

      {/* Live target suggestions dropdown */}
      {searchExpanded && searchFocused && searchSuggestions.length > 0 && (
        <div
          role="listbox"
          aria-label="Matching celestial objects"
          style={{
            borderTop: '1px solid var(--border-hairline)',
            padding: '6px',
            maxHeight: 230,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {searchSuggestions.map((item) => (
            <button
              key={item.object_id}
              type="button"
              role="option"
              aria-selected={false}
              onMouseDown={(e) => {
                e.preventDefault();
              }}
              onClick={() => handleSelectSuggestion(item)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '7px 9px',
                borderRadius: 8,
                border: '1px solid transparent',
                background: 'rgba(15, 23, 42, 0.72)',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'var(--font-sans)',
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {item.label}
              </span>
              <span
                className="mono"
                style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}
              >
                {item.constellation ?? `${item.ra.toFixed(1)}°, ${item.dec.toFixed(1)}°`}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Constrained Observation Time Picker (Current Time + SPHEREx Passes only) */}
      {selectedSearchTarget && targetEpochs.length > 0 && (
        <div
          className="search-epoch-card"
          data-testid="search-target-epoch-card"
          data-no-drag="true"
        >
          <div className="search-epoch-card-header">
            <span className="search-epoch-card-title" title={selectedSearchTarget.label}>
              {selectedSearchTarget.label}
            </span>
            <button
              type="button"
              className="hud-icon-btn"
              aria-label="Close target observation time selector"
              onClick={() => {
                epochsAbortRef.current?.abort();
                setSelectedSearchTarget(null);
              }}
              style={{ width: 22, height: 22 }}
            >
              <CloseIcon size={12} />
            </button>
          </div>

          <div className="zenith-field">
            <label htmlFor="search-target-epoch-select">
              Observation Time (Current or SPHEREx Pass Dates)
            </label>
            <select
              id="search-target-epoch-select"
              data-testid="search-target-epoch-select"
              className="hud-select"
              style={{ width: '100%' }}
              value={selectedEpochKey}
              disabled={epochsLoading && targetEpochs.length <= 1}
              onChange={(e) => {
                const chosen = targetEpochs.find((ep) => ep.epoch_key === e.target.value);
                if (chosen) {
                  applyEpochSelection(selectedSearchTarget, chosen, chosen.kind === 'spherex_pass');
                }
              }}
            >
              {targetEpochs.map((ep) => (
                <option key={ep.epoch_key} value={ep.epoch_key}>
                  {ep.label}
                </option>
              ))}
            </select>
          </div>

          {activeEpochOption && (
            <div className="search-epoch-meta">
              <span className="mono" style={{ color: 'var(--text-primary)' }}>
                {formatRaDecCompact(activeEpochOption.ra, activeEpochOption.dec)}
              </span>
              <span>{activeEpochOption.note}</span>
              {epochsLoading && <span>Checking SPHEREx pass intersections…</span>}
              {!epochsLoading && passesStatus === 'no_spherex_passes' && (
                <span>No SPHEREx archival pass intersections found yet for this target.</span>
              )}
            </div>
          )}

          {activeEpochOption && activeEpochOption.can_view_in_blinker && (
            <button
              type="button"
              className="hud-btn-primary"
              data-testid="open-epoch-in-blinker-btn"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={() => applyEpochSelection(selectedSearchTarget, activeEpochOption, true)}
            >
              Open in Blinker ({activeEpochOption.iso_date.slice(0, 10)})
            </button>
          )}
        </div>
      )}

      {/* Foldable What's Above Me? Earth-to-Sky Zenith Drawer */}
      {!isFolded && <ZenithConverterDrawer onFocusCoordinates={requestGlobeFocus} />}
    </section>
  );
};
