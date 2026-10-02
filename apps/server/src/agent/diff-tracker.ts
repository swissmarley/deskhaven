import fs from 'node:fs';
import path from 'node:path';
import type { FileDiff } from '@agenthotel/shared';
import { createTwoFilesPatch } from 'diff';

const MAX_SNAPSHOT_BYTES = 512 * 1024;

/**
 * Produces unified diffs for Edit / Write / MultiEdit tool calls. Write needs a snapshot of the file
 * before the tool runs (taken at PreToolUse); Edit carries old/new strings in its input.
 */
export class DiffTracker {
  private readonly snapshots = new Map<string, { filePath: string; before: string | null }>();

  constructor(private readonly cwd: string) {}

  onPreTool(toolUseId: string, toolName: string, input: unknown): void {
    if (toolName !== 'Write') return;
    const filePath = this.pathOf(input);
    if (!filePath) return;
    let before: string | null = null;
    try {
      const st = fs.statSync(filePath);
      if (st.isFile() && st.size <= MAX_SNAPSHOT_BYTES) before = fs.readFileSync(filePath, 'utf8');
    } catch {
      before = null; // new file
    }
    this.snapshots.set(toolUseId, { filePath, before });
  }

  onPostTool(toolUseId: string, toolName: string, input: unknown): FileDiff[] {
    const rec = (input ?? {}) as Record<string, unknown>;
    const rel = (p: string) =>
      path.isAbsolute(p) ? path.relative(this.cwd, p) || path.basename(p) : p;
    switch (toolName) {
      case 'Write': {
        const snap = this.snapshots.get(toolUseId);
        this.snapshots.delete(toolUseId);
        const filePath = snap?.filePath ?? this.pathOf(input);
        if (!filePath) return [];
        const after = typeof rec.content === 'string' ? rec.content : safeRead(filePath);
        return [patch(rel(filePath), snap?.before ?? '', after ?? '')];
      }
      case 'Edit': {
        const filePath = this.pathOf(input);
        if (!filePath || typeof rec.old_string !== 'string' || typeof rec.new_string !== 'string')
          return [];
        return [patch(rel(filePath), rec.old_string, rec.new_string)];
      }
      case 'MultiEdit': {
        const filePath = this.pathOf(input);
        const edits = Array.isArray(rec.edits) ? (rec.edits as Record<string, unknown>[]) : [];
        if (!filePath) return [];
        return edits
          .filter((e) => typeof e.old_string === 'string' && typeof e.new_string === 'string')
          .map((e) => patch(rel(filePath), e.old_string as string, e.new_string as string));
      }
      default:
        return [];
    }
  }

  private pathOf(input: unknown): string | null {
    const rec = (input ?? {}) as Record<string, unknown>;
    const p =
      typeof rec.file_path === 'string'
        ? rec.file_path
        : typeof rec.notebook_path === 'string'
          ? rec.notebook_path
          : null;
    if (!p) return null;
    return path.isAbsolute(p) ? p : path.join(this.cwd, p);
  }
}

function safeRead(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

export function patch(filePath: string, before: string, after: string): FileDiff {
  const text = createTwoFilesPatch(filePath, filePath, before, after, '', '', { context: 3 });
  let additions = 0;
  let deletions = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { path: filePath, patch: text, additions, deletions };
}

/** True when `target` is inside `root` (or equals it). Both are resolved to absolute paths. */
export function isInside(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  const rel = path.relative(r, t);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
