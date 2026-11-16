import {
  GRID_HEIGHT,
  GRID_WIDTH,
  type KnownCelestialObject,
  type SkyPatchManifest,
  type TracedObjectSummary,
} from '../../types/contracts';
import {
  computeSmartCalloutLayout,
  type AvoidRect,
  type DetailsCalloutOrigin,
} from '../../utils/calloutPlacement';
import {
  catalogBadgeLabel,
  formatMagnitude,
  formatProperMotion,
} from '../../utils/knownObjectSelection';
import {
  formatBlinkerSubtitle,
  formatEpochDateShort,
  formatRaDecCompact,
} from '../../utils/observatoryMath';

export { formatBlinkerSubtitle };

export type CalloutRef = { kind: 'tracked'; trackId: string } | { kind: 'known'; objectId: string };

export interface CalloutDetail {
  title: string;
  subtitle: string;
  description: string;
  catalogBadge: string;
  ra: number;
  dec: number;
  properMotionText: string;
  magnitudeText: string;
  w1W2Text: string | null;
  color: string;
  imgX: number;
  imgY: number;
  trackId: string | null;
  objectId: string | null;
  isLocked: boolean;
}

export interface CalloutGeometry {
  markerStageX: number;
  markerStageY: number;
  lineStartX: number;
  lineStartY: number;
  kneeX: number;
  kneeY: number;
  cardLeft: number;
  cardTop: number;
  anchorX: number;
  anchorY: number;
  color: string;
}

export interface CanvasFrameRect {
  width: number;
  height: number;
  leftInStage: number;
  topInStage: number;
  stageW: number;
  stageH: number;
}

export function buildCalloutDetailAndGeometry(params: {
  activeCalloutRef: CalloutRef | null;
  activeCalloutOrigin: DetailsCalloutOrigin;
  manifest: SkyPatchManifest | null;
  activeEpochIndex: number;
  trackedTargets: ReadonlyArray<TracedObjectSummary>;
  knownObjects: ReadonlyArray<KnownCelestialObject>;
  objectHighlighterColors: Readonly<Record<string, string>>;
  frameRect: CanvasFrameRect;
  viewBox: { minX: number; minY: number; viewWidth: number; viewHeight: number };
}): { detail: CalloutDetail; geometry: CalloutGeometry } | null {
  const {
    activeCalloutRef,
    activeCalloutOrigin,
    manifest,
    activeEpochIndex,
    trackedTargets,
    knownObjects,
    objectHighlighterColors,
    frameRect,
    viewBox,
  } = params;

  if (!activeCalloutRef || !manifest) return null;

  const targetNameLower = manifest.target_metadata.name.trim().toLowerCase();
  const activeEpoch =
    manifest.epochs[Math.min(activeEpochIndex, Math.max(0, manifest.epochs.length - 1))];
  const activeDateShort = formatEpochDateShort(activeEpoch?.iso_date);
  let detail: CalloutDetail | null = null;

  if (activeCalloutRef.kind === 'tracked') {
    const track = trackedTargets.find((t) => t.trackId === activeCalloutRef.trackId);
    if (track) {
      const knownMatch = track.matchedObjectId
        ? knownObjects.find((k) => k.object_id === track.matchedObjectId)
        : undefined;
      const wp = track.waypoints[activeEpochIndex] ??
        track.waypoints[track.originEpochIndex] ?? {
          x: track.originCentroidX,
          y: track.originCentroidY,
        };
      const title = track.matchedLabel ?? 'Uncataloged Moving Source';
      const isPrimaryFieldTarget =
        Boolean(targetNameLower) && title.toLowerCase().includes(targetNameLower);
      const notesParts: string[] = [];
      if (isPrimaryFieldTarget && manifest.target_metadata.description) {
        notesParts.push(manifest.target_metadata.description);
      } else if (knownMatch) {
        const typeLabel = [knownMatch.canonical_name, knownMatch.otype, knownMatch.object_type]
          .filter(Boolean)
          .join(' · ');
        if (typeLabel) notesParts.push(typeLabel);
      }
      if (track.statusMessage && !notesParts.includes(track.statusMessage)) {
        notesParts.push(track.statusMessage);
      }
      if (knownMatch?.data_source) {
        notesParts.push(`Catalog provenance: ${knownMatch.data_source}`);
      }
      if (activeDateShort !== 'n/a') {
        notesParts.push(`Frame captured: ${activeDateShort}`);
      }
      if (notesParts.length === 0 && manifest.target_metadata.description) {
        notesParts.push(
          `Field: ${manifest.target_metadata.name}. ${manifest.target_metadata.description}`,
        );
      }

      detail = {
        title,
        subtitle: `${formatRaDecCompact(track.ra, track.dec)} · Constellation: ${
          manifest.target_metadata.constellation || 'n/a'
        } · Captured ${activeDateShort}`,
        description: notesParts.join(' '),
        catalogBadge: track.matchedCatalog ? track.matchedCatalog.toUpperCase() : 'CANDIDATE',
        ra: track.ra,
        dec: track.dec,
        properMotionText: `${track.properMotionArcsecPerYr.toFixed(2)}"/yr`,
        magnitudeText:
          knownMatch && knownMatch.magnitude !== null
            ? formatMagnitude(knownMatch.magnitude)
            : 'mag n/a',
        w1W2Text:
          knownMatch && knownMatch.w1_w2_color !== null
            ? `W1-W2 ${knownMatch.w1_w2_color >= 0 ? '+' : ''}${knownMatch.w1_w2_color.toFixed(2)}`
            : null,
        color: track.color,
        imgX: wp.x,
        imgY: wp.y,
        trackId: track.trackId,
        objectId: track.matchedObjectId ?? null,
        isLocked: activeCalloutOrigin === 'click',
      };
    }
  } else {
    const obj = knownObjects.find((k) => k.object_id === activeCalloutRef.objectId);
    if (obj) {
      const epPos =
        obj.epoch_positions?.[
          Math.min(activeEpochIndex, Math.max(0, (obj.epoch_positions?.length ?? 1) - 1))
        ] ?? obj;
      const color = objectHighlighterColors[obj.object_id] ?? '#38bdf8';
      const isPrimaryFieldTarget =
        Boolean(targetNameLower) && obj.label.toLowerCase().includes(targetNameLower);
      const notesParts: string[] = [];
      if (isPrimaryFieldTarget && manifest.target_metadata.description) {
        notesParts.push(manifest.target_metadata.description);
      }
      const typeMeta = [obj.canonical_name, obj.otype, obj.object_class ?? obj.object_type]
        .filter(Boolean)
        .join(' · ');
      if (typeMeta) notesParts.push(`Classification: ${typeMeta}`);
      if (obj.parallax_mas !== null && obj.parallax_mas !== undefined) {
        notesParts.push(`Parallax: ${obj.parallax_mas.toFixed(1)} mas`);
      }
      if (obj.data_source) notesParts.push(`Source: ${obj.data_source}`);
      if (obj.catalog === 'jpl_horizons' || obj.object_id.startsWith('ephem:')) {
        notesParts.push(`Predicted ephemeris for ${activeDateShort}`);
      } else if (activeDateShort !== 'n/a') {
        notesParts.push(`Frame captured: ${activeDateShort}`);
      }

      detail = {
        title: obj.label,
        subtitle: `${formatRaDecCompact(epPos.ra, epPos.dec)} · Constellation: ${
          manifest.target_metadata.constellation || 'n/a'
        } · Captured ${activeDateShort}`,
        description:
          notesParts.length > 0
            ? notesParts.join(' · ')
            : `Cataloged celestial source in the ${manifest.target_metadata.name} cutout.`,
        catalogBadge: catalogBadgeLabel(obj.catalog),
        ra: epPos.ra,
        dec: epPos.dec,
        properMotionText: formatProperMotion(obj.proper_motion_arcsec_yr),
        magnitudeText: formatMagnitude(obj.magnitude),
        w1W2Text:
          obj.w1_w2_color !== null
            ? `W1-W2 ${obj.w1_w2_color >= 0 ? '+' : ''}${obj.w1_w2_color.toFixed(2)}`
            : null,
        color,
        imgX: epPos.x,
        imgY: epPos.y,
        trackId: null,
        objectId: obj.object_id,
        isLocked: activeCalloutOrigin === 'click',
      };
    }
  }

  if (!detail) return null;

  const sx = ((detail.imgX - viewBox.minX) / viewBox.viewWidth) * frameRect.width;
  const sy = ((detail.imgY - viewBox.minY) / viewBox.viewHeight) * frameRect.height;
  const markerStageX = frameRect.leftInStage + sx;
  const markerStageY = frameRect.topInStage + sy;

  const cardW = Math.min(316, Math.max(240, frameRect.stageW - 28));
  const cardH = 186;
  const transportAvoid: AvoidRect = {
    left: Math.max(0, frameRect.stageW / 2 - 190),
    top: Math.max(0, frameRect.stageH - 64),
    right: Math.min(frameRect.stageW, frameRect.stageW / 2 + 190),
    bottom: frameRect.stageH,
  };
  const smart = computeSmartCalloutLayout({
    markerStageX,
    markerStageY,
    stageW: frameRect.stageW,
    stageH: frameRect.stageH,
    cardW,
    cardH,
    avoidRects: [transportAvoid],
  });

  let lineStartX = markerStageX + 14;
  let lineStartY = markerStageY;
  if (smart.side === 'left') {
    lineStartX = markerStageX - 14;
  } else if (smart.side === 'above') {
    lineStartX = markerStageX;
    lineStartY = markerStageY - 14;
  } else if (smart.side === 'below') {
    lineStartX = markerStageX;
    lineStartY = markerStageY + 14;
  }

  return {
    detail,
    geometry: {
      markerStageX,
      markerStageY,
      lineStartX,
      lineStartY,
      kneeX: smart.kneeX,
      kneeY: smart.kneeY,
      cardLeft: smart.cardLeft,
      cardTop: smart.cardTop,
      anchorX: smart.anchorX,
      anchorY: smart.anchorY,
      color: detail.color,
    },
  };
}

export function isImagePointInBounds(x: number, y: number): boolean {
  return x >= 0 && x < GRID_WIDTH && y >= 0 && y < GRID_HEIGHT;
}
