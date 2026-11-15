import React, { useEffect, useState } from 'react';
import { useNotifications } from '../context/NotificationContext';
import { useSkyExplorer } from '../context/SkyExplorerContext';
import { CloseIcon } from './icons/ObservatoryIcons';

interface TourStep {
  title: string;
  body: string;
  selector: string;
  requiresBlinker?: boolean;
}

const TOUR_STEPS: ReadonlyArray<TourStep> = [
  {
    title: '1. True Night-Sky Globe & Cursor Patch',
    body: 'Pan across the infrared sphere and hover to outline a single 5′×5′ SPHEREx cell. Click at wide FoV to fly closer, then click again (or zoom below 0.5°) to inspect full-resolution science planes.',
    selector: '[data-testid="night-sky-globe"]',
  },
  {
    title: '2. Search Bar & What’s Above Me?',
    body: 'Click the magnifying glass to shrink or expand the sky search bar, jump to coordinates, or open the Zenith drawer to see what infrared targets sit overhead anywhere on Earth.',
    selector: '[data-testid="search-zenith-hud"]',
  },
  {
    title: '3. Viewport-Filtered Known Objects',
    body: 'Objects update automatically from your visible sky frustum. Checking boxes highlights markers right away—list sorting waits cleanly until you click outside the panel.',
    selector: '[data-testid="known-objects-panel"]',
  },
  {
    title: '4. Blinker Sliders & Hygiene Tooltips',
    body: 'Scrub the Dual-Thumb Wavelength Slider (0.75–5.0 µm) for real-time Dim & Pop, switch between Blink, Subtract, and Add across SPHEREx/WISE passes, and hover flagged pixels to read artifact masks.',
    selector: '[data-testid="blinker-controls-card"]',
    requiresBlinker: true,
  },
  {
    title: '5. Zero-Occlusion Tracking & 102-Band Spectra',
    body: 'Hollow Triangles (stars), Diamonds (Solar System movers), and tracked Squares keep target centers unobscured. Click a source once to track it, click again to untrack, or inspect its 102-band SED.',
    selector: '[data-testid="blinker-modal"]',
    requiresBlinker: true,
  },
];

export const SpotlightTourOverlay: React.FC = () => {
  const { tourOpen, tourStepIndex, setTourStepIndex, closeTour } = useNotifications();
  const { isBlinkerModalOpen = false, openBlinkerModal } = useSkyExplorer();

  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);

  const step = TOUR_STEPS[Math.max(0, Math.min(TOUR_STEPS.length - 1, tourStepIndex))];

  // Open WISE 0855 Blinker Modal automatically when advancing to Blinker tour steps
  useEffect(() => {
    if (!tourOpen) return;
    if (step.requiresBlinker && !isBlinkerModalOpen) {
      openBlinkerModal?.('wise_0855');
    }
  }, [isBlinkerModalOpen, openBlinkerModal, step.requiresBlinker, tourOpen]);

  // Measure target spotlight element bounds cleanly
  useEffect(() => {
    if (!tourOpen) return undefined;

    const measure = () => {
      const el = document.querySelector(step.selector);
      setTargetRect(el ? el.getBoundingClientRect() : null);
    };
    const timer = window.setTimeout(measure, 80);
    window.addEventListener('resize', measure);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', measure);
    };
  }, [step.selector, tourOpen, tourStepIndex, isBlinkerModalOpen]);

  if (!tourOpen) {
    return null;
  }

  const activeTargetRect = targetRect;

  const isLast = tourStepIndex >= TOUR_STEPS.length - 1;

  // Keep spotlight card nicely anchored near bottom-left or away from target box
  const cardTop =
    activeTargetRect && activeTargetRect.top < window.innerHeight * 0.45
      ? Math.min(window.innerHeight - 210, activeTargetRect.bottom + 16)
      : Math.max(16, (activeTargetRect?.top ?? window.innerHeight * 0.5) - 190);
  const cardLeft =
    activeTargetRect && activeTargetRect.left + 380 < window.innerWidth
      ? Math.max(16, activeTargetRect.left)
      : Math.max(16, window.innerWidth - 376);

  return (
    <>
      {activeTargetRect && (
        <div
          aria-hidden="true"
          style={{
            position: 'fixed',
            left: Math.max(4, activeTargetRect.left - 4),
            top: Math.max(4, activeTargetRect.top - 4),
            width: Math.min(window.innerWidth - 8, activeTargetRect.width + 8),
            height: Math.min(window.innerHeight - 8, activeTargetRect.height + 8),
            borderRadius: 16,
            border: '2px solid rgba(251, 191, 36, 0.85)',
            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.55)',
            pointerEvents: 'none',
            zIndex: 47,
            transition: 'all 220ms ease',
          }}
        />
      )}

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Observatory Guided Tour"
        data-testid="spotlight-tour-card"
        className="tour-spotlight-card"
        style={{
          left: step.selector === '[data-testid="night-sky-globe"]' ? 24 : cardLeft,
          top:
            step.selector === '[data-testid="night-sky-globe"]'
              ? Math.max(96, window.innerHeight * 0.35)
              : cardTop,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 8,
          }}
        >
          <span className="mono" style={{ fontSize: 11, color: 'var(--accent-amber-bright)' }}>
            STEP {tourStepIndex + 1} / {TOUR_STEPS.length}
          </span>
          <button
            type="button"
            className="hud-icon-btn"
            aria-label="Close Guided Tour"
            onClick={() => closeTour(true)}
          >
            <CloseIcon size={14} />
          </button>
        </div>

        <h3 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600 }}>{step.title}</h3>
        <p
          style={{
            margin: '0 0 14px',
            fontSize: 13,
            lineHeight: 1.5,
            color: 'var(--text-secondary)',
          }}
        >
          {step.body}
        </p>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button
            type="button"
            className="hud-btn-secondary"
            disabled={tourStepIndex === 0}
            onClick={() => setTourStepIndex(Math.max(0, tourStepIndex - 1))}
          >
            Previous
          </button>

          <button
            type="button"
            className="hud-btn-primary"
            onClick={() => {
              if (isLast) {
                closeTour(true);
              } else {
                setTourStepIndex(tourStepIndex + 1);
              }
            }}
          >
            {isLast ? 'Finish Tour' : 'Next'}
          </button>
        </div>
      </div>
    </>
  );
};
