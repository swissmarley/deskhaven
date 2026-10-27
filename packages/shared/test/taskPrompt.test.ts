import { describe, expect, it } from 'vitest';
import { presetById } from '../src/presets.js';
import { agentCanEdit, agentIsManagerRole, taskTail } from '../src/taskPrompt.js';

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
  it('uses tools only, not allowedTools', () => {
    expect(agentCanEdit(['Read', 'Edit'], ['Read'], 'default')).toBe(true);
    expect(agentCanEdit(['Read'], ['Edit'], 'default')).toBe(false);
  });

  it('treats tools null as able to edit', () => {
    expect(agentCanEdit(null, ['Read', 'Grep'], 'default')).toBe(true);
  });

  it('treats unrestricted Bash as able to edit', () => {
    expect(agentCanEdit(['Read', 'Bash'], [], 'default')).toBe(true);
    expect(agentCanEdit(['Bash(npm test:*)'], [], 'default')).toBe(false);
  });
});

describe('taskTail', () => {
  it('uses findings format for agents that cannot edit', () => {
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
    expect(agentIsManagerRole('cto', lookup)).toBe(true);
    const tail = taskTail(
      baseTask,
      {
        tools: customManager.tools,
        allowedTools: customManager.allowedTools,
        permissionMode: customManager.permissionMode,
        rolePresetId: 'cto',
      },
      lookup,
    );
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
