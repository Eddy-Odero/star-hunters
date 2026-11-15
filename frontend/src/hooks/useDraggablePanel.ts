import { useCallback, useEffect, useRef, useState } from 'react';

import {
  computeMagneticSnap,
  resolvePositionFromAnchor,
  type EdgeAnchor,
} from '../utils/observatoryMath.ts';

export interface DraggablePanelOptions {
  storageKey: string;
  defaultAnchor: EdgeAnchor;
  defaultWidth: number;
  defaultHeight: number;
  defaultFolded?: boolean;
  mobileDefaultY?: number;
  margin?: number;
  snapThreshold?: number;
}

interface PersistedPanelState {
  x: number;
  y: number;
  edgeAnchor: EdgeAnchor;
  isFolded: boolean;
}

function getViewportSize(): { width: number; height: number } {
  if (typeof window === 'undefined') {
    return { width: 1440, height: 1024 };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

function loadSavedState(opts: DraggablePanelOptions): PersistedPanelState {
  const margin = opts.margin ?? 16;
  const vp = getViewportSize();
  const initialY =
    vp.width < 768 && typeof opts.mobileDefaultY === 'number' ? opts.mobileDefaultY : margin;
  const fallback = resolvePositionFromAnchor(
    { x: margin, y: initialY, edgeAnchor: opts.defaultAnchor },
    { width: opts.defaultWidth, height: opts.defaultHeight },
    vp,
    margin,
  );
  const defaultState: PersistedPanelState = {
    ...fallback,
    isFolded: opts.defaultFolded ?? false,
  };

  if (typeof window === 'undefined') return defaultState;
  try {
    const raw = window.localStorage.getItem(opts.storageKey);
    if (!raw) return defaultState;
    const parsed = JSON.parse(raw) as Partial<PersistedPanelState>;
    const resolved = resolvePositionFromAnchor(
      {
        x: typeof parsed.x === 'number' ? parsed.x : fallback.x,
        y: typeof parsed.y === 'number' ? parsed.y : fallback.y,
        edgeAnchor: parsed.edgeAnchor ?? opts.defaultAnchor,
      },
      { width: opts.defaultWidth, height: opts.defaultHeight },
      vp,
      margin,
    );
    const clampedY =
      vp.width < 768 && typeof opts.mobileDefaultY === 'number'
        ? Math.max(opts.mobileDefaultY, resolved.y)
        : resolved.y;
    return {
      ...resolved,
      y: clampedY,
      isFolded:
        typeof parsed.isFolded === 'boolean' ? parsed.isFolded : (opts.defaultFolded ?? false),
    };
  } catch {
    return defaultState;
  }
}

export function useDraggablePanel(opts: DraggablePanelOptions) {
  const margin = opts.margin ?? 16;
  const snapThreshold = opts.snapThreshold ?? 24;
  const panelRef = useRef<HTMLDivElement | null>(null);

  const [state, setState] = useState<PersistedPanelState>(() => loadSavedState(opts));
  const [isDragging, setIsDragging] = useState(false);

  const dragSessionRef = useRef<{
    startPointerX: number;
    startPointerY: number;
    startPanelX: number;
    startPanelY: number;
    width: number;
    height: number;
  } | null>(null);

  const persistState = useCallback(
    (next: PersistedPanelState) => {
      try {
        window.localStorage.setItem(opts.storageKey, JSON.stringify(next));
      } catch {
        // Ignore storage quota errors
      }
    },
    [opts.storageKey],
  );

  // Re-clamp on viewport resize using live measured panel size
  useEffect(() => {
    const handleResize = () => {
      const vp = getViewportSize();
      const rect = panelRef.current?.getBoundingClientRect();
      const size = {
        width: rect?.width && rect.width > 40 ? rect.width : opts.defaultWidth,
        height: rect?.height && rect.height > 28 ? rect.height : opts.defaultHeight,
      };
      setState((prev) => {
        const resolved = resolvePositionFromAnchor(prev, size, vp, margin);
        const adjustedY =
          vp.width < 768 && typeof opts.mobileDefaultY === 'number'
            ? Math.max(opts.mobileDefaultY, resolved.y)
            : resolved.y;
        if (resolved.x === prev.x && adjustedY === prev.y) return prev;
        return { ...prev, ...resolved, y: adjustedY };
      });
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [margin, opts.defaultHeight, opts.defaultWidth, opts.mobileDefaultY]);

  const toggleFolded = useCallback(() => {
    setState((prev) => {
      const next = { ...prev, isFolded: !prev.isFolded };
      persistState(next);
      return next;
    });
  }, [persistState]);

  const setFolded = useCallback(
    (folded: boolean) => {
      setState((prev) => {
        if (prev.isFolded === folded) return prev;
        const next = { ...prev, isFolded: folded };
        persistState(next);
        return next;
      });
    },
    [persistState],
  );

  const onDragHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // Do not initiate drag when interacting with buttons/inputs/selects inside handle
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('button, input, select, a, [data-no-drag="true"]')) {
        return;
      }

      const rect = panelRef.current?.getBoundingClientRect();
      const width = rect?.width && rect.width > 40 ? rect.width : opts.defaultWidth;
      const height = rect?.height && rect.height > 28 ? rect.height : opts.defaultHeight;

      dragSessionRef.current = {
        startPointerX: e.clientX,
        startPointerY: e.clientY,
        startPanelX: state.x,
        startPanelY: state.y,
        width,
        height,
      };
      setIsDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [opts.defaultHeight, opts.defaultWidth, state.x, state.y],
  );

  const onDragHandlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const session = dragSessionRef.current;
      if (!session) return;
      const dx = e.clientX - session.startPointerX;
      const dy = e.clientY - session.startPointerY;
      const vp = getViewportSize();
      const maxX = Math.max(margin, vp.width - session.width - margin);
      const maxY = Math.max(margin, vp.height - session.height - margin);
      const nextX = Math.max(margin, Math.min(maxX, session.startPanelX + dx));
      const nextY = Math.max(margin, Math.min(maxY, session.startPanelY + dy));
      setState((prev) => ({
        ...prev,
        x: Math.round(nextX),
        y: Math.round(nextY),
        edgeAnchor: 'free',
      }));
    },
    [margin],
  );

  const onDragHandlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const session = dragSessionRef.current;
      if (!session) return;
      dragSessionRef.current = null;
      setIsDragging(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore if capture already released
      }

      const dx = e.clientX - session.startPointerX;
      const dy = e.clientY - session.startPointerY;
      const vp = getViewportSize();
      const snapped = computeMagneticSnap(
        { x: session.startPanelX + dx, y: session.startPanelY + dy },
        { width: session.width, height: session.height },
        vp,
        margin,
        snapThreshold,
      );
      setState((prev) => {
        const next: PersistedPanelState = {
          ...prev,
          x: snapped.x,
          y: snapped.y,
          edgeAnchor: snapped.edgeAnchor,
        };
        persistState(next);
        return next;
      });
    },
    [margin, persistState, snapThreshold],
  );

  return {
    panelRef,
    x: state.x,
    y: state.y,
    edgeAnchor: state.edgeAnchor,
    isFolded: state.isFolded,
    isDragging,
    toggleFolded,
    setFolded,
    dragHandleProps: {
      onPointerDown: onDragHandlePointerDown,
      onPointerMove: onDragHandlePointerMove,
      onPointerUp: onDragHandlePointerUp,
      onPointerCancel: onDragHandlePointerUp,
    },
  };
}
