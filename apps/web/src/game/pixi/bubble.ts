import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import {
  bubbleFont,
  bubblePop,
  bubbleText,
  BUBBLE_MAX_WIDTH as MAX_WIDTH,
  BUBBLE_PAD_X as PAD_X,
  BUBBLE_PAD_Y as PAD_Y,
  BUBBLE_TAIL as TAIL,
  BUBBLE_THEMES as THEMES,
} from '../bubble-text.js';
import type { BubbleKind } from '../types.js';

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
    const font = bubbleFont(kind);
    this.text.style = new TextStyle({
      fontFamily: theme.mono
        ? 'ui-monospace, Menlo, Consolas, monospace'
        : 'system-ui, -apple-system, Segoe UI, sans-serif',
      fontSize: font.size,
      fontWeight: theme.bold ? 'bold' : 'normal',
      fill: theme.fg,
      wordWrap: true,
      wordWrapWidth: MAX_WIDTH - PAD_X * 2,
      breakWords: true,
      lineHeight: font.lineHeight,
    });
    this.text.text = bubbleText(rawText, kind);
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
    const { scale, alpha } = bubblePop(this.age, this.remaining);
    this.scale.set(scale);
    this.alpha = alpha;
  }
}
