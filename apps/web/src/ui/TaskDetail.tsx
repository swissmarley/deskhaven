import type { MergePreview, MergeStrategy, TaskStatus } from '@deskhaven/shared';
import { type JSX, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ApiError, api } from '../net/api.js';
import { useAppStore } from '../state/store.js';
import { fmtTime, fmtUsd } from './eventText.js';
import { manualMergeCommands, showMergeControls } from './merge.js';

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
  const [strategy, setStrategy] = useState<MergeStrategy>('squash');
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [asking, setAsking] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewerId, setReviewerId] = useState('');
  const [reviewPrompt, setReviewPrompt] = useState('');
  const assignee = agents.find((a) => a.id === task?.assigneeAgentId);
  const offerMerge = task ? showMergeControls(task, assignee) : false;
  const revision = task?.updatedAt ?? 0;
  const reviewers = [...agents].sort((a, b) => {
    const rank = (role: string) => (role === 'reviewer' ? 0 : 1);
    return rank(a.rolePresetId) - rank(b.rolePresetId) || a.name.localeCompare(b.name);
  });

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      pushNotice('error', String(err instanceof Error ? err.message : err));
    }
  };

  // revision is intentional: a merge updates the same task id, and the preview should follow.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the saved task changes
  useEffect(() => {
    if (!offerMerge || !taskId) {
      setPreview(null);
      return;
    }
    let cancel = false;
    setPreviewError(null);
    void api
      .mergePreview(taskId)
      .then((p) => {
        if (!cancel) setPreview(p);
      })
      .catch((err: unknown) => {
        if (!cancel)
          setPreviewError(err instanceof Error ? err.message : 'Could not preview the merge');
      });
    return () => {
      cancel = true;
    };
  }, [offerMerge, taskId, revision]);

  if (!task) return null;

  const mergeMessage = `deskhaven: ${task.title.replace(/\s+/g, ' ').trim().slice(0, 200)} (task ${task.id})`;
  const commands = preview ? manualMergeCommands(preview, mergeMessage, strategy) : '';
  const conflicted = task.merge?.status === 'conflict';

  const acceptMerge = async () => {
    setMerging(true);
    try {
      await api.mergeTask(task.id, { strategy });
    } catch (err) {
      pushNotice('error', err instanceof Error ? err.message : String(err));
    } finally {
      setMerging(false);
    }
  };

  const askAgent = async () => {
    setAsking(true);
    try {
      await api.resolveMerge(task.id);
    } catch (err) {
      pushNotice('error', err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  };

  const copyCommands = async () => {
    try {
      await navigator.clipboard.writeText(commands);
      pushNotice('info', 'Git commands copied.');
    } catch (err) {
      pushNotice('error', err instanceof Error ? err.message : String(err));
    }
  };

  const openReview = () => {
    const suggested =
      reviewers.find((a) => a.rolePresetId === 'reviewer' && a.id !== assignee?.id) ??
      reviewers.find((a) => a.id !== assignee?.id);
    setReviewerId(suggested?.id ?? '');
    setReviewPrompt(`Review the work on "${task.title}".\n\nOriginal request:\n${task.prompt}`);
    setReviewOpen(true);
  };

  const requestReview = async () => {
    if (!assignee || !reviewerId) return;
    try {
      await api.createTask({
        title: `Review: ${task.title}`.slice(0, 200),
        prompt: reviewPrompt.trim(),
        assigneeAgentId: reviewerId,
        reviewOfAgentId: assignee.id,
        parentTaskId: task.id,
      });
      setReviewOpen(false);
      pushNotice('info', 'Review task created.');
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      pushNotice('error', message);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal task-detail" role="dialog" aria-modal="true" aria-label={task.title}>
        <div className="panel-head">
          <h3>{task.title}</h3>
          <span>
            <span className={`pill status-${task.status}`}>{task.status.replace('_', ' ')}</span>
            {task.merge?.status === 'merged' && task.merge.commit ? (
              <span className="pill ok">merged {task.merge.commit.slice(0, 7)}</span>
            ) : null}
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
          {task.reviewTarget ? (
            <>
              <dt>Reviewing</dt>
              <dd>
                {task.reviewTarget.agentName}
                {task.reviewTarget.branch ? ` @ ${task.reviewTarget.branch}` : ''}
              </dd>
            </>
          ) : null}
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
        {offerMerge ? (
          <section className={conflicted ? 'merge-box conflict' : 'merge-box'}>
            <h4>Merge</h4>
            <p className="small warn-text">
              The merge includes every change on the agent's branch, not only this task.
            </p>
            {preview ? (
              <p className="mono small">
                {preview.branch} → {preview.targetBranch}
                {' · '}
                {preview.ahead} ahead, {preview.behind} behind
                {preview.dirty ? ' · uncommitted changes will be committed' : ''}
              </p>
            ) : (
              <p className="muted small">{previewError ?? 'Checking the branch…'}</p>
            )}
            {(preview?.files.length ?? 0) > 0 ? (
              <ul className="files">
                {preview?.files.map((f) => (
                  <li key={`${f.status}:${f.path}`} className="mono small">
                    {f.status} {f.path}
                  </li>
                ))}
              </ul>
            ) : null}
            {conflicted ? (
              <div>
                <p className="small">
                  {task.merge?.error ?? 'The merge conflicted. The source checkout was restored.'}
                </p>
                {task.merge?.conflictFiles?.length ? (
                  <ul className="files">
                    {task.merge.conflictFiles.map((f) => (
                      <li key={f} className="mono small">
                        {f}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <div className="row wrap">
              <label className="small">
                Strategy{' '}
                <select
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value === 'merge' ? 'merge' : 'squash')}
                >
                  <option value="squash">Squash (default)</option>
                  <option value="merge">Merge commit (--no-ff)</option>
                </select>
              </label>
              <button
                type="button"
                className="primary"
                disabled={merging || preview?.canMerge === false}
                onClick={() => void acceptMerge()}
              >
                {merging ? 'Merging…' : 'Accept & merge'}
              </button>
              {task.status !== 'done' ? (
                <button
                  type="button"
                  className="link"
                  onClick={() => void run(() => api.updateTask(task.id, { status: 'done' }))}
                >
                  Only mark done
                </button>
              ) : null}
              {conflicted ? (
                <button type="button" disabled={asking} onClick={() => void askAgent()}>
                  {asking ? 'Asking…' : 'Ask agent to resolve'}
                </button>
              ) : null}
              {commands ? (
                <button type="button" onClick={() => void copyCommands()}>
                  Copy git commands
                </button>
              ) : null}
            </div>
            {conflicted && commands ? <pre className="details">{commands}</pre> : null}
          </section>
        ) : null}
        {task.status === 'review' && assignee ? (
          <div className="row wrap">
            <button type="button" onClick={openReview}>
              Request review
            </button>
          </div>
        ) : null}
        {reviewOpen ? (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void requestReview();
            }}
          >
            <label className="small">
              Reviewer{' '}
              <select value={reviewerId} onChange={(e) => setReviewerId(e.target.value)} required>
                <option value="">Choose a reviewer</option>
                {reviewers.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.rolePresetId}
                    {a.rolePresetId === 'reviewer' ? ' (suggested)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <textarea
              rows={4}
              value={reviewPrompt}
              onChange={(e) => setReviewPrompt(e.target.value)}
              required
            />
            <button
              type="submit"
              className="primary"
              disabled={!reviewerId || !reviewPrompt.trim()}
            >
              Create review task
            </button>
          </form>
        ) : null}
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
