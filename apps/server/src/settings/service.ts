import {
  DEFAULT_MANAGER_MODEL,
  DEFAULT_MODEL,
  type Settings,
  SettingsSchema,
  type UpdateSettingsSchema,
} from '@agenthotel/shared';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db } from '../db/client.js';
import { settings as settingsTable } from '../db/schema.js';

export const POLICY_CHECKED_AT = '2026-10-02';

/** One place to disable the subscription strategy. Env override: AGENTHOTEL_ENABLE_SUBSCRIPTION_MODE=0 */
export const SUBSCRIPTION_MODE_FEATURE_FLAG =
  (process.env.AGENTHOTEL_ENABLE_SUBSCRIPTION_MODE ?? '1') !== '0';

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
    const parsed = row
      ? SettingsSchema.safeParse({ ...defaultSettings(), ...JSON.parse(row.value) })
      : null;
    this.cache = parsed?.success ? parsed.data : defaultSettings();
    // The feature flag is code-level: it always wins over a stored value.
    this.cache = { ...this.cache, subscriptionModeEnabled: SUBSCRIPTION_MODE_FEATURE_FLAG };
    return this.cache;
  }

  update(patch: z.infer<typeof UpdateSettingsSchema>): Settings {
    const next = SettingsSchema.parse({
      ...this.get(),
      ...patch,
      subscriptionModeEnabled: SUBSCRIPTION_MODE_FEATURE_FLAG,
    });
    if (next.authMode === 'CLAUDE_SUBSCRIPTION' && !next.subscriptionModeEnabled) {
      throw new Error('Subscription mode is disabled by the feature flag');
    }
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
