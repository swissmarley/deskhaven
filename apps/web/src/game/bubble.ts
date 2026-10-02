import { truncate } from '@agenthotel/shared';
import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { BubbleKind } from './types.js';

const MAX_WIDTH = 180;
const PAD_X = 8;
const PAD_Y = 5;
const TAIL = 7;
const POP_MS = 120;

interface BubbleTheme {
  bg: number;
  fg: number;
  border: number;
  mono: boolean;
  bold: boolean;
}

const THEMES: Record<BubbleKind, BubbleTheme> = {
  speech: { bg: 0xffffff, fg: 0x1f2328, border: 0x8a8f98, mono: false, bold: false },
  thought: { bg: 0xeef1f5, fg: 0x5b6470, border: 0xb3bac4, mono: false, bold: false },
  alert: { bg: 0xd62828, fg: 0xffffff, border: 0x7a0f0f, mono: false, bold: true },
  code: { bg: 0x1b1f24, fg: 0xa6e3a1, border: 0x3b4048, mono: true, bold: false },
};

/**
 * A speech/thought/alert/code bubble anchored at its bottom-centre (the tail tip). The owner
 * positions it above the avatar's head every frame and calls `update` to age it.
 */
export class Bubble extends Container {
  private readonly bg = new Graphics();
  private readonly text: Text;
  private remaining = 0;
  private age = 0;

  constructor() {
    super();
    this.visible = false;
    this.eventMode = 'none';
    this.text = new Text({ text: '', style: new TextStyle({ fontSize: 11 }), resolution: 2 });
    this.addChild(this.bg, this.text);
  }

  get active(): boolean {
    return this.visible;
  }

  show(rawText: string, kind: BubbleKind = 'speech', durationMs = 4000): void {
    const theme = THEMES[kind];
    this.text.style = new TextStyle({
      fontFamily: theme.mono
        ? 'ui-monospace, Menlo, Consolas, monospace'
        : 'system-ui, -apple-system, Segoe UI, sans-serif',
      fontSize: theme.mono ? 10 : 11,
      fontWeight: theme.bold ? 'bold' : 'normal',
      fill: theme.fg,
      wordWrap: true,
      wordWrapWidth: MAX_WIDTH - PAD_X * 2,
      breakWords: true,
      lineHeight: theme.mono ? 13 : 14,
    });
    this.text.text = truncate(rawText, kind === 'alert' ? 40 : 80) || ' ';
    const w = Math.min(MAX_WIDTH, Math.ceil(this.text.width) + PAD_X * 2);
    const h = Math.ceil(this.text.height) + PAD_Y * 2;
    // Box sits above the tail; local origin = tail tip.
    const x0 = -w / 2;
    const y0 = -TAIL - h;
    this.text.position.set(x0 + PAD_X, y0 + PAD_Y);
    this.bg.clear();
    this.bg.roundRect(x0, y0, w, h, 6).fill(theme.bg).stroke({ width: 1, color: theme.border });
    if (kind === 'thought') {
      this.bg
        .circle(0, -TAIL + 1, 3)
        .fill(theme.bg)
        .stroke({ width: 1, color: theme.border });
      this.bg.circle(2, -1, 1.5).fill(theme.bg).stroke({ width: 1, color: theme.border });
    } else {
      this.bg
        .poly([-TAIL, -TAIL, TAIL, -TAIL, 0, 0])
        .fill(theme.bg)
        .stroke({ width: 1, color: theme.border });
      // Hide the stroke line along the box edge where the tail joins.
      this.bg.rect(-TAIL + 1, -TAIL - 1.5, TAIL * 2 - 2, 3).fill(theme.bg);
    }
    this.remaining = durationMs;
    this.age = 0;
    this.visible = true;
    this.scale.set(0.6);
    this.alpha = 1;
  }

  hide(): void {
    this.visible = false;
    this.remaining = 0;
  }

  /** Ages the bubble; pops in, then fades out over the last 250 ms. */
  update(deltaMS: number): void {
    if (!this.visible) return;
    this.age += deltaMS;
    this.remaining -= deltaMS;
    if (this.remaining <= 0) {
      this.hide();
      return;
    }
    const pop = Math.min(1, this.age / POP_MS);
    const s = 0.6 + 0.4 * (1 - (1 - pop) * (1 - pop));
    this.scale.set(s);
    this.alpha = Math.min(1, this.remaining / 250);
  }
}
