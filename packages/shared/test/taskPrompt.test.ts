import { describe, expect, it } from 'vitest';
import { presetById } from '../src/presets.js';
import { presetIsReadOnly, taskTail } from '../src/taskPrompt.js';

describe('taskPrompt', () => {
  it('treats QA and Reviewer as read-only', () => {
    expect(presetIsReadOnly(presetById('qa')!)).toBe(true);
    expect(presetIsReadOnly(presetById('reviewer')!)).toBe(true);
    expect(presetIsReadOnly(presetById('engineer')!)).toBe(false);
  });

  it('taskTail uses findings format for read-only presets', () => {
    const tail = taskTail(
      {
        id: 't',
        title: 'Run tests',
        prompt: 'pnpm test',
        status: 'assigned',
        assigneeAgentId: 'q1',
        parentTaskId: null,
        resultSummary: null,
        filesChanged: [],
        costUsd: 0,
        position: 0,
        createdAt: 1,
        startedAt: 1,
        completedAt: null,
        updatedAt: 1,
      },
      presetById('qa'),
    );
    expect(tail).toContain('**Findings**');
    expect(tail).not.toContain('Change only what this task asks for');
  });
});
