import fs from 'node:fs';
import path from 'node:path';
import { envVar } from '../config.js';
import type { ChildEnv } from './env.js';

/**
 * Credentials other than an Anthropic API key that API_KEY mode accepts because the user configured
 * them on purpose. Without one of these, API_KEY mode insists on ANTHROPIC_API_KEY so the CLI cannot
 * fall back to a claude.ai login (or anything else it happens to find).
 */
export interface ExternalCredentials {
  kind: 'bedrock' | 'vertex' | 'foundry' | 'apiKeyHelper' | 'allowed';
  /** Human-readable origin, for logs and error messages. */
  label: string;
  /** Whether a session reporting this `system/init.apiKeySource` is acceptable. */
  accepts(apiKeySource: string): boolean;
}

const truthy = (v: string | undefined) =>
  v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';

const any = () => true;

/** `apiKeyHelper` from the project settings Claude Code loads for this cwd (settingSources: project). */
export function projectApiKeyHelper(cwd: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8');
    const helper = (JSON.parse(raw) as { apiKeyHelper?: unknown }).apiKeyHelper;
    return typeof helper === 'string' && helper.trim() ? helper : null;
  } catch {
    return null;
  }
}

export function externalCredentials(env: ChildEnv, cwd: string): ExternalCredentials | null {
  // Cloud providers route inference away from the Anthropic API entirely; the CLI then reports
  // apiKeySource "none", which is fine here.
  if (truthy(env.CLAUDE_CODE_USE_BEDROCK))
    return { kind: 'bedrock', label: 'Amazon Bedrock (CLAUDE_CODE_USE_BEDROCK)', accepts: any };
  if (truthy(env.CLAUDE_CODE_USE_VERTEX))
    return { kind: 'vertex', label: 'Google Vertex AI (CLAUDE_CODE_USE_VERTEX)', accepts: any };
  if (truthy(env.CLAUDE_CODE_USE_FOUNDRY))
    return { kind: 'foundry', label: 'Microsoft Foundry (CLAUDE_CODE_USE_FOUNDRY)', accepts: any };
  if (envVar(env, 'ALLOW_EXTERNAL_CREDENTIALS') === '1')
    return {
      kind: 'allowed',
      label: 'any credentials Claude Code finds (DESKHAVEN_ALLOW_EXTERNAL_CREDENTIALS=1)',
      accepts: any,
    };
  if (projectApiKeyHelper(cwd))
    return {
      kind: 'apiKeyHelper',
      label: `apiKeyHelper in ${path.join(cwd, '.claude', 'settings.json')}`,
      accepts: (s) => s === 'apiKeyHelper' || s === 'ANTHROPIC_API_KEY',
    };
  return null;
}
