import { describe, expect, it } from 'vitest';
import { agentIsManagerRole } from '../src/models.js';
import { presetById } from '../src/presets.js';
import { agentCanEdit, taskTail } from '../src/taskPrompt.js';

const baseTask = {
  id: 't',
  title: 'Work',
  prompt: 'Do it',
  status: 'assigned' as const,
  assigneeAgentId: 'a1',
  parentTaskId: null,
  resultSummary: null,
  filesChanged: [],
  costUsd: 0,
  position: 0,
  createdAt: 1,
  startedAt: 1,
  completedAt: null,
  updatedAt: 1,
};

describe('agentCanEdit', () => {
  it('uses tools only and ignores Bash', () => {
    expect(agentCanEdit(['Read', 'Edit'])).toBe(true);
    expect(agentCanEdit(['Read'])).toBe(false);
    expect(agentCanEdit(['Read', 'Bash'])).toBe(false);
    expect(agentCanEdit(['Bash(npm test:*)'])).toBe(false);
  });

  it('treats tools null as able to edit', () => {
    expect(agentCanEdit(null)).toBe(true);
  });
});

describe('taskTail', () => {
  it('uses findings format for reviewer', () => {
    const reviewer = presetById('reviewer');
    if (!reviewer) throw new Error('missing reviewer preset');
    const tail = taskTail(
      baseTask,
      {
        tools: reviewer.tools,
        allowedTools: reviewer.allowedTools,
        permissionMode: reviewer.permissionMode,
        rolePresetId: 'reviewer',
      },
      presetById,
    );
    expect(tail).toContain('**Findings**');
    expect(tail).not.toContain('Change only what this task asks for');
  });

  it('uses findings format for QA even with Bash in tools', () => {
    const qa = presetById('qa');
    if (!qa) throw new Error('missing qa preset');
    expect(qa.taskStyle).toBe('review');
    const tail = taskTail(
      baseTask,
      {
        tools: qa.tools,
        allowedTools: qa.allowedTools,
        permissionMode: qa.permissionMode,
        rolePresetId: 'qa',
      },
      presetById,
    );
    expect(tail).toContain('**Findings**');
    expect(tail).not.toContain('**Changed**');
  });

  it('uses implementation format for managers even without edit tools', () => {
    const manager = presetById('manager');
    if (!manager) throw new Error('missing manager preset');
    const tail = taskTail(
      baseTask,
      {
        tools: manager.tools,
        allowedTools: manager.allowedTools,
        permissionMode: manager.permissionMode,
        rolePresetId: 'manager',
      },
      presetById,
    );
    expect(tail).toContain('Change only what this task asks for');
    expect(tail).toContain('**Changed**');
  });

  it('uses implementation format for custom manager presets via lookup', () => {
    const customManager = {
      id: 'cto',
      name: 'CTO',
      description: 'Delegates',
      systemPrompt: 'Delegate',
      tools: ['Read'],
      allowedTools: ['Read'],
      permissionMode: 'default' as const,
      manager: true,
    };
    const lookup = (id: string) => (id === 'cto' ? customManager : presetById(id));
    const assignee = {
      tools: customManager.tools,
      allowedTools: customManager.allowedTools,
      permissionMode: customManager.permissionMode,
      rolePresetId: 'cto',
    };
    expect(agentIsManagerRole(assignee, customManager)).toBe(true);
    const tail = taskTail(baseTask, assignee, lookup);
    expect(tail).toContain('**Changed**');
  });

  it('uses implementation format for engineers', () => {
    const engineer = presetById('engineer');
    if (!engineer) throw new Error('missing engineer preset');
    const tail = taskTail(
      baseTask,
      {
        tools: engineer.tools,
        allowedTools: engineer.allowedTools,
        permissionMode: engineer.permissionMode,
        rolePresetId: 'engineer',
      },
      presetById,
    );
    expect(tail).toContain('**Changed**');
  });
});
