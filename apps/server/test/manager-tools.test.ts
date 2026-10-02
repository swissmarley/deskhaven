import type { Agent, Task } from '@agenthotel/shared';
import { describe, expect, it } from 'vitest';
import type { AgentService } from '../src/agents/service.js';
import { managerActions, managerToolNames } from '../src/manager/tools.js';
import type { TaskService } from '../src/tasks/service.js';

const agent = (id: string, role: string): Agent =>
  ({
    id,
    name: id,
    rolePresetId: role,
    status: 'idle',
    workdir: '/w',
    worktree: null,
    currentTaskId: null,
    model: 'm',
  }) as unknown as Agent;

function setup() {
  const agents = {
    list: () => [agent('mgr', 'manager'), agent('eng', 'engineer'), agent('qa', 'qa')],
    get: (id: string) =>
      [agent('mgr', 'manager'), agent('eng', 'engineer'), agent('qa', 'qa')].find(
        (a) => a.id === id,
      ),
  } as unknown as AgentService;
  const store = new Map<string, Task>();
  const tasks = {
    create: (input: { title: string; prompt: string; assigneeAgentId?: string | null }) => {
      const t = {
        id: `t${store.size + 1}`,
        title: input.title,
        prompt: input.prompt,
        status: input.assigneeAgentId ? 'assigned' : 'backlog',
        assigneeAgentId: input.assigneeAgentId ?? null,
        resultSummary: null,
        filesChanged: [],
        costUsd: 0,
        updatedAt: Date.now(),
      } as unknown as Task;
      store.set(t.id, t);
      return t;
    },
    assign: (id: string, agentId: string) => {
      const t = store.get(id);
      if (!t) throw new Error('unknown');
      const n = { ...t, assigneeAgentId: agentId, status: 'assigned' } as Task;
      store.set(id, n);
      return n;
    },
    get: (id: string) => store.get(id),
    list: () => [...store.values()],
  } as unknown as TaskService;
  return managerActions({ agents, tasks, selfId: 'mgr' });
}

describe('manager delegation tools', () => {
  it('lists only employees (never itself or other managers)', () => {
    expect(
      setup()
        .listAgents()
        .map((a) => a.id),
    ).toEqual(['eng', 'qa']);
    expect(managerToolNames()).toContain('mcp__agenthotel__create_task');
  });
  it('creates and assigns tasks and reports status', () => {
    const a = setup();
    const created = a.createTask({ title: 'Fix', prompt: 'do it', assigneeAgentId: 'eng' });
    expect(created).toMatchObject({ status: 'assigned', assigneeAgentId: 'eng' });
    const backlog = a.createTask({ title: 'Later', prompt: 'later' });
    expect(backlog.status).toBe('backlog');
    expect(a.assignTask({ taskId: backlog.taskId, agentId: 'qa' })).toMatchObject({
      assigneeAgentId: 'qa',
    });
    expect(a.taskStatus({ taskId: created.taskId })).toMatchObject({
      title: 'Fix',
      status: 'assigned',
    });
    expect((a.taskStatus({}) as unknown[]).length).toBe(2);
    expect(a.taskStatus({ taskId: 'nope' })).toEqual({ error: 'unknown task nope' });
  });
  it('keeps delegation flat', () => {
    const a = setup();
    expect(() => a.createTask({ title: 'x', prompt: 'y', assigneeAgentId: 'mgr' })).toThrow(
      /itself/,
    );
    expect(() => a.assignTask({ taskId: 'any', agentId: 'ghost' })).toThrow(/Unknown employee/);
  });
});
