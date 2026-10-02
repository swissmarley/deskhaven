import type { JSX } from 'react';
import { api } from '../net/api.js';
import { useAppStore } from '../state/store.js';
import { fmtTokens, fmtUsd } from './eventText.js';

export function TopBar(): JSX.Element {
  const connection = useAppStore((s) => s.connection);
  const settings = useAppStore((s) => s.settings);
  const usage = useAppStore((s) => s.usage);
  const killSwitch = useAppStore((s) => s.killSwitch);
  const soundEnabled = useAppStore((s) => s.soundEnabled);
  const setSoundEnabled = useAppStore((s) => s.setSoundEnabled);
  const pushNotice = useAppStore((s) => s.pushNotice);

  const modeLabel = settings?.authMode === 'CLAUDE_SUBSCRIPTION' ? 'Subscription' : 'API key';
  const inUse = usage?.authModeInUse ?? 'unknown';

  const toggleKill = async () => {
    try {
      if (killSwitch) await api.resetKill();
      else if (confirm('Stop every agent and refuse new work until reset?')) await api.kill();
    } catch (err) {
      pushNotice('error', String(err));
    }
  };

  return (
    <header className="topbar">
      <span className="brand">AgentHotel</span>
      <span className="status">
        <span
          className={`dot ${connection === 'open' ? 'ok' : connection === 'closed' ? 'bad' : ''}`}
        />
        {connection}
      </span>
      <span className="hud">
        <span
          className="hud-item"
          title={`Auth mode in Settings: ${modeLabel}. In use by the last session: ${inUse}`}
        >
          <span className="hud-label">auth</span> {modeLabel}
          {settings?.authMode === 'CLAUDE_SUBSCRIPTION' ? (
            <span className="pill warn">plan usage</span>
          ) : null}
        </span>
        <span className="hud-item" title="Estimated API-equivalent cost today / total">
          <span className="hud-label">cost</span> {fmtUsd(usage?.today.costUsd ?? 0)}{' '}
          <span className="muted">/ {fmtUsd(usage?.totals.costUsd ?? 0)}</span>
        </span>
        <span className="hud-item" title="Input + output tokens today">
          <span className="hud-label">tokens</span>{' '}
          {fmtTokens((usage?.today.inputTokens ?? 0) + (usage?.today.outputTokens ?? 0))}
        </span>
        <span className="hud-item" title="Running agents / concurrency cap">
          <span className="hud-label">desks</span> {usage?.running ?? 0}/
          {usage?.concurrencyCap ?? settings?.concurrencyCap ?? '-'}
        </span>
        {usage?.rateLimits.map((w) => (
          <span
            key={w.windowType}
            className={`hud-item ${w.status === 'rejected' ? 'bad' : w.status === 'allowed_warning' ? 'warn' : ''}`}
            title={`Plan window ${w.windowType}${w.resetsAt ? ` resets ${new Date(w.resetsAt * (w.resetsAt < 1e12 ? 1000 : 1)).toLocaleTimeString()}` : ''}`}
          >
            <span className="hud-label">{w.windowType.replace('_', ' ')}</span>{' '}
            {w.utilization !== undefined ? `${Math.round(w.utilization * 100)}%` : w.status}
          </span>
        ))}
      </span>
      <span className="spacer" />
      <button type="button" onClick={() => setSoundEnabled(!soundEnabled)} title="Toggle sounds">
        {soundEnabled ? '🔊' : '🔇'}
      </button>
      <button
        type="button"
        className={killSwitch ? 'primary' : 'danger'}
        onClick={() => void toggleKill()}
      >
        {killSwitch ? 'Reset kill switch' : 'Kill switch'}
      </button>
    </header>
  );
}
