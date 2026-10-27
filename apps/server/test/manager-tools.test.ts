import type { Agent, Task } from '@deskhaven/shared';
import { describe, expect, it } from 'vitest';
import type { AgentService } from '../src/agents/service.js';
import { managerActions, managerToolNames } from '../src/manager/tools.js';
import type { TaskService } from '../src/tasks/service.js';

const agent = (id: string, role: string): Agent =>
  ({
    id,
    name: id === 'eng' ? 'Ada' : id,
    rolePresetId: role,
    status: 'idle',
    workdir: '/w',
    worktree: id === 'eng' ? { path: '/wt/ada', branch: 'deskhaven/ada' } : null,
    currentTaskId: null,
    model: 'm',
  }) as unknown as Agent;

/** Role presets as the app's PresetService would return them: "cto" is a custom manager preset. */
const presetIsManager: Record<string, boolean> = { manager: true, cto: true };

function setup(withIsManager = true) {
  const all = () => [
    agent('mgr', 'manager'),
    agent('eng', 'engineer'),
    agent('qa', 'qa'),
    agent('boss', 'cto'),
  ];
  const agents = {
    list: all,
    get: (id: string) => all().find((a) => a.id === id),
  } as unknown as AgentService;
  const store = new Map<string, Task>();
  const created: {
    title: string;
    prompt: string;
    assigneeAgentId?: string | null;
    reviewOfAgentId?: string;
  }[] = [];
  const tasks = {
    create: (input: {
      title: string;
      prompt: string;
      assigneeAgentId?: string | null;
      reviewOfAgentId?: string;
    }) => {
      created.push(input);
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
  return {
    ...managerActions({
      agents,
      tasks,
      selfId: 'mgr',
      ...(withIsManager
        ? { isManager: (a: Agent) => presetIsManager[a.rolePresetId] === true }
        : {}),
    }),
    created,
  };
}

describe('manager delegation tools', () => {
  it('lists only employees (never itself or other managers)', () => {
    expect(
      setup()
        .listAgents()
        .map((a) => a.id),
    ).toEqual(['eng', 'qa']);
    expect(managerToolNames()).toContain('mcp__deskhaven__create_task');
    expect(
      setup()
        .listAgents()
        .find((a) => a.id === 'eng'),
    ).toMatchObject({
      branch: 'deskhaven/ada',
    });
  });
  it('creates and assigns tasks and reports status', async () => {
    const a = setup();
    const created = await a.createTask({ title: 'Fix', prompt: 'do it', assigneeAgentId: 'eng' });
    expect(created).toMatchObject({ status: 'assigned', assigneeAgentId: 'eng' });
    const backlog = await a.createTask({ title: 'Later', prompt: 'later' });
    expect(backlog.status).toBe('backlog');
    expect(await a.assignTask({ taskId: backlog.taskId, agentId: 'qa' })).toMatchObject({
      assigneeAgentId: 'qa',
    });
    expect(a.taskStatus({ taskId: created.taskId })).toMatchObject({
      title: 'Fix',
      status: 'assigned',
    });
    expect((a.taskStatus({}) as unknown[]).length).toBe(2);
    expect(a.taskStatus({ taskId: 'nope' })).toEqual({ error: 'unknown task nope' });
  });
  it('keeps delegation flat', async () => {
    const a = setup();
    await expect(a.createTask({ title: 'x', prompt: 'y', assigneeAgentId: 'mgr' })).rejects.toThrow(
      /itself/,
    );
    await expect(a.assignTask({ taskId: 'any', agentId: 'ghost' })).rejects.toThrow(
      /Unknown employee/,
    );
  });
  it('treats any agent whose preset has the manager flag as a manager, not just id "manager"', async () => {
    const a = setup();
    expect(a.listAgents().map((x) => x.id)).not.toContain('boss');
    await expect(
      a.createTask({ title: 'x', prompt: 'y', assigneeAgentId: 'boss' }),
    ).rejects.toThrow(/flat/);
    const backlog = await a.createTask({ title: 'Later', prompt: 'later' });
    await expect(a.assignTask({ taskId: backlog.taskId, agentId: 'boss' })).rejects.toThrow(/flat/);
  });
  it('falls back to the built-in presets when no lookup is given', async () => {
    const a = setup(false);
    await expect(a.assignTask({ taskId: 'any', agentId: 'mgr' })).rejects.toThrow(/itself/);
    expect(a.listAgents().map((x) => x.id)).toEqual(['eng', 'qa', 'boss']);
  });
  it('resolves reviewOfAgentId by name and passes the employee id to create', async () => {
    const a = setup();
    await a.createTask({
      title: 'Review',
      prompt: 'look at the branch',
      assigneeAgentId: 'qa',
      reviewOfAgentId: 'Ada',
    });
    expect(a.created[a.created.length - 1]).toMatchObject({
      assigneeAgentId: 'qa',
      reviewOfAgentId: 'eng',
    });
    await expect(
      a.createTask({ title: 'Review', prompt: 'x', reviewOfAgentId: 'nobody' }),
    ).rejects.toThrow(/Unknown employee/);
  });
});
