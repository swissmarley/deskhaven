import path from 'node:path';
import type { AgentEvent } from '@deskhaven/shared';

/**
 * Which task last edited each file, from the agent's logged edit-tool calls (Edit, Write,
 * NotebookEdit carry the file path and the task in progress). Works for changes made before the
 * worktree comparison existed, which attribute the branch to no task. Files changed only through
 * Bash have no such event and stay unknown.
 *
 * `events` newest first; paths in the result are relative to the worktree root with `/`, like
 * `git status`. Absolute paths outside the worktree are ignored.
 */
export function fileAuthors(
  events: readonly AgentEvent[],
  worktreeRoot: string,
  cwd: string,
  realRoot?: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const roots = realRoot && realRoot !== worktreeRoot ? [worktreeRoot, realRoot] : [worktreeRoot];
  for (const e of events) {
    if (e.type !== 'tool_started' || e.category !== 'edit' || !e.taskId) continue;
    const input = (e.input ?? {}) as Record<string, unknown>;
    const raw =
      typeof input.file_path === 'string'
        ? input.file_path
        : typeof input.notebook_path === 'string'
          ? input.notebook_path
          : null;
    if (!raw) continue;
    const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw);
    for (const root of roots) {
      const rel = path.relative(root, abs);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const key = rel.split(path.sep).join('/');
      // Newest first: the first event seen for a file is its latest edit.
      if (!out.has(key)) out.set(key, e.taskId);
      break;
    }
  }
  return out;
}
