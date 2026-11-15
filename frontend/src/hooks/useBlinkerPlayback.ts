import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { SkyPatchManifest, ViewportRenderSettings } from '../types/contracts';

/** Options accepted by {@link useBlinkerPlayback}. */
interface UseBlinkerPlaybackOptions {
  /** Active patch manifest (`null` while loading or before any patch is selected). */
  manifest: SkyPatchManifest | null;
  /** Current active epoch index from viewport render settings. */
  activeEpochIndex: number;
  /** Epoch indices permitted by the active mission filter. */
  filteredEpochIndices: readonly number[];
  /** State setter for viewport render settings. */
  setRenderSettings: React.Dispatch<React.SetStateAction<ViewportRenderSettings>>;
}

/**
 * Manage epoch playback state, loop mode, speed (FPS), and filtered step navigation.
 *
 * Uses a pure `setTimeout` effect keyed on `activeEpochIndex` so state updaters
 * passed to `setRenderSettings` remain side-effect-free under React StrictMode.
 *
 * @param options - Playback configuration and render settings dispatcher.
 * @returns Playback state flags and transport control callbacks.
 */
export function useBlinkerPlayback({
  manifest,
  activeEpochIndex,
  filteredEpochIndices,
  setRenderSettings,
}: UseBlinkerPlaybackOptions) {
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isLooping, setIsLooping] = useState<boolean>(false);
  const [fps, setFps] = useState<number>(2);

  useEffect(() => {
    if (!isPlaying || !manifest || filteredEpochIndices.length <= 1) {
      return undefined;
    }
    const intervalMs = Math.max(100, Math.round(1000 / Math.max(0.5, fps)));
    const timer = window.setTimeout(() => {
      const pos = filteredEpochIndices.indexOf(activeEpochIndex);
      if (pos >= 0 && pos < filteredEpochIndices.length - 1) {
        const nextIdx = filteredEpochIndices[pos + 1];
        setRenderSettings((prev) => ({ ...prev, activeEpochIndex: nextIdx }));
        return;
      }
      if (pos === -1 || isLooping) {
        const nextIdx = filteredEpochIndices[0];
        setRenderSettings((prev) => ({ ...prev, activeEpochIndex: nextIdx }));
        return;
      }
      setIsPlaying(false);
    }, intervalMs);
    return () => window.clearTimeout(timer);
  }, [
    activeEpochIndex,
    isPlaying,
    isLooping,
    fps,
    manifest,
    filteredEpochIndices,
    setRenderSettings,
  ]);

  const play = useCallback(() => {
    if (filteredEpochIndices.length === 0) return;
    setRenderSettings((prev) => {
      const lastValid = filteredEpochIndices[filteredEpochIndices.length - 1];
      if (
        !filteredEpochIndices.includes(prev.activeEpochIndex) ||
        prev.activeEpochIndex === lastValid
      ) {
        return { ...prev, activeEpochIndex: filteredEpochIndices[0] };
      }
      return prev;
    });
    setIsPlaying(true);
  }, [filteredEpochIndices, setRenderSettings]);

  const pause = useCallback(() => setIsPlaying(false), []);

  const stepForward = useCallback(() => {
    setIsPlaying(false);
    if (filteredEpochIndices.length === 0) return;
    setRenderSettings((prev) => {
      const pos = filteredEpochIndices.indexOf(prev.activeEpochIndex);
      const nextIdx =
        pos < 0
          ? filteredEpochIndices[0]
          : filteredEpochIndices[Math.min(filteredEpochIndices.length - 1, pos + 1)];
      return { ...prev, activeEpochIndex: nextIdx };
    });
  }, [filteredEpochIndices, setRenderSettings]);

  const stepBackward = useCallback(() => {
    setIsPlaying(false);
    if (filteredEpochIndices.length === 0) return;
    setRenderSettings((prev) => {
      const pos = filteredEpochIndices.indexOf(prev.activeEpochIndex);
      const prevIdx =
        pos < 0 ? filteredEpochIndices[0] : filteredEpochIndices[Math.max(0, pos - 1)];
      return { ...prev, activeEpochIndex: prevIdx };
    });
  }, [filteredEpochIndices, setRenderSettings]);

  const toggleLoop = useCallback(() => setIsLooping((prev) => !prev), []);

  return {
    isPlaying,
    setIsPlaying,
    isLooping,
    fps,
    setFps,
    play,
    pause,
    stepForward,
    stepBackward,
    toggleLoop,
  };
}
