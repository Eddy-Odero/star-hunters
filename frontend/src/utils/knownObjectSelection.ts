/**
 * Pure helpers for the Viewport Controls Bar and Known Celestial Objects menu (ISS-16).
 *
 * Kept free of React so the selection, formatting and wavelength-preset logic can be unit
 * tested with `node --test` and reused identically by the UI and SkyExplorerContext.
 */

import type {
  CatalogSourceType,
  CelestialObjectClass,
  GlobalKnownObjectEntry,
  KnownCelestialObject,
} from '../types/contracts.ts';

export interface WavelengthPreset {
  id: string;
  label: string;
  range: [number, number];
}

export const WAVELENGTH_PRESETS: ReadonlyArray<WavelengthPreset> = [
  { id: 'all', label: 'All Bands (0.75–5.0 µm)', range: [0.75, 5.0] },
  { id: 'cold', label: 'Cold Objects / Planet X (3.8–5.0 µm)', range: [3.8, 5.0] },
  { id: 'molecules', label: 'H₂O / CH₄ Band (2.4–3.8 µm)', range: [2.4, 3.8] },
  { id: 'hot', label: 'Hot Stars (0.75–2.4 µm)', range: [0.75, 2.4] },
];

const PRESET_MATCH_TOLERANCE_UM = 0.05;

export function isWavelengthPresetActive(
  current: readonly [number, number],
  range: readonly [number, number],
): boolean {
  return (
    Math.abs(current[0] - range[0]) < PRESET_MATCH_TOLERANCE_UM &&
    Math.abs(current[1] - range[1]) < PRESET_MATCH_TOLERANCE_UM
  );
}

const CATALOG_BADGE_LABELS: Record<CatalogSourceType, string> = {
  gaia_dr3: 'Gaia DR3',
  wise: 'WISE',
  most: 'MOST',
  simbad: 'SIMBAD',
  jpl_horizons: 'JPL Horizons',
};

export function catalogBadgeLabel(catalog: CatalogSourceType): string {
  return CATALOG_BADGE_LABELS[catalog] ?? catalog;
}

const OBJECT_CLASS_LABELS: Record<CelestialObjectClass, string> = {
  star: 'Star',
  brown_dwarf: 'Brown Dwarf',
  planet: 'Planet',
  moon: 'Moon',
  comet: 'Comet',
  asteroid: 'Asteroid',
  galaxy: 'Galaxy',
  nebula: 'Nebula',
  variable_star: 'Variable Star',
  infrared_source: 'IR Source',
};

export function inferObjectClass(
  obj: Pick<KnownCelestialObject, 'object_class' | 'object_type' | 'label'>,
): CelestialObjectClass {
  if (obj.object_class) {
    return obj.object_class;
  }
  const low = obj.label.toLowerCase();
  if (obj.object_type === 'brown_dwarf_candidate') return 'brown_dwarf';
  if (obj.object_type === 'solar_system') {
    if (low.includes('comet') || low.includes('3i') || low.includes('atlas')) return 'comet';
    if (low.includes('ceres') || low.includes('vesta') || low.includes('apophis'))
      return 'asteroid';
    if (
      low.includes('io') ||
      low.includes('europa') ||
      low.includes('ganymede') ||
      low.includes('callisto') ||
      low.includes('titan')
    ) {
      return 'moon';
    }
    return 'planet';
  }
  if (obj.object_type === 'variable_star') return 'variable_star';
  if (obj.object_type === 'infrared_source') return 'infrared_source';
  return 'star';
}

export function objectClassBadgeLabel(objClass: CelestialObjectClass): string {
  return OBJECT_CLASS_LABELS[objClass] ?? objClass;
}

export function isMovingSolarSystemObject(obj: KnownCelestialObject): boolean {
  const cls = inferObjectClass(obj);
  if (cls === 'planet' || cls === 'moon' || cls === 'comet' || cls === 'asteroid') {
    return true;
  }
  if (obj.object_type === 'solar_system') {
    return true;
  }
  if (obj.motion_vector) {
    const pxDisp = Math.hypot(obj.motion_vector.dx_px, obj.motion_vector.dy_px);
    if (pxDisp >= 0.5) return true;
  }
  if (obj.epoch_positions.length >= 2) {
    const first = obj.epoch_positions[0];
    const last = obj.epoch_positions[obj.epoch_positions.length - 1];
    if (Math.hypot(last.x - first.x, last.y - first.y) >= 0.5) {
      return true;
    }
  }
  return false;
}

export function formatMagnitude(magnitude: number | null): string {
  return magnitude === null || !Number.isFinite(magnitude)
    ? 'mag n/a'
    : `mag ${magnitude.toFixed(1)}`;
}

/** Proper motion in arcsec/yr; small values keep 3 decimals so Gaia field stars stay readable. */
export function formatProperMotion(arcsecPerYr: number | null): string {
  if (arcsecPerYr === null || !Number.isFinite(arcsecPerYr)) return 'μ n/a';
  return `μ ${arcsecPerYr.toFixed(arcsecPerYr < 1 ? 3 : 2)}″/yr`;
}

export function selectAllObjectIds(knownObjects: ReadonlyArray<{ object_id: string }>): string[] {
  return knownObjects.map((obj) => obj.object_id);
}

export function clearCheckedObjectIds(): string[] {
  return [];
}

export function toggleObjectId(checkedIds: readonly string[], objectId: string): string[] {
  return checkedIds.includes(objectId)
    ? checkedIds.filter((id) => id !== objectId)
    : [...checkedIds, objectId];
}

/**
 * Compute a normalized [0.0, 1.0] fuzzy match score between a user query and a candidate string.
 * Supports exact/prefix/substring match, multi-word token prefix match, ordered subsequence
 * ("w0855" -> "WISE 0855-0714"), and bounded Levenshtein edit distance ("barnrd" -> "Barnard's Star").
 */
export function fuzzyScoreText(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1.0;
  const c = candidate.trim().toLowerCase();
  if (!c) return 0.0;
  if (q === c) return 1.0;
  if (c.startsWith(q)) return 0.96;
  const subIdx = c.indexOf(q);
  if (subIdx >= 0) {
    return 0.9 - Math.min(0.12, (subIdx / Math.max(1, c.length)) * 0.12);
  }

  const qTokens = q.replace(/[-_']/g, ' ').split(/\s+/).filter(Boolean);
  const cTokens = c.replace(/[-_']/g, ' ').split(/\s+/).filter(Boolean);
  if (
    qTokens.length > 0 &&
    qTokens.every((qt) => cTokens.some((ct) => ct.startsWith(qt) || ct.includes(qt)))
  ) {
    return 0.84;
  }

  // Ordered subsequence match
  let qIdx = 0;
  let gaps = 0;
  let lastMatch = -1;
  for (let i = 0; i < c.length && qIdx < q.length; i += 1) {
    if (c[i] === q[qIdx]) {
      if (lastMatch >= 0) {
        gaps += i - lastMatch - 1;
      }
      lastMatch = i;
      qIdx += 1;
    }
  }
  if (qIdx === q.length && q.length >= 3) {
    return Math.max(0.52, 0.78 - Math.min(0.24, gaps * 0.02));
  }

  // Bounded Levenshtein edit distance against candidate tokens for typo tolerance
  let bestTokenScore = 0.0;
  for (const ct of cTokens) {
    if (Math.abs(ct.length - q.length) > 3) continue;
    let prev = Array.from({ length: ct.length + 1 }, (_, idx) => idx);
    for (let i = 1; i <= q.length; i += 1) {
      const curr = [i];
      for (let j = 1; j <= ct.length; j += 1) {
        const cost = q[i - 1] === ct[j - 1] ? 0 : 1;
        curr.push(Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost));
      }
      prev = curr;
    }
    const dist = prev[ct.length];
    const maxLen = Math.max(q.length, ct.length, 1);
    const sim = 1.0 - dist / maxLen;
    if (sim >= 0.65) {
      bestTokenScore = Math.max(bestTokenScore, sim * 0.74);
    }
  }
  return bestTokenScore;
}

/**
 * Filter and rank KnownCelestialObject / GlobalKnownObjectEntry items using fuzzy search.
 */
export function fuzzySearchKnownObjects<T extends KnownCelestialObject | GlobalKnownObjectEntry>(
  objects: readonly T[],
  query: string,
): T[] {
  const clean = query.trim();
  if (!clean) {
    return [...objects];
  }
  const scored: { item: T; score: number }[] = [];
  for (const obj of objects) {
    const entry = obj as GlobalKnownObjectEntry;
    const fields = [
      obj.label,
      obj.canonical_name ?? '',
      obj.otype ?? '',
      obj.object_class ?? '',
      obj.object_id,
      obj.catalog,
      obj.object_type.replace(/_/g, ' '),
      entry.target_name ?? '',
      entry.target_slug ?? '',
      entry.constellation ?? '',
    ];
    let best = 0;
    for (const f of fields) {
      if (!f) continue;
      const s = fuzzyScoreText(clean, f);
      if (s > best) best = s;
    }
    if (best >= 0.45) {
      scored.push({ item: obj, score: best });
    }
  }
  scored.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 1e-4) return b.score - a.score;
    const aPrim = a.item.default_checked ? 1 : 0;
    const bPrim = b.item.default_checked ? 1 : 0;
    if (bPrim !== aPrim) return bPrim - aPrim;
    return (a.item.magnitude ?? 20) - (b.item.magnitude ?? 20);
  });
  return scored.map((s) => s.item);
}

// ---------------------------------------------------------------------------
// Pixel rendering lives in the dedicated 60 FPS engine (ISS-11). Re-exported
// here for backwards compatibility with existing viewport imports.
// ---------------------------------------------------------------------------
export {
  applyContrastStretch,
  renderEpochBuffersToImageData,
  renderEpochBuffersToRgba,
  renderPixelFrame,
} from './pixelEngine.ts';
export type { PixelEngineRenderParams } from './pixelEngine.ts';
