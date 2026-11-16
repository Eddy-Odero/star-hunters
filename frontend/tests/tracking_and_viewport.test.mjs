import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { TRACKING_SQUARE_COLORS, WORLD_CAPITAL_CITIES } from '../src/types/contracts.ts';
import { decodeDetectorBinaryBuffer } from '../src/utils/binaryDecoder.ts';
import {
  detectAndTrackBodiesAtClick,
  detectAndTrackBrightBodyAcrossEpochs,
  mergeTrackedTargets,
} from '../src/utils/clickTracker.ts';
import {
  clampViewportPanZoom,
  computeGridKey,
  computeViewportViewBox,
  screenToImageCoordinates,
} from '../src/utils/wcsViewport.ts';
import {
  PRESET_SLUGS,
  PRESETS_DIR,
  makeGaussianEpochPlanes,
  makeSeededNoiseEpochPlanes,
  makeThreeEpochManifest,
  readArrayBuffer,
  readPresetManifest,
} from './helpers/fixtures.mjs';

test('Click-to-Track detects bright body on origin frame and tracks both forward and backward across epochs', () => {
  const slug = 'wise_0855';
  const manifest = readPresetManifest(slug);
  const realP1 = decodeDetectorBinaryBuffer(
    readArrayBuffer(path.join(PRESETS_DIR, slug, 'pass_1.bin')),
  );
  const realP2 = decodeDetectorBinaryBuffer(
    readArrayBuffer(path.join(PRESETS_DIR, slug, 'pass_2.bin')),
  );
  assert.equal(realP1.length, 6);
  assert.equal(realP2.length, 6);
  assert.ok(realP1[0].some((v) => Number.isFinite(v) && v !== 0));
  assert.ok(realP2[0].some((v) => Number.isFinite(v) && v !== 0));

  const primary = manifest.catalog_overlays.known_objects.find((obj) =>
    obj.object_id.startsWith('wise:'),
  );
  const pass1Pos = primary.epoch_positions.find((pos) => pos.epoch_id === 'pass_1');
  const pass2Pos = primary.epoch_positions.find((pos) => pos.epoch_id === 'pass_2');
  const manifest2 = { ...manifest, epochs: manifest.epochs.slice(0, 2) };
  const p1 = makeGaussianEpochPlanes([{ x: pass1Pos.x, y: pass1Pos.y }]);
  const p2 = makeGaussianEpochPlanes([{ x: pass2Pos.x, y: pass2Pos.y }]);

  // Case A: Click slightly off-center on Pass 1 (originEpochIndex = 0) -> tracks FORWARD to Pass 2
  const forwardTrace = detectAndTrackBrightBodyAcrossEpochs({
    clickX: pass1Pos.x - 1,
    clickY: pass1Pos.y - 1,
    originEpochIndex: 0,
    epochBuffers: [p1, p2],
    manifest: manifest2,
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
    manifest: manifest2,
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
  const baseManifest = readPresetManifest('wise_0855');
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
  const baseManifest = readPresetManifest('wise_0855');
  const manifest3 = makeThreeEpochManifest(baseManifest);

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
  const baseManifest = readPresetManifest('wise_0855');
  const manifest3 = makeThreeEpochManifest(baseManifest);

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
  const baseManifest = readPresetManifest('wise_0855');
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
  const baseManifest = readPresetManifest('wise_0855');
  const manifest3 = makeThreeEpochManifest(baseManifest);

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
  const baseManifest = readPresetManifest('wise_0855');
  const manifest3 = makeThreeEpochManifest(baseManifest);

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
  const baseManifest = readPresetManifest('wise_0855');
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

test('Click-to-Track accurately tracks both stationary field stars and moving targets across all 12 presets and epochs', () => {
  assert.equal(PRESET_SLUGS.length, 12);
  assert.equal(computeGridKey(133.7951, -7.2451, 5.0), 'ra133.80_dec-7.25_fov5.0');
  assert.equal(computeGridKey(133.809, -7.258, 5.0), 'ra133.80_dec-7.25_fov5.0');

  const inSafeBounds = (pos) =>
    Boolean(pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) &&
    pos.x >= 8 &&
    pos.x <= 247 &&
    pos.y >= 8 &&
    pos.y <= 247;

  for (const slug of PRESET_SLUGS) {
    const manifest = readPresetManifest(slug);
    const realP1 = decodeDetectorBinaryBuffer(
      readArrayBuffer(path.join(PRESETS_DIR, slug, 'pass_1.bin')),
    );
    const realP2 = decodeDetectorBinaryBuffer(
      readArrayBuffer(path.join(PRESETS_DIR, slug, 'pass_2.bin')),
    );
    assert.equal(realP1.length, 6);
    assert.equal(realP2.length, 6);
    assert.ok(realP1.some((plane) => plane.some((v) => Number.isFinite(v) && v !== 0)));
    assert.ok(realP2.some((plane) => plane.some((v) => Number.isFinite(v) && v !== 0)));

    const manifest2 = { ...manifest, epochs: manifest.epochs.slice(0, 2) };
    const inBoundsObjects = manifest.catalog_overlays.known_objects.filter(
      (obj) =>
        Array.isArray(obj.epoch_positions) &&
        obj.epoch_positions.length >= 2 &&
        inSafeBounds(obj.epoch_positions[0]) &&
        inSafeBounds(obj.epoch_positions[1]),
    );
    const notables = inBoundsObjects.filter((obj) => obj.default_checked);
    const stationaries = inBoundsObjects.filter((obj) => !obj.default_checked).slice(0, 3);
    const selectedObjects = [...notables, ...stationaries];
    assert.ok(notables.length >= 1, `Preset ${slug}: expected at least 1 in-bounds notable object`);

    for (const obj of selectedObjects) {
      const exp0 = obj.epoch_positions[0];
      const exp1 = obj.epoch_positions[1];
      const p1 = makeGaussianEpochPlanes([{ x: exp0.x, y: exp0.y }]);
      const p2 = makeGaussianEpochPlanes([{ x: exp1.x, y: exp1.y }]);

      for (const originEpochIndex of [0, 1]) {
        const clickPos = obj.epoch_positions[originEpochIndex];
        const trace = detectAndTrackBrightBodyAcrossEpochs({
          clickX: clickPos.x,
          clickY: clickPos.y,
          originEpochIndex,
          epochBuffers: [p1, p2],
          manifest: manifest2,
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
