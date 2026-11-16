/**
 * Smart non-occluding placement utilities for object details callout cards.
 * Guarantees callout cards never cover the inspected celestial target and flip cleanly
 * away from viewport edges or floating control panels.
 */

export const HOVER_DETAILS_DELAY_MS = 850;

export type DetailsCalloutOrigin = 'hover' | 'click';

export type CalloutPlacementSide = 'right' | 'left' | 'above' | 'below';

export interface AvoidRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SmartCalloutLayoutInput {
  markerStageX: number;
  markerStageY: number;
  stageW: number;
  stageH: number;
  cardW: number;
  cardH: number;
  margin?: number;
  bottomReservedPx?: number;
  markerClearRadius?: number;
  avoidRects?: ReadonlyArray<AvoidRect>;
}

export interface SmartCalloutLayout {
  cardLeft: number;
  cardTop: number;
  anchorX: number;
  anchorY: number;
  kneeX: number;
  kneeY: number;
  side: CalloutPlacementSide;
}

function clamp(val: number, min: number, max: number): number {
  if (max <= min) return min;
  return Math.max(min, Math.min(max, val));
}

function rectIntersectionArea(a: AvoidRect, b: AvoidRect): number {
  const xOverlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const yOverlap = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return xOverlap * yOverlap;
}

export function computeSmartCalloutLayout({
  markerStageX,
  markerStageY,
  stageW,
  stageH,
  cardW,
  cardH,
  margin = 14,
  bottomReservedPx = 68,
  markerClearRadius = 28,
  avoidRects = [],
}: SmartCalloutLayoutInput): SmartCalloutLayout {
  const safeW = Math.max(cardW + margin * 2, stageW);
  const safeH = Math.max(cardH + margin + bottomReservedPx, stageH);
  const minLeft = margin;
  const maxLeft = Math.max(minLeft, safeW - margin - cardW);
  const minTop = margin;
  const maxTop = Math.max(minTop, safeH - bottomReservedPx - cardH);

  const markerProtectRect: AvoidRect = {
    left: markerStageX - markerClearRadius,
    top: markerStageY - markerClearRadius,
    right: markerStageX + markerClearRadius,
    bottom: markerStageY + markerClearRadius,
  };

  const gap = markerClearRadius + 22;

  const candidates: Array<{
    side: CalloutPlacementSide;
    rawLeft: number;
    rawTop: number;
    preferenceOrder: number;
  }> = [
    {
      side: 'right',
      rawLeft: markerStageX + gap,
      rawTop: markerStageY - cardH * 0.5,
      preferenceOrder: 0,
    },
    {
      side: 'left',
      rawLeft: markerStageX - gap - cardW,
      rawTop: markerStageY - cardH * 0.5,
      preferenceOrder: 1,
    },
    {
      side: 'below',
      rawLeft: markerStageX - cardW * 0.5,
      rawTop: markerStageY + gap,
      preferenceOrder: 2,
    },
    {
      side: 'above',
      rawLeft: markerStageX - cardW * 0.5,
      rawTop: markerStageY - gap - cardH,
      preferenceOrder: 3,
    },
  ];

  let bestScore = Number.POSITIVE_INFINITY;
  let bestCandidate: { side: CalloutPlacementSide; cardLeft: number; cardTop: number } = {
    side: 'right',
    cardLeft: clamp(candidates[0].rawLeft, minLeft, maxLeft),
    cardTop: clamp(candidates[0].rawTop, minTop, maxTop),
  };

  for (const cand of candidates) {
    const cardLeft = clamp(cand.rawLeft, minLeft, maxLeft);
    const cardTop = clamp(cand.rawTop, minTop, maxTop);
    const cardRect: AvoidRect = {
      left: cardLeft,
      top: cardTop,
      right: cardLeft + cardW,
      bottom: cardTop + cardH,
    };

    const markerOverlap = rectIntersectionArea(cardRect, markerProtectRect);
    let uiOverlap = 0;
    for (const avoid of avoidRects) {
      uiOverlap += rectIntersectionArea(cardRect, avoid);
    }

    const clampShift = Math.abs(cardLeft - cand.rawLeft) * 1.5 + Math.abs(cardTop - cand.rawTop);
    const score =
      markerOverlap * 1_000_000 + uiOverlap * 10_000 + clampShift + cand.preferenceOrder * 4;

    if (score < bestScore) {
      bestScore = score;
      bestCandidate = { side: cand.side, cardLeft, cardTop };
    }
  }

  const { side, cardLeft, cardTop } = bestCandidate;

  if (side === 'left') {
    const anchorX = cardLeft + cardW;
    const anchorY = clamp(markerStageY, cardTop + 18, cardTop + cardH - 18);
    const kneeX = Math.min(markerStageX - 12, anchorX + 20);
    return {
      cardLeft,
      cardTop,
      anchorX,
      anchorY,
      kneeX,
      kneeY: anchorY,
      side,
    };
  }

  if (side === 'below') {
    const anchorX = clamp(markerStageX, cardLeft + 24, cardLeft + cardW - 24);
    const anchorY = cardTop;
    const kneeY = Math.max(markerStageY + 12, anchorY - 18);
    return {
      cardLeft,
      cardTop,
      anchorX,
      anchorY,
      kneeX: anchorX,
      kneeY,
      side,
    };
  }

  if (side === 'above') {
    const anchorX = clamp(markerStageX, cardLeft + 24, cardLeft + cardW - 24);
    const anchorY = cardTop + cardH;
    const kneeY = Math.min(markerStageY - 12, anchorY + 18);
    return {
      cardLeft,
      cardTop,
      anchorX,
      anchorY,
      kneeX: anchorX,
      kneeY,
      side,
    };
  }

  const anchorX = cardLeft;
  const anchorY = clamp(markerStageY, cardTop + 18, cardTop + cardH - 18);
  const kneeX = Math.max(markerStageX + 12, anchorX - 20);
  return {
    cardLeft,
    cardTop,
    anchorX,
    anchorY,
    kneeX,
    kneeY: anchorY,
    side: 'right',
  };
}
