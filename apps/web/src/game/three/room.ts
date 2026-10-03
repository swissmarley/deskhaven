import type { Room } from '@agenthotel/shared';
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  Euler,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Matrix4,
  MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { shade } from '../color.js';
import { FLOOR_STYLE_COUNT, wallStyleColor } from '../styles.js';
import { brickTexture, floorTexture } from './textures.js';

/** Room geometry tunables (world units; 1 unit = 1 tile). */
export const WALL_HEIGHT = 2.5;
export const WALL_THICKNESS = 0.12;
export const SKIRTING_HEIGHT = 0.12;
export const SKIRTING_DEPTH = 0.05;
export const SKIRTING_COLOR = 0x2b3139;
export const FLOOR_ROUGHNESS = 0.9;
export const WALL_ROUGHNESS = 0.85;
/**
 * The Pixi palette (`WALL_STYLES`) is painted unlit; under the hemisphere + sun it read too dark
 * (G1b note), so wall colours are lightened by this factor. Brick keeps its texture.
 */
export const WALL_LIGHTEN = 1.25;
/** Lift of the grid overlay above the floor so it never z-fights. */
export const GRID_Y = 0.002;
export const GRID_COLOR = 0x000000;
export const GRID_ALPHA = 0.25;
/** Brick wall style id (gets the procedural brick texture). */
const BRICK_STYLE = 1;

/** Lit wall colour for a face and style: the palette entry, lightened. */
export function wallFaceColor(side: 'north' | 'west', style: number): number {
  return shade(wallStyleColor(side, style), WALL_LIGHTEN);
}

const _m = new Matrix4();
const _p = new Vector3();
const _s = new Vector3();
const _c = new Color();
const WEST_TURN = new Quaternion().setFromEuler(new Euler(0, Math.PI / 2, 0));
const NO_TURN = new Quaternion();

/**
 * Floor, walls, skirting and the grid overlay for one room. Tile (x, y) is a 1×1 quad centred at
 * world (x, 0, y); the north wall runs along z = −0.5 (the top edge of row 0) and the west wall
 * along x = −0.5 (the left edge of column 0), both standing just outside the floor.
 *
 * Draw calls: floor tiles are one `InstancedMesh` per floor style, wall segments one per wall
 * style present (north and west segments share a geometry, the west ones turned 90° and the
 * corner piece stretched; faces get their colour per instance), skirting one mesh with two
 * instances, grid one `LineSegments`.
 */
export class RoomMeshes {
  readonly group = new Group();
  private readonly owned: { geometries: BufferGeometry[]; materials: Material[] } = {
    geometries: [],
    materials: [],
  };
  private grid: LineSegments | null = null;
  private gridVisible = true;

  constructor(private readonly parent: Object3D) {
    parent.add(this.group);
  }

  setRoom(room: Room): void {
    this.clear();
    this.buildFloor(room);
    this.buildWalls(room);
    this.buildSkirting(room);
    this.buildGrid(room);
  }

  setGridVisible(visible: boolean): void {
    this.gridVisible = visible;
    if (this.grid) this.grid.visible = visible;
  }

  dispose(): void {
    this.clear();
    this.parent.remove(this.group);
  }

  private clear(): void {
    this.group.clear();
    for (const g of this.owned.geometries) g.dispose();
    for (const m of this.owned.materials) m.dispose();
    this.owned.geometries = [];
    this.owned.materials = [];
    this.grid = null;
  }

  private buildFloor(room: Room): void {
    const counts = new Array<number>(FLOOR_STYLE_COUNT).fill(0);
    const styleAt = (i: number): number => {
      const s = room.floor[i] ?? 0;
      return s >= 0 && s < FLOOR_STYLE_COUNT ? s : 0;
    };
    for (let i = 0; i < room.width * room.height; i++) {
      const style = styleAt(i);
      counts[style] = (counts[style] ?? 0) + 1;
    }
    const quad = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.owned.geometries.push(quad);
    const meshes: (InstancedMesh | null)[] = counts.map((n, style) => {
      if (n === 0) return null;
      const material = new MeshStandardMaterial({
        map: floorTexture(style),
        roughness: FLOOR_ROUGHNESS,
        metalness: 0,
      });
      this.owned.materials.push(material);
      const mesh = new InstancedMesh(quad, material, n);
      mesh.receiveShadow = true;
      mesh.name = `floor-${style}`;
      this.group.add(mesh);
      return mesh;
    });
    const next = new Array<number>(FLOOR_STYLE_COUNT).fill(0);
    const m = new Matrix4();
    for (let y = 0; y < room.height; y++)
      for (let x = 0; x < room.width; x++) {
        const style = styleAt(y * room.width + x);
        const mesh = meshes[style];
        if (!mesh) continue;
        m.makeTranslation(x, 0, y);
        const index = next[style] ?? 0;
        next[style] = index + 1;
        mesh.setMatrixAt(index, m);
      }
    for (const mesh of meshes) {
      if (!mesh) continue;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  private wallMaterial(style: number): MeshStandardMaterial {
    // White base: the per-instance colour carries the face colour (and tints the brick texture).
    const material = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: WALL_ROUGHNESS,
      metalness: 0,
    });
    if (style === BRICK_STYLE) {
      const tex = brickTexture();
      tex.repeat.set(1, WALL_HEIGHT);
      material.map = tex;
    }
    this.owned.materials.push(material);
    return material;
  }

  /** One instanced mesh per wall style: north segments as-is, west ones turned, colour per face. */
  private buildWalls(room: Room): void {
    const { width, height, walls } = room;
    const segment = new BoxGeometry(1, WALL_HEIGHT, WALL_THICKNESS);
    this.owned.geometries.push(segment);
    const styleAt = (i: number): number => walls[i] ?? 0;
    const counts = new Map<number, number>();
    for (let i = 0; i < width + height; i++)
      counts.set(styleAt(i), (counts.get(styleAt(i)) ?? 0) + 1);
    const meshes = new Map<number, { mesh: InstancedMesh; next: number }>();
    for (const [style, n] of counts) {
      const mesh = new InstancedMesh(segment, this.wallMaterial(style), n);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `walls-${style}`;
      this.group.add(mesh);
      meshes.set(style, { mesh, next: 0 });
    }
    const place = (
      style: number,
      side: 'north' | 'west',
      x: number,
      z: number,
      stretch: number,
    ): void => {
      const entry = meshes.get(style);
      if (!entry) return;
      _p.set(x, WALL_HEIGHT / 2, z);
      _s.set(stretch, 1, 1);
      _m.compose(_p, side === 'west' ? WEST_TURN : NO_TURN, _s);
      entry.mesh.setMatrixAt(entry.next, _m);
      entry.mesh.setColorAt(entry.next, _c.setHex(wallFaceColor(side, style)));
      entry.next++;
    };
    const zNorth = -0.5 - WALL_THICKNESS / 2;
    const xWest = -0.5 - WALL_THICKNESS / 2;
    for (let x = 0; x < width; x++) {
      // The first north segment also fills the corner outside the west wall.
      if (x === 0) place(styleAt(x), 'north', -WALL_THICKNESS / 2, zNorth, 1 + WALL_THICKNESS);
      else place(styleAt(x), 'north', x, zNorth, 1);
    }
    for (let y = 0; y < height; y++) place(styleAt(width + y), 'west', xWest, y, 1);
    for (const { mesh } of meshes.values()) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /** North and west skirting boards as two instances of one unit box. */
  private buildSkirting(room: Room): void {
    const material = new MeshStandardMaterial({ color: SKIRTING_COLOR, roughness: 1 });
    const unit = new BoxGeometry(1, SKIRTING_HEIGHT, SKIRTING_DEPTH);
    this.owned.materials.push(material);
    this.owned.geometries.push(unit);
    const mesh = new InstancedMesh(unit, material, 2);
    mesh.name = 'skirting';
    mesh.receiveShadow = true;
    _p.set((room.width - 1) / 2, SKIRTING_HEIGHT / 2, -0.5 + SKIRTING_DEPTH / 2);
    _s.set(room.width, 1, 1);
    mesh.setMatrixAt(0, _m.compose(_p, NO_TURN, _s));
    _p.set(-0.5 + SKIRTING_DEPTH / 2, SKIRTING_HEIGHT / 2, (room.height - 1) / 2);
    _s.set(room.height, 1, 1);
    mesh.setMatrixAt(1, _m.compose(_p, WEST_TURN, _s));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
  }

  private buildGrid(room: Room): void {
    const { width, height } = room;
    const pts: number[] = [];
    for (let x = 0; x <= width; x++) pts.push(x - 0.5, GRID_Y, -0.5, x - 0.5, GRID_Y, height - 0.5);
    for (let y = 0; y <= height; y++) pts.push(-0.5, GRID_Y, y - 0.5, width - 0.5, GRID_Y, y - 0.5);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(pts, 3));
    const material = new LineBasicMaterial({
      color: GRID_COLOR,
      transparent: true,
      opacity: GRID_ALPHA,
      depthWrite: false,
    });
    this.owned.geometries.push(geometry);
    this.owned.materials.push(material);
    const lines = new LineSegments(geometry, material);
    lines.visible = this.gridVisible;
    lines.name = 'grid';
    this.group.add(lines);
    this.grid = lines;
  }
}
