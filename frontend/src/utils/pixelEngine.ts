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

/** Input parameters for {@link renderEpochBuffersToRgba} and {@link renderEpochBuffersToImageData}. */
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
  /**
   * Optional pre-allocated 256x256x4 RGBA output buffer to populate in-place,
   * avoiding a 262,144-byte allocation on every animation frame.
   */
  outBuffer?: Uint8ClampedArray;
}

type DetectorWeights = readonly [number, number, number, number, number, number];

const EXPECTED_RGBA_BYTES = PIXELS_PER_PLANE * 4;
const ZERO_PLANE = new Float32Array(PIXELS_PER_PLANE);
const COADD_FLAGS_SCRATCH = new Uint8Array(PIXELS_PER_PLANE);
const ACC_BLUE_SCRATCH = new Float32Array(PIXELS_PER_PLANE);
const ACC_GREEN_SCRATCH = new Float32Array(PIXELS_PER_PLANE);
const ACC_RED_SCRATCH = new Float32Array(PIXELS_PER_PLANE);

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
 * Map a single (already weighted) flux value into `[0, 1]` for the chosen stretch.
 * Exposed for tests and for callers that need a scalar readout (e.g. hover probes).
 *
 * @param value - Weighted flux sample.
 * @param stretch - Contrast stretch curve (`'asinh'`, `'linear'`, or `'zscale'`).
 * @returns Normalized intensity in `[0, 1]`.
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

/**
 * Resolve the target 256x256 RGBA output buffer, validating any caller-supplied buffer.
 *
 * @param outBuffer - Optional reusable `Uint8ClampedArray` of length `262,144`.
 * @returns Either `outBuffer` or a newly allocated `Uint8ClampedArray`.
 * @throws {RangeError} When `outBuffer` does not have exact length `262,144`.
 */
function resolveOutputBuffer(outBuffer?: Uint8ClampedArray): Uint8ClampedArray {
  if (outBuffer) {
    if (outBuffer.length !== EXPECTED_RGBA_BYTES) {
      throw new RangeError(
        `outBuffer must have length ${EXPECTED_RGBA_BYTES}, got ${outBuffer.length}`,
      );
    }
    return outBuffer;
  }
  return new Uint8ClampedArray(EXPECTED_RGBA_BYTES);
}

/**
 * Bitwise-OR hygiene flag masks across all selected co-add epochs so any pixel
 * contaminated in any contributing pass remains flagged in `coadd` mode.
 *
 * @param flagsBuffers - Per-epoch 256x256 hygiene flag arrays.
 * @param indices - Selected epoch indices participating in the co-add.
 * @returns Combined 256x256 flag mask, or `null` if no flag buffers exist.
 */
function combineCoaddFlags(
  flagsBuffers: ReadonlyArray<Uint8Array> | null | undefined,
  indices: readonly number[],
): Uint8Array | null {
  if (!flagsBuffers || flagsBuffers.length === 0) return null;
  let first: Uint8Array | null = null;
  let merged = false;
  for (const idx of indices) {
    const buf = flagsBuffers[idx];
    if (!buf) continue;
    if (!first) {
      first = buf;
      continue;
    }
    if (!merged) {
      COADD_FLAGS_SCRATCH.set(first);
      merged = true;
    }
    for (let i = 0; i < PIXELS_PER_PLANE; i += 1) {
      COADD_FLAGS_SCRATCH[i] |= buf[i];
    }
  }
  if (!first) return null;
  return merged ? COADD_FLAGS_SCRATCH : first;
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

const IS_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function applyFlagsOverlay(out: Uint8ClampedArray, flags: Uint8Array | null | undefined): void {
  if (!flags) return;
  for (let i = 0; i < PIXELS_PER_PLANE; i += 1) {
    const flag = flags[i];
    if (flag === 0) continue;
    const outIdx = i * 4;
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
}

/**
 * Accumulate one epoch's weighted RGB detector pairs into the module-level scratch planes.
 * Keeping `d0..d5` as local `Float32Array` bindings avoids array-of-arrays indirection
 * inside the 65,536-pixel loop for multi-epoch co-adds.
 */
function accumulateEpochChannels(
  planes: ReadonlyArray<Float32Array>,
  h0: number,
  h1: number,
  h2: number,
  h3: number,
  h4: number,
  h5: number,
  overwrite: boolean,
): void {
  const d0 = planes[0] ?? ZERO_PLANE;
  const d1 = planes[1] ?? ZERO_PLANE;
  const d2 = planes[2] ?? ZERO_PLANE;
  const d3 = planes[3] ?? ZERO_PLANE;
  const d4 = planes[4] ?? ZERO_PLANE;
  const d5 = planes[5] ?? ZERO_PLANE;

  if (overwrite) {
    for (let i = 0; i < PIXELS_PER_PLANE; i += 1) {
      ACC_BLUE_SCRATCH[i] = h0 * d0[i] + h1 * d1[i];
      ACC_GREEN_SCRATCH[i] = h2 * d2[i] + h3 * d3[i];
      ACC_RED_SCRATCH[i] = h4 * d4[i] + h5 * d5[i];
    }
    return;
  }

  for (let i = 0; i < PIXELS_PER_PLANE; i += 1) {
    ACC_BLUE_SCRATCH[i] += h0 * d0[i] + h1 * d1[i];
    ACC_GREEN_SCRATCH[i] += h2 * d2[i] + h3 * d3[i];
    ACC_RED_SCRATCH[i] += h4 * d4[i] + h5 * d5[i];
  }
}

/**
 * Synthesize a 256x256 RGB frame across 1 or more epochs using monomorphic
 * typed-array loops and hoisted little-endian `Uint32Array` packing.
 *
 * @param epochBuffers - Cached multi-epoch detector planes.
 * @param indices - Epoch indices to average (`[activeIdx]` for blink, or N indices for coadd).
 * @param weights - Per-detector wavelength Dim & Pop weights.
 * @param lut - Precomputed 8-bit contrast stretch lookup table.
 * @param flags - Optional 256x256 hygiene flag mask for tinting.
 * @param showFlagsOverlay - Whether to tint flagged pixels.
 * @param out - Target 256x256x4 RGBA byte buffer.
 * @returns Populated `out` buffer.
 */
function renderColorFrame(
  epochBuffers: ReadonlyArray<ReadonlyArray<Float32Array>>,
  indices: readonly number[],
  weights: DetectorWeights,
  lut: Uint8Array,
  flags: Uint8Array | null | undefined,
  showFlagsOverlay: boolean,
  out: Uint8ClampedArray,
): Uint8ClampedArray {
  const out32 =
    IS_LITTLE_ENDIAN && out.byteOffset % 4 === 0
      ? new Uint32Array(out.buffer, out.byteOffset, PIXELS_PER_PLANE)
      : null;
  const epochCount = Math.max(1, indices.length);
  // Half of each detector pair, averaged across the co-add stack.
  const scale = 0.5 / epochCount;
  const h0 = weights[0] * scale;
  const h1 = weights[1] * scale;
  const h2 = weights[2] * scale;
  const h3 = weights[3] * scale;
  const h4 = weights[4] * scale;
  const h5 = weights[5] * scale;

  const lastIdx = indices.length - 1;
  for (let k = 0; k < lastIdx; k += 1) {
    accumulateEpochChannels(planesAt(epochBuffers, indices[k]), h0, h1, h2, h3, h4, h5, k === 0);
  }

  const lastPlanes = planesAt(epochBuffers, indices[lastIdx]);
  const d0 = lastPlanes[0] ?? ZERO_PLANE;
  const d1 = lastPlanes[1] ?? ZERO_PLANE;
  const d2 = lastPlanes[2] ?? ZERO_PLANE;
  const d3 = lastPlanes[3] ?? ZERO_PLANE;
  const d4 = lastPlanes[4] ?? ZERO_PLANE;
  const d5 = lastPlanes[5] ?? ZERO_PLANE;
  const hasAccumulated = lastIdx > 0;

  if (out32) {
    if (hasAccumulated) {
      for (let i = 0; i < PIXELS_PER_PLANE; i += 1) {
        const blue = ACC_BLUE_SCRATCH[i] + h0 * d0[i] + h1 * d1[i];
        const green = ACC_GREEN_SCRATCH[i] + h2 * d2[i] + h3 * d3[i];
        const red = ACC_RED_SCRATCH[i] + h4 * d4[i] + h5 * d5[i];
        let ri = red * STRETCH_LUT_STEP;
        let gi = green * STRETCH_LUT_STEP;
        let bi = blue * STRETCH_LUT_STEP;
        ri = ri <= 0 ? 0 : ri >= STRETCH_LUT_SIZE ? STRETCH_LUT_SIZE : ri | 0;
        gi = gi <= 0 ? 0 : gi >= STRETCH_LUT_SIZE ? STRETCH_LUT_SIZE : gi | 0;
        bi = bi <= 0 ? 0 : bi >= STRETCH_LUT_SIZE ? STRETCH_LUT_SIZE : bi | 0;
        out32[i] = 0xff000000 | (lut[bi] << 16) | (lut[gi] << 8) | lut[ri];
      }
    } else {
      for (let i = 0; i < PIXELS_PER_PLANE; i += 1) {
        const blue = h0 * d0[i] + h1 * d1[i];
        const green = h2 * d2[i] + h3 * d3[i];
        const red = h4 * d4[i] + h5 * d5[i];
        let ri = red * STRETCH_LUT_STEP;
        let gi = green * STRETCH_LUT_STEP;
        let bi = blue * STRETCH_LUT_STEP;
        ri = ri <= 0 ? 0 : ri >= STRETCH_LUT_SIZE ? STRETCH_LUT_SIZE : ri | 0;
        gi = gi <= 0 ? 0 : gi >= STRETCH_LUT_SIZE ? STRETCH_LUT_SIZE : gi | 0;
        bi = bi <= 0 ? 0 : bi >= STRETCH_LUT_SIZE ? STRETCH_LUT_SIZE : bi | 0;
        out32[i] = 0xff000000 | (lut[bi] << 16) | (lut[gi] << 8) | lut[ri];
      }
    }
  } else {
    for (let i = 0; i < PIXELS_PER_PLANE; i += 1) {
      const blue = (hasAccumulated ? ACC_BLUE_SCRATCH[i] : 0) + h0 * d0[i] + h1 * d1[i];
      const green = (hasAccumulated ? ACC_GREEN_SCRATCH[i] : 0) + h2 * d2[i] + h3 * d3[i];
      const red = (hasAccumulated ? ACC_RED_SCRATCH[i] : 0) + h4 * d4[i] + h5 * d5[i];
      let ri = red * STRETCH_LUT_STEP;
      let gi = green * STRETCH_LUT_STEP;
      let bi = blue * STRETCH_LUT_STEP;
      ri = ri <= 0 ? 0 : ri >= STRETCH_LUT_SIZE ? STRETCH_LUT_SIZE : ri | 0;
      gi = gi <= 0 ? 0 : gi >= STRETCH_LUT_SIZE ? STRETCH_LUT_SIZE : gi | 0;
      bi = bi <= 0 ? 0 : bi >= STRETCH_LUT_SIZE ? STRETCH_LUT_SIZE : bi | 0;
      const outIdx = i * 4;
      out[outIdx] = lut[ri];
      out[outIdx + 1] = lut[gi];
      out[outIdx + 2] = lut[bi];
      out[outIdx + 3] = 255;
    }
  }
  if (showFlagsOverlay) applyFlagsOverlay(out, flags);
  return out;
}

/**
 * Render a signed Pass B minus Pass A difference image into `out`.
 *
 * @param epochBuffers - Cached multi-epoch detector planes.
 * @param passAIndex - Reference epoch index.
 * @param passBIndex - Comparison epoch index.
 * @param weights - Per-detector wavelength Dim & Pop weights.
 * @param lut - Precomputed 8-bit contrast stretch lookup table.
 * @param flags - Optional 256x256 hygiene flag mask for tinting.
 * @param showFlagsOverlay - Whether to tint flagged pixels.
 * @param out - Target 256x256x4 RGBA byte buffer.
 * @returns Populated `out` buffer.
 */
function renderSubtractFrame(
  epochBuffers: ReadonlyArray<ReadonlyArray<Float32Array>>,
  passAIndex: number,
  passBIndex: number,
  weights: DetectorWeights,
  lut: Uint8Array,
  flags: Uint8Array | null | undefined,
  showFlagsOverlay: boolean,
  out: Uint8ClampedArray,
): Uint8ClampedArray {
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
    out[outIdx + 3] = 255;
  }
  if (showFlagsOverlay) applyFlagsOverlay(out, flags);
  return out;
}

/**
 * Render cached multi-epoch detector planes into a 256x256 RGBA byte buffer.
 *
 * The returned array (or caller-provided `outBuffer`) can be wrapped directly:
 * `ctx.putImageData(new ImageData(rgba, 256, 256), 0, 0)`
 *
 * @param params - Rendering parameters, epoch buffers, wavelength window, and optional `outBuffer`.
 * @returns Populated 256x256x4 RGBA `Uint8ClampedArray`.
 * @throws {RangeError} When `params.outBuffer` does not have length `262,144`.
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
    outBuffer,
  } = params;

  const out = resolveOutputBuffer(outBuffer);

  if (!epochBuffers || epochBuffers.length === 0) {
    return fillEmptyFrame(out);
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
    return renderSubtractFrame(
      epochBuffers,
      passA,
      passB,
      weights,
      lut,
      flags,
      showFlagsOverlay,
      out,
    );
  }

  if (comparisonMode === 'coadd') {
    const indices = selectedCoaddIndices(epochBuffers, coaddIndices);
    const flags = showFlagsOverlay ? combineCoaddFlags(flagsBuffers, indices) : null;
    return renderColorFrame(epochBuffers, indices, weights, lut, flags, showFlagsOverlay, out);
  }

  const flags = flagsBuffers?.[activeIdx];
  return renderColorFrame(epochBuffers, [activeIdx], weights, lut, flags, showFlagsOverlay, out);
}

export { computeDetectorWeights };

/**
 * Create a browser `ImageData` object directly from rendered epoch buffers.
 *
 * @param params - Rendering parameters passed to {@link renderEpochBuffersToRgba}.
 * @returns A 256x256 `ImageData` instance.
 * @throws {Error} Outside a DOM-capable runtime where `ImageData` is undefined.
 */
export function renderEpochBuffersToImageData(params: PixelEngineRenderParams): ImageData {
  if (typeof ImageData === 'undefined') {
    throw new Error('ImageData is not available in this runtime; use renderEpochBuffersToRgba.');
  }
  const rgba = renderEpochBuffersToRgba(params) as Uint8ClampedArray<ArrayBuffer>;
  return new ImageData(rgba, GRID_WIDTH, GRID_HEIGHT);
}

/** Number of detector planes expected in a cached epoch. */
export const PIXEL_ENGINE_DETECTOR_COUNT = NUM_DETECTORS;

/** Wavelength-weighted flux, 3x3 spatial variance, and hygiene flag readout at a single pixel. */
export interface LocalPixelReadout {
  x: number;
  y: number;
  flux: number;
  variance: number;
  flagByte: number;
}

/**
 * Sample wavelength-weighted local flux and 3x3 spatial variance at pixel `(px, py)`
 * for hover inspection over the 256x256 SPHEREx scientific plane.
 *
 * @param params - Target buffers, active epoch, wavelength range, and pixel coordinates.
 * @returns Clamped integer pixel coordinates, weighted center flux, 3x3 variance, and flag byte.
 */
export function computeLocalPixelReadout(params: {
  epochBuffers: Float32Array[][] | null;
  flagsBuffers?: Uint8Array[] | null;
  activeEpochIndex?: number;
  wavelengthRangeUm?: [number, number];
  px: number;
  py: number;
}): LocalPixelReadout {
  const {
    epochBuffers,
    flagsBuffers,
    activeEpochIndex = 0,
    wavelengthRangeUm = [0.75, 5.0],
    px,
    py,
  } = params;

  const ix = Math.max(0, Math.min(GRID_WIDTH - 1, Math.floor(px)));
  const iy = Math.max(0, Math.min(GRID_HEIGHT - 1, Math.floor(py)));

  if (!epochBuffers || epochBuffers.length === 0) {
    return { x: ix, y: iy, flux: 0, variance: 0, flagByte: 0 };
  }

  const activeIdx = clampEpochIndex(activeEpochIndex, epochBuffers.length);
  const planes = epochBuffers[activeIdx];
  const flags = flagsBuffers?.[activeIdx];
  const weights = normaliseWeights(wavelengthRangeUm);

  const sampleFluxAt = (sx: number, sy: number): number => {
    const idx = sy * GRID_WIDTH + sx;
    let total = 0;
    let weightSum = 0;
    for (let d = 0; d < NUM_DETECTORS; d += 1) {
      const plane = planes[d];
      if (!plane) continue;
      const w = weights[d];
      const v = plane[idx];
      if (Number.isFinite(v)) {
        total += w * v;
        weightSum += w;
      }
    }
    return weightSum > 0 ? total / weightSum : 0;
  };

  const centerFlux = sampleFluxAt(ix, iy);
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    const sy = Math.max(0, Math.min(GRID_HEIGHT - 1, iy + dy));
    for (let dx = -1; dx <= 1; dx += 1) {
      const sx = Math.max(0, Math.min(GRID_WIDTH - 1, ix + dx));
      const v = sampleFluxAt(sx, sy);
      sum += v;
      sumSq += v * v;
      count += 1;
    }
  }
  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  const flagByte = flags ? flags[iy * GRID_WIDTH + ix] : 0;

  return {
    x: ix,
    y: iy,
    flux: centerFlux,
    variance,
    flagByte,
  };
}
