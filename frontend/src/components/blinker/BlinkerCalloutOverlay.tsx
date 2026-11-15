import React from 'react';
import type { DetailsCalloutOrigin } from '../../utils/calloutPlacement';
import { CloseIcon, SpectrumWaveIcon } from '../icons/ObservatoryIcons';
import { isImagePointInBounds, type CalloutDetail, type CalloutGeometry } from './calloutBuilder';

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

/** Non-occluding 1px leader line and translucent frosted-glass object details card. */
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
      <svg
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: 6,
        }}
      >
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
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--text-primary)',
                lineHeight: 1.3,
                overflowWrap: 'anywhere',
              }}
            >
              {calloutDetail.title}
            </div>
            <div
              className="mono"
              style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}
            >
              {calloutDetail.subtitle}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
            <span
              className="mono"
              style={{
                fontSize: 9.5,
                padding: '1px 6px',
                borderRadius: 999,
                border: `1px solid ${calloutGeometry.color}66`,
                color: calloutDetail.isLocked ? calloutGeometry.color : 'var(--text-secondary)',
              }}
            >
              {calloutDetail.isLocked ? 'Pinned' : 'Preview'}
            </span>
            <button
              type="button"
              className="hud-icon-btn"
              style={{ width: 22, height: 22 }}
              aria-label="Close object details"
              data-testid="callout-close-btn"
              onClick={onClose}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        </div>

        <p
          style={{
            margin: 0,
            fontSize: 11.5,
            lineHeight: 1.42,
            color: 'var(--text-secondary)',
            overflowWrap: 'anywhere',
          }}
          data-testid="callout-description"
        >
          {calloutDetail.description}
        </p>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 6,
            fontSize: 10.5,
          }}
        >
          <span className="badge-pill">{calloutDetail.catalogBadge}</span>
          <span className="mono" style={{ color: 'var(--text-secondary)' }}>
            {calloutDetail.magnitudeText}
          </span>
          <span className="mono" style={{ color: calloutGeometry.color }}>
            {calloutDetail.properMotionText}
          </span>
          {calloutDetail.w1W2Text && (
            <span className="mono" style={{ color: 'var(--text-muted)' }}>
              {calloutDetail.w1W2Text}
            </span>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            paddingTop: 2,
          }}
        >
          {calloutDetail.trackId ? (
            <button
              type="button"
              className="hud-btn-secondary"
              style={{ height: 26, padding: '0 9px', fontSize: 11 }}
              data-testid="callout-untrack-btn"
              onClick={() => onUntrack(calloutDetail.trackId!)}
            >
              Untrack
            </button>
          ) : (
            <button
              type="button"
              className="hud-btn-secondary"
              style={{ height: 26, padding: '0 9px', fontSize: 11 }}
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
            className="hud-btn-primary"
            style={{ height: 28, padding: '0 10px', fontSize: 11 }}
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
