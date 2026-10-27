import { BUILTIN_PRESETS, type RolePreset } from '@deskhaven/shared';
import { describe, expect, it } from 'vitest';
import { rolePresets } from '../src/db/schema.js';
import { ENGINEER_PRESET_LEGACY_HASH } from '../src/presets/presetBuiltin.js';
import { client, testApp } from './helpers.js';

describe('presets HTTP', () => {
  it('PUT /api/presets/:id honors acknowledgeBuiltinUpdate', async () => {
    const built = await testApp();
    const shipped = BUILTIN_PRESETS.find((p) => p.id === 'engineer');
    if (!shipped) throw new Error('missing engineer preset');
    const customized: RolePreset = { ...shipped, description: 'HTTP customized' };
    built.ctx.db
      .insert(rolePresets)
      .values({
        id: 'engineer',
        json: JSON.stringify(customized),
        builtin: 1,
        baseHash: ENGINEER_PRESET_LEGACY_HASH,
      })
      .onConflictDoUpdate({
        target: rolePresets.id,
        set: {
          json: JSON.stringify(customized),
          builtin: 1,
          baseHash: ENGINEER_PRESET_LEGACY_HASH,
        },
      })
      .run();

    const listBefore = (await client(built)({ method: 'GET', url: '/api/presets' })).json() as {
      id: string;
      builtinUpdatePending?: boolean;
    }[];
    expect(listBefore.find((p) => p.id === 'engineer')?.builtinUpdatePending).toBe(true);

    const save = await client(built)({
      method: 'PUT',
      url: '/api/presets/engineer',
      payload: { ...customized, acknowledgeBuiltinUpdate: true },
    });
    expect(save.statusCode).toBe(200);

    const listAfter = (await client(built)({ method: 'GET', url: '/api/presets' })).json() as {
      id: string;
      builtinUpdatePending?: boolean;
    }[];
    expect(listAfter.find((p) => p.id === 'engineer')?.builtinUpdatePending).toBeFalsy();
  });
});
