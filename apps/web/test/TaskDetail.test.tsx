// @vitest-environment happy-dom
import { AgentSchema, emptyUsage, type Task, TaskSchema } from '@deskhaven/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/net/api.js', () => {
  class ApiError extends Error {
    readonly status: number;
    readonly body: Record<string, unknown>;
    constructor(message: string, status: number, body: Record<string, unknown>) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
  }
  return {
    ApiError,
    api: {
      mergePreview: vi.fn(),
      mergeTask: vi.fn(),
      resolveMerge: vi.fn(),
      updateTask: vi.fn(),
      assignTask: vi.fn(),
      createTask: vi.fn(),
      deleteTask: vi.fn(),
      nudgeTask: vi.fn(),
    },
  };
});

import { ApiError, api } from '../src/net/api.js';
import { useAppStore } from '../src/state/store.js';
import { TaskDetail } from '../src/ui/TaskDetail.js';

const agent = AgentSchema.parse({
  id: 'eng',
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
  allowedTools: ['Read', 'Edit'],
  permissionMode: 'default',
  workdir: '/repo',
  worktree: {
    path: '/wt/ada',
    branch: 'deskhaven/ada',
    baseBranch: 'main',
    sourceRoot: '/repo',
  },
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

function task(extra: Partial<Task> = {}): Task {
  return TaskSchema.parse({
    id: 't1',
    title: 'Ship it',
    prompt: 'make the change',
    status: 'review',
    assigneeAgentId: 'eng',
    parentTaskId: null,
    resultSummary: null,
    filesChanged: [],
    costUsd: 0,
    position: 1,
    createdAt: 1,
    startedAt: 1,
    completedAt: null,
    updatedAt: 1,
    merge: null,
    reviewTarget: null,
    ...extra,
  });
}

const preview = {
  branch: 'deskhaven/ada',
  targetBranch: 'main',
  sourceRoot: '/repo',
  worktreePath: '/wt/ada',
  ahead: 1,
  behind: 0,
  dirty: false,
  files: [{ path: 'b.txt', status: 'A' }],
  canMerge: true,
  branchSha: 'abc1234567890',
};

describe('TaskDetail merge conflict', () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({ agents: {}, tasks: {}, notices: [] });
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.mocked(api.mergePreview).mockResolvedValue(preview);
  });

  it('confirms, then shows Ask agent to resolve from the 409 body', async () => {
    useAppStore.setState({ agents: { eng: agent }, tasks: { t1: task() } });
    const conflicted = task({
      merge: {
        status: 'conflict',
        strategy: 'squash',
        branch: 'deskhaven/ada',
        targetBranch: 'main',
        commit: null,
        conflictFiles: ['a.txt'],
        error: 'Merge conflict. The source checkout was restored.',
        mergedAt: null,
      },
      updatedAt: 2,
    });
    vi.mocked(api.mergeTask).mockRejectedValue(
      new ApiError('Merge conflict. The source checkout was restored.', 409, {
        error: 'conflict',
        task: conflicted,
        conflictFiles: ['a.txt'],
      }),
    );

    render(<TaskDetail taskId="t1" onClose={() => {}} />);
    expect(await screen.findByText(/deskhaven\/ada → main/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept & merge' }));
    expect(api.mergeTask).not.toHaveBeenCalled();
    fireEvent.change(screen.getByDisplayValue('Squash (default)'), { target: { value: 'merge' } });
    expect(screen.getByRole('button', { name: 'Accept & merge' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept & merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));
    expect(await screen.findByRole('button', { name: 'Ask agent to resolve' })).toBeTruthy();
    expect(screen.getByText('a.txt')).toBeTruthy();
    expect(useAppStore.getState().tasks.t1?.merge?.status).toBe('conflict');
    expect(api.mergeTask).toHaveBeenCalledWith('t1', {
      strategy: 'merge',
      expectedBranchSha: 'abc1234567890',
      consentedHookFiles: [],
      previewDirty: false,
    });
  });

  it('cancels merge confirmation without calling the API', async () => {
    useAppStore.setState({ agents: { eng: agent }, tasks: { t1: task() } });
    render(<TaskDetail taskId="t1" onClose={() => {}} />);
    await screen.findByText(/deskhaven\/ada → main/);
    fireEvent.click(screen.getByRole('button', { name: 'Accept & merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Accept & merge' })).toBeTruthy();
    expect(api.mergeTask).not.toHaveBeenCalled();
  });

  it('requires hook consent before merge when preview lists hook files', async () => {
    vi.mocked(api.mergePreview).mockResolvedValue({
      ...preview,
      hookFiles: ['.husky/pre-commit'],
      hooksWarning: 'This merge changes git hook scripts (.husky/pre-commit).',
    });
    useAppStore.setState({ agents: { eng: agent }, tasks: { t1: task() } });
    render(<TaskDetail taskId="t1" onClose={() => {}} />);
    await screen.findByText(/hook scripts/i);
    fireEvent.click(screen.getByRole('button', { name: 'Accept & merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));
    expect(api.mergeTask).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /reviewed the hook changes/i,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Accept & merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge' }));
    expect(api.mergeTask).toHaveBeenCalledWith('t1', {
      strategy: 'squash',
      expectedBranchSha: 'abc1234567890',
      consentedHookFiles: ['.husky/pre-commit'],
      previewDirty: false,
      allowHookChanges: true,
    });
  });

  it('expires merge confirmation after ten seconds', async () => {
    vi.useFakeTimers();
    useAppStore.setState({ agents: { eng: agent }, tasks: { t1: task() } });
    render(<TaskDetail taskId="t1" onClose={() => {}} />);
    await vi.waitFor(() => screen.getByText(/deskhaven\/ada → main/));
    fireEvent.click(screen.getByRole('button', { name: 'Accept & merge' }));
    expect(screen.getByRole('button', { name: 'Confirm merge' })).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByRole('button', { name: 'Accept & merge' })).toBeTruthy();
    expect(api.mergeTask).not.toHaveBeenCalled();
  });
});
