import { quantizeGridCenter, wrapRaDeg } from './observatoryMath.ts';

export const MIN_GLOBE_FOV_DEG = 0.25;
export const MAX_GLOBE_FOV_DEG = 160.0;
export const TWO_STAGE_CLICK_FOV_DEG = 15.0;
export const PANEL_GRID_FOV_DEG = 2.5;
export const PANEL_GRID_STEP_DEG = 0.05;

export type GlobeClickStageAction = 'zoom_medium' | 'zoom_panels' | 'open_panel';

/**
 * Progressive click behavior on the Night-Sky Globe:
 *  - Wide sky (> 15 deg FoV): click focuses & zooms to medium scale (8 deg FoV).
 *  - Medium zoom (2.5 to 15 deg FoV): click zooms to 1.6 deg FoV where 0.05 deg sky panels appear.
 *  - Panel view (<= 2.5 deg FoV): click selects and opens the clicked visible sky panel.
 */
export function resolveGlobeClickAction(fovDeg: number): GlobeClickStageAction {
  if (fovDeg > TWO_STAGE_CLICK_FOV_DEG) return 'zoom_medium';
  if (fovDeg > PANEL_GRID_FOV_DEG) return 'zoom_panels';
  return 'open_panel';
}

export function targetFovForClickAction(
  action: Exclude<GlobeClickStageAction, 'open_panel'>,
): number {
  return action === 'zoom_medium' ? 8.0 : 1.6;
}

export function clampGlobeFov(fovDeg: number): number {
  if (!Number.isFinite(fovDeg) || fovDeg <= 0) return 70.0;
  return Math.max(MIN_GLOBE_FOV_DEG, Math.min(MAX_GLOBE_FOV_DEG, fovDeg));
}

export function stepPanCoordinates(
  ra: number,
  dec: number,
  fovDeg: number,
  dir: 'north' | 'south' | 'east' | 'west',
): { ra: number; dec: number } {
  const stepDeg = Math.max(0.05, Math.min(24.0, fovDeg * 0.22));
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

export interface VisibleGridPanelCell {
  key: string;
  raQ: number;
  decQ: number;
}

/**
 * Enumerate quantized 0.05-deg sky panel centers around the camera frustum
 * when zoomed in to <= PANEL_GRID_FOV_DEG.
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
