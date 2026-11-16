import React, { useEffect, useRef } from 'react';
import type { GlobalKnownObjectEntry } from '../../types/contracts';
import { BACKGROUND_STARS, projectSkySin } from '../../utils/skyProjection';

interface FallbackSkyCanvasProps {
  ra: number;
  dec: number;
  fovDeg: number;
  width: number;
  height: number;
  globalKnownObjects: ReadonlyArray<GlobalKnownObjectEntry>;
  paused: boolean;
}

/**
 * Demand-driven pure-#000000 3D celestial sphere fallback rendered only when camera,
 * catalog, or viewport state updates (eliminating idle 60 FPS CPU/GPU spin).
 */
export const FallbackSkyCanvas: React.FC<FallbackSkyCanvasProps> = ({
  ra,
  dec,
  fovDeg,
  width,
  height,
  globalKnownObjects,
  paused,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (paused) return undefined;
    const rafId = window.requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = width || window.innerWidth;
      const h = height || window.innerHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, w, h);

      if (fovDeg >= 110) {
        const halfFovRad = Math.min(Math.PI / 2, fovDeg * 0.5 * (Math.PI / 180));
        const limbRadius = (w * 0.5) / Math.max(1e-4, Math.sin(halfFovRad));
        ctx.beginPath();
        ctx.arc(w * 0.5, h * 0.5, limbRadius, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      for (const star of BACKGROUND_STARS) {
        const p = projectSkySin(star.ra, star.dec, ra, dec, fovDeg, w, h);
        if (!p.visible || p.px < -4 || p.px > w + 4 || p.py < -4 || p.py > h + 4) {
          continue;
        }
        ctx.globalAlpha = star.alpha;
        ctx.fillStyle = star.tint;
        ctx.beginPath();
        ctx.arc(p.px, p.py, star.size, 0, Math.PI * 2);
        ctx.fill();
      }

      const maxPlot = Math.min(globalKnownObjects.length, 650);
      const placedLabelBoxes: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
      const labelCandidates: Array<{
        obj: GlobalKnownObjectEntry;
        px: number;
        py: number;
        priority: number;
      }> = [];

      for (let i = 0; i < maxPlot; i += 1) {
        const obj = globalKnownObjects[i];
        const p = projectSkySin(obj.ra, obj.dec, ra, dec, fovDeg, w, h);
        if (!p.visible || p.px < 0 || p.px > w || p.py < 0 || p.py > h) continue;
        const isMajorObject =
          obj.default_checked ||
          obj.object_type === 'solar_system' ||
          obj.object_type === 'brown_dwarf_candidate' ||
          obj.object_class === 'brown_dwarf' ||
          obj.object_class === 'nebula' ||
          obj.object_class === 'galaxy';
        const color =
          obj.object_type === 'solar_system'
            ? '#fbbf24'
            : obj.object_type === 'brown_dwarf_candidate' || obj.object_class === 'brown_dwarf'
              ? '#fb923c'
              : '#38bdf8';

        ctx.globalAlpha = isMajorObject ? 0.92 : 0.65;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.px, p.py, isMajorObject ? 3.0 : 1.8, 0, Math.PI * 2);
        ctx.fill();

        if (isMajorObject && (fovDeg <= 12 || !obj.object_id.startsWith('gaia:'))) {
          const priority = obj.object_id.startsWith('primary_')
            ? 3
            : obj.object_id.startsWith('most:')
              ? 2
              : obj.object_id.startsWith('global:')
                ? 1
                : 0;
          labelCandidates.push({ obj, px: p.px, py: p.py, priority });
        }
      }

      if (fovDeg <= 130 && labelCandidates.length > 0) {
        labelCandidates.sort((a, b) => b.priority - a.priority);
        ctx.font = '500 11px Jost, system-ui, sans-serif';
        ctx.globalAlpha = 0.88;
        ctx.fillStyle = '#e2e8f0';
        for (const cand of labelCandidates) {
          const shortLabel = cand.obj.label.split('(')[0].trim();
          const boxW = Math.max(48, shortLabel.length * 6.5 + 14);
          const x1 = cand.px + 6;
          const y1 = cand.py - 10;
          const x2 = x1 + boxW;
          const y2 = y1 + 16;
          const collides = placedLabelBoxes.some(
            (b) => x1 < b.x2 && x2 > b.x1 && y1 < b.y2 && y2 > b.y1,
          );
          if (collides) continue;
          placedLabelBoxes.push({ x1, y1, x2, y2 });
          ctx.fillText(shortLabel, cand.px + 7, cand.py + 3);
          if (placedLabelBoxes.length >= 28) break;
        }
      }
      ctx.globalAlpha = 1;
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [dec, fovDeg, globalKnownObjects, height, paused, ra, width]);

  return (
    <canvas
      ref={canvasRef}
      className="globe-fallback-canvas"
      aria-label="3D Night-Sky Globe Canvas"
    />
  );
};
