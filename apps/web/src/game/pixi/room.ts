import {
  FURNITURE_CATALOG,
  type Furniture,
  interactionTiles,
  type Room,
  rotatedSize,
} from '@deskhaven/shared';
import { Container, Graphics, Polygon, Text, TextStyle } from 'pixi.js';
import type { Painters } from '../assets/index.js';
import { GHOST_ALPHA, ghostTint } from '../editor.js';
import { depthKey, FACING_DIR, isoRectPoints, tileDiamond, tileToScreen } from '../iso.js';
import type { Ghost, TilePoint } from '../types.js';

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

const HIGHLIGHT_COLOR = 0xffd166;
/** The ghost sorts above furniture sharing its row but below avatars (which use 500). */
const GHOST_DEPTH_EXTRA = 400;
const DRAG_ALPHA = 0.5;

/** Flat non-blocking pieces (rug) are floor decals, drawn beneath avatars rather than depth-sorted. */
export function isDecal(kind: Furniture['kind']): boolean {
  const spec = FURNITURE_CATALOG[kind];
  return !spec.blocks && spec.height <= 4;
}

/** Placeholder furniture: shadow + coloured prism + label. Clicks are resolved by the world. */
export class FurnitureSprite extends Container {
  readonly furnitureId: string;
  readonly kind: Furniture['kind'];
  private placed: Furniture;
  private readonly ring = new Graphics();
  private readonly outline: number[];
  private readonly size: { w: number; h: number };

  constructor(piece: Furniture, painters: Painters) {
    super();
    this.furnitureId = piece.id;
    this.kind = piece.kind;
    this.placed = piece;
    this.size = rotatedSize(piece.kind, piece.rotation);
    const g = new Graphics();
    const shape = painters.furniture(g, piece.kind, piece.rotation);
    this.outline = shape.outline;
    const label = new Text({
      text: FURNITURE_CATALOG[piece.kind].label,
      style: LABEL_STYLE,
      anchor: 0.5,
      resolution: 2,
    });
    label.position.set(shape.labelX, shape.labelY);
    this.ring.eventMode = 'none';
    this.addChild(g, this.ring, label);
    this.moveTo(piece.x, piece.y);
    this.eventMode = 'static';
    this.interactiveChildren = false;
    this.cursor = 'pointer';
    this.hitArea = new Polygon(shape.outline);
  }

  /** The piece as last applied through `setRoom` (origin tile and rotation). */
  get piece(): Furniture {
    return this.placed;
  }

  /** Adopt a new placement of the same kind and rotation (moved, or unchanged). */
  setPlacement(piece: Furniture): void {
    this.placed = piece;
    this.moveTo(piece.x, piece.y);
  }

  /** Position the sprite as if its origin tile were (x, y); used for the drag preview. */
  moveTo(x: number, y: number): void {
    const { sx, sy } = tileToScreen(x, y);
    this.position.set(sx, sy);
    // Sort by the piece's front-most tile so avatars in front of it draw over it.
    this.zIndex = depthKey(x + this.size.w - 1, y + this.size.h - 1);
  }

  /** Selection outline around the prism. */
  setHighlighted(on: boolean): void {
    this.ring.clear();
    if (!on) return;
    this.ring
      .poly(this.outline)
      .fill({ color: HIGHLIGHT_COLOR, alpha: 0.15 })
      .stroke({ width: 2, color: HIGHLIGHT_COLOR });
  }

  /** Semi-transparent while dragged; turning it off snaps the sprite back to its real origin. */
  setDragging(on: boolean): void {
    this.alpha = on ? DRAG_ALPHA : 1;
    if (!on) this.moveTo(this.placed.x, this.placed.y);
  }
}

/**
 * Draws the room: walls, floor, decals and interaction markers into the floor layer, the tile grid
 * into the grid layer, furniture prisms (and the placement ghost) into the objects layer, and
 * hover / highlight diamonds into the ui layer. Furniture sprites are keyed by id so repeated
 * `setRoom` calls (every editor stroke) only touch what changed.
 */
export class RoomView {
  private readonly wallG = new Graphics();
  private readonly floorG = new Graphics();
  private readonly markerG = new Graphics();
  private readonly gridG = new Graphics();
  private readonly hoverG = new Graphics();
  private readonly highlightG = new Graphics();
  private readonly ghostG = new Graphics();
  private readonly furniture = new Map<string, FurnitureSprite>();
  private readonly diamond: number[] = [];
  private highlightedFurniture: string | null = null;
  private editor = false;

  constructor(
    private readonly layers: RoomLayers,
    private readonly painters: Painters,
  ) {
    for (const g of this.graphics()) g.eventMode = 'none';
    this.ghostG.visible = false;
    layers.floor.addChild(this.wallG, this.floorG, this.markerG);
    layers.grid.addChild(this.gridG);
    layers.objects.addChild(this.ghostG);
    layers.ui.addChild(this.highlightG, this.hoverG);
  }

  setRoom(room: Room): void {
    this.drawWalls(room);
    this.drawFloor(room);
    this.drawGrid(room);
    this.drawMarkers(room);
    const seen = new Set<string>();
    for (const piece of room.furniture) {
      seen.add(piece.id);
      const existing = this.furniture.get(piece.id);
      if (existing && existing.kind === piece.kind && existing.piece.rotation === piece.rotation) {
        existing.setPlacement(piece);
        continue;
      }
      existing?.destroy({ children: true });
      const sprite = new FurnitureSprite(piece, this.painters);
      sprite.cursor = this.editor ? 'grab' : 'pointer';
      if (piece.id === this.highlightedFurniture) sprite.setHighlighted(true);
      (isDecal(piece.kind) ? this.layers.floor : this.layers.objects).addChild(sprite);
      this.furniture.set(piece.id, sprite);
    }
    for (const [id, sprite] of this.furniture) {
      if (seen.has(id)) continue;
      sprite.destroy({ children: true });
      this.furniture.delete(id);
    }
  }

  /** The live sprite for a piece, or null once it has been removed or replaced. */
  furnitureById(id: string): FurnitureSprite | null {
    return this.furniture.get(id) ?? null;
  }

  setGridVisible(visible: boolean): void {
    this.gridG.visible = visible;
  }

  get gridVisible(): boolean {
    return this.gridG.visible;
  }

  /** Editor mode: furniture shows a grab cursor. */
  setEditorMode(on: boolean): void {
    this.editor = on;
    for (const sprite of this.furniture.values()) sprite.cursor = on ? 'grab' : 'pointer';
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
      .fill({ color: HIGHLIGHT_COLOR, alpha: 0.35 })
      .stroke({ width: 2, color: HIGHLIGHT_COLOR });
  }

  setHighlightFurniture(id: string | null): void {
    if (id === this.highlightedFurniture) return;
    if (this.highlightedFurniture)
      this.furniture.get(this.highlightedFurniture)?.setHighlighted(false);
    this.highlightedFurniture = id;
    if (id) this.furniture.get(id)?.setHighlighted(true);
  }

  /**
   * Translucent placement preview: footprint plate plus the piece's painter, tinted green when the
   * placement is valid and red otherwise. Depth-sorted with the furniture.
   */
  setGhost(ghost: Ghost | null): void {
    const g = this.ghostG;
    g.clear();
    if (!ghost) {
      g.visible = false;
      return;
    }
    const tint = ghostTint(ghost.valid);
    const { w, h } = rotatedSize(ghost.kind, ghost.rotation);
    g.poly(isoRectPoints(-0.5, -0.5, w - 0.5, h - 0.5))
      .fill({ color: 0xffffff, alpha: 0.35 })
      .stroke({ width: 2, color: 0xffffff, alpha: 0.9 });
    this.painters.furniture(g, ghost.kind, ghost.rotation);
    g.tint = tint;
    g.alpha = GHOST_ALPHA;
    const { sx, sy } = tileToScreen(ghost.x, ghost.y);
    g.position.set(sx, sy);
    g.zIndex = depthKey(ghost.x + w - 1, ghost.y + h - 1, GHOST_DEPTH_EXTRA);
    g.visible = true;
  }

  destroy(): void {
    for (const f of this.furniture.values()) f.destroy({ children: true });
    this.furniture.clear();
    for (const g of this.graphics()) g.destroy();
  }

  private graphics(): Graphics[] {
    return [
      this.wallG,
      this.floorG,
      this.markerG,
      this.gridG,
      this.hoverG,
      this.highlightG,
      this.ghostG,
    ];
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
