/**
 * Mid-turn cost estimate. The SDK only reports cost in the `result` message at the end of a turn, so
 * a per-turn cap needs its own running estimate from the `usage` block of every assistant message
 * (main loop and subagents). Pure; no I/O.
 *
 * Prices are USD per million tokens (list prices, 2026-10). Claude Code writes the prompt cache with
 * the 1-hour TTL, billed at 2x input; 5-minute writes are 1.25x input. Checked against a recorded
 * session (`test/fixtures/session-readonly-sonnet.jsonl`): the estimate lands within ~2% of the SDK's
 * `total_cost_usd`; the gap is output tokens, which a streamed message reports before it ends.
 * An unknown model is priced at the Opus 5 rate so the cap errs on the side of stopping early.
 */

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}

const PRICES: { match: RegExp; price: ModelPrice }[] = [
  { match: /(fable|mythos)-5-1/, price: { input: 10, output: 50, cacheRead: 0.25 } },
  { match: /fable|mythos/, price: { input: 10, output: 50, cacheRead: 1 } },
  { match: /opus-5-5/, price: { input: 4, output: 20, cacheRead: 0.2 } },
  { match: /opus-4-1|opus-4-2025|3-opus/, price: { input: 15, output: 75, cacheRead: 1.5 } },
  { match: /opus/, price: { input: 5, output: 25, cacheRead: 0.5 } },
  { match: /sonnet-5/, price: { input: 2, output: 10, cacheRead: 0.2 } },
  { match: /sonnet/, price: { input: 3, output: 15, cacheRead: 0.3 } },
  { match: /haiku-5/, price: { input: 0.1, output: 0.5, cacheRead: 0.01 } },
  { match: /haiku-4/, price: { input: 1, output: 5, cacheRead: 0.1 } },
  { match: /haiku/, price: { input: 0.8, output: 4, cacheRead: 0.08 } },
];

const FALLBACK: ModelPrice = { input: 5, output: 25, cacheRead: 0.5 };

export function priceFor(model: string | undefined | null): ModelPrice {
  const id = (model ?? '').toLowerCase();
  return PRICES.find((p) => p.match.test(id))?.price ?? FALLBACK;
}

/** The subset of the Messages API `usage` block the estimate reads. */
export interface MessageUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
}

const n = (v: number | null | undefined): number => (typeof v === 'number' && v > 0 ? v : 0);

export function usageCostUsd(model: string | undefined | null, usage: MessageUsage): number {
  const p = priceFor(model);
  const created = n(usage.cache_creation_input_tokens);
  const split = usage.cache_creation;
  const fiveMin = n(split?.ephemeral_5m_input_tokens);
  // Without the split, assume the 1-hour TTL Claude Code uses (the dearer of the two).
  const oneHour = split ? n(split.ephemeral_1h_input_tokens) : created;
  const unsplit = Math.max(0, created - fiveMin - oneHour);
  const perToken =
    n(usage.input_tokens) * p.input +
    n(usage.output_tokens) * p.output +
    n(usage.cache_read_input_tokens) * p.cacheRead +
    fiveMin * p.input * 1.25 +
    (oneHour + unsplit) * p.input * 2;
  return perToken / 1_000_000;
}

/**
 * Running estimate for one turn. A streamed API response arrives as several assistant messages with
 * the same `message.id`, each carrying the usage so far; per id the largest value of each counter is
 * kept, so a response is never counted twice.
 */
export class TurnCostMeter {
  private readonly byMessage = new Map<string, { model: string; usage: MessageUsage }>();
  private anon = 0;
  private cached = 0;

  reset(): void {
    this.byMessage.clear();
    this.anon = 0;
    this.cached = 0;
  }

  get totalUsd(): number {
    return this.cached;
  }

  /** Record one assistant message and return the turn's estimated cost so far. */
  add(messageId: string | undefined | null, model: string, usage: MessageUsage): number {
    const key = messageId || `anon-${this.anon++}`;
    const prev = this.byMessage.get(key)?.usage;
    const max = (a: number | null | undefined, b: number | null | undefined) =>
      Math.max(n(a), n(b));
    const merged: MessageUsage = {
      input_tokens: max(prev?.input_tokens, usage.input_tokens),
      output_tokens: max(prev?.output_tokens, usage.output_tokens),
      cache_creation_input_tokens: max(
        prev?.cache_creation_input_tokens,
        usage.cache_creation_input_tokens,
      ),
      cache_read_input_tokens: max(prev?.cache_read_input_tokens, usage.cache_read_input_tokens),
      ...(usage.cache_creation || prev?.cache_creation
        ? {
            cache_creation: {
              ephemeral_5m_input_tokens: max(
                prev?.cache_creation?.ephemeral_5m_input_tokens,
                usage.cache_creation?.ephemeral_5m_input_tokens,
              ),
              ephemeral_1h_input_tokens: max(
                prev?.cache_creation?.ephemeral_1h_input_tokens,
                usage.cache_creation?.ephemeral_1h_input_tokens,
              ),
            },
          }
        : {}),
    };
    this.byMessage.set(key, { model, usage: merged });
    let total = 0;
    for (const m of this.byMessage.values()) total += usageCostUsd(m.model, m.usage);
    this.cached = total;
    return total;
  }
}

/**
 * The SDK's `result.total_cost_usd` is cumulative for the process (a resumed process continues from
 * the total its transcript saved). Returns this turn's share given the total after the previous turn;
 * a total below the baseline means the counter restarted, so the whole total is this turn's.
 */
export function turnCostFromCumulative(totalUsd: number, baselineUsd: number): number {
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return 0;
  if (totalUsd + 1e-9 < baselineUsd) return totalUsd;
  return Math.max(0, totalUsd - baselineUsd);
}
