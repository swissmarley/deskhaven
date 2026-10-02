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
