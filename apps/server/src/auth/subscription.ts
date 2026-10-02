import type { AuthStatus } from '@agenthotel/shared';
import { type CliAuthStatus, cliAuthStatus } from './cli-path.js';
import { type ChildEnv, scrubAuthEnv } from './env.js';
import type { AuthConstraints, AuthProvider } from './types.js';

export const SUBSCRIPTION_NOTICE =
  'Subscription mode: every agent turn counts against your Claude plan usage limits (5-hour and weekly windows). Concurrency is capped to protect those limits.';

interface SubscriptionDeps {
  env: ChildEnv;
  policyCheckedAt: string;
  probeFn?: (env: ChildEnv) => Promise<CliAuthStatus>;
}

/**
 * CLAUDE_SUBSCRIPTION mode. No login UI, no token handling: the user signs in with `claude login`;
 * we only strip API-key variables from the child env so the plan is used, and we detect the login
 * state through the CLI's own status command.
 */
export class ClaudeSubscriptionAuthProvider implements AuthProvider {
  readonly mode = 'CLAUDE_SUBSCRIPTION' as const;
  readonly bindHost = '127.0.0.1';

  constructor(private readonly deps: SubscriptionDeps) {}

  async probe(): Promise<AuthStatus> {
    const probe = this.deps.probeFn ?? cliAuthStatus;
    const status = await probe(scrubAuthEnv(this.deps.env));
    const base = {
      mode: this.mode,
      loggedIn: status.loggedIn,
      subscriptionType: status.subscriptionType,
      email: status.email,
      bindHost: this.bindHost,
      subscriptionModeEnabled: true,
      policyCheckedAt: this.deps.policyCheckedAt,
      notice: SUBSCRIPTION_NOTICE,
    };
    if (!status.loggedIn) {
      return {
        ...base,
        available: false,
        error: 'Not logged in. Run `claude login` in your terminal, then refresh.',
      };
    }
    if (status.authMethod && status.authMethod !== 'claude.ai') {
      return {
        ...base,
        available: false,
        error: `Claude Code is signed in with "${status.authMethod}", not a claude.ai subscription. Use API_KEY mode or run \`claude login\`.`,
      };
    }
    return { ...base, available: true };
  }

  childEnv(base: ChildEnv): ChildEnv {
    return scrubAuthEnv(base);
  }

  constraints(): AuthConstraints {
    return { bindHost: this.bindHost, defaultConcurrency: 2, notice: SUBSCRIPTION_NOTICE };
  }
}
