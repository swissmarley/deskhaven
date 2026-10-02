import { BUILTIN_PRESETS, type RolePreset, RolePresetSchema } from '@agenthotel/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { rolePresets } from '../db/schema.js';

/** Role presets are editable JSON: built-ins are seeded once and can be overridden or extended. */
export class PresetService {
  constructor(private readonly db: Db) {
    for (const p of BUILTIN_PRESETS) {
      this.db
        .insert(rolePresets)
        .values({ id: p.id, json: JSON.stringify(p), builtin: 1 })
        .onConflictDoNothing()
        .run();
    }
  }

  list(): RolePreset[] {
    return this.db
      .select()
      .from(rolePresets)
      .all()
      .map((r) => RolePresetSchema.parse(JSON.parse(r.json)));
  }

  get(id: string): RolePreset | undefined {
    const row = this.db.select().from(rolePresets).where(eq(rolePresets.id, id)).get();
    return row ? RolePresetSchema.parse(JSON.parse(row.json)) : undefined;
  }

  upsert(input: unknown): RolePreset {
    const preset = RolePresetSchema.parse(input);
    if (preset.permissionMode === ('bypassPermissions' as string))
      throw new Error('bypassPermissions is not allowed');
    const builtin = BUILTIN_PRESETS.some((p) => p.id === preset.id) ? 1 : 0;
    this.db
      .insert(rolePresets)
      .values({ id: preset.id, json: JSON.stringify(preset), builtin })
      .onConflictDoUpdate({ target: rolePresets.id, set: { json: JSON.stringify(preset) } })
      .run();
    return preset;
  }

  /** Deleting a built-in restores its shipped definition; deleting a custom preset removes it. */
  reset(id: string): RolePreset | undefined {
    const builtin = BUILTIN_PRESETS.find((p) => p.id === id);
    if (builtin) {
      this.db
        .update(rolePresets)
        .set({ json: JSON.stringify(builtin) })
        .where(eq(rolePresets.id, id))
        .run();
      return builtin;
    }
    this.db.delete(rolePresets).where(eq(rolePresets.id, id)).run();
    return undefined;
  }
}
