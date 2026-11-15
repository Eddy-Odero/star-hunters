import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NotificationContextValue } from '../context/NotificationContext';
import type {
  ClickDiagnosticInfo,
  SkyPatchManifest,
  TracedObjectSummary,
} from '../types/contracts';
import { detectAndTrackBodiesAtClick, mergeTrackedTargets } from '../utils/clickTracker';
import { observatoryLogger } from '../utils/observatoryLogger';

/** Options accepted by {@link useTargetTracking}. */
export interface UseTargetTrackingOptions {
  /** Active epoch detector planes (`null` while loading). */
  epochBuffers: Float32Array[][] | null;
  /** Active sky-patch manifest (`null` while loading). */
  manifest: SkyPatchManifest | null;
  /** Deterministic `object_id -> hexColor` map for known catalog objects. */
  objectHighlighterColors: Readonly<Record<string, string>>;
  /** Currently active epoch index in the Blinker viewport. */
  activeEpochIndex: number;
  /** Active Dim & Pop wavelength window `[minUm, maxUm]`. */
  wavelengthRangeUm: [number, number];
  /** Ref to notification context for `no_body_found` warnings. */
  notificationsRef: React.RefObject<NotificationContextValue | null>;
}

/**
 * Manage Click-to-Track targets, selected target summary, click diagnostics,
 * and single/batch target removal in the Blinker viewport.
 *
 * @param options - Active patch buffers, render slice, highlighter palette, and notifications.
 * @returns Tracked target list, active selection, diagnostics, and tracking actions.
 */
export function useTargetTracking({
  epochBuffers,
  manifest,
  objectHighlighterColors,
  activeEpochIndex,
  wavelengthRangeUm,
  notificationsRef,
}: UseTargetTrackingOptions) {
  const [selectedObject, setSelectedObject] = useState<TracedObjectSummary | null>(null);
  const [trackedTargets, setTrackedTargets] = useState<TracedObjectSummary[]>([]);
  const [lastClickDiagnostic, setLastClickDiagnostic] = useState<ClickDiagnosticInfo | null>(null);

  const trackedTargetsRef = useRef<TracedObjectSummary[]>(trackedTargets);
  const selectedObjectRef = useRef<TracedObjectSummary | null>(selectedObject);
  const stateRef = useRef({
    epochBuffers,
    manifest,
    objectHighlighterColors,
    activeEpochIndex,
    wavelengthRangeUm,
  });
  useEffect(() => {
    trackedTargetsRef.current = trackedTargets;
    selectedObjectRef.current = selectedObject;
    stateRef.current = {
      epochBuffers,
      manifest,
      objectHighlighterColors,
      activeEpochIndex,
      wavelengthRangeUm,
    };
  }, [
    epochBuffers,
    manifest,
    objectHighlighterColors,
    activeEpochIndex,
    wavelengthRangeUm,
    trackedTargets,
    selectedObject,
  ]);

  const removeTrackedTarget = useCallback((trackId: string) => {
    const next = trackedTargetsRef.current.filter((t) => t.trackId !== trackId);
    trackedTargetsRef.current = next;
    setTrackedTargets(next);
    if (selectedObjectRef.current?.trackId === trackId) {
      const nextSelected = next[next.length - 1] ?? null;
      selectedObjectRef.current = nextSelected;
      setSelectedObject(nextSelected);
    }
  }, []);

  const untrackObjectById = useCallback((objectId: string) => {
    const next = trackedTargetsRef.current.filter((t) => t.matchedObjectId !== objectId);
    trackedTargetsRef.current = next;
    setTrackedTargets(next);
    if (selectedObjectRef.current?.matchedObjectId === objectId) {
      const nextSelected = next[next.length - 1] ?? null;
      selectedObjectRef.current = nextSelected;
      setSelectedObject(nextSelected);
    }
  }, []);

  const clearTrackedTargets = useCallback(() => {
    trackedTargetsRef.current = [];
    selectedObjectRef.current = null;
    setTrackedTargets([]);
    setSelectedObject(null);
    setLastClickDiagnostic(null);
  }, []);

  const inspectPixelOrCoord = useCallback(
    (x: number, y: number, originEpochIndex?: number) => {
      const {
        epochBuffers: bufs,
        manifest: currManifest,
        objectHighlighterColors: colors,
        activeEpochIndex: currEpoch,
        wavelengthRangeUm: currWl,
      } = stateRef.current;
      const currTargets = trackedTargetsRef.current;

      if (!bufs || !currManifest || bufs.length === 0) return;
      const originEpoch = originEpochIndex ?? currEpoch;

      // Second-click untrack: hitting an already-tracked target removes its Square frame
      const hitExisting = currTargets.find((t) => {
        const wp = t.waypoints[originEpoch] ??
          t.waypoints[t.originEpochIndex] ?? {
            x: t.originCentroidX,
            y: t.originCentroidY,
          };
        return Math.hypot(wp.x - x, wp.y - y) <= 10;
      });
      if (hitExisting) {
        removeTrackedTarget(hitExisting.trackId);
        setLastClickDiagnostic(null);
        return;
      }

      const result = detectAndTrackBodiesAtClick({
        clickX: x,
        clickY: y,
        originEpochIndex: originEpoch,
        epochBuffers: bufs,
        manifest: currManifest,
        wavelengthRangeUm: currWl,
      });

      setLastClickDiagnostic({
        clickX: x,
        clickY: y,
        epochIndex: originEpoch,
        status: result.status,
        message: result.message,
        tracksAdded: result.tracks.length,
      });

      if (result.status === 'no_body_found' || result.tracks.length === 0) {
        notificationsRef.current?.pushWarning({
          id: 'no-body-clicked',
          title: 'No source detected at cursor',
          detail: result.message,
          level: 'warning',
        });
        return;
      }

      observatoryLogger.info('tracking', 'Tracked target(s) on canvas click', {
        status: result.status,
        tracksAdded: result.tracks.length,
        labels: result.tracks.map((t) => t.matchedLabel || t.groupId),
      });

      // Preserve the known object's assigned marker color when converting in-place to Square
      const colorMatchedTracks = result.tracks.map((track) => {
        if (track.matchedObjectId && colors[track.matchedObjectId]) {
          return { ...track, color: colors[track.matchedObjectId] };
        }
        return track;
      });

      const merged = mergeTrackedTargets(trackedTargetsRef.current, colorMatchedTracks);
      trackedTargetsRef.current = merged;
      setTrackedTargets(merged);
      const primary =
        merged.find((t) => t.groupId === colorMatchedTracks[0].groupId) ??
        merged[merged.length - 1] ??
        null;
      if (primary) {
        selectedObjectRef.current = primary;
        setSelectedObject(primary);
      }
    },
    [notificationsRef, removeTrackedTarget],
  );

  return {
    selectedObject,
    setSelectedObject,
    trackedTargets,
    lastClickDiagnostic,
    inspectPixelOrCoord,
    removeTrackedTarget,
    untrackObjectById,
    clearTrackedTargets,
  };
}
