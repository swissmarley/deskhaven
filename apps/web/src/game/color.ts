/** Multiply an 0xRRGGBB colour's channels by `k` (clamped to 255). */
export function shade(color: number, k: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * k));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * k));
  const b = Math.min(255, Math.round((color & 0xff) * k));
  return (r << 16) | (g << 8) | b;
}

/** Parse `#rrggbb` / `rrggbb` / `#rgb` / `0xrrggbb`; anything else yields `fallback`. */
export function parseHex(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  let s = input.trim().replace(/^#/, '').replace(/^0x/i, '');
  if (/^[0-9a-f]{3}$/i.test(s))
    s = s
      .split('')
      .map((c) => c + c)
      .join('');
  if (!/^[0-9a-f]{6}$/i.test(s)) return fallback;
  return Number.parseInt(s, 16);
}

/** `0xRRGGBB` → `#rrggbb` (CSS). */
export function toHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** `0xRRGGBB` → hue, saturation, lightness, each in [0, 1]. */
export function rgbToHsl(color: number): [number, number, number] {
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

/** Hue, saturation, lightness in [0, 1] → `0xRRGGBB`. */
export function hslToRgb(h: number, s: number, l: number): number {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const r = Math.round(channel(h + 1 / 3) * 255);
  const g = Math.round(channel(h) * 255);
  const b = Math.round(channel(h - 1 / 3) * 255);
  return (r << 16) | (g << 8) | b;
}

/**
 * A colour that reads clearly against `color`: the opposite hue, well saturated, and darker when
 * the base is light (or lighter when it is dark). Used for ties and scarves.
 */
export function contrastColor(color: number): number {
  const [h, s, l] = rgbToHsl(color);
  // Neutral bases get no hue contrast, so push their lightness further instead.
  const neutral = s < 0.15;
  const lightness = l > 0.5 ? (neutral ? 0.25 : 0.35) : neutral ? 0.75 : 0.6;
  return hslToRgb((h + 0.5) % 1, Math.max(0.55, s), lightness);
}

/** Wash a colour out for interns: half the saturation, lighter. */
export function internTint(color: number): number {
  const [h, s, l] = rgbToHsl(color);
  return hslToRgb(h, s * 0.5, Math.min(0.9, l + 0.18));
}
