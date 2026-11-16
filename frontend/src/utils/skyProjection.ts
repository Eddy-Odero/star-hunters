import { wrapRaDeg } from './observatoryMath';

const ALADIN_MODULE_URL = 'https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js';
const ALADIN_LOAD_TIMEOUT_MS = 12000;

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
