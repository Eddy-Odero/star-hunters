/**
 * Client-side 60 FPS pixel-math & wavelength "Dim & Pop" engine (ISS-11).
 *
 * Turns the six cached SPHEREx detector planes for one or more epochs into a
 * 256x256 RGBA `Uint8ClampedArray` (ready for `new ImageData(...)`). Everything
 * here is pure, synchronous and network-free so blink / subtract / co-add,
 * wavelength filtering, contrast stretch and flag overlays can run on every
 * animation frame.
 *
 * Rendering contract:
 *   - Detectors 1+2 (blue end)  -> Blue channel
 *   - Detectors 3+4 (green/mid) -> Green channel
 *   - Detectors 5+6 (red/IR)    -> Red channel
 *   - Each detector is weighted by `computeDetectorWeights(wavelengthRangeUm)`
 *     (out-of-band detectors keep a 5% context floor). Channels are intentionally
 *     normalised by a constant (2 detectors) rather than by the active weights so
 *     that dimming an out-of-band detector genuinely dims it by ~95%.
 */

import {
  GRID_HEIGHT,
  GRID_WIDTH,
  NUM_DETECTORS,
  PIXELS_PER_PLANE,
  computeDetectorWeights,
  type ComparisonMode,
  type ContrastStretch,
} from '../types/contracts.ts';

export interface PixelEngineRenderParams {
  /** `epochBuffers[epochIndex][detectorIndex]` — each plane is 65,536 Float32 values. */
  epochBuffers: ReadonlyArray<ReadonlyArray<Float32Array>> | null;
  /** Optional `flagsBuffers[epochIndex]` 256x256 bit masks. */
  flagsBuffers?: ReadonlyArray<Uint8Array> | null;
  /** Blink epoch. Defaults to 0. */
  activeEpochIndex?: number;
  /** Defaults to `blink`. */
  comparisonMode?: ComparisonMode;
  /** Defaults to `asinh`. */
  contrastStretch?: ContrastStretch;
  /** Inclusive wavelength window in micrometres. Defaults to the full 0.75–5.0 um range. */
  wavelengthRangeUm?: readonly [number, number];
  /** Pass A (reference) for `subtract`; Pass B - Pass A. */
  passAIndex?: number;
  /** Pass B (current) for `subtract`. Defaults to `activeEpochIndex`. */
  passBIndex?: number;
  /** Epoch indices averaged by `coadd`. Defaults to every available epoch. */
  coaddIndices?: readonly number[];
  /** Tint pixels whose flag mask is non-zero (magenta/amber). Defaults to false. */
  showFlagsOverlay?: boolean;
}

type DetectorWeights = readonly [number, number, number, number, number, number];

const ZERO_PLANE = new Float32Array(PIXELS_PER_PLANE);

const STRETCH_LUT_STEP = 256; // 1/256 of a flux unit
const STRETCH_LUT_SIZE = 4096; // covers raw flux 0..16
const STRETCH_DOMAIN_MAX = STRETCH_LUT_SIZE / STRETCH_LUT_STEP;

// Asinh is deliberately close to linear at the faint end (gain 0.25) so a 5%
// detector weight remains a genuine ~95% dim, while still compressing bright peaks.
const ASINH_GAIN = 0.25;
const ASINH_WHITE = 8.0;
const ASINH_NORMALISER = Math.asinh(ASINH_WHITE * ASINH_GAIN);
// Fixed robust black/white points used by the z-scale stretch. A small black
// point keeps the observatory background neutral and a fixed white point keeps
// wavelength dimming absolute instead of re-normalising each frame.
const ZSCALE_BLACK = 0.02;
const ZSCALE_WHITE = 8.0;

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

/**
 * Map a single (already weighted) flux value into [0, 1] for the chosen stretch.
 * Exposed for tests and for callers that need a scalar readout (e.g. hover probes).
 */
export function applyContrastStretch(value: number, stretch: ContrastStretch = 'asinh'): number {
  const flux = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (stretch === 'linear') {
    return clamp01((flux / STRETCH_DOMAIN_MAX) * 2.0);
  }
  if (stretch === 'zscale') {
    return clamp01((flux - ZSCALE_BLACK) / (ZSCALE_WHITE - ZSCALE_BLACK));
  }
  return clamp01(Math.asinh(flux * ASINH_GAIN) / ASINH_NORMALISER);
}

function buildStretchLut(stretch: ContrastStretch): Uint8Array {
  const lut = new Uint8Array(STRETCH_LUT_SIZE + 1);
  for (let i = 0; i <= STRETCH_LUT_SIZE; i += 1) {
    lut[i] = Math.round(applyContrastStretch(i / STRETCH_LUT_STEP, stretch) * 255);
  }
  return lut;
}

const STRETCH_LUTS: Record<ContrastStretch, Uint8Array> = {
  asinh: buildStretchLut('asinh'),
  linear: buildStretchLut('linear'),
  zscale: buildStretchLut('zscale'),
};

function stretchIndex(value: number): number {
  const scaled = value * STRETCH_LUT_STEP;
  if (!(scaled > 0)) return 0;
  return scaled >= STRETCH_LUT_SIZE ? STRETCH_LUT_SIZE : scaled | 0;
}

function clampEpochIndex(index: number | undefined, count: number): number {
  if (count <= 0) return -1;
  const candidate = Number.isFinite(index) ? Math.trunc(index as number) : 0;
  return Math.max(0, Math.min(count - 1, candidate));
}

function normaliseWeights(wavelengthRangeUm: readonly [number, number]): DetectorWeights {
  const computed = computeDetectorWeights([wavelengthRangeUm[0], wavelengthRangeUm[1]]);
  return [
    computed[0] ?? 0.05,
    computed[1] ?? 0.05,
    computed[2] ?? 0.05,
    computed[3] ?? 0.05,
    computed[4] ?? 0.05,
    computed[5] ?? 0.05,
  ];
}

function selectedCoaddIndices(
  epochBuffers: ReadonlyArray<ReadonlyArray<Float32Array>>,
  coaddIndices: readonly number[] | undefined,
): number[] {
  const count = epochBuffers.length;
  if (count === 0) return [];
  if (!coaddIndices || coaddIndices.length === 0) {
    return Array.from({ length: count }, (_, index) => index);
  }
  const seen = new Set<number>();
  const indices: number[] = [];
  for (const raw of coaddIndices) {
    const index = clampEpochIndex(raw, count);
    if (index >= 0 && !seen.has(index)) {
      seen.add(index);
      indices.push(index);
    }
  }
  return indices.length > 0 ? indices : Array.from({ length: count }, (_, index) => index);
}

function planesAt(
  epochBuffers: ReadonlyArray<ReadonlyArray<Float32Array>>,
  epochIndex: number,
): ReadonlyArray<Float32Array> {
  return epochBuffers[epochIndex] ?? [];
}

function fillEmptyFrame(out: Uint8ClampedArray): Uint8ClampedArray {
  for (let i = 0; i < PIXELS_PER_PLANE; i += 1) {
    const outIdx = i * 4;
    out[outIdx] = 8;
    out[outIdx + 1] = 12;
    out[outIdx + 2] = 24;
    out[outIdx + 3] = 255;
  }
  return out;
}

function tintFlagPixel(out: Uint8ClampedArray, outIdx: number, flag: number): void {
  if (flag === 0) return;
  // Bit 1 is rendered as warm amber; any higher bit as hot magenta. Mixed masks
  // get a magenta/amber blend so both classes remain distinguishable.
  if ((flag & 0x02) !== 0) {
    out[outIdx] = Math.min(255, out[outIdx] + 110);
    out[outIdx + 1] = Math.min(255, out[outIdx + 1] + 25);
    out[outIdx + 2] = Math.min(255, out[outIdx + 2] + 130);
  } else {
    out[outIdx] = Math.min(255, out[outIdx] + 125);
    out[outIdx + 1] = Math.min(255, out[outIdx + 1] + 85);
    out[outIdx + 2] = Math.min(255, out[outIdx + 2] + 10);
  }
}

function renderColorFrame(
  epochBuffers: ReadonlyArray<ReadonlyArray<Float32Array>>,
  indices: readonly number[],
  weights: DetectorWeights,
  lut: Uint8Array,
  flags: Uint8Array | null | undefined,
  showFlagsOverlay: boolean,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(PIXELS_PER_PLANE * 4);
  const epochCount = Math.max(1, indices.length);
  // Half of each detector pair, averaged across the co-add stack.
  const scale = 0.5 / epochCount;
  const h0 = weights[0] * scale;
  const h1 = weights[1] * scale;
  const h2 = weights[2] * scale;
  const h3 = weights[3] * scale;
  const h4 = weights[4] * scale;
  const h5 = weights[5] * scale;

  if (indices.length === 1) {
    const planes = planesAt(epochBuffers, indices[0]);
    const d0 = planes[0] ?? ZERO_PLANE;
    const d1 = planes[1] ?? ZERO_PLANE;
    const d2 = planes[2] ?? ZERO_PLANE;
    const d3 = planes[3] ?? ZERO_PLANE;
    const d4 = planes[4] ?? ZERO_PLANE;
    const d5 = planes[5] ?? ZERO_PLANE;

    for (let i = 0; i < PIXELS_PER_PLANE; i += 1) {
      const blue = h0 * d0[i] + h1 * d1[i];
      const green = h2 * d2[i] + h3 * d3[i];
      const red = h4 * d4[i] + h5 * d5[i];
      const outIdx = i * 4;
      let ri = red * STRETCH_LUT_STEP;
      let gi = green * STRETCH_LUT_STEP;
      let bi = blue * STRETCH_LUT_STEP;
      ri = ri <= 0 ? 0 : ri >= STRETCH_LUT_SIZE ? STRETCH_LUT_SIZE : ri | 0;
      gi = gi <= 0 ? 0 : gi >= STRETCH_LUT_SIZE ? STRETCH_LUT_SIZE : gi | 0;
      bi = bi <= 0 ? 0 : bi >= STRETCH_LUT_SIZE ? STRETCH_LUT_SIZE : bi | 0;
      out[outIdx] = lut[ri];
      out[outIdx + 1] = lut[gi];
      out[outIdx + 2] = lut[bi];
      if (showFlagsOverlay && flags) tintFlagPixel(out, outIdx, flags[i]);
      out[outIdx + 3] = 255;
    }
    return out;
  }

  if (indices.length === 2) {
    const first = planesAt(epochBuffers, indices[0]);
    const second = planesAt(epochBuffers, indices[1]);
    const a0 = first[0] ?? ZERO_PLANE;
    const a1 = first[1] ?? ZERO_PLANE;
    const a2 = first[2] ?? ZERO_PLANE;
    const a3 = first[3] ?? ZERO_PLANE;
    const a4 = first[4] ?? ZERO_PLANE;
    const a5 = first[5] ?? ZERO_PLANE;
    const b0 = second[0] ?? ZERO_PLANE;
    const b1 = second[1] ?? ZERO_PLANE;
    const b2 = second[2] ?? ZERO_PLANE;
    const b3 = second[3] ?? ZERO_PLANE;
    const b4 = second[4] ?? ZERO_PLANE;
    const b5 = second[5] ?? ZERO_PLANE;

    for (let i = 0; i < PIXELS_PER_PLANE; i += 1) {
      const blue = h0 * (a0[i] + b0[i]) + h1 * (a1[i] + b1[i]);
      const green = h2 * (a2[i] + b2[i]) + h3 * (a3[i] + b3[i]);
      const red = h4 * (a4[i] + b4[i]) + h5 * (a5[i] + b5[i]);
      const outIdx = i * 4;
      let ri = red * STRETCH_LUT_STEP;
      let gi = green * STRETCH_LUT_STEP;
      let bi = blue * STRETCH_LUT_STEP;
      ri = ri <= 0 ? 0 : ri >= STRETCH_LUT_SIZE ? STRETCH_LUT_SIZE : ri | 0;
      gi = gi <= 0 ? 0 : gi >= STRETCH_LUT_SIZE ? STRETCH_LUT_SIZE : gi | 0;
      bi = bi <= 0 ? 0 : bi >= STRETCH_LUT_SIZE ? STRETCH_LUT_SIZE : bi | 0;
      out[outIdx] = lut[ri];
      out[outIdx + 1] = lut[gi];
      out[outIdx + 2] = lut[bi];
      if (showFlagsOverlay && flags) tintFlagPixel(out, outIdx, flags[i]);
      out[outIdx + 3] = 255;
    }
    return out;
  }

  // Hoist the six plane references per epoch so the inner pixel loop is a flat
  // sequence of typed-array reads instead of chained array indexing.
  const selectedPlanes = indices.map((index) => planesAt(epochBuffers, index));
  const c0 = selectedPlanes.map((planes) => planes[0] ?? ZERO_PLANE);
  const c1 = selectedPlanes.map((planes) => planes[1] ?? ZERO_PLANE);
  const c2 = selectedPlanes.map((planes) => planes[2] ?? ZERO_PLANE);
  const c3 = selectedPlanes.map((planes) => planes[3] ?? ZERO_PLANE);
  const c4 = selectedPlanes.map((planes) => planes[4] ?? ZERO_PLANE);
  const c5 = selectedPlanes.map((planes) => planes[5] ?? ZERO_PLANE);
  const planeCount = selectedPlanes.length;

  for (let i = 0; i < PIXELS_PER_PLANE; i += 1) {
    let blue = 0;
    let green = 0;
    let red = 0;
    for (let k = 0; k < planeCount; k += 1) {
      blue += h0 * c0[k][i] + h1 * c1[k][i];
      green += h2 * c2[k][i] + h3 * c3[k][i];
      red += h4 * c4[k][i] + h5 * c5[k][i];
    }
    const outIdx = i * 4;
    let ri = red * STRETCH_LUT_STEP;
    let gi = green * STRETCH_LUT_STEP;
    let bi = blue * STRETCH_LUT_STEP;
    ri = ri <= 0 ? 0 : ri >= STRETCH_LUT_SIZE ? STRETCH_LUT_SIZE : ri | 0;
    gi = gi <= 0 ? 0 : gi >= STRETCH_LUT_SIZE ? STRETCH_LUT_SIZE : gi | 0;
    bi = bi <= 0 ? 0 : bi >= STRETCH_LUT_SIZE ? STRETCH_LUT_SIZE : bi | 0;
    out[outIdx] = lut[ri];
    out[outIdx + 1] = lut[gi];
    out[outIdx + 2] = lut[bi];
    if (showFlagsOverlay && flags) tintFlagPixel(out, outIdx, flags[i]);
    out[outIdx + 3] = 255;
  }
  return out;
}

function renderSubtractFrame(
  epochBuffers: ReadonlyArray<ReadonlyArray<Float32Array>>,
  passAIndex: number,
  passBIndex: number,
  weights: DetectorWeights,
  lut: Uint8Array,
  flags: Uint8Array | null | undefined,
  showFlagsOverlay: boolean,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(PIXELS_PER_PLANE * 4);
  const planesA = planesAt(epochBuffers, passAIndex);
  const planesB = planesAt(epochBuffers, passBIndex);
  const a0 = planesA[0] ?? ZERO_PLANE;
  const a1 = planesA[1] ?? ZERO_PLANE;
  const a2 = planesA[2] ?? ZERO_PLANE;
  const a3 = planesA[3] ?? ZERO_PLANE;
  const a4 = planesA[4] ?? ZERO_PLANE;
  const a5 = planesA[5] ?? ZERO_PLANE;
  const b0 = planesB[0] ?? ZERO_PLANE;
  const b1 = planesB[1] ?? ZERO_PLANE;
  const b2 = planesB[2] ?? ZERO_PLANE;
  const b3 = planesB[3] ?? ZERO_PLANE;
  const b4 = planesB[4] ?? ZERO_PLANE;
  const b5 = planesB[5] ?? ZERO_PLANE;

  const w0 = weights[0];
  const w1 = weights[1];
  const w2 = weights[2];
  const w3 = weights[3];
  const w4 = weights[4];
  const w5 = weights[5];
  const norm = 1 / Math.max(1e-6, w0 + w1 + w2 + w3 + w4 + w5);

  // A neutral, exactly equal-channel background for a zero residual. When the
  // same pass is subtracted from itself every pixel therefore stays uniform.
  const baseR = 0;
  const baseG = 0;
  const baseB = 0;

  for (let i = 0; i < PIXELS_PER_PLANE; i += 1) {
    const delta =
      (w0 * (b0[i] - a0[i]) +
        w1 * (b1[i] - a1[i]) +
        w2 * (b2[i] - a2[i]) +
        w3 * (b3[i] - a3[i]) +
        w4 * (b4[i] - a4[i]) +
        w5 * (b5[i] - a5[i])) *
      norm;
    const outIdx = i * 4;
    if (delta > 0) {
      // Positive residual: warm orange/red (new source, fading-in, moved in).
      const s = lut[stretchIndex(delta)];
      out[outIdx] = baseR + (s * 247) / 255;
      out[outIdx + 1] = baseG + (s * 118) / 255;
      out[outIdx + 2] = baseB + (s * 18) / 255;
    } else if (delta < 0) {
      // Negative residual: cool cyan/blue (source present in Pass A, absent in B).
      const s = lut[stretchIndex(-delta)];
      out[outIdx] = baseR + (s * 18) / 255;
      out[outIdx + 1] = baseG + (s * 160) / 255;
      out[outIdx + 2] = baseB + (s * 247) / 255;
    } else {
      out[outIdx] = baseR;
      out[outIdx + 1] = baseG;
      out[outIdx + 2] = baseB;
    }
    if (showFlagsOverlay && flags) tintFlagPixel(out, outIdx, flags[i]);
    out[outIdx + 3] = 255;
  }
  return out;
}

/**
 * Render cached multi-epoch detector planes into a 256x256 RGBA byte buffer.
 *
 * The returned array can be wrapped directly:
 *   `ctx.putImageData(new ImageData(rgba, 256, 256), 0, 0)`
 */
export function renderEpochBuffersToRgba(params: PixelEngineRenderParams): Uint8ClampedArray {
  const {
    epochBuffers,
    flagsBuffers,
    activeEpochIndex = 0,
    comparisonMode = 'blink',
    contrastStretch = 'asinh',
    wavelengthRangeUm = [0.75, 5.0],
    passAIndex,
    passBIndex,
    coaddIndices,
    showFlagsOverlay = false,
  } = params;

  if (!epochBuffers || epochBuffers.length === 0) {
    return fillEmptyFrame(new Uint8ClampedArray(PIXELS_PER_PLANE * 4));
  }

  const weights = normaliseWeights(wavelengthRangeUm);
  const lut = STRETCH_LUTS[contrastStretch] ?? STRETCH_LUTS.asinh;
  const activeIdx = clampEpochIndex(activeEpochIndex, epochBuffers.length);

  if (comparisonMode === 'subtract') {
    const passB = clampEpochIndex(passBIndex ?? activeIdx, epochBuffers.length);
    const passA = clampEpochIndex(
      passAIndex ?? (epochBuffers.length > 1 ? (passB === 0 ? 1 : 0) : passB),
      epochBuffers.length,
    );
    const flags = flagsBuffers?.[passB] ?? flagsBuffers?.[passA];
    return renderSubtractFrame(epochBuffers, passA, passB, weights, lut, flags, showFlagsOverlay);
  }

  if (comparisonMode === 'coadd') {
    const indices = selectedCoaddIndices(epochBuffers, coaddIndices);
    const flags = flagsBuffers?.[indices[0]];
    return renderColorFrame(epochBuffers, indices, weights, lut, flags, showFlagsOverlay);
  }

  const flags = flagsBuffers?.[activeIdx];
  return renderColorFrame(epochBuffers, [activeIdx], weights, lut, flags, showFlagsOverlay);
}

/** Aliases used by the viewport / animation loop. */
export const renderPixelFrame = renderEpochBuffersToRgba;
export const renderFrameToRgba = renderEpochBuffersToRgba;

export { computeDetectorWeights };

/** Create a browser `ImageData` object directly. Throws outside a DOM-capable runtime. */
export function renderEpochBuffersToImageData(params: PixelEngineRenderParams): ImageData {
  if (typeof ImageData === 'undefined') {
    throw new Error('ImageData is not available in this runtime; use renderEpochBuffersToRgba.');
  }
  const rgba = renderEpochBuffersToRgba(params) as Uint8ClampedArray<ArrayBuffer>;
  return new ImageData(rgba, GRID_WIDTH, GRID_HEIGHT);
}

/** Number of detector planes expected in a cached epoch. */
export const PIXEL_ENGINE_DETECTOR_COUNT = NUM_DETECTORS;
