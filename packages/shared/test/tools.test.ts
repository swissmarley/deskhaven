import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  normalizeToolLists,
  RETIRED_TOOLS,
  toolRuleName,
  truncateBlock,
} from '../src/index.js';

const ENGINEER_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'];

describe('normalizeToolLists', () => {
  it('trims an engineer hired before the preset was narrowed (Tester-Eng)', () => {
    const out = normalizeToolLists(
      null,
      ['Read', 'Grep', 'Glob', 'LS', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'TodoWrite'],
      ENGINEER_TOOLS,
    );
    expect(out).toEqual({ tools: null, allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'] });
  });

  it('drops a retired tool from both lists (Tester-Rev)', () => {
    const out = normalizeToolLists(
      ['Read', 'Grep', 'Glob', 'LS'],
      ['Read', 'Grep', 'Glob', 'LS'],
      ['Read', 'Grep', 'Glob'],
    );
    expect(out).toEqual({
      tools: ['Read', 'Grep', 'Glob'],
      allowedTools: ['Read', 'Grep', 'Glob'],
    });
  });

  it('keeps scoped rules for tools the agent has, and everything but retired names without a list', () => {
    expect(
      normalizeToolLists(['Read', 'Bash'], ['Read', 'Bash(pnpm test:*)', 'Edit'], null)
        .allowedTools,
    ).toEqual(['Read', 'Bash(pnpm test:*)']);
    expect(normalizeToolLists(null, ['Edit', 'LS', 'WebFetch'], null)).toEqual({
      tools: null,
      allowedTools: ['Edit', 'WebFetch'],
    });
    expect(toolRuleName('Bash(npm test:*)')).toBe('Bash');
  });

  it('ships presets without retired tools or unusable auto-approvals', () => {
    for (const p of BUILTIN_PRESETS) {
      for (const t of [...(p.tools ?? []), ...p.allowedTools])
        expect(RETIRED_TOOLS.has(toolRuleName(t)), `${p.id}: ${t}`).toBe(false);
      expect(normalizeToolLists(p.tools, p.allowedTools, p.tools).allowedTools).toEqual(
        p.allowedTools,
      );
    }
  });
});

describe('truncateBlock', () => {
  it('shortens markdown without flattening its lines', () => {
    expect(truncateBlock('## Changed\n- a\n\n## How to verify\n- b\n\n', 100)).toBe(
      '## Changed\n- a\n\n## How to verify\n- b',
    );
    expect(truncateBlock('line one\nline two', 12)).toBe('line one\nli…');
  });
});
