import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

export type WarningLevel = 'warning' | 'error';

export interface WarningAlert {
  id: string;
  title: string;
  detail?: string;
  level: WarningLevel;
  createdAt: number;
}

export interface AsyncTaskToast {
  id: string;
  label: string;
  startedAt: number;
}

export interface NotificationContextValue {
  alerts: WarningAlert[];
  pushWarning: (alert: {
    id?: string;
    title: string;
    detail?: string;
    level?: WarningLevel;
  }) => void;
  dismissWarning: (id: string) => void;
  clearWarnings: () => void;
  asyncTasks: AsyncTaskToast[];
  startAsyncTask: (id: string, label: string) => void;
  finishAsyncTask: (id: string) => void;
  tourOpen: boolean;
  tourStepIndex: number;
  startTour: (stepIndex?: number) => void;
  closeTour: (markSeen?: boolean) => void;
  setTourStepIndex: (index: number) => void;
  tourPromptVisible: boolean;
  dismissTourPrompt: () => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

const WARNING_AUTO_DISMISS_MS = 6000;
const TOUR_SEEN_STORAGE_KEY = 'star_hunters_guided_tour_seen_v1';

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [alerts, setAlerts] = useState<WarningAlert[]>([]);
  const [asyncTasks, setAsyncTasks] = useState<AsyncTaskToast[]>([]);
  const [tourOpen, setTourOpen] = useState(false);
  const [tourStepIndex, setTourStepIndex] = useState(0);
  const [tourPromptVisible, setTourPromptVisible] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(TOUR_SEEN_STORAGE_KEY) !== 'seen';
    } catch {
      return false;
    }
  });

  const warningTimersRef = useRef<Map<string, number>>(new Map());

  const dismissWarning = useCallback((id: string) => {
    const existingTimer = warningTimersRef.current.get(id);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
      warningTimersRef.current.delete(id);
    }
    setAlerts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const pushWarning = useCallback(
    (input: { id?: string; title: string; detail?: string; level?: WarningLevel }) => {
      const id = input.id ?? `warn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const existingTimer = warningTimersRef.current.get(id);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
      }

      const nextAlert: WarningAlert = {
        id,
        title: input.title,
        detail: input.detail,
        level: input.level ?? 'warning',
        createdAt: Date.now(),
      };

      setAlerts((prev) => [nextAlert, ...prev.filter((item) => item.id !== id)]);

      if (typeof window !== 'undefined') {
        const timerId = window.setTimeout(() => {
          warningTimersRef.current.delete(id);
          setAlerts((prev) => prev.filter((item) => item.id !== id));
        }, WARNING_AUTO_DISMISS_MS);
        warningTimersRef.current.set(id, timerId);
      }
    },
    [],
  );

  const clearWarnings = useCallback(() => {
    for (const timerId of warningTimersRef.current.values()) {
      window.clearTimeout(timerId);
    }
    warningTimersRef.current.clear();
    setAlerts([]);
  }, []);

  const startAsyncTask = useCallback((id: string, label: string) => {
    setAsyncTasks((prev) => {
      const existing = prev.find((item) => item.id === id);
      if (existing && existing.label === label) return prev;
      const filtered = prev.filter((item) => item.id !== id);
      return [...filtered, { id, label, startedAt: Date.now() }];
    });
  }, []);

  const finishAsyncTask = useCallback((id: string) => {
    setAsyncTasks((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const dismissTourPrompt = useCallback(() => {
    setTourPromptVisible(false);
    try {
      window.localStorage.setItem(TOUR_SEEN_STORAGE_KEY, 'seen');
    } catch {
      // Ignore storage quota errors cleanly
    }
  }, []);

  const startTour = useCallback(
    (stepIndex = 0) => {
      setTourStepIndex(stepIndex);
      setTourOpen(true);
      dismissTourPrompt();
    },
    [dismissTourPrompt],
  );

  const closeTour = useCallback(
    (markSeen = true) => {
      setTourOpen(false);
      if (markSeen) {
        dismissTourPrompt();
      }
    },
    [dismissTourPrompt],
  );

  useEffect(() => {
    const timers = warningTimersRef.current;
    return () => {
      for (const timerId of timers.values()) {
        window.clearTimeout(timerId);
      }
      timers.clear();
    };
  }, []);

  const value = useMemo<NotificationContextValue>(
    () => ({
      alerts,
      pushWarning,
      dismissWarning,
      clearWarnings,
      asyncTasks,
      startAsyncTask,
      finishAsyncTask,
      tourOpen,
      tourStepIndex,
      startTour,
      closeTour,
      setTourStepIndex,
      tourPromptVisible,
      dismissTourPrompt,
    }),
    [
      alerts,
      pushWarning,
      dismissWarning,
      clearWarnings,
      asyncTasks,
      startAsyncTask,
      finishAsyncTask,
      tourOpen,
      tourStepIndex,
      startTour,
      closeTour,
      tourPromptVisible,
      dismissTourPrompt,
    ],
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
};

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error('useNotifications must be used inside a NotificationProvider');
  }
  return ctx;
}

export function useOptionalNotifications(): NotificationContextValue | null {
  return useContext(NotificationContext);
}
