import { type AgentEvent, agentCwd, WORKDIR_ERROR_PREFIX } from '@deskhaven/shared';
import { type JSX, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../net/api.js';
import { selectPendingPermissions, useAppStore } from '../state/store.js';
import { AgentForm } from './AgentForm.js';
import { AvatarPreview } from './AvatarPicker.js';
import { describeEvent, fmtTime, fmtTokens, fmtUsd } from './eventText.js';
import { PermissionCard } from './PermissionModal.js';

const EMPTY: AgentEvent[] = [];

export function InspectorPanel(): JSX.Element {
  const id = useAppStore((s) => s.selectedAgentId);
  const agent = useAppStore((s) => (id ? s.agents[id] : undefined));
  const transcript = useAppStore((s) => (id ? s.transcripts[id] : undefined)) ?? EMPTY;
  const liveText = useAppStore((s) => (id ? (s.liveText[id] ?? '') : ''));
  const behavior = useAppStore((s) => (id ? s.behaviors[id] : undefined));
  const task = useAppStore((s) =>
    agent?.currentTaskId ? s.tasks[agent.currentTaskId] : undefined,
  );
  const pending = useAppStore(
    useShallow((s) => selectPendingPermissions(s).filter((p) => p.agentId === id)),
  );
  const pushNotice = useAppStore((s) => s.pushNotice);
  const selectAgent = useAppStore((s) => s.selectAgent);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);

  if (!agent || !id)
    return <p className="muted">Click an avatar or pick an agent from the HR desk.</p>;

  const act = async (action: 'start' | 'stop' | 'pause' | 'resume' | 'interrupt') => {
    try {
      await api.agentAction(id, action);
    } catch (err) {
      pushNotice('error', String(err instanceof Error ? err.message : err), id);
    }
  };
  const send = async () => {
    if (!text.trim()) return;
    try {
      await api.message(id, text.trim());
      setText('');
    } catch (err) {
      pushNotice('error', String(err instanceof Error ? err.message : err), id);
    }
  };
  const remove = async () => {
    if (!confirm(`Fire ${agent.name}? The session transcript stays on disk.`)) return;
    try {
      await api.deleteAgent(id);
      selectAgent(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        /uncommitted/.test(message) &&
        confirm(`${message}\n\nRemove the worktree anyway and lose those changes?`)
      ) {
        try {
          await api.deleteAgent(id, true);
          selectAgent(null);
          return;
        } catch (err2) {
          pushNotice('error', String(err2 instanceof Error ? err2.message : err2), id);
          return;
        }
      }
      pushNotice('error', message, id);
    }
  };

  return (
    <div className="panel inspector">
      <div className="panel-head">
        <h3>
          <AvatarPreview avatar={agent.avatar} size={32} /> {agent.name}
        </h3>
        <span>
          <span className={`pill status-${agent.status}`}>{agent.status.replace('_', ' ')}</span>
          <button type="button" className="link" onClick={() => setEditing((v) => !v)}>
            {editing ? 'close' : 'edit'}
          </button>
        </span>
      </div>
      {editing ? <AgentForm agent={agent} onDone={() => setEditing(false)} /> : null}
      <dl className="kv">
        <dt>Role</dt>
        <dd>{agent.rolePresetId}</dd>
        <dt>Model</dt>
        <dd>{agent.model}</dd>
        <dt>Doing</dt>
        <dd>{behavior ? behaviorLabel(behavior) : '-'}</dd>
        <dt>Task</dt>
        <dd>{task ? task.title : agent.currentTaskId ? agent.currentTaskId : 'none'}</dd>
        <dt>Cost</dt>
        <dd>
          {fmtUsd(agent.usage.costUsd)} · {fmtTokens(agent.usage.inputTokens)} in /{' '}
          {fmtTokens(agent.usage.outputTokens)} out · {agent.usage.turns} turns
        </dd>
        <dt>Workdir</dt>
        <dd className="mono small">{agentCwd(agent)}</dd>
        <dt>Session</dt>
        <dd className="mono small">
          {agent.sessionId ? `${agent.sessionId.slice(0, 8)}… (resumable)` : 'none yet'}
        </dd>
        {agent.lastError ? (
          <>
            <dt>Error</dt>
            <dd className="error">
              {agent.lastError}
              {agent.lastError.startsWith(WORKDIR_ERROR_PREFIX) && !agent.worktree && !editing ? (
                <>
                  {' '}
                  <button type="button" className="link" onClick={() => setEditing(true)}>
                    Change working directory
                  </button>
                </>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>
      <div className="row wrap">
        {agent.status === 'stopped' || agent.status === 'error' ? (
          <button type="button" className="primary" onClick={() => void act('start')}>
            Start
          </button>
        ) : (
          <button type="button" onClick={() => void act('stop')}>
            Stop
          </button>
        )}
        {agent.status === 'paused' ? (
          <button type="button" onClick={() => void act('resume')}>
            Resume
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void act('pause')}
            disabled={agent.status === 'stopped'}
          >
            Pause
          </button>
        )}
        <button
          type="button"
          onClick={() => void act('interrupt')}
          disabled={agent.status !== 'working' && agent.status !== 'needs_input'}
        >
          Interrupt
        </button>
        <button type="button" className="danger" onClick={() => void remove()}>
          Fire
        </button>
      </div>
      {pending.map((p) => (
        <PermissionCard key={p.id} request={p} compact />
      ))}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Message ${agent.name}…`}
        />
        <button type="submit" className="primary" disabled={!text.trim()}>
          Send
        </button>
      </form>
      <h4>Transcript</h4>
      <div className="transcript">
        {transcript.map((e) => (
          <TranscriptItem key={e.id} event={e} />
        ))}
        {liveText ? (
          <div className="t-item live">
            <span className="t-icon">…</span>
            <span className="t-text">{liveText}</span>
          </div>
        ) : null}
        {transcript.length === 0 && !liveText ? (
          <p className="muted">Nothing yet. Send a message or assign a task.</p>
        ) : null}
      </div>
    </div>
  );
}

function TranscriptItem({ event }: { event: AgentEvent }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const d = describeEvent(event);
  if (!d.text) return null;
  const details =
    event.type === 'tool_finished'
      ? event.diffs?.length
        ? event.diffs.map((x) => x.patch).join('\n')
        : event.output
      : event.type === 'tool_started'
        ? safeJson(event.input)
        : event.type === 'turn_completed'
          ? event.result
          : undefined;
  return (
    <div className={`t-item tone-${d.tone}`}>
      <span className="t-time">{fmtTime(event.ts)}</span>
      <span className="t-icon">{d.icon}</span>
      <span className="t-text">
        {d.text}
        {details ? (
          <button type="button" className="link" onClick={() => setOpen((v) => !v)}>
            {open ? 'hide' : 'details'}
          </button>
        ) : null}
        {open && details ? <pre className="details">{details}</pre> : null}
      </span>
    </div>
  );
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function behaviorLabel(b: { kind: string } & Record<string, unknown>): string {
  switch (b.kind) {
    case 'idle':
      return `idle (${String(b.variant)})`;
    case 'reading':
      return `reading ${String(b.label)}`;
    case 'typing':
      return `editing ${String(b.label)}`;
    case 'terminal':
      return `running ${String(b.command)}`;
    case 'browsing':
      return `browsing ${String(b.query)}`;
    case 'raise_hand':
      return `needs you (${String(b.reason)})`;
    case 'sweat':
      return `trouble (${String(b.reason)})`;
    default:
      return b.kind;
  }
}
