// @vitest-environment happy-dom
import { AgentSchema, emptyUsage, TaskSchema } from '@deskhaven/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/worldHandle.js', () => ({ getWorldHandle: () => null }));
vi.mock('../src/ui/AvatarPicker.js', () => ({ AvatarPreview: () => null }));
vi.mock('../src/ui/TaskDetail.js', () => ({
  TaskDetail: ({ taskId }: { taskId: string }) => <div role="dialog">detail {taskId}</div>,
}));

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
import { BoardPanel, isClickDrag } from '../src/ui/BoardPanel.js';

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

describe('BoardPanel cards', () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({ agents: {}, tasks: {}, notices: [] });
  });

  const done = TaskSchema.parse({
    id: 'd1',
    title: 'Fix filetypes kwarg',
    prompt: 'p',
    status: 'done',
    assigneeAgentId: 'ada',
    parentTaskId: null,
    resultSummary: 'All done.',
    filesChanged: [],
    costUsd: 0,
    position: 1,
    createdAt: 1,
    startedAt: 1,
    completedAt: 2,
    updatedAt: 2,
    merge: null,
    reviewTarget: null,
  });

  it('opens a task from anywhere on its card, not only the title', () => {
    useAppStore.setState({ agents: { ada }, tasks: { d1: done } });
    render(<BoardPanel />);
    // The summary is the part left in view when a card is scrolled half out of the column.
    fireEvent.click(screen.getByText('All done.'));
    expect(screen.getByRole('dialog').textContent).toBe('detail d1');
  });

  it('opens a task from the keyboard', () => {
    useAppStore.setState({ agents: { ada }, tasks: { d1: done } });
    render(<BoardPanel />);
    const card = screen.getByText('All done.').closest('.card-task');
    if (!card) throw new Error('no card');
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('keeps the column head outside the scrolling card list', () => {
    useAppStore.setState({ agents: { ada }, tasks: { d1: done } });
    const { container } = render(<BoardPanel />);
    const list = container.querySelector('.col-done .column-cards');
    expect(list?.querySelector('.column-head')).toBeNull();
    expect(list?.querySelectorAll('.card-task')).toHaveLength(1);
  });
});

describe('click versus drag on a card', () => {
  it('treats a drag of a few pixels as a click and a real drag as a drag', () => {
    expect(isClickDrag({ x: 6, y: 5 })).toBe(true);
    expect(isClickDrag({ x: 0, y: 11 })).toBe(true);
    expect(isClickDrag({ x: 10, y: 10 })).toBe(false);
    expect(isClickDrag({ x: 140, y: 0 })).toBe(false);
  });
});
