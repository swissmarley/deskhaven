import { type JSX, useEffect } from 'react';
import { useAppStore } from '../state/store.js';

/** Info toasts go away on their own; warnings and errors stay until dismissed. */
export const INFO_NOTICE_MS = 6_000;

/**
 * Toasts float above every panel and modal, so their bodies let clicks through to whatever is
 * underneath: a toast over the task window's "close" link used to swallow the first click (it
 * dismissed the toast instead). Only the × button takes clicks.
 */
export function Notices(): JSX.Element | null {
  const notices = useAppStore((s) => s.notices);
  const dismiss = useAppStore((s) => s.dismissNotice);

  useEffect(() => {
    const timers = notices
      .filter((n) => n.level === 'info')
      .map((n) => window.setTimeout(() => dismiss(n.id), INFO_NOTICE_MS));
    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
  }, [notices, dismiss]);

  if (!notices.length) return null;
  return (
    <div className="notices" aria-live="polite">
      {notices.slice(-4).map((n) => (
        <div key={n.id} className={`notice-toast ${n.level}`} role="status">
          <span className="notice-text">{n.message}</span>
          <button
            type="button"
            className="notice-dismiss"
            aria-label="Dismiss notice"
            onClick={() => dismiss(n.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
