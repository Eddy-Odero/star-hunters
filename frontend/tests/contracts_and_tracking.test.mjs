import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BINARY_DETECTOR_FLOAT16_BYTES,
  BINARY_DETECTOR_FLOAT32_BYTES,
  BINARY_FLAGS_UINT8_BYTES,
  DEFAULT_MOLECULAR_BANDS,
  TRACKING_SQUARE_COLORS,
  WORLD_CAPITAL_CITIES,
} from '../src/types/contracts.ts';
import * as ContractsModule from '../src/types/contracts.ts';
import { readStoredNumber } from '../src/hooks/useResizableSplit.ts';
import {
  decodeDetectorBinaryBuffer,
  decodeFlagsBinaryBuffer,
  decodeFloat16Word,
} from '../src/utils/binaryDecoder.ts';
import {
  detectAndTrackBodiesAtClick,
  detectAndTrackBrightBodyAcrossEpochs,
  mergeTrackedTargets,
} from '../src/utils/clickTracker.ts';
import {
  clampViewportPanZoom,
  computeDetectorWeights,
  computeGridKey,
  computeViewportViewBox,
  pixelToSkyWcs,
  quantizeGridCenter,
  screenToImageCoordinates,
} from '../src/utils/wcsViewport.ts';
import {
  ClientPatchCache,
  gridCacheKey,
  presetCacheKey,
} from '../src/services/clientPatchCache.ts';
import {
  loadLiveCoordinatesFlow,
  loadPresetPatchFlow,
} from '../src/services/progressivePatchLoader.ts';
import { formatSpectrumCsv } from '../src/utils/csvExport.ts';
import {
  WAVELENGTH_PRESETS,
  assignDeterministicHighlighterColors,
  catalogBadgeLabel,
  clearCheckedObjectIds,
  extractAvailableMissions,
  formatMagnitude,
  formatProperMotion,
  fuzzyScoreText,
  fuzzySearchKnownObjects,
  getDefaultCheckedObjectIds,
  inferObjectClass,
  isMovingSolarSystemObject,
  isWavelengthPresetActive,
  objectClassBadgeLabel,
  pickDistinctHighlighterColors,
  pickNearestAllowedEpoch,
  resolveFilteredEpochIndices,
  selectAllObjectIds,
  toggleObjectId,
} from '../src/utils/knownObjectSelection.ts';
import {
  URL_STATE_DEFAULTS,
  parseUrlState,
  replaceUrlState,
  serializeUrlState,
} from '../src/utils/urlStateSync.ts';
import {
  applyContrastStretch,
  computeLocalPixelReadout,
  renderEpochBuffersToRgba,
} from '../src/utils/pixelEngine.ts';
import {
  angularSeparationDeg,
  computeMagneticSnap,
  decodeHygieneFlagMask,
  formatImageProvenanceBadge,
  formatRaDecCompact,
  getMarkerShapeKind,
  isObjectInPatchViewBox,
  isObjectInSkyFrustum,
  parseSkySearchInput,
  resolvePositionFromAnchor,
  sortKnownObjectsCheckedFirst,
} from '../src/utils/observatoryMath.ts';
import {
  computeSmartCalloutLayout,
  HOVER_DETAILS_DELAY_MS,
} from '../src/utils/calloutPlacement.ts';
import {
  CDS_MIRROR_SPHEREX_COLOR_HIPS_URL,
  CDS_SPHEREX_COLOR_HIPS_URL,
  IRSA_2MASS_HIPS_URL,
  IRSA_SPHEREX_CUBE_HIPS_URL,
  SUPPORTED_GLOBE_PROJECTIONS,
  buildVisibleSkyPanels,
  clampGlobeFov,
  resolveBestDeepSkyHiPS,
  resolveGlobeClickAction,
  resolveGlobeLodTier,
  stepPanCoordinates,
  targetFovForClickAction,
} from '../src/utils/globeNavigation.ts';
import { ObservatoryLogger } from '../src/utils/observatoryLogger.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRESETS_DIR = path.resolve(__dirname, '../public/presets');

function readArrayBuffer(filePath) {
  const buf = fs.readFileSync(filePath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function makeSeededNoiseEpochPlanes(sources = [], bgLevel = 0.02, noiseSigma = 0.02, seed = 12345) {
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
    planes.push(plane);
  }
  return planes;
}

function makeGaussianEpochPlanes(sources, bgLevel = 0.02) {
  const planes = [];
  for (let d = 0; d < 6; d += 1) {
    const plane = new Float32Array(256 * 256);
    plane.fill(bgLevel);
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
    planes.push(plane);
  }
  return planes;
}

test('Preset manifests, KnownCelestialObjects, and binary buffers match Phase 0 contracts', () => {
  const slugs = [
    'wise_0855',
    'barnards_star',
    'epsilon_indi_b',
    'rw_aurigae',
    'r_draconis',
    'comet_3i_atlas',
  ];

  for (const slug of slugs) {
    const manifestPath = path.join(PRESETS_DIR, slug, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    assert.equal(manifest.target_metadata.slug, slug);
    assert.equal(manifest.wcs.width, 256);
    assert.equal(manifest.wcs.height, 256);
    assert.ok(Array.isArray(manifest.catalog_overlays.known_objects));
    assert.ok(manifest.catalog_overlays.known_objects.length >= 2);

    const defaultChecked = getDefaultCheckedObjectIds(manifest.catalog_overlays.known_objects);
    assert.ok(defaultChecked.length >= 1, `Expected at least 1 default_checked object in ${slug}`);
    assert.ok(
      defaultChecked.length < manifest.catalog_overlays.known_objects.length,
      `Expected stationary background stars to have default_checked=false in ${slug}`,
    );

    const p1Buf = readArrayBuffer(path.join(PRESETS_DIR, slug, 'pass_1.bin'));
    assert.equal(p1Buf.byteLength, BINARY_DETECTOR_FLOAT32_BYTES);
    const planes = decodeDetectorBinaryBuffer(p1Buf, 'float32');
    assert.equal(planes.length, 6);
    assert.equal(planes[0].length, 256 * 256);

    const f1Buf = readArrayBuffer(path.join(PRESETS_DIR, slug, 'pass_1_flags.bin'));
    assert.equal(f1Buf.byteLength, BINARY_FLAGS_UINT8_BYTES);
    const flags = decodeFlagsBinaryBuffer(f1Buf);
    assert.equal(flags.length, 256 * 256);
  }
});

test('Float16 3G binary detector buffer decoding produces finite 6x256x256 Float32Array planes', () => {
  const words = new Uint16Array(6 * 256 * 256);
  // 0x3C00 is IEEE 754 float16 for 1.0
  words.fill(0x3c00);
  const decoded = decodeDetectorBinaryBuffer(words.buffer, 'float16');
  assert.equal(decoded.length, 6);
  assert.equal(decoded[0][0], 1.0);
  assert.equal(decoded[5][65535], 1.0);

  assert.throws(() => decodeDetectorBinaryBuffer(new ArrayBuffer(128), 'float16'));
  assert.throws(() => decodeDetectorBinaryBuffer(new ArrayBuffer(128), 'float32'));
});

test('ISS-10: decodeFloat16Word matches IEEE-754 binary16 reference values including subnormals, infinity and NaN', () => {
  assert.equal(decodeFloat16Word(0x0000), 0);
  assert.ok(Object.is(decodeFloat16Word(0x8000), -0));
  assert.equal(decodeFloat16Word(0x3c00), 1.0);
  assert.equal(decodeFloat16Word(0xbc00), -1.0);
  assert.equal(decodeFloat16Word(0x4000), 2.0);
  assert.equal(decodeFloat16Word(0xc000), -2.0);
  assert.equal(decodeFloat16Word(0x3800), 0.5);
  assert.equal(decodeFloat16Word(0x7bff), 65504);
  // Smallest positive subnormal: 2^-24
  assert.equal(decodeFloat16Word(0x0001), Math.pow(2, -24));
  // 0x3555 => (1 + 341/1024) * 2^-2
  assert.equal(decodeFloat16Word(0x3555), (1 + 341 / 1024) * 0.25);
  assert.equal(decodeFloat16Word(0x7c00), Infinity);
  assert.equal(decodeFloat16Word(0xfc00), -Infinity);
  assert.ok(Number.isNaN(decodeFloat16Word(0x7e00)));
  assert.equal(BINARY_DETECTOR_FLOAT16_BYTES, 786432);
  assert.equal(BINARY_DETECTOR_FLOAT32_BYTES, 1572864);
});

test('ISS-10: decodeDetectorBinaryBuffer decodes both 786,432 B float16 and 1,572,864 B float32 wire frames into Float32Array[6]', () => {
  const words = new Uint16Array(6 * 256 * 256);
  const pattern = [0x0000, 0x3c00, 0xbc00, 0x4000, 0x3800, 0x7bff, 0x0001, 0xc000];
  for (let i = 0; i < words.length; i += 1) {
    words[i] = pattern[i % pattern.length];
  }

  const float16Buffer = words.buffer;
  assert.equal(float16Buffer.byteLength, BINARY_DETECTOR_FLOAT16_BYTES);
  const decoded16 = decodeDetectorBinaryBuffer(float16Buffer, 'float16');
  assert.equal(decoded16.length, 6);
  assert.ok(decoded16.every((plane) => plane instanceof Float32Array));
  assert.ok(decoded16.every((plane) => plane.length === 256 * 256));
  // First and last values of every plane follow the exact same pattern.
  for (const plane of decoded16) {
    assert.equal(plane[0], 0);
    assert.equal(plane[1], 1);
    assert.equal(plane[2], -1);
    assert.equal(plane[65535], decodeFloat16Word(pattern[65535 % pattern.length]));
  }
  // Auto-detection by wire size also works when no dtype hint is supplied.
  const autoDecoded = decodeDetectorBinaryBuffer(float16Buffer);
  assert.equal(autoDecoded[3][1000], decodeFloat16Word(pattern[1000 % pattern.length]));

  const float32 = new Float32Array(6 * 256 * 256);
  for (let i = 0; i < float32.length; i += 1) {
    float32[i] = (i % 17) - 8 + 0.25;
  }
  assert.equal(float32.buffer.byteLength, BINARY_DETECTOR_FLOAT32_BYTES);
  const decoded32 = decodeDetectorBinaryBuffer(float32.buffer, 'float32');
  assert.equal(decoded32.length, 6);
  assert.ok(decoded32.every((plane) => plane.length === 256 * 256));
  assert.equal(decoded32[0][0], -7.75);
  assert.equal(decoded32[0][16], 8.25);
  assert.equal(decoded32[5][65535], float32[5 * 65536 + 65535]);
  // Planes reference the correct detector slices in the raw frame.
  assert.equal(decoded32[1][0], float32[65536]);
  assert.equal(decoded32[5][0], float32[5 * 65536]);

  assert.throws(() => decodeDetectorBinaryBuffer(new ArrayBuffer(786431), 'float16'));
  assert.throws(() => decodeDetectorBinaryBuffer(new ArrayBuffer(1572863), 'float32'));
});

test('Wavelength Dim & Pop detector weights isolate cold IR detectors (3.8 - 5.0 um)', () => {
  const coldWeights = computeDetectorWeights([3.8, 5.0]);
  // Detectors 1..4 (indices 0..3) are at the 5% floor, Detectors 5..6 (indices 4..5) are at 100%
  assert.ok(Math.abs(coldWeights[0] - 0.05) < 1e-6);
  assert.ok(Math.abs(coldWeights[2] - 0.05) < 1e-6);
  assert.ok(Math.abs(coldWeights[4] - 1.0) < 1e-6);
  assert.ok(Math.abs(coldWeights[5] - 1.0) < 1e-6);
});

test('ISS-11: subtracting an epoch from itself produces a uniform neutral background', () => {
  const epoch = makeGaussianEpochPlanes([{ x: 72, y: 88, peak: 9.0, sigma: 1.7 }]);
  const rgba = renderEpochBuffersToRgba({
    epochBuffers: [epoch],
    comparisonMode: 'subtract',
    passAIndex: 0,
    passBIndex: 0,
    contrastStretch: 'asinh',
    wavelengthRangeUm: [0.75, 5.0],
  });

  let nonNeutralPixels = 0;
  for (let i = 0; i < 256 * 256; i += 1) {
    const outIdx = i * 4;
    if (
      rgba[outIdx] !== 0 ||
      rgba[outIdx + 1] !== 0 ||
      rgba[outIdx + 2] !== 0 ||
      rgba[outIdx + 3] !== 255
    ) {
      nonNeutralPixels += 1;
    }
  }
  assert.equal(nonNeutralPixels, 0);
});

test('ISS-11: cold wavelength window dims D1-D3 by >=90% and preserves D5-D6 at full intensity', () => {
  const epoch = Array.from({ length: 6 }, () => {
    const plane = new Float32Array(256 * 256);
    plane.fill(0.01);
    return plane;
  });
  const addSpot = (plane, x, y, peak, sigma = 1.5) => {
    const twoSigmaSq = 2 * sigma * sigma;
    for (let py = Math.max(0, y - 6); py <= Math.min(255, y + 6); py += 1) {
      for (let px = Math.max(0, x - 6); px <= Math.min(255, x + 6); px += 1) {
        const r2 = (px - x) * (px - x) + (py - y) * (py - y);
        plane[py * 256 + px] += peak * Math.exp(-r2 / twoSigmaSq);
      }
    }
  };

  // Hot short-wavelength star: detectors D1-D3 (indices 0..2).
  addSpot(epoch[0], 64, 64, 8.0);
  addSpot(epoch[1], 64, 64, 8.0);
  addSpot(epoch[2], 64, 64, 8.0);
  // Cold brown dwarf: detectors D5-D6 (indices 4..5).
  addSpot(epoch[4], 192, 192, 8.0);
  addSpot(epoch[5], 192, 192, 8.0);

  const renderAt = (wavelengthRangeUm, contrastStretch) =>
    renderEpochBuffersToRgba({
      epochBuffers: [epoch],
      activeEpochIndex: 0,
      comparisonMode: 'blink',
      contrastStretch,
      wavelengthRangeUm,
    });

  const hotIndex = (64 * 256 + 64) * 4;
  const coldIndex = (192 * 256 + 192) * 4;

  for (const contrastStretch of ['asinh', 'linear', 'zscale']) {
    const fullRange = renderAt([0.75, 5.0], contrastStretch);
    const coldRange = renderAt([3.8, 5.0], contrastStretch);

    // Blue channel of the hot star must dim by at least 90%.
    assert.ok(
      coldRange[hotIndex + 2] <= fullRange[hotIndex + 2] * 0.1,
      `Expected hot-star blue ${coldRange[hotIndex + 2]} <= 10% of ${fullRange[hotIndex + 2]} (${contrastStretch})`,
    );
    // Green channel (D3) dims as well.
    assert.ok(coldRange[hotIndex + 1] <= fullRange[hotIndex + 1] * 0.1);

    // The cold brown dwarf's red channel is untouched by the wavelength window.
    assert.equal(coldRange[coldIndex], fullRange[coldIndex]);
    assert.ok(coldRange[coldIndex] > 240);
  }
});

test('ISS-11: blink, subtract and coadd combine cached epochs and flag bits tint the frame', () => {
  const passA = makeGaussianEpochPlanes([{ x: 60, y: 60, peak: 7.0 }], 0.005);
  const passB = makeGaussianEpochPlanes([{ x: 180, y: 180, peak: 7.0 }], 0.005);

  const blinkA = renderEpochBuffersToRgba({
    epochBuffers: [passA, passB],
    activeEpochIndex: 0,
    comparisonMode: 'blink',
    wavelengthRangeUm: [0.75, 5.0],
  });
  const blinkB = renderEpochBuffersToRgba({
    epochBuffers: [passA, passB],
    activeEpochIndex: 1,
    comparisonMode: 'blink',
    wavelengthRangeUm: [0.75, 5.0],
  });
  assert.ok(blinkA[(60 * 256 + 60) * 4] > 0);
  assert.equal(blinkB[(60 * 256 + 60) * 4], 0);

  // Pass B - Pass A: the source at (180,180) is a positive (warm) residual,
  // the source at (60,60) is a negative (cool) residual.
  const positive = renderEpochBuffersToRgba({
    epochBuffers: [passA, passB],
    comparisonMode: 'subtract',
    passAIndex: 0,
    passBIndex: 1,
    wavelengthRangeUm: [0.75, 5.0],
  });
  const positiveIdx = (180 * 256 + 180) * 4;
  const negativeIdx = (60 * 256 + 60) * 4;
  assert.ok(positive[positiveIdx] > positive[positiveIdx + 2]);
  // The same Pass B - Pass A frame also exposes the source that disappeared
  // from (60,60) as a cool cyan/blue residual.
  assert.ok(positive[negativeIdx + 2] > positive[negativeIdx]);

  // Co-add averages both passes, so both sources remain visible.
  const coadd = renderEpochBuffersToRgba({
    epochBuffers: [passA, passB],
    comparisonMode: 'coadd',
    coaddIndices: [0, 1],
    wavelengthRangeUm: [0.75, 5.0],
  });
  assert.ok(coadd[(60 * 256 + 60) * 4] > 0);
  assert.ok(coadd[(180 * 256 + 180) * 4] > 0);

  // Optional flags overlay tints masked pixels magenta/amber.
  const flags = new Uint8Array(256 * 256);
  flags[60 * 256 + 60] = 0x01;
  flags[60 * 256 + 61] = 0x02;
  const noFlags = renderEpochBuffersToRgba({
    epochBuffers: [passA],
    activeEpochIndex: 0,
    comparisonMode: 'blink',
    wavelengthRangeUm: [0.75, 5.0],
    flagsBuffers: [flags],
    showFlagsOverlay: false,
  });
  const withFlags = renderEpochBuffersToRgba({
    epochBuffers: [passA],
    activeEpochIndex: 0,
    comparisonMode: 'blink',
    wavelengthRangeUm: [0.75, 5.0],
    flagsBuffers: [flags],
    showFlagsOverlay: true,
  });
  assert.notDeepEqual(
    Array.from(withFlags.slice(60 * 256 * 4, 62 * 256 * 4)),
    Array.from(noFlags.slice(60 * 256 * 4, 62 * 256 * 4)),
  );
});

test('ISS-11: rendering a 256x256 RGBA frame completes in <5 ms', () => {
  const passA = makeGaussianEpochPlanes([
    { x: 64, y: 64, peak: 8.0 },
    { x: 190, y: 120, peak: 5.0 },
  ]);
  const passB = makeGaussianEpochPlanes([
    { x: 74, y: 70, peak: 8.0 },
    { x: 190, y: 120, peak: 5.0 },
  ]);
  const params = {
    epochBuffers: [passA, passB],
    comparisonMode: 'coadd',
    coaddIndices: [0, 1],
    contrastStretch: 'asinh',
    wavelengthRangeUm: [0.75, 5.0],
  };

  // Warm the JIT so the measurement reflects steady-state per-frame cost.
  for (let i = 0; i < 30; i += 1) {
    renderEpochBuffersToRgba(params);
  }
  const iterations = 50;
  const startedAt = performance.now();
  let last;
  for (let i = 0; i < iterations; i += 1) {
    last = renderEpochBuffersToRgba(params);
  }
  const averageMs = (performance.now() - startedAt) / iterations;
  assert.equal(last.length, 256 * 256 * 4);
  assert.ok(averageMs < 5.0, `Expected <5 ms per frame, measured ${averageMs.toFixed(2)} ms`);
});

test('ISS-11: contrast stretches are monotonic and clamped to [0, 1]', () => {
  for (const stretch of ['asinh', 'linear', 'zscale']) {
    assert.equal(applyContrastStretch(-3, stretch), 0);
    assert.equal(applyContrastStretch(1e6, stretch), 1);
    let previous = -1;
    for (let value = 0; value <= 12; value += 0.25) {
      const stretched = applyContrastStretch(value, stretch);
      assert.ok(stretched >= 0 && stretched <= 1);
      assert.ok(stretched >= previous);
      previous = stretched;
    }
  }
});

test('Click-to-Track detects bright body on origin frame and tracks both forward and backward across epochs', () => {
  const slug = 'wise_0855';
  const manifest = JSON.parse(
    fs.readFileSync(path.join(PRESETS_DIR, slug, 'manifest.json'), 'utf-8'),
  );
  const p1 = decodeDetectorBinaryBuffer(
    readArrayBuffer(path.join(PRESETS_DIR, slug, 'pass_1.bin')),
  );
  const p2 = decodeDetectorBinaryBuffer(
    readArrayBuffer(path.join(PRESETS_DIR, slug, 'pass_2.bin')),
  );
  const primary = manifest.catalog_overlays.known_objects.find((obj) =>
    obj.object_id.startsWith('wise:'),
  );
  const pass1Pos = primary.epoch_positions.find((pos) => pos.epoch_id === 'pass_1');
  const pass2Pos = primary.epoch_positions.find((pos) => pos.epoch_id === 'pass_2');

  // Case A: Click slightly off-center on Pass 1 (originEpochIndex = 0) -> tracks FORWARD to Pass 2
  const forwardTrace = detectAndTrackBrightBodyAcrossEpochs({
    clickX: pass1Pos.x - 1,
    clickY: pass1Pos.y - 1,
    originEpochIndex: 0,
    epochBuffers: [p1, p2],
    manifest,
    wavelengthRangeUm: [3.8, 5.0],
  });

  assert.equal(forwardTrace.status, 'tracked');
  assert.equal(forwardTrace.originEpochIndex, 0);
  assert.ok(
    Math.hypot(
      forwardTrace.originCentroidX - pass1Pos.x,
      forwardTrace.originCentroidY - pass1Pos.y,
    ) < 0.6,
  );
  assert.equal(forwardTrace.waypoints.length, 2);
  assert.ok(
    Math.hypot(forwardTrace.waypoints[0].x - pass1Pos.x, forwardTrace.waypoints[0].y - pass1Pos.y) <
      0.6,
  );
  assert.ok(
    Math.hypot(forwardTrace.waypoints[1].x - pass2Pos.x, forwardTrace.waypoints[1].y - pass2Pos.y) <
      0.8,
  );
  assert.ok(forwardTrace.properMotionArcsecPerYr > 5.0);
  assert.equal(forwardTrace.matchedCatalog, 'wise');
  assert.equal(forwardTrace.isUncatalogedMover, false);

  // Case B: Click slightly off-center on Pass 2 (originEpochIndex = 1) -> tracks BACKWARD to Pass 1
  const backwardTrace = detectAndTrackBrightBodyAcrossEpochs({
    clickX: pass2Pos.x + 1,
    clickY: pass2Pos.y + 1,
    originEpochIndex: 1,
    epochBuffers: [p1, p2],
    manifest,
    wavelengthRangeUm: [3.8, 5.0],
  });

  assert.equal(backwardTrace.status, 'tracked');
  assert.equal(backwardTrace.originEpochIndex, 1);
  assert.ok(
    Math.hypot(
      backwardTrace.originCentroidX - pass2Pos.x,
      backwardTrace.originCentroidY - pass2Pos.y,
    ) < 0.6,
  );
  assert.ok(
    Math.hypot(
      backwardTrace.waypoints[0].x - pass1Pos.x,
      backwardTrace.waypoints[0].y - pass1Pos.y,
    ) < 0.8,
  );
  assert.ok(
    Math.hypot(
      backwardTrace.waypoints[1].x - pass2Pos.x,
      backwardTrace.waypoints[1].y - pass2Pos.y,
    ) < 0.6,
  );
});

test('Click-to-Track on middle epoch (Pass 2 of 3) tracks both backward to Pass 1 and forward to Pass 3', () => {
  const slug = 'wise_0855';
  const baseManifest = JSON.parse(
    fs.readFileSync(path.join(PRESETS_DIR, slug, 'manifest.json'), 'utf-8'),
  );
  const manifest3 = {
    ...baseManifest,
    epochs: [
      { ...baseManifest.epochs[0], epoch_id: 'pass_1', mjd: 60600.0 },
      { ...baseManifest.epochs[1], epoch_id: 'pass_2', mjd: 60800.0 },
      { ...baseManifest.epochs[1], epoch_id: 'pass_3', mjd: 61000.0 },
    ],
  };

  const trace = detectAndTrackBrightBodyAcrossEpochs({
    clickX: 84,
    clickY: 82,
    originEpochIndex: 1, // Middle frame!
    epochBuffers: [
      makeGaussianEpochPlanes([{ x: 80, y: 80 }]),
      makeGaussianEpochPlanes([{ x: 85, y: 83 }]),
      makeGaussianEpochPlanes([{ x: 90, y: 86 }]),
    ],
    manifest: manifest3,
    wavelengthRangeUm: [0.75, 5.0],
  });

  assert.equal(trace.originEpochIndex, 1);
  assert.equal(trace.waypoints.length, 3);
  assert.ok(Math.hypot(trace.waypoints[0].x - 80, trace.waypoints[0].y - 80) < 0.5);
  assert.ok(Math.hypot(trace.waypoints[1].x - 85, trace.waypoints[1].y - 83) < 0.5);
  assert.ok(Math.hypot(trace.waypoints[2].x - 90, trace.waypoints[2].y - 86) < 0.5);
  assert.equal(trace.isUncatalogedMover, true);
});

test('Overlapped bodies at the moment of clicking are separated and tracked with different colored tracking squares', () => {
  const baseManifest = JSON.parse(
    fs.readFileSync(path.join(PRESETS_DIR, 'wise_0855', 'manifest.json'), 'utf-8'),
  );
  const manifest3 = {
    ...baseManifest,
    catalog_overlays: { ...baseManifest.catalog_overlays, known_objects: [] },
    epochs: [
      { ...baseManifest.epochs[0], epoch_id: 'pass_1', mjd: 60600.0 },
      { ...baseManifest.epochs[1], epoch_id: 'pass_2', mjd: 60800.0 },
      { ...baseManifest.epochs[1], epoch_id: 'pass_3', mjd: 61000.0 },
    ],
  };

  // Case 1: Two moving bodies cross/overlap at (100, 100) on Pass 2 (originEpochIndex = 1):
  // Body A: (92, 95) -> (100, 100) -> (108, 105)
  // Body B: (92, 105) -> (100, 100) -> (108, 95)
  const epochBuffersCrossing = [
    makeGaussianEpochPlanes([
      { x: 92, y: 95, peak: 9.0 },
      { x: 92, y: 105, peak: 8.5 },
    ]),
    makeGaussianEpochPlanes([{ x: 100, y: 100, peak: 14.0 }]),
    makeGaussianEpochPlanes([
      { x: 108, y: 105, peak: 9.0 },
      { x: 108, y: 95, peak: 8.5 },
    ]),
  ];

  const crossingRes = detectAndTrackBodiesAtClick({
    clickX: 100,
    clickY: 100,
    originEpochIndex: 1,
    epochBuffers: epochBuffersCrossing,
    manifest: manifest3,
    wavelengthRangeUm: [0.75, 5.0],
  });

  assert.equal(crossingRes.status, 'tracked');
  assert.equal(crossingRes.isOverlapped, true);
  assert.equal(crossingRes.tracks.length, 2);
  assert.notEqual(crossingRes.tracks[0].color, crossingRes.tracks[1].color);
  assert.equal(crossingRes.tracks[0].isOverlappedAtOrigin, true);
  assert.equal(crossingRes.tracks[1].isOverlappedAtOrigin, true);

  // Verify Branch A and Branch B trajectories across Pass 1, Pass 2, Pass 3
  const branchA = crossingRes.tracks.find((t) => t.waypoints[0].y < 100);
  const branchB = crossingRes.tracks.find((t) => t.waypoints[0].y > 100);
  assert.ok(branchA && branchB);
  assert.ok(Math.hypot(branchA.waypoints[0].x - 92, branchA.waypoints[0].y - 95) < 0.8);
  assert.ok(Math.hypot(branchA.waypoints[1].x - 100, branchA.waypoints[1].y - 100) < 0.8);
  assert.ok(Math.hypot(branchA.waypoints[2].x - 108, branchA.waypoints[2].y - 105) < 0.8);

  assert.ok(Math.hypot(branchB.waypoints[0].x - 92, branchB.waypoints[0].y - 105) < 0.8);
  assert.ok(Math.hypot(branchB.waypoints[1].x - 100, branchB.waypoints[1].y - 100) < 0.8);
  assert.ok(Math.hypot(branchB.waypoints[2].x - 108, branchB.waypoints[2].y - 95) < 0.8);

  // Case 2: Stationary star + moving body overlapped at (140, 140) on Pass 1 (originEpochIndex = 0)
  // that separate on Pass 2: stationary stays at (140, 140), mover shifts to (149, 144)
  const epochBuffersStatPlusMover = [
    makeGaussianEpochPlanes([{ x: 140, y: 140, peak: 12.0 }]),
    makeGaussianEpochPlanes([
      { x: 140, y: 140, peak: 6.5 },
      { x: 149, y: 144, peak: 7.5 },
    ]),
  ];
  const statPlusMoverRes = detectAndTrackBodiesAtClick({
    clickX: 140,
    clickY: 140,
    originEpochIndex: 0,
    epochBuffers: epochBuffersStatPlusMover,
    manifest: baseManifest,
    wavelengthRangeUm: [0.75, 5.0],
    colorIndexOffset: 2,
  });

  assert.equal(statPlusMoverRes.isOverlapped, true);
  assert.equal(statPlusMoverRes.tracks.length, 2);
  assert.equal(statPlusMoverRes.tracks[0].color, TRACKING_SQUARE_COLORS[2]);
  assert.equal(statPlusMoverRes.tracks[1].color, TRACKING_SQUARE_COLORS[3]);

  // Case 3: Partially-overlapped close bodies within the clicked area (localRadiusPx = 6) at originEpochIndex
  // Stationary star at (100, 100) + close moving body at (103.5, 100) when user clicks at (101.5, 100);
  // in Pass 2 the moving body separates to (110, 104).
  const epochBuffersClosePair = [
    makeGaussianEpochPlanes([
      { x: 100, y: 100, peak: 8.5 },
      { x: 103.5, y: 100, peak: 7.5 },
    ]),
    makeGaussianEpochPlanes([
      { x: 100, y: 100, peak: 8.5 },
      { x: 110, y: 104, peak: 7.5 },
    ]),
  ];
  const closePairRes = detectAndTrackBodiesAtClick({
    clickX: 101.5,
    clickY: 100,
    originEpochIndex: 0,
    epochBuffers: epochBuffersClosePair,
    manifest: baseManifest,
    wavelengthRangeUm: [0.75, 5.0],
  });
  assert.equal(closePairRes.isOverlapped, true);
  assert.equal(closePairRes.tracks.length, 2);
  assert.notEqual(closePairRes.tracks[0].color, closePairRes.tracks[1].color);

  // Case 4: Two bodies cross at (100, 100) on Pass 2 (originEpochIndex = 1), where
  // Branch A separates in Pass 1 at (92, 95) and fades in Pass 3, while
  // Branch B fades in Pass 1 and separates in Pass 3 at (108, 95).
  const epochBuffersAsyncSep = [
    makeGaussianEpochPlanes([{ x: 92, y: 95, peak: 9.0 }]),
    makeGaussianEpochPlanes([{ x: 100, y: 100, peak: 14.0 }]),
    makeGaussianEpochPlanes([{ x: 108, y: 95, peak: 8.5 }]),
  ];
  const asyncSepRes = detectAndTrackBodiesAtClick({
    clickX: 100,
    clickY: 100,
    originEpochIndex: 1,
    epochBuffers: epochBuffersAsyncSep,
    manifest: manifest3,
    wavelengthRangeUm: [0.75, 5.0],
  });
  assert.equal(asyncSepRes.isOverlapped, true);
  assert.equal(asyncSepRes.tracks.length, 2);
  assert.equal(asyncSepRes.status, 'partially_lost');
  assert.ok(WORLD_CAPITAL_CITIES.length > 0);
  assert.equal(
    new Set(WORLD_CAPITAL_CITIES.map((city) => city.slug)).size,
    WORLD_CAPITAL_CITIES.length,
  );
});

test('Edge cases: clicking empty sky returns no_body_found, and fading or exiting bodies report lost/out_of_bounds waypoints', () => {
  const baseManifest = JSON.parse(
    fs.readFileSync(path.join(PRESETS_DIR, 'wise_0855', 'manifest.json'), 'utf-8'),
  );
  const manifest3 = {
    ...baseManifest,
    catalog_overlays: { ...baseManifest.catalog_overlays, known_objects: [] },
    epochs: [
      { ...baseManifest.epochs[0], epoch_id: 'pass_1', mjd: 60600.0 },
      { ...baseManifest.epochs[1], epoch_id: 'pass_2', mjd: 60800.0 },
      { ...baseManifest.epochs[1], epoch_id: 'pass_3', mjd: 61000.0 },
    ],
  };

  // Edge Case A: Click empty background noise at (25, 25) -> no_body_found
  const emptyBuffers = [
    makeGaussianEpochPlanes([{ x: 180, y: 180, peak: 8.0 }]),
    makeGaussianEpochPlanes([{ x: 185, y: 182, peak: 8.0 }]),
  ];
  const emptyRes = detectAndTrackBodiesAtClick({
    clickX: 25,
    clickY: 25,
    originEpochIndex: 0,
    epochBuffers: emptyBuffers,
    manifest: baseManifest,
    wavelengthRangeUm: [0.75, 5.0],
  });
  assert.equal(emptyRes.status, 'no_body_found');
  assert.equal(emptyRes.tracks.length, 0);

  // Pure random sky noise must also be rejected rather than snapping to a noise spike.
  const noisyEmptyBuffers = [
    makeSeededNoiseEpochPlanes([], 0.02, 0.02, 12345),
    makeSeededNoiseEpochPlanes([], 0.02, 0.02, 67890),
  ];
  for (const [clickX, clickY] of [
    [25, 25],
    [50, 50],
    [120, 180],
    [200, 200],
  ]) {
    const noisyRes = detectAndTrackBodiesAtClick({
      clickX,
      clickY,
      originEpochIndex: 0,
      epochBuffers: noisyEmptyBuffers,
      manifest: baseManifest,
      wavelengthRangeUm: [0.75, 5.0],
    });
    assert.equal(noisyRes.status, 'no_body_found');
    assert.equal(noisyRes.tracks.length, 0);
  }

  const emptySingle = detectAndTrackBrightBodyAcrossEpochs({
    clickX: 25,
    clickY: 25,
    originEpochIndex: 0,
    epochBuffers: emptyBuffers,
    manifest: baseManifest,
    wavelengthRangeUm: [0.75, 5.0],
  });
  assert.equal(emptySingle.status, 'no_body_found');
  assert.equal(emptySingle.waypoints.length, 0);

  // Edge Case B: Body is present in Pass 1 (70, 70) and Pass 2 (76, 73), then fades/disappears in Pass 3
  const fadingBuffers = [
    makeGaussianEpochPlanes([{ x: 70, y: 70, peak: 9.0 }]),
    makeGaussianEpochPlanes([{ x: 76, y: 73, peak: 9.0 }]),
    makeGaussianEpochPlanes([]), // Faded below detection limit in Pass 3
  ];
  const fadingRes = detectAndTrackBodiesAtClick({
    clickX: 70,
    clickY: 70,
    originEpochIndex: 0,
    epochBuffers: fadingBuffers,
    manifest: manifest3,
    wavelengthRangeUm: [0.75, 5.0],
  });
  assert.equal(fadingRes.status, 'partially_lost');
  assert.equal(fadingRes.tracks.length, 1);
  const fadingTrack = fadingRes.tracks[0];
  assert.equal(fadingTrack.waypoints[0].status, 'tracked');
  assert.equal(fadingTrack.waypoints[1].status, 'tracked');
  assert.ok(['lost', 'low_snr'].includes(fadingTrack.waypoints[2].status));
  assert.equal(fadingTrack.waypoints[2].visible, false);
  assert.deepEqual(fadingTrack.lostEpochIds, ['pass_3']);

  // Edge Case B2: A body that dims below the tracking flux threshold but is still
  // present above the background is reported as 'low_snr'.
  const dimmingBuffers = [
    makeGaussianEpochPlanes([{ x: 70, y: 70, peak: 9.0 }]),
    makeGaussianEpochPlanes([{ x: 76, y: 73, peak: 9.0 }]),
    makeGaussianEpochPlanes([{ x: 82, y: 76, peak: 0.1 }]),
  ];
  const dimmingRes = detectAndTrackBodiesAtClick({
    clickX: 70,
    clickY: 70,
    originEpochIndex: 0,
    epochBuffers: dimmingBuffers,
    manifest: manifest3,
    wavelengthRangeUm: [0.75, 5.0],
  });
  assert.equal(dimmingRes.status, 'partially_lost');
  assert.equal(dimmingRes.tracks[0].waypoints[2].status, 'low_snr');
  assert.equal(dimmingRes.tracks[0].waypoints[2].visible, false);
  assert.deepEqual(dimmingRes.tracks[0].lostEpochIds, ['pass_3']);
  assert.equal(dimmingRes.tracks[0].status, 'partially_lost');

  // Edge Case C: Fast mover near border exits 256x256 FOV in Pass 3 -> out_of_bounds
  const borderBuffers = [
    makeGaussianEpochPlanes([{ x: 244, y: 120, peak: 9.0 }]),
    makeGaussianEpochPlanes([{ x: 252, y: 120, peak: 9.0 }]),
    makeGaussianEpochPlanes([]), // Predicted at x = 260 (out of bounds!)
  ];
  const borderRes = detectAndTrackBodiesAtClick({
    clickX: 244,
    clickY: 120,
    originEpochIndex: 0,
    epochBuffers: borderBuffers,
    manifest: manifest3,
    wavelengthRangeUm: [0.75, 5.0],
  });
  assert.equal(borderRes.status, 'partially_lost');
  assert.equal(borderRes.tracks[0].waypoints[2].status, 'out_of_bounds');
  assert.equal(borderRes.tracks[0].waypoints[2].visible, false);
});

test('ISS-18: clicking multiple spots accumulates every target with a distinct tracking-square color', () => {
  const baseManifest = JSON.parse(
    fs.readFileSync(path.join(PRESETS_DIR, 'wise_0855', 'manifest.json'), 'utf-8'),
  );
  const manifest2 = {
    ...baseManifest,
    catalog_overlays: { ...baseManifest.catalog_overlays, known_objects: [] },
    epochs: baseManifest.epochs.slice(0, 2),
  };
  // Two independent bodies that move between the two passes.
  const twoBodyBuffers = [
    makeGaussianEpochPlanes([
      { x: 60, y: 60 },
      { x: 160, y: 160 },
    ]),
    makeGaussianEpochPlanes([
      { x: 64, y: 62 },
      { x: 164, y: 162 },
    ]),
  ];

  const clickResults = [];
  let trackedTargets = [];
  for (const [clickX, clickY] of [
    [60, 60],
    [160, 160],
  ]) {
    const res = detectAndTrackBodiesAtClick({
      clickX,
      clickY,
      originEpochIndex: 0,
      epochBuffers: twoBodyBuffers,
      manifest: manifest2,
      wavelengthRangeUm: [0.75, 5.0],
      colorIndexOffset: trackedTargets.length,
    });
    assert.equal(res.status, 'tracked');
    assert.equal(res.tracks.length, 1);
    clickResults.push(res);
    // This is the exact accumulation helper used by SkyExplorerContext.
    trackedTargets = mergeTrackedTargets(trackedTargets, res.tracks);
  }

  assert.equal(trackedTargets.length, 2);
  assert.equal(new Set(trackedTargets.map((t) => t.color)).size, 2);
  for (const target of trackedTargets) {
    assert.ok(TRACKING_SQUARE_COLORS.includes(target.color));
  }

  // Re-clicking an existing spot replaces that target instead of duplicating it.
  trackedTargets = mergeTrackedTargets(trackedTargets, clickResults[0].tracks);
  assert.equal(trackedTargets.length, 2);
  assert.equal(new Set(trackedTargets.map((t) => t.color)).size, 2);

  // A matched known object whose preferred highlighter color collides with an
  // already-tracked target must be reassigned a distinct palette color.
  const existingColor = trackedTargets[0].color;
  const matchedTrack = {
    ...clickResults[1].tracks[0],
    trackId: 'matched-known-object',
    groupId: 'matched-known-object-group',
    matchedObjectId: 'known-1',
  };
  const withKnownObject = mergeTrackedTargets(trackedTargets, [matchedTrack], {
    objectHighlighterColors: { 'known-1': existingColor },
  });
  assert.equal(withKnownObject.length, 3);
  assert.equal(new Set(withKnownObject.map((t) => t.color)).size, 3);
  assert.ok(withKnownObject.every((t) => TRACKING_SQUARE_COLORS.includes(t.color)));

  // A checked object's own preferred color is still allowed for its matched track.
  const ownKnownColor = mergeTrackedTargets([], [matchedTrack], {
    checkedObjectIds: ['known-1'],
    objectHighlighterColors: { 'known-1': TRACKING_SQUARE_COLORS[5] },
  });
  assert.equal(ownKnownColor[0].color, TRACKING_SQUARE_COLORS[5]);

  // Unmatched targets never steal a color reserved by a checked known object.
  const reservedAware = mergeTrackedTargets(
    [],
    [{ ...clickResults[0].tracks[0], matchedObjectId: null }],
    {
      checkedObjectIds: ['known-2'],
      objectHighlighterColors: { 'known-2': TRACKING_SQUARE_COLORS[0] },
      rng: () => 0,
    },
  );
  assert.notEqual(reservedAware[0].color, TRACKING_SQUARE_COLORS[0]);

  // Palette offsets wrap back to the first color instead of running off the end.
  const wrapped = detectAndTrackBodiesAtClick({
    clickX: 60,
    clickY: 60,
    originEpochIndex: 0,
    epochBuffers: twoBodyBuffers,
    manifest: manifest2,
    wavelengthRangeUm: [0.75, 5.0],
    colorIndexOffset: TRACKING_SQUARE_COLORS.length,
  });
  assert.equal(wrapped.tracks[0].color, TRACKING_SQUARE_COLORS[0]);
});

test('ISS-18: 3+ overlapped bodies separate into one colored branch per body while tracking backward and forward', () => {
  const baseManifest = JSON.parse(
    fs.readFileSync(path.join(PRESETS_DIR, 'wise_0855', 'manifest.json'), 'utf-8'),
  );
  const manifest3 = {
    ...baseManifest,
    catalog_overlays: { ...baseManifest.catalog_overlays, known_objects: [] },
    epochs: [
      { ...baseManifest.epochs[0], epoch_id: 'pass_1', mjd: 60600.0 },
      { ...baseManifest.epochs[1], epoch_id: 'pass_2', mjd: 60800.0 },
      { ...baseManifest.epochs[1], epoch_id: 'pass_3', mjd: 61000.0 },
    ],
  };

  // Three bodies blended at (100, 100) on Pass 2. Each moves linearly through the
  // clicked position:  A (88,92) -> (100,100) -> (112,108)
  //                      B (112,92) -> (100,100) -> (88,108)
  //                      C (100,88) -> (100,100) -> (100,112)
  const threeBodyBuffers = [
    makeGaussianEpochPlanes([
      { x: 88, y: 92 },
      { x: 112, y: 92 },
      { x: 100, y: 88 },
    ]),
    makeGaussianEpochPlanes([{ x: 100, y: 100, peak: 20.0 }]),
    makeGaussianEpochPlanes([
      { x: 112, y: 108 },
      { x: 88, y: 108 },
      { x: 100, y: 112 },
    ]),
  ];

  const res = detectAndTrackBodiesAtClick({
    clickX: 100,
    clickY: 100,
    originEpochIndex: 1,
    epochBuffers: threeBodyBuffers,
    manifest: manifest3,
    wavelengthRangeUm: [0.75, 5.0],
  });

  assert.equal(res.status, 'tracked');
  assert.equal(res.isOverlapped, true);
  assert.equal(res.tracks.length, 3);
  assert.equal(new Set(res.tracks.map((t) => t.color)).size, 3);
  for (const track of res.tracks) {
    assert.equal(track.isOverlappedAtOrigin, true);
    assert.equal(track.waypoints.length, 3);
    assert.ok(track.waypoints.every((wp) => wp.status === 'tracked' && wp.visible));
  }

  const expectedLines = [
    [
      [88, 92],
      [100, 100],
      [112, 108],
    ],
    [
      [112, 92],
      [100, 100],
      [88, 108],
    ],
    [
      [100, 88],
      [100, 100],
      [100, 112],
    ],
  ];
  for (const line of expectedLines) {
    const track = res.tracks.find(
      (t) => Math.hypot(t.waypoints[0].x - line[0][0], t.waypoints[0].y - line[0][1]) < 0.8,
    );
    assert.ok(track, `missing branch starting at (${line[0][0]}, ${line[0][1]})`);
    for (let epIdx = 0; epIdx < line.length; epIdx += 1) {
      assert.ok(
        Math.hypot(
          track.waypoints[epIdx].x - line[epIdx][0],
          track.waypoints[epIdx].y - line[epIdx][1],
        ) < 0.8,
        `branch from (${line[0][0]}, ${line[0][1]}) waypoint ${epIdx} drifted`,
      );
    }
  }
});

test('ISS-18: two overlapped bodies that merge again in another epoch do not create a phantom third track', () => {
  const baseManifest = JSON.parse(
    fs.readFileSync(path.join(PRESETS_DIR, 'wise_0855', 'manifest.json'), 'utf-8'),
  );
  const manifest3 = {
    ...baseManifest,
    catalog_overlays: { ...baseManifest.catalog_overlays, known_objects: [] },
    epochs: [
      { ...baseManifest.epochs[0], epoch_id: 'pass_1', mjd: 60600.0 },
      { ...baseManifest.epochs[1], epoch_id: 'pass_2', mjd: 60800.0 },
      { ...baseManifest.epochs[1], epoch_id: 'pass_3', mjd: 61000.0 },
    ],
  };

  // Two bodies are separated on Pass 1, blended on Pass 2, and blended again on Pass 3.
  const mergeBuffers = [
    makeGaussianEpochPlanes([
      { x: 90, y: 94 },
      { x: 90, y: 106 },
    ]),
    makeGaussianEpochPlanes([{ x: 100, y: 100, peak: 14.0 }]),
    makeGaussianEpochPlanes([{ x: 110, y: 100, peak: 14.0 }]),
  ];

  const res = detectAndTrackBodiesAtClick({
    clickX: 100,
    clickY: 100,
    originEpochIndex: 1,
    epochBuffers: mergeBuffers,
    manifest: manifest3,
    wavelengthRangeUm: [0.75, 5.0],
  });

  assert.equal(res.isOverlapped, true);
  assert.equal(res.tracks.length, 2);
  assert.equal(new Set(res.tracks.map((t) => t.color)).size, 2);
  assert.equal(res.status, 'partially_lost');
  for (const track of res.tracks) {
    assert.equal(track.waypoints[0].status, 'tracked');
    assert.equal(track.waypoints[1].status, 'tracked');
    assert.ok(['lost', 'low_snr', 'out_of_bounds'].includes(track.waypoints[2].status));
    assert.equal(track.waypoints[2].visible, false);
    assert.deepEqual(track.lostEpochIds, ['pass_3']);
    assert.equal(track.status, 'partially_lost');
  }
});

test('ISS-18: out-of-bounds clicks return no_body_found without adding a bogus track', () => {
  const baseManifest = JSON.parse(
    fs.readFileSync(path.join(PRESETS_DIR, 'wise_0855', 'manifest.json'), 'utf-8'),
  );
  const buffers = makeGaussianEpochPlanes([{ x: 100, y: 100 }]);

  for (const [clickX, clickY] of [
    [-1, 50],
    [50, -0.5],
    [256, 50],
    [50, 256],
    [Number.NaN, 50],
  ]) {
    const res = detectAndTrackBodiesAtClick({
      clickX,
      clickY,
      originEpochIndex: 0,
      epochBuffers: [buffers],
      manifest: baseManifest,
      wavelengthRangeUm: [0.75, 5.0],
    });
    assert.equal(res.status, 'no_body_found');
    assert.equal(res.tracks.length, 0);
    assert.ok(res.message.length > 0);
  }
});

test('Interactive viewport panning and zooming clamps bounds and inverse-maps clicks to 256x256 image coordinates', () => {
  // At 1x zoom, pan offsets clamp to 0 and viewBox is full 0..256
  const z1 = clampViewportPanZoom(1.0, 45, -30);
  assert.equal(z1.zoom, 1.0);
  assert.equal(z1.panX, 0);
  assert.equal(z1.panY, 0);
  const vb1 = computeViewportViewBox(1.0, 0, 0);
  assert.equal(vb1.svgViewBox, '0.000 0.000 256.000 256.000');

  // At 4x zoom, visible window is 64x64; with panX=20, panY=-10, center is at (148, 118)
  const vb4 = computeViewportViewBox(4.0, 20, -10);
  assert.equal(vb4.viewWidth, 64);
  assert.equal(vb4.viewHeight, 64);
  assert.equal(vb4.minX, 116);
  assert.equal(vb4.minY, 86);

  // Clicking the center of a 512x512 screen element at (zoom=4, panX=20, panY=-10) maps to (148, 118)
  const clickCenter = screenToImageCoordinates(
    356,
    256,
    { left: 100, top: 0, width: 512, height: 512 },
    4.0,
    20,
    -10,
  );
  assert.equal(clickCenter.inBounds, true);
  assert.equal(clickCenter.x, 148);
  assert.equal(clickCenter.y, 118);
});

test('ClientPatchCache caches sky patches in memory and evicts oldest entry on LRU overflow', async () => {
  const cache = new ClientPatchCache(2);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(PRESETS_DIR, 'wise_0855', 'manifest.json'), 'utf-8'),
  );

  await cache.putPatch({
    cacheKey: 'k1',
    manifest,
    epochBuffers: [],
    flagsBuffers: [],
    storedAt: 1,
    lastAccessed: 1,
  });
  await cache.putPatch({
    cacheKey: 'k2',
    manifest,
    epochBuffers: [],
    flagsBuffers: [],
    storedAt: 2,
    lastAccessed: 2,
  });
  // Access k1 so k2 becomes the oldest
  const hit1 = await cache.getPatch('k1');
  assert.ok(hit1 !== null);

  await cache.putPatch({
    cacheKey: 'k3',
    manifest,
    epochBuffers: [],
    flagsBuffers: [],
    storedAt: 3,
    lastAccessed: 3,
  });

  assert.ok((await cache.getPatch('k1')) !== null);
  assert.equal(await cache.getPatch('k2'), null);
  assert.ok((await cache.getPatch('k3')) !== null);
});

test('ISS-10: cached grid_key and preset:{slug} are served from memory in <5 ms with zero network requests', async () => {
  const cache = new ClientPatchCache(4);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(PRESETS_DIR, 'wise_0855', 'manifest.json'), 'utf-8'),
  );
  const gridKey = computeGridKey(133.7951, -7.2451, 5.0);
  const presetKey = presetCacheKey('wise_0855');

  assert.equal(gridCacheKey(gridKey), 'ra133.80_dec-7.25_fov5.0');
  assert.equal(presetKey, 'preset:wise_0855');
  assert.equal(gridCacheKey('  ra133.80_dec-7.25_fov5.0  '), gridKey);
  assert.equal(presetCacheKey('  wise_0855  '), presetKey);

  const makeBundle = (cacheKey) => ({
    cacheKey,
    manifest,
    epochBuffers: [],
    flagsBuffers: [],
    storedAt: Date.now(),
    lastAccessed: Date.now(),
  });

  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (...args) => {
    networkCalls += 1;
    return Promise.reject(new Error(`Unexpected network request: ${String(args[0])}`));
  };

  try {
    await cache.putPatch(makeBundle(gridKey));
    await cache.putPatch(makeBundle(presetKey));
    await cache.putCatalogs(gridKey, {
      query: manifest.query,
      wcs: manifest.wcs,
      catalog_overlays: manifest.catalog_overlays,
    });

    // A loader must not run for keys that are already cached.
    const gridHit = await cache.getOrFetchPatch(gridKey, async () => {
      networkCalls += 1;
      return null;
    });
    const presetHit = await cache.getOrFetchPatch(presetKey, async () => {
      networkCalls += 1;
      return null;
    });
    const catalogHit = await cache.getOrFetchCatalogs(gridKey, async () => {
      networkCalls += 1;
      return null;
    });
    assert.ok(gridHit);
    assert.ok(presetHit);
    assert.ok(catalogHit);

    // Warm the JIT then measure the average hot-path retrieval time.
    for (let i = 0; i < 10; i += 1) {
      await cache.getPatch(gridKey);
      await cache.getPatch(presetKey);
    }
    const iterations = 200;
    const startedAt = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      const hit = await cache.getPatch(i % 2 === 0 ? gridKey : presetKey);
      assert.ok(hit);
    }
    const averageMs = (performance.now() - startedAt) / iterations;
    assert.ok(averageMs < 5, `cached patch retrieval averaged ${averageMs.toFixed(3)} ms`);

    assert.ok(cache.getPatchSync(gridKey));
    assert.ok(cache.getPatchSync(presetKey));
    assert.equal(networkCalls, 0, 'cached retrieval must never touch the network');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ISS-10: ClientPatchCache LRU-evicts catalogs and works without IndexedDB in headless environments', async () => {
  const cache = new ClientPatchCache(2);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(PRESETS_DIR, 'wise_0855', 'manifest.json'), 'utf-8'),
  );
  const catalogsFor = (ra) => ({
    query: { ...manifest.query, ra },
    wcs: manifest.wcs,
    catalog_overlays: manifest.catalog_overlays,
  });

  // Node has no indexedDB: every operation must gracefully fall back to memory.
  assert.equal(cache.isPersistentStorageAvailable(), false);
  assert.equal(cache.capacity, 2);

  await cache.putCatalogs('grid_a', catalogsFor(10));
  await cache.putCatalogs('grid_b', catalogsFor(20));
  assert.equal((await cache.getCatalogs('grid_a')).query.ra, 10);

  await cache.putCatalogs('grid_c', catalogsFor(30));
  assert.equal(await cache.getCatalogs('grid_b'), null, 'LRU catalog grid_b should be evicted');
  assert.equal((await cache.getCatalogs('grid_a')).query.ra, 10);
  assert.equal((await cache.getCatalogs('grid_c')).query.ra, 30);
  assert.equal(await cache.hasCatalogs('grid_b'), false);
  assert.equal(await cache.hasCatalogs('grid_c'), true);

  assert.deepEqual(cache.size, { patches: 0, catalogs: 2 });
  const stats = cache.getStats();
  assert.equal(stats.maxEntries, 2);
  assert.equal(stats.memoryCatalogs, 2);
  assert.ok(stats.catalogHits >= 2);
  assert.ok(stats.catalogMisses >= 1);

  await cache.deleteCatalogs('grid_a');
  assert.equal(await cache.getCatalogs('grid_a'), null);

  const patch = {
    cacheKey: 'grid_patch',
    manifest,
    epochBuffers: [],
    flagsBuffers: [],
    storedAt: Date.now(),
    lastAccessed: Date.now(),
  };
  await cache.putPatch(patch);
  assert.equal(await cache.hasPatch('grid_patch'), true);
  assert.ok(await cache.getPatch('grid_patch'));
  await cache.deletePatch('grid_patch');
  assert.equal(await cache.hasPatch('grid_patch'), false);

  await cache.putCatalogs('grid_d', catalogsFor(40));
  await cache.clearAll();
  assert.deepEqual(cache.size, { patches: 0, catalogs: 0 });
});

test('Click-to-Track accurately tracks both stationary field stars and moving targets across all 12 presets and epochs', () => {
  const slugs = [
    'wise_0855',
    'barnards_star',
    'epsilon_indi_b',
    'rw_aurigae',
    'r_draconis',
    'comet_3i_atlas',
    'luhman_16',
    'wolf_359',
    'teegardens_star',
    'cw_leonis',
    't_tauri',
    'ceres_asteroid',
  ];

  assert.equal(computeGridKey(133.7951, -7.2451, 5.0), 'ra133.80_dec-7.25_fov5.0');
  assert.equal(computeGridKey(133.809, -7.258, 5.0), 'ra133.80_dec-7.25_fov5.0');

  for (const slug of slugs) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(PRESETS_DIR, slug, 'manifest.json'), 'utf-8'),
    );
    const p1 = decodeDetectorBinaryBuffer(
      readArrayBuffer(path.join(PRESETS_DIR, slug, 'pass_1.bin')),
    );
    const p2 = decodeDetectorBinaryBuffer(
      readArrayBuffer(path.join(PRESETS_DIR, slug, 'pass_2.bin')),
    );

    for (const obj of manifest.catalog_overlays.known_objects) {
      for (const originEpochIndex of [0, 1]) {
        const clickPos = obj.epoch_positions[originEpochIndex];
        const trace = detectAndTrackBrightBodyAcrossEpochs({
          clickX: clickPos.x,
          clickY: clickPos.y,
          originEpochIndex,
          epochBuffers: [p1, p2],
          manifest,
          wavelengthRangeUm: [0.75, 5.0],
        });

        assert.equal(trace.matchedObjectId, obj.object_id);
        for (const epIdx of [0, 1]) {
          const wp = trace.waypoints[epIdx];
          const exp = obj.epoch_positions[epIdx];
          const err = Math.hypot(wp.x - exp.x, wp.y - exp.y);
          assert.ok(
            err < 1.2,
            `Preset ${slug} object ${obj.object_id} (origin=${originEpochIndex}) waypoint ${epIdx} error ${err.toFixed(2)} >= 1.2 px`,
          );
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// ISS-16 & ISS-23: Viewport Controls Bar, Known Celestial Objects & Fuzzy Search
// ---------------------------------------------------------------------------

function loadPresetKnownObjects(slug) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(PRESETS_DIR, slug, 'manifest.json'), 'utf-8'),
  );
  return manifest.catalog_overlays.known_objects;
}

const PRESET_SLUGS = fs
  .readdirSync(PRESETS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

test('ISS-16: default selection checks notable movers and leaves stationary field stars unchecked', () => {
  assert.equal(PRESET_SLUGS.length, 12);
  for (const slug of PRESET_SLUGS) {
    const known = loadPresetKnownObjects(slug);
    const defaults = getDefaultCheckedObjectIds(known);
    assert.ok(defaults.length >= 1, `${slug}: expected at least one notable object checked`);
    for (const obj of known) {
      assert.equal(
        defaults.includes(obj.object_id),
        obj.default_checked,
        `${slug}: ${obj.object_id} default selection must follow default_checked`,
      );
    }
    assert.ok(
      known.some((obj) => !obj.default_checked),
      `${slug}: expected stationary background stars to start unchecked`,
    );
  }
});

test('ISS-23: highlighter color palette has >=16 distinct colors and fuzzy search matches typos and catalog designations', () => {
  assert.ok(TRACKING_SQUARE_COLORS.length >= 16);
  assert.equal(new Set(TRACKING_SQUARE_COLORS).size, TRACKING_SQUARE_COLORS.length);

  // Sampling 16 colors without replacement produces 16 distinct colors
  const sampled = pickDistinctHighlighterColors(16);
  assert.equal(sampled.length, 16);
  assert.equal(new Set(sampled).size, 16);

  // Fuzzy search ranks exact, substring, subsequence, and typo queries accurately
  assert.ok(fuzzyScoreText('barnrd', "Barnard's Star (GJ 699)") >= 0.45);
  assert.ok(fuzzyScoreText('w0855', 'WISE 0855-0714') >= 0.5);

  const barnardKnown = loadPresetKnownObjects('barnards_star');
  const matches = fuzzySearchKnownObjects(barnardKnown, 'barnrd');
  assert.ok(matches.length >= 1);
  assert.ok(matches[0].label.includes("Barnard's Star"));
});

test('ISS-16: Check All selects every object, Uncheck All clears to [], Notable Only restores defaults', () => {
  for (const slug of PRESET_SLUGS) {
    const known = loadPresetKnownObjects(slug);

    const all = selectAllObjectIds(known);
    assert.deepEqual(
      all,
      known.map((obj) => obj.object_id),
      `${slug}: Check All must include every known object`,
    );

    assert.deepEqual(clearCheckedObjectIds(), [], `${slug}: Uncheck All must yield []`);

    const restored = getDefaultCheckedObjectIds(known);
    assert.notDeepEqual(all, restored, `${slug}: Notable Only must differ from Check All`);
    assert.deepEqual(
      restored,
      known.filter((obj) => obj.default_checked).map((obj) => obj.object_id),
    );
  }
});

test('ISS-16: toggling an object id adds or removes only that id without mutating the input', () => {
  const start = ['a', 'b'];
  const added = toggleObjectId(start, 'c');
  assert.deepEqual(added, ['a', 'b', 'c']);
  assert.deepEqual(start, ['a', 'b'], 'input array must not be mutated');

  const removed = toggleObjectId(added, 'a');
  assert.deepEqual(removed, ['b', 'c']);

  assert.deepEqual(toggleObjectId(toggleObjectId([], 'x'), 'x'), []);
});

test('ISS-16: wavelength quick-filter pills cover the four required ranges and highlight exclusively', () => {
  assert.deepEqual(
    WAVELENGTH_PRESETS.map((p) => p.range),
    [
      [0.75, 5.0],
      [3.8, 5.0],
      [2.4, 3.8],
      [0.75, 2.4],
    ],
  );
  for (const preset of WAVELENGTH_PRESETS) {
    const active = WAVELENGTH_PRESETS.filter((p) =>
      isWavelengthPresetActive(preset.range, p.range),
    );
    assert.deepEqual(
      active.map((p) => p.id),
      [preset.id],
      `only the ${preset.id} pill should be active for its own range`,
    );
    assert.ok(preset.range[0] >= 0.75 && preset.range[1] <= 5.0);
  }
  assert.equal(isWavelengthPresetActive([1.0, 4.0], [0.75, 5.0]), false);
});

test('ISS-16: known-object rows show a catalog badge, magnitude and proper motion for every preset object', () => {
  assert.equal(catalogBadgeLabel('gaia_dr3'), 'Gaia DR3');
  assert.equal(catalogBadgeLabel('wise'), 'WISE');
  assert.equal(catalogBadgeLabel('most'), 'MOST');

  assert.equal(formatMagnitude(16.44), 'mag 16.4');
  assert.equal(formatMagnitude(null), 'mag n/a');
  assert.equal(formatProperMotion(0.013), 'μ 0.013″/yr');
  assert.equal(formatProperMotion(8.12), 'μ 8.12″/yr');
  assert.equal(formatProperMotion(null), 'μ n/a');

  for (const slug of PRESET_SLUGS) {
    for (const obj of loadPresetKnownObjects(slug)) {
      const row = [
        catalogBadgeLabel(obj.catalog),
        formatMagnitude(obj.magnitude),
        formatProperMotion(obj.proper_motion_arcsec_yr),
      ].join(' ');
      assert.ok(!/NaN|undefined|null/.test(row), `${slug}/${obj.object_id}: bad row "${row}"`);
    }
  }
});

test('Automated pipeline UI helpers: catalog/class badges, mover detection, and canvas pixel rendering', () => {
  assert.equal(catalogBadgeLabel('simbad'), 'SIMBAD');
  assert.equal(catalogBadgeLabel('jpl_horizons'), 'JPL Horizons');

  const planetObj = {
    object_id: 'ephem:599',
    label: 'Jupiter',
    catalog: 'jpl_horizons',
    object_type: 'solar_system',
    object_class: 'planet',
    ra: 120.0,
    dec: 20.0,
    x: 128,
    y: 128,
    magnitude: -2.3,
    proper_motion_arcsec_yr: null,
    w1_w2_color: null,
    default_checked: true,
    epoch_positions: [
      { epoch_id: 'pass_1', mjd: 60800, ra: 120.0, dec: 20.0, x: 110, y: 120 },
      { epoch_id: 'pass_2', mjd: 60900, ra: 120.02, dec: 20.01, x: 145, y: 132 },
    ],
  };
  assert.equal(inferObjectClass(planetObj), 'planet');
  assert.equal(objectClassBadgeLabel('planet'), 'Planet');
  assert.equal(isMovingSolarSystemObject(planetObj), true);

  const bdObj = {
    ...planetObj,
    object_id: 'simbad:WISE_0855',
    catalog: 'simbad',
    object_type: 'brown_dwarf_candidate',
    object_class: null,
    epoch_positions: [{ epoch_id: 'pass_1', mjd: 60800, ra: 133.7, dec: -7.2, x: 128, y: 128 }],
  };
  assert.equal(inferObjectClass(bdObj), 'brown_dwarf');
  assert.equal(objectClassBadgeLabel('brown_dwarf'), 'Brown Dwarf');

  // Render 6-detector preset pass_1 + pass_2 buffers to 256x256 RGBA bytes
  const wiseDir = path.join(PRESETS_DIR, 'wise_0855');
  const p1Raw = fs.readFileSync(path.join(wiseDir, 'pass_1.bin'));
  const p2Raw = fs.readFileSync(path.join(wiseDir, 'pass_2.bin'));
  const p1 = decodeDetectorBinaryBuffer(
    p1Raw.buffer.slice(p1Raw.byteOffset, p1Raw.byteOffset + p1Raw.byteLength),
    'float32',
  );
  const p2 = decodeDetectorBinaryBuffer(
    p2Raw.buffer.slice(p2Raw.byteOffset, p2Raw.byteOffset + p2Raw.byteLength),
    'float32',
  );

  const blinkRgba = renderEpochBuffersToRgba({
    epochBuffers: [p1, p2],
    activeEpochIndex: 0,
    comparisonMode: 'blink',
    contrastStretch: 'asinh',
    wavelengthRangeUm: [0.75, 5.0],
  });
  assert.equal(blinkRgba.length, 256 * 256 * 4);
  assert.equal(blinkRgba[3], 255);

  const diffRgba = renderEpochBuffersToRgba({
    epochBuffers: [p1, p2],
    activeEpochIndex: 1,
    comparisonMode: 'subtract',
    contrastStretch: 'zscale',
    wavelengthRangeUm: [3.8, 5.0],
  });
  assert.equal(diffRgba.length, 256 * 256 * 4);
});

test('ISS-17: formatSpectrumCsv produces 103-line CSV with header and 102 spectral channels', () => {
  const channels = Array.from({ length: 102 }, (_, idx) => ({
    band_index: idx + 1,
    detector: Math.floor(idx / 17) + 1,
    wavelength_um: 0.75 + (idx / 101) * (5.0 - 0.75),
    flux: 12.5 + idx * 0.1,
    variance: 0.04,
    flagged: idx === 10 || idx === 55,
  }));

  const csv = formatSpectrumCsv({
    target_id: 'barnards_star',
    ra: 269.452,
    dec: 4.693,
    aperture_radius_px: 2.5,
    channels,
  });

  const lines = csv.trimEnd().split('\n');
  assert.equal(lines.length, 103);
  assert.equal(lines[0], 'band_index,detector,wavelength_um,flux,variance,flagged');
  assert.ok(lines[1].startsWith('1,1,0.7500,'));
  assert.ok(lines[11].endsWith(',true'));
  assert.ok(lines[12].endsWith(',false'));
});

// ---------------------------------------------------------------------------
// ISS-14: Aladin Lite v3 Global Sky Map & Shareable URL Query State
// ---------------------------------------------------------------------------

test('ISS-14: parseUrlState restores exact coordinates, comparison mode, and wavelength filter', () => {
  const parsed = parseUrlState(
    '?target=barnards_star&ra=269.4521&dec=4.6934&fov=5&mode=subtract&wlMin=3.8&wlMax=5.0',
  );

  assert.equal(parsed.target, 'barnards_star');
  assert.equal(parsed.ra, 269.4521);
  assert.equal(parsed.dec, 4.6934);
  assert.equal(parsed.fov, 5);
  assert.equal(parsed.mode, 'subtract');
  assert.equal(parsed.wlMin, 3.8);
  assert.equal(parsed.wlMax, 5.0);

  // Acceptance URL without a preset still resolves the exact sky state.
  const acceptance = parseUrlState('?ra=269.4521&dec=4.6934&mode=subtract&wlMin=3.8&wlMax=5.0');
  assert.equal(acceptance.target, null);
  assert.equal(acceptance.ra, 269.4521);
  assert.equal(acceptance.dec, 4.6934);
  assert.equal(acceptance.mode, 'subtract');
  assert.deepEqual([acceptance.wlMin, acceptance.wlMax], [3.8, 5.0]);
});

test('ISS-14: parseUrlState applies scientific defaults and ignores invalid ranges', () => {
  const empty = parseUrlState('');
  assert.equal(empty.target, null);
  assert.equal(empty.ra, null);
  assert.equal(empty.dec, null);
  assert.equal(empty.fov, URL_STATE_DEFAULTS.fov);
  assert.equal(empty.mode, URL_STATE_DEFAULTS.mode);
  assert.equal(empty.wlMin, URL_STATE_DEFAULTS.wlMin);
  assert.equal(empty.wlMax, URL_STATE_DEFAULTS.wlMax);

  const invalid = parseUrlState(
    '?ra=999&dec=-120&fov=0&mode=bogus&wlMin=abc&wlMax=9&target=%3Cscript%3E',
  );
  assert.equal(invalid.target, null);
  assert.equal(invalid.ra, null);
  assert.equal(invalid.dec, null);
  assert.equal(invalid.fov, URL_STATE_DEFAULTS.fov);
  assert.equal(invalid.mode, URL_STATE_DEFAULTS.mode);
  assert.equal(invalid.wlMin, URL_STATE_DEFAULTS.wlMin);
  assert.equal(invalid.wlMax, URL_STATE_DEFAULTS.wlMax);

  // Reversed wavelength windows are normalized rather than dropped.
  const reversed = parseUrlState('?wlMin=5&wlMax=3.8');
  assert.deepEqual([reversed.wlMin, reversed.wlMax], [3.8, 5]);

  // RA 360 is the same as 0h, and full URLs are accepted.
  const fullUrl = parseUrlState('https://example.test/explore?ra=360&dec=-90&mode=coadd');
  assert.equal(fullUrl.ra, 0);
  assert.equal(fullUrl.dec, -90);
  assert.equal(fullUrl.mode, 'coadd');
});

test('ISS-14: serializeUrlState round-trips the sky view and preserves unrelated params', () => {
  const serialized = serializeUrlState({
    ra: 269.4521,
    dec: 4.6934,
    fov: 5,
    mode: 'subtract',
    wlMin: 3.8,
    wlMax: 5.0,
  });

  assert.equal(serialized, 'ra=269.4521&dec=4.6934&fov=5&mode=subtract&wlMin=3.8&wlMax=5');
  assert.deepEqual(parseUrlState(`?${serialized}`), {
    target: null,
    ra: 269.4521,
    dec: 4.6934,
    fov: 5,
    mode: 'subtract',
    wlMin: 3.8,
    wlMax: 5,
  });

  // Non-sky parameters survive, and `null` explicitly clears a known key.
  const updated = serializeUrlState(
    { target: null, mode: 'coadd' },
    '?target=wise_0855&foo=bar&mode=blink',
  );
  assert.equal(updated, 'mode=coadd&foo=bar');
  assert.equal(parseUrlState(`?${updated}`).target, null);
});

test('ISS-14: replaceUrlState mirrors the view into history.replaceState without navigation', () => {
  const calls = [];
  const history = {
    state: { from: 'test' },
    replaceState(data, unused, url) {
      calls.push({ data, unused, url });
    },
    pushState() {
      throw new Error('ISS-14 must not push a new history entry');
    },
  };
  const location = {
    pathname: '/explore',
    search: '?target=wise_0855&utm_source=share',
    hash: '#sky',
  };

  const url = replaceUrlState(
    {
      target: null,
      ra: 269.4521,
      dec: 4.6934,
      fov: 5,
      mode: 'subtract',
      wlMin: 3.8,
      wlMax: 5.0,
    },
    { history, location },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].data, { from: 'test' });
  assert.equal(calls[0].unused, '');
  assert.equal(
    url,
    '/explore?ra=269.4521&dec=4.6934&fov=5&mode=subtract&wlMin=3.8&wlMax=5&utm_source=share#sky',
  );
  assert.equal(calls[0].url, url);
});

test('ISS-21: Stage A catalogs populate knownObjects before Stage B cutouts complete and use ?precision=float16', async () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(PRESETS_DIR, 'wise_0855', 'manifest.json'), 'utf-8'),
  );
  const liveManifest = {
    ...manifest,
    epochs: manifest.epochs.map((ep, idx) => ({
      ...ep,
      binary_dtype: 'float16',
      detectors_data_url: `/api/v1/frames/test_grid/ep_${idx}_detectors.bin`,
      flags_mask_url: `/api/v1/frames/test_grid/ep_${idx}_flags.bin`,
    })),
    default_spectrum_url: null,
  };

  const float16Frame = new Uint16Array(6 * 256 * 256);
  const flagsFrame = new Uint8Array(256 * 256);
  const fetchedUrls = [];
  const timeline = [];

  let releaseStageB;
  const stageBGate = new Promise((resolve) => {
    releaseStageB = resolve;
  });

  const mockFetch = async (url) => {
    fetchedUrls.push(url);
    if (url.startsWith('/api/v1/catalogs')) {
      return new Response(
        JSON.stringify({
          grid_key: 'test_grid',
          catalog_overlays: manifest.catalog_overlays,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.startsWith('/api/v1/sky-patch')) {
      await stageBGate;
      return new Response(JSON.stringify(liveManifest), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('detectors.bin')) {
      return new Response(float16Frame.buffer, {
        status: 200,
        headers: { 'X-Binary-Dtype': 'float16' },
      });
    }
    if (url.includes('flags.bin')) {
      return new Response(flagsFrame.buffer, { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const cache = new ClientPatchCache(10);
  let readyResult = null;
  const flowPromise = loadLiveCoordinatesFlow(133.8, -7.25, 5.0, {
    cache,
    fetchImpl: mockFetch,
    onStageChange: (st) => timeline.push(`stage:${st.stage}`),
    onCatalogsReady: (cat) => {
      timeline.push(`catalogs:${cat.catalog_overlays.known_objects.length}`);
      assert.equal(readyResult, null, 'Stage A must resolve before Stage B finishes');
      releaseStageB();
    },
    onReady: (res) => {
      readyResult = res;
      timeline.push(`ready:cache=${res.fromClientCache}`);
    },
  });

  const outcome = await flowPromise;
  assert.equal(outcome.aborted, false);
  assert.equal(outcome.fromClientCache, false);
  assert.ok(readyResult);
  assert.ok(
    timeline.some((entry) => entry.startsWith('catalogs:')),
    'Expected Stage A callback to fire',
  );
  assert.ok(
    timeline.findIndex((e) => e.startsWith('catalogs:')) <
      timeline.findIndex((e) => e.startsWith('ready:')),
  );
  assert.ok(
    fetchedUrls.some((u) => u.includes('detectors.bin?precision=float16')),
    'Expected live detector frames to request ?precision=float16',
  );

  // Second call for the same coordinates must hit ClientPatchCache with 0 HTTP requests
  const beforeCount = fetchedUrls.length;
  let cachedReady = null;
  const cachedOutcome = await loadLiveCoordinatesFlow(133.8, -7.25, 5.0, {
    cache,
    fetchImpl: mockFetch,
    onReady: (res) => {
      cachedReady = res;
    },
  });
  assert.equal(cachedOutcome.fromClientCache, true);
  assert.equal(cachedReady.fromClientCache, true);
  assert.equal(fetchedUrls.length, beforeCount, 'Cache hit must issue 0 HTTP requests');
});

test('ISS-21: Rapid navigation cancels stale AbortController so stale responses never overwrite active patch', async () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(PRESETS_DIR, 'wise_0855', 'manifest.json'), 'utf-8'),
  );
  const float32Frame = new Float32Array(6 * 256 * 256);
  const flagsFrame = new Uint8Array(256 * 256);

  let releaseStale;
  const staleGate = new Promise((resolve) => {
    releaseStale = resolve;
  });

  const mockFetch = async (url, init) => {
    if (url.includes('wise_0855')) {
      await staleGate;
      if (init?.signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
    }
    if (url.endsWith('manifest.json')) {
      return new Response(JSON.stringify(manifest), { status: 200 });
    }
    if (url.endsWith('_flags.bin')) {
      return new Response(flagsFrame.buffer, { status: 200 });
    }
    if (url.endsWith('.bin')) {
      return new Response(float32Frame.buffer, {
        status: 200,
        headers: { 'X-Binary-Dtype': 'float32' },
      });
    }
    if (url.endsWith('spectrum.json')) {
      return new Response(JSON.stringify({ flux_jy: [], wavelength_um: [] }), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const cache = new ClientPatchCache(10);
  const readySlugs = [];

  const ctrl1 = new AbortController();
  const p1 = loadPresetPatchFlow('wise_0855', {
    cache,
    fetchImpl: mockFetch,
    signal: ctrl1.signal,
    onReady: () => readySlugs.push('wise_0855'),
  });

  // Immediately abort first navigation and switch to barnards_star
  ctrl1.abort();
  const ctrl2 = new AbortController();
  const p2 = loadPresetPatchFlow('barnards_star', {
    cache,
    fetchImpl: mockFetch,
    signal: ctrl2.signal,
    onReady: () => readySlugs.push('barnards_star'),
  });

  releaseStale();
  const [out1, out2] = await Promise.all([
    p1.catch((e) => ({ aborted: e.name === 'AbortError' })),
    p2,
  ]);
  assert.equal(out1.aborted, true);
  assert.equal(out2.aborted, false);
  assert.deepEqual(readySlugs, ['barnards_star']);
});

test('ISS-21: Changing render options, pan/zoom, known object selection, and tracking makes 0 HTTP requests', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(PRESETS_DIR, 'wise_0855', 'manifest.json'), 'utf-8'),
  );
  const epochBuffers = manifest.epochs.map((ep) => {
    const buf = fs.readFileSync(
      path.join(PRESETS_DIR, 'wise_0855', path.basename(ep.detectors_data_url)),
    );
    return decodeDetectorBinaryBuffer(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      ep.binary_dtype,
    );
  });
  const flagsBuffers = manifest.epochs.map((ep) => {
    const buf = fs.readFileSync(
      path.join(PRESETS_DIR, 'wise_0855', path.basename(ep.flags_mask_url)),
    );
    return decodeFlagsBinaryBuffer(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    );
  });

  const origFetch = globalThis.fetch;
  let httpCalls = 0;
  globalThis.fetch = async () => {
    httpCalls += 1;
    throw new Error('Zero HTTP requests allowed during client-side interactions');
  };

  try {
    for (const comparisonMode of ['blink', 'subtract', 'coadd']) {
      renderEpochBuffersToRgba({
        epochBuffers,
        flagsBuffers,
        comparisonMode,
        activeEpochIndex: 0,
        passAIndex: 0,
        passBIndex: 1,
        coaddIndices: [0, 1],
        wavelengthRangeUm: [3.8, 5.0],
        contrastStretch: 'asinh',
        showFlagsOverlay: true,
      });
    }
    clampViewportPanZoom(4.0, 0.25, -0.25);
    selectAllObjectIds(manifest.catalog_overlays.known_objects);
    clearCheckedObjectIds();
    toggleObjectId([], manifest.catalog_overlays.known_objects[0].object_id);
    detectAndTrackBodiesAtClick({
      clickX: 128,
      clickY: 128,
      originEpochIndex: 0,
      epochBuffers,
      manifest,
      wavelengthRangeUm: [0.75, 5.0],
    });
    assert.equal(httpCalls, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Redesign math helpers enforce frustum filtering, deferred sorting, magnetic snap, hygiene flags, and 3-shape markers', () => {
  // Frustum filtering excludes far-hemisphere objects while keeping visible region targets
  const wiseFrustum = { ra: 133.7951, dec: -7.2451, fovDeg: 65, aspect: 1.4 };
  assert.equal(isObjectInSkyFrustum(133.8, -7.2, wiseFrustum), true);
  assert.equal(isObjectInSkyFrustum(313.8, 7.2, wiseFrustum), false);
  assert.ok(angularSeparationDeg(0, 0, 180, 0) > 179.9);

  // Patch viewBox filtering honors zoom/pan bounds
  assert.equal(
    isObjectInPatchViewBox(128, 128, { minX: 96, minY: 96, viewWidth: 64, viewHeight: 64 }),
    true,
  );
  assert.equal(
    isObjectInPatchViewBox(12, 12, { minX: 96, minY: 96, viewWidth: 64, viewHeight: 64 }),
    false,
  );

  // Deferred sort moves checked items to top while preserving relative group order
  const rows = [{ object_id: 'a' }, { object_id: 'b' }, { object_id: 'c' }, { object_id: 'd' }];
  assert.deepEqual(
    sortKnownObjectsCheckedFirst(rows, ['c', 'a']).map((r) => r.object_id),
    ['a', 'c', 'b', 'd'],
  );

  // Magnetic snapping clamps safe 16px margins and detects corners within 24px
  const snapped = computeMagneticSnap(
    { x: 30, y: 20 },
    { width: 291, height: 320 },
    { width: 1440, height: 1024 },
  );
  assert.equal(snapped.x, 16);
  assert.equal(snapped.y, 16);
  assert.equal(snapped.edgeAnchor, 'top-left');

  const resolvedRight = resolvePositionFromAnchor(
    { x: 1000, y: 16, edgeAnchor: 'top-right' },
    { width: 291, height: 320 },
    { width: 1280, height: 800 },
  );
  assert.equal(resolvedRight.x, 1280 - 291 - 16);
  assert.equal(resolvedRight.y, 16);

  // Hygiene flag mask decoding identifies all contamination bits
  assert.equal(decodeHygieneFlagMask(0).isFlagged, false);
  const decodedCrSat = decodeHygieneFlagMask(1 | 2 | 4);
  assert.equal(decodedCrSat.isFlagged, true);
  assert.equal(decodedCrSat.severity, 'critical');
  assert.equal(decodedCrSat.bits.length, 3);

  // Search input parses decimal, HMS/DMS sexagesimal, and object names
  const decSearch = parseSkySearchInput('133.7951, -7.2451');
  assert.equal(decSearch.kind, 'coords');
  if (decSearch.kind === 'coords') {
    assert.ok(Math.abs(decSearch.ra - 133.7951) < 1e-4);
    assert.ok(Math.abs(decSearch.dec - -7.2451) < 1e-4);
  }
  const sexaSearch = parseSkySearchInput('08:55:10.8 -07:14:42');
  assert.equal(sexaSearch.kind, 'coords');
  assert.equal(parseSkySearchInput('Jupiter').kind, 'text');

  // Strictly 3 hollow shapes: square when tracked, diamond for moving Solar System, triangle for star/deep-sky
  assert.equal(
    getMarkerShapeKind(
      { object_class: 'star', object_type: 'star', label: 'Sirius', epoch_positions: [] },
      false,
    ),
    'triangle',
  );
  assert.equal(
    getMarkerShapeKind(
      {
        object_class: 'comet',
        object_type: 'solar_system',
        label: '3I/ATLAS',
        epoch_positions: [],
      },
      false,
    ),
    'diamond',
  );
  assert.equal(
    getMarkerShapeKind(
      { object_class: 'star', object_type: 'star', label: 'Sirius', epoch_positions: [] },
      true,
    ),
    'square',
  );

  // Compute local pixel flux + variance + flag readout on real buffers
  const testPlane = new Float32Array(256 * 256).fill(10);
  testPlane[128 * 256 + 128] = 46;
  const epochBufs = [Array.from({ length: 6 }, () => testPlane)];
  const flagsBuf = new Uint8Array(256 * 256);
  flagsBuf[128 * 256 + 128] = 2;
  const readout = computeLocalPixelReadout({
    epochBuffers: epochBufs,
    flagsBuffers: [flagsBuf],
    activeEpochIndex: 0,
    wavelengthRangeUm: [0.75, 5.0],
    px: 128,
    py: 128,
  });
  assert.equal(readout.flagByte, 2);
  assert.ok(Math.abs(readout.flux - 46) < 1e-4);
  assert.ok(readout.variance > 100);

  // Expanded global_known_objects.json contains planets, moons, comets, asteroids, stars, nebulae, and galaxies
  const globalCatalog = JSON.parse(
    fs.readFileSync(path.join(PRESETS_DIR, 'global_known_objects.json'), 'utf8'),
  );
  assert.ok(globalCatalog.length >= 620);
  const classes = new Set(globalCatalog.map((item) => item.object_class || item.object_type));
  for (const requiredClass of ['planet', 'moon', 'comet', 'asteroid', 'nebula', 'galaxy']) {
    assert.ok(classes.has(requiredClass), `Missing expanded class ${requiredClass}`);
  }
});

test('Progressive globe click navigation reveals sky panels without auto-opening on zoom', () => {
  assert.equal(resolveGlobeClickAction(70), 'zoom_medium');
  assert.equal(targetFovForClickAction('zoom_medium'), 8.0);
  assert.equal(resolveGlobeClickAction(8.0), 'zoom_panels');
  assert.equal(targetFovForClickAction('zoom_panels'), 1.6);
  assert.equal(resolveGlobeClickAction(1.6), 'open_panel');

  assert.equal(buildVisibleSkyPanels(133.79, -7.25, 8.0).length, 0);
  const panels = buildVisibleSkyPanels(133.79, -7.25, 1.6);
  assert.ok(panels.length > 0);
  assert.ok(panels.some((cell) => cell.key === '133.80_-7.25'));

  const pannedNorth = stepPanCoordinates(359.5, 88.0, 20, 'north');
  assert.ok(pannedNorth.dec <= 89.9);
  const pannedEast = stepPanCoordinates(359.0, 0, 20, 'east');
  assert.ok(pannedEast.ra >= 0 && pannedEast.ra < 360);
  assert.equal(clampGlobeFov(999), 160);
  assert.equal(clampGlobeFov(0.01), 0.25);
});

test('Smart callout placement flips away from right edge & UI panels without occluding object', () => {
  assert.ok(HOVER_DETAILS_DELAY_MS >= 700 && HOVER_DETAILS_DELAY_MS <= 1500);

  // Target near right edge must flip card to the left so marker remains uncovered
  const rightTargetLayout = computeSmartCalloutLayout({
    markerStageX: 890,
    markerStageY: 310,
    stageW: 960,
    stageH: 640,
    cardW: 316,
    cardH: 186,
  });
  assert.equal(rightTargetLayout.side, 'left');
  assert.ok(rightTargetLayout.cardLeft + 316 < 890);

  // Target overlapping top-left controls box should avoid avoidRects cleanly
  const avoidControlsLayout = computeSmartCalloutLayout({
    markerStageX: 355,
    markerStageY: 160,
    stageW: 1100,
    stageH: 700,
    cardW: 316,
    cardH: 186,
    avoidRects: [{ left: 14, top: 14, right: 310, bottom: 420 }],
  });
  assert.equal(avoidControlsLayout.side, 'right');
  assert.ok(avoidControlsLayout.cardLeft > 355);
});

test('Coordinate labels use full names and image provenance distinguishes primary, extension & simulated', () => {
  const coordText = formatRaDecCompact(133.7951, -7.2451);
  assert.ok(coordText.startsWith('Right Ascension 133.7951°, Declination -7.2451°'));
  assert.equal(coordText.includes('—'), false);

  const primaryBadge = formatImageProvenanceBadge({
    primary_mission: 'SPHEREx',
    has_multi_epoch_spherex: true,
    uses_wise_fallback: false,
    baseline_days: 180,
    status_note: 'SPHEREx',
  });
  assert.equal(primaryBadge.tier, 'primary');

  const extBadge = formatImageProvenanceBadge({
    primary_mission: 'SkyView',
    has_multi_epoch_spherex: false,
    uses_wise_fallback: false,
    baseline_days: 0,
    status_note: 'DSS2 IR',
    provenance_tier: 'extension',
    survey_name: 'NASA SkyView (DSS2 IR / Red)',
  });
  assert.equal(extBadge.tier, 'extension');
  assert.equal(extBadge.label, 'NASA SkyView (DSS2 IR / Red)');

  const simBadge = formatImageProvenanceBadge({
    primary_mission: 'Simulated',
    has_multi_epoch_spherex: false,
    uses_wise_fallback: false,
    baseline_days: 0,
    status_note: 'Synthetic baseline',
  });
  assert.equal(simBadge.tier, 'simulated');
});

test('ObservatoryLogger enforces configurable levels and FIFO bufferSize, and replaceUrlState deduplicates', () => {
  const logger = new ObservatoryLogger({ level: 'warn', bufferSize: 20 });
  assert.equal(logger.shouldLog('debug'), false);
  assert.equal(logger.shouldLog('info'), false);
  assert.equal(logger.info('test', 'ignored_info'), null);
  assert.ok(logger.warn('test', 'recorded_warn', { ok: true }));

  logger.configure({ level: 'debug', bufferSize: 20 });
  assert.equal(logger.shouldLog('debug'), true);
  for (let i = 0; i < 25; i += 1) {
    logger.debug('test', `evt_${i}`);
  }
  const entries = logger.getEntries();
  assert.equal(entries.length, 20);
  assert.equal(entries[entries.length - 1].event, 'evt_24');

  let calls = 0;
  const mockLocation = { pathname: '/', search: '', hash: '' };
  const mockHistory = {
    replaceState(_state, _unused, url) {
      calls += 1;
      const qIdx = url.indexOf('?');
      mockLocation.search = qIdx >= 0 ? url.slice(qIdx) : '';
    },
  };
  const firstUrl = replaceUrlState(
    { target: 'wise0855', fov: 70 },
    { location: mockLocation, history: mockHistory },
  );
  replaceUrlState(
    { target: 'wise0855', fov: 70 },
    { location: mockLocation, history: mockHistory },
  );
  assert.ok(firstUrl.includes('target=wise0855'));
  assert.equal(calls, 1);
});

test('Resilient HiPS hierarchy, LoD tiers, projections, and mission epoch filters', async () => {
  assert.equal(resolveGlobeLodTier(45), 'allwise');
  assert.equal(resolveGlobeLodTier(8), '2mass');
  assert.equal(resolveGlobeLodTier(2.5), 'spherex_deep');
  assert.ok(SUPPORTED_GLOBE_PROJECTIONS.some((p) => p.id === 'SIN'));
  assert.ok(SUPPORTED_GLOBE_PROJECTIONS.some((p) => p.id === 'AIT'));

  const primaryCds = await resolveBestDeepSkyHiPS(async (url) =>
    url.startsWith(CDS_SPHEREX_COLOR_HIPS_URL),
  );
  assert.equal(primaryCds.source, 'cds_qr2');
  assert.equal(primaryCds.label, 'SPHEREx QR2 Color (CDS)');

  const mirrorCds = await resolveBestDeepSkyHiPS(async (url) =>
    url.startsWith(CDS_MIRROR_SPHEREX_COLOR_HIPS_URL),
  );
  assert.equal(mirrorCds.source, 'cds_qr2_mirror');
  assert.equal(mirrorCds.label, 'SPHEREx QR2 Color (Mirror)');

  const irsaCube = await resolveBestDeepSkyHiPS(async (url) =>
    url.startsWith(IRSA_SPHEREX_CUBE_HIPS_URL),
  );
  assert.equal(irsaCube.source, 'irsa_spherex_cube');

  const safeFallback = await resolveBestDeepSkyHiPS(async () => false);
  assert.equal(safeFallback.source, 'irsa_2mass_fallback');
  assert.equal(safeFallback.url, IRSA_2MASS_HIPS_URL);

  const epochs = [
    { mission: 'SPHEREx' },
    { mission: 'WISE' },
    { mission: 'SPHEREx' },
    { mission: 'SkyView' },
  ];
  assert.deepEqual(extractAvailableMissions(epochs), [
    { mission: 'SPHEREx', count: 2 },
    { mission: 'WISE', count: 1 },
    { mission: 'SkyView', count: 1 },
  ]);
  const onlyWise = resolveFilteredEpochIndices(epochs, ['WISE']);
  assert.deepEqual(onlyWise, [1]);
  assert.equal(pickNearestAllowedEpoch(2, [0, 3]), 3);
  assert.equal(pickNearestAllowedEpoch(3, [0, 3]), 3);
});

test('Phase 1 pixelEngine: coadd ORs flagsBuffers across coaddIndices and reusable outBuffer matches fresh allocation', () => {
  const epoch0 = makeGaussianEpochPlanes([{ x: 100, y: 100, peak: 5.0 }], 0.01);
  const epoch1 = makeGaussianEpochPlanes([{ x: 140, y: 140, peak: 5.0 }], 0.01);
  const flags0 = new Uint8Array(256 * 256);
  const flags1 = new Uint8Array(256 * 256);
  const p0 = 10 * 256 + 10;
  const p1 = 20 * 256 + 20;
  flags0[p0] = 0x01; // amber flag only in epoch 0
  flags1[p1] = 0x02; // magenta flag only in epoch 1

  const coaddNoFlags = renderEpochBuffersToRgba({
    epochBuffers: [epoch0, epoch1],
    flagsBuffers: [flags0, flags1],
    comparisonMode: 'coadd',
    coaddIndices: [0, 1],
    showFlagsOverlay: false,
  });
  const coaddWithFlags = renderEpochBuffersToRgba({
    epochBuffers: [epoch0, epoch1],
    flagsBuffers: [flags0, flags1],
    comparisonMode: 'coadd',
    coaddIndices: [0, 1],
    showFlagsOverlay: true,
  });

  // Both epoch 0's pixel (10,10) and epoch 1's pixel (20,20) must be tinted
  assert.notDeepEqual(
    Array.from(coaddWithFlags.slice(p0 * 4, p0 * 4 + 4)),
    Array.from(coaddNoFlags.slice(p0 * 4, p0 * 4 + 4)),
  );
  assert.notDeepEqual(
    Array.from(coaddWithFlags.slice(p1 * 4, p1 * 4 + 4)),
    Array.from(coaddNoFlags.slice(p1 * 4, p1 * 4 + 4)),
  );
  // Unflagged pixel remains untouched
  const cleanIdx = (30 * 256 + 30) * 4;
  assert.deepEqual(
    Array.from(coaddWithFlags.slice(cleanIdx, cleanIdx + 4)),
    Array.from(coaddNoFlags.slice(cleanIdx, cleanIdx + 4)),
  );

  // Subset coaddIndices: [1] should only tint p1, not p0
  const coaddOnlySecond = renderEpochBuffersToRgba({
    epochBuffers: [epoch0, epoch1],
    flagsBuffers: [flags0, flags1],
    comparisonMode: 'coadd',
    coaddIndices: [1],
    showFlagsOverlay: true,
  });
  const coaddOnlySecondNoFlags = renderEpochBuffersToRgba({
    epochBuffers: [epoch0, epoch1],
    flagsBuffers: [flags0, flags1],
    comparisonMode: 'coadd',
    coaddIndices: [1],
    showFlagsOverlay: false,
  });
  assert.deepEqual(
    Array.from(coaddOnlySecond.slice(p0 * 4, p0 * 4 + 4)),
    Array.from(coaddOnlySecondNoFlags.slice(p0 * 4, p0 * 4 + 4)),
  );
  assert.notDeepEqual(
    Array.from(coaddOnlySecond.slice(p1 * 4, p1 * 4 + 4)),
    Array.from(coaddOnlySecondNoFlags.slice(p1 * 4, p1 * 4 + 4)),
  );

  // Reusable outBuffer equivalence across blink, subtract, coadd, and empty buffers
  const reusable = new Uint8ClampedArray(256 * 256 * 4);
  for (const comparisonMode of ['blink', 'subtract', 'coadd']) {
    const fresh = renderEpochBuffersToRgba({
      epochBuffers: [epoch0, epoch1],
      flagsBuffers: [flags0, flags1],
      comparisonMode,
      activeEpochIndex: 0,
      passAIndex: 0,
      passBIndex: 1,
      coaddIndices: [0, 1],
      showFlagsOverlay: true,
    });
    const inPlace = renderEpochBuffersToRgba({
      epochBuffers: [epoch0, epoch1],
      flagsBuffers: [flags0, flags1],
      comparisonMode,
      activeEpochIndex: 0,
      passAIndex: 0,
      passBIndex: 1,
      coaddIndices: [0, 1],
      showFlagsOverlay: true,
      outBuffer: reusable,
    });
    assert.equal(inPlace, reusable);
    assert.deepEqual(inPlace, fresh);
  }

  // Non-zero byteOffset sub-view works identically and invalid size throws RangeError
  const padded = new Uint8ClampedArray(256 * 256 * 4 + 16);
  const offsetView = padded.subarray(4, 4 + 256 * 256 * 4);
  const freshBlink = renderEpochBuffersToRgba({ epochBuffers: [epoch0], comparisonMode: 'blink' });
  const viewResult = renderEpochBuffersToRgba({
    epochBuffers: [epoch0],
    comparisonMode: 'blink',
    outBuffer: offsetView,
  });
  assert.equal(viewResult, offsetView);
  assert.deepEqual(viewResult, freshBlink);
  assert.throws(
    () =>
      renderEpochBuffersToRgba({ epochBuffers: [epoch0], outBuffer: new Uint8ClampedArray(16) }),
    RangeError,
  );
});

test('Phase 1 computeLocalPixelReadout computes exact running variance and clamps boundaries', () => {
  const uniformPlane = new Float32Array(256 * 256).fill(4.25);
  const uniformEpoch = Array.from({ length: 6 }, () => uniformPlane);
  const cornerReadout = computeLocalPixelReadout({
    epochBuffers: [uniformEpoch],
    px: -5,
    py: 300,
  });
  assert.equal(cornerReadout.x, 0);
  assert.equal(cornerReadout.y, 255);
  assert.ok(Math.abs(cornerReadout.flux - 4.25) < 1e-5);
  assert.equal(cornerReadout.variance, 0);

  const spikePlane = new Float32Array(256 * 256).fill(10);
  spikePlane[128 * 256 + 128] = 46;
  const spikeEpoch = Array.from({ length: 6 }, () => spikePlane);
  const spikeReadout = computeLocalPixelReadout({
    epochBuffers: [spikeEpoch],
    px: 128.9,
    py: 128.1,
  });
  assert.equal(spikeReadout.x, 128);
  assert.equal(spikeReadout.y, 128);
  assert.ok(Math.abs(spikeReadout.flux - 46) < 1e-5);
  // Exact 3x3 population variance: (8*10^2 + 46^2)/9 - 14^2 = 324 - 196 = 128
  assert.ok(Math.abs(spikeReadout.variance - 128) < 1e-4);
});

test('Phase 1 assignDeterministicHighlighterColors is deterministic and preserves Stage A -> Stage B colors', () => {
  const stageA = [{ object_id: 'gaia:101' }, { object_id: 'wise:202' }, { object_id: 'most:303' }];
  const firstRun = assignDeterministicHighlighterColors(stageA);
  const secondRun = assignDeterministicHighlighterColors(stageA);
  assert.deepEqual(firstRun, secondRun);
  assert.equal(new Set(Object.values(firstRun)).size, 3);

  // Stage B reorders objects and adds new ones; Stage A object_id -> color mappings stay intact
  const stageB = [
    { object_id: 'simbad:999' },
    { object_id: 'most:303' },
    { object_id: 'gaia:101' },
    { object_id: 'wise:202' },
    { object_id: 'gaia:404' },
  ];
  const stageBColors = assignDeterministicHighlighterColors(stageB, firstRun);
  assert.equal(stageBColors['gaia:101'], firstRun['gaia:101']);
  assert.equal(stageBColors['wise:202'], firstRun['wise:202']);
  assert.equal(stageBColors['most:303'], firstRun['most:303']);
  assert.equal(new Set(Object.values(stageBColors)).size, 5);
  assert.deepEqual(assignDeterministicHighlighterColors([]), {});
});

test('Phase 1 SpectraModal contract: preset spectrum channels use 1-based band_index 1..102', () => {
  for (const slug of PRESET_SLUGS) {
    const specPath = path.join(PRESETS_DIR, slug, 'spectrum.json');
    const spectrum = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
    assert.equal(spectrum.channels.length, 102, `${slug}: expected 102 spectral channels`);
    assert.equal(spectrum.channels[0].band_index, 1, `${slug}: first band_index must be 1`);
    assert.equal(spectrum.channels[101].band_index, 102, `${slug}: last band_index must be 102`);
  }
});

test('Phase 1 progressivePatchLoader fetches all epoch binary frames concurrently via Promise.all', async () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(PRESETS_DIR, 'wise_0855', 'manifest.json'), 'utf-8'),
  );
  const float32Frame = new Float32Array(6 * 256 * 256);
  const flagsFrame = new Uint8Array(256 * 256);

  let inFlightDetectors = 0;
  let peakInFlightDetectors = 0;
  let releaseEpochs;
  const epochGate = new Promise((resolve) => {
    releaseEpochs = resolve;
  });

  const mockFetch = async (url) => {
    if (url.endsWith('manifest.json')) {
      return new Response(JSON.stringify(manifest), { status: 200 });
    }
    if (url.endsWith('_flags.bin')) {
      return new Response(flagsFrame.buffer, { status: 200 });
    }
    if (url.endsWith('.bin')) {
      inFlightDetectors += 1;
      peakInFlightDetectors = Math.max(peakInFlightDetectors, inFlightDetectors);
      if (inFlightDetectors === manifest.epochs.length) {
        releaseEpochs();
      }
      await epochGate;
      inFlightDetectors -= 1;
      return new Response(float32Frame.buffer, {
        status: 200,
        headers: { 'X-Binary-Dtype': 'float32' },
      });
    }
    if (url.endsWith('spectrum.json')) {
      return new Response(JSON.stringify({ ra: 0, dec: 0, channels: [] }), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const cache = new ClientPatchCache(4);
  let loaded = null;
  const outcome = await loadPresetPatchFlow('wise_0855', {
    cache,
    fetchImpl: mockFetch,
    onReady: (res) => {
      loaded = res;
    },
  });

  assert.equal(outcome.aborted, false);
  assert.equal(peakInFlightDetectors, manifest.epochs.length);
  assert.equal(loaded.epochBuffers.length, manifest.epochs.length);
  assert.equal(loaded.flagsBuffers.length, manifest.epochs.length);
});

test('Phase 1 TieredLruStore persists to IndexedDB, restores after clearMemory, and prunes LRU entries', async () => {
  const stores = new Map();
  const makeRequest = (executor) => {
    const req = { result: undefined, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      try {
        req.result = executor();
        req.onsuccess?.({ target: req });
      } catch {
        req.onerror?.({ target: req });
      }
    });
    return req;
  };
  const fakeDb = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore: (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
    },
    transaction: (names) => {
      const storeList = Array.isArray(names) ? names : [names];
      const tx = { oncomplete: null, onerror: null, onabort: null };
      let pending = 0;
      const track = (fn) => {
        pending += 1;
        return makeRequest(() => {
          const res = fn();
          queueMicrotask(() => {
            pending -= 1;
            if (pending === 0) tx.oncomplete?.({ target: tx });
          });
          return res;
        });
      };
      tx.objectStore = (name) => {
        if (!storeList.includes(name) || !stores.has(name)) {
          throw new Error(`Unknown store ${name}`);
        }
        const map = stores.get(name);
        return {
          get: (key) => track(() => map.get(key)),
          put: (value, key) => track(() => map.set(key, value)),
          delete: (key) => track(() => map.delete(key)),
          clear: () => track(() => map.clear()),
          openCursor: () => {
            const entries = Array.from(map.entries());
            let idx = 0;
            const req = { result: null, onsuccess: null, onerror: null };
            const advance = () => {
              queueMicrotask(() => {
                if (idx < entries.length) {
                  const [key, value] = entries[idx];
                  idx += 1;
                  req.result = { key, value, continue: advance };
                  req.onsuccess?.({ target: req });
                } else {
                  req.result = null;
                  req.onsuccess?.({ target: req });
                  queueMicrotask(() => {
                    if (pending === 0) tx.oncomplete?.({ target: tx });
                  });
                }
              });
            };
            advance();
            return req;
          },
        };
      };
      return tx;
    },
  };

  const origDesc = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {
      open: () => {
        const req = {
          result: fakeDb,
          onupgradeneeded: null,
          onsuccess: null,
          onerror: null,
          onblocked: null,
        };
        queueMicrotask(() => {
          req.onupgradeneeded?.({ target: req });
          req.onsuccess?.({ target: req });
        });
        return req;
      },
    },
  });

  try {
    const cache = new ClientPatchCache(2);
    assert.equal(cache.isPersistentStorageAvailable(), true);

    const mkBundle = (key) => ({
      cacheKey: key,
      manifest: {
        query: { ra: 0, dec: 0, fov_arcmin: 5, grid_key: key },
        epochs: [],
        catalog_overlays: { known_objects: [] },
      },
      epochBuffers: [],
      flagsBuffers: [],
      spectrum: null,
      storedAt: Date.now(),
      lastAccessed: Date.now(),
    });

    await cache.putPatch(mkBundle('k1'));
    await cache.putPatch(mkBundle('k2'));
    // Touch k1 in memory so k2 becomes the least recently used entry
    assert.ok(await cache.getPatch('k1'));
    // Inserting k3 must evict k2 from both Tier 1 memory and Tier 2 IndexedDB
    await cache.putPatch(mkBundle('k3'));

    cache.clearMemory();
    assert.equal(cache.size.patches, 0);
    assert.equal(await cache.hasPatch('k2'), false);
    assert.ok(await cache.getPatch('k1'), 'k1 must restore from IndexedDB after clearMemory');
    assert.ok(await cache.getPatch('k3'), 'k3 must restore from IndexedDB after clearMemory');
    assert.equal(cache.size.patches, 2);

    await cache.clearAll();
    assert.equal(await cache.hasPatch('k1'), false);
  } finally {
    if (origDesc) {
      Object.defineProperty(globalThis, 'indexedDB', origDesc);
    } else {
      delete globalThis.indexedDB;
    }
  }
});

test('Phase 1 progressivePatchLoader treats aborted non-ok frame responses as AbortError', async () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(PRESETS_DIR, 'wise_0855', 'manifest.json'), 'utf-8'),
  );
  const controller = new AbortController();
  const mockFetch = async (url) => {
    if (url.endsWith('manifest.json')) {
      return new Response(JSON.stringify(manifest), { status: 200 });
    }
    controller.abort();
    return new Response(null, { status: 500 });
  };

  const cache = new ClientPatchCache(2);
  await assert.rejects(
    () =>
      loadPresetPatchFlow('wise_0855', {
        cache,
        fetchImpl: mockFetch,
        signal: controller.signal,
        onReady: () => {
          throw new Error('onReady must not run after abort');
        },
      }),
    (err) => err instanceof Error && err.name === 'AbortError',
  );
});

test('Phase 2 decomposed modules: DEFAULT_MOLECULAR_BANDS, unified grid quantization, WCS edge cases, and binary flags validation', () => {
  // Consolidated DEFAULT_MOLECULAR_BANDS covers H2O, CH4, CO2, and CO within [0.75, 5.0] um
  assert.equal(DEFAULT_MOLECULAR_BANDS.length, 4);
  assert.deepEqual(
    DEFAULT_MOLECULAR_BANDS.map((b) => b.molecule),
    ['h2o', 'ch4', 'co2', 'co'],
  );
  for (const band of DEFAULT_MOLECULAR_BANDS) {
    assert.ok(band.min_um >= 0.75 && band.max_um <= 5.0 && band.min_um < band.max_um);
    assert.ok(band.label.length > 0);
  }

  // Consolidated WAVELENGTH_PRESETS exposes shortLabel for BlinkerControlsSection pills
  for (const preset of WAVELENGTH_PRESETS) {
    assert.ok(typeof preset.shortLabel === 'string' && preset.shortLabel.length > 0);
  }

  // Unified quantizeGridCenter & computeGridKey handle RA wraparound and Dec clamping
  assert.deepEqual(quantizeGridCenter(-10.02, 95.0), { raQ: 350.0, decQ: 90.0 });
  assert.deepEqual(quantizeGridCenter(359.99, -95.0), { raQ: 0.0, decQ: -90.0 });
  assert.equal(computeGridKey(-10.02, 95.0, 5.0), 'ra350.00_dec90.00_fov5.0');
  assert.equal(computeGridKey(359.99, -95.0, 5.0), 'ra0.00_dec-90.00_fov5.0');

  // pixelToSkyWcs wraps RA across 0/360 and clamps Dec to [-90, 90]
  const wcs = {
    width: 256,
    height: 256,
    crval: [0.001, 89.99],
    crpix: [128, 128],
    cdelt: [-0.0003255, 0.0003255],
  };
  const sky = pixelToSkyWcs(200, 200, wcs);
  assert.ok(sky.ra >= 0 && sky.ra < 360);
  assert.ok(sky.dec <= 90 && sky.dec >= -90);

  // screenToImageCoordinates rejects degenerate rects and out-of-rect clicks
  assert.equal(
    screenToImageCoordinates(50, 50, { left: 0, top: 0, width: 0, height: 100 }).inBounds,
    false,
  );
  assert.equal(
    screenToImageCoordinates(-10, 50, { left: 0, top: 0, width: 256, height: 256 }).inBounds,
    false,
  );

  // decodeFlagsBinaryBuffer enforces exact 65,536-byte length
  assert.throws(() => decodeFlagsBinaryBuffer(new ArrayBuffer(1024)));

  // contracts.ts stays strictly pure (constants/types only; zero runtime function exports)
  const exportedFunctions = Object.entries(ContractsModule).filter(
    ([, value]) => typeof value === 'function',
  );
  assert.deepEqual(exportedFunctions, []);
});

test('Phase 2 readStoredNumber safely validates localStorage bounds and SSR fallback', () => {
  // In Node SSR (window undefined), returns fallback
  assert.equal(readStoredNumber('sh_test_width', 292, 240, 420), 292);

  const origWindowDesc = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storageMap = new Map();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      },
    },
  });
  try {
    // Missing key or empty string -> fallback even when 0 is within [min, max]
    assert.equal(readStoredNumber('missing', 292, 240, 420), 292);
    assert.equal(readStoredNumber('missing', 0.5, 0, 1), 0.5);
    storageMap.set('empty', '');
    storageMap.set('whitespace', '   ');
    assert.equal(readStoredNumber('empty', 0.5, 0, 1), 0.5);
    assert.equal(readStoredNumber('whitespace', 0.5, 0, 1), 0.5);
    // Out-of-bounds / non-numeric -> fallback
    storageMap.set('too_small', '120');
    storageMap.set('too_large', '999');
    storageMap.set('nan_val', 'abc');
    assert.equal(readStoredNumber('too_small', 292, 240, 420), 292);
    assert.equal(readStoredNumber('too_large', 292, 240, 420), 292);
    assert.equal(readStoredNumber('nan_val', 292, 240, 420), 292);
    assert.equal(readStoredNumber('empty', 292, 240, 420), 292);
    // Valid stored number (including 0 when inside [min, max]) -> parsed value
    storageMap.set('valid', '340');
    storageMap.set('zero', '0');
    assert.equal(readStoredNumber('valid', 292, 240, 420), 340);
    assert.equal(readStoredNumber('zero', 0.5, 0, 1), 0);
  } finally {
    if (origWindowDesc) {
      Object.defineProperty(globalThis, 'window', origWindowDesc);
    } else {
      delete globalThis.window;
    }
  }
});
