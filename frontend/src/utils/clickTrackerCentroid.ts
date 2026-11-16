/**
 * Composite frame synthesis, aperture centroiding, and multi-peak discovery helpers
 * backing Click-to-Track body detection across SPHEREx / archival epochs.
 *
 * Kept React-free so Node 24's `node --test` executes this module directly.
 */

import { GRID_HEIGHT, GRID_WIDTH, NUM_DETECTORS, PIXELS_PER_PLANE } from '../types/contracts.ts';
import { computeDetectorWeights } from './wcsViewport.ts';

/** Sub-pixel source detection metrics computed inside a local aperture. */
export interface CentroidDetection {
  x: number;
  y: number;
  peakFlux: number;
  netFlux: number;
  snr: number;
}

/**
 * Build wavelength-weighted 256x256 composite brightness frames for each epoch.
 *
 * @param epochBuffers - Multi-epoch 6-detector buffer planes.
 * @param numEpochs - Number of valid epochs to synthesize.
 * @param wavelengthRangeUm - Active `[minUm, maxUm]` Dim & Pop wavelength slice.
 * @returns Array of `numEpochs` composite 256x256 `Float32Array` images.
 */
export function buildCompositeFrames(
  epochBuffers: Float32Array[][],
  numEpochs: number,
  wavelengthRangeUm: [number, number],
): Float32Array[] {
  const weights = computeDetectorWeights(wavelengthRangeUm);
  return epochBuffers.slice(0, numEpochs).map((detPlanes) => {
    const comp = new Float32Array(PIXELS_PER_PLANE);
    for (let d = 0; d < Math.min(NUM_DETECTORS, detPlanes.length); d += 1) {
      const w = weights[d];
      const plane = detPlanes[d];
      for (let i = 0; i < PIXELS_PER_PLANE; i += 1) {
        comp[i] += w * plane[i];
      }
    }
    return comp;
  });
}

/**
 * Build positive difference frames relative to `originEpochIndex`, cancelling ~98%
 * of stationary field-star flux when isolating moving bodies across epochs.
 *
 * @param compositeFrames - Per-epoch composite brightness images.
 * @param originEpochIndex - Reference epoch index where the click originated.
 * @returns Per-epoch positive transient difference buffers (origin frame returned verbatim).
 */
export function buildTransientDifferenceFrames(
  compositeFrames: Float32Array[],
  originEpochIndex: number,
): Float32Array[] {
  const numEpochs = compositeFrames.length;
  const originComp = compositeFrames[originEpochIndex];
  return compositeFrames.map((comp, epIdx) => {
    if (numEpochs < 2 || epIdx === originEpochIndex) {
      return comp;
    }
    const diffFrame = new Float32Array(PIXELS_PER_PLANE);
    for (let i = 0; i < PIXELS_PER_PLANE; i += 1) {
      diffFrame[i] = Math.max(0, comp[i] - 0.98 * originComp[i]);
    }
    return diffFrame;
  });
}

/**
 * Locate the brightest pixel within `searchRadius` of `(centerX, centerY)`, estimate
 * the local sky background from an annulus (`r = 5..8 px`), and compute a 5x5
 * flux-weighted centroid and rectified-noise-adjusted aperture SNR.
 *
 * @param comp - 256x256 composite brightness buffer.
 * @param centerX - Search center X in image pixels.
 * @param centerY - Search center Y in image pixels.
 * @param searchRadius - Circular search radius in pixels.
 * @returns Sub-pixel {@link CentroidDetection} summary.
 */
export function findLocalPeakAndCentroid(
  comp: Float32Array,
  centerX: number,
  centerY: number,
  searchRadius: number,
): CentroidDetection {
  const xMin = Math.max(1, Math.floor(centerX - searchRadius));
  const xMax = Math.min(GRID_WIDTH - 2, Math.ceil(centerX + searchRadius));
  const yMin = Math.max(1, Math.floor(centerY - searchRadius));
  const yMax = Math.min(GRID_HEIGHT - 2, Math.ceil(centerY + searchRadius));

  let peakX = Math.round(Math.max(0, Math.min(GRID_WIDTH - 1, centerX)));
  let peakY = Math.round(Math.max(0, Math.min(GRID_HEIGHT - 1, centerY)));
  let peakVal = -Infinity;
  const rSq = searchRadius * searchRadius;

  for (let py = yMin; py <= yMax; py += 1) {
    const dy = py - centerY;
    for (let px = xMin; px <= xMax; px += 1) {
      const dx = px - centerX;
      if (dx * dx + dy * dy <= rSq) {
        const val = comp[py * GRID_WIDTH + px];
        if (val > peakVal) {
          peakVal = val;
          peakX = px;
          peakY = py;
        }
      }
    }
  }

  if (!Number.isFinite(peakVal)) {
    peakVal = comp[peakY * GRID_WIDTH + peakX] ?? 0;
  }

  // Estimate local background from annulus (radius 5..8 around peak)
  let bgSum = 0;
  let bgSqSum = 0;
  let bgCount = 0;
  for (let py = Math.max(0, peakY - 8); py <= Math.min(GRID_HEIGHT - 1, peakY + 8); py += 1) {
    for (let px = Math.max(0, peakX - 8); px <= Math.min(GRID_WIDTH - 1, peakX + 8); px += 1) {
      const d2 = (px - peakX) * (px - peakX) + (py - peakY) * (py - peakY);
      if (d2 >= 25 && d2 <= 64) {
        const v = comp[py * GRID_WIDTH + px];
        bgSum += v;
        bgSqSum += v * v;
        bgCount += 1;
      }
    }
  }
  const bgMean = bgCount > 0 ? bgSum / bgCount : 0;
  const bgVar = bgCount > 1 ? Math.max(1e-6, bgSqSum / bgCount - bgMean * bgMean) : 1e-4;
  const bgStd = Math.sqrt(bgVar);

  // 5x5 flux-weighted centroid around peak
  let sumFlux = 0;
  let sumX = 0;
  let sumY = 0;
  let aperturePixelCount = 0;
  for (let py = Math.max(0, peakY - 2); py <= Math.min(GRID_HEIGHT - 1, peakY + 2); py += 1) {
    for (let px = Math.max(0, peakX - 2); px <= Math.min(GRID_WIDTH - 1, peakX + 2); px += 1) {
      const net = Math.max(0, comp[py * GRID_WIDTH + px] - bgMean);
      sumFlux += net;
      sumX += px * net;
      sumY += py * net;
      aperturePixelCount += 1;
    }
  }

  const centroidX = sumFlux > 1e-5 ? sumX / sumFlux : peakX;
  const centroidY = sumFlux > 1e-5 ? sumY / sumFlux : peakY;
  const netFlux = Math.max(0, peakVal - bgMean);

  // Aperture significance: subtract rectification bias of max(0, noise) over the 5x5 aperture
  const rectifiedNoiseBias = 0.3989422804014327 * bgStd * aperturePixelCount;
  const apertureSignal = Math.max(0, sumFlux - rectifiedNoiseBias);
  const apertureNoise = bgStd * Math.sqrt(Math.max(1, aperturePixelCount));
  const snr = Math.max(0, apertureSignal / apertureNoise);

  return {
    x: Number(centroidX.toFixed(2)),
    y: Number(centroidY.toFixed(2)),
    peakFlux: Number(peakVal.toFixed(4)),
    netFlux: Number(netFlux.toFixed(4)),
    snr: Number(snr.toFixed(2)),
  };
}

function isLocal3x3Max(buf: Float32Array, px: number, py: number, val: number): boolean {
  for (let ny = py - 1; ny <= py + 1; ny += 1) {
    for (let nx = px - 1; nx <= px + 1; nx += 1) {
      if (nx === px && ny === py) continue;
      if (buf[ny * GRID_WIDTH + nx] > val) return false;
    }
  }
  return true;
}

/**
 * Find all distinct separated moving peaks in a target epoch's transient difference frame.
 *
 * @param params - Transient frame, raw frame, origin centroid, search window, and SNR gate.
 * @returns Refined, de-duplicated moving centroid detections sorted by difference flux.
 */
export function findSeparatedMovingPeaks(params: {
  diffComp: Float32Array;
  rawComp: Float32Array;
  originDetection: CentroidDetection;
  searchCenterX: number;
  searchCenterY: number;
  searchRadius: number;
  minSnrThreshold: number;
  minSeparationPx?: number;
}): CentroidDetection[] {
  const {
    diffComp,
    rawComp,
    originDetection,
    searchCenterX,
    searchCenterY,
    searchRadius,
    minSnrThreshold,
    minSeparationPx = 3.0,
  } = params;

  const xMin = Math.max(2, Math.floor(searchCenterX - searchRadius));
  const xMax = Math.min(GRID_WIDTH - 3, Math.ceil(searchCenterX + searchRadius));
  const yMin = Math.max(2, Math.floor(searchCenterY - searchRadius));
  const yMax = Math.min(GRID_HEIGHT - 3, Math.ceil(searchCenterY + searchRadius));
  const rSq = searchRadius * searchRadius;

  const candidates: { px: number; py: number; diffVal: number }[] = [];
  const minDiffFlux = Math.max(0.05, 0.14 * originDetection.netFlux);

  for (let py = yMin; py <= yMax; py += 1) {
    const dy = py - searchCenterY;
    for (let px = xMin; px <= xMax; px += 1) {
      const dx = px - searchCenterX;
      if (dx * dx + dy * dy > rSq) continue;
      if (Math.hypot(px - originDetection.x, py - originDetection.y) < 2.2) continue;

      const val = diffComp[py * GRID_WIDTH + px];
      if (val >= minDiffFlux && isLocal3x3Max(diffComp, px, py, val)) {
        candidates.push({ px, py, diffVal: val });
      }
    }
  }

  candidates.sort((a, b) => b.diffVal - a.diffVal);

  const refinedPeaks: CentroidDetection[] = [];
  for (const cand of candidates) {
    const refined = findLocalPeakAndCentroid(rawComp, cand.px, cand.py, 2.2);
    if (
      refined.snr < minSnrThreshold ||
      refined.netFlux < Math.max(0.04, 0.14 * originDetection.netFlux) ||
      Math.hypot(refined.x - originDetection.x, refined.y - originDetection.y) < 2.2
    ) {
      continue;
    }
    const tooClose = refinedPeaks.some(
      (existing) => Math.hypot(existing.x - refined.x, existing.y - refined.y) < minSeparationPx,
    );
    if (!tooClose) {
      refinedPeaks.push(refined);
    }
  }
  return refinedPeaks;
}

/**
 * Verify whether a stationary source remains at `(refX, refY)` in another epoch.
 *
 * @param targetComp - Composite frame for the comparison epoch.
 * @param refX - Reference X coordinate on the origin frame.
 * @param refY - Reference Y coordinate on the origin frame.
 * @param refNetFlux - Reference net flux on the origin frame.
 * @param minSnrThreshold - Minimum aperture SNR required for confirmation.
 * @returns Confirmed {@link CentroidDetection}, or `null` if absent or too faint.
 */
export function checkStationaryAtSpot(
  targetComp: Float32Array,
  refX: number,
  refY: number,
  refNetFlux: number,
  minSnrThreshold: number,
): CentroidDetection | null {
  const cand = findLocalPeakAndCentroid(targetComp, refX, refY, 2.2);
  const dist = Math.hypot(cand.x - refX, cand.y - refY);
  if (
    dist <= 1.4 &&
    cand.snr >= minSnrThreshold &&
    cand.netFlux >= Math.max(0.04, 0.15 * refNetFlux)
  ) {
    return cand;
  }
  return null;
}

/**
 * Detect secondary local peaks inside `localRadiusPx` of the clicked spot on the
 * origin epoch so partially separated overlapped bodies are also seeded.
 *
 * @param originComp - Origin epoch composite image.
 * @param clickX - Raw click X coordinate.
 * @param clickY - Raw click Y coordinate.
 * @param localRadiusPx - Click search radius in pixels.
 * @param originDetection - Primary centroid detection at the click.
 * @param minSnrThreshold - Minimum SNR gate.
 * @returns Secondary origin centroid detections distinct from `originDetection`.
 */
export function findSecondaryOriginPeaks(
  originComp: Float32Array,
  clickX: number,
  clickY: number,
  localRadiusPx: number,
  originDetection: CentroidDetection,
  minSnrThreshold: number,
): CentroidDetection[] {
  const xMin = Math.max(2, Math.floor(clickX - localRadiusPx));
  const xMax = Math.min(GRID_WIDTH - 3, Math.ceil(clickX + localRadiusPx));
  const yMin = Math.max(2, Math.floor(clickY - localRadiusPx));
  const yMax = Math.min(GRID_HEIGHT - 3, Math.ceil(clickY + localRadiusPx));
  const rSq = localRadiusPx * localRadiusPx;
  const minPeakNet = Math.max(0.05, 0.2 * originDetection.netFlux);

  const rawCandidates: { px: number; py: number; val: number }[] = [];
  for (let py = yMin; py <= yMax; py += 1) {
    const dy = py - clickY;
    for (let px = xMin; px <= xMax; px += 1) {
      const dx = px - clickX;
      if (dx * dx + dy * dy > rSq) continue;
      if (Math.hypot(px - originDetection.x, py - originDetection.y) < 2.2) continue;
      const val = originComp[py * GRID_WIDTH + px];
      if (val >= minPeakNet && isLocal3x3Max(originComp, px, py, val)) {
        rawCandidates.push({ px, py, val });
      }
    }
  }

  rawCandidates.sort((a, b) => b.val - a.val);
  const secondaries: CentroidDetection[] = [];
  for (const c of rawCandidates) {
    const refined = findLocalPeakAndCentroid(originComp, c.px, c.py, 1.8);
    if (
      refined.snr < minSnrThreshold ||
      refined.netFlux < minPeakNet ||
      Math.hypot(refined.x - originDetection.x, refined.y - originDetection.y) < 2.2
    ) {
      continue;
    }
    if (!secondaries.some((s) => Math.hypot(s.x - refined.x, s.y - refined.y) < 2.5)) {
      secondaries.push(refined);
    }
  }
  return secondaries;
}
