import { type JSX, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { selectAgentList, useAppStore } from '../state/store.js';
import { AgentForm } from './AgentForm.js';
import { AvatarPreview } from './AvatarPicker.js';
import { fmtUsd } from './eventText.js';
import { firedAgentsToday } from './usageMath.js';

export function AgentsPanel(): JSX.Element {
  const agents = useAppStore(useShallow(selectAgentList));
  const connection = useAppStore((s) => s.connection);
  const usage = useAppStore((s) => s.usage);
  const selectAgent = useAppStore((s) => s.selectAgent);
  const [creating, setCreating] = useState(false);
  /** The form was opened for an empty office, not by the user. */
  const autoOpened = useRef(false);
  // The agent list is known only after the server's hello (which also carries the usage snapshot).
  const synced = connection === 'open' && usage !== null;

  // Open the hire form automatically when the office is empty, and close it again if agents arrive.
  useEffect(() => {
    if (!synced) return;
    if (agents.length === 0 && !creating) {
      autoOpened.current = true;
      setCreating(true);
    } else if (agents.length > 0 && autoOpened.current) {
      autoOpened.current = false;
      setCreating(false);
    }
  }, [synced, agents.length, creating]);

  const fired = firedAgentsToday(usage);

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>HR desk</h3>
        <button
          type="button"
          className={creating ? undefined : 'primary'}
          onClick={() => {
            autoOpened.current = false;
            setCreating((v) => !v);
          }}
        >
          {creating ? 'Close' : 'New agent'}
        </button>
      </div>
      {creating ? (
        <AgentForm
          onDone={() => {
            autoOpened.current = false;
            setCreating(false);
          }}
        />
      ) : null}
      <ul className="agent-list">
        {agents.map((a) => (
          <li key={a.id}>
            <button type="button" className="agent-row" onClick={() => selectAgent(a.id)}>
              <AvatarPreview avatar={a.avatar} size={28} />
              <span className="agent-name">{a.name}</span>
              <span className="muted">{a.rolePresetId}</span>
              <span className={`pill status-${a.status}`}>{a.status.replace('_', ' ')}</span>
              <span
                className="muted nowrap"
                title={`Estimated cost today (all time: ${fmtUsd(a.usage.costUsd)})`}
              >
                {fmtUsd(usage?.perAgentToday?.[a.id]?.costUsd ?? 0)}
              </span>
            </button>
          </li>
        ))}
        {agents.length === 0 ? <li className="muted">No agents yet. Hire one above.</li> : null}
        {fired > 0 ? (
          <li className="muted small" title="Their spend stays in the office totals">
            Agents no longer on staff: {fmtUsd(fired)} today
          </li>
        ) : null}
      </ul>
    </div>
  );
}
