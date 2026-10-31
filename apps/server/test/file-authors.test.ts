import type { AgentEvent } from '@deskhaven/shared';
import { describe, expect, it } from 'vitest';
import { fileAuthors } from '../src/tasks/file-authors.js';

let n = 0;
const edit = (
  taskId: string | undefined,
  input: Record<string, unknown>,
  tool = 'Edit',
): AgentEvent => ({
  id: `e${++n}`,
  ts: n,
  agentId: 'ada',
  ...(taskId ? { taskId } : {}),
  type: 'tool_started',
  toolUseId: `t${n}`,
  tool,
  category: tool === 'Read' ? 'read' : 'edit',
  input,
  summary: '',
});

describe('fileAuthors', () => {
  it('names the task of the latest edit of each file, relative to the worktree root', () => {
    const newestFirst = [
      edit('b', { file_path: '/wt/ada/notepad.py' }),
      edit('a', { file_path: 'README.md' }),
      edit('c', { file_path: '/wt/ada/README.md' }), // older than a's edit
      edit('a', { notebook_path: '/wt/ada/nb/x.ipynb' }, 'NotebookEdit'),
    ];
    expect(Object.fromEntries(fileAuthors(newestFirst, '/wt/ada', '/wt/ada'))).toEqual({
      'notepad.py': 'b',
      'README.md': 'a',
      'nb/x.ipynb': 'a',
    });
  });

  it('resolves relative paths from a subfolder hire and a symlinked root', () => {
    const out = fileAuthors(
      [edit('a', { file_path: 'src/x.ts' }), edit('b', { file_path: '/private/wt/ada/y.ts' })],
      '/wt/ada',
      '/wt/ada/packages/app',
      '/private/wt/ada',
    );
    expect(Object.fromEntries(out)).toEqual({ 'packages/app/src/x.ts': 'a', 'y.ts': 'b' });
  });

  it('ignores reads, edits outside the worktree and edits with no task', () => {
    const out = fileAuthors(
      [
        edit('a', { file_path: '/wt/ada/r.txt' }, 'Read'),
        edit('a', { file_path: '/etc/hosts' }),
        edit(undefined, { file_path: '/wt/ada/chat.txt' }),
      ],
      '/wt/ada',
      '/wt/ada',
    );
    expect(out.size).toBe(0);
  });
});
