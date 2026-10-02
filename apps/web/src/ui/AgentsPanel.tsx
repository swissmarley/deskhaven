import { type JSX, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { selectAgentList, useAppStore } from '../state/store.js';
import { AgentForm } from './AgentForm.js';
import { AvatarPreview } from './AvatarPicker.js';
import { fmtUsd } from './eventText.js';

export function AgentsPanel(): JSX.Element {
  const agents = useAppStore(useShallow(selectAgentList));
  const connection = useAppStore((s) => s.connection);
  const selectAgent = useAppStore((s) => s.selectAgent);
  const [creating, setCreating] = useState(false);

  // Open the hire form automatically when the office is empty.
  useEffect(() => {
    if (connection === 'open' && agents.length === 0) setCreating(true);
  }, [connection, agents.length]);

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>HR desk</h3>
        <button type="button" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Close' : 'New agent'}
        </button>
      </div>
      {creating ? <AgentForm onDone={() => setCreating(false)} /> : null}
      <ul className="agent-list">
        {agents.map((a) => (
          <li key={a.id}>
            <button type="button" className="agent-row" onClick={() => selectAgent(a.id)}>
              <AvatarPreview avatar={a.avatar} size={28} />
              <span className="agent-name">{a.name}</span>
              <span className="muted">{a.rolePresetId}</span>
              <span className={`pill status-${a.status}`}>{a.status.replace('_', ' ')}</span>
              <span className="muted">{fmtUsd(a.usage.costUsd)}</span>
            </button>
          </li>
        ))}
        {agents.length === 0 ? <li className="muted">No agents yet. Hire one above.</li> : null}
      </ul>
    </div>
  );
}
