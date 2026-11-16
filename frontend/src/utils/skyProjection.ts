import { wrapRaDeg } from './observatoryMath.ts';

const ALADIN_MODULE_URL = 'https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js';
const ALADIN_LOAD_TIMEOUT_MS = 12000;

export interface AladinViewHandle {
  redrawClbk?: (timestamp?: number) => void;
  moving?: boolean;
  needRedraw?: boolean;
  wasm?: {
    isRendering?(): boolean;
    isInerting?(): boolean;
  };
}

export interface AladinInstance {
  gotoRaDec(ra: number, dec: number): void;
  setFoV?(fovDeg: number): void;
  setProjection?(projection: string): void;
  getRaDec?(): [number, number];
  getFoV?(): [number, number] | number;
  setImageSurvey?(surveyId: string): void;
  pix2world?(x: number, y: number): [number, number] | null;
  world2pix?(ra: number, dec: number): [number, number] | null;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  view?: AladinViewHandle;
}

export interface AladinIdleThrottler {
  /** Mark the globe active and immediately resume 60 FPS rendering if throttled. */
  wake: () => void;
  /** Pause (0 FPS) when obscured by a modal or hidden tab; resume when unpaused. */
  setPaused: (paused: boolean) => void;
  /** Permanently halt Aladin's internal requestAnimationFrame loop on unmount. */
  destroy: () => void;
}

export interface AladinThrottlerOptions {
  /** Low-power keepalive interval (ms) once Aladin reports idle & tiles finished. */
  idleIntervalMs?: number;
  /** Number of consecutive quiet frames before dropping from 60 FPS to idle. */
  quietFramesBeforeIdle?: number;
  scheduleFrame?: (cb: (timestamp?: number) => void) => void;
  scheduleTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancelTimer?: (id: ReturnType<typeof setTimeout>) => void;
  now?: () => number;
}

/**
 * Wrap Aladin Lite v3's unconditional 60 FPS `view.redrawClbk` loop with an
 * event- and render-state-driven throttler and clean unmount teardown.
 *
 * Keeps native 60 FPS whenever the user interacts or Aladin's WASM engine reports
 * active camera motion, inertia, overlay redraws, or HiPS tile rendering
 * (`view.wasm.isRendering()`). Drops immediately to a lightweight keepalive once
 * Aladin reports quiet frames (all HiPS tiles finished streaming), pauses to 0 FPS
 * while the Blinker modal is open or the tab is hidden, and halts cleanly on unmount.
 */
export function attachAladinIdleThrottler(
  instance: AladinInstance,
  options: AladinThrottlerOptions = {},
): AladinIdleThrottler {
  const view = instance.view;
  if (!view || typeof view.redrawClbk !== 'function') {
    return {
      wake: () => {},
      setPaused: () => {},
      destroy: () => {},
    };
  }

  const idleIntervalMs = options.idleIntervalMs ?? 500;
  const quietFramesBeforeIdle = options.quietFramesBeforeIdle ?? 2;
  const getNow =
    options.now ??
    (() =>
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now());
  const scheduleFrame =
    options.scheduleFrame ??
    ((cb: (timestamp?: number) => void) => {
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(cb);
      } else {
        setTimeout(() => cb(getNow()), 16);
      }
    });
  const scheduleTimer =
    options.scheduleTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const cancelTimer =
    options.cancelTimer ?? ((id: ReturnType<typeof setTimeout>) => clearTimeout(id));

  const origRedraw = view.redrawClbk;
  let stopped = false;
  let paused = false;
  let waitingResume = false;
  let loopBroken = false;
  let woke = true;
  let quietFrames = 0;
  let idleTimerId: ReturnType<typeof setTimeout> | null = null;

  const isViewBusy = (): boolean =>
    Boolean(
      view.moving || view.needRedraw || view.wasm?.isRendering?.() || view.wasm?.isInerting?.(),
    );

  const resolveTimestamp = (timestamp?: number): number =>
    typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : getNow();

  const invokeOrigRedraw = (timestamp?: number) => {
    try {
      origRedraw(resolveTimestamp(timestamp));
      loopBroken = false;
    } catch {
      loopBroken = true;
      if (!stopped && !paused && idleTimerId === null) {
        idleTimerId = scheduleTimer(() => {
          idleTimerId = null;
          if (stopped) return;
          if (paused) {
            waitingResume = true;
            return;
          }
          scheduleFrame(throttledRedraw);
        }, idleIntervalMs);
      }
    }
  };

  const throttledRedraw = (timestamp?: number) => {
    if (stopped) return;
    if (paused) {
      waitingResume = true;
      return;
    }

    if (woke || isViewBusy()) {
      woke = false;
      quietFrames = 0;
      invokeOrigRedraw(timestamp);
      return;
    }

    quietFrames += 1;
    if (quietFrames < quietFramesBeforeIdle) {
      invokeOrigRedraw(timestamp);
      return;
    }

    if (idleTimerId === null) {
      idleTimerId = scheduleTimer(() => {
        idleTimerId = null;
        if (stopped) return;
        if (paused) {
          waitingResume = true;
          return;
        }
        invokeOrigRedraw();
        if (isViewBusy()) {
          quietFrames = 0;
        }
      }, idleIntervalMs);
    }
  };

  view.redrawClbk = throttledRedraw;

  return {
    wake() {
      if (stopped) return;
      woke = true;
      quietFrames = 0;
      if (paused) return;
      if (idleTimerId !== null) {
        cancelTimer(idleTimerId);
        idleTimerId = null;
        scheduleFrame(throttledRedraw);
      } else if (waitingResume || loopBroken) {
        waitingResume = false;
        loopBroken = false;
        scheduleFrame(throttledRedraw);
      }
    },
    setPaused(nextPaused: boolean) {
      if (stopped || paused === nextPaused) return;
      paused = nextPaused;
      if (paused) {
        if (idleTimerId !== null) {
          cancelTimer(idleTimerId);
          idleTimerId = null;
          waitingResume = true;
        }
      } else {
        woke = true;
        quietFrames = 0;
        if (waitingResume || loopBroken) {
          waitingResume = false;
          loopBroken = false;
          scheduleFrame(throttledRedraw);
        }
      }
    },
    destroy() {
      stopped = true;
      if (idleTimerId !== null) {
        cancelTimer(idleTimerId);
        idleTimerId = null;
      }
      view.redrawClbk = () => {};
    },
  };
}

export interface AladinApi {
  init?: Promise<unknown>;
  aladin(target: HTMLElement | string, options: Record<string, unknown>): AladinInstance;
}

declare global {
  interface Window {
    A?: AladinApi;
  }
}

let aladinLoaderPromise: Promise<AladinApi> | null = null;

export function loadAladinLite(): Promise<AladinApi> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('Aladin Lite requires a browser runtime'));
  }
  if (window.A && typeof window.A.aladin === 'function') {
    return Promise.resolve(window.A.init).then(() => window.A as AladinApi);
  }
  if (aladinLoaderPromise) return aladinLoaderPromise;

  const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> =>
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

export interface BackgroundStar {
  ra: number;
  dec: number;
  size: number;
  alpha: number;
  tint: string;
}

/** Deterministic background star field (~420 stars) for the 3D canvas fallback sphere. */
export const BACKGROUND_STARS: ReadonlyArray<BackgroundStar> = Array.from(
  { length: 420 },
  (_, i) => {
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
  },
);

/**
 * Project sky (ra, dec) onto the 3D celestial sphere looking outward (SIN orthographic).
 * East increases left as viewed from inside the Earth celestial sphere.
 */
export function projectSkySin(
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

  const xi = -Math.cos(d) * Math.sin(a - a0);
  const eta = Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0);

  const halfFovRad = Math.min(Math.PI / 2, fovDeg * 0.5 * d2r);
  const scale = width / (2 * Math.max(1e-4, Math.sin(halfFovRad)));

  return {
    px: width * 0.5 + xi * scale,
    py: height * 0.5 - eta * scale,
    visible: true,
  };
}

/** Inverse-project screen pixels back to celestial (RA, Dec) in SIN projection. */
export function unprojectSkySin(
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
