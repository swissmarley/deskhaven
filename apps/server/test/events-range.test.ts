import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Built, client, testApp } from './helpers.js';

let built: Built;
let req: ReturnType<typeof client>;
const now = Date.now();
const MIN = 60_000;

beforeAll(async () => {
  built = await testApp();
  req = client(built);
  for (const [id, ago] of [
    ['old', 10 * MIN],
    ['recent', 2 * MIN],
    ['latest', 0],
  ] as const) {
    built.ctx.events.append({
      id,
      ts: now - ago,
      agentId: 'a1',
      type: 'notification',
      kind: 'test',
      message: id,
    });
  }
});
afterAll(async () => {
  await built.app.close();
});

const ids = (body: { id: string }[]) => body.map((e) => e.id);

describe('GET /api/events time range (replay)', () => {
  it('returns only the last 5 minutes when fromTs is set', async () => {
    const res = await req({
      method: 'GET',
      url: `/api/events?asc=true&fromTs=${now - 5 * MIN}`,
    });
    expect(res.statusCode).toBe(200);
    expect(ids(res.json())).toEqual(['recent', 'latest']);
  });

  it('honours toTs as an inclusive upper bound', async () => {
    const res = await req({
      method: 'GET',
      url: `/api/events?asc=true&fromTs=${now - 11 * MIN}&toTs=${now - 2 * MIN}`,
    });
    expect(ids(res.json())).toEqual(['old', 'recent']);
  });

  it('returns nothing for a range in the future', async () => {
    const res = await req({
      method: 'GET',
      url: `/api/events?fromTs=${now + 60 * MIN}&toTs=${now + 120 * MIN}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('rejects inverted and non-numeric ranges', async () => {
    for (const q of [`fromTs=${now}&toTs=${now - MIN}`, 'fromTs=yesterday', 'toTs=-5']) {
      const res = await req({ method: 'GET', url: `/api/events?${q}` });
      expect(res.statusCode, q).toBe(400);
    }
  });
});
