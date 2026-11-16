import React from 'react';
import type { ContrastStretch, ImageProvenanceBadge } from '../../types/contracts';
import {
  ChevronIcon,
  CloseIcon,
  ResetViewIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from '../icons/ObservatoryIcons';

interface BlinkerHeaderProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  zoom: number;
  panX: number;
  panY: number;
  contrastStretch: ContrastStretch;
  title: string;
  fullSubtitleText: string;
  provenance: ImageProvenanceBadge;
  statusNote?: string;
  onSetZoomPan: (zoom: number, panX: number, panY: number) => void;
  onResetZoomPan: () => void;
  onChangeContrast: (next: ContrastStretch) => void;
  onClose?: () => void;
}

/** Modal header containing sidebar toggle, viewport zoom/stretch controls, marquee subtitle, and provenance pill. */
export const BlinkerHeader: React.FC<BlinkerHeaderProps> = ({
  sidebarCollapsed,
  onToggleSidebar,
  zoom,
  panX,
  panY,
  contrastStretch,
  title,
  fullSubtitleText,
  provenance,
  statusNote,
  onSetZoomPan,
  onResetZoomPan,
  onChangeContrast,
  onClose,
}) => (
  <header
    className="blinker-header"
    onPointerDown={(e) => e.stopPropagation()}
    onPointerUp={(e) => e.stopPropagation()}
  >
    <div className="blinker-header-left">
      <button
        type="button"
        className={`hud-icon-btn ${!sidebarCollapsed ? 'is-active' : ''}`}
        aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-expanded={!sidebarCollapsed}
        data-testid="blinker-sidebar-toggle"
        title={sidebarCollapsed ? 'Show Controls & Known Objects Sidebar' : 'Hide Sidebar'}
        onClick={onToggleSidebar}
      >
        <ChevronIcon size={14} direction={sidebarCollapsed ? 'right' : 'left'} />
      </button>
      <button
        type="button"
        className="hud-icon-btn"
        aria-label="Zoom out cutout"
        onClick={() => onSetZoomPan(zoom / 1.4, panX, panY)}
      >
        <ZoomOutIcon size={14} />
      </button>
      <span className="mono" style={{ minWidth: 34, textAlign: 'center' }}>
        {zoom.toFixed(1)}×
      </span>
      <button
        type="button"
        className="hud-icon-btn"
        aria-label="Zoom in cutout"
        onClick={() => onSetZoomPan(zoom * 1.4, panX, panY)}
      >
        <ZoomInIcon size={14} />
      </button>
      {zoom > 1.01 && (
        <button
          type="button"
          className="hud-icon-btn"
          aria-label="Reset zoom and pan"
          onClick={onResetZoomPan}
        >
          <ResetViewIcon size={14} />
        </button>
      )}
      <select
        aria-label="Contrast stretch"
        className="hud-select"
        style={{ height: 26, fontSize: 11, marginLeft: 4 }}
        value={contrastStretch}
        onChange={(e) => onChangeContrast(e.target.value as ContrastStretch)}
      >
        <option value="asinh">Asinh</option>
        <option value="zscale">ZScale</option>
        <option value="linear">Linear</option>
      </select>
    </div>

    <div className="blinker-section-label" title={fullSubtitleText}>
      <span className="blinker-section-title">{title}</span>
      <div className="blinker-section-sub-marquee" tabIndex={0}>
        <span className="blinker-section-sub mono">{fullSubtitleText}</span>
      </div>
    </div>

    <div className="blinker-header-right">
      <span
        className={`provenance-pill provenance-pill--${provenance.tier}`}
        data-testid="blinker-provenance-badge"
        title={statusNote ? `${provenance.label} (${statusNote})` : provenance.label}
      >
        {provenance.label}
      </span>
      <button
        type="button"
        className="hud-icon-btn"
        aria-label="Close Blinker Modal"
        data-testid="blinker-close-btn"
        onClick={onClose}
      >
        <CloseIcon size={16} />
      </button>
    </div>
  </header>
);
