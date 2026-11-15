/**
 * Click-to-Track multi-epoch trajectory discovery, overlapped-body branch
 * separation, catalog cross-matching, and target-list color merging.
 *
 * Kept React-free so Node 24's `node --test` executes this module directly.
 */

import {
  GRID_HEIGHT,
  GRID_WIDTH,
  TRACKING_SQUARE_COLORS,
  type CatalogSourceType,
  type ClickTrackingResult,
  type SkyPatchManifest,
  type TracedObjectSummary,
  type TracedWaypoint,
  type TrackSummaryStatus,
  type WaypointTrackingStatus,
} from '../types/contracts.ts';
import {
  buildCompositeFrames,
  buildTransientDifferenceFrames,
  checkStationaryAtSpot,
  findLocalPeakAndCentroid,
  findSecondaryOriginPeaks,
  findSeparatedMovingPeaks,
  type CentroidDetection,
} from './clickTrackerCentroid.ts';
import { pickDistinctHighlighterColors } from './knownObjectSelection.ts';
import { pixelToSkyWcs } from './wcsViewport.ts';

/** Parameters for {@link detectAndTrackBodiesAtClick} and {@link detectAndTrackBrightBodyAcrossEpochs}. */
export interface ClickTrackingParams {
  clickX: number;
  clickY: number;
  originEpochIndex: number;
  epochBuffers: Float32Array[][];
  manifest: SkyPatchManifest;
  wavelengthRangeUm: [number, number];
  localRadiusPx?: number;
  crossEpochSearchRadiusPx?: number;
  minSnrThreshold?: number;
  colorIndexOffset?: number;
}

interface BranchSeed {
  kind: 'moving' | 'stationary';
  originPeak: CentroidDetection;
  seedEpochIdx: number;
  seedDetection: CentroidDetection;
}

function isPeakExplainedByExistingSeed(
  candPeak: CentroidDetection,
  epIdx: number,
  clampedOrigin: number,
  branchSeeds: readonly BranchSeed[],
  manifest: SkyPatchManifest,
): boolean {
  const mjdTarget = manifest.epochs[epIdx].mjd;
  const mjdOrigin = manifest.epochs[clampedOrigin].mjd;
  const predictions: Array<{ x: number; y: number }> = [];

  for (const existing of branchSeeds) {
    if (existing.kind !== 'moving') continue;
    if (existing.seedEpochIdx === epIdx) {
      if (
        Math.hypot(existing.seedDetection.x - candPeak.x, existing.seedDetection.y - candPeak.y) <
        3.5
      ) {
        return true;
      }
      continue;
    }
    const dtSeed = manifest.epochs[existing.seedEpochIdx].mjd - mjdOrigin;
    const dtTarget = mjdTarget - mjdOrigin;
    if (Math.abs(dtSeed) > 1e-3) {
      const predX =
        existing.originPeak.x +
        ((existing.seedDetection.x - existing.originPeak.x) / dtSeed) * dtTarget;
      const predY =
        existing.originPeak.y +
        ((existing.seedDetection.y - existing.originPeak.y) / dtSeed) * dtTarget;
      if (Math.hypot(predX - candPeak.x, predY - candPeak.y) < 4.5) {
        return true;
      }
      predictions.push({ x: predX, y: predY });
    }
  }

  // A widened detection sitting on the segment between two predicted branches is their blend.
  for (let i = 0; i < predictions.length; i += 1) {
    for (let j = i + 1; j < predictions.length; j += 1) {
      const a = predictions[i];
      const b = predictions[j];
      const segX = b.x - a.x;
      const segY = b.y - a.y;
      const segLenSq = segX * segX + segY * segY;
      if (segLenSq < 20.0) continue;
      const t = Math.max(
        0,
        Math.min(1, ((candPeak.x - a.x) * segX + (candPeak.y - a.y) * segY) / segLenSq),
      );
      const closestX = a.x + t * segX;
      const closestY = a.y + t * segY;
      if (Math.hypot(candPeak.x - closestX, candPeak.y - closestY) <= 2.2) {
        return true;
      }
    }
  }
  return false;
}

function discoverBranchSeeds(params: {
  clickX: number;
  clickY: number;
  clampedOrigin: number;
  numEpochs: number;
  localRadiusPx: number;
  crossEpochSearchRadiusPx: number;
  minSnrThreshold: number;
  originDetection: CentroidDetection;
  compositeFrames: Float32Array[];
  transientDifferenceFrames: Float32Array[];
  manifest: SkyPatchManifest;
}): BranchSeed[] {
  const {
    clickX,
    clickY,
    clampedOrigin,
    numEpochs,
    localRadiusPx,
    crossEpochSearchRadiusPx,
    minSnrThreshold,
    originDetection,
    compositeFrames,
    transientDifferenceFrames,
    manifest,
  } = params;

  if (numEpochs < 2) {
    return [
      {
        kind: 'stationary',
        originPeak: originDetection,
        seedEpochIdx: clampedOrigin,
        seedDetection: originDetection,
      },
    ];
  }

  const secondaryOriginPeaks = findSecondaryOriginPeaks(
    compositeFrames[clampedOrigin],
    clickX,
    clickY,
    localRadiusPx,
    originDetection,
    minSnrThreshold,
  );
  const peaksByEpoch = new Map<number, CentroidDetection[]>();
  let bestSepEpochIdx = -1;
  let bestSepPeaks: CentroidDetection[] = [];
  let hasStationaryInAnyOtherEpoch = false;
  let stationaryDroppedFlux = false;

  for (let epIdx = 0; epIdx < numEpochs; epIdx += 1) {
    if (epIdx === clampedOrigin) continue;
    const stat = checkStationaryAtSpot(
      compositeFrames[epIdx],
      originDetection.x,
      originDetection.y,
      originDetection.netFlux,
      minSnrThreshold,
    );
    if (stat) {
      hasStationaryInAnyOtherEpoch = true;
      if (stat.netFlux <= 0.85 * originDetection.netFlux) {
        stationaryDroppedFlux = true;
      }
    }

    const originComp = compositeFrames[clampedOrigin];
    const targetComp = compositeFrames[epIdx];
    const xMin = Math.max(1, Math.floor(clickX - localRadiusPx));
    const xMax = Math.min(GRID_WIDTH - 2, Math.ceil(clickX + localRadiusPx));
    const yMin = Math.max(1, Math.floor(clickY - localRadiusPx));
    const yMax = Math.min(GRID_HEIGHT - 2, Math.ceil(clickY + localRadiusPx));
    const rSq = localRadiusPx * localRadiusPx;
    let maxDepartFlux = 0;
    for (let py = yMin; py <= yMax; py += 1) {
      const dy = py - clickY;
      for (let px = xMin; px <= xMax; px += 1) {
        const dx = px - clickX;
        if (dx * dx + dy * dy > rSq) continue;
        const dep = originComp[py * GRID_WIDTH + px] - 0.98 * targetComp[py * GRID_WIDTH + px];
        if (dep > maxDepartFlux) maxDepartFlux = dep;
      }
    }
    if (maxDepartFlux >= Math.max(0.05, 0.18 * originDetection.netFlux)) {
      stationaryDroppedFlux = true;
    }

    const stepFactor = Math.max(1, Math.abs(epIdx - clampedOrigin));
    const peaks = findSeparatedMovingPeaks({
      diffComp: transientDifferenceFrames[epIdx],
      rawComp: compositeFrames[epIdx],
      originDetection,
      searchCenterX: originDetection.x,
      searchCenterY: originDetection.y,
      searchRadius: crossEpochSearchRadiusPx * stepFactor,
      minSnrThreshold,
    });
    peaksByEpoch.set(epIdx, peaks);
    if (peaks.length > bestSepPeaks.length) {
      bestSepPeaks = peaks;
      bestSepEpochIdx = epIdx;
    }
  }

  const pickOriginPeakForMover = (
    moverPeak: CentroidDetection,
    epIdx: number,
  ): CentroidDetection => {
    if (secondaryOriginPeaks.length === 0) return originDetection;
    const allOriginPeaks = [originDetection, ...secondaryOriginPeaks];
    const departingOrigins = allOriginPeaks.filter((op) => {
      const st = checkStationaryAtSpot(
        compositeFrames[epIdx],
        op.x,
        op.y,
        op.netFlux,
        minSnrThreshold,
      );
      return st === null || st.netFlux <= 0.85 * op.netFlux;
    });
    const pool = departingOrigins.length > 0 ? departingOrigins : allOriginPeaks;
    let bestOp = pool[0];
    let bestDist = Math.hypot(moverPeak.x - bestOp.x, moverPeak.y - bestOp.y);
    for (const op of pool.slice(1)) {
      const d = Math.hypot(moverPeak.x - op.x, moverPeak.y - op.y);
      if (d < bestDist) {
        bestDist = d;
        bestOp = op;
      }
    }
    return bestOp;
  };

  const hasSecondaryDepartingOrigin = secondaryOriginPeaks.some((op) => {
    for (let epIdx = 0; epIdx < numEpochs; epIdx += 1) {
      if (epIdx === clampedOrigin) continue;
      const st = checkStationaryAtSpot(
        compositeFrames[epIdx],
        op.x,
        op.y,
        op.netFlux,
        minSnrThreshold,
      );
      if (st === null || st.netFlux <= 0.85 * op.netFlux) return true;
    }
    return false;
  });

  const branchSeeds: BranchSeed[] = [];
  if (hasStationaryInAnyOtherEpoch && !stationaryDroppedFlux && !hasSecondaryDepartingOrigin) {
    branchSeeds.push({
      kind: 'stationary',
      originPeak: originDetection,
      seedEpochIdx: clampedOrigin,
      seedDetection: originDetection,
    });
    return branchSeeds;
  }

  if (bestSepPeaks.length >= 1 && bestSepEpochIdx >= 0) {
    for (const pk of bestSepPeaks) {
      branchSeeds.push({
        kind: 'moving',
        originPeak: pickOriginPeakForMover(pk, bestSepEpochIdx),
        seedEpochIdx: bestSepEpochIdx,
        seedDetection: pk,
      });
    }
    if (!hasStationaryInAnyOtherEpoch || stationaryDroppedFlux || hasSecondaryDepartingOrigin) {
      for (const [epIdx, epPeaks] of peaksByEpoch.entries()) {
        if (epIdx === bestSepEpochIdx) continue;
        for (const candPk of epPeaks) {
          if (!isPeakExplainedByExistingSeed(candPk, epIdx, clampedOrigin, branchSeeds, manifest)) {
            branchSeeds.push({
              kind: 'moving',
              originPeak: pickOriginPeakForMover(candPk, epIdx),
              seedEpochIdx: epIdx,
              seedDetection: candPk,
            });
          }
        }
      }
    }
    if (hasStationaryInAnyOtherEpoch && (stationaryDroppedFlux || hasSecondaryDepartingOrigin)) {
      const statSeed =
        checkStationaryAtSpot(
          compositeFrames[bestSepEpochIdx],
          originDetection.x,
          originDetection.y,
          originDetection.netFlux,
          minSnrThreshold,
        ) ?? originDetection;
      branchSeeds.push({
        kind: 'stationary',
        originPeak: originDetection,
        seedEpochIdx: bestSepEpochIdx,
        seedDetection: statSeed,
      });
    }
    for (const secOp of secondaryOriginPeaks) {
      const secSt = checkStationaryAtSpot(
        compositeFrames[bestSepEpochIdx],
        secOp.x,
        secOp.y,
        secOp.netFlux,
        minSnrThreshold,
      );
      if (secSt && secSt.netFlux > 0.85 * secOp.netFlux) {
        branchSeeds.push({
          kind: 'stationary',
          originPeak: secOp,
          seedEpochIdx: bestSepEpochIdx,
          seedDetection: secSt,
        });
      }
    }
    return branchSeeds;
  }

  branchSeeds.push({
    kind: 'stationary',
    originPeak: originDetection,
    seedEpochIdx: clampedOrigin,
    seedDetection: originDetection,
  });
  return branchSeeds;
}

function buildBranchSummary(params: {
  seed: BranchSeed;
  branchIndex: number;
  totalBranches: number;
  isOverlapped: boolean;
  groupId: string;
  clickX: number;
  clickY: number;
  clampedOrigin: number;
  numEpochs: number;
  crossEpochSearchRadiusPx: number;
  minSnrThreshold: number;
  colorIndexOffset: number;
  compositeFrames: Float32Array[];
  transientDifferenceFrames: Float32Array[];
  manifest: SkyPatchManifest;
}): TracedObjectSummary {
  const {
    seed,
    branchIndex,
    totalBranches,
    isOverlapped,
    groupId,
    clickX,
    clickY,
    clampedOrigin,
    numEpochs,
    crossEpochSearchRadiusPx,
    minSnrThreshold,
    colorIndexOffset,
    compositeFrames,
    transientDifferenceFrames,
    manifest,
  } = params;

  const waypoints: TracedWaypoint[] = new Array(numEpochs);
  const lostEpochIds: string[] = [];
  const branchOrigin = seed.originPeak;
  const branchOriginSky = pixelToSkyWcs(branchOrigin.x, branchOrigin.y, manifest.wcs);
  const originEpochMeta = manifest.epochs[clampedOrigin];

  waypoints[clampedOrigin] = {
    epoch_id: originEpochMeta.epoch_id,
    epoch_index: clampedOrigin,
    mjd: originEpochMeta.mjd,
    iso_date: originEpochMeta.iso_date,
    x: branchOrigin.x,
    y: branchOrigin.y,
    ra: branchOriginSky.ra,
    dec: branchOriginSky.dec,
    peak_flux: branchOrigin.peakFlux,
    snr: branchOrigin.snr,
    status: 'tracked',
    visible: true,
  };

  const locateBranchInEpoch = (
    targetEpochIdx: number,
    fallbackX: number,
    fallbackY: number,
  ): TracedWaypoint => {
    const epMeta = manifest.epochs[targetEpochIdx];

    if (seed.kind === 'stationary') {
      const stat = checkStationaryAtSpot(
        compositeFrames[targetEpochIdx],
        branchOrigin.x,
        branchOrigin.y,
        branchOrigin.netFlux,
        minSnrThreshold,
      );
      if (stat) {
        const sky = pixelToSkyWcs(stat.x, stat.y, manifest.wcs);
        return {
          epoch_id: epMeta.epoch_id,
          epoch_index: targetEpochIdx,
          mjd: epMeta.mjd,
          iso_date: epMeta.iso_date,
          x: stat.x,
          y: stat.y,
          ra: sky.ra,
          dec: sky.dec,
          peak_flux: stat.peakFlux,
          snr: stat.snr,
          status: 'tracked',
          visible: true,
        };
      }
    }

    let searchX = fallbackX;
    let searchY = fallbackY;
    let searchRadius = crossEpochSearchRadiusPx;

    if (seed.kind === 'moving' && seed.seedEpochIdx !== clampedOrigin) {
      if (targetEpochIdx === seed.seedEpochIdx) {
        const sky = pixelToSkyWcs(seed.seedDetection.x, seed.seedDetection.y, manifest.wcs);
        return {
          epoch_id: epMeta.epoch_id,
          epoch_index: targetEpochIdx,
          mjd: epMeta.mjd,
          iso_date: epMeta.iso_date,
          x: seed.seedDetection.x,
          y: seed.seedDetection.y,
          ra: sky.ra,
          dec: sky.dec,
          peak_flux: seed.seedDetection.peakFlux,
          snr: seed.seedDetection.snr,
          status: 'tracked',
          visible: true,
        };
      }
      const dtSeed = manifest.epochs[seed.seedEpochIdx].mjd - originEpochMeta.mjd;
      const dtTarget = epMeta.mjd - originEpochMeta.mjd;
      if (Math.abs(dtSeed) > 1e-3) {
        searchX = branchOrigin.x + ((seed.seedDetection.x - branchOrigin.x) / dtSeed) * dtTarget;
        searchY = branchOrigin.y + ((seed.seedDetection.y - branchOrigin.y) / dtSeed) * dtTarget;
        searchRadius = isOverlapped ? 4.0 : crossEpochSearchRadiusPx;
      }
    }

    if (searchX < 1 || searchX >= GRID_WIDTH - 1 || searchY < 1 || searchY >= GRID_HEIGHT - 1) {
      const clampedX = Number(Math.max(0, Math.min(GRID_WIDTH - 1, searchX)).toFixed(2));
      const clampedY = Number(Math.max(0, Math.min(GRID_HEIGHT - 1, searchY)).toFixed(2));
      const sky = pixelToSkyWcs(clampedX, clampedY, manifest.wcs);
      lostEpochIds.push(epMeta.epoch_id);
      return {
        epoch_id: epMeta.epoch_id,
        epoch_index: targetEpochIdx,
        mjd: epMeta.mjd,
        iso_date: epMeta.iso_date,
        x: clampedX,
        y: clampedY,
        ra: sky.ra,
        dec: sky.dec,
        peak_flux: 0,
        snr: 0,
        status: 'out_of_bounds',
        visible: false,
      };
    }

    const diffPeak = findLocalPeakAndCentroid(
      transientDifferenceFrames[targetEpochIdx],
      searchX,
      searchY,
      searchRadius,
    );
    const refined = findLocalPeakAndCentroid(
      compositeFrames[targetEpochIdx],
      diffPeak.x,
      diffPeak.y,
      2.5,
    );

    if (
      diffPeak.netFlux >= Math.max(0.04, 0.12 * branchOrigin.netFlux) &&
      Math.hypot(refined.x - searchX, refined.y - searchY) <= searchRadius + 0.8 &&
      refined.snr >= minSnrThreshold &&
      refined.netFlux >= Math.max(0.04, 0.12 * branchOrigin.netFlux)
    ) {
      const sky = pixelToSkyWcs(refined.x, refined.y, manifest.wcs);
      return {
        epoch_id: epMeta.epoch_id,
        epoch_index: targetEpochIdx,
        mjd: epMeta.mjd,
        iso_date: epMeta.iso_date,
        x: refined.x,
        y: refined.y,
        ra: sky.ra,
        dec: sky.dec,
        peak_flux: refined.peakFlux,
        snr: refined.snr,
        status: 'tracked',
        visible: true,
      };
    }

    const localCheck = findLocalPeakAndCentroid(
      compositeFrames[targetEpochIdx],
      fallbackX,
      fallbackY,
      2.5,
    );
    if (
      (!isOverlapped || seed.kind === 'stationary') &&
      localCheck.snr >= minSnrThreshold &&
      localCheck.netFlux >= Math.max(0.04, 0.15 * branchOrigin.netFlux)
    ) {
      const sky = pixelToSkyWcs(localCheck.x, localCheck.y, manifest.wcs);
      return {
        epoch_id: epMeta.epoch_id,
        epoch_index: targetEpochIdx,
        mjd: epMeta.mjd,
        iso_date: epMeta.iso_date,
        x: localCheck.x,
        y: localCheck.y,
        ra: sky.ra,
        dec: sky.dec,
        peak_flux: localCheck.peakFlux,
        snr: localCheck.snr,
        status: 'tracked',
        visible: true,
      };
    }

    lostEpochIds.push(epMeta.epoch_id);
    const holdX = Number(Math.max(0, Math.min(GRID_WIDTH - 1, searchX)).toFixed(2));
    const holdY = Number(Math.max(0, Math.min(GRID_HEIGHT - 1, searchY)).toFixed(2));
    const sky = pixelToSkyWcs(holdX, holdY, manifest.wcs);
    const lossStatus: WaypointTrackingStatus = localCheck.snr >= 1.2 ? 'low_snr' : 'lost';
    return {
      epoch_id: epMeta.epoch_id,
      epoch_index: targetEpochIdx,
      mjd: epMeta.mjd,
      iso_date: epMeta.iso_date,
      x: holdX,
      y: holdY,
      ra: sky.ra,
      dec: sky.dec,
      peak_flux: localCheck.peakFlux,
      snr: localCheck.snr,
      status: lossStatus,
      visible: false,
    };
  };

  // Track backward (originEpochIndex - 1 down to 0)
  let prevX = branchOrigin.x;
  let prevY = branchOrigin.y;
  for (let idx = clampedOrigin - 1; idx >= 0; idx -= 1) {
    const wp = locateBranchInEpoch(idx, prevX, prevY);
    waypoints[idx] = wp;
    if (wp.status === 'tracked') {
      prevX = wp.x;
      prevY = wp.y;
    }
  }

  // Track forward (originEpochIndex + 1 up to numEpochs - 1)
  let nextX = branchOrigin.x;
  let nextY = branchOrigin.y;
  for (let idx = clampedOrigin + 1; idx < numEpochs; idx += 1) {
    let predX = nextX;
    let predY = nextY;
    if (
      idx - 2 >= 0 &&
      waypoints[idx - 1]?.status === 'tracked' &&
      waypoints[idx - 2]?.status === 'tracked'
    ) {
      const wpPrev = waypoints[idx - 1];
      const wpPrev2 = waypoints[idx - 2];
      const dtPrev = wpPrev.mjd - wpPrev2.mjd;
      const dtCurr = manifest.epochs[idx].mjd - wpPrev.mjd;
      if (Math.abs(dtPrev) > 1e-3 && Math.abs(dtCurr) > 1e-3) {
        predX = wpPrev.x + ((wpPrev.x - wpPrev2.x) / dtPrev) * dtCurr;
        predY = wpPrev.y + ((wpPrev.y - wpPrev2.y) / dtPrev) * dtCurr;
      }
    }
    const wp = locateBranchInEpoch(idx, predX, predY);
    waypoints[idx] = wp;
    if (wp.status === 'tracked') {
      nextX = wp.x;
      nextY = wp.y;
    }
  }

  const trackedWaypoints = waypoints.filter((w) => w.status === 'tracked');
  const firstWp = trackedWaypoints[0] ?? waypoints[0];
  const lastWp = trackedWaypoints[trackedWaypoints.length - 1] ?? waypoints[numEpochs - 1];
  const dxPx = lastWp.x - firstWp.x;
  const dyPx = lastWp.y - firstWp.y;
  const distPx = Math.hypot(dxPx, dyPx);
  const pixelScaleArcsec = Math.abs(manifest.wcs.cdelt[1]) * 3600.0;
  const baselineYears = Math.max(1e-4, Math.abs(lastWp.mjd - firstWp.mjd) / 365.25);
  const properMotionArcsecPerYr =
    trackedWaypoints.length >= 2
      ? Number(((distPx * pixelScaleArcsec) / baselineYears).toFixed(3))
      : 0;
  const positionAngleDeg = Number(
    (((Math.atan2(dxPx, dyPx) * 180.0) / Math.PI + 360.0) % 360.0).toFixed(1),
  );

  // Cross-match against known_objects across both origin and target epoch positions
  const knownObjects = manifest.catalog_overlays.known_objects ?? [];
  let matchedObjectId: string | null = null;
  let matchedCatalog: CatalogSourceType | null = null;
  let matchedLabel: string | null = null;
  let bestDist = 4.5;

  for (const obj of knownObjects) {
    const originPos =
      obj.epoch_positions.find((p) => p.epoch_id === originEpochMeta.epoch_id) ?? obj;
    const dOrigin = Math.hypot(originPos.x - branchOrigin.x, originPos.y - branchOrigin.y);
    if (dOrigin < bestDist) {
      const lastPos = obj.epoch_positions.find((p) => p.epoch_id === lastWp.epoch_id) ?? obj;
      const dLast = Math.hypot(lastPos.x - lastWp.x, lastPos.y - lastWp.y);
      const combinedScore = isOverlapped ? Math.max(dOrigin, dLast) : dOrigin;
      if (combinedScore < bestDist) {
        bestDist = combinedScore;
        matchedObjectId = obj.object_id;
        matchedCatalog = obj.catalog;
        matchedLabel = obj.label;
      }
    }
  }

  const isUncatalogedMover = matchedObjectId === null && properMotionArcsecPerYr >= 0.2;
  const color =
    TRACKING_SQUARE_COLORS[(colorIndexOffset + branchIndex) % TRACKING_SQUARE_COLORS.length];
  const summaryStatus: TrackSummaryStatus = lostEpochIds.length > 0 ? 'partially_lost' : 'tracked';
  const statusMessage =
    lostEpochIds.length > 0
      ? `Tracked across ${numEpochs - lostEpochIds.length}/${numEpochs} epochs (lost in ${lostEpochIds.join(', ')})`
      : isOverlapped
        ? `Overlapped body branch #${branchIndex + 1} of ${totalBranches} separated across epochs`
        : `Tracked across all ${numEpochs} epochs`;

  return {
    trackId: `${groupId}_b${branchIndex}`,
    groupId,
    branchIndex,
    totalBranchesInClick: totalBranches,
    isOverlappedAtOrigin: isOverlapped,
    color,
    status: summaryStatus,
    statusMessage,
    originEpochIndex: clampedOrigin,
    clickX,
    clickY,
    originCentroidX: branchOrigin.x,
    originCentroidY: branchOrigin.y,
    ra: branchOriginSky.ra,
    dec: branchOriginSky.dec,
    x1: waypoints[0].x,
    y1: waypoints[0].y,
    xN: waypoints[numEpochs - 1].x,
    yN: waypoints[numEpochs - 1].y,
    waypoints,
    lostEpochIds,
    properMotionArcsecPerYr,
    positionAngleDeg,
    matchedObjectId,
    matchedCatalog,
    matchedLabel,
    isUncatalogedMover,
  };
}

/**
 * Detect all bodies at or near `(clickX, clickY)` on `originEpochIndex` — including
 * overlapped bodies that separate in earlier or later epochs — and track each branch
 * backward and forward across all cached epochs.
 *
 * @param params - Click coordinates, origin epoch index, epoch buffers, manifest, and thresholds.
 * @returns {@link ClickTrackingResult} containing separated branches or `no_body_found`.
 */
export function detectAndTrackBodiesAtClick(params: ClickTrackingParams): ClickTrackingResult {
  const {
    clickX,
    clickY,
    originEpochIndex,
    epochBuffers,
    manifest,
    wavelengthRangeUm,
    localRadiusPx = 6,
    crossEpochSearchRadiusPx = 18,
    minSnrThreshold = 3.0,
    colorIndexOffset = 0,
  } = params;

  const numEpochs = Math.min(epochBuffers.length, manifest.epochs.length);
  const clampedOrigin = Math.max(0, Math.min(Math.max(0, numEpochs - 1), originEpochIndex));

  if (
    numEpochs === 0 ||
    !Number.isFinite(clickX) ||
    !Number.isFinite(clickY) ||
    clickX < 0 ||
    clickX >= GRID_WIDTH ||
    clickY < 0 ||
    clickY >= GRID_HEIGHT
  ) {
    return {
      status: 'no_body_found',
      message: 'Clicked coordinates are outside the 256x256 sky patch bounds.',
      clickX,
      clickY,
      originEpochIndex: clampedOrigin,
      isOverlapped: false,
      tracks: [],
    };
  }

  const compositeFrames = buildCompositeFrames(epochBuffers, numEpochs, wavelengthRangeUm);
  const originDetection = findLocalPeakAndCentroid(
    compositeFrames[clampedOrigin],
    clickX,
    clickY,
    localRadiusPx,
  );

  if (originDetection.snr < minSnrThreshold || originDetection.netFlux <= 0.04) {
    return {
      status: 'no_body_found',
      message: `No bright body identified near (${clickX.toFixed(1)}, ${clickY.toFixed(1)}) on Pass ${clampedOrigin + 1} (SNR ${originDetection.snr.toFixed(1)} < ${minSnrThreshold.toFixed(1)}).`,
      clickX,
      clickY,
      originEpochIndex: clampedOrigin,
      isOverlapped: false,
      tracks: [],
    };
  }

  const transientDifferenceFrames = buildTransientDifferenceFrames(compositeFrames, clampedOrigin);
  const branchSeeds = discoverBranchSeeds({
    clickX,
    clickY,
    clampedOrigin,
    numEpochs,
    localRadiusPx,
    crossEpochSearchRadiusPx,
    minSnrThreshold,
    originDetection,
    compositeFrames,
    transientDifferenceFrames,
    manifest,
  });

  const isOverlapped = branchSeeds.length > 1;
  const groupId = `group_ep${clampedOrigin}_x${Math.round(originDetection.x)}_y${Math.round(originDetection.y)}`;

  const tracks = branchSeeds.map((seed, idx) =>
    buildBranchSummary({
      seed,
      branchIndex: idx,
      totalBranches: branchSeeds.length,
      isOverlapped,
      groupId,
      clickX,
      clickY,
      clampedOrigin,
      numEpochs,
      crossEpochSearchRadiusPx,
      minSnrThreshold,
      colorIndexOffset,
      compositeFrames,
      transientDifferenceFrames,
      manifest,
    }),
  );

  const anyLost = tracks.some((t) => t.status === 'partially_lost');
  return {
    status: anyLost ? 'partially_lost' : 'tracked',
    message: isOverlapped
      ? `Detected ${tracks.length} overlapped bodies at (${originDetection.x}, ${originDetection.y}) that separate across epochs.`
      : tracks[0].statusMessage,
    clickX,
    clickY,
    originEpochIndex: clampedOrigin,
    isOverlapped,
    tracks,
  };
}

/**
 * Merge a fresh click-tracking result into the accumulated `trackedTargets` list.
 *
 * Every retained and newly added target keeps a distinct color from
 * `TRACKING_SQUARE_COLORS`; re-clicking the same group or catalog object replaces
 * its previous branches instead of duplicating them.
 *
 * @param existing - Currently active tracked target summaries.
 * @param incoming - New branch summaries emitted by {@link detectAndTrackBodiesAtClick}.
 * @param options - Optional checked IDs, pre-assigned highlighter colors, and RNG.
 * @returns Updated `TracedObjectSummary[]` list.
 */
export function mergeTrackedTargets(
  existing: TracedObjectSummary[],
  incoming: TracedObjectSummary[],
  options: {
    checkedObjectIds?: Iterable<string>;
    objectHighlighterColors?: Record<string, string>;
    rng?: () => number;
  } = {},
): TracedObjectSummary[] {
  if (incoming.length === 0) return existing;

  const { checkedObjectIds = [], objectHighlighterColors = {}, rng = Math.random } = options;

  const incomingGroupId = incoming[0].groupId;
  const incomingMatchedIds = new Set(
    incoming.map((t) => t.matchedObjectId).filter((id): id is string => Boolean(id)),
  );
  const retained = existing.filter(
    (t) =>
      t.groupId !== incomingGroupId &&
      (!t.matchedObjectId || !incomingMatchedIds.has(t.matchedObjectId)),
  );

  const usedTargetColors = new Set(retained.map((t) => t.color));
  const reservedObjectColors = new Set<string>();
  for (const id of checkedObjectIds) {
    const color = objectHighlighterColors[id];
    if (color) reservedObjectColors.add(color);
  }

  const colored = incoming.map((track) => {
    const preferred = track.matchedObjectId
      ? objectHighlighterColors[track.matchedObjectId]
      : undefined;
    const color =
      preferred && !usedTargetColors.has(preferred)
        ? preferred
        : pickDistinctHighlighterColors(
            1,
            new Set([...usedTargetColors, ...reservedObjectColors]),
            rng,
          )[0];
    usedTargetColors.add(color);
    return { ...track, color };
  });

  return [...retained, ...colored];
}

/**
 * Detect the primary bright body near `(clickX, clickY)` on `originEpochIndex`
 * and automatically track its position backward and forward across epochs.
 *
 * @param params - Click tracking parameters forwarded to {@link detectAndTrackBodiesAtClick}.
 * @returns Primary {@link TracedObjectSummary} or a `no_body_found` fallback summary.
 */
export function detectAndTrackBrightBodyAcrossEpochs(
  params: ClickTrackingParams,
): TracedObjectSummary {
  const result = detectAndTrackBodiesAtClick(params);
  if (result.tracks.length > 0) {
    return result.tracks[0];
  }

  const clampedOrigin = result.originEpochIndex;
  const fallbackSky = pixelToSkyWcs(
    Math.max(0, Math.min(GRID_WIDTH - 1, params.clickX)),
    Math.max(0, Math.min(GRID_HEIGHT - 1, params.clickY)),
    params.manifest.wcs,
  );
  return {
    trackId: `no_body_ep${clampedOrigin}_x${Math.round(params.clickX)}_y${Math.round(params.clickY)}`,
    groupId: `no_body_ep${clampedOrigin}`,
    branchIndex: 0,
    totalBranchesInClick: 0,
    isOverlappedAtOrigin: false,
    color: TRACKING_SQUARE_COLORS[0],
    status: 'no_body_found',
    statusMessage: result.message,
    originEpochIndex: clampedOrigin,
    clickX: params.clickX,
    clickY: params.clickY,
    originCentroidX: params.clickX,
    originCentroidY: params.clickY,
    ra: fallbackSky.ra,
    dec: fallbackSky.dec,
    x1: params.clickX,
    y1: params.clickY,
    xN: params.clickX,
    yN: params.clickY,
    waypoints: [],
    lostEpochIds: params.manifest.epochs.map((e) => e.epoch_id),
    properMotionArcsecPerYr: 0,
    positionAngleDeg: 0,
    matchedObjectId: null,
    matchedCatalog: null,
    matchedLabel: null,
    isUncatalogedMover: false,
  };
}
