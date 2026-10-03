import { describe, expect, it } from 'vitest';
import {
  BUBBLE_FADE_MS,
  BUBBLE_POP_MS,
  bubbleFont,
  bubbleMaxChars,
  bubblePop,
  bubbleText,
} from '../src/game/bubble-text.js';
import { IsoCamera } from '../src/game/three/camera.js';
import {
  anchorVisible,
  BUBBLE_LIFT_PX,
  bubbleAnchor,
  LABEL_LIFT_PX,
  labelAnchor,
  MOVE_EPSILON_PX,
  movedEnough,
  OFFSCREEN_MARGIN_PX,
  overlayTransform,
} from '../src/game/three/overlay-math.js';
import type { BubbleKind } from '../src/game/types.js';

const KINDS: BubbleKind[] = ['speech', 'thought', 'alert', 'code'];

describe('bubbleText (shared by the Pixi bubble and the Three overlay)', () => {
  it('collapses whitespace and truncates to 80 chars (40 for alerts) with an ellipsis', () => {
    expect(bubbleText('  hello\n  world ', 'speech')).toBe('hello world');
    const long = 'x'.repeat(200);
    for (const kind of KINDS) {
      const out = bubbleText(long, kind);
      expect(out.length).toBe(bubbleMaxChars(kind));
      expect(out.endsWith('…')).toBe(true);
    }
    expect(bubbleMaxChars('alert')).toBe(40);
    expect(bubbleMaxChars('speech')).toBe(80);
    expect(bubbleMaxChars('code')).toBe(80);
  });

  it('never yields an empty string (Pixi needs a glyph to measure)', () => {
    expect(bubbleText('', 'speech')).toBe(' ');
    expect(bubbleText('   ', 'thought')).toBe(' ');
  });

  it('is exactly what the Pixi bubble used to compute', () => {
    const raw = 'Running the test suite now, hold on a second while the results come in please';
    // Former inline rule: truncate(rawText, kind === 'alert' ? 40 : 80) || ' '.
    const oneLine = raw.replace(/\s+/g, ' ').trim();
    expect(bubbleText(raw, 'speech')).toBe(
      oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine,
    );
    expect(bubbleText(raw, 'alert')).toBe(`${oneLine.slice(0, 39)}…`);
  });

  it('uses the monospace size only for code', () => {
    expect(bubbleFont('code')).toEqual({ size: 10, lineHeight: 13 });
    for (const kind of ['speech', 'thought', 'alert'] as const)
      expect(bubbleFont(kind)).toEqual({ size: 11, lineHeight: 14 });
  });
});

describe('bubblePop', () => {
  it('pops from 0.6 to 1 and fades over the last 250 ms', () => {
    expect(bubblePop(0, 4000)).toEqual({ scale: 0.6, alpha: 1 });
    expect(bubblePop(BUBBLE_POP_MS, 4000).scale).toBeCloseTo(1, 9);
    expect(bubblePop(BUBBLE_POP_MS * 10, 4000).scale).toBeCloseTo(1, 9);
    const mid = bubblePop(BUBBLE_POP_MS / 2, 4000).scale;
    expect(mid).toBeGreaterThan(0.6);
    expect(mid).toBeLessThan(1);
    expect(bubblePop(1000, BUBBLE_FADE_MS / 2).alpha).toBeCloseTo(0.5, 9);
    expect(bubblePop(1000, 0).alpha).toBe(0);
    expect(bubblePop(1000, -10).alpha).toBe(0);
  });
});

describe('overlayTransform', () => {
  it('anchors the element bottom-centre at the canvas pixel, sub-pixel kept to 1/100', () => {
    expect(overlayTransform(100, 50)).toBe('translate(-50%, -100%) translate(100px, 50px)');
    expect(overlayTransform(12.3456, -0.004)).toBe(
      'translate(-50%, -100%) translate(12.35px, 0px)',
    );
  });

  it('agrees with the iso camera: a projected ground point lands where tileToScreen says', () => {
    const iso = new IsoCamera();
    iso.setScreen(800, 600);
    iso.setTransform(1, 400, 100);
    const p = iso.project({ x: 2, y: 0, z: 3 });
    // tileToScreen(2, 3) = ((2 − 3) × 32, (2 + 3) × 16) = (−32, 80), plus the pan offset.
    expect(p.sx).toBeCloseTo(400 - 32, 6);
    expect(p.sy).toBeCloseTo(100 + 80, 6);
    expect(overlayTransform(p.sx, p.sy)).toBe('translate(-50%, -100%) translate(368px, 180px)');
    // A point one unit up projects cos 30° × 45.25 px higher.
    const up = iso.project({ x: 2, y: 1, z: 3 });
    expect(up.sx).toBeCloseTo(p.sx, 6);
    expect(p.sy - up.sy).toBeCloseTo(Math.cos(Math.PI / 6) * (64 / Math.SQRT2), 3);
  });
});

describe('movedEnough', () => {
  it('writes the first position, then only moves of at least 0.5 px on either axis', () => {
    expect(MOVE_EPSILON_PX).toBe(0.5);
    expect(movedEnough(null, 0, 0)).toBe(true);
    const prev = { sx: 100, sy: 200 };
    expect(movedEnough(prev, 100.49, 200.49)).toBe(false);
    expect(movedEnough(prev, 100.5, 200)).toBe(true);
    expect(movedEnough(prev, 100, 199.5)).toBe(true);
    expect(movedEnough(prev, 99.4, 200.1)).toBe(true);
    expect(movedEnough(prev, 100.2, 200.2, 0.1)).toBe(true);
  });
});

describe('anchors', () => {
  it('hang the label and the bubble above the head, bubble higher than label', () => {
    const head = { sx: 300, sy: 240 };
    expect(labelAnchor(head)).toEqual({ sx: 300, sy: 240 - LABEL_LIFT_PX });
    expect(bubbleAnchor(head)).toEqual({ sx: 300, sy: 240 - BUBBLE_LIFT_PX });
    expect(BUBBLE_LIFT_PX).toBeGreaterThan(LABEL_LIFT_PX);
  });

  it('hide elements whose anchor is far outside the canvas (and non-finite ones)', () => {
    expect(anchorVisible(10, 10, 800, 600)).toBe(true);
    expect(anchorVisible(-OFFSCREEN_MARGIN_PX, 300, 800, 600)).toBe(true);
    expect(anchorVisible(-OFFSCREEN_MARGIN_PX - 1, 300, 800, 600)).toBe(false);
    expect(anchorVisible(400, 600 + OFFSCREEN_MARGIN_PX + 1, 800, 600)).toBe(false);
    expect(anchorVisible(Number.NaN, 0, 800, 600)).toBe(false);
    expect(anchorVisible(0, Number.POSITIVE_INFINITY, 800, 600)).toBe(false);
  });
});
