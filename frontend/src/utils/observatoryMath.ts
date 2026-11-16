/**
 * Pure observatory geometry, viewport filtering, hygiene-flag decoding,
 * magnetic panel snapping, and 3-shape marker classification helpers.
 *
 * Kept React-free so `node --test` verifies every invariant directly.
 */

import type {
  GlobalKnownObjectEntry,
  KnownCelestialObject,
  SkyViewportFrustum,
} from '../types/contracts.ts';
import { isMovingSolarSystemObject } from './knownObjectSelection.ts';

export type MarkerShapeKind = 'triangle' | 'diamond' | 'square';

export interface DecodedHygieneBit {
  bit: number;
  code: string;
  label: string;
  detail: string;
  severity: 'critical' | 'warning';
}

export interface DecodedHygieneMask {
  flagByte: number;
  isFlagged: boolean;
  severity: 'nominal' | 'warning' | 'critical';
  bits: DecodedHygieneBit[];
  summary: string;
}

export type EdgeAnchor =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'free';

export interface PanelSnapResult {
  x: number;
  y: number;
  edgeAnchor: EdgeAnchor;
}

export type ParsedSkySearch =
  { kind: 'coords'; ra: number; dec: number } | { kind: 'text'; query: string } | { kind: 'empty' };

export const BENCHMARK_TARGET_OPTIONS: ReadonlyArray<{
  slug: string;
  label: string;
  subtitle: string;
  ra: number;
  dec: number;
}> = [
  {
    slug: 'wise_0855',
    label: 'WISE 0855',
    subtitle: 'Y4 Sub-Brown Dwarf (8.12″/yr)',
    ra: 133.7951,
    dec: -7.2451,
  },
  {
    slug: 'barnards_star',
    label: "Barnard's Star",
    subtitle: 'High-PM Red Dwarf (10.37″/yr)',
    ra: 269.4521,
    dec: 4.6934,
  },
  {
    slug: 'epsilon_indi_b',
    label: 'Epsilon Indi Ba/Bb',
    subtitle: 'Binary T-Dwarf Pair (4.70″/yr)',
    ra: 331.0438,
    dec: -56.7827,
  },
  {
    slug: 'rw_aurigae',
    label: 'RW Aurigae',
    subtitle: 'Variable T-Tauri System',
    ra: 76.9565,
    dec: 30.4014,
  },
  {
    slug: 'r_draconis',
    label: 'R Draconis',
    subtitle: 'Mira-Type IR Pulsator',
    ra: 248.1676,
    dec: 66.7548,
  },
  {
    slug: 'comet_3i_atlas',
    label: 'Comet 3I/ATLAS',
    subtitle: 'Interstellar Moving Comet',
    ra: 295.32,
    dec: -18.41,
  },
];

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export function wrapRaDeg(raDeg: number): number {
  const mod = raDeg % 360;
  return mod < 0 ? mod + 360 : mod;
}

export function angularSeparationDeg(
  ra1Deg: number,
  dec1Deg: number,
  ra2Deg: number,
  dec2Deg: number,
): number {
  const d1 = dec1Deg * DEG_TO_RAD;
  const d2 = dec2Deg * DEG_TO_RAD;
  const dRa = (ra2Deg - ra1Deg) * DEG_TO_RAD;
  const cosAngle = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(dRa);
  return Math.acos(Math.max(-1, Math.min(1, cosAngle))) * RAD_TO_DEG;
}

/**
 * Filter known objects against the active 3D night-sky globe frustum.
 * Wide hemispheres clamp cleanly to ~90° horizon radius so back-of-sphere
 * targets stay excluded while nearby targets in the viewport remain selectable.
 */
export function isObjectInSkyFrustum(
  ra: number,
  dec: number,
  frustum: SkyViewportFrustum,
): boolean {
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) return false;
  if (!Number.isFinite(frustum.ra) || !Number.isFinite(frustum.dec)) return false;
  const aspect = Math.max(0.6, Math.min(2.4, frustum.aspect ?? 1.4));
  const halfDiag = Math.max(0.1, frustum.fovDeg) * 0.5 * Math.hypot(1, 1 / aspect);
  const radiusDeg = Math.min(90, Math.max(0.25, halfDiag * 1.05));
  return angularSeparationDeg(ra, dec, frustum.ra, frustum.dec) <= radiusDeg;
}

/**
 * Filter active sky-patch objects against the zoomed/panned 256x256 viewBox.
 */
export function isObjectInPatchViewBox(
  x: number,
  y: number,
  viewBox: {
    minX: number;
    minY: number;
    viewWidth: number;
    viewHeight: number;
  },
  marginPx = 6,
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return (
    x >= viewBox.minX - marginPx &&
    x <= viewBox.minX + viewBox.viewWidth + marginPx &&
    y >= viewBox.minY - marginPx &&
    y <= viewBox.minY + viewBox.viewHeight + marginPx
  );
}

export function quantizeGridCenter(
  raDeg: number,
  decDeg: number,
  gridStepDeg = 0.05,
): { raQ: number; decQ: number } {
  const normRa = wrapRaDeg(raDeg);
  const clampedDec = Math.max(-90, Math.min(90, decDeg));
  const raQ = wrapRaDeg(Number((Math.round(normRa / gridStepDeg) * gridStepDeg).toFixed(2)));
  const decQ = Number((Math.round(clampedDec / gridStepDeg) * gridStepDeg).toFixed(2));
  return { raQ, decQ };
}

/**
 * Deferred stable partition: checked objects rise to the top of the list
 * while preserving the existing relative order within checked and unchecked groups.
 */
export function sortKnownObjectsCheckedFirst<T extends { object_id: string }>(
  objects: readonly T[],
  checkedIds: readonly string[],
): T[] {
  const checkedSet = new Set(checkedIds);
  const checked: T[] = [];
  const unchecked: T[] = [];
  for (const obj of objects) {
    if (checkedSet.has(obj.object_id)) {
      checked.push(obj);
    } else {
      unchecked.push(obj);
    }
  }
  return [...checked, ...unchecked];
}

const KNOWN_HYGIENE_BITS: ReadonlyArray<DecodedHygieneBit> = [
  {
    bit: 1,
    code: 'TRANSIENT / CR',
    label: 'Cosmic Ray / Transient',
    detail: 'High-energy particle hit or transient flux spike detected in ramp fit.',
    severity: 'critical',
  },
  {
    bit: 2,
    code: 'SATURATED',
    label: 'Detector Saturation',
    detail: 'Pixel reached non-linear well capacity; flux measurements compromised.',
    severity: 'critical',
  },
  {
    bit: 4,
    code: 'PERSISTENCE / BAD',
    label: 'Persistence / Bad Pixel',
    detail: 'Latent charge persistence or flagged hot/dead reference detector pixel.',
    severity: 'warning',
  },
  {
    bit: 8,
    code: 'STRAY LIGHT',
    label: 'Stray Light / Field Edge',
    detail: 'Elevated zodiacal/earthshine scattered background near detector boundary.',
    severity: 'warning',
  },
];

export function decodeHygieneFlagMask(flagByte: number): DecodedHygieneMask {
  const mask = Number.isFinite(flagByte) ? Math.max(0, Math.floor(flagByte)) & 0xff : 0;
  if (mask === 0) {
    return {
      flagByte: 0,
      isFlagged: false,
      severity: 'nominal',
      bits: [],
      summary: 'Clean science pixel',
    };
  }
  const bits: DecodedHygieneBit[] = [];
  for (const spec of KNOWN_HYGIENE_BITS) {
    if ((mask & spec.bit) !== 0) {
      bits.push(spec);
    }
  }
  for (let bit = 16; bit <= 128; bit <<= 1) {
    if ((mask & bit) !== 0) {
      bits.push({
        bit,
        code: `BIT ${bit}`,
        label: `Pipeline Mask Bit ${Math.log2(bit)}`,
        detail: `SPHEREx Level-2 quality mask flag (bitvalue ${bit}).`,
        severity: 'warning',
      });
    }
  }
  const severity = bits.some((b) => b.severity === 'critical') ? 'critical' : 'warning';
  return {
    flagByte: mask,
    isFlagged: true,
    severity,
    bits,
    summary: bits.map((b) => b.label).join(' · '),
  };
}

/**
 * Clamp a floating HUD panel within viewport safe margins and magnetically snap
 * to edges when dragged within `snapThreshold` pixels.
 */
export function computeMagneticSnap(
  rawPos: { x: number; y: number },
  panelSize: { width: number; height: number },
  viewportSize: { width: number; height: number },
  margin = 16,
  snapThreshold = 24,
): PanelSnapResult {
  const maxX = Math.max(margin, viewportSize.width - panelSize.width - margin);
  const maxY = Math.max(margin, viewportSize.height - panelSize.height - margin);

  let x = Math.max(margin, Math.min(maxX, rawPos.x));
  let y = Math.max(margin, Math.min(maxY, rawPos.y));

  let hEdge: 'left' | 'right' | null = null;
  let vEdge: 'top' | 'bottom' | null = null;

  if (Math.abs(x - margin) <= snapThreshold) {
    x = margin;
    hEdge = 'left';
  } else if (Math.abs(x - maxX) <= snapThreshold) {
    x = maxX;
    hEdge = 'right';
  }

  if (Math.abs(y - margin) <= snapThreshold) {
    y = margin;
    vEdge = 'top';
  } else if (Math.abs(y - maxY) <= snapThreshold) {
    y = maxY;
    vEdge = 'bottom';
  }

  let edgeAnchor: EdgeAnchor = 'free';
  if (vEdge && hEdge) {
    edgeAnchor = `${vEdge}-${hEdge}` as EdgeAnchor;
  } else if (vEdge) {
    edgeAnchor = vEdge;
  } else if (hEdge) {
    edgeAnchor = hEdge;
  }

  return { x: Math.round(x), y: Math.round(y), edgeAnchor };
}

export function resolvePositionFromAnchor(
  saved: { x: number; y: number; edgeAnchor?: EdgeAnchor },
  panelSize: { width: number; height: number },
  viewportSize: { width: number; height: number },
  margin = 16,
): PanelSnapResult {
  const maxX = Math.max(margin, viewportSize.width - panelSize.width - margin);
  const maxY = Math.max(margin, viewportSize.height - panelSize.height - margin);
  let { x, y } = saved;
  const anchor = saved.edgeAnchor ?? 'free';

  if (anchor.includes('left')) x = margin;
  if (anchor.includes('right')) x = maxX;
  if (anchor.includes('top')) y = margin;
  if (anchor.includes('bottom')) y = maxY;

  x = Math.max(margin, Math.min(maxX, x));
  y = Math.max(margin, Math.min(maxY, y));
  return { x: Math.round(x), y: Math.round(y), edgeAnchor: anchor };
}

/**
 * Parse search bar queries: supports decimal `RA, Dec` or `RA Dec`, HMS/DMS
 * sexagesimal pairs (`08:55:10.8 -07:14:42`), or catalog object name text.
 */
export function parseSkySearchInput(raw: string): ParsedSkySearch {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'empty' };

  const decimalMatch = trimmed.match(/^([+-]?\d+(?:\.\d+)?)\s*(?:,|\s+)\s*([+-]?\d+(?:\.\d+)?)$/);
  if (decimalMatch) {
    const ra = Number(decimalMatch[1]);
    const dec = Number(decimalMatch[2]);
    if (Number.isFinite(ra) && Number.isFinite(dec) && dec >= -90 && dec <= 90) {
      return { kind: 'coords', ra: wrapRaDeg(ra), dec };
    }
  }

  const sexaMatch = trimmed.match(
    /^(\d{1,2})[:h\s]+(\d{1,2})[:m\s]+(\d{1,2}(?:\.\d+)?)s?\s*(?:,|\s+)\s*([+-]?\d{1,2})[:d°\s]+(\d{1,2})[:m'\s]+(\d{1,2}(?:\.\d+)?)s?"?$/i,
  );
  if (sexaMatch) {
    const h = Number(sexaMatch[1]);
    const m = Number(sexaMatch[2]);
    const s = Number(sexaMatch[3]);
    const dStr = sexaMatch[4];
    const dSign = dStr.startsWith('-') ? -1 : 1;
    const deg = Math.abs(Number(dStr));
    const am = Number(sexaMatch[5]);
    const as = Number(sexaMatch[6]);
    const ra = wrapRaDeg((h + m / 60 + s / 3600) * 15);
    const dec = dSign * (deg + am / 60 + as / 3600);
    if (h >= 0 && h < 24 && dec >= -90 && dec <= 90) {
      return { kind: 'coords', ra, dec };
    }
  }

  return { kind: 'text', query: trimmed };
}

/**
 * Compute gnomonic TAN sky polygon corners for a SPHEREx 5'x5' cell centered at (raDeg, decDeg).
 */
export function computeSpherExReticleCorners(
  raDeg: number,
  decDeg: number,
  fovArcmin = 5.0,
): [number, number][] {
  const halfRad = (fovArcmin / 60) * 0.5 * DEG_TO_RAD;
  const ra0 = raDeg * DEG_TO_RAD;
  const dec0 = decDeg * DEG_TO_RAD;
  const sinD0 = Math.sin(dec0);
  const cosD0 = Math.cos(dec0);
  const signs: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  return signs.map(([sx, sy]) => {
    const xi = sx * halfRad;
    const eta = sy * halfRad;
    const denom = Math.max(1e-8, cosD0 - eta * sinD0);
    const raCorner = wrapRaDeg((ra0 + Math.atan2(xi, denom)) * RAD_TO_DEG);
    const rho = Math.hypot(xi, denom);
    const decCorner = Math.atan2(sinD0 + eta * cosD0, rho) * RAD_TO_DEG;
    return [raCorner, Math.max(-89.999, Math.min(89.999, decCorner))];
  });
}

/**
 * Strictly enforce the 3-shape zero-occlusion marker vocabulary:
 *   - 'square'   -> actively tracked target
 *   - 'diamond'  -> known moving Solar System body
 *   - 'triangle' -> known catalog star / brown dwarf / nebula / galaxy
 */
export function getMarkerShapeKind(
  obj: Pick<
    KnownCelestialObject | GlobalKnownObjectEntry,
    'object_class' | 'object_type' | 'label' | 'motion_vector' | 'epoch_positions'
  >,
  isTracked: boolean,
): MarkerShapeKind {
  if (isTracked) return 'square';
  return isMovingSolarSystemObject(obj as KnownCelestialObject) ? 'diamond' : 'triangle';
}

export function formatRaDecCompact(ra: number, dec: number): string {
  const sign = dec >= 0 ? '+' : '';
  return `Right Ascension ${ra.toFixed(4)}°, Declination ${sign}${dec.toFixed(4)}°`;
}
