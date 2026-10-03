import type { PermissionRequest } from '@deskhaven/shared';
import { type JSX, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../net/api.js';
import { selectPendingPermissions, useAppStore } from '../state/store.js';

export function PermissionModal(): JSX.Element | null {
  const pending = useAppStore(useShallow(selectPendingPermissions));
  const first = pending[0];
  if (!first) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <PermissionCard request={first} />
        {pending.length > 1 ? (
          <p className="muted small">{pending.length - 1} more waiting</p>
        ) : null}
      </div>
    </div>
  );
}

export function PermissionCard({
  request,
  compact = false,
}: {
  request: PermissionRequest;
  compact?: boolean;
}): JSX.Element {
  const agent = useAppStore((s) => s.agents[request.agentId]);
  const pushNotice = useAppStore((s) => s.pushNotice);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const decide = async (decision: 'allow' | 'allow_session' | 'deny') => {
    setBusy(true);
    try {
      await api.resolvePermission(
        request.id,
        decision,
        decision === 'deny' && reason ? reason : undefined,
      );
    } catch (err) {
      pushNotice('error', String(err instanceof Error ? err.message : err), request.agentId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`perm-card ${compact ? 'compact' : ''}`}>
      <div className="perm-head">
        <span className="hand">✋</span>
        <strong>{agent?.name ?? 'Agent'}</strong> asks permission
      </div>
      <p className="perm-title">{request.title ?? `Use ${request.tool}`}</p>
      {request.description ? <p className="muted small">{request.description}</p> : null}
      <pre className="details">{pretty(request.input)}</pre>
      <div className="row wrap">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void decide('allow')}
        >
          Allow once
        </button>
        {request.hasSuggestions ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide('allow_session')}
            title="Adds the SDK's suggested rule for this session only"
          >
            Allow for this session
          </button>
        ) : null}
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => void decide('deny')}
        >
          Deny
        </button>
      </div>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Optional reason sent back to the agent when denying"
      />
    </div>
  );
}

function pretty(v: unknown): string {
  try {
    const s = JSON.stringify(v, null, 2);
    return s.length > 1500 ? `${s.slice(0, 1500)}\n…` : s;
  } catch {
    return String(v);
  }
}
