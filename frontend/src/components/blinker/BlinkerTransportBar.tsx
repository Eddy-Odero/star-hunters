import React from 'react';
import {
  PauseIcon,
  PlayIcon,
  RepeatLoopIcon,
  SkipNextIcon,
  SkipPrevIcon,
} from '../icons/ObservatoryIcons';

interface BlinkerTransportBarProps {
  isPlaying: boolean;
  isLooping: boolean;
  fps: number;
  activeEpochIndex: number;
  totalEpochs: number;
  onPlay: () => void;
  onPause: () => void;
  onStepForward: () => void;
  onStepBackward: () => void;
  onToggleLoop: () => void;
  onSetFps: (fps: number) => void;
}

/** Bottom-center playback transport toolbar for stepping or playing calibrated infrared passes. */
export const BlinkerTransportBar: React.FC<BlinkerTransportBarProps> = ({
  isPlaying,
  isLooping,
  fps,
  activeEpochIndex,
  totalEpochs,
  onPlay,
  onPause,
  onStepForward,
  onStepBackward,
  onToggleLoop,
  onSetFps,
}) => (
  <div
    className="blinker-transport-bar"
    role="toolbar"
    aria-label="Pass Playback Transport"
    data-testid="blinker-transport-bar"
    onPointerDown={(e) => e.stopPropagation()}
    onPointerUp={(e) => e.stopPropagation()}
  >
    <button
      type="button"
      className="transport-btn"
      aria-label="Previous pass"
      onClick={onStepBackward}
      data-testid="transport-prev-btn"
    >
      <SkipPrevIcon size={15} />
    </button>

    <button
      type="button"
      className={`transport-btn ${isPlaying ? 'is-active' : ''}`}
      aria-label={isPlaying ? 'Pause playback' : 'Play passes'}
      onClick={isPlaying ? onPause : onPlay}
      data-testid="transport-play-btn"
    >
      {isPlaying ? <PauseIcon size={15} /> : <PlayIcon size={15} />}
    </button>

    <button
      type="button"
      className="transport-btn"
      aria-label="Next pass"
      onClick={onStepForward}
      data-testid="transport-next-btn"
    >
      <SkipNextIcon size={15} />
    </button>

    <button
      type="button"
      className={`transport-btn ${isLooping ? 'is-active' : ''}`}
      aria-label="Toggle loop playback"
      aria-pressed={isLooping}
      onClick={onToggleLoop}
      data-testid="transport-loop-btn"
    >
      <RepeatLoopIcon size={14} />
    </button>

    <span className="globe-telemetry-divider" />

    <span
      className="mono"
      style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '0 4px' }}
    >
      {totalEpochs > 0 ? `${activeEpochIndex + 1}/${totalEpochs}` : '0/0'}
    </span>

    <select
      aria-label="Playback speed in FPS"
      className="hud-select"
      style={{ height: 26, fontSize: 11, borderRadius: 999, padding: '0 8px' }}
      value={fps}
      onChange={(e) => onSetFps(Number(e.target.value))}
      data-testid="transport-fps-select"
    >
      <option value={0.5}>FPS | 0.5×</option>
      <option value={1}>FPS | 1×</option>
      <option value={2}>FPS | 2×</option>
      <option value={4}>FPS | 4×</option>
      <option value={8}>FPS | 8×</option>
    </select>
  </div>
);
