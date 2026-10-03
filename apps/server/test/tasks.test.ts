import { type Agent, type AgentEvent, AgentSchema, emptyUsage } from '@deskhaven/shared';
import { describe, expect, it } from 'vitest';
import type { AgentManager } from '../src/agent/manager.js';
import type { AgentService } from '../src/agents/service.js';
import { openDb } from '../src/db/client.js';
import { EventStore } from '../src/events/store.js';
import { buildTaskPrompt, TaskService } from '../src/tasks/service.js';
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
  return { tasks, events, sent };
}

const ev = (partial: Partial<AgentEvent> & { type: AgentEvent['type'] }): AgentEvent =>
  ({ id: Math.random().toString(36).slice(2), ts: 1, agentId: 'a1', ...partial }) as AgentEvent;

describe('TaskService', () => {
  it('creates in backlog, assigns, and dispatches the prompt tagged with the task id', () => {
    const { tasks, sent, events } = setup();
    const t = tasks.create({ title: 'Fix mean', prompt: 'mean() divides by n+1' });
    expect(t.status).toBe('backlog');
    const assigned = tasks.assign(t.id, 'a1');
    expect(assigned.status).toBe('assigned');
    expect(assigned.assigneeAgentId).toBe('a1');
    expect(sent).toEqual([{ agentId: 'a1', text: buildTaskPrompt(assigned), taskId: t.id }]);
    expect(sent[0]?.text).toContain('# Task: Fix mean');
    expect(events.list({ types: ['task_assigned'] })[0]).toMatchObject({
      taskId: t.id,
      title: 'Fix mean',
    });
    expect(() => tasks.assign(t.id, 'nope')).toThrow(/Unknown agent/);
  });

  it('moves across columns from agent events and captures result, cost and files', async () => {
    const { tasks, events } = setup();
    const t = tasks.create({ title: 'T', prompt: 'p', assigneeAgentId: 'a1' });
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
    tasks.update(t.id, { status: 'done' });
    expect(tasks.get(t.id)?.completedAt).not.toBeNull();
    // done tasks ignore later events
    events.append(ev({ type: 'status', status: 'working', taskId: t.id }));
    expect(tasks.get(t.id)?.status).toBe('done');
  });

  it('a failed turn lands in needs_input with the error as summary', () => {
    const { tasks, events } = setup();
    const t = tasks.create({ title: 'T', prompt: 'p', assigneeAgentId: 'a1' });
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

  it('ignores SDK diagnostic strings as result summaries', () => {
    const { tasks, events } = setup();
    const t = tasks.create({ title: 'T', prompt: 'p', assigneeAgentId: 'a1' });
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

  it('reassigning through update dispatches to the new agent and nudge re-sends', () => {
    const { tasks, sent } = setup();
    const t = tasks.create({ title: 'T', prompt: 'p' });
    tasks.update(t.id, { assigneeAgentId: 'a1' });
    expect(sent).toHaveLength(1);
    tasks.nudge(t.id, 'please continue');
    expect(sent[1]).toEqual({ agentId: 'a1', text: 'please continue', taskId: t.id });
    expect(tasks.get(t.id)?.status).toBe('in_progress');
    tasks.remove(t.id);
    expect(tasks.get(t.id)).toBeUndefined();
  });
});
