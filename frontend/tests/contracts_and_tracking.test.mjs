import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BINARY_DETECTOR_FLOAT32_BYTES,
  BINARY_FLAGS_UINT8_BYTES,
  TRACKING_SQUARE_COLORS,
  WORLD_CAPITAL_CITIES,
  clampViewportPanZoom,
  computeDetectorWeights,
  computeGridKey,
  computeViewportViewBox,
  decodeDetectorBinaryBuffer,
  decodeFlagsBinaryBuffer,
  detectAndTrackBodiesAtClick,
  detectAndTrackBrightBodyAcrossEpochs,
  getDefaultCheckedObjectIds,
  screenToImageCoordinates,
} from '../src/types/contracts.ts';
import { ClientPatchCache } from '../src/services/clientPatchCache.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRESETS_DIR = path.resolve(__dirname, '../public/presets');

function readArrayBuffer(filePath) {
  const buf = fs.readFileSync(filePath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
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

test('Wavelength Dim & Pop detector weights isolate cold IR detectors (3.8 - 5.0 um)', () => {
  const coldWeights = computeDetectorWeights([3.8, 5.0]);
  // Detectors 1..4 (indices 0..3) are at the 5% floor, Detectors 5..6 (indices 4..5) are at 100%
  assert.ok(Math.abs(coldWeights[0] - 0.05) < 1e-6);
  assert.ok(Math.abs(coldWeights[2] - 0.05) < 1e-6);
  assert.ok(Math.abs(coldWeights[4] - 1.0) < 1e-6);
  assert.ok(Math.abs(coldWeights[5] - 1.0) < 1e-6);
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

  // Case A: Click slightly off-center at (123, 125) on Pass 1 (originEpochIndex = 0) -> tracks FORWARD to Pass 2
  const forwardTrace = detectAndTrackBrightBodyAcrossEpochs({
    clickX: 123,
    clickY: 125,
    originEpochIndex: 0,
    epochBuffers: [p1, p2],
    manifest,
    wavelengthRangeUm: [3.8, 5.0],
  });

  assert.equal(forwardTrace.status, 'tracked');
  assert.equal(forwardTrace.originEpochIndex, 0);
  assert.ok(
    Math.hypot(forwardTrace.originCentroidX - 124.0, forwardTrace.originCentroidY - 126.0) < 0.6,
  );
  assert.equal(forwardTrace.waypoints.length, 2);
  assert.ok(
    Math.hypot(forwardTrace.waypoints[0].x - 124.0, forwardTrace.waypoints[0].y - 126.0) < 0.6,
  );
  assert.ok(
    Math.hypot(forwardTrace.waypoints[1].x - 132.0, forwardTrace.waypoints[1].y - 130.0) < 0.8,
  );
  assert.ok(forwardTrace.properMotionArcsecPerYr > 5.0);
  assert.equal(forwardTrace.matchedCatalog, 'wise');
  assert.equal(forwardTrace.isUncatalogedMover, false);

  // Case B: Click slightly off-center at (133, 131) on Pass 2 (originEpochIndex = 1) -> tracks BACKWARD to Pass 1
  const backwardTrace = detectAndTrackBrightBodyAcrossEpochs({
    clickX: 133,
    clickY: 131,
    originEpochIndex: 1,
    epochBuffers: [p1, p2],
    manifest,
    wavelengthRangeUm: [3.8, 5.0],
  });

  assert.equal(backwardTrace.status, 'tracked');
  assert.equal(backwardTrace.originEpochIndex, 1);
  assert.ok(
    Math.hypot(backwardTrace.originCentroidX - 132.0, backwardTrace.originCentroidY - 130.0) < 0.6,
  );
  assert.ok(
    Math.hypot(backwardTrace.waypoints[0].x - 124.0, backwardTrace.waypoints[0].y - 126.0) < 0.8,
  );
  assert.ok(
    Math.hypot(backwardTrace.waypoints[1].x - 132.0, backwardTrace.waypoints[1].y - 130.0) < 0.6,
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
  assert.equal(WORLD_CAPITAL_CITIES.length, 12);
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

test('Click-to-Track accurately tracks both stationary field stars and moving targets across all 6 presets and epochs', () => {
  const slugs = [
    'wise_0855',
    'barnards_star',
    'epsilon_indi_b',
    'rw_aurigae',
    'r_draconis',
    'comet_3i_atlas',
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
