import React, { useMemo, useState } from 'react';
import { useSkyExplorer } from '../context/SkyExplorerContext';
import { useOptionalNotifications } from '../context/NotificationContext';
import { useDraggablePanel } from '../hooks/useDraggablePanel';
import {
  WORLD_CAPITAL_CITIES,
  type EarthToSkyResponse,
  type GlobalKnownObjectEntry,
} from '../types/contracts';
import { fuzzySearchKnownObjects } from '../utils/knownObjectSelection';
import {
  angularSeparationDeg,
  BENCHMARK_TARGET_OPTIONS,
  formatRaDecCompact,
  parseSkySearchInput,
  wrapRaDeg,
} from '../utils/observatoryMath';
import { ChevronIcon, CompassZenithIcon, DragGripIcon, SearchIcon } from './icons/ObservatoryIcons';

function localApproximateZenith(latDeg: number, lonDeg: number, dateIso: string) {
  const dt = new Date(dateIso);
  const validMs = Number.isNaN(dt.getTime()) ? Date.now() : dt.getTime();
  const jd = validMs / 86400000 + 2440587.5;
  const d = jd - 2451545.0;
  const gmstDeg = 280.46061837 + 360.98564736629 * d;
  return {
    ra: wrapRaDeg(gmstDeg + lonDeg),
    dec: Math.max(-89.9, Math.min(89.9, latDeg)),
  };
}

export const FloatingSearchZenithMenu: React.FC = () => {
  const {
    globalKnownObjects = [],
    requestGlobeFocus,
    navigateToCoordinates,
    selectPreset,
    skyFrustum,
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

  // Earth-to-Sky Zenith converter state
  const [selectedCityName, setSelectedCityName] = useState<string>('Nairobi');
  const [latInput, setLatInput] = useState<string>('-1.2864');
  const [lonInput, setLonInput] = useState<string>('36.8172');
  const [obsTimeIso, setObsTimeIso] = useState<string>(() => new Date().toISOString().slice(0, 16));
  const [zenithResult, setZenithResult] = useState<{
    ra: number;
    dec: number;
    constellation?: string;
    city?: string | null;
  } | null>(null);
  const [isConverting, setIsConverting] = useState<boolean>(false);

  const searchSuggestions = useMemo(() => {
    const q = searchText.trim();
    if (!q || parseSkySearchInput(q).kind === 'coords') return [];
    return fuzzySearchKnownObjects(globalKnownObjects, q).slice(0, 6);
  }, [globalKnownObjects, searchText]);

  const handleSelectSuggestion = (entry: GlobalKnownObjectEntry) => {
    setSearchText(entry.label);
    setSearchFocused(false);
    requestGlobeFocus?.(entry.ra, entry.dec, 2.2);
    if (entry.target_slug && !entry.target_slug.startsWith('all_sky')) {
      selectPreset(entry.target_slug);
    }
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
      } else if ((skyFrustum?.fovDeg ?? 70) <= 15) {
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

  const handleCityChange = (cityName: string) => {
    setSelectedCityName(cityName);
    const city = WORLD_CAPITAL_CITIES.find((c) => c.city_name === cityName);
    if (city) {
      setLatInput(city.lat.toFixed(4));
      setLonInput(city.lon.toFixed(4));
    }
  };

  const handleZenithConvert = async (e: React.FormEvent) => {
    e.preventDefault();
    const lat = Number(latInput);
    const lon = Number(lonInput);
    if (
      !Number.isFinite(lat) ||
      lat < -90 ||
      lat > 90 ||
      !Number.isFinite(lon) ||
      lon < -180 ||
      lon > 180
    ) {
      notifications?.pushWarning({
        id: 'zenith-invalid-coords',
        title: 'Invalid observer latitude or longitude',
        detail: 'Latitude must be between -90° and +90°, longitude between -180° and +180°.',
        level: 'warning',
      });
      return;
    }

    const isoTime = new Date(obsTimeIso).toISOString();
    setIsConverting(true);
    notifications?.startAsyncTask('earth-to-sky', 'Computing zenith ICRS sky coordinates...');
    try {
      const params = new URLSearchParams({
        lat: lat.toFixed(5),
        lon: lon.toFixed(5),
        time: isoTime,
      });
      const res = await fetch(`/api/v1/earth-to-sky?${params.toString()}`);
      if (res.ok) {
        const data = (await res.json()) as EarthToSkyResponse;
        setZenithResult({
          ra: data.zenith_icrs.ra,
          dec: data.zenith_icrs.dec,
          constellation: data.zenith_icrs.constellation,
          city: data.earth.city_name,
        });
        requestGlobeFocus?.(data.zenith_icrs.ra, data.zenith_icrs.dec, 12.0);
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch {
      const approx = localApproximateZenith(lat, lon, isoTime);
      setZenithResult({
        ra: approx.ra,
        dec: approx.dec,
        city: selectedCityName,
      });
      requestGlobeFocus?.(approx.ra, approx.dec, 12.0);
    } finally {
      setIsConverting(false);
      notifications?.finishAsyncTask('earth-to-sky');
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
              placeholder="Search object or RA, Dec..."
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
                handleSelectSuggestion(item);
              }}
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

      {/* Foldable What's Above Me? Earth-to-Sky Zenith Drawer */}
      {!isFolded && (
        <form
          className="zenith-drawer"
          onSubmit={handleZenithConvert}
          data-testid="zenith-converter-drawer"
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
              What&rsquo;s Above Me? (Zenith)
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Earth → ICRS</span>
          </div>

          <div className="zenith-field">
            <label htmlFor="zenith-city-select">Observatory City Preset</label>
            <select
              id="zenith-city-select"
              className="hud-select"
              style={{ width: '100%' }}
              value={selectedCityName}
              onChange={(e) => handleCityChange(e.target.value)}
            >
              {WORLD_CAPITAL_CITIES.map((city) => (
                <option key={city.slug} value={city.city_name}>
                  {city.city_name}, {city.country}
                </option>
              ))}
            </select>
          </div>

          <div className="zenith-grid">
            <div className="zenith-field">
              <label htmlFor="zenith-lat">Latitude (°)</label>
              <input
                id="zenith-lat"
                type="number"
                step="0.0001"
                className="hud-input mono"
                value={latInput}
                onChange={(e) => setLatInput(e.target.value)}
              />
            </div>
            <div className="zenith-field">
              <label htmlFor="zenith-lon">Longitude (°)</label>
              <input
                id="zenith-lon"
                type="number"
                step="0.0001"
                className="hud-input mono"
                value={lonInput}
                onChange={(e) => setLonInput(e.target.value)}
              />
            </div>
          </div>

          <div className="zenith-field">
            <label htmlFor="zenith-utc">UTC Observation Time</label>
            <input
              id="zenith-utc"
              type="datetime-local"
              className="hud-input mono"
              value={obsTimeIso}
              onChange={(e) => setObsTimeIso(e.target.value)}
            />
          </div>

          <button
            type="submit"
            className="hud-btn-primary"
            style={{ width: '100%', justifyContent: 'center' }}
            disabled={isConverting}
          >
            {isConverting ? 'Computing Zenith...' : 'Point Globe Overhead'}
          </button>

          {zenithResult && (
            <div className="zenith-result-chip">
              <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                Zenith Sky:{' '}
                <span className="mono">
                  {formatRaDecCompact(zenithResult.ra, zenithResult.dec)}
                </span>
              </span>
              {zenithResult.constellation && (
                <span>Constellation: {zenithResult.constellation}</span>
              )}
            </div>
          )}
        </form>
      )}
    </section>
  );
};
