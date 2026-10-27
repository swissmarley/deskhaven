import { describe, expect, it } from 'vitest';
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
  it('requires edit tools in both tools and allowedTools when tools is a list', () => {
    expect(agentCanEdit(['Read'], ['Edit'], 'default')).toBe(false);
    expect(agentCanEdit(['Read', 'Edit'], ['Edit'], 'default')).toBe(true);
  });

  it('treats tools null as the full tool surface when allowedTools permit edits', () => {
    expect(agentCanEdit(null, ['Edit', 'Read'], 'default')).toBe(true);
    expect(agentCanEdit(null, ['Read', 'Grep'], 'default')).toBe(false);
  });
});

describe('taskTail', () => {
  it('uses findings format for agents that cannot edit', () => {
    const qa = presetById('qa');
    if (!qa) throw new Error('missing qa preset');
    const tail = taskTail(
      baseTask,
      { tools: qa.tools, allowedTools: qa.allowedTools, permissionMode: qa.permissionMode },
      qa,
    );
    expect(tail).toContain('**Findings**');
    expect(tail).toContain('Out-of-scope changes (not asked for by the task)');
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
      },
      manager,
    );
    expect(tail).toContain('Change only what this task asks for');
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
      },
      engineer,
    );
    expect(tail).toContain('**Changed**');
  });
});
