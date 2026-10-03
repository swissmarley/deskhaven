import {
  BUBBLE_MAX_WIDTH,
  BUBBLE_PAD_X,
  BUBBLE_PAD_Y,
  BUBBLE_TAIL,
  BUBBLE_THEMES,
  bubbleFont,
  bubblePop,
  bubbleText,
} from '../bubble-text.js';
import { toHex } from '../color.js';
import type { BubbleKind } from '../types.js';
import {
  anchorVisible,
  bubbleAnchor,
  labelAnchor,
  movedEnough,
  overlayTransform,
  type ScreenPos,
} from './overlay-math.js';

/**
 * DOM overlay for the Three renderer: one name label and one bubble per avatar, positioned every
 * frame from the projected top of the head (`setAnchor`), sized in CSS pixels regardless of zoom
 * (so text stays legible). The overlay sits inside the mount container over the canvas, ignores
 * pointer events and clips at the canvas edges. Texts, kinds and durations are the ones the core
 * passes to `showBubble` — the same `say()` calls that drive the Pixi bubbles.
 *
 * DOM traffic is kept low: `style.transform` is rewritten only when the anchor moved ≥ 0.5 px,
 * hidden elements get `display: none`, bubble pop/fade touch only `opacity` and a scale transform.
 */

const STYLE_ID = 'agenthotel-world-overlay-style';

interface Entry {
  label: HTMLDivElement;
  bubble: HTMLDivElement;
  labelPos: ScreenPos | null;
  bubblePos: ScreenPos | null;
  /** Last anchor received this frame, or null when off screen / not placed yet. */
  anchor: ScreenPos | null;
  labelShown: boolean;
  bubbleShown: boolean;
  bubbleRemaining: number;
  bubbleAge: number;
  bubbleKind: BubbleKind;
  bubbleScale: number;
  bubbleAlpha: number;
}

function css(): string {
  const themes = (Object.keys(BUBBLE_THEMES) as BubbleKind[])
    .map((kind) => {
      const t = BUBBLE_THEMES[kind];
      const font = bubbleFont(kind);
      const family = t.mono
        ? 'ui-monospace, Menlo, Consolas, monospace'
        : 'system-ui, -apple-system, Segoe UI, sans-serif';
      return `
.world-overlay .bubble[data-kind="${kind}"] { background: ${toHex(t.bg)}; color: ${toHex(t.fg)}; border-color: ${toHex(t.border)}; font-family: ${family}; font-size: ${font.size}px; line-height: ${font.lineHeight}px; font-weight: ${t.bold ? 'bold' : 'normal'}; }
.world-overlay .bubble[data-kind="${kind}"]::after { border-top-color: ${toHex(t.bg)}; }
.world-overlay .bubble[data-kind="${kind}"]::before { border-top-color: ${toHex(t.border)}; }
.world-overlay .bubble[data-kind="${kind}"] .dot { background: ${toHex(t.bg)}; border-color: ${toHex(t.border)}; }`;
    })
    .join('\n');
  return `
.world-overlay { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 2; }
.world-overlay > div { position: absolute; left: 0; top: 0; will-change: transform; white-space: nowrap; }
.world-overlay .label { font: 11px/14px system-ui, -apple-system, Segoe UI, sans-serif; color: #fff; padding: 0 2px; paint-order: stroke fill; -webkit-text-stroke: 3px #101418; text-shadow: 0 0 2px #101418, 0 1px 1px #101418; }
.world-overlay .label.intern { font-size: 10px; color: #cfd4dc; }
.world-overlay .bubble { box-sizing: border-box; max-width: ${BUBBLE_MAX_WIDTH}px; padding: ${BUBBLE_PAD_Y}px ${BUBBLE_PAD_X}px; margin-top: -${BUBBLE_TAIL}px; border: 1px solid; border-radius: 6px; white-space: normal; overflow-wrap: anywhere; text-align: left; transform-origin: 50% 100%; }
.world-overlay .bubble::before, .world-overlay .bubble::after { content: ''; position: absolute; left: 50%; top: 100%; transform: translateX(-50%); border: solid transparent; border-bottom: 0; }
.world-overlay .bubble::before { border-width: ${BUBBLE_TAIL + 1}px ${BUBBLE_TAIL + 1}px 0; }
.world-overlay .bubble::after { border-width: ${BUBBLE_TAIL - 0.5}px ${BUBBLE_TAIL - 0.5}px 0; margin-top: -1px; }
.world-overlay .bubble[data-kind="thought"]::before, .world-overlay .bubble[data-kind="thought"]::after { display: none; }
.world-overlay .bubble .dot { display: none; position: absolute; border-radius: 50%; border: 1px solid; }
.world-overlay .bubble[data-kind="thought"] .dot { display: block; }
.world-overlay .bubble .dot.a { width: 6px; height: 6px; left: calc(50% - 3px); top: calc(100% + 1px); }
.world-overlay .bubble .dot.b { width: 3px; height: 3px; left: calc(50% + 1px); top: calc(100% + 6px); }
${themes}
`;
}

/** Inject the overlay stylesheet once per document (scoped by the `world-overlay` class). */
function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css();
  doc.head.appendChild(style);
}

export class WorldOverlay {
  readonly root: HTMLDivElement;
  private readonly entries = new Map<string, Entry>();
  private width = 1;
  private height = 1;

  constructor(container: HTMLElement) {
    const doc = container.ownerDocument;
    ensureStyle(doc);
    this.root = doc.createElement('div');
    this.root.className = 'world-overlay';
    container.appendChild(this.root);
  }

  /** Number of avatars with elements (the stats overlay's avatar count). */
  get size(): number {
    return this.entries.size;
  }

  /** Canvas size in CSS px, for the off-screen test. */
  setScreen(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  add(id: string, name: string, intern: boolean): void {
    this.remove(id);
    const doc = this.root.ownerDocument;
    const label = doc.createElement('div');
    label.className = intern ? 'label intern' : 'label';
    label.textContent = name;
    label.style.display = 'none';
    const bubble = doc.createElement('div');
    bubble.className = 'bubble';
    bubble.dataset.kind = 'speech';
    bubble.style.display = 'none';
    const text = doc.createElement('span');
    text.className = 'text';
    const dotA = doc.createElement('span');
    dotA.className = 'dot a';
    const dotB = doc.createElement('span');
    dotB.className = 'dot b';
    bubble.append(text, dotA, dotB);
    this.root.append(label, bubble);
    this.entries.set(id, {
      label,
      bubble,
      labelPos: null,
      bubblePos: null,
      anchor: null,
      labelShown: false,
      bubbleShown: false,
      bubbleRemaining: 0,
      bubbleAge: 0,
      bubbleKind: 'speech',
      bubbleScale: 1,
      bubbleAlpha: 1,
    });
  }

  remove(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.label.remove();
    e.bubble.remove();
    this.entries.delete(id);
  }

  setName(id: string, name: string): void {
    const e = this.entries.get(id);
    if (e && e.label.textContent !== name) e.label.textContent = name;
  }

  setIntern(id: string, intern: boolean): void {
    const e = this.entries.get(id);
    if (!e) return;
    const cls = intern ? 'label intern' : 'label';
    if (e.label.className !== cls) e.label.className = cls;
  }

  /** Canvas pixel of the top of the avatar's head this frame; null hides its elements. */
  setAnchor(id: string, pos: ScreenPos | null): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.anchor = pos && anchorVisible(pos.sx, pos.sy, this.width, this.height) ? pos : null;
  }

  showBubble(id: string, text: string, kind: BubbleKind, durationMs: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    const span = e.bubble.firstElementChild;
    if (span) span.textContent = bubbleText(text, kind);
    if (e.bubbleKind !== kind) {
      e.bubbleKind = kind;
      e.bubble.dataset.kind = kind;
    }
    e.bubbleRemaining = durationMs;
    e.bubbleAge = 0;
    e.bubbleScale = -1;
    e.bubbleAlpha = -1;
    // Force a transform rewrite so the pop starts from the fresh scale.
    e.bubblePos = null;
  }

  hideBubble(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.bubbleRemaining = 0;
  }

  /** Whether the avatar's bubble is currently showing (tests and the scene's bookkeeping). */
  bubbleActive(id: string): boolean {
    return (this.entries.get(id)?.bubbleRemaining ?? 0) > 0;
  }

  /** Age bubbles and write positions; call once per frame after every `setAnchor`. */
  update(dtMs: number): void {
    for (const e of this.entries.values()) {
      // Label.
      const showLabel = e.anchor !== null;
      if (showLabel && e.anchor) {
        const a = labelAnchor(e.anchor);
        if (movedEnough(e.labelPos, a.sx, a.sy)) {
          e.label.style.transform = overlayTransform(a.sx, a.sy);
          e.labelPos = a;
        }
      }
      if (showLabel !== e.labelShown) {
        e.label.style.display = showLabel ? '' : 'none';
        e.labelShown = showLabel;
      }
      // Bubble.
      if (e.bubbleRemaining > 0) {
        e.bubbleAge += dtMs;
        e.bubbleRemaining -= dtMs;
      }
      const showBubble = e.bubbleRemaining > 0 && e.anchor !== null;
      if (showBubble && e.anchor) {
        const { scale, alpha } = bubblePop(e.bubbleAge, e.bubbleRemaining);
        const a = bubbleAnchor(e.anchor);
        const scaleChanged = Math.abs(scale - e.bubbleScale) >= 0.005;
        if (scaleChanged || movedEnough(e.bubblePos, a.sx, a.sy)) {
          e.bubble.style.transform = `${overlayTransform(a.sx, a.sy)} scale(${scale.toFixed(3)})`;
          e.bubblePos = a;
          e.bubbleScale = scale;
        }
        if (Math.abs(alpha - e.bubbleAlpha) >= 0.01) {
          e.bubble.style.opacity = alpha.toFixed(2);
          e.bubbleAlpha = alpha;
        }
      }
      if (showBubble !== e.bubbleShown) {
        e.bubble.style.display = showBubble ? '' : 'none';
        e.bubbleShown = showBubble;
      }
    }
  }

  destroy(): void {
    for (const id of [...this.entries.keys()]) this.remove(id);
    this.root.remove();
  }
}
