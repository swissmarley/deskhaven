import type { Avatar, Facing } from '@deskhaven/shared';
import { describe, expect, it } from 'vitest';
import { contrastColor, hslToRgb, rgbToHsl, toHex } from '../src/game/color.js';
import {
  canRenderPreview,
  FACINGS,
  FRAME_H,
  FRAME_W,
  frameKey,
  generateAvatarSheet,
  layoutAvatarSheet,
  type PlannedPixel,
  POSE_FRAME_COUNT,
  planAvatarPixels,
  renderAvatarPreview,
  SHEET_POSES,
  type SheetPose,
} from '../src/game/sprites.js';

const BASE: Avatar = {
  skin: '#f1c27d',
  hair: '#4a2c17',
  hairStyle: 'short',
  shirt: '#3a86ff',
  pants: '#3d405b',
  accessory: 'none',
};

const parts = (px: PlannedPixel[], part: PlannedPixel['part']) => px.filter((p) => p.part === part);
const sig = (px: PlannedPixel[]) => px.map((p) => `${p.x},${p.y},${p.color}`).join('|');

describe('layoutAvatarSheet', () => {
  it('has every facing × pose frame with non-overlapping rects inside the sheet', () => {
    const layout = layoutAvatarSheet(2);
    const total = FACINGS.length * SHEET_POSES.reduce((n, p) => n + POSE_FRAME_COUNT[p], 0);
    expect(Object.keys(layout.frames)).toHaveLength(total);
    expect(layout.frameW).toBe(FRAME_W * 2);
    expect(layout.frameH).toBe(FRAME_H * 2);
    const rects = Object.entries(layout.frames);
    for (const facing of FACINGS) {
      for (const pose of SHEET_POSES) {
        for (let i = 0; i < POSE_FRAME_COUNT[pose]; i++) {
          const r = layout.frames[frameKey(pose, facing, i)];
          expect(r, `${pose}/${facing}/${i}`).toBeDefined();
          if (!r) continue;
          expect(r.w).toBe(layout.frameW);
          expect(r.h).toBe(layout.frameH);
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(layout.width);
          expect(r.y + r.h).toBeLessThanOrEqual(layout.height);
        }
      }
    }
    for (let a = 0; a < rects.length; a++) {
      for (let b = a + 1; b < rects.length; b++) {
        const [ka, ra] = rects[a] as [string, { x: number; y: number; w: number; h: number }];
        const [kb, rb] = rects[b] as [string, { x: number; y: number; w: number; h: number }];
        const overlap =
          ra.x < rb.x + rb.w && rb.x < ra.x + ra.w && ra.y < rb.y + rb.h && rb.y < ra.y + ra.h;
        expect(overlap, `${ka} overlaps ${kb}`).toBe(false);
      }
    }
  });

  it('normalises the scale to a positive integer', () => {
    expect(layoutAvatarSheet(2.4).scale).toBe(2);
    expect(layoutAvatarSheet(0).scale).toBe(2);
    expect(layoutAvatarSheet(3).frameW).toBe(FRAME_W * 3);
  });
});

describe('planAvatarPixels', () => {
  it('is deterministic, in-bounds and free of duplicate cells', () => {
    for (const facing of FACINGS) {
      for (const pose of SHEET_POSES) {
        for (let i = 0; i < POSE_FRAME_COUNT[pose]; i++) {
          const a = planAvatarPixels(BASE, facing, pose, i);
          const b = planAvatarPixels({ ...BASE }, facing, pose, i);
          expect(sig(a)).toBe(sig(b));
          expect(a.length).toBeGreaterThan(60);
          const seen = new Set<string>();
          for (const p of a) {
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThan(FRAME_W);
            expect(p.y).toBeLessThan(FRAME_H);
            expect(p.color).toMatch(/^#[0-9a-f]{6}$/);
            const k = `${p.x},${p.y}`;
            expect(seen.has(k)).toBe(false);
            seen.add(k);
          }
        }
      }
    }
  });

  it('draws every body part in the avatar colours', () => {
    const px = planAvatarPixels(BASE, 2, 'idle');
    for (const part of ['skin', 'hair', 'eye', 'shirt', 'pants', 'shoe'] as const)
      expect(parts(px, part).length, part).toBeGreaterThan(0);
    expect(parts(px, 'skin').some((p) => p.color === BASE.skin)).toBe(true);
    expect(parts(px, 'hair').some((p) => p.color === BASE.hair)).toBe(true);
    expect(parts(px, 'shirt').some((p) => p.color === BASE.shirt)).toBe(true);
    expect(parts(px, 'pants').some((p) => p.color === BASE.pants)).toBe(true);
    // Shading: a darker tone exists on the right side of the head and torso.
    const skin = parts(px, 'skin');
    const skinColors = new Set(skin.map((p) => p.color));
    expect(skinColors.size).toBe(2);
    const darkSkinXs = skin.filter((p) => p.color !== BASE.skin).map((p) => p.x);
    expect(Math.min(...darkSkinXs)).toBeGreaterThan(
      Math.max(...skin.filter((p) => p.color === BASE.skin).map((p) => p.x)) - 3,
    );
    // Feet sit on the last row.
    expect(Math.max(...parts(px, 'shoe').map((p) => p.y))).toBe(FRAME_H - 1);
  });

  it('bald produces no hair pixels, every other style does', () => {
    expect(parts(planAvatarPixels({ ...BASE, hairStyle: 'bald' }, 2, 'idle'), 'hair')).toHaveLength(
      0,
    );
    expect(parts(planAvatarPixels({ ...BASE, hairStyle: 'bald' }, 0, 'idle'), 'hair')).toHaveLength(
      0,
    );
    const counts: Record<string, number> = {};
    for (const style of ['short', 'long', 'cap', 'bun'] as const) {
      const n = parts(planAvatarPixels({ ...BASE, hairStyle: style }, 2, 'idle'), 'hair').length;
      expect(n, style).toBeGreaterThan(0);
      counts[style] = n;
    }
    // Long hair reaches below the ears; the bun sits above the hairline; the cap uses the shirt tone.
    const long = parts(planAvatarPixels({ ...BASE, hairStyle: 'long' }, 2, 'idle'), 'hair');
    const short = parts(planAvatarPixels({ ...BASE, hairStyle: 'short' }, 2, 'idle'), 'hair');
    expect(Math.max(...long.map((p) => p.y))).toBeGreaterThan(
      Math.max(...short.map((p) => p.y)) + 3,
    );
    const bun = parts(planAvatarPixels({ ...BASE, hairStyle: 'bun' }, 2, 'idle'), 'hair');
    expect(Math.min(...bun.map((p) => p.y))).toBeLessThan(Math.min(...short.map((p) => p.y)));
    const cap = parts(planAvatarPixels({ ...BASE, hairStyle: 'cap' }, 2, 'idle'), 'hair');
    expect(cap.some((p) => p.color === BASE.hair)).toBe(true); // hair under the brim
    expect(cap.some((p) => p.color !== BASE.hair && p.color !== '#35200f')).toBe(true);
    expect(cap.some((p) => p.color === BASE.hair || p.color === BASE.shirt)).toBe(true);
  });

  it('front views have eye pixels and back views have none', () => {
    for (const facing of [1, 2] as const)
      expect(parts(planAvatarPixels(BASE, facing, 'idle'), 'eye').length).toBe(4);
    for (const facing of [0, 3] as const)
      expect(parts(planAvatarPixels(BASE, facing, 'idle'), 'eye')).toHaveLength(0);
    // Napping closes the eyes to a single row each.
    expect(parts(planAvatarPixels(BASE, 2, 'nap'), 'eye').length).toBe(2);
  });

  it('glasses add accessory pixels next to the eyes; other accessories land where expected', () => {
    const plain = planAvatarPixels(BASE, 2, 'idle');
    expect(parts(plain, 'accessory')).toHaveLength(0);
    const glasses = planAvatarPixels({ ...BASE, accessory: 'glasses' }, 2, 'idle');
    const eyes = parts(glasses, 'eye');
    const acc = parts(glasses, 'accessory');
    expect(eyes.length).toBe(4); // eyes stay visible through the lenses
    expect(acc.length).toBeGreaterThan(0);
    for (const a of acc) {
      const near = eyes.some((e) => Math.abs(e.x - a.x) <= 2 && Math.abs(e.y - a.y) <= 1);
      expect(near, `glasses pixel ${a.x},${a.y}`).toBe(true);
    }
    expect(
      parts(planAvatarPixels({ ...BASE, accessory: 'glasses' }, 0, 'idle'), 'accessory'),
    ).toHaveLength(0);

    const headset = parts(
      planAvatarPixels({ ...BASE, accessory: 'headset' }, 0, 'idle'),
      'accessory',
    );
    expect(headset.length).toBeGreaterThan(6); // band + cups visible from behind too
    expect(Math.min(...headset.map((p) => p.y))).toBeLessThanOrEqual(3);

    const tie = parts(planAvatarPixels({ ...BASE, accessory: 'tie' }, 2, 'idle'), 'accessory');
    expect(tie.length).toBeGreaterThan(3);
    for (const p of tie) expect(p.y).toBeGreaterThanOrEqual(13); // on the shirt
    expect(
      parts(planAvatarPixels({ ...BASE, accessory: 'tie' }, 3, 'idle'), 'accessory'),
    ).toHaveLength(0);

    const scarf = parts(planAvatarPixels({ ...BASE, accessory: 'scarf' }, 2, 'idle'), 'accessory');
    expect(scarf.some((p) => p.y === 12)).toBe(true); // neck band
    expect(new Set(scarf.map((p) => p.color)).has(BASE.shirt)).toBe(false); // contrasting colour
  });

  it('walk frames all differ from each other and from idle', () => {
    for (const facing of FACINGS) {
      const sigs = [0, 1, 2, 3].map((i) => sig(planAvatarPixels(BASE, facing, 'walk', i)));
      expect(new Set(sigs).size).toBe(4);
      expect(sigs).not.toContain(sig(planAvatarPixels(BASE, facing, 'idle')));
    }
  });

  it('type frames alternate and the other poses are distinct', () => {
    for (const facing of FACINGS) {
      expect(sig(planAvatarPixels(BASE, facing, 'type', 0))).not.toBe(
        sig(planAvatarPixels(BASE, facing, 'type', 1)),
      );
      const poses: SheetPose[] = ['idle', 'sit', 'type', 'read', 'raise', 'nap'];
      const sigs = poses.map((p) => sig(planAvatarPixels(BASE, facing, p, 0)));
      expect(new Set(sigs).size).toBe(poses.length);
    }
    // Reading shows a book in front; raising puts skin above the head.
    const read = planAvatarPixels(BASE, 2, 'read');
    expect(parts(read, 'prop').length).toBeGreaterThan(0);
    const raise = planAvatarPixels(BASE, 2, 'raise');
    expect(Math.min(...parts(raise, 'skin').map((p) => p.y))).toBeLessThan(4);
  });

  it('facings mirror the side the avatar looks towards', () => {
    const east = planAvatarPixels(BASE, 1, 'idle');
    const south = planAvatarPixels(BASE, 2, 'idle');
    const eyeX = (px: PlannedPixel[]) => parts(px, 'eye').reduce((s, p) => s + p.x, 0) / 4;
    expect(eyeX(east)).toBeGreaterThan(eyeX(south));
    const back: Facing[] = [0, 3];
    for (const f of back)
      expect(parts(planAvatarPixels(BASE, f, 'idle'), 'hair').length).toBeGreaterThan(
        parts(planAvatarPixels(BASE, 2, 'idle'), 'hair').length,
      );
  });

  it('falls back to default colours for unparsable hex strings', () => {
    const px = planAvatarPixels({ ...BASE, skin: 'nope', shirt: '' }, 2, 'idle');
    expect(parts(px, 'skin').some((p) => p.color === '#f1c27d')).toBe(true);
    expect(parts(px, 'shirt').some((p) => p.color === '#3a86ff')).toBe(true);
  });
});

describe('colour helpers', () => {
  it('round-trips hex and HSL', () => {
    expect(toHex(0x3a86ff)).toBe('#3a86ff');
    expect(toHex(0x000001)).toBe('#000001');
    const [h, s, l] = rgbToHsl(0x3a86ff);
    expect(hslToRgb(h, s, l)).toBe(0x3a86ff);
    expect(rgbToHsl(0x808080)[1]).toBe(0);
  });

  it('contrastColor differs clearly from its base', () => {
    for (const c of [0x3a86ff, 0xffffff, 0x000000, 0x808080, 0xff595e]) {
      const k = contrastColor(c);
      const dr = Math.abs(((k >> 16) & 0xff) - ((c >> 16) & 0xff));
      const dg = Math.abs(((k >> 8) & 0xff) - ((c >> 8) & 0xff));
      const db = Math.abs((k & 0xff) - (c & 0xff));
      expect(dr + dg + db).toBeGreaterThan(120);
    }
  });
});

describe('canvas-backed rendering', () => {
  const hasCanvas = canRenderPreview();

  it.skipIf(!hasCanvas)('renderAvatarPreview returns a PNG data URL', () => {
    const url = renderAvatarPreview(BASE, 2, 4);
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    expect(renderAvatarPreview(BASE, 2, 4)).toBe(url);
  });

  it.skipIf(!hasCanvas)('generateAvatarSheet paints a sheet matching the layout', () => {
    const sheet = generateAvatarSheet(BASE, { scale: 2 });
    const layout = layoutAvatarSheet(2);
    expect(sheet.frames).toEqual(layout.frames);
    expect(sheet.canvas.width).toBe(layout.width);
    expect(sheet.canvas.height).toBe(layout.height);
  });

  it.skipIf(hasCanvas)('generateAvatarSheet throws a clear error without a canvas', () => {
    expect(() => generateAvatarSheet(BASE)).toThrow(/canvas/i);
    expect(() => renderAvatarPreview(BASE)).toThrow(/canvas/i);
  });
});
