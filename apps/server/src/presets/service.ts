import {
  BUILTIN_PRESET_LEGACY_HASH,
  BUILTIN_PRESETS,
  hashRolePreset,
  type RolePreset,
  type RolePresetListItem,
  RolePresetSchema,
} from '@deskhaven/shared';
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
    this.migrateUnmodifiedBuiltins();
  }

  list(): RolePresetListItem[] {
    return this.db
      .select()
      .from(rolePresets)
      .all()
      .map((r) => {
        const preset = RolePresetSchema.parse(JSON.parse(r.json));
        const shipped = BUILTIN_PRESETS.find((p) => p.id === preset.id);
        const pending =
          shipped &&
          r.builtin === 1 &&
          hashRolePreset(preset) !== hashRolePreset(shipped) &&
          hashRolePreset(preset) !== BUILTIN_PRESET_LEGACY_HASH[preset.id];
        return pending ? { ...preset, builtinUpdatePending: true } : preset;
      });
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

  /** Replace a built-in in the DB when it still matches an older shipped revision (non-destructive). */
  private migrateUnmodifiedBuiltins(): void {
    for (const shipped of BUILTIN_PRESETS) {
      const legacyHash = BUILTIN_PRESET_LEGACY_HASH[shipped.id];
      if (!legacyHash) continue;
      const row = this.db.select().from(rolePresets).where(eq(rolePresets.id, shipped.id)).get();
      if (!row) continue;
      const stored = RolePresetSchema.parse(JSON.parse(row.json));
      if (hashRolePreset(stored) !== legacyHash) continue;
      this.db
        .update(rolePresets)
        .set({ json: JSON.stringify(shipped) })
        .where(eq(rolePresets.id, shipped.id))
        .run();
    }
  }
}
