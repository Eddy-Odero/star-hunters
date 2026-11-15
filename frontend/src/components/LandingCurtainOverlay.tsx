import React, { useEffect, useState } from 'react';
import { pickRandomNasaCurtainImage, type NasaCurtainImage } from '../data/nasaCurtainImages';
import { SpinnerIcon } from './icons/ObservatoryIcons';

const CURTAIN_WARMUP_LOCK_MS = 1750;
const CURTAIN_EXIT_TRANSITION_MS = 620;

export const LandingCurtainOverlay: React.FC<{
  onDismissed?: () => void;
}> = ({ onDismissed }) => {
  const [selectedImage] = useState<NasaCurtainImage>(() => pickRandomNasaCurtainImage());
  const [progressPct, setProgressPct] = useState<number>(8);
  const [isUnlocked, setIsUnlocked] = useState<boolean>(false);
  const [isDismissing, setIsDismissing] = useState<boolean>(false);
  const [isUnmounted, setIsUnmounted] = useState<boolean>(false);

  // Enforce the <= 2s loading animation lock before allowing reveal of main UI
  useEffect(() => {
    const start = performance.now();
    let rafId = 0;

    const tick = (now: number) => {
      const elapsed = now - start;
      const pct = Math.min(100, Math.round((elapsed / CURTAIN_WARMUP_LOCK_MS) * 100));
      setProgressPct(pct);
      if (elapsed >= CURTAIN_WARMUP_LOCK_MS) {
        setIsUnlocked(true);
        return;
      }
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, []);

  const handleDismiss = () => {
    if (!isUnlocked || isDismissing) return;
    setIsDismissing(true);
    window.setTimeout(() => {
      setIsUnmounted(true);
      onDismissed?.();
    }, CURTAIN_EXIT_TRANSITION_MS);
  };

  if (isUnmounted) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Star Hunters Observatory Landing Overlay"
      aria-busy={!isUnlocked}
      data-testid="landing-curtain-overlay"
      className={`curtain-overlay ${isUnlocked ? 'is-ready' : 'is-locked'} ${
        isDismissing ? 'is-dismissing' : ''
      }`}
      onClick={handleDismiss}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleDismiss();
        }
      }}
      tabIndex={0}
    >
      <img src={selectedImage.src} alt={selectedImage.title} className="curtain-bg-photo" />
      <div className="curtain-scrim" />

      <div className="curtain-content">
        <h1 className="curtain-title">Star Hunters</h1>
        <p className="curtain-subtitle">
          Hunting moving celestial bodies, ultra-cold brown dwarfs, interstellar visitors, and
          Planet X across NASA SPHEREx&rsquo;s 102 infrared bands and WISE/NEOWISE archives.
        </p>

        <div className="curtain-status-box">
          {!isUnlocked ? (
            <>
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 13,
                  color: '#e2e8f0',
                }}
              >
                <SpinnerIcon size={15} />
                <span className="mono">
                  Initializing sky globe &amp; warming 6 benchmark patches ({progressPct}%)
                </span>
              </div>
              <div
                className="curtain-progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressPct}
              >
                <div className="curtain-progress-fill" style={{ width: `${progressPct}%` }} />
              </div>
            </>
          ) : (
            <div className="curtain-cta-pill" data-testid="curtain-enter-cta">
              <span>Click anywhere to enter observatory</span>
            </div>
          )}
        </div>
      </div>

      <aside className="curtain-attribution" aria-label="NASA image attribution">
        <div className="curtain-attribution-title">{selectedImage.title}</div>
        <div className="curtain-attribution-credit">
          Credit: {selectedImage.attribution} ({selectedImage.nasaId})
        </div>
      </aside>
    </div>
  );
};
