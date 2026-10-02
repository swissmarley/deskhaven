import type { Room } from '@agenthotel/shared';
import {
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
} from 'three';
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
/** Lift of the grid overlay above the floor so it never z-fights. */
export const GRID_Y = 0.002;
export const GRID_COLOR = 0x000000;
export const GRID_ALPHA = 0.25;
/** Brick wall style id (gets the procedural brick texture). */
const BRICK_STYLE = 1;

/**
 * Floor, walls, skirting and the grid overlay for one room. Tile (x, y) is a 1×1 quad centred at
 * world (x, 0, y); the north wall runs along z = −0.5 (the top edge of row 0) and the west wall
 * along x = −0.5 (the left edge of column 0), both standing just outside the floor.
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

  private wallMaterial(side: 'north' | 'west', style: number): MeshStandardMaterial {
    const material = new MeshStandardMaterial({
      color: wallStyleColor(side, style),
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

  private buildWalls(room: Room): void {
    const { width, height, walls } = room;
    const north = new BoxGeometry(1, WALL_HEIGHT, WALL_THICKNESS);
    // The first north segment also fills the corner outside the west wall.
    const corner = new BoxGeometry(1 + WALL_THICKNESS, WALL_HEIGHT, WALL_THICKNESS);
    const west = new BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, 1);
    this.owned.geometries.push(north, corner, west);
    const materials = new Map<string, MeshStandardMaterial>();
    const materialFor = (side: 'north' | 'west', style: number): MeshStandardMaterial => {
      const key = `${side}:${style}`;
      let m = materials.get(key);
      if (!m) {
        m = this.wallMaterial(side, style);
        materials.set(key, m);
      }
      return m;
    };
    const add = (geometry: BufferGeometry, material: Material, x: number, z: number): void => {
      const mesh = new Mesh(geometry, material);
      mesh.position.set(x, WALL_HEIGHT / 2, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    };
    const zNorth = -0.5 - WALL_THICKNESS / 2;
    const xWest = -0.5 - WALL_THICKNESS / 2;
    for (let x = 0; x < width; x++) {
      const style = walls[x] ?? 0;
      if (x === 0) add(corner, materialFor('north', style), -WALL_THICKNESS / 2, zNorth);
      else add(north, materialFor('north', style), x, zNorth);
    }
    for (let y = 0; y < height; y++) {
      const style = walls[width + y] ?? 0;
      add(west, materialFor('west', style), xWest, y);
    }
  }

  private buildSkirting(room: Room): void {
    const material = new MeshStandardMaterial({ color: SKIRTING_COLOR, roughness: 1 });
    const northG = new BoxGeometry(room.width, SKIRTING_HEIGHT, SKIRTING_DEPTH);
    const westG = new BoxGeometry(SKIRTING_DEPTH, SKIRTING_HEIGHT, room.height);
    this.owned.materials.push(material);
    this.owned.geometries.push(northG, westG);
    const north = new Mesh(northG, material);
    north.position.set((room.width - 1) / 2, SKIRTING_HEIGHT / 2, -0.5 + SKIRTING_DEPTH / 2);
    const west = new Mesh(westG, material);
    west.position.set(-0.5 + SKIRTING_DEPTH / 2, SKIRTING_HEIGHT / 2, (room.height - 1) / 2);
    north.receiveShadow = true;
    west.receiveShadow = true;
    this.group.add(north, west);
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
