/**
 * Pure helpers for the Viewport Controls Bar and Known Celestial Objects menu (ISS-16).
 *
 * Kept free of React so the selection, formatting and wavelength-preset logic can be unit
 * tested with `node --test` and reused identically by the UI and SkyExplorerContext.
 */

import type { CatalogSourceType } from '../types/contracts.ts';

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
};

export function catalogBadgeLabel(catalog: CatalogSourceType): string {
  return CATALOG_BADGE_LABELS[catalog] ?? catalog;
}

export function formatMagnitude(magnitude: number | null): string {
  return magnitude === null || !Number.isFinite(magnitude)
    ? 'mag —'
    : `mag ${magnitude.toFixed(1)}`;
}

/** Proper motion in arcsec/yr; small values keep 3 decimals so Gaia field stars stay readable. */
export function formatProperMotion(arcsecPerYr: number | null): string {
  if (arcsecPerYr === null || !Number.isFinite(arcsecPerYr)) return 'μ —';
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
