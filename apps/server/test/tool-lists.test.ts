import { BUILTIN_PRESETS, type RolePreset } from '@deskhaven/shared';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.js';
import { rolePresets } from '../src/db/schema.js';
import { hashRolePreset } from '../src/presets/presetBuiltin.js';
import { PresetService } from '../src/presets/service.js';
import { managerHarness } from './manager-harness.js';

const shipped = (id: string): RolePreset => {
  const p = BUILTIN_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(id);
  return p;
};

describe('agent tool lists', () => {
  it('cleans agents saved with retired or unavailable tools at boot, and leaves clean ones', () => {
    const h = managerHarness();
    const eng = h.hire('Tester-Eng');
    const rev = h.agents.create({
      name: 'Tester-Rev',
      rolePresetId: 'reviewer',
      workdir: process.cwd(),
      useWorktree: false,
    });
    // As stored before this release.
    h.agents.patch(eng.id, (a) => ({
      ...a,
      tools: null,
      allowedTools: [
        'Read',
        'Grep',
        'Glob',
        'LS',
        'Edit',
        'Write',
        'MultiEdit',
        'NotebookEdit',
        'TodoWrite',
      ],
    }));
    h.agents.patch(rev.id, (a) => ({
      ...a,
      tools: ['Read', 'Grep', 'Glob', 'LS'],
      allowedTools: ['Read', 'Grep', 'Glob', 'LS'],
    }));
    expect(h.agents.normalizeToolLists().sort()).toEqual(['Tester-Eng', 'Tester-Rev']);
    expect(h.agents.get(eng.id)?.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write']);
    expect(h.agents.get(rev.id)).toMatchObject({
      tools: ['Read', 'Grep', 'Glob'],
      allowedTools: ['Read', 'Grep', 'Glob'],
    });
    expect(h.agents.normalizeToolLists()).toEqual([]);
  });

  it('keeps hire and edit from saving tools the agent cannot use', () => {
    const h = managerHarness();
    const a = h.agents.create({
      name: 'Ada',
      rolePresetId: 'engineer',
      workdir: process.cwd(),
      useWorktree: false,
      allowedTools: ['Read', 'LS', 'WebFetch'],
    });
    expect(a.allowedTools).toEqual(['Read']);
    const edited = h.agents.update(a.id, {
      allowedTools: ['Read', 'Bash(pnpm test:*)', 'MultiEdit'],
    });
    expect(edited.allowedTools).toEqual(['Read', 'Bash(pnpm test:*)']);
  });

  it('updates an unmodified reviewer preset that still listed LS', () => {
    const current = shipped('reviewer');
    const withLs: RolePreset = {
      ...current,
      tools: [...(current.tools ?? []), 'LS'],
      allowedTools: [...current.allowedTools, 'LS'],
    };
    const { db } = openDb(':memory:');
    db.insert(rolePresets)
      .values({
        id: 'reviewer',
        json: JSON.stringify(withLs),
        builtin: 1,
        baseHash: hashRolePreset(withLs),
      })
      .run();
    expect(new PresetService(db).get('reviewer')).toEqual(current);
  });
});
