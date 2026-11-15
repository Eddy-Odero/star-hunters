import React, { useEffect, useRef, useState } from 'react';
import { useSkyExplorer } from '../context/SkyExplorerContext';
import type { ComparisonMode } from '../types/contracts';

/**
 * ISS-14: CDS Aladin Lite v3 wide-field sky map synchronized with
 * `SkyExplorerContext.coordinates`. A 5' x 5' SPHEREx patch reticle is drawn
 * at the active target, and clicking a new sky region starts a live patch
 * query through `navigateToCoordinates(ra, dec)`.
 *
 * The CDN-hosted Aladin runtime is loaded lazily. When the CDN is unavailable
 * (offline / blocked) the component renders an interactive all-sky SVG map so
 * coordinate navigation and the reticle remain fully usable.
 */

const ALADIN_SCRIPT_URL = 'https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js';
const ALADIN_CSS_URL = 'https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.css';
const ALADIN_LOAD_TIMEOUT_MS = 8000;
const WIDE_FIELD_FOV_DEG = 20;
const RETICLE_COLOR = '#38bdf8';
const SPHEREX_PATCH_ARCMIN = 5;

const FALLBACK_VIEW_WIDTH = 720;
const FALLBACK_VIEW_HEIGHT = 360;

interface AladinClickObject {
  ra?: number;
  dec?: number;
}

interface AladinGraphicOverlay {
  add(shape: unknown): void;
  removeAll?(): void;
}

interface AladinInstance {
  gotoRaDec(ra: number, dec: number): void;
  getRaDec?(): [number, number];
  on?(event: 'click', handler: (object?: AladinClickObject | null) => void): void;
  addOverlay(overlay: AladinGraphicOverlay): void;
  removeOverlay?(overlay: AladinGraphicOverlay): void;
}

interface AladinApi {
  init?: Promise<unknown>;
  aladin(target: HTMLElement | string, options: Record<string, unknown>): AladinInstance;
  graphicOverlay(options: Record<string, unknown>): AladinGraphicOverlay;
  polygon(coords: Array<[number, number]>, options?: Record<string, unknown>): unknown;
  circle(ra: number, dec: number, radiusDeg: number, options?: Record<string, unknown>): unknown;
  marker(ra: number, dec: number, options?: Record<string, unknown>): unknown;
}

declare global {
  interface Window {
    A?: AladinApi;
  }
}

let aladinLoaderPromise: Promise<AladinApi> | null = null;

function ensureAladinStylesheet(): void {
  if (document.querySelector('link[data-aladin-lite-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = ALADIN_CSS_URL;
  link.dataset.aladinLiteCss = 'true';
  document.head.appendChild(link);
}

/**
 * Load the Aladin Lite v3 CDN bundle once and resolve after `A.init`.
 * Rejects on network/CSP/timeout failures so the caller can fall back.
 */
export function loadAladinLite(): Promise<AladinApi> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('Aladin Lite requires a browser environment'));
  }
  if (window.A && typeof window.A.aladin === 'function') {
    return Promise.resolve(window.A);
  }
  if (aladinLoaderPromise) return aladinLoaderPromise;

  ensureAladinStylesheet();

  aladinLoaderPromise = new Promise<AladinApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = ALADIN_SCRIPT_URL;
    script.async = true;
    script.charset = 'utf-8';
    script.dataset.aladinLite = 'true';

    let settled = false;
    let timeoutId = 0;

    const finish = (api?: AladinApi, error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      script.onload = null;
      script.onerror = null;
      if (api) {
        resolve(api);
      } else {
        script.remove();
        aladinLoaderPromise = null;
        reject(error ?? new Error('Failed to load Aladin Lite'));
      }
    };

    timeoutId = window.setTimeout(() => {
      finish(undefined, new Error('Aladin Lite CDN request timed out'));
    }, ALADIN_LOAD_TIMEOUT_MS);

    script.onload = () => {
      const api = window.A;
      if (!api || typeof api.aladin !== 'function') {
        finish(undefined, new Error('Aladin Lite global API was not initialized'));
        return;
      }
      Promise.resolve(api.init)
        .then(() => finish(api))
        .catch((err: unknown) =>
          finish(undefined, err instanceof Error ? err : new Error('Aladin Lite init failed')),
        );
    };

    script.onerror = () => {
      finish(undefined, new Error('Aladin Lite CDN request failed'));
    };

    document.head.appendChild(script);
  });

  return aladinLoaderPromise;
}

function wrapRa(ra: number): number {
  return ((ra % 360) + 360) % 360;
}

function clampDec(dec: number): number {
  return Math.max(-90, Math.min(90, dec));
}

/**
 * Corners of the 5' x 5' SPHEREx reticle in [ra, dec] degrees, widened in RA
 * by cos(dec) so the on-sky footprint stays square near the poles.
 */
export function computeSpherExReticleCorners(
  ra: number,
  dec: number,
  fovArcmin: number = SPHEREX_PATCH_ARCMIN,
): Array<[number, number]> {
  const halfDeg = Math.max(0.01, fovArcmin) / 60 / 2;
  const cosDec = Math.max(0.05, Math.cos((clampDec(dec) * Math.PI) / 180));
  const halfRa = Math.min(180, halfDeg / cosDec);
  return [
    [wrapRa(ra - halfRa), clampDec(dec - halfDeg)],
    [wrapRa(ra + halfRa), clampDec(dec - halfDeg)],
    [wrapRa(ra + halfRa), clampDec(dec + halfDeg)],
    [wrapRa(ra - halfRa), clampDec(dec + halfDeg)],
  ];
}

interface SkyMapFallbackProps {
  ra: number;
  dec: number;
  fovArcmin: number;
  mode: ComparisonMode;
  wlMin: number;
  wlMax: number;
  onNavigate: (ra: number, dec: number) => void;
}

const SkyMapFallback: React.FC<SkyMapFallbackProps> = ({
  ra,
  dec,
  fovArcmin,
  mode,
  wlMin,
  wlMax,
  onNavigate,
}) => {
  const normalizedRa = wrapRa(ra);
  const markerX = (normalizedRa / 360) * FALLBACK_VIEW_WIDTH;
  const markerY = ((90 - clampDec(dec)) / 180) * FALLBACK_VIEW_HEIGHT;

  const handleClick = (event: React.MouseEvent<SVGSVGElement>) => {
    const svg = event.currentTarget;
    const matrix = svg.getScreenCTM();
    if (!matrix) return;

    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(matrix.inverse());

    const nextRa = wrapRa((local.x / FALLBACK_VIEW_WIDTH) * 360);
    const nextDec = clampDec(90 - (local.y / FALLBACK_VIEW_HEIGHT) * 180);
    onNavigate(nextRa, nextDec);
  };

  const handleKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    const stepDeg = event.shiftKey ? 5 : 1;
    let nextRa = normalizedRa;
    let nextDec = dec;

    switch (event.key) {
      case 'ArrowLeft':
        nextRa = wrapRa(normalizedRa - stepDeg);
        break;
      case 'ArrowRight':
        nextRa = wrapRa(normalizedRa + stepDeg);
        break;
      case 'ArrowUp':
        nextDec = clampDec(dec + stepDeg);
        break;
      case 'ArrowDown':
        nextDec = clampDec(dec - stepDeg);
        break;
      default:
        return;
    }

    event.preventDefault();
    onNavigate(nextRa, nextDec);
  };

  const raGrid = Array.from({ length: 13 }, (_, index) => index * 30);
  const decGrid = [-60, -30, 0, 30, 60];

  return (
    <svg
      className="aladin-fallback-svg"
      viewBox={`0 0 ${FALLBACK_VIEW_WIDTH} ${FALLBACK_VIEW_HEIGHT}`}
      role="application"
      tabIndex={0}
      aria-label={`Offline wide-field sky map centered on RA ${normalizedRa.toFixed(
        2,
      )} degrees, Dec ${dec.toFixed(2)} degrees. Click or use arrow keys to navigate.`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <title>Interactive offline wide-field sky map (Aladin Lite unavailable)</title>
      <defs>
        <radialGradient id="aladin-fallback-glow" cx="50%" cy="50%" r="65%">
          <stop offset="0%" stopColor="#0b1f3a" />
          <stop offset="100%" stopColor="#050811" />
        </radialGradient>
      </defs>

      <rect
        x={0}
        y={0}
        width={FALLBACK_VIEW_WIDTH}
        height={FALLBACK_VIEW_HEIGHT}
        fill="url(#aladin-fallback-glow)"
      />

      {raGrid.map((raLine) => {
        const x = (raLine / 360) * FALLBACK_VIEW_WIDTH;
        return (
          <g key={`ra-${raLine}`}>
            <line
              x1={x}
              y1={0}
              x2={x}
              y2={FALLBACK_VIEW_HEIGHT}
              stroke="rgba(56, 189, 248, 0.16)"
              strokeWidth={1}
            />
            <text x={x + 6} y={16} fill="#64748b" fontSize={10}>
              {raLine}°
            </text>
          </g>
        );
      })}

      {decGrid.map((decLine) => {
        const y = ((90 - decLine) / 180) * FALLBACK_VIEW_HEIGHT;
        return (
          <g key={`dec-${decLine}`}>
            <line
              x1={0}
              y1={y}
              x2={FALLBACK_VIEW_WIDTH}
              y2={y}
              stroke={decLine === 0 ? 'rgba(148, 163, 184, 0.45)' : 'rgba(148, 163, 184, 0.16)'}
              strokeWidth={decLine === 0 ? 1.5 : 1}
            />
            <text x={8} y={y - 6} fill="#64748b" fontSize={10}>
              {decLine > 0 ? '+' : ''}
              {decLine}°
            </text>
          </g>
        );
      })}

      <g
        className="aladin-fallback-reticle"
        transform={`translate(${markerX} ${markerY})`}
        aria-hidden="true"
      >
        <circle
          r={12}
          fill="rgba(56, 189, 248, 0.12)"
          stroke={RETICLE_COLOR}
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
        <line x1={-20} y1={0} x2={-6} y2={0} stroke={RETICLE_COLOR} strokeWidth={1.5} />
        <line x1={6} y1={0} x2={20} y2={0} stroke={RETICLE_COLOR} strokeWidth={1.5} />
        <line x1={0} y1={-20} x2={0} y2={-6} stroke={RETICLE_COLOR} strokeWidth={1.5} />
        <line x1={0} y1={6} x2={0} y2={20} stroke={RETICLE_COLOR} strokeWidth={1.5} />
        <circle r={2.2} fill={RETICLE_COLOR} />
        <text x={16} y={-18} fill="#bae6fd" fontSize={11}>
          {fovArcmin.toFixed(1)}′ SPHEREx patch
        </text>
      </g>

      <g className="aladin-fallback-note">
        <text x={12} y={FALLBACK_VIEW_HEIGHT - 14} fill="#94a3b8" fontSize={11}>
          Offline vector map · click a region to navigate · arrows nudge · {mode.toUpperCase()} ·{' '}
          {wlMin.toFixed(2)}–{wlMax.toFixed(2)} µm
        </text>
      </g>
    </svg>
  );
};

export const AladinSkyMap: React.FC = () => {
  const { activePresetSlug, coordinates, renderSettings, navigateToCoordinates } = useSkyExplorer();

  const [status, setStatus] = useState<'loading' | 'ready' | 'fallback'>('loading');
  const [retryToken, setRetryToken] = useState(0);
  const [copied, setCopied] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const aladinRef = useRef<AladinInstance | null>(null);
  const overlayRef = useRef<AladinGraphicOverlay | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  // Keep click handlers pointing at the latest context values without
  // re-registering the Aladin listener on every render.
  const coordinatesRef = useRef(coordinates);
  const navigateRef = useRef(navigateToCoordinates);

  useEffect(() => {
    coordinatesRef.current = coordinates;
  }, [coordinates]);

  useEffect(() => {
    navigateRef.current = navigateToCoordinates;
  }, [navigateToCoordinates]);

  // Lazily boot Aladin Lite v3; fall back to the interactive SVG map on failure.
  useEffect(() => {
    let cancelled = false;

    loadAladinLite()
      .then((api) => {
        if (cancelled || !containerRef.current) {
          if (!cancelled) setStatus('fallback');
          return;
        }

        const container = containerRef.current;
        container.innerHTML = '';

        const aladin = api.aladin(container, {
          survey: 'P/DSS2/color',
          target: `${coordinatesRef.current.ra} ${coordinatesRef.current.dec}`,
          fov: WIDE_FIELD_FOV_DEG,
          cooFrame: 'J2000d',
          showFrame: true,
          showCooGrid: true,
          showZoomControl: true,
          showLayersControl: false,
          showGotoControl: false,
          showFullscreenControl: false,
          showShareControl: false,
          showSimbadPointerControl: false,
          showSettingsControl: false,
          showCatalogControl: false,
          showStatusBar: false,
        });

        aladinRef.current = aladin;

        aladin.on?.('click', (object) => {
          const raDec = aladin.getRaDec?.();
          const ra = Number(object?.ra ?? raDec?.[0]);
          const dec = Number(object?.dec ?? raDec?.[1]);
          if (Number.isFinite(ra) && Number.isFinite(dec)) {
            navigateRef.current(ra, dec, coordinatesRef.current.fovArcmin);
          }
        });

        if (!cancelled) setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('fallback');
      });

    return () => {
      cancelled = true;
    };
  }, [retryToken]);

  // Pan immediately whenever the context coordinates change, then redraw the
  // 5' x 5' SPHEREx reticle at the new target (presets and sky clicks both
  // flow through here).
  useEffect(() => {
    const aladin = aladinRef.current;
    if (!aladin || status !== 'ready') return;

    aladin.gotoRaDec(coordinates.ra, coordinates.dec);

    const api = typeof window === 'undefined' ? undefined : window.A;
    if (!api) return;

    const previous = overlayRef.current;
    if (previous) {
      if (typeof previous.removeAll === 'function') {
        previous.removeAll();
      } else {
        aladin.removeOverlay?.(previous);
      }
    }

    const halfDeg = Math.max(0.01, coordinates.fovArcmin) / 60 / 2;
    const overlay = api.graphicOverlay({
      name: 'spherx-patch-reticle',
      color: RETICLE_COLOR,
      lineWidth: 2,
    });

    overlay.add(
      api.polygon(
        computeSpherExReticleCorners(coordinates.ra, coordinates.dec, coordinates.fovArcmin),
        {
          color: RETICLE_COLOR,
          lineWidth: 2,
          fillColor: RETICLE_COLOR,
          fillOpacity: 0.18,
        },
      ),
    );
    overlay.add(
      api.circle(coordinates.ra, coordinates.dec, Math.max(halfDeg * Math.SQRT2, 0.02), {
        color: RETICLE_COLOR,
        lineWidth: 1.5,
        lineDash: [3, 2],
      }),
    );
    overlay.add(
      api.marker(coordinates.ra, coordinates.dec, {
        popupTitle: `${coordinates.fovArcmin.toFixed(1)}′ SPHEREx patch`,
        popupDesc: `RA ${coordinates.ra.toFixed(4)}° · Dec ${coordinates.dec.toFixed(4)}°`,
      }),
    );

    aladin.addOverlay(overlay);
    overlayRef.current = overlay;
  }, [status, coordinates.ra, coordinates.dec, coordinates.fovArcmin]);

  const handleNavigate = (ra: number, dec: number) => {
    navigateToCoordinates(ra, dec, coordinates.fovArcmin);
  };

  const handleRetry = () => {
    setStatus('loading');
    setRetryToken((value) => value + 1);
  };

  const handleCopyUrl = async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(window.location.href);
        setCopied(true);
        if (copyTimerRef.current !== null) {
          window.clearTimeout(copyTimerRef.current);
        }
        copyTimerRef.current = window.setTimeout(() => {
          setCopied(false);
          copyTimerRef.current = null;
        }, 2500);
      }
    } catch {
      setCopied(false);
    }
  };

  const [wlMin, wlMax] = renderSettings.wavelengthRangeUm;
  const statusLabel =
    status === 'ready'
      ? 'Aladin Lite v3 · CDS'
      : status === 'loading'
        ? 'Connecting to CDS…'
        : 'Offline SVG fallback';

  return (
    <section className="aladin-sky-map" aria-label="Wide-field Aladin sky map">
      <div className="aladin-map-header">
        <div>
          <h3>Wide-Field Sky Context</h3>
          <p className="aladin-map-subtitle">
            Stage A overview synchronized with the 256×256 SPHEREx patch. Click any region to
            re-point the telescope, or use the 5′ reticle to confirm the active footprint.
          </p>
        </div>
        <span className={`aladin-status aladin-status-${status}`} role="status">
          {statusLabel}
        </span>
      </div>

      <div className={`aladin-map-stage aladin-map-stage-${status}`}>
        <div ref={containerRef} className="aladin-map-canvas" aria-hidden={status !== 'ready'} />

        {status !== 'ready' && (
          <SkyMapFallback
            ra={coordinates.ra}
            dec={coordinates.dec}
            fovArcmin={coordinates.fovArcmin}
            mode={renderSettings.mode}
            wlMin={wlMin}
            wlMax={wlMax}
            onNavigate={handleNavigate}
          />
        )}

        {status === 'loading' && (
          <div className="aladin-map-loading" role="status">
            Loading CDS Aladin Lite v3…
          </div>
        )}
      </div>

      <div className="aladin-map-footer">
        <div className="aladin-coords">
          <span className="aladin-coord-pill">
            RA {coordinates.ra.toFixed(4)}° · Dec {coordinates.dec.toFixed(4)}°
          </span>
          <span className="aladin-coord-pill">
            FOV {coordinates.fovArcmin.toFixed(1)}′ · 5′ SPHEREx reticle
          </span>
          <span className="aladin-coord-pill">
            {renderSettings.mode.toUpperCase()} · {wlMin.toFixed(2)}–{wlMax.toFixed(2)} µm
          </span>
          {activePresetSlug && (
            <span className="aladin-coord-pill aladin-coord-pill-target">{activePresetSlug}</span>
          )}
        </div>

        <div className="aladin-map-actions">
          {status === 'fallback' && (
            <button type="button" className="mode-btn" onClick={handleRetry}>
              Retry CDS CDN
            </button>
          )}
          <button type="button" className="mode-btn" onClick={() => void handleCopyUrl()}>
            {copied ? 'URL copied ✓' : 'Copy shareable URL'}
          </button>
        </div>
      </div>

      <p className="aladin-map-hint">
        Query state is mirrored to the address bar (?target, ?ra, ?dec, ?fov, ?mode, ?wlMin, ?wlMax)
        so this exact sky view can be shared without a page reload.
      </p>
    </section>
  );
};

export default AladinSkyMap;
