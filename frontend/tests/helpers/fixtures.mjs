import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  decodeDetectorBinaryBuffer,
  decodeFlagsBinaryBuffer,
} from '../../src/utils/binaryDecoder.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the static benchmark preset fixtures directory. */
export const PRESETS_DIR = path.resolve(__dirname, '../../public/presets');

/** Canonical list of preset directory slugs discovered under {@link PRESETS_DIR}. */
export const PRESET_SLUGS = fs
  .readdirSync(PRESETS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/**
 * Read a binary file from disk into a standalone `ArrayBuffer` slice.
 *
 * @param {string} filePath - Absolute path to the binary file.
 * @returns {ArrayBuffer} Exact byte slice backed by a fresh `ArrayBuffer`.
 */
export function readArrayBuffer(filePath) {
  const buf = fs.readFileSync(filePath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Load and parse `manifest.json` for a static preset slug.
 *
 * @param {string} slug - Preset directory slug (e.g., `'wise_0855'`).
 * @returns {Record<string, any>} Parsed `SkyPatchManifest` object.
 */
export function readPresetManifest(slug) {
  return JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, slug, 'manifest.json'), 'utf-8'));
}

/**
 * Load `catalog_overlays.known_objects` for a static preset slug.
 *
 * @param {string} slug - Preset directory slug.
 * @returns {Array<Record<string, any>>} Array of `KnownCelestialObject` records.
 */
export function readPresetKnownObjects(slug) {
  return readPresetManifest(slug).catalog_overlays.known_objects;
}

/**
 * Load and parse `spectrum.json` for a static preset slug.
 *
 * @param {string} slug - Preset directory slug.
 * @returns {Record<string, any>} Parsed `SpectrumPayload` object.
 */
export function readPresetSpectrum(slug) {
  return JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, slug, 'spectrum.json'), 'utf-8'));
}

/**
 * Load and decode all epoch detector cubes and flags masks for a static preset.
 *
 * @param {string} slug - Preset directory slug.
 * @returns {{ manifest: Record<string, any>, epochBuffers: Float32Array[][], flagsBuffers: Uint8Array[] }}
 * Decoded preset manifest, 6-plane detector buffers per epoch, and 8-bit flags masks.
 */
export function loadPresetEpochAndFlags(slug) {
  const manifest = readPresetManifest(slug);
  const epochBuffers = manifest.epochs.map((ep) => {
    const raw = readArrayBuffer(path.join(PRESETS_DIR, slug, path.basename(ep.detectors_data_url)));
    return decodeDetectorBinaryBuffer(raw, ep.binary_dtype);
  });
  const flagsBuffers = manifest.epochs.map((ep) => {
    const raw = readArrayBuffer(path.join(PRESETS_DIR, slug, path.basename(ep.flags_mask_url)));
    return decodeFlagsBinaryBuffer(raw);
  });
  return { manifest, epochBuffers, flagsBuffers };
}

/**
 * Build a 3-epoch manifest derived from a base manifest with cleared `known_objects`
 * for controlled multi-epoch tracking and overlap tests.
 *
 * @param {Record<string, any>} baseManifest - Source manifest to clone.
 * @returns {Record<string, any>} Cloned manifest with `pass_1`, `pass_2`, and `pass_3`.
 */
export function makeThreeEpochManifest(baseManifest) {
  return {
    ...baseManifest,
    catalog_overlays: { ...baseManifest.catalog_overlays, known_objects: [] },
    epochs: [
      { ...baseManifest.epochs[0], epoch_id: 'pass_1', mjd: 60600.0 },
      { ...baseManifest.epochs[1], epoch_id: 'pass_2', mjd: 60800.0 },
      { ...baseManifest.epochs[1], epoch_id: 'pass_3', mjd: 61000.0 },
    ],
  };
}

/**
 * Stamp 2D Gaussian point sources additively onto a single 256x256 detector plane.
 *
 * @param {Float32Array} plane - Target 256x256 detector plane buffer.
 * @param {Array<{ x: number, y: number, peak?: number, sigma?: number }>} sources - Point sources to stamp.
 */
function stampGaussianSources(plane, sources) {
  for (const src of sources) {
    const { x: cx, y: cy, peak = 8.0, sigma = 1.6 } = src;
    const twoSigmaSq = 2.0 * sigma * sigma;
    const yMin = Math.max(0, Math.floor(cy - 6));
    const yMax = Math.min(255, Math.ceil(cy + 6));
    const xMin = Math.max(0, Math.floor(cx - 6));
    const xMax = Math.min(255, Math.ceil(cx + 6));
    for (let py = yMin; py <= yMax; py += 1) {
      for (let px = xMin; px <= xMax; px += 1) {
        const r2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
        plane[py * 256 + px] += peak * Math.exp(-r2 / twoSigmaSq);
      }
    }
  }
}

/**
 * Synthesize 6 identical 256x256 detector planes filled with seeded Gaussian sky
 * noise plus optional 2D Gaussian point sources.
 *
 * @param {Array<{ x: number, y: number, peak?: number, sigma?: number }>} [sources] - Point sources to stamp.
 * @param {number} [bgLevel] - Mean background flux level.
 * @param {number} [noiseSigma] - Standard deviation of Box-Muller background noise.
 * @param {number} [seed] - Deterministic LCG PRNG seed.
 * @returns {Float32Array[]} Six 256x256 detector planes.
 */
export function makeSeededNoiseEpochPlanes(
  sources = [],
  bgLevel = 0.02,
  noiseSigma = 0.02,
  seed = 12345,
) {
  const planes = [];
  let state = seed >>> 0;
  const nextRandom = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  for (let d = 0; d < 6; d += 1) {
    const plane = new Float32Array(256 * 256);
    for (let i = 0; i < plane.length; i += 1) {
      const u1 = Math.max(1e-9, nextRandom());
      const u2 = nextRandom();
      const gaussian = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      plane[i] = bgLevel + noiseSigma * gaussian;
    }
    stampGaussianSources(plane, sources);
    planes.push(plane);
  }
  return planes;
}

/**
 * Synthesize 6 identical 256x256 detector planes with a flat background and
 * stamped 2D Gaussian point sources.
 *
 * @param {Array<{ x: number, y: number, peak?: number, sigma?: number }>} sources - Point sources to stamp.
 * @param {number} [bgLevel] - Uniform background flux level.
 * @returns {Float32Array[]} Six 256x256 detector planes.
 */
export function makeGaussianEpochPlanes(sources, bgLevel = 0.02) {
  const planes = [];
  for (let d = 0; d < 6; d += 1) {
    const plane = new Float32Array(256 * 256);
    plane.fill(bgLevel);
    stampGaussianSources(plane, sources);
    planes.push(plane);
  }
  return planes;
}
