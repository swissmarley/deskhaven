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
  previewTree: '0000000000000000000000000000000000000001',
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
      previewTree: '0000000000000000000000000000000000000001',
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
    const accept = screen.getByRole('button', { name: 'Accept & merge' }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    expect(screen.getByText(/Tick one of the options above/)).toBeTruthy();
    fireEvent.click(accept);
    expect(screen.queryByRole('button', { name: 'Confirm merge' })).toBeNull();
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
      previewTree: '0000000000000000000000000000000000000001',
      allowHookChanges: true,
    });
  });

  it('keeps the confirmation open while the user reads it, and expires it after a minute', async () => {
    vi.useFakeTimers();
    useAppStore.setState({ agents: { eng: agent }, tasks: { t1: task() } });
    render(<TaskDetail taskId="t1" onClose={() => {}} />);
    await vi.waitFor(() => screen.getByText(/deskhaven\/ada → main/));
    fireEvent.click(screen.getByRole('button', { name: 'Accept & merge' }));
    expect(screen.getByRole('alertdialog', { name: 'Confirm merge' }).textContent).toMatch(
      /Merge 1 commit \(1 file\) from deskhaven\/ada into main as a squash commit/,
    );
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByRole('button', { name: 'Confirm merge' })).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByRole('button', { name: 'Accept & merge' })).toBeTruthy();
    expect(api.mergeTask).not.toHaveBeenCalled();
  });

  it('keeps "Accept & merge" disabled until the preview has loaded', async () => {
    let resolve: (p: typeof preview) => void = () => {};
    vi.mocked(api.mergePreview).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    useAppStore.setState({ agents: { eng: agent }, tasks: { t1: task() } });
    render(<TaskDetail taskId="t1" onClose={() => {}} />);
    const early = screen.getByRole('button', { name: 'Accept & merge' }) as HTMLButtonElement;
    expect(early.disabled).toBe(true);
    // A click while the preview is on its way used to open a confirmation the preview then closed.
    fireEvent.click(early);
    expect(screen.queryByRole('button', { name: 'Confirm merge' })).toBeNull();
    await act(async () => {
      resolve(preview);
    });
    const ready = screen.getByRole('button', { name: 'Accept & merge' }) as HTMLButtonElement;
    expect(ready.disabled).toBe(false);
    fireEvent.click(ready);
    expect(screen.getByRole('button', { name: 'Confirm merge' })).toBeTruthy();
  });

  it('withdraws an open confirmation with a notice when the branch changes', async () => {
    useAppStore.setState({ agents: { eng: agent }, tasks: { t1: task() } });
    render(<TaskDetail taskId="t1" onClose={() => {}} />);
    await screen.findByText(/deskhaven\/ada → main/);
    fireEvent.click(screen.getByRole('button', { name: 'Accept & merge' }));
    vi.mocked(api.mergePreview).mockResolvedValue({ ...preview, ahead: 2, branchSha: 'def' });
    await act(async () => {
      useAppStore.setState({ tasks: { t1: task({ updatedAt: 5 }) } });
    });
    await screen.findByText(/2 ahead/);
    expect(screen.queryByRole('button', { name: 'Confirm merge' })).toBeNull();
    expect(screen.getByText(/branch changed while the confirmation was open/)).toBeTruthy();
  });

  it('shows "Nothing to merge" instead of the merge button for an empty branch', async () => {
    vi.mocked(api.mergePreview).mockResolvedValue({
      ...preview,
      ahead: 0,
      files: [],
      canMerge: false,
      reason: 'Nothing to merge',
    });
    useAppStore.setState({ agents: { eng: agent }, tasks: { t1: task({ status: 'done' }) } });
    render(<TaskDetail taskId="t1" onClose={() => {}} />);
    expect(await screen.findByText('Nothing to merge.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept & merge' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy git commands' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Go to merge' })).toBeNull();
  });

  it('places the merge section above the prompt and result', async () => {
    useAppStore.setState({
      agents: { eng: agent },
      tasks: { t1: task({ resultSummary: 'A very long result' }) },
    });
    render(<TaskDetail taskId="t1" onClose={() => {}} />);
    await screen.findByText(/deskhaven\/ada → main/);
    const merge = screen.getByRole('heading', { name: 'Merge' });
    const prompt = screen.getByRole('heading', { name: 'Prompt' });
    expect(merge.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Go to merge' })).toBeTruthy();
  });

  it('tells the user when an open confirmation expired', async () => {
    vi.useFakeTimers();
    useAppStore.setState({ agents: { eng: agent }, tasks: { t1: task() } });
    render(<TaskDetail taskId="t1" onClose={() => {}} />);
    await vi.waitFor(() => screen.getByText(/deskhaven\/ada → main/));
    fireEvent.click(screen.getByRole('button', { name: 'Accept & merge' }));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText(/confirmation expired after a minute/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept & merge' }));
    expect(screen.queryByText(/confirmation expired/)).toBeNull();
  });

  it("offers no merge on a done task whose branch holds the agent's later task", async () => {
    vi.mocked(api.mergePreview).mockResolvedValue({
      ...preview,
      ahead: 0,
      dirty: true,
      files: [{ path: 'notepad.py', status: ' M' }],
      canMerge: false,
      reason: 'The changes on the branch belong to "notepad.py header comment"',
      ownerTask: { id: 't2', title: 'notepad.py header comment', status: 'review' },
    });
    useAppStore.setState({
      agents: { eng: agent },
      tasks: { t1: task({ title: 'Fix filetypes kwarg', status: 'done' }) },
    });
    render(<TaskDetail taskId="t1" onClose={() => {}} />);
    expect(await screen.findByText('Nothing to merge for this task.')).toBeTruthy();
    expect(screen.getByText(/belong to "notepad.py header comment"/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept & merge' })).toBeNull();
  });

  it("offers no merge on a review task either when the agent's later task made the changes", async () => {
    vi.mocked(api.mergePreview).mockResolvedValue({
      ...preview,
      canMerge: false,
      reason: 'The changes on the branch belong to "Later task"',
      ownerTask: { id: 't2', title: 'Later task', status: 'review' },
    });
    useAppStore.setState({ agents: { eng: agent }, tasks: { t1: task() } });
    render(<TaskDetail taskId="t1" onClose={() => {}} />);
    expect(await screen.findByText('Nothing to merge for this task.')).toBeTruthy();
    expect(screen.getByText(/belong to "Later task"/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept & merge' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeTruthy();
  });

  it('names the other task whose changes the merge brings in, file by file', async () => {
    vi.mocked(api.mergePreview).mockResolvedValue({
      ...preview,
      dirty: true,
      files: [
        { path: 'README.md', status: ' M', author: { taskId: 't1', title: 'Ship it' } },
        { path: 'notepad.py', status: ' M', author: { taskId: 't2', title: 'notepad header' } },
        { path: 'by-shell.txt', status: '??', author: null },
      ],
    });
    useAppStore.setState({ agents: { eng: agent }, tasks: { t1: task() } });
    render(<TaskDetail taskId="t1" onClose={() => {}} />);
    expect(
      await screen.findByText('It also brings in the changes of "notepad header": notepad.py.'),
    ).toBeTruthy();
    expect(screen.getByText(/No task's edit is logged for by-shell.txt/)).toBeTruthy();
    expect(screen.getByText('— this task')).toBeTruthy();
    expect(screen.getByText('— "notepad header"')).toBeTruthy();
    expect(screen.getByText('— origin unknown')).toBeTruthy();
  });

  it('links a task whose changes went in with another task to that task and commit', () => {
    useAppStore.setState({
      agents: { eng: agent },
      tasks: {
        t1: task({
          title: 'README run note',
          status: 'done',
          merge: {
            status: 'merged',
            strategy: 'squash',
            branch: 'deskhaven/ada',
            targetBranch: 'main',
            commit: '85c9a05aaaaaaa',
            conflictFiles: [],
            error: null,
            mergedAt: 2,
            viaTaskId: 't2',
          },
        }),
        t2: task({ id: 't2', title: 'Final: comment above open_file', status: 'done' }),
      },
    });
    render(<TaskDetail taskId="t1" onClose={() => {}} />);
    expect(
      screen.getByText(/Its changes went in with "Final: comment above open_file"/).textContent,
    ).toContain('85c9a05');
  });

  it('tells how to reach the merge when the owning task is not in review yet', async () => {
    vi.mocked(api.mergePreview).mockResolvedValue({
      ...preview,
      canMerge: false,
      ownerTask: { id: 't2', title: 'Final: comment above open_file', status: 'needs_input' },
    });
    useAppStore.setState({ agents: { eng: agent }, tasks: { t1: task() } });
    render(<TaskDetail taskId="t1" onClose={() => {}} />);
    expect(await screen.findByText(/once it is in Review/)).toBeTruthy();
    expect(screen.getByText(/a task in needs input has no merge controls/)).toBeTruthy();
  });
});
