import {
  BUILTIN_PRESETS,
  type RolePreset,
  type RolePresetListItem,
  RolePresetSchema,
} from '@deskhaven/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { rolePresets } from '../db/schema.js';
import { BUILTIN_PRESET_LEGACY_HASH, hashRolePreset } from './presetBuiltin.js';

function shippedBuiltin(id: string): RolePreset | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id);
}

function latestLegacyBaseHash(id: string): string | undefined {
  const legacy = BUILTIN_PRESET_LEGACY_HASH[id];
  if (!legacy?.length) return undefined;
  return legacy[legacy.length - 1];
}

export type PresetUpsertOptions = {
  /** User dismissed "Built-in updated" without resetting to shipped JSON. */
  acknowledgeBuiltinUpdate?: boolean;
};

/** Role presets are editable JSON: built-ins are seeded once and can be overridden or extended. */
export class PresetService {
  constructor(private readonly db: Db) {
    for (const p of BUILTIN_PRESETS) {
      const baseHash = hashRolePreset(p);
      this.db
        .insert(rolePresets)
        .values({ id: p.id, json: JSON.stringify(p), builtin: 1, baseHash })
        .onConflictDoNothing()
        .run();
    }
    this.migrateUnmodifiedBuiltins();
    this.backfillBaseHashes();
  }

  list(): RolePresetListItem[] {
    return this.db
      .select()
      .from(rolePresets)
      .all()
      .map((r) => {
        const preset = RolePresetSchema.parse(JSON.parse(r.json));
        const shipped = shippedBuiltin(preset.id);
        const pending =
          shipped && r.builtin === 1 && r.baseHash && r.baseHash !== hashRolePreset(shipped);
        return pending ? { ...preset, builtinUpdatePending: true } : preset;
      });
  }

  get(id: string): RolePreset | undefined {
    const row = this.db.select().from(rolePresets).where(eq(rolePresets.id, id)).get();
    return row ? RolePresetSchema.parse(JSON.parse(row.json)) : undefined;
  }

  upsert(input: unknown, options: PresetUpsertOptions = {}): RolePreset {
    const preset = RolePresetSchema.parse(input);
    if (preset.permissionMode === ('bypassPermissions' as string))
      throw new Error('bypassPermissions is not allowed');
    const existing = this.db.select().from(rolePresets).where(eq(rolePresets.id, preset.id)).get();
    const builtin = BUILTIN_PRESETS.some((p) => p.id === preset.id) ? 1 : 0;
    const shipped = shippedBuiltin(preset.id);
    const presetHash = hashRolePreset(preset);
    let baseHash: string;
    if (shipped) {
      const shippedHash = hashRolePreset(shipped);
      if (presetHash === shippedHash) {
        baseHash = shippedHash;
      } else if (options.acknowledgeBuiltinUpdate) {
        baseHash = shippedHash;
      } else if (existing?.baseHash) {
        baseHash = existing.baseHash;
      } else {
        baseHash = latestLegacyBaseHash(preset.id) ?? shippedHash;
      }
    } else {
      baseHash = existing?.baseHash ?? presetHash;
    }
    this.db
      .insert(rolePresets)
      .values({ id: preset.id, json: JSON.stringify(preset), builtin, baseHash })
      .onConflictDoUpdate({
        target: rolePresets.id,
        set: { json: JSON.stringify(preset), builtin, baseHash },
      })
      .run();
    return preset;
  }

  /** Deleting a built-in restores its shipped definition; deleting a custom preset removes it. */
  reset(id: string): RolePreset | undefined {
    const builtin = shippedBuiltin(id);
    if (builtin) {
      const baseHash = hashRolePreset(builtin);
      this.db
        .update(rolePresets)
        .set({ json: JSON.stringify(builtin), baseHash })
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
      const legacyHashes = BUILTIN_PRESET_LEGACY_HASH[shipped.id];
      if (!legacyHashes?.length) continue;
      const row = this.db.select().from(rolePresets).where(eq(rolePresets.id, shipped.id)).get();
      if (!row) continue;
      const stored = RolePresetSchema.parse(JSON.parse(row.json));
      const storedHash = hashRolePreset(stored);
      if (!legacyHashes.includes(storedHash)) continue;
      const baseHash = hashRolePreset(shipped);
      this.db
        .update(rolePresets)
        .set({ json: JSON.stringify(shipped), baseHash })
        .where(eq(rolePresets.id, shipped.id))
        .run();
    }
  }

  /** Rows created before base_hash existed: align with shipped or current bundle. */
  private backfillBaseHashes(): void {
    for (const row of this.db.select().from(rolePresets).all()) {
      if (row.baseHash) continue;
      const shipped = shippedBuiltin(row.id);
      if (!shipped) continue;
      const stored = RolePresetSchema.parse(JSON.parse(row.json));
      const shippedHash = hashRolePreset(shipped);
      const storedHash = hashRolePreset(stored);
      const legacy = BUILTIN_PRESET_LEGACY_HASH[row.id];
      let json = row.json;
      let baseHash = shippedHash;
      if (legacy?.includes(storedHash)) {
        json = JSON.stringify(shipped);
        baseHash = shippedHash;
      } else if (storedHash !== shippedHash) {
        const legacyBase = latestLegacyBaseHash(row.id);
        baseHash = legacyBase ?? shippedHash;
      }
      this.db.update(rolePresets).set({ json, baseHash }).where(eq(rolePresets.id, row.id)).run();
    }
  }
}
