import { describe, expect, it } from 'vitest';
import { client, testApp } from './helpers.js';

const turn = (agentId: string, costUsd: number) => ({
  id: `t-${agentId}-${costUsd}`,
  ts: Date.now(),
  agentId,
  type: 'turn_completed' as const,
  ok: true,
  subtype: 'success',
  costUsd,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  numTurns: 1,
  durationMs: 1,
});

describe('usage snapshot', () => {
  it('counts fired agents in the office totals and splits today per agent on staff', async () => {
    const built = await testApp();
    try {
      const req = client(built);
      const hire = async (name: string) =>
        (
          await req({
            method: 'POST',
            url: '/api/agents',
            payload: { name, rolePresetId: 'engineer', workdir: process.cwd() },
          })
        ).json() as { id: string };
      const ada = await hire('Ada');
      const bea = await hire('Bea');
      built.ctx.agents.addUsage(ada.id, turn(ada.id, 0.25));
      built.ctx.agents.addUsage(bea.id, turn(bea.id, 0.1));
      const fired = await req({ method: 'DELETE', url: `/api/agents/${bea.id}` });
      expect(fired.statusCode).toBeLessThan(300);

      const snap = built.ctx.usage.snapshot();
      expect(snap.today.costUsd).toBeCloseTo(0.35, 9);
      expect(snap.totals.costUsd).toBeCloseTo(0.35, 9);
      expect(snap.totals.costUsd).toBeGreaterThanOrEqual(snap.today.costUsd);
      expect(Object.keys(snap.perAgentToday ?? {})).toEqual([ada.id]);
      expect(snap.perAgentToday?.[ada.id]?.costUsd).toBeCloseTo(0.25, 9);
      expect(snap.perAgent[ada.id]?.costUsd).toBeCloseTo(0.25, 9);
    } finally {
      await built.app.close();
    }
  });
});
