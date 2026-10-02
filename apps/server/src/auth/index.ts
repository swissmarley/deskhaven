import type { Settings } from '@agenthotel/shared';
import { ApiKeyAuthProvider, type KeyStore } from './api-key.js';
import type { ChildEnv } from './env.js';
import { ClaudeSubscriptionAuthProvider } from './subscription.js';
import type { AuthProvider } from './types.js';

export * from './api-key.js';
export * from './cli-path.js';
export * from './env.js';
export * from './subscription.js';
export * from './types.js';

export function createAuthProvider(
  settings: Settings,
  deps: { env: ChildEnv; keyStore: KeyStore; bindHost: string },
): AuthProvider {
  if (settings.authMode === 'CLAUDE_SUBSCRIPTION') {
    if (!settings.subscriptionModeEnabled)
      throw new Error('Subscription mode is disabled by the feature flag');
    return new ClaudeSubscriptionAuthProvider({
      env: deps.env,
      policyCheckedAt: settings.policyCheckedAt,
    });
  }
  return new ApiKeyAuthProvider({
    env: deps.env,
    keyStore: deps.keyStore,
    subscriptionModeEnabled: settings.subscriptionModeEnabled,
    policyCheckedAt: settings.policyCheckedAt,
    bindHost: deps.bindHost,
  });
}
