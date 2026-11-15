import React, { useEffect, useRef, useState } from 'react';
import { useSkyExplorer } from '../context/SkyExplorerContext';
import { TRACKING_SQUARE_COLORS } from '../types/contracts';
import {
  angularSeparationDeg,
  BENCHMARK_TARGET_OPTIONS,
  computeSpherExReticleCorners,
  formatRaDecCompact,
  quantizeGridCenter,
  wrapRaDeg,
} from '../utils/observatoryMath';
import { TargetReticleIcon } from './icons/ObservatoryIcons';

const ALADIN_SCRIPT_URL = 'https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js';
const ALADIN_CSS_URL = 'https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.css';
const ALADIN_LOAD_TIMEOUT_MS = 5000;
const SPHEREX_PATCH_ARCMIN = 5.0;
const HIGH_RES_LOD_FOV_DEG = 12.0;
const AUTO_PATCH_ENTRY_FOV_DEG = 0.5;
const TWO_STAGE_CLICK_FOV_DEG = 15.0;

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

function ensureAladinStylesheet(): void {
  if (document.querySelector('link[data-aladin-lite-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = ALADIN_CSS_URL;
  link.dataset.aladinLiteCss = 'true';
  document.head.appendChild(link);
}

function loadAladinLite(): Promise<AladinApi> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('Aladin Lite requires a browser runtime'));
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

    const finish = (api?: AladinApi, err?: Error) => {
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
        reject(err ?? new Error('Failed to load Aladin Lite'));
      }
    };

    timeoutId = window.setTimeout(() => {
      finish(undefined, new Error('Aladin Lite load timeout'));
    }, ALADIN_LOAD_TIMEOUT_MS);

    script.onload = () => {
      const api = window.A;
      if (!api || typeof api.aladin !== 'function') {
        finish(undefined, new Error('Aladin Lite global API unavailable'));
        return;
      }
      Promise.resolve(api.init)
        .then(() => finish(api))
        .catch((e: unknown) =>
          finish(undefined, e instanceof Error ? e : new Error('Aladin init failed')),
        );
    };
    script.onerror = () => finish(undefined, new Error('Aladin script error'));
    document.head.appendChild(script);
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
  const [activeSurveyLabel, setActiveSurveyLabel] = useState<'allWISE' | '2MASS'>('allWISE');

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

  const modalTriggerGuardRef = useRef<number>(0);

  const triggerTargetOrLivePatch = (ra: number, dec: number) => {
    const matchedBenchmark = BENCHMARK_TARGET_OPTIONS.find(
      (b) => angularSeparationDeg(ra, dec, b.ra, b.dec) <= 0.25,
    );
    if (matchedBenchmark) {
      openBlinkerModal?.(matchedBenchmark.slug);
    } else {
      openBlinkerModal?.({ ra, dec, fovArcmin: SPHEREX_PATCH_ARCMIN });
    }
  };

  // Progressive LoD survey tier switching based on FoV
  const updateLodForFov = (fovDeg: number) => {
    const targetSurvey =
      fovDeg <= HIGH_RES_LOD_FOV_DEG ? 'CDS/P/2MASS/color' : 'CDS/P/allWISE/color';
    const nextLabel = fovDeg <= HIGH_RES_LOD_FOV_DEG ? '2MASS' : 'allWISE';
    setActiveSurveyLabel((prev) => {
      if (prev !== nextLabel) {
        aladinInstanceRef.current?.setImageSurvey?.(targetSurvey);
      }
      return nextLabel;
    });
  };

  // Respond to focus requests from Search, Zenith, Known Objects, or Benchmark dropdown
  useEffect(() => {
    if (!globeFocusRequest) return;
    viewStateRef.current = {
      ra: globeFocusRequest.ra,
      dec: globeFocusRequest.dec,
      fovDeg: globeFocusRequest.fovDeg,
    };
    const rect = containerRef.current?.getBoundingClientRect();
    setSkyFrustum?.({
      ra: globeFocusRequest.ra,
      dec: globeFocusRequest.dec,
      fovDeg: globeFocusRequest.fovDeg,
      aspect: rect && rect.height > 0 ? rect.width / rect.height : 1.4,
    });
    updateLodForFov(globeFocusRequest.fovDeg);
    if (aladinInstanceRef.current) {
      aladinInstanceRef.current.gotoRaDec(globeFocusRequest.ra, globeFocusRequest.dec);
      aladinInstanceRef.current.setFoV?.(globeFocusRequest.fovDeg);
    }
  }, [globeFocusRequest, setSkyFrustum]);

  // Attempt lazy WebGL Aladin Lite v3 initialization (projection: 'SIN', #000000 void, NO grid)
  useEffect(() => {
    let cancelled = false;
    loadAladinLite()
      .then((api) => {
        if (cancelled || !aladinHostRef.current) return;
        const initState = viewStateRef.current;
        const instance = api.aladin(aladinHostRef.current, {
          survey: 'CDS/P/allWISE/color',
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

        const syncFromAladin = () => {
          const pos = instance.getRaDec?.();
          const rawFov = instance.getFoV?.();
          const fovDeg = Array.isArray(rawFov)
            ? Number(rawFov[0])
            : typeof rawFov === 'number'
              ? rawFov
              : viewStateRef.current.fovDeg;
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

          // Zoom-threshold trigger into Blinker Modal (< 0.5° FoV)
          if (
            fovDeg < AUTO_PATCH_ENTRY_FOV_DEG &&
            !isBlinkerModalOpen &&
            Date.now() - modalTriggerGuardRef.current > 1200
          ) {
            modalTriggerGuardRef.current = Date.now();
            triggerTargetOrLivePatch(ra, dec);
          }
        };

        instance.on?.('positionChanged', syncFromAladin);
        instance.on?.('zoomChanged', syncFromAladin);
      })
      .catch(() => {
        if (!cancelled) {
          setAladinFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
    // Intentionally initialize Aladin host once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Draw pure-#000000 interactive 3D celestial sphere fallback when Aladin isn't rendering
  useEffect(() => {
    if (aladinReady && !aladinFailed) return;
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

          // Subtle 3D horizon limb circle when viewing whole sphere (>= 110°)
          if (fovDeg >= 110) {
            const halfFovRad = Math.min(Math.PI / 2, fovDeg * 0.5 * (Math.PI / 180));
            const limbRadius = (w * 0.5) / Math.max(1e-4, Math.sin(halfFovRad));
            ctx.beginPath();
            ctx.arc(w * 0.5, h * 0.5, limbRadius, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
            ctx.lineWidth = 1;
            ctx.stroke();
          }

          // Background stars on the pure black sky
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

          // Plot known objects from global catalog with subtle pinpoints and collision-culled labels
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
  }, [aladinFailed, aladinReady, globalKnownObjects]);

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

    const { raQ, decQ } = quantizeGridCenter(world.ra, world.dec, 0.05);
    const corners = computeSpherExReticleCorners(raQ, decQ, SPHEREX_PATCH_ARCMIN);
    const screenPts: string[] = [];

    for (const [cRa, cDec] of corners) {
      if (aladinReady && aladinInstanceRef.current?.world2pix) {
        const px = aladinInstanceRef.current.world2pix(cRa, cDec);
        if (px && Number.isFinite(px[0]) && Number.isFinite(px[1])) {
          screenPts.push(`${px[0].toFixed(1)},${px[1].toFixed(1)}`);
        }
      } else {
        const p = projectSkySin(
          cRa,
          cDec,
          viewStateRef.current.ra,
          viewStateRef.current.dec,
          viewStateRef.current.fovDeg,
          rect.width,
          rect.height,
        );
        if (p.visible) {
          screenPts.push(`${p.px.toFixed(1)},${p.py.toFixed(1)}`);
        }
      }
    }

    if (screenPts.length === 4) {
      setHoverPatchPolygon({ pointsStr: screenPts.join(' '), raQ, decQ });
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
      viewStateRef.current = { ra: nextRa, dec: nextDec, fovDeg: fov };
      setSkyFrustum?.({
        ra: nextRa,
        dec: nextDec,
        fovDeg: fov,
        aspect: rect && rect.height > 0 ? rect.width / rect.height : 1.4,
      });
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

    const currentFov = viewStateRef.current.fovDeg;
    if (currentFov > TWO_STAGE_CLICK_FOV_DEG) {
      // Two-stage Stage 1: wide FoV zooms smoothly toward clicked region
      const nextFov = 2.0;
      viewStateRef.current = { ra: clicked.ra, dec: clicked.dec, fovDeg: nextFov };
      updateLodForFov(nextFov);
      setSkyFrustum?.({
        ra: clicked.ra,
        dec: clicked.dec,
        fovDeg: nextFov,
        aspect: rect.height > 0 ? rect.width / rect.height : 1.4,
      });
      aladinInstanceRef.current?.gotoRaDec(clicked.ra, clicked.dec);
      aladinInstanceRef.current?.setFoV?.(nextFov);
    } else {
      // Two-stage Stage 2: close FoV opens full-resolution Patch Inspector Modal
      triggerTargetOrLivePatch(clicked.ra, clicked.dec);
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (isBlinkerModalOpen || (aladinReady && !aladinFailed)) return;
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.18 : 0.84;
    const nextFov = Math.max(0.35, Math.min(180, viewStateRef.current.fovDeg * factor));
    const { ra, dec } = viewStateRef.current;
    viewStateRef.current = { ra, dec, fovDeg: nextFov };
    updateLodForFov(nextFov);

    const rect = containerRef.current?.getBoundingClientRect();
    setSkyFrustum?.({
      ra,
      dec,
      fovDeg: nextFov,
      aspect: rect && rect.height > 0 ? rect.width / rect.height : 1.4,
    });

    if (
      nextFov < AUTO_PATCH_ENTRY_FOV_DEG &&
      !isBlinkerModalOpen &&
      Date.now() - modalTriggerGuardRef.current > 1200
    ) {
      modalTriggerGuardRef.current = Date.now();
      triggerTargetOrLivePatch(ra, dec);
    }
  };

  const liveFrustum = skyFrustum ?? {
    ra: coordinates.ra,
    dec: coordinates.dec,
    fovDeg: 70,
  };

  return (
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
      {/* Aladin Lite v3 WebGL Sky Globe host (strictly black background, ZERO coordinate grid) */}
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

      {/* Subtle border ONLY around the single 5'x5' sky patch directly under the cursor */}
      <svg className="globe-reticle-overlay" aria-hidden="true">
        {hoverPatchPolygon && (
          <polygon
            points={hoverPatchPolygon.pointsStr}
            fill="rgba(255, 255, 255, 0.03)"
            stroke="rgba(248, 250, 252, 0.38)"
            strokeWidth={1}
          />
        )}
      </svg>

      {/* Bottom-left compact live astrometry & progressive LoD status pill */}
      <div className="globe-telemetry-chip">
        <span className="mono">{formatRaDecCompact(liveFrustum.ra, liveFrustum.dec)}</span>
        <span className="globe-telemetry-divider" />
        <span className="mono">FoV {liveFrustum.fovDeg.toFixed(1)}°</span>
        <span className="globe-telemetry-lod">
          <span className="globe-telemetry-divider" />
          <span>
            LoD: <strong>{activeSurveyLabel === '2MASS' ? '2MASS High-Res' : 'WISE Wide'}</strong>
          </span>
        </span>
        <button
          type="button"
          className="hud-btn-secondary"
          style={{ height: 24, padding: '0 8px', pointerEvents: 'auto', fontSize: 11 }}
          onClick={() => triggerTargetOrLivePatch(liveFrustum.ra, liveFrustum.dec)}
          data-testid="inspect-center-patch-btn"
        >
          <TargetReticleIcon size={12} />
          <span>Inspect Patch</span>
        </button>
      </div>
    </div>
  );
};
