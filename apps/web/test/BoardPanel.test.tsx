// @vitest-environment happy-dom
import { AgentSchema, emptyUsage } from '@deskhaven/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/worldHandle.js', () => ({ getWorldHandle: () => null }));
vi.mock('../src/ui/AvatarPicker.js', () => ({ AvatarPreview: () => null }));

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
      createTask: vi.fn(),
      updateTask: vi.fn(),
      assignTask: vi.fn(),
      deleteTask: vi.fn(),
    },
  };
});

import { ApiError, api } from '../src/net/api.js';
import { useAppStore } from '../src/state/store.js';
import { BoardPanel } from '../src/ui/BoardPanel.js';

const ada = AgentSchema.parse({
  id: 'ada',
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
  allowedTools: ['Read'],
  permissionMode: 'default',
  workdir: '/repo',
  worktree: { path: '/wt', branch: 'deskhaven/ada' },
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

describe('BoardPanel create task', () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({ agents: {}, tasks: {}, notices: [] });
    vi.clearAllMocks();
  });

  it('shows the self_review error from the API', async () => {
    const rev = AgentSchema.parse({ ...ada, id: 'rev', name: 'Rev', worktree: null });
    useAppStore.setState({ agents: { ada, rev } });
    vi.mocked(api.createTask).mockRejectedValue(
      new ApiError('An agent cannot review its own worktree. Pick a different reviewer.', 400, {
        error: 'self_review',
        message: 'An agent cannot review its own worktree. Pick a different reviewer.',
      }),
    );
    render(<BoardPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByPlaceholderText('Title'), { target: { value: 'Review myself' } });
    fireEvent.change(screen.getByPlaceholderText(/What should the agent do/), {
      target: { value: 'no' },
    });
    const selects = screen.getAllByRole('combobox');
    const assigneeSelect = selects[0];
    const reviewSelect = selects[1];
    if (!assigneeSelect || !reviewSelect) throw new Error('expected assignee and review selects');
    fireEvent.change(reviewSelect, { target: { value: 'ada' } });
    fireEvent.change(assigneeSelect, { target: { value: 'rev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create & assign' }));
    await vi.waitFor(() => {
      expect(
        useAppStore
          .getState()
          .notices.some((n) => /cannot review its own worktree/i.test(n.message)),
      ).toBe(true);
    });
    expect(api.createTask).toHaveBeenCalled();
  });
});
