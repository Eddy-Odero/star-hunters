import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { SkyPatchManifest, ViewportRenderSettings } from '../types/contracts';

interface UseBlinkerPlaybackOptions {
  manifest: SkyPatchManifest | null;
  filteredEpochIndices: readonly number[];
  setRenderSettings: React.Dispatch<React.SetStateAction<ViewportRenderSettings>>;
}

/** Manage epoch playback state, loop mode, speed (FPS), and filtered step navigation. */
export function useBlinkerPlayback({
  manifest,
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
    const timer = window.setInterval(() => {
      setRenderSettings((prev) => {
        const pos = filteredEpochIndices.indexOf(prev.activeEpochIndex);
        if (pos >= 0 && pos < filteredEpochIndices.length - 1) {
          return { ...prev, activeEpochIndex: filteredEpochIndices[pos + 1] };
        }
        if (pos === -1) {
          return { ...prev, activeEpochIndex: filteredEpochIndices[0] };
        }
        if (isLooping) {
          return { ...prev, activeEpochIndex: filteredEpochIndices[0] };
        }
        setIsPlaying(false);
        return prev;
      });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [isPlaying, isLooping, fps, manifest, filteredEpochIndices, setRenderSettings]);

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
