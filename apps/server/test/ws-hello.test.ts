import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import { sessionCookieName } from '../src/http/security.js';
import { type Built, TEST_HOST, TEST_ORIGIN, testApp } from './helpers.js';

let built: Built;

beforeAll(async () => {
  built = await testApp();
  await built.app.ready();
  for (let i = 0; i < 520; i++) {
    built.ctx.events.append({
      id: `n-${i}`,
      ts: i,
      agentId: 'ada',
      type: 'notification',
      kind: 'test',
      message: `event ${i}`,
    });
  }
});

afterAll(async () => {
  await built.app.close();
});

/** Sends `hello` and returns the seqs of the events_batch that follows it. */
async function batchAfterHello(
  hello: Record<string, unknown>,
  onHello?: (m: Record<string, unknown>) => void,
): Promise<number[]> {
  const ws: WebSocket = await built.app.injectWS('/ws', {
    headers: {
      host: TEST_HOST,
      origin: TEST_ORIGIN,
      cookie: `${sessionCookieName(8787)}=${built.ctx.security.token}`,
    },
  });
  const batch = new Promise<number[]>((resolve) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as { type: string; events?: { seq: number }[] };
      if (m.type === 'hello') onHello?.(m);
      if (m.type === 'events_batch') resolve((m.events ?? []).map((e) => e.seq));
    });
  });
  ws.send(JSON.stringify(hello));
  const seqs = await batch;
  ws.terminate();
  return seqs;
}

describe('websocket hello', () => {
  it('sends only the events after the seq a reconnecting client already has', async () => {
    const all = built.ctx.events.list({ limit: 1000, ascending: true }).map((e) => e.seq ?? 0);
    const last = all.at(-1) ?? 0;
    const seqs = await batchAfterHello({ type: 'hello', sinceSeq: last - 3 });
    expect(seqs).toEqual([last - 2, last - 1, last]);
  });

  it('sends the latest 500 events, oldest first, on a first load', async () => {
    const all = built.ctx.events.list({ limit: 1000, ascending: true }).map((e) => e.seq ?? 0);
    const seqs = await batchAfterHello({ type: 'hello' });
    expect(seqs).toHaveLength(500);
    expect(seqs).toEqual(all.slice(-500));
  });

  it('tells the client the highest seq in its log, so a tab can notice a reset database', async () => {
    let lastSeq: unknown;
    await batchAfterHello({ type: 'hello', sinceSeq: 1 }, (m) => {
      lastSeq = m.lastSeq;
    });
    expect(lastSeq).toBe(built.ctx.events.maxSeq());
    expect(lastSeq).toBeGreaterThanOrEqual(520);
  });
});
