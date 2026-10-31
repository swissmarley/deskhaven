import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  priceFor,
  TurnCostMeter,
  turnCostFromCumulative,
  UNKNOWN_MODEL_PRICE,
  usageCostUsd,
} from '../src/agent/turn-cost.js';

describe('turn cost estimate', () => {
  it('prices model families like the bundled CLI catalog', () => {
    expect(priceFor('claude-sonnet-5-5')).toMatchObject({ input: 2, output: 10 });
    expect(priceFor('claude-opus-5-5')).toMatchObject({ input: 4, output: 20 });
    expect(priceFor('claude-opus-4-1-20250805')).toMatchObject({ input: 15, output: 75 });
    expect(priceFor('claude-opus-4-8')).toMatchObject({ input: 5, output: 25 });
    expect(priceFor('claude-haiku-4-5-20251001')).toMatchObject({ input: 1, output: 5 });
    expect(priceFor('us.anthropic.claude-sonnet-4-6')).toMatchObject({ input: 3 });
    expect(priceFor('claude-fable-5-1')).toMatchObject({ input: 10, cacheRead: 0.25 });
  });

  it('prices ids the bundled CLI does not know (Haiku 5.5) at its default-model rate', () => {
    expect(priceFor('claude-haiku-5-5')).toEqual(UNKNOWN_MODEL_PRICE);
    expect(priceFor('some-gateway-model')).toEqual(UNKNOWN_MODEL_PRICE);
    expect(UNKNOWN_MODEL_PRICE).toEqual(priceFor('claude-sonnet-5-5'));
  });

  it('puts a real Haiku 5.5 turn (63k cache reads, 32k cache writes) over a $0.10 cap', () => {
    const meter = new TurnCostMeter();
    meter.add('m1', 'claude-haiku-5-5', {
      input_tokens: 10,
      cache_creation_input_tokens: 32_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 32_000 },
      cache_read_input_tokens: 63_000,
      output_tokens: 0,
    });
    expect(meter.totalUsd).toBeGreaterThan(0.1);
    // With the ~4.7k output tokens of that turn the estimate meets the SDK's $0.1876.
    meter.add('m1', 'claude-haiku-5-5', { output_tokens: 4_700 });
    expect(meter.totalUsd).toBeCloseTo(0.1876, 3);
  });

  it('bills 1-hour cache writes at 2x input and 5-minute writes at 1.25x', () => {
    const oneHour = usageCostUsd('claude-sonnet-5-5', {
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
    });
    const fiveMin = usageCostUsd('claude-sonnet-5-5', {
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 0 },
    });
    const unsplit = usageCostUsd('claude-sonnet-5-5', { cache_creation_input_tokens: 1_000_000 });
    expect(oneHour).toBeCloseTo(4, 6);
    expect(fiveMin).toBeCloseTo(2.5, 6);
    expect(unsplit).toBeCloseTo(4, 6);
  });

  it('counts a streamed response once and keeps the largest counters', () => {
    const meter = new TurnCostMeter();
    meter.add('m1', 'claude-sonnet-5-5', { output_tokens: 10 });
    meter.add('m1', 'claude-sonnet-5-5', { output_tokens: 100 });
    expect(meter.totalUsd).toBeCloseTo(100 * 10e-6, 9);
    meter.add('m2', 'claude-sonnet-5-5', { output_tokens: 100 });
    expect(meter.totalUsd).toBeCloseTo(200 * 10e-6, 9);
    meter.reset();
    expect(meter.totalUsd).toBe(0);
  });

  it('lands within a few percent of the SDK total on a recorded session', () => {
    const file = path.join(import.meta.dirname, 'fixtures', 'session-readonly-sonnet.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const meter = new TurnCostMeter();
    let base = 0;
    let turns = 0;
    for (const line of lines) {
      const m = JSON.parse(line) as {
        type: string;
        message?: { id?: string; model?: string; usage?: Record<string, unknown> };
        total_cost_usd?: number;
      };
      if (m.type === 'assistant' && m.message?.usage)
        meter.add(m.message.id, m.message.model ?? '', m.message.usage);
      if (m.type === 'result' && typeof m.total_cost_usd === 'number') {
        const sdkTurn = turnCostFromCumulative(m.total_cost_usd, base);
        base = m.total_cost_usd;
        expect(Math.abs(meter.totalUsd - sdkTurn) / sdkTurn).toBeLessThan(0.05);
        meter.reset();
        turns++;
      }
    }
    expect(turns).toBeGreaterThan(1);
  });

  it('differences the cumulative SDK total and treats a drop as a restart', () => {
    expect(turnCostFromCumulative(0.185327, 0.1651324)).toBeCloseTo(0.0201946, 7);
    expect(turnCostFromCumulative(0.2, 0)).toBe(0.2);
    expect(turnCostFromCumulative(0.05, 0.4)).toBe(0.05);
    expect(turnCostFromCumulative(0, 0.4)).toBe(0);
  });
});
