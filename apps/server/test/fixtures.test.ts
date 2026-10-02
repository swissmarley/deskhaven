import fs from 'node:fs';
import path from 'node:path';
import { AgentEventSchema } from '@agenthotel/shared';
import { describe, expect, it } from 'vitest';
import { normalizeSdkMessage } from '../src/agent/normalize.js';
import type { SDKMessage } from '../src/agent/sdk-adapter.js';

/**
 * Replays recorded SDK sessions (see AGENTHOTEL_RECORD_SDK) through the normaliser. Every recorded
 * message must produce only valid AgentEvents, and the message types we claim to handle must never
 * fall through to `unknown`.
 */
const HANDLED = new Set([
  'system',
  'assistant',
  'user',
  'result',
  'stream_event',
  'rate_limit_event',
  'auth_status',
  'tool_progress',
  'tool_use_summary',
]);
const dir = path.join(import.meta.dirname, 'fixtures');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];

describe('recorded SDK fixtures', () => {
  it.skipIf(files.length === 0)('normalise without invalid or unknown events', () => {
    let n = 0;
    for (const file of files) {
      const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const m = JSON.parse(line) as SDKMessage;
        const events = normalizeSdkMessage(m, {
          agentId: 'fixture',
          now: () => 1,
          newId: () => `id${++n}`,
        });
        for (const e of events) {
          AgentEventSchema.parse(e);
          if (HANDLED.has(m.type)) expect(e.type, `${file}: ${m.type}`).not.toBe('unknown');
        }
      }
    }
    expect(n).toBeGreaterThan(0);
  });
  it('has the fixture directory', () => {
    expect(fs.existsSync(dir)).toBe(true);
  });
});
