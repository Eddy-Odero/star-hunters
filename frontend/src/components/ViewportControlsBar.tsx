import React from 'react';
import { useSkyExplorer } from '../context/SkyExplorerContext';
import type { ComparisonMode, ContrastStretch } from '../types/contracts';

const WAVELENGTH_PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  range: [number, number];
}> = [
  { id: 'all', label: 'All Bands (0.75–5.0 µm)', range: [0.75, 5.0] },
  { id: 'cold', label: 'Cold Objects / Planet X (3.8–5.0 µm)', range: [3.8, 5.0] },
  { id: 'molecules', label: 'H₂O / CH₄ Band (2.4–3.8 µm)', range: [2.4, 3.8] },
  { id: 'hot', label: 'Hot Stars (0.75–2.4 µm)', range: [0.75, 2.4] },
];

export const ViewportControlsBar: React.FC = () => {
  const {
    manifest,
    renderSettings,
    updateRenderSettings,
    setViewportZoomPan,
    resetViewportZoomPan,
    playback,
  } = useSkyExplorer();

  const epochs = manifest?.epochs ?? [];
  const [minWave, maxWave] = renderSettings.wavelengthRangeUm;

  const handleModeChange = (mode: ComparisonMode) => {
    updateRenderSettings({ mode });
  };

  const handleCoaddToggle = (epochIdx: number) => {
    const exists = renderSettings.coaddIndices.includes(epochIdx);
    const next = exists
      ? renderSettings.coaddIndices.filter((i) => i !== epochIdx)
      : [...renderSettings.coaddIndices, epochIdx].sort((a, b) => a - b);
    if (next.length > 0) {
      updateRenderSettings({ coaddIndices: next });
    }
  };

  const handleMinWaveChange = (val: number) => {
    const clampedMin = Math.min(val, Number((maxWave - 0.1).toFixed(2)));
    updateRenderSettings({ wavelengthRangeUm: [Math.max(0.75, clampedMin), maxWave] });
  };

  const handleMaxWaveChange = (val: number) => {
    const clampedMax = Math.max(val, Number((minWave + 0.1).toFixed(2)));
    updateRenderSettings({ wavelengthRangeUm: [minWave, Math.min(5.0, clampedMax)] });
  };

  const isPresetActive = (range: [number, number]) =>
    Math.abs(minWave - range[0]) < 0.05 && Math.abs(maxWave - range[1]) < 0.05;

  return (
    <div className="viewport-controls-bar" role="region" aria-label="Viewport Controls Bar">
      {/* Row 1: Comparison Mode + Epoch Selectors */}
      <div className="controls-row">
        <div className="control-group" role="group" aria-label="Comparison Mode">
          <span className="control-label">Compare:</span>
          {(['blink', 'subtract', 'coadd'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={renderSettings.mode === m ? 'mode-btn active' : 'mode-btn'}
              aria-pressed={renderSettings.mode === m}
              onClick={() => handleModeChange(m)}
            >
              {m === 'blink' && 'Blink Epochs'}
              {m === 'subtract' && 'Subtract (B − A)'}
              {m === 'coadd' && 'Co-Add Stack'}
            </button>
          ))}
        </div>

        {renderSettings.mode === 'subtract' && epochs.length > 0 && (
          <div className="control-group" role="group" aria-label="Subtraction Epochs">
            <label className="inline-select">
              <span>Pass A:</span>
              <select
                value={renderSettings.passAIndex}
                onChange={(e) => updateRenderSettings({ passAIndex: Number(e.target.value) })}
              >
                {epochs.map((ep, idx) => (
                  <option key={ep.epoch_id} value={idx}>
                    #{idx + 1} ({ep.iso_date.slice(0, 10)})
                  </option>
                ))}
              </select>
            </label>

            <label className="inline-select">
              <span>Pass B:</span>
              <select
                value={renderSettings.passBIndex}
                onChange={(e) => updateRenderSettings({ passBIndex: Number(e.target.value) })}
              >
                {epochs.map((ep, idx) => (
                  <option key={ep.epoch_id} value={idx}>
                    #{idx + 1} ({ep.iso_date.slice(0, 10)})
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {renderSettings.mode === 'coadd' && epochs.length > 0 && (
          <div className="control-group" role="group" aria-label="Co-Add Epochs">
            <span className="control-label">Stack:</span>
            {epochs.map((ep, idx) => {
              const checked = renderSettings.coaddIndices.includes(idx);
              return (
                <label key={ep.epoch_id} className="epoch-checkbox">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => handleCoaddToggle(idx)}
                  />
                  <span>
                    Pass {idx + 1} ({ep.iso_date.slice(0, 10)})
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      {/* Row 2: Playback Transport & Zoom/Contrast */}
      <div className="controls-row">
        <div className="control-group" role="group" aria-label="Playback Transport">
          <span className="control-label">
            Frame {epochs.length > 0 ? renderSettings.activeEpochIndex + 1 : 0}/{epochs.length}:
          </span>
          <button
            type="button"
            className="mode-btn"
            onClick={playback.stepBackward}
            disabled={epochs.length <= 1 || renderSettings.activeEpochIndex === 0}
            aria-label="Step Backward"
          >
            &lt; Step
          </button>
          <button
            type="button"
            className={playback.isPlaying ? 'mode-btn active' : 'mode-btn'}
            onClick={playback.isPlaying ? playback.pause : playback.play}
            disabled={epochs.length <= 1}
          >
            {playback.isPlaying ? 'Pause' : 'Play'}
          </button>
          <button
            type="button"
            className="mode-btn"
            onClick={playback.stepForward}
            disabled={epochs.length <= 1 || renderSettings.activeEpochIndex >= epochs.length - 1}
            aria-label="Step Forward"
          >
            Step &gt;
          </button>

          <label className="inline-select">
            <span>FPS:</span>
            <select
              value={playback.fps}
              onChange={(e) => playback.setFps(Number(e.target.value))}
            >
              <option value={1}>1×</option>
              <option value={2}>2×</option>
              <option value={4}>4×</option>
              <option value={8}>8×</option>
            </select>
          </label>

          <button
            type="button"
            className={playback.isLooping ? 'mode-btn active' : 'mode-btn'}
            aria-pressed={playback.isLooping}
            onClick={playback.toggleLoop}
          >
            Loop: {playback.isLooping ? 'On' : 'Off'}
          </button>
        </div>

        <div className="control-group" role="group" aria-label="Zoom and Contrast">
          <button
            type="button"
            className="mode-btn"
            onClick={() =>
              setViewportZoomPan(
                Math.min(8.0, renderSettings.zoom * 1.5),
                renderSettings.panX,
                renderSettings.panY,
              )
            }
          >
            Zoom In (+)
          </button>
          <button
            type="button"
            className="mode-btn"
            onClick={() =>
              setViewportZoomPan(
                Math.max(1.0, renderSettings.zoom / 1.5),
                renderSettings.panX,
                renderSettings.panY,
              )
            }
          >
            Zoom Out (−)
          </button>
          <button type="button" className="mode-btn" onClick={resetViewportZoomPan}>
            Reset 1×
          </button>

          <label className="inline-select">
            <span>Stretch:</span>
            <select
              value={renderSettings.contrastStretch}
              onChange={(e) =>
                updateRenderSettings({ contrastStretch: e.target.value as ContrastStretch })
              }
            >
              <option value="asinh">Asinh</option>
              <option value="linear">Linear</option>
              <option value="zscale">ZScale</option>
            </select>
          </label>
        </div>
      </div>

      {/* Row 3: Wavelength Dual Slider & Quick Filters */}
      <div className="controls-row wavelength-row">
        <div className="wavelength-slider-group">
          <span className="control-label">
            Wavelength: <strong>{minWave.toFixed(2)}–{maxWave.toFixed(2)} µm</strong>
          </span>
          <div className="dual-range">
            <input
              type="range"
              min={0.75}
              max={5.0}
              step={0.05}
              value={minWave}
              aria-label="Minimum Wavelength (µm)"
              onChange={(e) => handleMinWaveChange(Number(e.target.value))}
            />
            <input
              type="range"
              min={0.75}
              max={5.0}
              step={0.05}
              value={maxWave}
              aria-label="Maximum Wavelength (µm)"
              onChange={(e) => handleMaxWaveChange(Number(e.target.value))}
            />
          </div>
        </div>

        <div className="control-group" role="group" aria-label="Wavelength Quick Filters">
          {WAVELENGTH_PRESETS.map((preset) => {
            const active = isPresetActive(preset.range);
            return (
              <button
                key={preset.id}
                type="button"
                className={active ? 'mode-btn active' : 'mode-btn'}
                aria-pressed={active}
                onClick={() => updateRenderSettings({ wavelengthRangeUm: [...preset.range] })}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default ViewportControlsBar;