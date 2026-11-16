/**
 * 3D Night-Sky Globe navigation, HiPS Level-of-Detail resilience hierarchy,
 * progressive click-to-zoom actions, and 0.05-degree visible sky-panel grid helpers.
 *
 * Kept React-free so Node 24's `node --test` executes this module directly.
 */

import { wrapRaDeg } from './observatoryMath.ts';
import { quantizeGridCenter } from './wcsViewport.ts';

/** Minimum interactive Aladin/fallback globe field-of-view in degrees. */
export const MIN_GLOBE_FOV_DEG = 0.25;

/** Maximum wide-field globe field-of-view in degrees. */
export const MAX_GLOBE_FOV_DEG = 160.0;

/** FoV threshold above which a globe click zooms to medium scale (`8°`). */
export const TWO_STAGE_CLICK_FOV_DEG = 15.0;

/** FoV threshold at or below which quantized `0.05°` sky panels become interactive. */
export const PANEL_GRID_FOV_DEG = 2.5;

/** Angular spacing (degrees) between quantized sky-panel grid centers. */
export const PANEL_GRID_STEP_DEG = 0.05;

/** Supported Aladin Lite spherical map projections. */
export type GlobeProjection = 'SIN' | 'AIT' | 'MOL' | 'STG' | 'ZEA';

/** Projection options rendered in the globe controls dock. */
export const SUPPORTED_GLOBE_PROJECTIONS: ReadonlyArray<{
  id: GlobeProjection;
  label: string;
}> = [
  { id: 'SIN', label: 'SIN (Orthographic)' },
  { id: 'AIT', label: 'AIT (Aitoff)' },
  { id: 'MOL', label: 'MOL (Mollweide)' },
  { id: 'STG', label: 'STG (Stereographic)' },
  { id: 'ZEA', label: 'ZEA (Equal-Area)' },
];

/** Progressive HiPS survey Level-of-Detail tier selected by globe FoV. */
export type GlobeLodTier = 'allwise' | '2mass' | 'spherex_deep';

/** IRSA AllWISE wide-field infrared HiPS endpoint. */
export const IRSA_WISE_HIPS_URL =
  'https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/RGB-W4-W2-W1';

/** IRSA 2MASS high-resolution near-infrared HiPS endpoint. */
export const IRSA_2MASS_HIPS_URL = 'https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color';

/** Primary CDS SPHEREx QR2 color HiPS endpoint. */
export const CDS_SPHEREX_COLOR_HIPS_URL = 'https://alasky.cds.unistra.fr/SPHEREx/color';

/** Mirror CDS SPHEREx QR2 color HiPS endpoint. */
export const CDS_MIRROR_SPHEREX_COLOR_HIPS_URL = 'https://alaskybis.cds.unistra.fr/SPHEREx/color';

/** IRSA SPHEREx all-sky cube HiPS endpoint. */
export const IRSA_SPHEREX_CUBE_HIPS_URL =
  'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';

/**
 * Select the HiPS Level-of-Detail survey tier appropriate for the active FoV.
 *
 * @param fovDeg - Active globe field-of-view in degrees.
 * @returns Selected {@link GlobeLodTier}.
 */
export function resolveGlobeLodTier(fovDeg: number): GlobeLodTier {
  if (fovDeg > 12.0) return 'allwise';
  if (fovDeg > 5.0) return '2mass';
  return 'spherex_deep';
}

/** Resolved deep-sky HiPS endpoint and provenance label. */
export interface DeepHiPSResolution {
  url: string;
  label: string;
  source: 'cds_qr2' | 'cds_qr2_mirror' | 'irsa_spherex_cube' | 'irsa_2mass_fallback';
}

/**
 * Probe SPHEREx HiPS endpoints along the canonical resilience hierarchy
 * (CDS QR2 primary -> CDS QR2 mirror -> IRSA SPHEREx DR1 cube) and fall back
 * gracefully to 2MASS High-Res so deep zoom never turns black during outages.
 *
 * @param probeFn - Optional URL reachability probe injected by unit tests.
 * @returns Resolved {@link DeepHiPSResolution} endpoint metadata.
 */
export async function resolveBestDeepSkyHiPS(
  probeFn?: (url: string) => Promise<boolean>,
): Promise<DeepHiPSResolution> {
  const defaultProbe = async (url: string): Promise<boolean> => {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
      clearTimeout(tid);
      return res.ok;
    } catch {
      return false;
    }
  };
  const check = probeFn ?? defaultProbe;

  if (
    (await check(`${CDS_SPHEREX_COLOR_HIPS_URL}/properties`)) &&
    (await check(`${CDS_SPHEREX_COLOR_HIPS_URL}/Norder3/Allsky.png`))
  ) {
    return {
      url: CDS_SPHEREX_COLOR_HIPS_URL,
      label: 'SPHEREx QR2 Color (CDS)',
      source: 'cds_qr2',
    };
  }

  if (
    (await check(`${CDS_MIRROR_SPHEREX_COLOR_HIPS_URL}/properties`)) &&
    (await check(`${CDS_MIRROR_SPHEREX_COLOR_HIPS_URL}/Norder3/Allsky.png`))
  ) {
    return {
      url: CDS_MIRROR_SPHEREX_COLOR_HIPS_URL,
      label: 'SPHEREx QR2 Color (Mirror)',
      source: 'cds_qr2_mirror',
    };
  }

  // Note: IRSA spherex_allsky_cube serves Norder3+ PNGs without Allsky.png; verify a real
  // Norder3 cube tile exists and is renderable, else keep 2MASS High-Res as clean visual base.
  if (await check(`${IRSA_SPHEREX_CUBE_HIPS_URL}/Norder3/Dir0/Npix100/Npix100_1.png`)) {
    // Only use cube directly if overview Allsky exists so Aladin HiPS never stays blank.
    if (await check(`${IRSA_SPHEREX_CUBE_HIPS_URL}/Norder0/Allsky.png`)) {
      return {
        url: IRSA_SPHEREX_CUBE_HIPS_URL,
        label: 'SPHEREx All-Sky (IRSA)',
        source: 'irsa_spherex_cube',
      };
    }
  }

  return {
    url: IRSA_2MASS_HIPS_URL,
    label: '2MASS High-Res (IRSA)',
    source: 'irsa_2mass_fallback',
  };
}

/** Progressive globe click stage determined by the active FoV. */
export type GlobeClickStageAction = 'zoom_medium' | 'zoom_panels' | 'open_panel';

/**
 * Progressive click behavior on the Night-Sky Globe:
 *  - Wide sky (> 15 deg FoV): click focuses & zooms to medium scale (8 deg FoV).
 *  - Medium zoom (2.5 to 15 deg FoV): click zooms to 1.6 deg FoV where 0.05 deg sky panels appear.
 *  - Panel view (<= 2.5 deg FoV): click selects and opens the clicked visible sky panel.
 *
 * @param fovDeg - Active globe field-of-view in degrees.
 * @returns Click action stage for the current zoom level.
 */
export function resolveGlobeClickAction(fovDeg: number): GlobeClickStageAction {
  if (fovDeg > TWO_STAGE_CLICK_FOV_DEG) return 'zoom_medium';
  if (fovDeg > PANEL_GRID_FOV_DEG) return 'zoom_panels';
  return 'open_panel';
}

/**
 * Return the target FoV in degrees for a progressive zoom click stage.
 *
 * @param action - Zoom action (`'zoom_medium'` or `'zoom_panels'`).
 * @returns Target FoV in degrees (`8.0` or `1.6`).
 */
export function targetFovForClickAction(
  action: Exclude<GlobeClickStageAction, 'open_panel'>,
): number {
  return action === 'zoom_medium' ? 8.0 : 1.6;
}

/**
 * Clamp a requested globe field-of-view to `[MIN_GLOBE_FOV_DEG, MAX_GLOBE_FOV_DEG]`,
 * defaulting to `70°` for non-finite or non-positive inputs.
 *
 * @param fovDeg - Requested FoV in degrees.
 * @returns Clamped FoV in degrees.
 */
export function clampGlobeFov(fovDeg: number): number {
  if (!Number.isFinite(fovDeg) || fovDeg <= 0) return 70.0;
  return Math.max(MIN_GLOBE_FOV_DEG, Math.min(MAX_GLOBE_FOV_DEG, fovDeg));
}

/**
 * Step the globe camera coordinates by one cardinal pan increment scaled to `fovDeg`.
 *
 * @param ra - Current Right Ascension in degrees.
 * @param dec - Current Declination in degrees.
 * @param fovDeg - Active FoV in degrees.
 * @param dir - Cardinal pan direction (`'north' | 'south' | 'east' | 'west'`).
 * @param stepScale - Optional step multiplier (e.g. `0.35` for Shift fine panning).
 * @returns Wrapped and clamped `{ ra, dec }` coordinates.
 */
export function stepPanCoordinates(
  ra: number,
  dec: number,
  fovDeg: number,
  dir: 'north' | 'south' | 'east' | 'west',
  stepScale: number = 1.0,
): { ra: number; dec: number } {
  const stepDeg = Math.max(0.05, Math.min(24.0, fovDeg * 0.22)) * stepScale;
  const cosDec = Math.max(0.2, Math.cos((dec * Math.PI) / 180));
  if (dir === 'north') {
    return { ra, dec: Math.max(-89.9, Math.min(89.9, dec + stepDeg)) };
  }
  if (dir === 'south') {
    return { ra, dec: Math.max(-89.9, Math.min(89.9, dec - stepDeg)) };
  }
  if (dir === 'east') {
    return { ra: wrapRaDeg(ra + stepDeg / cosDec), dec };
  }
  return { ra: wrapRaDeg(ra - stepDeg / cosDec), dec };
}

/** Keyboard action resolved for the focused Night-Sky Globe viewport. */
export type GlobeKeyboardAction =
  | { type: 'pan'; dir: 'north' | 'south' | 'east' | 'west'; fine: boolean }
  | { type: 'zoom'; factor: number | 'reset' };

/**
 * Resolve a keyboard event into a globe pan/zoom/reset action under North-up
 * celestial orientation (screen-left = East/+RA, screen-right = West/-RA).
 *
 * @param input - Keyboard event key and modifier flags.
 * @returns Resolved {@link GlobeKeyboardAction}, or `null` for unbound/modified keys.
 */
export function resolveGlobeKeyboardAction(input: {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): GlobeKeyboardAction | null {
  if (input.ctrlKey || input.metaKey || input.altKey) return null;
  const fine = Boolean(input.shiftKey);
  switch (input.key) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      return { type: 'pan', dir: 'north', fine };
    case 'ArrowDown':
    case 's':
    case 'S':
      return { type: 'pan', dir: 'south', fine };
    case 'ArrowLeft':
    case 'a':
    case 'A':
      return { type: 'pan', dir: 'east', fine };
    case 'ArrowRight':
    case 'd':
    case 'D':
      return { type: 'pan', dir: 'west', fine };
    case '+':
    case '=':
      return { type: 'zoom', factor: 0.72 };
    case '-':
    case '_':
      return { type: 'zoom', factor: 1.38 };
    case '0':
      return { type: 'zoom', factor: 'reset' };
    default:
      return null;
  }
}

/** Quantized `0.05°` sky-panel grid cell center around the globe camera. */
export interface VisibleGridPanelCell {
  key: string;
  raQ: number;
  decQ: number;
}

/**
 * Enumerate quantized 0.05-deg sky panel centers around the camera frustum
 * when zoomed in to `<= PANEL_GRID_FOV_DEG`.
 *
 * @param centerRa - Camera Right Ascension in degrees.
 * @param centerDec - Camera Declination in degrees.
 * @param fovDeg - Active FoV in degrees.
 * @param stepDeg - Grid quantization step in degrees (defaults to `0.05`).
 * @param maxRadiusSteps - Maximum step radius in either axis (defaults to `6`).
 * @returns Array of {@link VisibleGridPanelCell} entries (empty when zoomed out).
 */
export function buildVisibleSkyPanels(
  centerRa: number,
  centerDec: number,
  fovDeg: number,
  stepDeg: number = PANEL_GRID_STEP_DEG,
  maxRadiusSteps: number = 6,
): VisibleGridPanelCell[] {
  if (fovDeg > PANEL_GRID_FOV_DEG) return [];
  const { raQ: baseRa, decQ: baseDec } = quantizeGridCenter(centerRa, centerDec, stepDeg);
  const cosDec = Math.max(0.25, Math.cos((centerDec * Math.PI) / 180));
  const halfSpanDecSteps = Math.min(
    maxRadiusSteps,
    Math.max(1, Math.ceil((fovDeg * 0.6) / stepDeg)),
  );
  const halfSpanRaSteps = Math.min(
    maxRadiusSteps + 1,
    Math.max(1, Math.ceil((fovDeg * 0.85) / (stepDeg * cosDec))),
  );

  const cells: VisibleGridPanelCell[] = [];
  for (let dStep = -halfSpanDecSteps; dStep <= halfSpanDecSteps; dStep += 1) {
    const decCand = Number((baseDec + dStep * stepDeg).toFixed(4));
    if (decCand < -89.95 || decCand > 89.95) continue;
    for (let rStep = -halfSpanRaSteps; rStep <= halfSpanRaSteps; rStep += 1) {
      const raCand = wrapRaDeg(Number((baseRa + rStep * stepDeg).toFixed(4)));
      const q = quantizeGridCenter(raCand, decCand, stepDeg);
      cells.push({
        key: `${q.raQ.toFixed(2)}_${q.decQ.toFixed(2)}`,
        raQ: q.raQ,
        decQ: q.decQ,
      });
    }
  }
  return cells;
}
