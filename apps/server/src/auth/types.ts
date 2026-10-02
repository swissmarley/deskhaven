import type { AuthMode, AuthStatus } from '@agenthotel/shared';
import type { ChildEnv } from './env.js';

export interface AuthConstraints {
  /** Host the HTTP server may bind to. Subscription mode is loopback-only. */
  bindHost: string | null;
  defaultConcurrency: number;
  notice?: string;
}

export interface AuthProvider {
  readonly mode: AuthMode;
  /** Never throws, never reads credential files. */
  probe(): Promise<AuthStatus>;
  /** Environment for the agent subprocess. The SDK REPLACES the env, so this must be complete. */
  childEnv(base: ChildEnv): ChildEnv;
  constraints(): AuthConstraints;
}
