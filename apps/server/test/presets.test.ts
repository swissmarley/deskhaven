import {
  BUILTIN_PRESETS,
  ENGINEER_PRESET_LEGACY,
  ENGINEER_PRESET_LEGACY_HASH,
  hashRolePreset,
  type RolePreset,
} from '@deskhaven/shared';
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
        baseHash: ENGINEER_PRESET_LEGACY_HASH,
      })
      .run();
    const svc = new PresetService(db);
    const stored = svc.get('engineer');
    const shipped = BUILTIN_PRESETS.find((p) => p.id === 'engineer');
    expect(stored).toEqual(shipped);
    expect(svc.list().find((p) => p.id === 'engineer')?.builtinUpdatePending).toBeFalsy();
  });

  it('flags builtinUpdatePending only when shipped moved past base_hash', () => {
    const { db } = openDb(':memory:');
    const shipped = BUILTIN_PRESETS.find((p) => p.id === 'engineer');
    expect(shipped).toBeDefined();
    const customized: RolePreset = {
      ...shipped!,
      description: 'My custom engineer blurb',
    };
    db.insert(rolePresets)
      .values({
        id: 'engineer',
        json: JSON.stringify(customized),
        builtin: 1,
        baseHash: ENGINEER_PRESET_LEGACY_HASH,
      })
      .run();
    const svc = new PresetService(db);
    expect(svc.list().find((p) => p.id === 'engineer')?.builtinUpdatePending).toBe(true);
  });

  it('clears builtinUpdatePending after saving a customized built-in', () => {
    const { db } = openDb(':memory:');
    const shipped = BUILTIN_PRESETS.find((p) => p.id === 'engineer');
    expect(shipped).toBeDefined();
    const customized: RolePreset = {
      ...shipped!,
      description: 'Tweaked',
    };
    db.insert(rolePresets)
      .values({
        id: 'engineer',
        json: JSON.stringify(customized),
        builtin: 1,
        baseHash: ENGINEER_PRESET_LEGACY_HASH,
      })
      .run();
    const svc = new PresetService(db);
    svc.upsert(customized);
    expect(svc.list().find((p) => p.id === 'engineer')?.builtinUpdatePending).toBeFalsy();
  });

  it('does not flag a customized reviewer when base_hash matches shipped', () => {
    const { db } = openDb(':memory:');
    const shipped = BUILTIN_PRESETS.find((p) => p.id === 'reviewer');
    expect(shipped).toBeDefined();
    const customized: RolePreset = {
      ...shipped!,
      description: 'Stricter review checklist',
    };
    db.insert(rolePresets)
      .values({
        id: 'reviewer',
        json: JSON.stringify(customized),
        builtin: 1,
        baseHash: hashRolePreset(shipped!),
      })
      .run();
    const svc = new PresetService(db);
    expect(svc.list().find((p) => p.id === 'reviewer')?.builtinUpdatePending).toBeFalsy();
  });
});
