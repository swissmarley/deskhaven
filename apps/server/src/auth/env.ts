/** The three variables that make the Claude Code subprocess bill an API key instead of the plan. */
export const AUTH_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

export type ChildEnv = Record<string, string | undefined>;

/** Copy of `base` with every auth variable removed. Pure. */
export function scrubAuthEnv(base: ChildEnv): ChildEnv {
  const out: ChildEnv = { ...base };
  for (const k of AUTH_ENV_VARS) delete out[k];
  return out;
}

/** True when any auth variable is present (and non-empty) in `env`. */
export function hasAuthEnv(env: ChildEnv): boolean {
  return AUTH_ENV_VARS.some((k) => Boolean(env[k]));
}
