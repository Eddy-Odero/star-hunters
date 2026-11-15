import React, { useCallback, useEffect, useRef, useState } from 'react';
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
    title: '1. Night-Sky Globe & Panel Grid',
    body: 'Pan and zoom the full-sky globe, or toggle constellations from the HUD. Click once to focus closer, click again to reveal the sky panel grid, then click a visible panel to open its cutout.',
    selector: '[data-testid="night-sky-globe"]',
  },
  {
    title: '2. Search Bar & Zenith Drawer',
    body: 'Click the magnifying glass to expand or fold the sky search bar, jump to Right Ascension and Declination coordinates or Solar System targets like Saturn, or inspect what sits overhead.',
    selector: '[data-testid="search-zenith-hud"]',
  },
  {
    title: '3. Viewport-Filtered Known Objects',
    body: 'Objects update automatically from your visible sky view. Checking boxes highlights markers right away, and the Known Objects list stays reachable inside the Blinker view.',
    selector: '[data-testid="known-objects-panel"]',
  },
  {
    title: '4. Blinker Controls & Data Source Badge',
    body: 'Scrub the Dual-Thumb Wavelength Slider (0.75 to 5.0 um) for Dim and Pop, switch between Blink, Subtract, and Add passes, and check the Image Source badge (SPHEREx, WISE, or SkyView).',
    selector: '[data-testid="blinker-controls-card"]',
    requiresBlinker: true,
  },
  {
    title: '5. Object Details, Tracking & Spectra',
    body: 'Hollow Triangles (stars), Diamonds (movers), and Squares keep centers clear. Hover a marker briefly to preview details, click to lock the callout card, or open the 102-band spectrum view.',
    selector: '[data-testid="blinker-modal"]',
    requiresBlinker: true,
  },
];

export const SpotlightTourOverlay: React.FC = () => {
  const { tourOpen, tourStepIndex, setTourStepIndex, closeTour } = useNotifications();
  const { isBlinkerModalOpen = false, openBlinkerModal, closeBlinkerModal } = useSkyExplorer();

  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const tourOpenedBlinkerRef = useRef<boolean>(false);

  const step = TOUR_STEPS[Math.max(0, Math.min(TOUR_STEPS.length - 1, tourStepIndex))];

  // Open WISE 0855 Blinker Modal automatically when advancing to Blinker tour steps
  useEffect(() => {
    if (!tourOpen) return;
    if (step.requiresBlinker && !isBlinkerModalOpen) {
      tourOpenedBlinkerRef.current = true;
      openBlinkerModal?.('wise_0855');
    }
  }, [isBlinkerModalOpen, openBlinkerModal, step.requiresBlinker, tourOpen]);

  const handleCloseTour = useCallback(() => {
    if (tourOpenedBlinkerRef.current) {
      tourOpenedBlinkerRef.current = false;
      closeBlinkerModal?.();
    }
    closeTour(true);
  }, [closeBlinkerModal, closeTour]);

  // Measure target spotlight element bounds cleanly without stalling the compositor
  useEffect(() => {
    if (!tourOpen) return undefined;

    let ro: ResizeObserver | null = null;
    const measure = () => {
      const el = document.querySelector(step.selector);
      setTargetRect(el ? el.getBoundingClientRect() : null);
      if (el && !ro && typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => {
          setTargetRect(el.getBoundingClientRect());
        });
        ro.observe(el);
      }
    };

    const rafId = window.requestAnimationFrame(measure);
    const timer = window.setTimeout(measure, 150);
    window.addEventListener('resize', measure);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timer);
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [step.selector, tourOpen, tourStepIndex, isBlinkerModalOpen]);

  if (!tourOpen) {
    return null;
  }

  const activeTargetRect = targetRect;

  const isLast = tourStepIndex >= TOUR_STEPS.length - 1;

  const cutLeft = activeTargetRect ? Math.max(4, Math.floor(activeTargetRect.left - 4)) : 0;
  const cutTop = activeTargetRect ? Math.max(4, Math.floor(activeTargetRect.top - 4)) : 0;
  const cutRight = activeTargetRect
    ? Math.min(window.innerWidth - 4, Math.ceil(activeTargetRect.right + 4))
    : 0;
  const cutBottom = activeTargetRect
    ? Math.min(window.innerHeight - 4, Math.ceil(activeTargetRect.bottom + 4))
    : 0;
  const cutW = Math.max(0, cutRight - cutLeft);
  const cutH = Math.max(0, cutBottom - cutTop);

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
      {activeTargetRect && cutW > 0 && cutH > 0 && (
        <div
          aria-hidden="true"
          style={{
            position: 'fixed',
            inset: 0,
            pointerEvents: 'none',
            zIndex: 47,
          }}
        >
          <div
            style={{
              position: 'fixed',
              left: 0,
              top: 0,
              right: 0,
              height: cutTop,
              background: 'rgba(0, 0, 0, 0.56)',
            }}
          />
          <div
            style={{
              position: 'fixed',
              left: 0,
              top: cutBottom,
              right: 0,
              bottom: 0,
              background: 'rgba(0, 0, 0, 0.56)',
            }}
          />
          <div
            style={{
              position: 'fixed',
              left: 0,
              top: cutTop,
              width: cutLeft,
              height: cutH,
              background: 'rgba(0, 0, 0, 0.56)',
            }}
          />
          <div
            style={{
              position: 'fixed',
              left: cutRight,
              top: cutTop,
              right: 0,
              height: cutH,
              background: 'rgba(0, 0, 0, 0.56)',
            }}
          />
          <div
            style={{
              position: 'fixed',
              left: cutLeft,
              top: cutTop,
              width: cutW,
              height: cutH,
              borderRadius: 14,
              border: '2px solid rgba(251, 191, 36, 0.88)',
            }}
          />
        </div>
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
            onClick={handleCloseTour}
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
            onClick={() => {
              const prevIndex = Math.max(0, tourStepIndex - 1);
              if (!TOUR_STEPS[prevIndex].requiresBlinker && tourOpenedBlinkerRef.current) {
                tourOpenedBlinkerRef.current = false;
                closeBlinkerModal?.();
              }
              setTourStepIndex(prevIndex);
            }}
          >
            Previous
          </button>

          <button
            type="button"
            className="hud-btn-primary"
            onClick={() => {
              if (isLast) {
                handleCloseTour();
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
