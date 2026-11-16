import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NotificationContextValue } from '../context/NotificationContext';
import type { SpectrumPayload, TracedObjectSummary } from '../types/contracts';
import { observatoryLogger } from '../utils/observatoryLogger';

/** Options accepted by {@link useSpectrumInspector}. */
export interface UseSpectrumInspectorOptions {
  /** Active sky-patch center coordinates used as fallback target when no coords are supplied. */
  coordinates: { ra: number; dec: number; fovArcmin: number };
  /** Currently selected tracked object, if any. */
  selectedObject: TracedObjectSummary | null;
  /** Ref to notification context for progress toasts and warning banners. */
  notificationsRef: React.RefObject<NotificationContextValue | null>;
}

/**
 * Manage 102-band SPHEREx spectral energy distribution (SED) state, modal
 * open/close lifecycle, and `/api/v1/spectrum` fetching with duplicate-coord reuse.
 *
 * @param options - Fallback sky coordinates, selected object, and notification ref.
 * @returns Active spectrum payload, loading/modal flags, and open/close/setter actions.
 */
export function useSpectrumInspector({
  coordinates,
  selectedObject,
  notificationsRef,
}: UseSpectrumInspectorOptions) {
  const [activeSpectrum, setActiveSpectrum] = useState<SpectrumPayload | null>(null);
  const [isSpectrumLoading, setIsSpectrumLoading] = useState<boolean>(false);
  const [isSpectraModalOpen, setIsSpectraModalOpen] = useState<boolean>(false);

  const latestRef = useRef({ activeSpectrum, coordinates, selectedObject });
  useEffect(() => {
    latestRef.current = { activeSpectrum, coordinates, selectedObject };
  }, [activeSpectrum, coordinates, selectedObject]);

  const openSelectedSpectrum = useCallback(
    async (coords?: { ra: number; dec: number; label?: string }) => {
      setIsSpectraModalOpen(true);
      const {
        activeSpectrum: currSpectrum,
        coordinates: currCoords,
        selectedObject: currSelected,
      } = latestRef.current;
      const targetRa = coords?.ra ?? currSelected?.ra ?? currCoords.ra;
      const targetDec = coords?.dec ?? currSelected?.dec ?? currCoords.dec;

      // Reuse already-loaded matching spectrum when clicking near patch center
      if (
        currSpectrum &&
        Math.abs(currSpectrum.ra - targetRa) < 0.002 &&
        Math.abs(currSpectrum.dec - targetDec) < 0.002
      ) {
        return;
      }

      setIsSpectrumLoading(true);
      notificationsRef.current?.startAsyncTask(
        'spectrum-fetch',
        'Loading 102-band spectrum...',
        'progress',
      );
      observatoryLogger.info('spectrum', 'Fetching 102-band spectrum', {
        ra: targetRa,
        dec: targetDec,
      });
      try {
        const params = new URLSearchParams({
          ra: targetRa.toFixed(5),
          dec: targetDec.toFixed(5),
        });
        const label = coords?.label ?? currSelected?.matchedLabel;
        if (label) {
          params.set('label', label);
        }
        const res = await fetch(`/api/v1/spectrum?${params.toString()}`);
        if (res.ok) {
          const payload = (await res.json()) as SpectrumPayload;
          if (payload && Array.isArray(payload.channels) && payload.channels.length > 0) {
            setActiveSpectrum(payload);
            observatoryLogger.info('spectrum', 'Loaded 102-band spectrum', {
              channels: payload.channels.length,
              label: payload.source_label,
            });
            return;
          }
        }
        throw new Error(`Spectrum endpoint returned status ${res.status}`);
      } catch (err) {
        observatoryLogger.warn('spectrum', 'Spectrum request failed', {
          error: err instanceof Error ? err.message : 'unavailable',
        });
        if (!latestRef.current.activeSpectrum) {
          notificationsRef.current?.pushWarning({
            id: 'spectrum-error',
            title: '102-band spectrum unavailable',
            detail:
              err instanceof Error
                ? err.message
                : 'Backend spectrum extractor could not be reached.',
            level: 'warning',
          });
        }
      } finally {
        setIsSpectrumLoading(false);
        notificationsRef.current?.finishAsyncTask('spectrum-fetch');
      }
    },
    [notificationsRef],
  );

  const closeSpectraModal = useCallback(() => {
    setIsSpectraModalOpen(false);
  }, []);

  return {
    activeSpectrum,
    setActiveSpectrum,
    isSpectrumLoading,
    isSpectraModalOpen,
    setIsSpectraModalOpen,
    openSelectedSpectrum,
    closeSpectraModal,
  };
}
