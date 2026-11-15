import React from 'react';
import type { DetailsCalloutOrigin } from '../../utils/calloutPlacement';
import { CloseIcon, SpectrumWaveIcon } from '../icons/ObservatoryIcons';
import { isImagePointInBounds, type CalloutDetail, type CalloutGeometry } from './calloutBuilder';

/** Props for {@link BlinkerCalloutOverlay}. */
interface BlinkerCalloutOverlayProps {
  calloutDetail: CalloutDetail;
  calloutGeometry: CalloutGeometry;
  activeCalloutOrigin: DetailsCalloutOrigin;
  isCutoutLoading: boolean;
  activeEpochIndex: number;
  onClose: () => void;
  onUntrack: (trackId: string) => void;
  onPinTrack: (imgX: number, imgY: number, epochIdx: number) => void;
  onOpenSpectrum?: (params: { ra: number; dec: number; label: string }) => void;
}

/**
 * Non-occluding 1px leader line and translucent frosted-glass object details card.
 *
 * @param props - Callout detail fields, smart geometry coordinates, and action handlers.
 * @returns Rendered leader SVG and floating callout card.
 */
export const BlinkerCalloutOverlay: React.FC<BlinkerCalloutOverlayProps> = ({
  calloutDetail,
  calloutGeometry,
  activeCalloutOrigin,
  isCutoutLoading,
  activeEpochIndex,
  onClose,
  onUntrack,
  onPinTrack,
  onOpenSpectrum,
}) => {
  const isInPatchBounds = isImagePointInBounds(calloutDetail.imgX, calloutDetail.imgY);

  return (
    <>
      <svg aria-hidden="true" className="callout-leader-svg">
        <polyline
          points={`${calloutGeometry.lineStartX.toFixed(1)},${calloutGeometry.lineStartY.toFixed(1)} ${calloutGeometry.kneeX.toFixed(1)},${calloutGeometry.kneeY.toFixed(1)} ${calloutGeometry.anchorX.toFixed(1)},${calloutGeometry.anchorY.toFixed(1)}`}
          fill="none"
          stroke={calloutGeometry.color}
          strokeWidth={1}
          strokeLinejoin="round"
          opacity={0.92}
        />
      </svg>

      <div
        className="callout-card"
        role="region"
        aria-label="Object Details Callout Card"
        data-testid="blinker-callout-card"
        data-callout-origin={activeCalloutOrigin}
        style={{
          left: calloutGeometry.cardLeft,
          top: calloutGeometry.cardTop,
          borderColor: `${calloutGeometry.color}88`,
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      >
        <div className="callout-header-row">
          <div className="callout-header-text">
            <div className="callout-title">{calloutDetail.title}</div>
            <div className="mono callout-subtitle">{calloutDetail.subtitle}</div>
          </div>
          <div className="callout-header-actions">
            <span
              className="mono callout-pin-pill"
              style={{
                borderColor: `${calloutGeometry.color}66`,
                color: calloutDetail.isLocked ? calloutGeometry.color : 'var(--text-secondary)',
              }}
            >
              {calloutDetail.isLocked ? 'Pinned' : 'Preview'}
            </span>
            <button
              type="button"
              className="hud-icon-btn callout-close-btn"
              aria-label="Close object details"
              data-testid="callout-close-btn"
              onClick={onClose}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        </div>

        <p className="callout-description" data-testid="callout-description">
          {calloutDetail.description}
        </p>

        <div className="callout-meta-row">
          <span className="badge-pill">{calloutDetail.catalogBadge}</span>
          <span className="mono callout-meta-mag">{calloutDetail.magnitudeText}</span>
          <span className="mono" style={{ color: calloutGeometry.color }}>
            {calloutDetail.properMotionText}
          </span>
          {calloutDetail.w1W2Text && (
            <span className="mono callout-meta-color">{calloutDetail.w1W2Text}</span>
          )}
        </div>

        <div className="callout-footer-row">
          {calloutDetail.trackId ? (
            <button
              type="button"
              className="hud-btn-secondary callout-action-btn"
              data-testid="callout-untrack-btn"
              onClick={() => onUntrack(calloutDetail.trackId!)}
            >
              Untrack
            </button>
          ) : (
            <button
              type="button"
              className="hud-btn-secondary callout-action-btn"
              data-testid="callout-pin-track-btn"
              disabled={!isInPatchBounds || isCutoutLoading}
              title={
                !isInPatchBounds
                  ? 'Object sits outside the 256x256 pixel cutout bounds'
                  : 'Convert marker to Square & track across passes'
              }
              onClick={() => {
                if (!isInPatchBounds) return;
                onPinTrack(calloutDetail.imgX, calloutDetail.imgY, activeEpochIndex);
              }}
            >
              Pin Vector
            </button>
          )}

          <button
            type="button"
            className="hud-btn-primary callout-spectrum-btn"
            data-testid="view-spectrum-btn"
            onClick={() =>
              onOpenSpectrum?.({
                ra: calloutDetail.ra,
                dec: calloutDetail.dec,
                label: calloutDetail.title,
              })
            }
          >
            <SpectrumWaveIcon size={13} />
            <span>View 102-Band Spectrum</span>
          </button>
        </div>
      </div>
    </>
  );
};
