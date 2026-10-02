import type { TaskStatus } from '@agenthotel/shared';
import { type JSX, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../net/api.js';
import { useAppStore } from '../state/store.js';
import { fmtTime, fmtUsd } from './eventText.js';

export function TaskDetail({
  taskId,
  onClose,
}: {
  taskId: string;
  onClose: () => void;
}): JSX.Element | null {
  const task = useAppStore((s) => s.tasks[taskId]);
  const agents = useAppStore(useShallow((s) => Object.values(s.agents)));
  const pushNotice = useAppStore((s) => s.pushNotice);
  const selectAgent = useAppStore((s) => s.selectAgent);
  const [reply, setReply] = useState('');
  if (!task) return null;
  const assignee = agents.find((a) => a.id === task.assigneeAgentId);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      pushNotice('error', String(err instanceof Error ? err.message : err));
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal task-detail" role="dialog" aria-modal="true" aria-label={task.title}>
        <div className="panel-head">
          <h3>{task.title}</h3>
          <span>
            <span className={`pill status-${task.status}`}>{task.status.replace('_', ' ')}</span>
            <button type="button" className="link" onClick={onClose}>
              close
            </button>
          </span>
        </div>
        <dl className="kv">
          <dt>Assignee</dt>
          <dd>
            <select
              value={task.assigneeAgentId ?? ''}
              onChange={(e) =>
                void run(() =>
                  e.target.value
                    ? api.assignTask(task.id, e.target.value)
                    : api.updateTask(task.id, { assigneeAgentId: null, status: 'backlog' }),
                )
              }
            >
              <option value="">unassigned</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.rolePresetId}
                </option>
              ))}
            </select>
            {assignee ? (
              <button type="button" className="link" onClick={() => selectAgent(assignee.id)}>
                open inspector
              </button>
            ) : null}
          </dd>
          <dt>Cost</dt>
          <dd>{fmtUsd(task.costUsd)}</dd>
          <dt>Created</dt>
          <dd>
            {fmtTime(task.createdAt)}
            {task.completedAt ? ` · done ${fmtTime(task.completedAt)}` : ''}
          </dd>
        </dl>
        <h4>Prompt</h4>
        <pre className="details">{task.prompt}</pre>
        <h4>Result</h4>
        {task.resultSummary ? (
          <pre className="details">{task.resultSummary}</pre>
        ) : (
          <p className="muted small">No result yet.</p>
        )}
        <h4>Files changed</h4>
        {task.filesChanged.length ? (
          <ul className="files">
            {task.filesChanged.map((f) => (
              <li key={f.path} className="mono small">
                {f.path}
                {f.additions !== undefined || f.deletions !== undefined ? (
                  <span className="muted">
                    {' '}
                    +{f.additions ?? 0} −{f.deletions ?? 0}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">None recorded.</p>
        )}
        <div className="row wrap">
          {(['backlog', 'review', 'done'] as TaskStatus[]).map((s) => (
            <button
              type="button"
              key={s}
              disabled={task.status === s}
              onClick={() => void run(() => api.updateTask(task.id, { status: s }))}
            >
              Move to {s.replace('_', ' ')}
            </button>
          ))}
          <button
            type="button"
            className="danger"
            onClick={() =>
              void run(async () => {
                await api.deleteTask(task.id);
                onClose();
              })
            }
          >
            Delete
          </button>
        </div>
        {assignee ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!reply.trim()) return;
              void run(async () => {
                await api.nudgeTask(task.id, reply.trim());
                setReply('');
              });
            }}
          >
            <input
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder={`Reply to ${assignee.name} about this task…`}
            />
            <button type="submit" className="primary" disabled={!reply.trim()}>
              Send
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
