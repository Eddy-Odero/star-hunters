import React, { useState } from 'react';
import { useSkyExplorer } from '../context/SkyExplorerContext';
import type { EarthToSkyResponse } from '../types/contracts';

const QUICK_CITIES = [
  { name: 'Nairobi, Kenya', lat: -1.2921, lon: 36.8219 },
  { name: 'Greenwich, UK', lat: 51.48, lon: 0.0 },
  { name: 'Mauna Kea, Hawaii', lat: 19.82, lon: -155.47 },
  { name: 'Atacama, Chile', lat: -23.01, lon: -67.75 },
];

export const WhatsAboveMeBar: React.FC<{
  onZenithResolved?: (bannerText: string) => void;
}> = ({ onZenithResolved }) => {
  const { navigateToCoordinates } = useSkyExplorer();
  const [latInput, setLatInput] = useState('');
  const [lonInput, setLonInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const fetchZenithAndNavigate = async (lat?: number, lon?: number) => {
    setLoading(true);
    setStatusMessage('Resolving overhead celestial zenith...');
    try {
      const endpoint =
        lat !== undefined && lon !== undefined
          ? `/api/v1/earth-to-sky?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`
          : '/api/v1/earth-to-sky';

      const res = await fetch(endpoint);
      if (!res.ok) {
        throw new Error(`Earth-to-Sky API error (${res.status})`);
      }
      const data = (await res.json()) as EarthToSkyResponse;

      const locLabel = data.earth.is_fallback_capital
        ? `${data.earth.city_name ?? 'Capital'}, ${data.earth.country ?? ''} (Random Capital Fallback)`
        : `(${data.earth.lat.toFixed(2)}°, ${data.earth.lon.toFixed(2)}°)`;

      const banner = `Zenith over ${locLabel}: RA ${data.zenith_icrs.ra.toFixed(2)}°, Dec ${data.zenith_icrs.dec.toFixed(2)}° (${data.zenith_icrs.constellation})`;

      setStatusMessage(banner);
      onZenithResolved?.(banner);
      navigateToCoordinates(data.zenith_icrs.ra, data.zenith_icrs.dec, 5.0);
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : 'Failed to resolve zenith coordinates.');
    } finally {
      setLoading(false);
    }
  };

  const handleBrowserGeolocation = () => {
    if (!navigator.geolocation) {
      // Fallback to automatic random capital city via backend
      void fetchZenithAndNavigate();
      return;
    }

    setLoading(true);
    setStatusMessage('Requesting browser geolocation...');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        void fetchZenithAndNavigate(pos.coords.latitude, pos.coords.longitude);
      },
      () => {
        // Geolocation denied or unavailable -> automatic backend fallback to random capital city
        void fetchZenithAndNavigate();
      },
      { timeout: 8000 },
    );
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const lat = parseFloat(latInput);
    const lon = parseFloat(lonInput);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      void fetchZenithAndNavigate(lat, lon);
    }
  };

  return (
    <div className="whats-above-me-bar" role="region" aria-label="What's Above Me Discovery Flow">
      <div className="wam-header">
        <h4> &ldquo;What&apos;s Above Me?&rdquo; Zenith Discovery</h4>
        <p className="wam-subtitle">
          Point your viewport directly at the night sky zenith above your location or a random world capital.
        </p>
      </div>

      <div className="wam-controls">
        <button
          type="button"
          className="mode-btn active"
          onClick={handleBrowserGeolocation}
          disabled={loading}
        >
          {loading ? 'Resolving...' : ' Use My Location (or Random Capital Fallback)'}
        </button>

        <div className="wam-presets">
          {QUICK_CITIES.map((city) => (
            <button
              key={city.name}
              type="button"
              className="mode-btn"
              onClick={() => void fetchZenithAndNavigate(city.lat, city.lon)}
              disabled={loading}
            >
              {city.name}
            </button>
          ))}
        </div>

        <form onSubmit={handleManualSubmit} className="wam-manual-form">
          <input
            type="number"
            step="any"
            placeholder="Lat (-90..90)"
            value={latInput}
            onChange={(e) => setLatInput(e.target.value)}
            className="wam-input"
          />
          <input
            type="number"
            step="any"
            placeholder="Lon (-180..180)"
            value={lonInput}
            onChange={(e) => setLonInput(e.target.value)}
            className="wam-input"
          />
          <button type="submit" className="mode-btn" disabled={loading}>
            Go to Lat/Lon
          </button>
        </form>
      </div>

      {statusMessage && (
        <div className="diagnostic-banner" role="status">
          {statusMessage}
        </div>
      )}
    </div>
  );
};

export default WhatsAboveMeBar;