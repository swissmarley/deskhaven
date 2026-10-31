import fs from 'node:fs';
import {
  type Agent,
  type AgentEvent,
  agentCwd,
  type CreateTask,
  defaultMergeMessage,
  type MergePreview,
  type MergeStrategy,
  type MergeTask,
  newId,
  type PresetLookup,
  type ReviewTarget,
  type Task,
  TaskSchema,
  type TaskStatus,
  taskTail,
  truncate,
  type UpdateTask,
} from '@deskhaven/shared';
import { eq } from 'drizzle-orm';
import type { AgentManager } from '../agent/manager.js';
import type { AgentService } from '../agents/service.js';
import type { Db } from '../db/client.js';
import { tasks as tasksTable } from '../db/schema.js';
import type { EventStore } from '../events/store.js';
import { hookFileSetsEqual } from '../worktree/hook-detect.js';
import { WorktreeMovedError, type WorktreeService } from '../worktree/service.js';
import type { WsHub } from '../ws/hub.js';

/** Review diffs longer than this are cut, and the prompt says so. */
export const REVIEW_DIFF_LIMIT = 60_000;

export class TaskHttpError extends Error {
  override readonly name = 'TaskHttpError';
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface TaskDeps {
  manager: AgentManager;
  agents: AgentService;
  events: EventStore;
  worktrees: WorktreeService;
  broker?: { pendingForAgent(agentId: string): unknown[] };
  /** DB-backed presets (custom manager roles). Falls back to shipped JSON in tests. */
  presetLookup?: PresetLookup;
  log: { warn(obj: unknown, msg?: string): void };
}

/**
 * The task board. Assigning a task sends its prompt into the agent's session; events tagged with the
 * task id move it across the columns and fill in result, files changed and cost. Merging a worktree
 * branch and pointing a reviewer at another agent's checkout live here too.
 */
export class TaskService {
  /** Last assistant text seen per task, used as the result summary when the turn completes. */
  private readonly lastText = new Map<string, string>();
  /** Agents whose branch merge is in progress. Checked by agentBusy so other work waits. */
  private readonly merging = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly hub: WsHub,
    private readonly deps: TaskDeps,
  ) {}

  list(): Task[] {
    return this.db
      .select()
      .from(tasksTable)
      .all()
      .map((r) => TaskSchema.parse(JSON.parse(r.json)))
      .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  }

  get(id: string): Task | undefined {
    const row = this.db.select().from(tasksTable).where(eq(tasksTable.id, id)).get();
    return row ? TaskSchema.parse(JSON.parse(row.json)) : undefined;
  }

  async create(input: CreateTask): Promise<Task> {
    if (!input.title.trim()) throw new Error('Title must not be empty');
    const now = Date.now();
    const position = Math.max(0, ...this.list().map((t) => t.position)) + 1;
    const id = newId();
    if (
      input.assigneeAgentId &&
      input.reviewOfAgentId &&
      input.assigneeAgentId === input.reviewOfAgentId
    ) {
      throw new TaskHttpError(
        400,
        'self_review',
        'An agent cannot review its own worktree. Pick a different reviewer.',
      );
    }
    const reviewTarget =
      input.reviewOfAgentId || input.reviewOfTaskId ? await this.recordReviewTarget(input) : null;
    if (input.assigneeAgentId && reviewTarget) {
      this.assertReviewSubjectReady(reviewTarget.agentId);
    }
    const task: Task = TaskSchema.parse({
      id,
      title: input.title.trim(),
      prompt: input.prompt,
      status: 'backlog',
      assigneeAgentId: null,
      parentTaskId: input.parentTaskId ?? null,
      resultSummary: null,
      filesChanged: [],
      costUsd: 0,
      position,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
      merge: null,
      reviewTarget,
    });
    this.write(task);
    if (input.assigneeAgentId) return this.assign(task.id, input.assigneeAgentId);
    return task;
  }

  async update(id: string, patch: UpdateTask): Promise<Task> {
    const current = this.mustGet(id);
    if (
      patch.assigneeAgentId !== undefined &&
      patch.assigneeAgentId &&
      patch.assigneeAgentId !== current.assigneeAgentId &&
      !this.deps.agents.get(patch.assigneeAgentId)
    ) {
      throw new Error(`Unknown agent ${patch.assigneeAgentId}`);
    }
    const next: Task = TaskSchema.parse({
      ...current,
      ...stripUndefined(patch),
      updatedAt: Date.now(),
    });
    if (
      patch.assigneeAgentId !== undefined &&
      patch.assigneeAgentId !== current.assigneeAgentId &&
      patch.assigneeAgentId
    ) {
      const pending: Task = TaskSchema.parse({
        ...next,
        assigneeAgentId: current.assigneeAgentId,
        status: current.status,
        startedAt: current.startedAt,
        updatedAt: Date.now(),
      });
      this.write(pending);
      return this.assign(id, patch.assigneeAgentId);
    }
    if (patch.status === 'done' && !next.completedAt) next.completedAt = Date.now();
    this.write(next);
    return next;
  }

  remove(id: string): void {
    this.db.delete(tasksTable).where(eq(tasksTable.id, id)).run();
    this.lastText.delete(id);
    this.hub.broadcast({ type: 'task_removed', taskId: id });
  }

  /** Assign and dispatch: the prompt goes to the agent's session tagged with the task id. */
  async assign(taskId: string, agentId: string): Promise<Task> {
    const task = this.mustGet(taskId);
    const agent = this.deps.agents.get(agentId);
    if (!agent) throw new Error(`Unknown agent ${agentId}`);
    if (task.reviewTarget?.agentId === agentId) {
      throw new TaskHttpError(
        400,
        'self_review',
        'An agent cannot review its own worktree. Pick a different reviewer.',
      );
    }
    const rollback = {
      assigneeAgentId: task.assigneeAgentId,
      status: task.status,
      startedAt: task.startedAt,
    };
    const dispatchSeq = (task.dispatchSeq ?? 0) + 1;
    const assigned: Task = {
      ...task,
      assigneeAgentId: agentId,
      status: 'assigned',
      startedAt: task.startedAt ?? Date.now(),
      dispatchSeq,
      updatedAt: Date.now(),
    };
    this.write(assigned);
    try {
      await this.dispatch(assigned, dispatchSeq);
      this.deps.events.append({
        id: newId(),
        ts: Date.now(),
        agentId,
        taskId,
        type: 'task_assigned',
        title: task.title,
      });
    } catch (err) {
      if (err instanceof TaskHttpError) {
        if (err.code === 'assign_superseded') {
          const now = this.mustGet(taskId);
          if (now.assigneeAgentId !== agentId) return now;
          throw err;
        }
        const now = this.mustGet(taskId);
        if (
          now.assigneeAgentId === agentId &&
          now.status === 'assigned' &&
          now.dispatchSeq === dispatchSeq
        ) {
          this.write({
            ...now,
            ...rollback,
            updatedAt: Date.now(),
          });
        }
        throw err;
      }
      // Budget cap or kill switch: keep the assignment but ask a human.
      const now = this.mustGet(taskId);
      if (now.dispatchSeq !== dispatchSeq) return now;
      const message = err instanceof Error ? err.message : String(err);
      this.write({
        ...now,
        status: 'needs_input',
        resultSummary: message,
        updatedAt: Date.now(),
      });
      this.deps.events.append({
        id: newId(),
        ts: Date.now(),
        agentId,
        taskId,
        type: 'notification',
        kind: 'budget',
        message,
      });
    }
    return this.mustGet(taskId);
  }

  /**
   * After a server restart no agent process is alive. Tasks that were merely queued are dispatched
   * again (their prompt never reached a model turn); tasks that were mid-turn need a human nudge, since
   * the resumed session already holds their context.
   */
  reconcileOnBoot(): void {
    for (const t of this.list()) {
      if (!t.assigneeAgentId) continue;
      if (t.status === 'assigned') {
        void this.redispatch(t).catch((err) => {
          this.deps.log.warn(
            { taskId: t.id, err: String(err) },
            'could not re-dispatch task after restart',
          );
        });
      } else if (t.status === 'in_progress' || t.status === 'needs_input') {
        this.write({
          ...t,
          status: 'needs_input',
          resultSummary: `${t.resultSummary ? `${t.resultSummary}\n\n` : ''}[Interrupted by a server restart at ${new Date().toLocaleTimeString()}. Reply to the agent to continue.]`,
          updatedAt: Date.now(),
        });
      }
    }
  }

  /** Re-send the task prompt (after a fix, or when the agent asked for input and the user replied). */
  nudge(taskId: string, text: string): void {
    const task = this.mustGet(taskId);
    if (!task.assigneeAgentId) throw new Error('Task has no assignee');
    if (this.merging.has(task.assigneeAgentId)) {
      throw new TaskHttpError(
        409,
        'agent_busy',
        'The agent is merging a branch. Wait until that finishes.',
      );
    }
    this.setStatus(task, 'in_progress');
    this.syncReadDirs(task.assigneeAgentId);
    this.deps.manager.sendPrompt(task.assigneeAgentId, text, taskId);
  }

  async mergePreview(taskId: string): Promise<MergePreview> {
    const located = await this.locateWorktree(taskId);
    if (!located.ok) throw located.error;
    const { agent, sourceRoot, targetBranch } = located;
    const wt = agent.worktree;
    if (!wt) throw new TaskHttpError(400, 'no_worktree', 'no worktree');
    const st = await this.deps.worktrees.status(wt, targetBranch);
    const branchSha = await this.deps.worktrees.headSha(wt.path);
    const hookCheck = await this.deps.worktrees.hookConsentSnapshot(
      sourceRoot,
      wt.path,
      targetBranch,
      branchSha,
    );
    if (!hookCheck.ok) {
      throw new TaskHttpError(409, 'hooks_verify_failed', hookCheck.message);
    }
    const hookFiles = hookCheck.files;
    const runnerFiles = hookCheck.runnerFiles ?? [];
    const hooksWarning =
      hookFiles.length > 0
        ? `This merge changes git hook scripts (${hookFiles.join(', ')}). Check the box below if you reviewed them and want them to run on the merge commit, or choose merge without hooks.`
        : undefined;
    const runnerWarning =
      runnerFiles.length > 0
        ? `This merge also changes hook runner config (${runnerFiles.join(', ')}). Unchanged hook scripts may still run new commands from those files during the merge commit.`
        : undefined;
    const previewTree = await this.deps.worktrees.previewTree(wt.path);
    const owner = this.worktreeOwner(agent.id);
    const ownedElsewhere = owner && owner.id !== taskId ? owner : null;
    const task = this.mustGet(taskId);
    // A finished task must not close another task's work: offer the merge on the task that made it.
    const blockedByOwner = Boolean(
      ownedElsewhere && task.status === 'done' && (st.dirty || st.ahead > 0),
    );
    return {
      branch: wt.branch,
      targetBranch,
      sourceRoot,
      worktreePath: wt.path,
      ahead: st.ahead,
      behind: st.behind,
      dirty: st.dirty,
      files: st.files,
      canMerge: st.canMerge && !blockedByOwner,
      ...(blockedByOwner && ownedElsewhere
        ? { reason: `The changes on the branch belong to "${ownedElsewhere.title}"` }
        : st.reason
          ? { reason: st.reason }
          : {}),
      ...(ownedElsewhere
        ? {
            ownerTask: {
              id: ownedElsewhere.id,
              title: ownedElsewhere.title,
              status: ownedElsewhere.status,
            },
          }
        : {}),
      ...(hookFiles.length ? { hookFiles } : {}),
      ...(hooksWarning ? { hooksWarning } : {}),
      ...(runnerFiles.length ? { runnerFiles } : {}),
      ...(runnerWarning ? { runnerWarning } : {}),
      branchSha,
      previewTree,
    };
  }

  /**
   * Commit the agent worktree and merge it into the source checkout. The source checkout is never
   * switched or stashed; a conflict aborts and leaves it as it was.
   */
  async merge(taskId: string, input: MergeTask): Promise<Task> {
    const located = await this.locateWorktree(taskId);
    if (!located.ok) throw located.error;
    const { task, agent, sourceRoot, targetBranch } = located;
    const wt = agent.worktree;
    if (!wt) throw new TaskHttpError(400, 'no_worktree', 'This agent has no worktree.');
    const busy = this.agentBusy(agent.id);
    if (busy) throw new TaskHttpError(409, 'agent_busy', busy);
    if (task.status !== 'review' && task.status !== 'done') {
      throw new TaskHttpError(
        409,
        'not_ready',
        'Move the task to review or done before merging its branch.',
      );
    }
    const owner = task.status === 'done' ? this.worktreeOwner(agent.id) : null;
    if (owner && owner.id !== task.id) {
      throw new TaskHttpError(
        409,
        'changes_belong_to_other_task',
        `The changes on ${wt.branch} belong to "${owner.title}", which ran after this task. Merge them from that task.`,
      );
    }
    const strategy: MergeStrategy = input.strategy ?? 'squash';
    const message = input.message?.trim() || defaultMergeMessage(task);
    if (this.merging.has(agent.id)) {
      throw new TaskHttpError(
        409,
        'agent_busy',
        'The agent is merging a branch. Wait until that finishes.',
      );
    }
    this.merging.add(agent.id);
    try {
      const saved = await this.deps.worktrees.withSourceLock(sourceRoot, async () => {
        try {
          return await this.mergeLocked(
            taskId,
            agent,
            wt,
            sourceRoot,
            targetBranch,
            strategy,
            message,
            input,
          );
        } finally {
          // Clear before the lock is released so a snapshot waiting on it does not see a stale flag.
          this.merging.delete(agent.id);
        }
      });
      void this.redispatchAssigned(agent.id).catch((err) => {
        this.deps.log.warn(
          { agentId: agent.id, err: String(err) },
          'could not re-dispatch after merge',
        );
      });
      return saved;
    } catch (err) {
      this.merging.delete(agent.id);
      void this.redispatchAssigned(agent.id).catch((redispatchErr) => {
        this.deps.log.warn(
          { agentId: agent.id, err: String(redispatchErr) },
          'could not re-dispatch after merge',
        );
      });
      throw err;
    }
  }

  private async mergeLocked(
    taskId: string,
    agent: Agent,
    wt: NonNullable<Agent['worktree']>,
    sourceRoot: string,
    targetBranch: string,
    strategy: MergeStrategy,
    message: string,
    input: MergeTask,
  ): Promise<Task> {
    const busyNow = this.runtimeBusy(agent.id);
    if (busyNow) throw new TaskHttpError(409, 'agent_busy', busyNow);
    await this.assertMergeConsent(wt, sourceRoot, targetBranch, input);
    try {
      await this.deps.worktrees.commitAll(wt, message);
    } catch (err) {
      if (err instanceof WorktreeMovedError) {
        throw new TaskHttpError(409, 'worktree_moved', err.message);
      }
      throw err;
    }
    const treeAfterCommit = await this.deps.worktrees.headTree(wt.path);
    if (treeAfterCommit !== input.previewTree) {
      throw new TaskHttpError(
        409,
        'merge_preview_stale',
        'The worktree content changed after the preview. Refresh the merge preview and try again.',
      );
    }
    const outcome = await this.deps.worktrees.mergeInto(
      sourceRoot,
      wt.branch,
      targetBranch,
      strategy,
      message,
      {
        allowHookChanges: input.allowHookChanges ?? false,
        skipHooks: input.skipHooks ?? false,
        consentedHookFiles: input.consentedHookFiles ?? [],
      },
    );
    if (!outcome.ok) {
      if (outcome.code === 'conflict' || outcome.code === 'failed') {
        const saved = this.write({
          ...this.mustGet(taskId),
          merge: {
            status: outcome.code === 'conflict' ? 'conflict' : 'failed',
            strategy,
            branch: wt.branch,
            targetBranch,
            commit: null,
            conflictFiles: outcome.conflictFiles ?? [],
            error: outcome.message,
            mergedAt: null,
          },
          updatedAt: Date.now(),
        });
        throw new TaskHttpError(409, outcome.code, outcome.message, {
          conflictFiles: outcome.conflictFiles ?? [],
          task: saved,
        });
      }
      throw new TaskHttpError(409, outcome.code, outcome.message, {
        ...(outcome.hookFiles?.length ? { hookFiles: outcome.hookFiles } : {}),
      });
    }
    let realign: string | null = null;
    try {
      await this.deps.worktrees.syncToTarget(wt, outcome.commit);
    } catch (err) {
      realign = err instanceof Error ? err.message : String(err);
      this.deps.log.warn({ taskId, err: realign }, 'merged, but the worktree was not realigned');
    }
    const saved = this.write({
      ...this.mustGet(taskId),
      status: 'done',
      completedAt: this.mustGet(taskId).completedAt ?? Date.now(),
      merge: {
        status: 'merged',
        strategy,
        branch: wt.branch,
        targetBranch,
        commit: outcome.commit,
        conflictFiles: [],
        error: realign,
        mergedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });
    this.deps.events.append({
      id: newId(),
      ts: Date.now(),
      agentId: agent.id,
      taskId,
      type: 'notification',
      kind: 'worktree',
      message: realign
        ? `Merged ${wt.branch} into ${targetBranch} (${outcome.commit.slice(0, 7)}), but the worktree was not realigned: ${realign}`
        : `Merged ${wt.branch} into ${targetBranch} (${outcome.commit.slice(0, 7)}).`,
    });
    return saved;
  }

  /** Ask the assignee to integrate the target branch inside their own worktree. */
  resolveMergeWithAgent(taskId: string): void {
    const task = this.mustGet(taskId);
    if (!task.assigneeAgentId) throw new Error('Task has no assignee');
    const agent = this.deps.agents.get(task.assigneeAgentId);
    if (!agent?.worktree)
      throw new TaskHttpError(400, 'no_worktree', 'This agent has no worktree.');
    const busy = this.agentBusy(agent.id);
    if (busy) throw new TaskHttpError(409, 'agent_busy', busy);
    const target = task.merge?.targetBranch ?? agent.worktree.baseBranch ?? 'the target branch';
    const files = task.merge?.conflictFiles ?? [];
    const list = files.length
      ? files.map((f) => `- ${f}`).join('\n')
      : '- (see the merge conflict)';
    this.nudge(
      taskId,
      [
        `The merge of \`${agent.worktree.branch}\` into \`${target}\` conflicted.`,
        'Conflicting files:',
        list,
        '',
        `Integrate \`${target}\` into your branch inside your worktree and resolve the conflicts there.`,
        "Do not change the user's checkout. When the worktree is consistent, stop so the user can merge again.",
      ].join('\n'),
    );
  }

  /** Event-driven column moves. Called for every AgentEvent. */
  onEvent(e: AgentEvent): void {
    if (!e.taskId) return;
    const task = this.get(e.taskId);
    if (!task || task.status === 'done') return;
    switch (e.type) {
      case 'status':
        if (e.status === 'working' && task.status !== 'in_progress')
          this.setStatus(task, 'in_progress');
        else if (e.status === 'needs_input') this.setStatus(task, 'needs_input');
        else if (e.status === 'waiting') this.setStatus(task, 'assigned');
        break;
      case 'permission_requested':
        this.setStatus(task, 'needs_input');
        break;
      case 'permission_resolved':
        if (e.decision !== 'deny' && e.decision !== 'timeout') this.setStatus(task, 'in_progress');
        break;
      case 'assistant_text':
        if (!e.parentToolUseId) this.lastText.set(task.id, e.text);
        break;
      case 'tool_started':
        if (e.category === 'ask' || e.category === 'plan') this.setStatus(task, 'needs_input');
        break;
      case 'turn_completed': {
        // An aborted turn can carry an SDK diagnostic string instead of prose; prefer the last real text.
        const result = e.result && !/^\[\w*diagnostic\]/.test(e.result) ? e.result : undefined;
        const summary = result ?? this.lastText.get(task.id) ?? (e.errors?.join('; ') || null);
        const next: Task = {
          ...task,
          status: e.ok ? 'review' : 'needs_input',
          resultSummary: summary ? truncate(summary, 4000) : task.resultSummary,
          costUsd: task.costUsd + e.costUsd,
          updatedAt: Date.now(),
        };
        this.write(next);
        this.lastText.delete(task.id);
        this.deps.events.append({
          id: newId(),
          ts: Date.now(),
          agentId: e.agentId,
          taskId: task.id,
          type: 'task_done',
          ok: e.ok,
        });
        void this.collectFiles(next);
        break;
      }
      case 'error':
        if (e.kind === 'auth' || e.kind === 'billing') this.setStatus(task, 'needs_input');
        break;
      case 'notification':
        // A queued task prompt was dropped (agent stopped): keep the card from being re-dispatched.
        if (e.kind === 'cancelled' && task.status === 'assigned') {
          this.write({
            ...task,
            status: 'needs_input',
            resultSummary: e.message,
            updatedAt: Date.now(),
          });
        }
        break;
      default:
        break;
    }
  }

  private async redispatch(task: Task): Promise<void> {
    const current = this.get(task.id);
    if (current?.status !== 'assigned' || !current?.assigneeAgentId) return;
    try {
      await this.dispatch(current);
    } catch (err) {
      this.deps.log.warn(
        { taskId: task.id, err: String(err) },
        'could not re-dispatch task after restart',
      );
    }
  }

  private async redispatchAssigned(agentId: string): Promise<void> {
    for (const task of this.list()) {
      if (task.assigneeAgentId === agentId && task.status === 'assigned') {
        await this.redispatch(task);
      }
    }
  }

  private async assertMergeConsent(
    wt: NonNullable<Agent['worktree']>,
    sourceRoot: string,
    targetBranch: string,
    input: MergeTask,
  ): Promise<void> {
    if (!input.expectedBranchSha || !input.previewTree) {
      throw new TaskHttpError(
        400,
        'missing_preview',
        'Refresh the merge preview, then merge again.',
      );
    }
    const head = await this.deps.worktrees.headSha(wt.path);
    if (head !== input.expectedBranchSha) {
      throw new TaskHttpError(
        409,
        'merge_preview_stale',
        'The branch changed after the preview. Refresh the merge preview and try again.',
      );
    }
    const previewTreeNow = await this.deps.worktrees.previewTree(wt.path);
    if (previewTreeNow !== input.previewTree) {
      throw new TaskHttpError(
        409,
        'merge_preview_stale',
        'The worktree content does not match the preview. Refresh the merge preview and try again.',
      );
    }
    const hookCheck = await this.deps.worktrees.hookConsentSnapshot(
      sourceRoot,
      wt.path,
      targetBranch,
      head,
    );
    if (!hookCheck.ok) {
      throw new TaskHttpError(409, 'hooks_verify_failed', hookCheck.message);
    }
    const consented = input.consentedHookFiles ?? [];
    if (!hookFileSetsEqual(hookCheck.files, consented)) {
      throw new TaskHttpError(409, 'hooks_changed', 'Hook files changed since the preview.', {
        hookFiles: hookCheck.files,
      });
    }
    if (hookCheck.files.length && !input.allowHookChanges && !input.skipHooks) {
      throw new TaskHttpError(
        409,
        'hooks_changed',
        'This merge changes git hook scripts. Allow hook changes or merge without hooks.',
        { hookFiles: hookCheck.files },
      );
    }
  }

  private assertAssignDispatch(taskId: string, dispatchSeq: number | undefined): void {
    if (dispatchSeq === undefined) return;
    const before = this.get(taskId);
    if (!before || before.dispatchSeq !== dispatchSeq) {
      throw new TaskHttpError(409, 'assign_superseded', 'A newer assign superseded this dispatch.');
    }
  }

  private async dispatch(task: Task, dispatchSeq?: number): Promise<void> {
    if (!task.assigneeAgentId) return;
    if (this.merging.has(task.assigneeAgentId)) return;
    await this.snapshotForReview(task);
    const current = this.get(task.id);
    if (!current || current.status === 'done' || !current.assigneeAgentId) return;
    if (this.merging.has(current.assigneeAgentId)) return;
    const text = await this.promptFor(current, this.deps.agents.get(current.assigneeAgentId));
    const latest = this.get(task.id);
    if (!latest || latest.status === 'done' || !latest.assigneeAgentId) return;
    if (this.merging.has(latest.assigneeAgentId)) return;
    this.syncReadDirs(latest.assigneeAgentId);
    this.assertAssignDispatch(task.id, dispatchSeq);
    await Promise.resolve(this.deps.manager.sendPrompt(latest.assigneeAgentId, text, latest.id));
    this.assertAssignDispatch(task.id, dispatchSeq);
  }

  private async promptFor(task: Task, assignee?: Agent): Promise<string> {
    const lookup = this.deps.presetLookup;
    if (!task.reviewTarget) return buildTaskPrompt(task, undefined, assignee, lookup);
    const material = await this.reviewMaterial(task);
    return buildTaskPrompt(task, material, assignee, lookup);
  }

  private async reviewMaterial(task: Task): Promise<{ diff: string; files: string[] }> {
    const target = task.reviewTarget;
    if (!target) return { diff: '', files: [] };
    const agent = this.deps.agents.get(target.agentId);
    const dir = agent?.worktree?.path ?? target.path;
    const base = target.baseBranch;
    const material = await this.deps.worktrees.reviewDiff(dir, base);
    if (!agent?.worktree) {
      try {
        const changed = await this.deps.worktrees.changedFiles(dir);
        const names = new Set(material.files);
        for (const f of changed) names.add(f.path);
        return { diff: material.diff, files: [...names] };
      } catch {
        return material;
      }
    }
    return material;
  }

  private syncReadDirs(agentId: string): void {
    const dirs = new Set<string>();
    for (const t of this.list()) {
      if (t.assigneeAgentId !== agentId || !t.reviewTarget) continue;
      if (t.status === 'done' || t.status === 'backlog') continue;
      const subject = this.deps.agents.get(t.reviewTarget.agentId);
      for (const dir of [t.reviewTarget.path, subject?.worktree?.path]) {
        if (dir && fs.existsSync(dir)) dirs.add(dir);
      }
    }
    this.deps.manager.setExtraReadDirs(agentId, [...dirs]);
  }

  /** Record who is being reviewed. The diff is taken later, at dispatch, so it matches the prompt. */
  private async recordReviewTarget(input: CreateTask): Promise<ReviewTarget> {
    const agent = await this.reviewSubject(input);
    if (input.assigneeAgentId === agent.id) {
      throw new TaskHttpError(
        400,
        'self_review',
        'An agent cannot review its own worktree. Pick a different reviewer.',
      );
    }
    let baseBranch = agent.worktree?.baseBranch ?? null;
    if (agent.worktree && !baseBranch) {
      const source = this.deps.worktrees.resolvedSource(agent.workdir, agent.worktree);
      try {
        baseBranch = (await this.deps.worktrees.currentBranch(source))?.branch ?? null;
      } catch {
        baseBranch = null;
      }
    }
    return {
      agentId: agent.id,
      agentName: agent.name,
      path: agentCwd(agent),
      branch: agent.worktree?.branch ?? null,
      baseBranch,
    };
  }

  /** Commit the subject's worktree immediately before the review prompt is built. */
  private async snapshotForReview(task: Task): Promise<void> {
    const target = task.reviewTarget;
    if (!target) return;
    const agent = this.deps.agents.get(target.agentId);
    if (!agent?.worktree) return;
    const wt = agent.worktree;
    const source = this.deps.worktrees.resolvedSource(agent.workdir, wt);
    await this.deps.worktrees.withSourceLock(source, async () => {
      if (this.merging.has(agent.id)) {
        throw new TaskHttpError(
          409,
          'agent_busy',
          'The agent is merging a branch. Wait until that finishes.',
        );
      }
      const busy = this.runtimeBusy(agent.id);
      if (busy) throw new TaskHttpError(409, 'agent_busy', busy);
      try {
        await this.deps.worktrees.commitAll(wt, `deskhaven: snapshot for review (task ${task.id})`);
      } catch (err) {
        if (err instanceof WorktreeMovedError) {
          throw new TaskHttpError(409, 'worktree_moved', err.message);
        }
        throw err;
      }
    });
  }

  private assertReviewSubjectReady(agentId: string): void {
    if (this.merging.has(agentId)) {
      throw new TaskHttpError(
        409,
        'agent_busy',
        'The agent is merging a branch. Wait until that finishes.',
      );
    }
    const busy = this.runtimeBusy(agentId);
    if (busy) throw new TaskHttpError(409, 'agent_busy', busy);
  }

  private async reviewSubject(input: CreateTask): Promise<Agent> {
    let agentId = input.reviewOfAgentId ?? null;
    if (!agentId && input.reviewOfTaskId) {
      const src = this.get(input.reviewOfTaskId);
      if (!src)
        throw new TaskHttpError(400, 'unknown_task', `Unknown task ${input.reviewOfTaskId}`);
      agentId = src.assigneeAgentId;
      if (!agentId)
        throw new TaskHttpError(400, 'no_assignee', 'That task has no assignee to review.');
    }
    if (!agentId) throw new TaskHttpError(400, 'no_review_target', 'No agent to review.');
    const agent = this.deps.agents.get(agentId);
    if (!agent) throw new TaskHttpError(400, 'unknown_agent', `Unknown agent ${agentId}`);
    return agent;
  }

  /**
   * The task whose turn ran last in the agent's worktree. Every task of an agent shares one worktree
   * and branch, so the uncommitted work there is that task's (a turn of a later task would have
   * come after it). Null when the agent has not completed a task turn.
   */
  private worktreeOwner(agentId: string): Task | null {
    const turns = this.deps.events.list({ agentId, types: ['turn_completed'], limit: 50 });
    for (const t of turns) {
      if (!t.taskId) continue;
      return this.get(t.taskId) ?? null;
    }
    return null;
  }

  private async locateWorktree(taskId: string): Promise<
    | {
        ok: true;
        task: Task;
        agent: Agent;
        sourceRoot: string;
        targetBranch: string;
      }
    | { ok: false; error: TaskHttpError }
  > {
    const task = this.get(taskId);
    if (!task) return { ok: false, error: new TaskHttpError(404, 'not_found', 'Unknown task') };
    if (!task.assigneeAgentId)
      return {
        ok: false,
        error: new TaskHttpError(400, 'no_assignee', 'Assign the task before merging it.'),
      };
    const agent = this.deps.agents.get(task.assigneeAgentId);
    if (!agent)
      return {
        ok: false,
        error: new TaskHttpError(400, 'unknown_agent', `Unknown agent ${task.assigneeAgentId}`),
      };
    if (!agent.worktree)
      return {
        ok: false,
        error: new TaskHttpError(
          400,
          'no_worktree',
          'This agent was not hired with a git worktree, so there is no branch to merge.',
        ),
      };
    const sourceRoot = this.deps.worktrees.resolvedSource(agent.workdir, agent.worktree);
    let targetBranch = agent.worktree.baseBranch ?? null;
    if (!targetBranch) {
      // Agents hired before baseBranch was stored: use whatever is checked out now.
      try {
        targetBranch = (await this.deps.worktrees.currentBranch(sourceRoot))?.branch ?? null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: new TaskHttpError(
            409,
            'invalid_branch',
            message.replace(/^invalid_branch:\s*/, ''),
          ),
        };
      }
    }
    if (!targetBranch) {
      return {
        ok: false,
        error: new TaskHttpError(
          409,
          'wrong_branch',
          'The source checkout is in detached HEAD, and this worktree has no recorded base branch. Deskhaven will not switch branches.',
        ),
      };
    }
    return { ok: true, task, agent, sourceRoot, targetBranch };
  }

  private agentBusy(agentId: string): string | null {
    if (this.merging.has(agentId))
      return 'The agent is merging a branch. Wait until that finishes.';
    return this.runtimeBusy(agentId);
  }

  /** Busy for a reason other than the merge this service is currently running. */
  private runtimeBusy(agentId: string): string | null {
    const rt = this.deps.manager.get(agentId);
    const live = rt?.getStatus();
    if (live === 'working' || live === 'needs_input')
      return 'The agent is working. Wait until it is idle before merging or snapshotting its worktree.';
    const agent = this.deps.agents.get(agentId);
    if (agent && (agent.status === 'working' || agent.status === 'needs_input'))
      return 'The agent is working. Wait until it is idle before merging or snapshotting its worktree.';
    if ((this.deps.broker?.pendingForAgent(agentId).length ?? 0) > 0)
      return 'The agent has an open permission request.';
    const open = this.list().find(
      (t) =>
        t.assigneeAgentId === agentId && (t.status === 'in_progress' || t.status === 'needs_input'),
    );
    if (open)
      return `The agent is busy on "${open.title}" (${open.status.replace('_', ' ')}). Wait until that task is idle.`;
    return null;
  }

  private async collectFiles(task: Task): Promise<void> {
    const agent = task.assigneeAgentId ? this.deps.agents.get(task.assigneeAgentId) : undefined;
    if (!agent) return;
    try {
      const files = await this.deps.worktrees.changedFiles(agent.worktree?.path ?? agent.workdir);
      const current = this.get(task.id);
      if (current) this.write({ ...current, filesChanged: files, updatedAt: Date.now() });
    } catch (err) {
      this.deps.log.warn({ taskId: task.id, err: String(err) }, 'could not collect changed files');
    }
  }

  private setStatus(task: Task, status: TaskStatus): void {
    const current = this.get(task.id) ?? task;
    if (current.status === status || current.status === 'done') return;
    this.write({ ...current, status, updatedAt: Date.now() });
  }

  private mustGet(id: string): Task {
    const t = this.get(id);
    if (!t) throw new Error(`Unknown task ${id}`);
    return t;
  }

  private write(task: Task): Task {
    const parsed = TaskSchema.parse(task);
    const json = JSON.stringify(parsed);
    this.db
      .insert(tasksTable)
      .values({
        id: parsed.id,
        json,
        status: parsed.status,
        assigneeAgentId: parsed.assigneeAgentId,
        position: parsed.position,
        updatedAt: parsed.updatedAt,
      })
      .onConflictDoUpdate({
        target: tasksTable.id,
        set: {
          json,
          status: parsed.status,
          assigneeAgentId: parsed.assigneeAgentId,
          position: parsed.position,
          updatedAt: parsed.updatedAt,
        },
      })
      .run();
    this.hub.broadcast({ type: 'task_upserted', task: parsed });
    return parsed;
  }
}

export function buildTaskPrompt(
  task: Task,
  review?: { diff: string; files: string[] },
  assignee?: Agent | null,
  presetLookup?: PresetLookup,
): string {
  const head = `# Task: ${task.title}\n\n${task.prompt}`;
  const tail = taskTail(task, assignee, presetLookup);
  const target = task.reviewTarget;
  if (!target) return `${head}\n\n${tail}`;
  const files = review?.files ?? [];
  const raw = review?.diff ?? '';
  const truncated = raw.length > REVIEW_DIFF_LIMIT;
  const diff = truncated
    ? `${raw.slice(0, REVIEW_DIFF_LIMIT)}\n\n[diff truncated, read the files from the path]`
    : raw;
  const fileList = files.length ? files.map((f) => `- ${f}`).join('\n') : '(none listed)';
  const reviewBlock = `## Review target
Review the files under \`${target.path}\`, not your working directory.
Agent: ${target.agentName} (${target.agentId})
Branch: ${target.branch ?? '(no branch)'}
Base: ${target.baseBranch ?? '(working tree)'}

Changed files:
${fileList}

Diff:
\`\`\`diff
${diff || '(empty)'}
\`\`\`
${truncated ? '\nThe diff above is truncated. Read the files from the path.' : ''}`;
  return `${head}\n\n${reviewBlock}\n\n${tail}`;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
