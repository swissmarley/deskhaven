import {
  DEFAULT_MANAGER_MODEL,
  DEFAULT_MODEL,
  MAX_PERMISSION_TIMEOUT_MS,
  type Settings,
  SettingsSchema,
  type UpdateSettingsSchema,
} from '@deskhaven/shared';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { envVar } from '../config.js';
import type { Db } from '../db/client.js';
import { settings as settingsTable } from '../db/schema.js';

export const POLICY_CHECKED_AT = '2026-10-02';

/** One place to disable the subscription strategy. Env override: DESKHAVEN_ENABLE_SUBSCRIPTION_MODE=0 */
export const SUBSCRIPTION_MODE_FEATURE_FLAG =
  (envVar(process.env, 'ENABLE_SUBSCRIPTION_MODE') ?? '1') !== '0';

const KEY = 'app';

export function defaultSettings(over: Partial<Settings> = {}): Settings {
  return SettingsSchema.parse({
    authMode: 'API_KEY',
    subscriptionModeEnabled: SUBSCRIPTION_MODE_FEATURE_FLAG,
    concurrencyCap: 2,
    dailyCapUsd: 20,
    permissionTimeoutMs: 10 * 60 * 1000,
    idleTimeoutMinutes: 15,
    soundEnabled: true,
    policyCheckedAt: POLICY_CHECKED_AT,
    onboarded: false,
    defaultModel: DEFAULT_MODEL,
    managerModel: DEFAULT_MANAGER_MODEL,
    ...over,
  });
}

export class SettingsService {
  private cache: Settings | null = null;
  private readonly listeners = new Set<(s: Settings) => void>();

  constructor(private readonly db: Db) {}

  /** True when no settings row exists yet (first run). */
  isFirstRun(): boolean {
    return (
      this.db.select().from(settingsTable).where(eq(settingsTable.key, KEY)).get() === undefined
    );
  }

  get(): Settings {
    if (this.cache) return this.cache;
    const row = this.db.select().from(settingsTable).where(eq(settingsTable.key, KEY)).get();
    const stored = row ? (JSON.parse(row.value) as Record<string, unknown>) : null;
    // Rows written before the 24 h cap existed are clamped rather than discarded wholesale.
    if (stored && typeof stored.permissionTimeoutMs === 'number')
      stored.permissionTimeoutMs = Math.min(stored.permissionTimeoutMs, MAX_PERMISSION_TIMEOUT_MS);
    const parsed = stored ? SettingsSchema.safeParse({ ...defaultSettings(), ...stored }) : null;
    this.cache = parsed?.success ? parsed.data : defaultSettings();
    // The feature flag is code-level: it always wins over a stored value.
    this.cache = { ...this.cache, subscriptionModeEnabled: SUBSCRIPTION_MODE_FEATURE_FLAG };
    return this.cache;
  }

  /** The settings `patch` would produce, validated but not persisted. Throws when invalid. */
  preview(patch: z.infer<typeof UpdateSettingsSchema>): Settings {
    const next = SettingsSchema.parse({
      ...this.get(),
      ...patch,
      subscriptionModeEnabled: SUBSCRIPTION_MODE_FEATURE_FLAG,
    });
    if (next.authMode === 'CLAUDE_SUBSCRIPTION' && !next.subscriptionModeEnabled) {
      throw new Error('Subscription mode is disabled by the feature flag');
    }
    return next;
  }

  update(patch: z.infer<typeof UpdateSettingsSchema>): Settings {
    const next = this.preview(patch);
    this.db
      .insert(settingsTable)
      .values({ key: KEY, value: JSON.stringify(next) })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: JSON.stringify(next) } })
      .run();
    this.cache = next;
    for (const l of this.listeners) l(next);
    return next;
  }

  onChange(listener: (s: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
