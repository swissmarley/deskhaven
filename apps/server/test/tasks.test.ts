import {
  type Agent,
  type AgentEvent,
  AgentSchema,
  emptyUsage,
  TaskSchema,
} from '@deskhaven/shared';
import { describe, expect, it } from 'vitest';
import type { AgentManager } from '../src/agent/manager.js';
import type { AgentService } from '../src/agents/service.js';
import { openDb } from '../src/db/client.js';
import { tasks as tasksTable } from '../src/db/schema.js';
import { EventStore } from '../src/events/store.js';
import {
  buildTaskPrompt,
  REVIEW_DIFF_LIMIT,
  TaskHttpError,
  TaskService,
} from '../src/tasks/service.js';
import type { WorktreeService } from '../src/worktree/service.js';
import { WsHub } from '../src/ws/hub.js';

function setup() {
  const { db } = openDb(':memory:');
  const hub = new WsHub();
  const events = new EventStore(db, hub);
  const sent: { agentId: string; text: string; taskId: string | null }[] = [];
  const agent: Agent = AgentSchema.parse({
    id: 'a1',
    name: 'Ada',
    avatar: {
      skin: '#fff',
      hair: '#000',
      hairStyle: 'short',
      shirt: '#f00',
      pants: '#00f',
      accessory: 'none',
    },
    rolePresetId: 'engineer',
    systemPrompt: '',
    model: 'm',
    tools: null,
    allowedTools: [],
    permissionMode: 'default',
    workdir: process.cwd(),
    worktree: null,
    sessionId: null,
    status: 'idle',
    roomId: 'lobby',
    deskId: null,
    budget: {},
    currentTaskId: null,
    usage: emptyUsage(),
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  });
  const manager = {
    sendPrompt: (agentId: string, text: string, taskId: string | null) =>
      sent.push({ agentId, text, taskId }),
    setExtraReadDirs: () => {},
    get: () => undefined,
  } as unknown as AgentManager;
  const agents = {
    get: (id: string) => (id === 'a1' ? agent : undefined),
  } as unknown as AgentService;
  const worktrees = {
    changedFiles: async () => [{ path: 'src/stats.ts', additions: 1, deletions: 1 }],
  } as unknown as WorktreeService;
  const tasks = new TaskService(db, hub, {
    manager,
    agents,
    events,
    worktrees,
    log: { warn() {} },
  });
  events.onEvent((e) => tasks.onEvent(e));
  return { tasks, events, sent, db };
}

const ev = (partial: Partial<AgentEvent> & { type: AgentEvent['type'] }): AgentEvent =>
  ({ id: Math.random().toString(36).slice(2), ts: 1, agentId: 'a1', ...partial }) as AgentEvent;

describe('TaskService', () => {
  it('creates in backlog, assigns, and dispatches the prompt tagged with the task id', async () => {
    const { tasks, sent, events } = setup();
    const t = await tasks.create({ title: 'Fix mean', prompt: 'mean() divides by n+1' });
    expect(t.status).toBe('backlog');
    const assigned = await tasks.assign(t.id, 'a1');
    expect(assigned.status).toBe('assigned');
    expect(assigned.assigneeAgentId).toBe('a1');
    expect(sent).toEqual([{ agentId: 'a1', text: buildTaskPrompt(assigned), taskId: t.id }]);
    expect(sent[0]?.text).toContain('# Task: Fix mean');
    expect(events.list({ types: ['task_assigned'] })[0]).toMatchObject({
      taskId: t.id,
      title: 'Fix mean',
    });
    await expect(tasks.assign(t.id, 'nope')).rejects.toThrow(/Unknown agent/);
  });

  it('moves across columns from agent events and captures result, cost and files', async () => {
    const { tasks, events } = setup();
    const t = await tasks.create({ title: 'T', prompt: 'p', assigneeAgentId: 'a1' });
    expect(tasks.get(t.id)?.status).toBe('assigned');
    events.append(ev({ type: 'status', status: 'working', taskId: t.id }));
    expect(tasks.get(t.id)?.status).toBe('in_progress');
    events.append(
      ev({
        type: 'permission_requested',
        taskId: t.id,
        requestId: 'r',
        toolUseId: 'x',
        tool: 'Bash',
        category: 'bash',
        input: {},
        hasSuggestions: false,
      }),
    );
    expect(tasks.get(t.id)?.status).toBe('needs_input');
    events.append(
      ev({
        type: 'permission_resolved',
        taskId: t.id,
        requestId: 'r',
        tool: 'Bash',
        category: 'bash',
        decision: 'allow',
      }),
    );
    expect(tasks.get(t.id)?.status).toBe('in_progress');
    events.append(ev({ type: 'assistant_text', taskId: t.id, text: 'Fixed the divisor.' }));
    events.append(
      ev({
        type: 'turn_completed',
        taskId: t.id,
        ok: true,
        subtype: 'success',
        costUsd: 0.2,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        numTurns: 1,
        durationMs: 5,
        result: 'Fixed the divisor.',
      }),
    );
    const done = tasks.get(t.id);
    expect(done).toMatchObject({
      status: 'review',
      resultSummary: 'Fixed the divisor.',
      costUsd: 0.2,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(tasks.get(t.id)?.filesChanged).toEqual([
      { path: 'src/stats.ts', additions: 1, deletions: 1 },
    ]);
    expect(events.list({ types: ['task_done'] })[0]).toMatchObject({ taskId: t.id, ok: true });
    await tasks.update(t.id, { status: 'done' });
    expect(tasks.get(t.id)?.completedAt).not.toBeNull();
    // done tasks ignore later events
    events.append(ev({ type: 'status', status: 'working', taskId: t.id }));
    expect(tasks.get(t.id)?.status).toBe('done');
  });

  it('a failed turn lands in needs_input with the error as summary', async () => {
    const { tasks, events } = setup();
    const t = await tasks.create({ title: 'T', prompt: 'p', assigneeAgentId: 'a1' });
    events.append(
      ev({
        type: 'turn_completed',
        taskId: t.id,
        ok: false,
        subtype: 'error_max_turns',
        costUsd: 0.1,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        numTurns: 9,
        durationMs: 5,
        errors: ['max turns'],
      }),
    );
    expect(tasks.get(t.id)).toMatchObject({ status: 'needs_input', resultSummary: 'max turns' });
  });

  it('ignores SDK diagnostic strings as result summaries', async () => {
    const { tasks, events } = setup();
    const t = await tasks.create({ title: 'T', prompt: 'p', assigneeAgentId: 'a1' });
    events.append(ev({ type: 'assistant_text', taskId: t.id, text: 'halfway there' }));
    events.append(
      ev({
        type: 'turn_completed',
        taskId: t.id,
        ok: false,
        subtype: 'success',
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        numTurns: 1,
        durationMs: 1,
        result: '[ede_diagnostic] result_type=user stop_reason=tool_use',
      }),
    );
    expect(tasks.get(t.id)?.resultSummary).toBe('halfway there');
  });

  it('does not roll back a successful second assign to the same agent', async () => {
    const { db } = openDb(':memory:');
    const hub = new WsHub();
    const events = new EventStore(db, hub);
    const agentA = AgentSchema.parse({
      id: 'a1',
      name: 'Ada',
      avatar: {
        skin: '#fff',
        hair: '#000',
        hairStyle: 'short',
        shirt: '#f00',
        pants: '#00f',
        accessory: 'none',
      },
      rolePresetId: 'engineer',
      systemPrompt: '',
      model: 'm',
      tools: null,
      allowedTools: [],
      permissionMode: 'default',
      workdir: process.cwd(),
      worktree: null,
      sessionId: null,
      status: 'idle',
      roomId: 'lobby',
      deskId: null,
      budget: {},
      currentTaskId: null,
      usage: emptyUsage(),
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    });
    let calls = 0;
    const manager = {
      sendPrompt: () => {
        calls += 1;
        if (calls === 1) throw new TaskHttpError(409, 'agent_busy', 'stale');
      },
      setExtraReadDirs: () => {},
      get: () => undefined,
    } as unknown as AgentManager;
    const agents = {
      get: (id: string) => (id === 'a1' ? agentA : undefined),
    } as unknown as AgentService;
    const worktrees = { changedFiles: async () => [] } as unknown as WorktreeService;
    const tasks = new TaskService(db, hub, {
      manager,
      agents,
      events,
      worktrees,
      log: { warn() {} },
    });
    const t = await tasks.create({ title: 'Race', prompt: 'p' });
    const results = await Promise.allSettled([tasks.assign(t.id, 'a1'), tasks.assign(t.id, 'a1')]);
    expect(results.some((r) => r.status === 'rejected')).toBe(true);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(tasks.get(t.id)).toMatchObject({ assigneeAgentId: 'a1', status: 'assigned' });
    expect(calls).toBe(2);
  });

  it('assign rollback is skipped when the task was reassigned before dispatch failed', async () => {
    const { db } = openDb(':memory:');
    const hub = new WsHub();
    const events = new EventStore(db, hub);
    const agentA = AgentSchema.parse({
      id: 'a1',
      name: 'Ada',
      avatar: {
        skin: '#fff',
        hair: '#000',
        hairStyle: 'short',
        shirt: '#f00',
        pants: '#00f',
        accessory: 'none',
      },
      rolePresetId: 'engineer',
      systemPrompt: '',
      model: 'm',
      tools: null,
      allowedTools: [],
      permissionMode: 'default',
      workdir: process.cwd(),
      worktree: null,
      sessionId: null,
      status: 'idle',
      roomId: 'lobby',
      deskId: null,
      budget: {},
      currentTaskId: null,
      usage: emptyUsage(),
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const agentB = AgentSchema.parse({ ...agentA, id: 'a2', name: 'Bob' });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: string[] = [];
    const manager = {
      sendPrompt: (agentId: string) => {
        sent.push(agentId);
        if (agentId === 'a1') {
          return gate.then(() => {
            throw new TaskHttpError(409, 'agent_busy', 'stale');
          });
        }
      },
      setExtraReadDirs: () => {},
      get: () => undefined,
    } as unknown as AgentManager;
    const agents = {
      get: (id: string) => (id === 'a1' ? agentA : id === 'a2' ? agentB : undefined),
    } as unknown as AgentService;
    const worktrees = {
      changedFiles: async () => [],
    } as unknown as WorktreeService;
    const tasks = new TaskService(db, hub, {
      manager,
      agents,
      events,
      worktrees,
      log: { warn() {} },
    });
    const t = await tasks.create({ title: 'Race', prompt: 'p' });
    const slow = tasks.assign(t.id, 'a1');
    await new Promise<void>((r) => setImmediate(r));
    const fast = tasks.assign(t.id, 'a2');
    release();
    await expect(slow).rejects.toMatchObject({ code: 'agent_busy' });
    await fast;
    expect(tasks.get(t.id)?.assigneeAgentId).toBe('a2');
    expect(sent).toEqual(['a1', 'a2']);
  });

  it('update with unknown assignee does not change the title', async () => {
    const { tasks } = setup();
    const t = await tasks.create({ title: 'Keep me', prompt: 'p' });
    await expect(tasks.update(t.id, { assigneeAgentId: 'nope', title: 'Lost' })).rejects.toThrow(
      /Unknown agent/,
    );
    expect(tasks.get(t.id)?.title).toBe('Keep me');
  });

  it('update with assignee and title writes both before dispatch', async () => {
    const { tasks, sent } = setup();
    const t = await tasks.create({ title: 'Old', prompt: 'p' });
    const updated = await tasks.update(t.id, {
      assigneeAgentId: 'a1',
      title: 'Renamed',
      prompt: 'new prompt',
    });
    expect(updated.title).toBe('Renamed');
    expect(updated.prompt).toBe('new prompt');
    expect(updated.assigneeAgentId).toBe('a1');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('# Task: Renamed');
  });

  it('reassigning through update dispatches to the new agent and nudge re-sends', async () => {
    const { tasks, sent } = setup();
    const t = await tasks.create({ title: 'T', prompt: 'p' });
    await tasks.update(t.id, { assigneeAgentId: 'a1' });
    expect(sent).toHaveLength(1);
    tasks.nudge(t.id, 'please continue');
    expect(sent[1]).toEqual({ agentId: 'a1', text: 'please continue', taskId: t.id });
    expect(tasks.get(t.id)?.status).toBe('in_progress');
    tasks.remove(t.id);
    expect(tasks.get(t.id)).toBeUndefined();
  });

  it('loads a task saved before merge and reviewTarget existed', () => {
    const { tasks, db } = setup();
    const old = {
      id: 'old-task',
      title: 'Old',
      prompt: 'p',
      status: 'backlog',
      assigneeAgentId: null,
      parentTaskId: null,
      resultSummary: null,
      filesChanged: [],
      costUsd: 0,
      position: 0,
      createdAt: 1,
      startedAt: null,
      completedAt: null,
      updatedAt: 1,
    };
    db.insert(tasksTable)
      .values({
        id: old.id,
        json: JSON.stringify(old),
        status: 'backlog',
        assigneeAgentId: null,
        position: 0,
        updatedAt: 1,
      })
      .run();
    expect(TaskSchema.parse(old).merge).toBeUndefined();
    expect(tasks.get('old-task')).toMatchObject({ title: 'Old', status: 'backlog' });
    expect(() => tasks.reconcileOnBoot()).not.toThrow();
  });

  it('states when a review diff is truncated', () => {
    const task = {
      id: 't',
      title: 'Review',
      prompt: 'look',
      status: 'assigned',
      assigneeAgentId: 'rev',
      parentTaskId: null,
      resultSummary: null,
      filesChanged: [],
      costUsd: 0,
      position: 1,
      createdAt: 1,
      startedAt: 1,
      completedAt: null,
      updatedAt: 1,
      reviewTarget: {
        agentId: 'eng',
        agentName: 'Ada',
        path: '/wt/ada',
        branch: 'deskhaven/ada',
        baseBranch: 'main',
      },
    } as const;
    const parsed = TaskSchema.parse(task);
    const short = buildTaskPrompt(parsed, { diff: '+ kept\n', files: ['a.txt'] });
    expect(short).toContain('/wt/ada');
    expect(short).toContain('deskhaven/ada');
    expect(short).toContain('+ kept');
    expect(short).not.toContain('diff truncated');
    const long = buildTaskPrompt(parsed, {
      diff: 'x'.repeat(REVIEW_DIFF_LIMIT + 10),
      files: ['a.txt'],
    });
    expect(long).toContain('[diff truncated, read the files from the path]');
    expect(long).toContain('The diff above is truncated');
  });
});
