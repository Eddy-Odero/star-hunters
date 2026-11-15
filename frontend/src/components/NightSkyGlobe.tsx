import React, { useCallback, useEffect, useRef, useState } from 'react';
import { IAU_CONSTELLATIONS } from '../data/constellations';
import { useSkyExplorer } from '../context/SkyExplorerContext';
import { TRACKING_SQUARE_COLORS } from '../types/contracts';
import {
  clampGlobeFov,
  IRSA_2MASS_HIPS_URL,
  IRSA_WISE_HIPS_URL,
  PANEL_GRID_FOV_DEG,
  PANEL_GRID_STEP_DEG,
  resolveBestDeepSkyHiPS,
  resolveGlobeClickAction,
  resolveGlobeLodTier,
  stepPanCoordinates,
  SUPPORTED_GLOBE_PROJECTIONS,
  targetFovForClickAction,
  type DeepHiPSResolution,
  type GlobeProjection,
} from '../utils/globeNavigation';
import { observatoryLogger } from '../utils/observatoryLogger';
import {
  angularSeparationDeg,
  BENCHMARK_TARGET_OPTIONS,
  computeSpherExReticleCorners,
  formatRaDecCompact,
  getMarkerShapeKind,
  quantizeGridCenter,
  wrapRaDeg,
} from '../utils/observatoryMath';

const ALADIN_MODULE_URL = 'https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js';
const ALADIN_LOAD_TIMEOUT_MS = 12000;
const SPHEREX_PATCH_ARCMIN = 5.0;
const CURSOR_TOOLTIP_DELAY_MS = 450;

interface AladinInstance {
  gotoRaDec(ra: number, dec: number): void;
  setFoV?(fovDeg: number): void;
  setProjection?(projection: string): void;
  getRaDec?(): [number, number];
  getFoV?(): [number, number] | number;
  setImageSurvey?(surveyId: string): void;
  pix2world?(x: number, y: number): [number, number] | null;
  world2pix?(ra: number, dec: number): [number, number] | null;
  on?(event: string, handler: (...args: unknown[]) => void): void;
}

interface AladinApi {
  init?: Promise<unknown>;
  aladin(target: HTMLElement | string, options: Record<string, unknown>): AladinInstance;
}

declare global {
  interface Window {
    A?: AladinApi;
  }
}

let aladinLoaderPromise: Promise<AladinApi> | null = null;

function loadAladinLite(): Promise<AladinApi> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('Aladin Lite requires a browser runtime'));
  }
  if (window.A && typeof window.A.aladin === 'function') {
    return Promise.resolve(window.A.init).then(() => window.A as AladinApi);
  }
  if (aladinLoaderPromise) return aladinLoaderPromise;

  const withTimeout = <T,>(promise: Promise<T>, label: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const tid = window.setTimeout(() => reject(new Error(label)), ALADIN_LOAD_TIMEOUT_MS);
      promise.then(
        (val) => {
          window.clearTimeout(tid);
          resolve(val);
        },
        (err) => {
          window.clearTimeout(tid);
          reject(err);
        },
      );
    });

  aladinLoaderPromise = withTimeout(
    import(/* @vite-ignore */ ALADIN_MODULE_URL) as Promise<{ default?: AladinApi }>,
    'Aladin Lite load timeout',
  )
    .then(async (mod) => {
      const api = mod?.default ?? window.A;
      if (!api || typeof api.aladin !== 'function') {
        throw new Error('Aladin Lite module API unavailable');
      }
      window.A = api;
      await withTimeout(Promise.resolve(api.init), 'Aladin Lite WebGL2 init timeout');
      return api;
    })
    .catch((err) => {
      aladinLoaderPromise = null;
      throw err instanceof Error ? err : new Error(String(err));
    });

  return aladinLoaderPromise;
}

// Deterministic background star field (~420 procedural faint stars) for pure-#000000 3D sphere fallback
const BACKGROUND_STARS: ReadonlyArray<{
  ra: number;
  dec: number;
  size: number;
  alpha: number;
  tint: string;
}> = Array.from({ length: 420 }, (_, i) => {
  const s1 = Math.sin((i + 1) * 12.9898) * 43758.5453;
  const s2 = Math.sin((i + 1) * 78.233) * 29431.1243;
  const s3 = Math.sin((i + 1) * 39.425) * 19381.4121;
  const f1 = s1 - Math.floor(s1);
  const f2 = s2 - Math.floor(s2);
  const f3 = s3 - Math.floor(s3);
  const ra = f1 * 360;
  const dec = Math.asin(2 * f2 - 1) * (180 / Math.PI);
  const tints = ['#f8fafc', '#fde68a', '#bae6fd', '#fed7aa'];
  return {
    ra,
    dec,
    size: 0.7 + f3 * 1.4,
    alpha: 0.25 + f3 * 0.65,
    tint: tints[i % tints.length],
  };
});

/**
 * Project sky (ra, dec) onto 3D celestial sphere looking outward (SIN orthographic).
 * East increases left as viewed from inside the Earth celestial sphere.
 */
function projectSkySin(
  raDeg: number,
  decDeg: number,
  centerRaDeg: number,
  centerDecDeg: number,
  fovDeg: number,
  width: number,
  height: number,
): { px: number; py: number; visible: boolean } {
  const d2r = Math.PI / 180;
  const a = raDeg * d2r;
  const d = decDeg * d2r;
  const a0 = centerRaDeg * d2r;
  const d0 = centerDecDeg * d2r;

  const cosC = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  if (cosC <= 0.02) {
    return { px: -9999, py: -9999, visible: false };
  }

  const xi = -Math.cos(d) * Math.sin(a - a0); // Sky east left
  const eta = Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0);

  const halfFovRad = Math.min(Math.PI / 2, fovDeg * 0.5 * d2r);
  const scale = width / (2 * Math.max(1e-4, Math.sin(halfFovRad)));

  return {
    px: width * 0.5 + xi * scale,
    py: height * 0.5 - eta * scale,
    visible: true,
  };
}

function unprojectSkySin(
  px: number,
  py: number,
  centerRaDeg: number,
  centerDecDeg: number,
  fovDeg: number,
  width: number,
  height: number,
): { ra: number; dec: number } | null {
  const d2r = Math.PI / 180;
  const r2d = 180 / Math.PI;
  const a0 = centerRaDeg * d2r;
  const d0 = centerDecDeg * d2r;
  const halfFovRad = Math.min(Math.PI / 2, fovDeg * 0.5 * d2r);
  const scale = width / (2 * Math.max(1e-4, Math.sin(halfFovRad)));

  const xi = (px - width * 0.5) / scale;
  const eta = -(py - height * 0.5) / scale;
  const rho = Math.hypot(xi, eta);
  if (rho >= 0.995) return null;

  const c = Math.asin(Math.min(1, rho));
  const cosC = Math.cos(c);
  const sinC = Math.sin(c);

  let dec = d0;
  let ra = a0;
  if (rho > 1e-9) {
    dec = Math.asin(
      Math.max(-1, Math.min(1, cosC * Math.sin(d0) + (eta * sinC * Math.cos(d0)) / rho)),
    );
    const num = -xi * sinC;
    const den = rho * Math.cos(d0) * cosC - eta * Math.sin(d0) * sinC;
    ra = a0 + Math.atan2(num, den);
  }

  return {
    ra: wrapRaDeg(ra * r2d),
    dec: Math.max(-89.99, Math.min(89.99, dec * r2d)),
  };
}

export const NightSkyGlobe: React.FC = () => {
  const {
    coordinates,
    skyFrustum,
    setSkyFrustum,
    knownObjects = [],
    globalKnownObjects = [],
    renderSettings,
    objectHighlighterColors = {},
    isBlinkerModalOpen = false,
    openBlinkerModal,
    globeFocusRequest,
  } = useSkyExplorer();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const aladinHostRef = useRef<HTMLDivElement | null>(null);
  const fallbackCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const aladinInstanceRef = useRef<AladinInstance | null>(null);

  const [aladinReady, setAladinReady] = useState(false);
  const [aladinFailed, setAladinFailed] = useState(false);
  const [projection, setProjection] = useState<GlobeProjection>('SIN');
  const [activeSurveyLabel, setActiveSurveyLabel] = useState<string>('AllWISE Wide (IRSA)');
  const currentSurveyUrlRef = useRef<string>(IRSA_WISE_HIPS_URL);
  const deepHiPSCacheRef = useRef<DeepHiPSResolution | null>(null);
  const deepHiPSPromiseRef = useRef<Promise<DeepHiPSResolution> | null>(null);
  const [showConstellations, setShowConstellations] = useState<boolean>(true);
  const [coordEditing, setCoordEditing] = useState<boolean>(false);
  const [raDraft, setRaDraft] = useState<string>('');
  const [decDraft, setDecDraft] = useState<string>('');
  const [cursorTooltip, setCursorTooltip] = useState<{
    x: number;
    y: number;
    ra: number;
    dec: number;
  } | null>(null);
  const cursorHoverTimerRef = useRef<number | null>(null);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number }>(() => ({
    width: typeof window === 'undefined' ? 1280 : window.innerWidth,
    height: typeof window === 'undefined' ? 800 : window.innerHeight,
  }));

  // Interactive camera state mirrored for instant canvas rendering + frustum updates
  const viewStateRef = useRef<{ ra: number; dec: number; fovDeg: number }>({
    ra: skyFrustum?.ra ?? coordinates.ra,
    dec: skyFrustum?.dec ?? coordinates.dec,
    fovDeg: skyFrustum?.fovDeg ?? 70,
  });

  const [hoverPatchPolygon, setHoverPatchPolygon] = useState<{
    pointsStr: string;
    raQ: number;
    decQ: number;
  } | null>(null);

  const dragRef = useRef<{
    active: boolean;
    moved: boolean;
    startX: number;
    startY: number;
    startRa: number;
    startDec: number;
  }>({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    startRa: coordinates.ra,
    startDec: coordinates.dec,
  });

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return undefined;
    const updateSize = () => {
      const rect = host.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setViewportSize({ width: rect.width, height: rect.height });
      }
    };
    updateSize();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateSize);
      return () => window.removeEventListener('resize', updateSize);
    }
    const ro = new ResizeObserver(updateSize);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  const triggerTargetOrLivePatch = useCallback(
    (ra: number, dec: number) => {
      const { raQ, decQ } = quantizeGridCenter(ra, dec, PANEL_GRID_STEP_DEG);
      const matchedBenchmark = BENCHMARK_TARGET_OPTIONS.find(
        (b) => angularSeparationDeg(raQ, decQ, b.ra, b.dec) <= 0.12,
      );
      observatoryLogger.info('globe', 'Opening sky panel in Blinker', {
        raQ,
        decQ,
        benchmarkSlug: matchedBenchmark?.slug ?? null,
      });
      if (matchedBenchmark) {
        openBlinkerModal?.(matchedBenchmark.slug);
      } else {
        openBlinkerModal?.({ ra: raQ, dec: decQ, fovArcmin: SPHEREX_PATCH_ARCMIN });
      }
    },
    [openBlinkerModal],
  );

  const switchSurveyLayer = useCallback((url: string, label: string) => {
    setActiveSurveyLabel(label);
    if (currentSurveyUrlRef.current !== url) {
      currentSurveyUrlRef.current = url;
      aladinInstanceRef.current?.setImageSurvey?.(url);
      observatoryLogger.info('globe', 'Globe background sky survey switched', {
        survey: label,
        fovDeg: Number(viewStateRef.current.fovDeg.toFixed(2)),
      });
    }
  }, []);

  // Resilient progressive LoD survey tier switching based on FoV
  const updateLodForFov = useCallback(
    (fovDeg: number) => {
      const tier = resolveGlobeLodTier(fovDeg);
      if (tier === 'allwise') {
        switchSurveyLayer(IRSA_WISE_HIPS_URL, 'AllWISE Wide (IRSA)');
        return;
      }
      if (tier === '2mass') {
        switchSurveyLayer(IRSA_2MASS_HIPS_URL, '2MASS High-Res (IRSA)');
        return;
      }
      if (deepHiPSCacheRef.current) {
        switchSurveyLayer(deepHiPSCacheRef.current.url, deepHiPSCacheRef.current.label);
        return;
      }
      if (!deepHiPSPromiseRef.current) {
        deepHiPSPromiseRef.current = resolveBestDeepSkyHiPS().then((resolved) => {
          deepHiPSCacheRef.current = resolved;
          return resolved;
        });
      }
      deepHiPSPromiseRef.current
        .then((resolved) => {
          if (resolveGlobeLodTier(viewStateRef.current.fovDeg) === 'spherex_deep') {
            switchSurveyLayer(resolved.url, resolved.label);
          }
        })
        .catch(() => {
          if (resolveGlobeLodTier(viewStateRef.current.fovDeg) === 'spherex_deep') {
            switchSurveyLayer(IRSA_2MASS_HIPS_URL, '2MASS High-Res (IRSA)');
          }
        });
    },
    [switchSurveyLayer],
  );

  const applyCameraState = useCallback(
    (nextRa: number, nextDec: number, nextFovDeg: number, driveAladin = true) => {
      const clampedFov = clampGlobeFov(nextFovDeg);
      const wrappedRa = wrapRaDeg(nextRa);
      const clampedDec = Math.max(-89.9, Math.min(89.9, nextDec));
      viewStateRef.current = { ra: wrappedRa, dec: clampedDec, fovDeg: clampedFov };
      updateLodForFov(clampedFov);
      const rect = containerRef.current?.getBoundingClientRect();
      setSkyFrustum?.({
        ra: wrappedRa,
        dec: clampedDec,
        fovDeg: clampedFov,
        aspect: rect && rect.height > 0 ? rect.width / rect.height : 1.4,
      });
      if (driveAladin && aladinInstanceRef.current) {
        aladinInstanceRef.current.gotoRaDec(wrappedRa, clampedDec);
        aladinInstanceRef.current.setFoV?.(clampedFov);
      }
    },
    [setSkyFrustum, updateLodForFov],
  );

  // Respond to focus requests from Search, Zenith, Known Objects, or Benchmark dropdown
  useEffect(() => {
    if (!globeFocusRequest) return undefined;
    const raf = window.requestAnimationFrame(() => {
      applyCameraState(globeFocusRequest.ra, globeFocusRequest.dec, globeFocusRequest.fovDeg, true);
      observatoryLogger.info('globe', 'Focused sky camera', {
        ra: Number(globeFocusRequest.ra.toFixed(4)),
        dec: Number(globeFocusRequest.dec.toFixed(4)),
        fovDeg: globeFocusRequest.fovDeg,
      });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [applyCameraState, globeFocusRequest]);

  // Attempt lazy WebGL Aladin Lite v3 initialization using CORS-enabled IRSA HiPS imagery
  useEffect(() => {
    let cancelled = false;
    observatoryLogger.info('globe', 'Loading Aladin Lite v3 runtime from jsDelivr');
    loadAladinLite()
      .then((api) => {
        if (cancelled || !aladinHostRef.current) return;
        const initState = viewStateRef.current;
        const instance = api.aladin(aladinHostRef.current, {
          survey: IRSA_WISE_HIPS_URL,
          projection: 'SIN',
          cooFrame: 'ICRSd',
          target: `${initState.ra} ${initState.dec}`,
          fov: initState.fovDeg,
          showCooGrid: false,
          showCooGridControl: false,
          showFullscreenControl: false,
          showLayersControl: false,
          showGotoControl: false,
          showReticle: false,
          showFrame: false,
          showZoomControl: false,
          showFov: false,
          showProjectionControl: false,
          showCooLocation: false,
          showShareControl: false,
          showSettingsControl: false,
          showSimbadPointerControl: false,
          showStatusBar: false,
          showContextMenu: false,
          log: false,
          backgroundColor: '#000000',
        });
        aladinInstanceRef.current = instance;
        const innerContainer = aladinHostRef.current.firstElementChild as HTMLElement | null;
        if (innerContainer) {
          innerContainer.style.width = '100%';
          innerContainer.style.height = '100%';
        }
        window.dispatchEvent(new Event('resize'));
        window.setTimeout(() => {
          if (!cancelled) {
            window.dispatchEvent(new Event('resize'));
          }
        }, 120);
        setAladinReady(true);
        observatoryLogger.info('globe', 'Aladin Lite v3 initialized cleanly', {
          projection: 'SIN',
          survey: 'allWISE',
        });

        const syncFromAladin = () => {
          const pos = instance.getRaDec?.();
          const rawFov = instance.getFoV?.();
          const parsedFov = Array.isArray(rawFov)
            ? Number(rawFov[0])
            : typeof rawFov === 'number'
              ? rawFov
              : NaN;
          if (!Number.isFinite(parsedFov) || parsedFov <= 0) {
            return;
          }
          const fovDeg = clampGlobeFov(parsedFov);
          const ra = pos ? wrapRaDeg(Number(pos[0])) : viewStateRef.current.ra;
          const dec = pos ? Number(pos[1]) : viewStateRef.current.dec;
          viewStateRef.current = { ra, dec, fovDeg };
          updateLodForFov(fovDeg);

          const rect = containerRef.current?.getBoundingClientRect();
          setSkyFrustum?.({
            ra,
            dec,
            fovDeg,
            aspect: rect && rect.height > 0 ? rect.width / rect.height : 1.4,
          });
        };

        instance.on?.('positionChanged', syncFromAladin);
        instance.on?.('zoomChanged', syncFromAladin);
      })
      .catch((err) => {
        if (!cancelled) {
          setAladinFailed(true);
          observatoryLogger.warn(
            'globe',
            'Aladin Lite unavailable; keeping pure-black 3D star sphere active',
            { error: err instanceof Error ? err.message : 'unavailable' },
          );
        }
      });

    return () => {
      cancelled = true;
    };
    // Intentionally initialize Aladin host once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Draw pure-#000000 interactive 3D celestial sphere fallback when Aladin isn't rendering (paused while Blinker is open)
  useEffect(() => {
    if ((aladinReady && !aladinFailed) || isBlinkerModalOpen) return undefined;
    let rafId = 0;

    const renderSphere = () => {
      const canvas = fallbackCanvasRef.current;
      const host = containerRef.current;
      if (canvas && host) {
        const dpr = window.devicePixelRatio || 1;
        const w = host.clientWidth || window.innerWidth;
        const h = host.clientHeight || window.innerHeight;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, w, h);

          const { ra: cRa, dec: cDec, fovDeg } = viewStateRef.current;

          if (fovDeg >= 110) {
            const halfFovRad = Math.min(Math.PI / 2, fovDeg * 0.5 * (Math.PI / 180));
            const limbRadius = (w * 0.5) / Math.max(1e-4, Math.sin(halfFovRad));
            ctx.beginPath();
            ctx.arc(w * 0.5, h * 0.5, limbRadius, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
            ctx.lineWidth = 1;
            ctx.stroke();
          }

          for (const star of BACKGROUND_STARS) {
            const p = projectSkySin(star.ra, star.dec, cRa, cDec, fovDeg, w, h);
            if (!p.visible || p.px < -4 || p.px > w + 4 || p.py < -4 || p.py > h + 4) {
              continue;
            }
            ctx.globalAlpha = star.alpha;
            ctx.fillStyle = star.tint;
            ctx.beginPath();
            ctx.arc(p.px, p.py, star.size, 0, Math.PI * 2);
            ctx.fill();
          }

          const maxPlot = Math.min(globalKnownObjects.length, 650);
          const placedLabelBoxes: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
          const labelCandidates: Array<{
            obj: (typeof globalKnownObjects)[number];
            px: number;
            py: number;
            priority: number;
          }> = [];

          for (let i = 0; i < maxPlot; i += 1) {
            const obj = globalKnownObjects[i];
            const p = projectSkySin(obj.ra, obj.dec, cRa, cDec, fovDeg, w, h);
            if (!p.visible || p.px < -12 || p.px > w + 12 || p.py < -12 || p.py > h + 12) {
              continue;
            }
            const isMajorObject =
              obj.object_id.startsWith('primary_') ||
              obj.object_id.startsWith('most:') ||
              obj.object_id.startsWith('global:') ||
              obj.default_checked;
            const color = TRACKING_SQUARE_COLORS[i % TRACKING_SQUARE_COLORS.length];
            ctx.globalAlpha = isMajorObject ? 0.92 : 0.65;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(p.px, p.py, isMajorObject ? 3.0 : 1.8, 0, Math.PI * 2);
            ctx.fill();

            if (isMajorObject && (fovDeg <= 12 || !obj.object_id.startsWith('gaia:'))) {
              const priority = obj.object_id.startsWith('primary_')
                ? 3
                : obj.object_id.startsWith('most:')
                  ? 2
                  : obj.object_id.startsWith('global:')
                    ? 1
                    : 0;
              labelCandidates.push({ obj, px: p.px, py: p.py, priority });
            }
          }

          if (fovDeg <= 130 && labelCandidates.length > 0) {
            labelCandidates.sort((a, b) => b.priority - a.priority);
            ctx.font = '500 11px Jost, system-ui, sans-serif';
            ctx.globalAlpha = 0.88;
            ctx.fillStyle = '#e2e8f0';
            for (const cand of labelCandidates) {
              const shortLabel = cand.obj.label.split('(')[0].trim();
              const boxW = Math.max(48, shortLabel.length * 6.5 + 14);
              const x1 = cand.px + 6;
              const y1 = cand.py - 10;
              const x2 = x1 + boxW;
              const y2 = y1 + 16;
              const collides = placedLabelBoxes.some(
                (b) => x1 < b.x2 && x2 > b.x1 && y1 < b.y2 && y2 > b.y1,
              );
              if (collides) continue;
              placedLabelBoxes.push({ x1, y1, x2, y2 });
              ctx.fillText(shortLabel, cand.px + 7, cand.py + 3);
              if (placedLabelBoxes.length >= 28) break;
            }
          }
          ctx.globalAlpha = 1;
        }
      }
      rafId = window.requestAnimationFrame(renderSphere);
    };

    rafId = window.requestAnimationFrame(renderSphere);
    return () => window.cancelAnimationFrame(rafId);
  }, [aladinFailed, aladinReady, globalKnownObjects, isBlinkerModalOpen]);

  const projectWorldPoint = useCallback(
    (ra: number, dec: number, width: number, height: number): { px: number; py: number } | null => {
      if (aladinReady && !aladinFailed && aladinInstanceRef.current?.world2pix) {
        const px = aladinInstanceRef.current.world2pix(ra, dec);
        if (px && Number.isFinite(px[0]) && Number.isFinite(px[1])) {
          return { px: px[0], py: px[1] };
        }
        return null;
      }
      const view = viewStateRef.current;
      const p = projectSkySin(ra, dec, view.ra, view.dec, view.fovDeg, width, height);
      return p.visible ? { px: p.px, py: p.py } : null;
    },
    [aladinFailed, aladinReady],
  );

  const projectPolygonPoints = useCallback(
    (raCenter: number, decCenter: number, width: number, height: number): string | null => {
      const corners = computeSpherExReticleCorners(raCenter, decCenter, SPHEREX_PATCH_ARCMIN);
      const pts: string[] = [];
      for (const [cRa, cDec] of corners) {
        const proj = projectWorldPoint(cRa, cDec, width, height);
        if (!proj) return null;
        pts.push(`${proj.px.toFixed(1)},${proj.py.toFixed(1)}`);
      }
      return pts.length === 4 ? pts.join(' ') : null;
    },
    [projectWorldPoint],
  );

  const clearCursorTooltipTimer = useCallback(() => {
    if (cursorHoverTimerRef.current !== null) {
      window.clearTimeout(cursorHoverTimerRef.current);
      cursorHoverTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearCursorTooltipTimer(), [clearCursorTooltipTimer]);

  const computeHoverOutline = (
    clientX: number,
    clientY: number,
  ): { ra: number; dec: number } | null => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    let world: { ra: number; dec: number } | null = null;
    if (aladinReady && aladinInstanceRef.current?.pix2world) {
      const res = aladinInstanceRef.current.pix2world(x, y);
      if (res && Number.isFinite(res[0]) && Number.isFinite(res[1])) {
        world = { ra: wrapRaDeg(res[0]), dec: res[1] };
      }
    } else {
      world = unprojectSkySin(
        x,
        y,
        viewStateRef.current.ra,
        viewStateRef.current.dec,
        viewStateRef.current.fovDeg,
        rect.width,
        rect.height,
      );
    }

    if (!world) {
      setHoverPatchPolygon(null);
      return null;
    }

    const { raQ, decQ } = quantizeGridCenter(world.ra, world.dec, PANEL_GRID_STEP_DEG);
    const pointsStr = projectPolygonPoints(raQ, decQ, rect.width, rect.height);
    if (pointsStr) {
      setHoverPatchPolygon({ pointsStr, raQ, decQ });
    } else {
      setHoverPatchPolygon(null);
    }
    return world;
  };

  const isInteractiveOverlayTarget = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null;
    if (!el) return false;
    return Boolean(
      el.closest(
        '.aladin-logo, .aladin-attribution, .aladin-box, .hud-panel, .globe-controls-dock, .globe-telemetry-chip, button, input, select, a',
      ),
    );
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || isBlinkerModalOpen || isInteractiveOverlayTarget(e.target)) return;
    clearCursorTooltipTimer();
    setCursorTooltip(null);
    dragRef.current = {
      active: true,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      startRa: viewStateRef.current.ra,
      startDec: viewStateRef.current.dec,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isBlinkerModalOpen) return;
    clearCursorTooltipTimer();
    setCursorTooltip(null);

    if (isInteractiveOverlayTarget(e.target)) {
      setHoverPatchPolygon(null);
      return;
    }

    const drag = dragRef.current;

    if (drag.active && (!aladinReady || aladinFailed)) {
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (Math.hypot(dx, dy) > 4) {
        drag.moved = true;
      }
      const rect = containerRef.current?.getBoundingClientRect();
      const w = rect?.width || window.innerWidth;
      const fov = viewStateRef.current.fovDeg;
      const degPerPx = fov / Math.max(1, w);
      const nextRa = wrapRaDeg(drag.startRa + dx * degPerPx);
      const nextDec = Math.max(-89, Math.min(89, drag.startDec + dy * degPerPx));
      applyCameraState(nextRa, nextDec, fov, false);
    } else if (drag.active) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 5) {
        drag.moved = true;
      }
    }

    const hoveredWorld = computeHoverOutline(e.clientX, e.clientY);
    if (hoveredWorld && !drag.active) {
      const cx = e.clientX;
      const cy = e.clientY;
      cursorHoverTimerRef.current = window.setTimeout(() => {
        setCursorTooltip({ x: cx, y: cy, ra: hoveredWorld.ra, dec: hoveredWorld.dec });
      }, CURSOR_TOOLTIP_DELAY_MS);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    const wasMoved = dragRef.current.moved;
    dragRef.current.active = false;
    if (wasMoved || isBlinkerModalOpen || isInteractiveOverlayTarget(e.target)) return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    let clicked: { ra: number; dec: number } | null = null;
    if (aladinReady && aladinInstanceRef.current?.pix2world) {
      const res = aladinInstanceRef.current.pix2world(x, y);
      if (res && Number.isFinite(res[0]) && Number.isFinite(res[1])) {
        clicked = { ra: wrapRaDeg(res[0]), dec: res[1] };
      }
    } else {
      clicked = unprojectSkySin(
        x,
        y,
        viewStateRef.current.ra,
        viewStateRef.current.dec,
        viewStateRef.current.fovDeg,
        rect.width,
        rect.height,
      );
    }

    if (!clicked) return;

    const action = resolveGlobeClickAction(viewStateRef.current.fovDeg);
    if (action !== 'open_panel') {
      const nextFov = targetFovForClickAction(action);
      applyCameraState(clicked.ra, clicked.dec, nextFov, true);
      observatoryLogger.info('globe', 'Progressive click zoom', {
        stage: action,
        nextFovDeg: nextFov,
        ra: Number(clicked.ra.toFixed(4)),
        dec: Number(clicked.dec.toFixed(4)),
      });
      return;
    }

    // Panel grid is visible (<= 2.5 deg FoV): ONLY clicking a panel opens Blinker.
    triggerTargetOrLivePatch(clicked.ra, clicked.dec);
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (isBlinkerModalOpen || (aladinReady && !aladinFailed)) return;
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.18 : 0.84;
    const nextFov = clampGlobeFov(viewStateRef.current.fovDeg * factor);
    const { ra, dec } = viewStateRef.current;
    applyCameraState(ra, dec, nextFov, false);
  };

  const liveFrustum = skyFrustum ?? {
    ra: coordinates.ra,
    dec: coordinates.dec,
    fovDeg: 70,
  };

  interface GlobeKnownMarker {
    id: string;
    label: string;
    px: number;
    py: number;
    shape: 'triangle' | 'diamond';
    color: string;
  }

  const [overlayGeometry, setOverlayGeometry] = useState<{
    constellationLines: Array<{ key: string; x1: number; y1: number; x2: number; y2: number }>;
    constellationLabels: Array<{ abbr: string; name: string; px: number; py: number }>;
    knownMarkers: GlobeKnownMarker[];
  }>({
    constellationLines: [],
    constellationLabels: [],
    knownMarkers: [],
  });

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      if (isBlinkerModalOpen) {
        setOverlayGeometry({
          constellationLines: [],
          constellationLabels: [],
          knownMarkers: [],
        });
        return;
      }

      const w = viewportSize.width;
      const h = viewportSize.height;
      const nextLines: Array<{ key: string; x1: number; y1: number; x2: number; y2: number }> = [];
      const nextLabels: Array<{ abbr: string; name: string; px: number; py: number }> = [];
      if (showConstellations) {
        for (const c of IAU_CONSTELLATIONS) {
          c.segments.forEach((seg, idx) => {
            const p1 = projectWorldPoint(seg.ra1, seg.dec1, w, h);
            const p2 = projectWorldPoint(seg.ra2, seg.dec2, w, h);
            if (!p1 || !p2) return;
            if (Math.hypot(p1.px - p2.px, p1.py - p2.py) > w * 0.85) return;
            if (
              Math.max(p1.px, p2.px) < -40 ||
              Math.min(p1.px, p2.px) > w + 40 ||
              Math.max(p1.py, p2.py) < -40 ||
              Math.min(p1.py, p2.py) > h + 40
            ) {
              return;
            }
            nextLines.push({
              key: `${c.abbr}-${idx}`,
              x1: p1.px,
              y1: p1.py,
              x2: p2.px,
              y2: p2.py,
            });
          });

          if (liveFrustum.fovDeg >= 10) {
            const centerPt = projectWorldPoint(c.centerRa, c.centerDec, w, h);
            if (
              centerPt &&
              centerPt.px >= 24 &&
              centerPt.px <= w - 24 &&
              centerPt.py >= 24 &&
              centerPt.py <= h - 24
            ) {
              nextLabels.push({
                abbr: c.abbr,
                name: c.name,
                px: centerPt.px,
                py: centerPt.py,
              });
            }
          }
        }
      }

      // Highlight checked Known Objects directly on top of WebGL Aladin & canvas fallback
      const checkedSet = new Set(renderSettings.checkedObjectIds);
      const nextKnownMarkers: GlobeKnownMarker[] = [];
      if (checkedSet.size > 0) {
        const seenIds = new Set<string>();
        const combined = [...knownObjects, ...globalKnownObjects];
        for (const obj of combined) {
          if (!checkedSet.has(obj.object_id) || seenIds.has(obj.object_id)) continue;
          seenIds.add(obj.object_id);
          const pt = projectWorldPoint(obj.ra, obj.dec, w, h);
          if (!pt || pt.px < 8 || pt.px > w - 8 || pt.py < 8 || pt.py > h - 8) continue;
          const shapeKind = getMarkerShapeKind(obj, false);
          nextKnownMarkers.push({
            id: obj.object_id,
            label: obj.label,
            px: pt.px,
            py: pt.py,
            shape: shapeKind === 'diamond' ? 'diamond' : 'triangle',
            color:
              objectHighlighterColors[obj.object_id] ??
              (obj.object_type === 'solar_system' ? '#fbbf24' : '#38bdf8'),
          });
          if (nextKnownMarkers.length >= 120) break;
        }
      }

      setOverlayGeometry({
        constellationLines: nextLines,
        constellationLabels: nextLabels,
        knownMarkers: nextKnownMarkers,
      });
    });

    return () => window.cancelAnimationFrame(raf);
  }, [
    aladinFailed,
    aladinReady,
    globalKnownObjects,
    isBlinkerModalOpen,
    knownObjects,
    liveFrustum.dec,
    liveFrustum.fovDeg,
    liveFrustum.ra,
    objectHighlighterColors,
    projectWorldPoint,
    projection,
    renderSettings.checkedObjectIds,
    showConstellations,
    viewportSize.height,
    viewportSize.width,
  ]);

  const constellationOverlay = {
    lines: overlayGeometry.constellationLines,
    labels: overlayGeometry.constellationLabels,
  };

  const handleAccessiblePan = (dir: 'north' | 'south' | 'east' | 'west') => {
    const cur = viewStateRef.current;
    const next = stepPanCoordinates(cur.ra, cur.dec, cur.fovDeg, dir);
    applyCameraState(next.ra, next.dec, cur.fovDeg, true);
    observatoryLogger.info('globe', 'Accessible pan button pressed', { dir, ...next });
  };

  const handleAccessibleZoom = (factor: number | 'reset') => {
    const cur = viewStateRef.current;
    const nextFov = factor === 'reset' ? 70.0 : clampGlobeFov(cur.fovDeg * factor);
    applyCameraState(cur.ra, cur.dec, nextFov, true);
    observatoryLogger.info('globe', 'Accessible zoom button pressed', {
      action: factor === 'reset' ? 'reset' : factor < 1 ? 'zoom_in' : 'zoom_out',
      fovDeg: Number(nextFov.toFixed(2)),
    });
  };

  const handleProjectionChange = (nextProj: GlobeProjection) => {
    setProjection(nextProj);
    aladinInstanceRef.current?.setProjection?.(nextProj);
    observatoryLogger.info('globe', 'Projection changed', { projection: nextProj });
  };

  const commitTelemetryCoordinates = (e?: React.FormEvent) => {
    e?.preventDefault();
    const rawRa = coordEditing ? raDraft : liveFrustum.ra.toFixed(4);
    const rawDec = coordEditing ? decDraft : liveFrustum.dec.toFixed(4);
    const parsedRa = Number.parseFloat(rawRa);
    const parsedDec = Number.parseFloat(rawDec);
    if (
      !Number.isFinite(parsedRa) ||
      !Number.isFinite(parsedDec) ||
      parsedDec < -90 ||
      parsedDec > 90
    ) {
      setCoordEditing(false);
      return;
    }
    const nextRa = wrapRaDeg(parsedRa);
    const nextDec = Math.max(-89.9, Math.min(89.9, parsedDec));
    setCoordEditing(false);
    applyCameraState(nextRa, nextDec, viewStateRef.current.fovDeg, true);
    observatoryLogger.info('globe', 'Navigated from inline telemetry coordinates', {
      ra: nextRa,
      dec: nextDec,
    });
  };

  const isPanelGridVisible = liveFrustum.fovDeg <= PANEL_GRID_FOV_DEG;

  return (
    <section className="globe-viewport-layer" aria-label="Interactive Night-Sky Observatory">
      <div
        ref={containerRef}
        data-testid="night-sky-globe"
        className="globe-viewport-layer"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => {
          dragRef.current.active = false;
          clearCursorTooltipTimer();
          setCursorTooltip(null);
          setHoverPatchPolygon(null);
        }}
        onWheel={handleWheel}
      >
        {/* Aladin Lite v3 WebGL Sky Globe host (pure #000000 background, IRSA HiPS imagery) */}
        <div
          ref={aladinHostRef}
          className="aladin-host"
          style={{ display: aladinFailed ? 'none' : 'block' }}
        />

        {/* Synchronized #000000 interactive 3D canvas fallback while/if Aladin CDN is unavailable */}
        {(!aladinReady || aladinFailed) && (
          <canvas
            ref={fallbackCanvasRef}
            className="globe-fallback-canvas"
            aria-label="3D Night-Sky Globe Canvas"
          />
        )}

        {/* Constellations + checked Known Objects + yellow panel hover highlight outline */}
        <svg className="globe-reticle-overlay" aria-hidden="true">
          {constellationOverlay.lines.map((line) => (
            <line
              key={line.key}
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              stroke="rgba(148, 163, 184, 0.30)"
              strokeWidth={1}
            />
          ))}
          {constellationOverlay.labels.map((lbl) => (
            <text
              key={lbl.abbr}
              x={lbl.px}
              y={lbl.py}
              textAnchor="middle"
              fill="rgba(186, 230, 253, 0.62)"
              fontSize={10}
              fontFamily="Jost, system-ui, sans-serif"
              letterSpacing="0.06em"
            >
              {lbl.name.toUpperCase()}
            </text>
          ))}

          {overlayGeometry.knownMarkers.map((m) => (
            <g key={m.id} data-globe-marker={m.id}>
              {m.shape === 'diamond' ? (
                <polygon
                  points={`${m.px},${m.py - 8} ${m.px + 8},${m.py} ${m.px},${m.py + 8} ${
                    m.px - 8
                  },${m.py}`}
                  fill="none"
                  stroke={m.color}
                  strokeWidth={1.6}
                />
              ) : (
                <polygon
                  points={`${m.px},${m.py - 8} ${m.px + 8},${m.py + 7} ${m.px - 8},${m.py + 7}`}
                  fill="none"
                  stroke={m.color}
                  strokeWidth={1.6}
                />
              )}
              <text
                x={m.px + 11}
                y={m.py + 3}
                fill={m.color}
                fontSize={10}
                fontWeight={600}
                stroke="rgba(5, 8, 15, 0.9)"
                strokeWidth={2.8}
                paintOrder="stroke"
                style={{ fontFamily: 'Inter, system-ui, sans-serif' }}
              >
                {m.label}
              </text>
            </g>
          ))}

          {isPanelGridVisible && hoverPatchPolygon && (
            <polygon
              data-testid="globe-hover-panel"
              points={hoverPatchPolygon.pointsStr}
              fill="rgba(245, 158, 11, 0.08)"
              stroke="rgba(251, 191, 36, 0.92)"
              strokeWidth={1.5}
            />
          )}
        </svg>

        {cursorTooltip && !isBlinkerModalOpen && (
          <div
            className="globe-cursor-tooltip mono"
            data-testid="globe-cursor-tooltip"
            style={{
              left: Math.min(viewportSize.width - 280, Math.max(12, cursorTooltip.x + 14)),
              top: Math.min(viewportSize.height - 44, Math.max(12, cursorTooltip.y + 14)),
            }}
          >
            {formatRaDecCompact(cursorTooltip.ra, cursorTooltip.dec)}
          </div>
        )}
      </div>

      {/* Accessible Pan, Zoom, Projection & Constellation Controls */}
      <div
        className="globe-controls-dock"
        data-testid="globe-nav-controls"
        role="group"
        aria-label="Sky Globe Pan, Zoom and Overlay Controls"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="globe-pan-cross" aria-label="Pan Sky Coordinates">
          <span />
          <button
            type="button"
            className="globe-nav-btn"
            aria-label="Pan North (Increase Declination)"
            title="Pan North"
            data-testid="globe-pan-north"
            onClick={() => handleAccessiblePan('north')}
          >
            N
          </button>
          <span />
          <button
            type="button"
            className="globe-nav-btn"
            aria-label="Pan West (Decrease Right Ascension)"
            title="Pan West"
            data-testid="globe-pan-west"
            onClick={() => handleAccessiblePan('west')}
          >
            W
          </button>
          <button
            type="button"
            className="globe-nav-btn"
            aria-label="Pan South (Decrease Declination)"
            title="Pan South"
            data-testid="globe-pan-south"
            onClick={() => handleAccessiblePan('south')}
          >
            S
          </button>
          <button
            type="button"
            className="globe-nav-btn"
            aria-label="Pan East (Increase Right Ascension)"
            title="Pan East"
            data-testid="globe-pan-east"
            onClick={() => handleAccessiblePan('east')}
          >
            E
          </button>
        </div>

        <span className="globe-telemetry-divider" style={{ height: 24 }} />

        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            className="globe-nav-btn"
            aria-label="Zoom In"
            title="Zoom In"
            data-testid="globe-zoom-in"
            onClick={() => handleAccessibleZoom(0.62)}
          >
            +
          </button>
          <button
            type="button"
            className="globe-nav-btn"
            aria-label="Zoom Out"
            title="Zoom Out"
            data-testid="globe-zoom-out"
            onClick={() => handleAccessibleZoom(1.48)}
          >
            -
          </button>
          <button
            type="button"
            className="globe-nav-btn"
            aria-label="Reset Sky Zoom"
            title="Reset View (70 deg FoV)"
            data-testid="globe-zoom-reset"
            onClick={() => handleAccessibleZoom('reset')}
          >
            Reset
          </button>
        </div>

        <span className="globe-telemetry-divider" style={{ height: 24 }} />

        <button
          type="button"
          className={`globe-nav-btn ${showConstellations ? 'is-active' : ''}`}
          aria-pressed={showConstellations}
          aria-label="Toggle Constellation Lines and Labels"
          data-testid="globe-constellations-toggle"
          onClick={() => {
            setShowConstellations((prev) => {
              const next = !prev;
              observatoryLogger.info('globe', 'Toggled constellation overlay', { visible: next });
              return next;
            });
          }}
        >
          Constellations
        </button>

        <select
          aria-label="Sky Globe Projection"
          data-testid="globe-projection-select"
          className="globe-nav-btn"
          style={{ paddingRight: 6 }}
          value={projection}
          onChange={(e) => handleProjectionChange(e.target.value as GlobeProjection)}
        >
          {SUPPORTED_GLOBE_PROJECTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Bottom-left compact live astrometry, inline coordinate input & active LoD status pill */}
      <form
        className="globe-telemetry-chip"
        data-testid="globe-telemetry-chip"
        onSubmit={commitTelemetryCoordinates}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <label className="telemetry-coord-label">
          <span>Right Ascension</span>
          <input
            type="text"
            inputMode="decimal"
            className="telemetry-coord-input mono"
            aria-label="Right Ascension in degrees"
            data-testid="telemetry-ra-input"
            value={coordEditing ? raDraft : liveFrustum.ra.toFixed(4)}
            onFocus={() => {
              setRaDraft(liveFrustum.ra.toFixed(4));
              setDecDraft(liveFrustum.dec.toFixed(4));
              setCoordEditing(true);
            }}
            onChange={(e) => {
              if (!coordEditing) {
                setDecDraft(liveFrustum.dec.toFixed(4));
                setCoordEditing(true);
              }
              setRaDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setCoordEditing(false);
            }}
          />
          <span>°</span>
        </label>

        <label className="telemetry-coord-label">
          <span>Declination</span>
          <input
            type="text"
            inputMode="decimal"
            className="telemetry-coord-input mono"
            aria-label="Declination in degrees"
            data-testid="telemetry-dec-input"
            value={
              coordEditing
                ? decDraft
                : `${liveFrustum.dec >= 0 ? '+' : ''}${liveFrustum.dec.toFixed(4)}`
            }
            onFocus={() => {
              setRaDraft(liveFrustum.ra.toFixed(4));
              setDecDraft(liveFrustum.dec.toFixed(4));
              setCoordEditing(true);
            }}
            onChange={(e) => {
              if (!coordEditing) {
                setRaDraft(liveFrustum.ra.toFixed(4));
                setCoordEditing(true);
              }
              setDecDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setCoordEditing(false);
            }}
          />
          <span>°</span>
        </label>

        {coordEditing && (
          <button
            type="submit"
            className="hud-btn-primary"
            style={{ height: 22, padding: '0 8px', fontSize: 10 }}
            data-testid="telemetry-coord-go"
          >
            Go
          </button>
        )}

        <span className="globe-telemetry-divider" />
        <span className="mono">FoV {liveFrustum.fovDeg.toFixed(1)}°</span>
        <span className="globe-telemetry-lod">
          <span className="globe-telemetry-divider" />
          <span>
            Sky Map: <strong>{activeSurveyLabel}</strong>
          </span>
        </span>
        {isPanelGridVisible && (
          <span
            className="badge-pill is-star"
            style={{ fontSize: 10, padding: '2px 7px', textTransform: 'none' }}
          >
            Click any panel to inspect
          </span>
        )}
      </form>
    </section>
  );
};
