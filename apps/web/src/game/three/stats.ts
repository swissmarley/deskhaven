import { formatStats, STATS_STORAGE_KEY, statsEnabled } from './perf.js';

/**
 * Small fixed stats overlay (fps, draw calls, triangles, avatars) for the Three scene, shown when
 * `?stats=1` is in the page URL or `localStorage['agenthotel.stats'] === '1'`. Pure DOM; the numbers
 * come from `perf.ts` and `renderer.info`.
 */

/** How often the text is rewritten (ms). */
export const STATS_REFRESH_MS = 250;

export function statsRequested(): boolean {
  let stored: string | null | undefined;
  try {
    stored = globalThis.localStorage?.getItem(STATS_STORAGE_KEY);
  } catch {
    stored = undefined;
  }
  return statsEnabled(globalThis.location?.search, stored);
}

export class StatsOverlay {
  private readonly el: HTMLDivElement;
  private since = 0;
  private last = '';

  constructor(container: HTMLElement) {
    const doc = container.ownerDocument;
    this.el = doc.createElement('div');
    this.el.className = 'world-stats';
    this.el.style.cssText =
      'position:absolute;left:8px;top:8px;z-index:3;pointer-events:none;' +
      'font:11px/16px ui-monospace,Menlo,Consolas,monospace;color:#e6edf3;' +
      'background:rgba(13,17,23,0.7);padding:2px 6px;border-radius:4px;white-space:nowrap;';
    this.el.textContent = '…';
    container.appendChild(this.el);
  }

  /** Feed one frame; the text is rewritten at most every `STATS_REFRESH_MS`. */
  update(
    dtMs: number,
    stats: { fps: number; calls: number; triangles: number; avatars: number; degraded: boolean },
  ): void {
    this.since += dtMs;
    if (this.since < STATS_REFRESH_MS) return;
    this.since = 0;
    const text = formatStats(stats);
    if (text !== this.last) {
      this.el.textContent = text;
      this.last = text;
    }
  }

  destroy(): void {
    this.el.remove();
  }
}
