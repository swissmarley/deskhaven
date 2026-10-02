import {
  FURNITURE_CATALOG,
  type Furniture,
  interactionTiles,
  type Room,
  rotatedSize,
} from '@agenthotel/shared';
import { Container, Graphics, Polygon, Text, TextStyle } from 'pixi.js';
import type { Painters } from './assets/index.js';
import { depthKey, FACING_DIR, tileDiamond, tileToScreen } from './iso.js';
import type { TilePoint } from './types.js';

export interface RoomLayers {
  floor: Container;
  grid: Container;
  objects: Container;
  ui: Container;
}

const LABEL_STYLE = new TextStyle({
  fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
  fontSize: 10,
  fill: 0x101418,
  stroke: { color: 0xffffff, width: 2 },
});

/** Flat non-blocking pieces (rug) are floor decals, drawn beneath avatars rather than depth-sorted. */
export function isDecal(kind: Furniture['kind']): boolean {
  const spec = FURNITURE_CATALOG[kind];
  return !spec.blocks && spec.height <= 4;
}

/** Placeholder furniture: shadow + coloured prism + label. Clicks are resolved by the world. */
export class FurnitureSprite extends Container {
  readonly furnitureId: string;
  readonly kind: Furniture['kind'];

  constructor(piece: Furniture, painters: Painters) {
    super();
    this.furnitureId = piece.id;
    this.kind = piece.kind;
    const g = new Graphics();
    const shape = painters.furniture(g, piece.kind, piece.rotation);
    const label = new Text({
      text: FURNITURE_CATALOG[piece.kind].label,
      style: LABEL_STYLE,
      anchor: 0.5,
      resolution: 2,
    });
    label.position.set(shape.labelX, shape.labelY);
    this.addChild(g, label);
    const { sx, sy } = tileToScreen(piece.x, piece.y);
    this.position.set(sx, sy);
    // Sort by the piece's front-most tile so avatars in front of it draw over it.
    const { w, h } = rotatedSize(piece.kind, piece.rotation);
    this.zIndex = depthKey(piece.x + w - 1, piece.y + h - 1);
    this.eventMode = 'static';
    this.interactiveChildren = false;
    this.cursor = 'pointer';
    this.hitArea = new Polygon(shape.outline);
  }
}

/**
 * Draws the static room: walls, floor, decals and interaction markers into the floor layer, the
 * tile grid into the grid layer, furniture prisms into the objects layer, and hover / highlight
 * diamonds into the ui layer.
 */
export class RoomView {
  private readonly wallG = new Graphics();
  private readonly floorG = new Graphics();
  private readonly markerG = new Graphics();
  private readonly gridG = new Graphics();
  private readonly hoverG = new Graphics();
  private readonly highlightG = new Graphics();
  private furniture: FurnitureSprite[] = [];
  private readonly diamond: number[] = [];

  constructor(
    private readonly layers: RoomLayers,
    private readonly painters: Painters,
  ) {
    for (const g of [
      this.wallG,
      this.floorG,
      this.markerG,
      this.gridG,
      this.hoverG,
      this.highlightG,
    ])
      g.eventMode = 'none';
    layers.floor.addChild(this.wallG, this.floorG, this.markerG);
    layers.grid.addChild(this.gridG);
    layers.ui.addChild(this.highlightG, this.hoverG);
  }

  setRoom(room: Room): void {
    for (const f of this.furniture) f.destroy({ children: true });
    this.furniture = [];
    this.drawWalls(room);
    this.drawFloor(room);
    this.drawGrid(room);
    this.drawMarkers(room);
    for (const piece of room.furniture) {
      const sprite = new FurnitureSprite(piece, this.painters);
      if (isDecal(piece.kind)) {
        this.layers.floor.addChild(sprite);
      } else {
        this.layers.objects.addChild(sprite);
      }
      this.furniture.push(sprite);
    }
  }

  setGridVisible(visible: boolean): void {
    this.gridG.visible = visible;
  }

  get gridVisible(): boolean {
    return this.gridG.visible;
  }

  setHover(tile: TilePoint | null): void {
    this.hoverG.clear();
    if (!tile) return;
    this.hoverG
      .poly(tileDiamond(tile.x, tile.y, this.diamond))
      .fill({ color: 0xffffff, alpha: 0.12 })
      .stroke({ width: 1.5, color: 0xffffff, alpha: 0.7 });
  }

  setHighlightTile(tile: TilePoint | null): void {
    this.highlightG.clear();
    if (!tile) return;
    this.highlightG
      .poly(tileDiamond(tile.x, tile.y, this.diamond))
      .fill({ color: 0xffd166, alpha: 0.35 })
      .stroke({ width: 2, color: 0xffd166 });
  }

  destroy(): void {
    for (const f of this.furniture) f.destroy({ children: true });
    this.furniture = [];
    for (const g of [
      this.wallG,
      this.floorG,
      this.markerG,
      this.gridG,
      this.hoverG,
      this.highlightG,
    ])
      g.destroy();
  }

  private drawWalls(room: Room): void {
    const g = this.wallG;
    g.clear();
    for (let x = 0; x < room.width; x++)
      this.painters.wallSegment(g, 'north', x, room.walls[x] ?? 0);
    for (let y = 0; y < room.height; y++)
      this.painters.wallSegment(g, 'west', y, room.walls[room.width + y] ?? 0);
  }

  private drawFloor(room: Room): void {
    const g = this.floorG;
    g.clear();
    for (let y = 0; y < room.height; y++)
      for (let x = 0; x < room.width; x++)
        this.painters.floorTile(g, x, y, room.floor[y * room.width + x] ?? 0);
  }

  private drawGrid(room: Room): void {
    const g = this.gridG;
    g.clear();
    for (let y = 0; y < room.height; y++)
      for (let x = 0; x < room.width; x++)
        g.poly(tileDiamond(x, y, this.diamond)).stroke({ width: 1, color: 0x000000, alpha: 0.18 });
  }

  /** Small triangles on interaction tiles pointing the way the avatar will face (seat = amber, stand = cyan). */
  private drawMarkers(room: Room): void {
    const g = this.markerG;
    g.clear();
    for (const piece of room.furniture) {
      for (const p of interactionTiles(piece.kind, piece.x, piece.y, piece.rotation)) {
        if (p.x < 0 || p.y < 0 || p.x >= room.width || p.y >= room.height) continue;
        const c = tileToScreen(p.x, p.y);
        const d = FACING_DIR[p.facing] ?? [0, 1];
        // Perpendicular in iso: swap and flatten so the base follows the diamond's slope.
        const px = -d[1];
        const py = d[0] * 0.5;
        g.poly([
          c.sx + d[0] * 11,
          c.sy + d[1] * 11,
          c.sx - d[0] * 4 + px * 6,
          c.sy - d[1] * 4 + py * 6,
          c.sx - d[0] * 4 - px * 6,
          c.sy - d[1] * 4 - py * 6,
        ]).fill({ color: p.type === 'seat' ? 0xffd166 : 0x4cc9f0, alpha: 0.75 });
      }
    }
  }
}
