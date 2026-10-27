import { BUILTIN_PRESETS, ENGINEER_PRESET_LEGACY, type RolePreset } from '@deskhaven/shared';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.js';
import { rolePresets } from '../src/db/schema.js';
import { PresetService } from '../src/presets/service.js';

describe('PresetService', () => {
  it('migrates engineer when the DB still holds the legacy built-in unchanged', () => {
    const { db } = openDb(':memory:');
    db.insert(rolePresets)
      .values({
        id: 'engineer',
        json: JSON.stringify(ENGINEER_PRESET_LEGACY),
        builtin: 1,
      })
      .run();
    const svc = new PresetService(db);
    const stored = svc.get('engineer');
    const shipped = BUILTIN_PRESETS.find((p) => p.id === 'engineer');
    expect(stored).toEqual(shipped);
    expect(svc.list().find((p) => p.id === 'engineer')?.builtinUpdatePending).toBeFalsy();
  });

  it('flags builtinUpdatePending when engineer was customized away from shipped', () => {
    const { db } = openDb(':memory:');
    const customized: RolePreset = {
      ...ENGINEER_PRESET_LEGACY,
      description: 'My custom engineer blurb',
    };
    db.insert(rolePresets)
      .values({
        id: 'engineer',
        json: JSON.stringify(customized),
        builtin: 1,
      })
      .run();
    const svc = new PresetService(db);
    expect(svc.get('engineer')?.description).toBe('My custom engineer blurb');
    expect(svc.list().find((p) => p.id === 'engineer')?.builtinUpdatePending).toBe(true);
  });
});
