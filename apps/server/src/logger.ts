import type { FastifyServerOptions } from 'fastify';

/** Keys whose values must never reach a log line. Matched case-insensitively on the key path. */
export const REDACT_PATHS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'apiKey',
  'api_key',
  'authorization',
  'token',
  '*.ANTHROPIC_API_KEY',
  '*.ANTHROPIC_AUTH_TOKEN',
  '*.CLAUDE_CODE_OAUTH_TOKEN',
  '*.apiKey',
  '*.token',
];

export function loggerOptions(isProduction: boolean): FastifyServerOptions['logger'] {
  return {
    level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'info'),
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    serializers: {
      // The default request serializer logs the raw URL, which can carry `?token=` (remote login).
      req: (req: { method?: string; url?: string; host?: string; ip?: string }) => ({
        method: req.method,
        url: redactUrl(req.url ?? ''),
        host: req.host,
        remoteAddress: req.ip,
      }),
    },
  };
}

/** Replaces the value of any `token` query parameter. */
export function redactUrl(url: string): string {
  return url.replace(/([?&]token=)[^&#]*/gi, '$1[redacted]');
}

/** Scrub anything that looks like an Anthropic key from free text before logging it. */
export function scrubSecrets(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[redacted]');
}
