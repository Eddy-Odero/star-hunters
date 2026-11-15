/**
 * Binary frame decoders for SPHEREx 6-detector cubes (`float32` / 3G `float16`)
 * and 8-bit 256x256 pixel hygiene flag masks.
 *
 * Kept React-free so Node 24's `node --test` executes this module directly.
 */

import {
  BINARY_DETECTOR_FLOAT16_BYTES,
  BINARY_DETECTOR_FLOAT32_BYTES,
  BINARY_FLAGS_UINT8_BYTES,
  NUM_DETECTORS,
  PIXELS_PER_PLANE,
  TOTAL_DETECTOR_VALUES,
  type BinaryDtype,
} from '../types/contracts.ts';

/**
 * Decode an IEEE 754 binary16 (`uint16` bit pattern) into a JavaScript `number`.
 *
 * Preserves signed zero (`-0`), subnormal values, `Infinity`, `-Infinity`, and `NaN`.
 *
 * @param bits - Unsigned 16-bit integer representing an IEEE 754 half-precision float.
 * @returns Decoded JavaScript floating-point number.
 */
export function decodeFloat16Word(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x03ff;
  if (exp === 0) {
    return frac === 0 ? sign * 0 : sign * Math.pow(2, -14) * (frac / 1024);
  }
  if (exp === 0x1f) {
    return frac === 0 ? sign * Infinity : NaN;
  }
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

/**
 * Lazily-built 65,536-entry lookup table so decoding a 786,432-byte `float16`
 * frame is a tight array lookup loop rather than 393,216 branch-heavy calls.
 */
let float16LookupTable: Float32Array | null = null;

function getFloat16LookupTable(): Float32Array {
  if (float16LookupTable) return float16LookupTable;
  const table = new Float32Array(0x10000);
  for (let bits = 0; bits < 0x10000; bits += 1) {
    table[bits] = decodeFloat16Word(bits);
  }
  float16LookupTable = table;
  return table;
}

/**
 * Decode a raw `pass_{N}.bin` `ArrayBuffer` (either `float32` or 3G-compressed
 * `float16`) into 6 per-detector `Float32Array` planes of length `65,536` (256x256).
 *
 * @param buffer - Raw binary detector cube payload.
 * @param dtype - Wire precision hint (`'float32'` or `'float16'`); automatically
 *   detects `float16` when `buffer.byteLength === 786,432`.
 * @returns Six `Float32Array` views ordered from Detector 1 to Detector 6.
 * @throws {Error} When `buffer.byteLength` does not match the expected byte count.
 */
export function decodeDetectorBinaryBuffer(
  buffer: ArrayBuffer,
  dtype: BinaryDtype = 'float32',
): Float32Array[] {
  let fullArray: Float32Array;
  if (dtype === 'float16' || buffer.byteLength === BINARY_DETECTOR_FLOAT16_BYTES) {
    if (buffer.byteLength !== BINARY_DETECTOR_FLOAT16_BYTES) {
      throw new Error(
        `Invalid float16 detector buffer length: expected ${BINARY_DETECTOR_FLOAT16_BYTES}, got ${buffer.byteLength}`,
      );
    }
    const words = new Uint16Array(buffer);
    const table = getFloat16LookupTable();
    fullArray = new Float32Array(TOTAL_DETECTOR_VALUES);
    for (let i = 0; i < TOTAL_DETECTOR_VALUES; i += 1) {
      fullArray[i] = table[words[i]];
    }
  } else {
    if (buffer.byteLength !== BINARY_DETECTOR_FLOAT32_BYTES) {
      throw new Error(
        `Invalid float32 detector buffer length: expected ${BINARY_DETECTOR_FLOAT32_BYTES}, got ${buffer.byteLength}`,
      );
    }
    fullArray = new Float32Array(buffer);
  }

  const planes: Float32Array[] = [];
  for (let d = 0; d < NUM_DETECTORS; d += 1) {
    const start = d * PIXELS_PER_PLANE;
    planes.push(fullArray.subarray(start, start + PIXELS_PER_PLANE));
  }
  return planes;
}

/**
 * Decode a raw `pass_{N}_flags.bin` `ArrayBuffer` into a 256x256 `Uint8Array` hygiene mask.
 *
 * @param buffer - Raw 65,536-byte hygiene flag payload.
 * @returns 256x256 `Uint8Array` hygiene bitmask.
 * @throws {Error} When `buffer.byteLength !== 65,536`.
 */
export function decodeFlagsBinaryBuffer(buffer: ArrayBuffer): Uint8Array {
  if (buffer.byteLength !== BINARY_FLAGS_UINT8_BYTES) {
    throw new Error(
      `Invalid flags buffer length: expected ${BINARY_FLAGS_UINT8_BYTES}, got ${buffer.byteLength}`,
    );
  }
  return new Uint8Array(buffer);
}
