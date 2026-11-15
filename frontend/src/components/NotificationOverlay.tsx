import React, { useState } from 'react';
import { useNotifications } from '../context/NotificationContext';
import {
  AlertTriangleIcon,
  ChevronIcon,
  CloseIcon,
  HelpQuestionIcon,
  SpinnerIcon,
} from './icons/ObservatoryIcons';

export const NotificationOverlay: React.FC = () => {
  const {
    alerts,
    dismissWarning,
    asyncTasks,
    finishAsyncTask,
    startTour,
    tourPromptVisible,
    dismissTourPrompt,
  } = useNotifications();

  const [historyExpanded, setHistoryExpanded] = useState(false);

  const latestAlert = alerts[0] ?? null;

  return (
    <>
      {/* Top-Center Warning / Error Notification Banner (Frame 32) */}
      {latestAlert && (
        <div
          className="warning-banner-wrap"
          role="alert"
          aria-live="assertive"
          data-testid="warning-notification-banner"
        >
          <div className={`warning-banner-card ${latestAlert.level === 'error' ? 'is-error' : ''}`}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span
                style={{
                  color:
                    latestAlert.level === 'error'
                      ? 'var(--accent-danger)'
                      : 'var(--accent-amber-bright)',
                  marginTop: 2,
                  flexShrink: 0,
                }}
              >
                <AlertTriangleIcon size={16} />
              </span>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {latestAlert.title}
                </div>
                {latestAlert.detail && (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                    {latestAlert.detail}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                {alerts.length > 1 && (
                  <button
                    type="button"
                    className="hud-icon-btn"
                    aria-label={`Toggle ${alerts.length} active warnings`}
                    aria-expanded={historyExpanded}
                    data-testid="warning-dropdown-toggle"
                    onClick={() => setHistoryExpanded((prev) => !prev)}
                  >
                    <ChevronIcon size={14} direction={historyExpanded ? 'up' : 'down'} />
                  </button>
                )}

                <button
                  type="button"
                  className="hud-icon-btn"
                  aria-label="Dismiss alert"
                  onClick={() => dismissWarning(latestAlert.id)}
                >
                  <CloseIcon size={14} />
                </button>
              </div>
            </div>

            {historyExpanded && alerts.length > 1 && (
              <div
                style={{
                  maxHeight: 150,
                  overflowY: 'auto',
                  borderTop: '1px solid var(--border-hairline)',
                  paddingTop: 6,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                {alerts.slice(1).map((item) => (
                  <div
                    key={item.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      fontSize: 12,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <span>
                      <strong style={{ color: 'var(--text-primary)' }}>{item.title}</strong>
                      {item.detail ? ` — ${item.detail}` : ''}
                    </span>
                    <button
                      type="button"
                      className="hud-icon-btn"
                      aria-label={`Dismiss ${item.title}`}
                      onClick={() => dismissWarning(item.id)}
                    >
                      <CloseIcon size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Bottom-Right Async Operations Toast Stack (Frame 33_2) */}
      {(asyncTasks.length > 0 || tourPromptVisible) && (
        <div
          className="async-toast-stack"
          role="status"
          aria-live="polite"
          data-testid="async-toast-stack"
        >
          {asyncTasks.map((task) => (
            <div key={task.id} className="async-toast-card">
              <span style={{ color: 'var(--accent-cyan)', display: 'inline-flex' }}>
                <SpinnerIcon size={14} />
              </span>
              <span>{task.label}</span>
              <button
                type="button"
                className="hud-icon-btn"
                style={{ width: 22, height: 22 }}
                aria-label={`Close ${task.label} notification`}
                onClick={() => finishAsyncTask(task.id)}
              >
                <CloseIcon size={12} />
              </button>
            </div>
          ))}

          {tourPromptVisible && (
            <div
              className="async-toast-card"
              style={{ borderColor: 'rgba(245, 158, 11, 0.45)' }}
              data-testid="tour-prompt-toast"
            >
              <span>New to Star Hunters? Take the 60s guided observatory tour.</span>
              <button
                type="button"
                className="hud-btn-primary"
                style={{ height: 26, padding: '0 9px', fontSize: 11 }}
                onClick={() => startTour(0)}
              >
                Start Tour
              </button>
              <button
                type="button"
                className="hud-icon-btn"
                style={{ width: 22, height: 22 }}
                aria-label="Dismiss tour prompt"
                onClick={dismissTourPrompt}
              >
                <CloseIcon size={12} />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Persistent 40x40px Bottom-Right Guided Tour Launcher (image 6) */}
      <button
        type="button"
        className="help-fab-btn"
        aria-label="Open Guided Observatory Tour"
        title="Launch Guided Tour"
        data-testid="guided-tour-help-btn"
        onClick={() => startTour(0)}
      >
        <HelpQuestionIcon size={19} />
      </button>
    </>
  );
};
