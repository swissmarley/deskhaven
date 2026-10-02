/**
 * Placeholder floor and wall palettes shared by the painters and the editor's style pickers.
 * Pure data, no Pixi.
 */

/** Floor style id → `[light, dark]` checker pair. Unknown ids fall back to style 0. */
export const FLOOR_STYLES: readonly (readonly [number, number])[] = [
  [0xcfd8dc, 0xb7c4cb], // 0 tile
  [0xe9a23b, 0xd9922b], // 1 rug
  [0x3b4252, 0x363c4a], // 2 dark tile
  [0xb5835a, 0xac7b53], // 3 wood
  [0x6fbf73, 0x67b56b], // 4 grass
];
export const FLOOR_STYLE_LABELS: readonly string[] = ['Tile', 'Rug', 'Dark tile', 'Wood', 'Grass'];
export const FLOOR_STYLE_COUNT = FLOOR_STYLES.length;

/** Wall style id → `[north face, west face]`. Unknown ids fall back to style 0. */
export const WALL_STYLES: readonly (readonly [number, number])[] = [
  [0x66788a, 0x50606f], // 0 plaster
  [0x9a4b3c, 0x7d3c30], // 1 brick
  [0xd9dee3, 0xbcc4cc], // 2 light
];
export const WALL_STYLE_LABELS: readonly string[] = ['Plaster', 'Brick', 'Light'];
export const WALL_STYLE_COUNT = WALL_STYLES.length;

export function floorStyleColors(style: number): readonly [number, number] {
  return FLOOR_STYLES[style] ?? FLOOR_STYLES[0] ?? [0xcccccc, 0xbbbbbb];
}

export function wallStyleColor(side: 'north' | 'west', style: number): number {
  const pair = WALL_STYLES[style] ?? WALL_STYLES[0] ?? [0x66788a, 0x50606f];
  return side === 'north' ? pair[0] : pair[1];
}
