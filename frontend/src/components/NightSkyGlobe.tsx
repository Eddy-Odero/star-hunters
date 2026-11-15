import React, { useCallback, useEffect, useRef, useState } from 'react';
import { IAU_CONSTELLATIONS } from '../data/constellations';
import { useSkyExplorer } from '../context/SkyExplorerContext';
import { TRACKING_SQUARE_COLORS } from '../types/contracts';
import {
  buildVisibleSkyPanels,
  clampGlobeFov,
  PANEL_GRID_FOV_DEG,
  PANEL_GRID_STEP_DEG,
  resolveGlobeClickAction,
  stepPanCoordinates,
  targetFovForClickAction,
} from '../utils/globeNavigation';
import { observatoryLogger } from '../utils/observatoryLogger';
import {
  angularSeparationDeg,
  BENCHMARK_TARGET_OPTIONS,
  computeSpherExReticleCorners,
  formatRaDecCompact,
  quantizeGridCenter,
  wrapRaDeg,
} from '../utils/observatoryMath';
import { TargetReticleIcon } from './icons/ObservatoryIcons';

const ALADIN_MODULE_URL = 'https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js';
const IRSA_SPHEREX_HIPS_URL = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
const IRSA_WISE_HIPS_URL = 'https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/RGB-W4-W2-W1';
const IRSA_2MASS_HIPS_URL = 'https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color';
const ALADIN_LOAD_TIMEOUT_MS = 12000;
const SPHEREX_PATCH_ARCMIN = 5.0;
const HIGH_RES_LOD_FOV_DEG = 12.0;

type GlobeSurveyMode = 'lod' | 'spherex';

interface AladinInstance {
  gotoRaDec(ra: number, dec: number): void;
  setFoV?(fovDeg: number): void;
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
    globalKnownObjects = [],
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
  const [surveyMode, setSurveyMode] = useState<GlobeSurveyMode>('lod');
  const surveyModeRef = useRef<GlobeSurveyMode>('lod');
  useEffect(() => {
    surveyModeRef.current = surveyMode;
  }, [surveyMode]);
  const [activeSurveyLabel, setActiveSurveyLabel] = useState<'allWISE' | '2MASS' | 'SPHEREx'>(
    'allWISE',
  );
  const [showConstellations, setShowConstellations] = useState<boolean>(true);
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

  // Progressive LoD survey tier switching based on FoV or explicit SPHEREx HiPS mode
  const updateLodForFov = useCallback((fovDeg: number, explicitMode?: GlobeSurveyMode) => {
    const mode = explicitMode ?? surveyModeRef.current;
    const targetSurvey =
      mode === 'spherex'
        ? IRSA_SPHEREX_HIPS_URL
        : fovDeg <= HIGH_RES_LOD_FOV_DEG
          ? IRSA_2MASS_HIPS_URL
          : IRSA_WISE_HIPS_URL;
    const nextLabel: 'allWISE' | '2MASS' | 'SPHEREx' =
      mode === 'spherex' ? 'SPHEREx' : fovDeg <= HIGH_RES_LOD_FOV_DEG ? '2MASS' : 'allWISE';
    setActiveSurveyLabel((prev) => {
      if (prev !== nextLabel) {
        aladinInstanceRef.current?.setImageSurvey?.(targetSurvey);
        observatoryLogger.info('globe', 'Globe background sky survey switched', {
          survey: nextLabel,
          fovDeg: Number(fovDeg.toFixed(2)),
        });
      }
      return nextLabel;
    });
  }, []);

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
    if (!globeFocusRequest) return;
    applyCameraState(globeFocusRequest.ra, globeFocusRequest.dec, globeFocusRequest.fovDeg, true);
    observatoryLogger.info('globe', 'Focused sky camera', {
      ra: Number(globeFocusRequest.ra.toFixed(4)),
      dec: Number(globeFocusRequest.dec.toFixed(4)),
      fovDeg: globeFocusRequest.fovDeg,
    });
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
          survey: surveyModeRef.current === 'spherex' ? IRSA_SPHEREX_HIPS_URL : IRSA_WISE_HIPS_URL,
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
          backgroundColor: '#000000',
        });
        aladinInstanceRef.current = instance;
        setAladinReady(true);
        observatoryLogger.info('globe', 'Aladin Lite v3 initialized cleanly', {
          projection: 'SIN',
          survey: surveyModeRef.current,
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

  const computeHoverOutline = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
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
      return;
    }

    const { raQ, decQ } = quantizeGridCenter(world.ra, world.dec, PANEL_GRID_STEP_DEG);
    const pointsStr = projectPolygonPoints(raQ, decQ, rect.width, rect.height);
    if (pointsStr) {
      setHoverPatchPolygon({ pointsStr, raQ, decQ });
    } else {
      setHoverPatchPolygon(null);
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || isBlinkerModalOpen) return;
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

    computeHoverOutline(e.clientX, e.clientY);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    const wasMoved = dragRef.current.moved;
    dragRef.current.active = false;
    if (wasMoved || isBlinkerModalOpen) return;

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

  const [overlayGeometry, setOverlayGeometry] = useState<{
    visiblePanels: Array<{ key: string; pointsStr: string; raQ: number; decQ: number }>;
    constellationLines: Array<{ key: string; x1: number; y1: number; x2: number; y2: number }>;
    constellationLabels: Array<{ abbr: string; name: string; px: number; py: number }>;
  }>({
    visiblePanels: [],
    constellationLines: [],
    constellationLabels: [],
  });

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      if (isBlinkerModalOpen) {
        setOverlayGeometry({
          visiblePanels: [],
          constellationLines: [],
          constellationLabels: [],
        });
        return;
      }

      const w = viewportSize.width;
      const h = viewportSize.height;
      const nextPanels: Array<{ key: string; pointsStr: string; raQ: number; decQ: number }> = [];
      if (liveFrustum.fovDeg <= PANEL_GRID_FOV_DEG) {
        const cells = buildVisibleSkyPanels(liveFrustum.ra, liveFrustum.dec, liveFrustum.fovDeg);
        for (const cell of cells) {
          const pointsStr = projectPolygonPoints(cell.raQ, cell.decQ, w, h);
          if (pointsStr) {
            nextPanels.push({ key: cell.key, pointsStr, raQ: cell.raQ, decQ: cell.decQ });
          }
        }
      }

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

      setOverlayGeometry({
        visiblePanels: nextPanels,
        constellationLines: nextLines,
        constellationLabels: nextLabels,
      });
    });

    return () => window.cancelAnimationFrame(raf);
  }, [
    aladinFailed,
    aladinReady,
    isBlinkerModalOpen,
    liveFrustum.dec,
    liveFrustum.fovDeg,
    liveFrustum.ra,
    projectPolygonPoints,
    projectWorldPoint,
    showConstellations,
    viewportSize.height,
    viewportSize.width,
  ]);

  const visiblePanels = overlayGeometry.visiblePanels;
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

  const handleToggleSurveyMode = () => {
    const next: GlobeSurveyMode = surveyMode === 'lod' ? 'spherex' : 'lod';
    setSurveyMode(next);
    surveyModeRef.current = next;
    updateLodForFov(viewStateRef.current.fovDeg, next);
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

        {/* Constellations + visible clickable sky panel grid + hover highlight outline */}
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

          {visiblePanels.map((panel) => {
            const isHovered =
              hoverPatchPolygon &&
              Math.abs(hoverPatchPolygon.raQ - panel.raQ) < 0.01 &&
              Math.abs(hoverPatchPolygon.decQ - panel.decQ) < 0.01;
            return (
              <polygon
                key={panel.key}
                points={panel.pointsStr}
                fill={isHovered ? 'rgba(245, 158, 11, 0.10)' : 'rgba(56, 189, 248, 0.025)'}
                stroke={isHovered ? 'rgba(251, 191, 36, 0.90)' : 'rgba(56, 189, 248, 0.28)'}
                strokeWidth={isHovered ? 1.3 : 0.8}
              />
            );
          })}

          {!isPanelGridVisible && hoverPatchPolygon && (
            <polygon
              points={hoverPatchPolygon.pointsStr}
              fill="rgba(255, 255, 255, 0.03)"
              stroke="rgba(248, 250, 252, 0.38)"
              strokeWidth={1}
            />
          )}
        </svg>
      </div>

      {/* Accessible Pan, Zoom & Constellation Controls */}
      <div
        className="globe-controls-dock"
        data-testid="globe-nav-controls"
        role="group"
        aria-label="Sky Globe Pan, Zoom and Overlay Controls"
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

        <button
          type="button"
          className={`globe-nav-btn ${surveyMode === 'spherex' ? 'is-active' : ''}`}
          aria-pressed={surveyMode === 'spherex'}
          aria-label="Switch Background Sky Survey Layer"
          title="Switch between SPHEREx All-Sky HiPS and WISE / 2MASS LoD"
          data-testid="globe-survey-toggle"
          onClick={handleToggleSurveyMode}
        >
          {surveyMode === 'spherex' ? 'SPHEREx Sky' : 'IR LoD Sky'}
        </button>
      </div>

      {/* Bottom-left compact live astrometry & progressive LoD status pill */}
      <div className="globe-telemetry-chip">
        <span className="mono">{formatRaDecCompact(liveFrustum.ra, liveFrustum.dec)}</span>
        <span className="globe-telemetry-divider" />
        <span className="mono">FoV {liveFrustum.fovDeg.toFixed(1)}°</span>
        <span className="globe-telemetry-lod">
          <span className="globe-telemetry-divider" />
          <span>
            Sky Map:{' '}
            <strong>
              {activeSurveyLabel === 'SPHEREx'
                ? 'SPHEREx HiPS'
                : activeSurveyLabel === '2MASS'
                  ? '2MASS High-Res (IRSA)'
                  : 'AllWISE Wide (IRSA)'}
            </strong>
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
        <button
          type="button"
          className="hud-btn-secondary"
          style={{ height: 24, padding: '0 8px', pointerEvents: 'auto', fontSize: 11 }}
          onClick={() => triggerTargetOrLivePatch(liveFrustum.ra, liveFrustum.dec)}
          data-testid="inspect-center-patch-btn"
        >
          <TargetReticleIcon size={12} />
          <span>Inspect Panel</span>
        </button>
      </div>
    </section>
  );
};
