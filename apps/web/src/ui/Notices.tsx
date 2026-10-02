import type { JSX } from 'react';
import { useAppStore } from '../state/store.js';

export function Notices(): JSX.Element | null {
  const notices = useAppStore((s) => s.notices);
  const dismiss = useAppStore((s) => s.dismissNotice);
  if (!notices.length) return null;
  return (
    <div className="notices">
      {notices.slice(-4).map((n) => (
        <button
          type="button"
          key={n.id}
          className={`notice-toast ${n.level}`}
          onClick={() => dismiss(n.id)}
        >
          {n.message}
        </button>
      ))}
    </div>
  );
}
