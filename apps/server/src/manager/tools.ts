import { z } from 'zod';
import { createSdkMcpServer, type McpServerConfig, tool } from '../agent/sdk-adapter.js';
import type { AgentService } from '../agents/service.js';
import type { TaskService } from '../tasks/service.js';

/** The Manager's delegation tools, served in-process over MCP. Flat: employees never receive these. */
export const MANAGER_MCP_SERVER = 'agenthotel';

export interface ManagerToolDeps {
  agents: AgentService;
  tasks: TaskService;
  /** The manager agent's own id, so it cannot assign work to itself or to other managers. */
  selfId: string;
}

export function managerToolNames(): string[] {
  return ['list_agents', 'create_task', 'assign_task', 'task_status'].map(
    (n) => `mcp__${MANAGER_MCP_SERVER}__${n}`,
  );
}

/** Plain functions behind the MCP tools, so they can be unit-tested without an MCP transport. */
export function managerActions(deps: ManagerToolDeps) {
  const guardAssignee = (agentId: string) => {
    const a = deps.agents.get(agentId);
    if (!a) throw new Error(`Unknown employee ${agentId}; call list_agents first`);
    if (a.id === deps.selfId) throw new Error('A manager cannot assign work to itself');
    if (a.rolePresetId === 'manager')
      throw new Error('Delegation is flat: managers cannot delegate to other managers');
  };
  const summary = (t: ReturnType<TaskService['list']>[number]) => ({
    taskId: t.id,
    title: t.title,
    status: t.status,
    assigneeAgentId: t.assigneeAgentId,
    resultSummary: t.resultSummary,
    filesChanged: t.filesChanged.map((f) => f.path),
    costUsd: Number(t.costUsd.toFixed(4)),
  });
  return {
    listAgents: () =>
      deps.agents
        .list()
        .filter((a) => a.id !== deps.selfId && a.rolePresetId !== 'manager')
        .map((a) => ({
          id: a.id,
          name: a.name,
          role: a.rolePresetId,
          status: a.status,
          workdir: a.worktree?.path ?? a.workdir,
          currentTaskId: a.currentTaskId,
          model: a.model,
        })),
    createTask: (args: { title: string; prompt: string; assigneeAgentId?: string }) => {
      if (args.assigneeAgentId) guardAssignee(args.assigneeAgentId);
      const task = deps.tasks.create({
        title: args.title,
        prompt: args.prompt,
        assigneeAgentId: args.assigneeAgentId ?? null,
      });
      return { taskId: task.id, status: task.status, assigneeAgentId: task.assigneeAgentId };
    },
    assignTask: (args: { taskId: string; agentId: string }) => {
      guardAssignee(args.agentId);
      const task = deps.tasks.assign(args.taskId, args.agentId);
      return { taskId: task.id, status: task.status, assigneeAgentId: task.assigneeAgentId };
    },
    taskStatus: (args: { taskId?: string }) => {
      if (args.taskId) {
        const t = deps.tasks.get(args.taskId);
        return t ? summary(t) : { error: `unknown task ${args.taskId}` };
      }
      const recent = Date.now() - 60 * 60 * 1000;
      return deps.tasks
        .list()
        .filter((t) => t.status !== 'done' || t.updatedAt > recent)
        .map(summary);
    },
  };
}

export function createManagerMcpServer(deps: ManagerToolDeps): McpServerConfig {
  const actions = managerActions(deps);
  const text = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  });
  const safe = <T>(fn: () => T) => {
    try {
      return text(fn());
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  };
  return createSdkMcpServer({
    name: MANAGER_MCP_SERVER,
    version: '1.0.0',
    tools: [
      tool(
        'list_agents',
        'List the employees you can delegate to, with role, status, working directory and current task.',
        {},
        async () => safe(() => actions.listAgents()),
      ),
      tool(
        'create_task',
        'Create a task on the board. Optionally assign it right away to an employee by id (the prompt is sent to that agent).',
        {
          title: z.string().min(1).max(120).describe('Short title shown on the card'),
          prompt: z
            .string()
            .min(1)
            .describe('Full instructions for the employee, including acceptance criteria'),
          assigneeAgentId: z.string().optional().describe('Employee id from list_agents'),
        },
        async (args) => safe(() => actions.createTask(args)),
      ),
      tool(
        'assign_task',
        'Assign (or reassign) an existing task to an employee by id. Sends the task prompt to that agent.',
        { taskId: z.string().min(1), agentId: z.string().min(1) },
        async (args) => safe(() => actions.assignTask(args)),
      ),
      tool(
        'task_status',
        'Get status, result summary, files changed and cost of one task, or of every open task when taskId is omitted.',
        { taskId: z.string().optional() },
        async (args) => safe(() => actions.taskStatus(args)),
      ),
    ],
  });
}
