import {
  type AgentEvent,
  type CreateTask,
  newId,
  type Task,
  TaskSchema,
  type TaskStatus,
  truncate,
  type UpdateTask,
} from '@agenthotel/shared';
import { eq } from 'drizzle-orm';
import type { AgentManager } from '../agent/manager.js';
import type { AgentService } from '../agents/service.js';
import type { Db } from '../db/client.js';
import { tasks as tasksTable } from '../db/schema.js';
import type { EventStore } from '../events/store.js';
import type { WorktreeService } from '../worktree/service.js';
import type { WsHub } from '../ws/hub.js';

interface TaskDeps {
  manager: AgentManager;
  agents: AgentService;
  events: EventStore;
  worktrees: WorktreeService;
  log: { warn(obj: unknown, msg?: string): void };
}

/**
 * The task board. Assigning a task sends its prompt into the agent's session; events tagged with the
 * task id move it across the columns and fill in result, files changed and cost.
 */
export class TaskService {
  /** Last assistant text seen per task, used as the result summary when the turn completes. */
  private readonly lastText = new Map<string, string>();

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

  create(input: CreateTask): Task {
    const now = Date.now();
    const position = Math.max(0, ...this.list().map((t) => t.position)) + 1;
    const task: Task = TaskSchema.parse({
      id: newId(),
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
    });
    this.write(task);
    if (input.assigneeAgentId) return this.assign(task.id, input.assigneeAgentId);
    return task;
  }

  update(id: string, patch: UpdateTask): Task {
    const current = this.mustGet(id);
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
      this.write(next);
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
  assign(taskId: string, agentId: string): Task {
    const task = this.mustGet(taskId);
    const agent = this.deps.agents.get(agentId);
    if (!agent) throw new Error(`Unknown agent ${agentId}`);
    const assigned: Task = {
      ...task,
      assigneeAgentId: agentId,
      status: 'assigned',
      startedAt: task.startedAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    this.write(assigned);
    this.deps.events.append({
      id: newId(),
      ts: Date.now(),
      agentId,
      taskId,
      type: 'task_assigned',
      title: task.title,
    });
    try {
      this.deps.manager.sendPrompt(agentId, buildTaskPrompt(assigned), taskId);
    } catch (err) {
      // Budget cap or kill switch: keep the assignment but ask a human.
      const message = err instanceof Error ? err.message : String(err);
      this.write({
        ...this.mustGet(taskId),
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
        try {
          this.deps.manager.sendPrompt(t.assigneeAgentId, buildTaskPrompt(t), t.id);
        } catch (err) {
          this.deps.log.warn(
            { taskId: t.id, err: String(err) },
            'could not re-dispatch task after restart',
          );
        }
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
    this.setStatus(task, 'in_progress');
    this.deps.manager.sendPrompt(task.assigneeAgentId, text, taskId);
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
      default:
        break;
    }
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

  private write(task: Task): void {
    const json = JSON.stringify(TaskSchema.parse(task));
    this.db
      .insert(tasksTable)
      .values({
        id: task.id,
        json,
        status: task.status,
        assigneeAgentId: task.assigneeAgentId,
        position: task.position,
        updatedAt: task.updatedAt,
      })
      .onConflictDoUpdate({
        target: tasksTable.id,
        set: {
          json,
          status: task.status,
          assigneeAgentId: task.assigneeAgentId,
          position: task.position,
          updatedAt: task.updatedAt,
        },
      })
      .run();
    this.hub.broadcast({ type: 'task_upserted', task });
  }
}

export function buildTaskPrompt(task: Task): string {
  return `# Task: ${task.title}\n\n${task.prompt}\n\nWhen you are done, end with a short summary of what you changed (or found) and how to verify it.`;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
