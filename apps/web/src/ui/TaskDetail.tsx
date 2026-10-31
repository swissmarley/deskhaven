import {
  defaultMergeMessage,
  type MergePreview,
  type MergeStrategy,
  TaskSchema,
  type TaskStatus,
} from '@deskhaven/shared';
import { type JSX, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ApiError, api } from '../net/api.js';
import { useAppStore } from '../state/store.js';
import { fmtTime, fmtUsd } from './eventText.js';
import {
  manualMergeCommands,
  mergeButtonState,
  nothingToMerge,
  reviewerCanWrite,
  showMergeControls,
} from './merge.js';
import { TaskMarkdown } from './TaskMarkdown.js';

const CONFIRM_TIMEOUT_MS = 60_000;

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
  const [confirming, setConfirming] = useState(false);
  /** The preview changed while a confirmation was open, so it was withdrawn. */
  const [confirmWithdrawn, setConfirmWithdrawn] = useState(false);
  const [allowHookChanges, setAllowHookChanges] = useState(false);
  const [skipHooks, setSkipHooks] = useState(false);
  const [asking, setAsking] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewerId, setReviewerId] = useState('');
  const [reviewPrompt, setReviewPrompt] = useState('');
  const assignee = agents.find((a) => a.id === task?.assigneeAgentId);
  const offerMerge = task ? showMergeControls(task, assignee) : false;
  const revision = task?.updatedAt ?? 0;
  const previewSig = preview
    ? `${preview.branch}:${preview.ahead}:${preview.behind}:${preview.dirty}:${preview.files
        .map((f) => `${f.status}:${f.path}`)
        .join(
          '|',
        )}:${preview.branchSha ?? ''}:${preview.previewTree}:${(preview.hookFiles ?? []).join('|')}:${(preview.runnerFiles ?? []).join('|')}`
    : 'none';
  const previewKey = `${taskId}:${strategy}:${previewSig}`;
  const confirmKey = `${previewKey}:${allowHookChanges}:${skipHooks}`;
  const previewKeyRef = useRef(previewKey);
  if (previewKeyRef.current !== previewKey) {
    previewKeyRef.current = previewKey;
    setAllowHookChanges(false);
    setSkipHooks(false);
    if (confirming) {
      setConfirming(false);
      setConfirmWithdrawn(true);
    }
  }
  const confirmKeyRef = useRef(confirmKey);
  if (confirmKeyRef.current !== confirmKey) {
    confirmKeyRef.current = confirmKey;
    if (confirming) {
      setConfirming(false);
      setConfirmWithdrawn(true);
    }
  }
  const hookConsentRequired = (preview?.hookFiles?.length ?? 0) > 0;
  const hookConsentOk = !hookConsentRequired || allowHookChanges || skipHooks;
  const reviewers = agents
    .filter((a) => a.id !== assignee?.id)
    .sort((a, b) => {
      const rank = (role: string) => (role === 'reviewer' ? 0 : 1);
      return rank(a.rolePresetId) - rank(b.rolePresetId) || a.name.localeCompare(b.name);
    });
  const chosenReviewer = reviewers.find((a) => a.id === reviewerId);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      pushNotice('error', String(err instanceof Error ? err.message : err));
    }
  };

  // An open confirmation expires after a minute; confirmKey restarts the timer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: confirmKey is intentional
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), CONFIRM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [confirming, confirmKey]);

  const mergeSectionRef = useRef<HTMLElement | null>(null);

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

  const assigneeMissing = Boolean(task.assigneeAgentId && !assignee);

  const mergeMessage = defaultMergeMessage(task);
  const commands = preview ? manualMergeCommands(preview, mergeMessage, strategy) : '';
  const conflicted = task.merge?.status === 'conflict';
  const empty = nothingToMerge(preview);
  const button = mergeButtonState(preview, { merging, hookConsentOk, previewError });

  const acceptMerge = async () => {
    setMerging(true);
    try {
      if (!preview?.branchSha) {
        pushNotice('error', 'Merge preview is not ready. Try again in a moment.');
        return;
      }
      await api.mergeTask(task.id, {
        strategy,
        expectedBranchSha: preview.branchSha,
        consentedHookFiles: preview.hookFiles ?? [],
        previewTree: preview.previewTree,
        ...(allowHookChanges ? { allowHookChanges: true } : {}),
        ...(skipHooks ? { skipHooks: true } : {}),
      });
    } catch (err) {
      if (err instanceof ApiError) {
        const parsed = TaskSchema.safeParse(err.body.task);
        if (parsed.success) {
          useAppStore.setState((s) => ({ tasks: { ...s.tasks, [parsed.data.id]: parsed.data } }));
        }
      }
      pushNotice('error', err instanceof Error ? err.message : String(err));
    } finally {
      setMerging(false);
      setConfirming(false);
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

  const openInspector = () => {
    if (!assignee) return;
    selectAgent(assignee.id);
    onClose();
  };

  return (
    <div className="modal-backdrop">
      <div className="modal task-detail" role="dialog" aria-modal="true" aria-label={task.title}>
        <div className="task-detail-scroll">
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
            <dd className="assignee-row">
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
                <option value="">— Unassign (back to backlog) —</option>
                {assigneeMissing && task.assigneeAgentId ? (
                  <option value={task.assigneeAgentId}>Unknown agent</option>
                ) : null}
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.rolePresetId}
                  </option>
                ))}
              </select>
              {assignee ? (
                <button type="button" className="link" onClick={openInspector}>
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
          {offerMerge && empty && !conflicted ? (
            <section className="merge-box empty" ref={mergeSectionRef}>
              <h4>Merge</h4>
              <p className="small">
                <strong>Nothing to merge.</strong>{' '}
                <span className="muted">
                  {preview?.branch} has no commits ahead of {preview?.targetBranch} and no
                  uncommitted changes. The branch is shared by all of this agent's tasks: if another
                  of them was merged, this task's changes went in with it.
                </span>
              </p>
              {task.status !== 'done' ? (
                <div className="row wrap">
                  <button
                    type="button"
                    onClick={() => void run(() => api.updateTask(task.id, { status: 'done' }))}
                  >
                    Mark done
                  </button>
                </div>
              ) : null}
            </section>
          ) : offerMerge ? (
            <section
              className={conflicted ? 'merge-box conflict' : 'merge-box'}
              ref={mergeSectionRef}
            >
              <h4>Merge</h4>
              <p className="small warn-text">
                The merge includes every change on the agent's branch, not only this task.
              </p>
              {preview?.hooksWarning ? (
                <p className="small warn-text">{preview.hooksWarning}</p>
              ) : null}
              {preview?.runnerWarning ? (
                <p className="small warn-text">{preview.runnerWarning}</p>
              ) : null}
              {hookConsentRequired ? (
                <label className="small row wrap">
                  <input
                    type="checkbox"
                    checked={allowHookChanges}
                    onChange={(e) => setAllowHookChanges(e.target.checked)}
                  />
                  I reviewed the hook changes and allow them to run on the merge commit
                </label>
              ) : null}
              {hookConsentRequired || preview?.runnerWarning ? (
                <label className="small row wrap">
                  <input
                    type="checkbox"
                    checked={skipHooks}
                    onChange={(e) => setSkipHooks(e.target.checked)}
                  />
                  Merge without running git hooks on my source checkout
                </label>
              ) : null}
              {preview && !hookConsentOk ? (
                <p className="small warn-text">
                  Tick one of the options above to enable the merge.
                </p>
              ) : null}
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
              {confirming && preview ? (
                <div className="merge-confirm" role="alertdialog" aria-label="Confirm merge">
                  <p className="small">
                    Merge {preview.ahead} commit{preview.ahead === 1 ? '' : 's'}
                    {preview.dirty ? ' plus the uncommitted changes' : ''} ({preview.files.length}{' '}
                    file{preview.files.length === 1 ? '' : 's'}) from{' '}
                    <span className="mono">{preview.branch}</span> into{' '}
                    <span className="mono">{preview.targetBranch}</span> as a{' '}
                    {strategy === 'squash' ? 'squash commit' : 'merge commit'}?
                  </p>
                  <div className="row wrap">
                    <button
                      type="button"
                      className="primary"
                      disabled={merging}
                      onClick={() => void acceptMerge()}
                    >
                      {merging ? 'Merging…' : 'Confirm merge'}
                    </button>
                    <button
                      type="button"
                      className="link"
                      disabled={merging}
                      onClick={() => setConfirming(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              {confirmWithdrawn && !confirming ? (
                <p className="small warn-text">
                  The branch changed while the confirmation was open. Review the preview and merge
                  again.
                </p>
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
                {!confirming ? (
                  <button
                    type="button"
                    className="primary"
                    disabled={button.disabled}
                    title={button.reason ?? undefined}
                    onClick={() => {
                      setConfirmWithdrawn(false);
                      setConfirming(true);
                    }}
                  >
                    {merging ? 'Merging…' : 'Accept & merge'}
                  </button>
                ) : null}
                {button.disabled && button.reason && preview ? (
                  <span className="muted small">{button.reason}</span>
                ) : null}
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
          <h4>Prompt</h4>
          <pre className="details">{task.prompt}</pre>
          <h4>Result</h4>
          {task.resultSummary ? (
            <TaskMarkdown content={task.resultSummary} />
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
              {reviewerCanWrite(chosenReviewer) ? (
                <p className="small warn-text">
                  This agent can edit or run tools. The review still cannot write the engineer
                  checkout, but a read-only reviewer is the usual choice.
                </p>
              ) : null}
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
        </div>
        <div className="task-detail-actions row wrap">
          {offerMerge && !empty ? (
            <button
              type="button"
              onClick={() =>
                mergeSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            >
              Go to merge
            </button>
          ) : null}
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
            className="task-detail-reply row"
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
