import React, { useState } from 'react';
import { useOptionalNotifications } from '../../context/NotificationContext';
import { WORLD_CAPITAL_CITIES, type EarthToSkyResponse } from '../../types/contracts';
import { formatRaDecCompact, wrapRaDeg } from '../../utils/observatoryMath';

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

interface ZenithConverterDrawerProps {
  onFocusCoordinates?: (ra: number, dec: number, fovDeg: number) => void;
}

/** Earth-to-Sky Zenith converter drawer mapping city coordinates & UTC time to ICRS sky overhead. */
export const ZenithConverterDrawer: React.FC<ZenithConverterDrawerProps> = ({
  onFocusCoordinates,
}) => {
  const notifications = useOptionalNotifications();
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
        onFocusCoordinates?.(data.zenith_icrs.ra, data.zenith_icrs.dec, 12.0);
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
      onFocusCoordinates?.(approx.ra, approx.dec, 12.0);
    } finally {
      setIsConverting(false);
      notifications?.finishAsyncTask('earth-to-sky');
    }
  };

  return (
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
            <span className="mono">{formatRaDecCompact(zenithResult.ra, zenithResult.dec)}</span>
          </span>
          {zenithResult.constellation && <span>Constellation: {zenithResult.constellation}</span>}
        </div>
      )}
    </form>
  );
};
