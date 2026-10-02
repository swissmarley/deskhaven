import type { AuthStatus } from '@agenthotel/shared';
import { type ChildEnv, scrubAuthEnv } from './env.js';
import type { AuthConstraints, AuthProvider } from './types.js';

export const KEYCHAIN_SERVICE = 'agenthotel';
export const KEYCHAIN_ACCOUNT = 'anthropic-api-key';

export interface KeyStore {
  get(): Promise<string | null>;
  set(key: string): Promise<void>;
  clear(): Promise<void>;
}

/** OS keychain via @napi-rs/keyring (keytar is unmaintained). Loaded lazily so tests never touch it. */
export class KeyringKeyStore implements KeyStore {
  private entry: {
    getPassword(): string | null;
    setPassword(p: string): void;
    deletePassword(): boolean;
  } | null = null;

  private async load() {
    if (this.entry) return this.entry;
    const mod = await import('@napi-rs/keyring');
    this.entry = new mod.Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    return this.entry;
  }
  async get(): Promise<string | null> {
    try {
      return (await this.load()).getPassword() ?? null;
    } catch {
      return null;
    }
  }
  async set(key: string): Promise<void> {
    (await this.load()).setPassword(key);
  }
  async clear(): Promise<void> {
    try {
      (await this.load()).deletePassword();
    } catch {
      // nothing stored
    }
  }
}

export class MemoryKeyStore implements KeyStore {
  constructor(private key: string | null = null) {}
  async get() {
    return this.key;
  }
  async set(key: string) {
    this.key = key;
  }
  async clear() {
    this.key = null;
  }
}

interface ApiKeyDeps {
  env: ChildEnv;
  keyStore: KeyStore;
  subscriptionModeEnabled: boolean;
  policyCheckedAt: string;
  bindHost: string;
}

/**
 * API_KEY mode. The key lives in this closure only: it is never logged, serialised, or persisted by us.
 * It reaches exactly one place, the agent subprocess environment.
 */
export class ApiKeyAuthProvider implements AuthProvider {
  readonly mode = 'API_KEY' as const;
  private resolved: { key: string | null; source: 'env' | 'keychain' | 'none' } | null = null;

  constructor(private readonly deps: ApiKeyDeps) {}

  private async resolveKey() {
    if (this.resolved) return this.resolved;
    const fromEnv = this.deps.env.ANTHROPIC_API_KEY;
    if (fromEnv) this.resolved = { key: fromEnv, source: 'env' };
    else {
      const k = await this.deps.keyStore.get();
      this.resolved = k ? { key: k, source: 'keychain' } : { key: null, source: 'none' };
    }
    return this.resolved;
  }

  /** Forget the cached key (after the keychain changed). */
  invalidate(): void {
    this.resolved = null;
  }

  async probe(): Promise<AuthStatus> {
    const r = await this.resolveKey();
    return {
      mode: this.mode,
      available: r.key !== null,
      keySource: r.source,
      bindHost: this.deps.bindHost,
      subscriptionModeEnabled: this.deps.subscriptionModeEnabled,
      policyCheckedAt: this.deps.policyCheckedAt,
      ...(r.key
        ? {}
        : {
            error:
              'No API key: set ANTHROPIC_API_KEY or store a key in the keychain from Settings.',
          }),
    };
  }

  childEnv(base: ChildEnv): ChildEnv {
    const key = this.resolved?.key ?? base.ANTHROPIC_API_KEY ?? null;
    const env = scrubAuthEnv(base);
    if (key) env.ANTHROPIC_API_KEY = key;
    return env;
  }

  /** Call after `probe()` so the keychain key is loaded before agents spawn. */
  async prepare(): Promise<void> {
    await this.resolveKey();
  }

  constraints(): AuthConstraints {
    return { bindHost: null, defaultConcurrency: 4 };
  }
}
