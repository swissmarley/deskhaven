import {
  type Furniture,
  type FurnitureKind,
  interactionTiles,
  type Room,
  rotatedSize,
} from '@agenthotel/shared';
import {
  Box3,
  Group,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  type Raycaster,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GHOST_ALPHA, ghostTint } from '../editor.js';
import { tileKey } from '../grid.js';
import type { Ghost, TilePoint } from '../types.js';
import {
  countNearDoor,
  DOOR_CLOSED,
  DOOR_HINGE_NAME,
  type DoorState,
  doorAngle,
  doorHinge,
  doorState,
  doorTiles,
  isDoorLeafName,
  type Point,
} from './door-math.js';
import { screenFlicker } from './emote-math.js';
import {
  BOOKCASE_SHELVES,
  BOOKCASE_SLOTS,
  BOOKS_PER_CASE,
  MODEL_MANIFEST,
  type ModelName,
  type ModelPart,
  modelUrl,
  type PiecePart,
  partScale,
  partsFor,
  placement,
  type Size3,
  variantIndex,
} from './models.js';
import {
  type Built,
  buildCounter,
  buildFallbackBox,
  buildServerRack,
  buildTable,
  buildWhiteboard,
  Resources,
} from './procedural.js';

/**
 * Furniture for the Three renderer: a glTF cache (one load per url, clones per piece), the
 * composition of pieces from `MODEL_MANIFEST`, and the editor affordances (ghost, highlight pulse,
 * drag preview). `setRoom` is synchronous: a piece's group exists at once and its models drop in
 * as their promises resolve, unless the piece was removed meanwhile (per-piece generation).
 *
 * This module imports `three/addons`, so no test may import it; the pure maths live in
 * `models.ts` and the box builders in `procedural.ts`.
 */

export const HIGHLIGHT_COLOR = 0xffd166;
export const HIGHLIGHT_MIN = 0.15;
export const HIGHLIGHT_MAX = 0.45;
export const HIGHLIGHT_HZ = 1.2;
export const DRAG_OPACITY = 0.5;
/** Monitor glow while someone types at the desk: emissive on the screen panel, Pixi's `0x9fd8ff`. */
export const SCREEN_GLOW_COLOR = 0x9fd8ff;
export const SCREEN_GLOW_BASE_COLOR = 0xdff4ff;
export const SCREEN_GLOW_INTENSITY = 1.6;
/** Model whose `metal` material is the screen panel (see `models.ts` SCREEN). */
const SCREEN_MODEL = 'computerScreen';
const SCREEN_PANEL_MATERIAL = 'metal';
/** Model whose leaf swings (`door-math.ts`). */
const DOOR_MODEL = 'doorway';

// ---- model cache ----------------------------------------------------------------------------------

export interface LoadedModel {
  /** Normalised model: XZ centre at the origin, base at y = 0. Never added to a scene; clone it. */
  group: Group;
  size: Size3;
}

const cache = new Map<string, Promise<LoadedModel | null>>();
const resolved: LoadedModel[] = [];
let loader: GLTFLoader | null = null;

/** Load (once) and normalise a furniture model; resolves null after one `console.warn` on failure. */
export function loadModel(name: ModelName): Promise<LoadedModel | null> {
  const url = modelUrl(name);
  let pending = cache.get(url);
  if (!pending) {
    pending = new Promise<LoadedModel | null>((resolve) => {
      loader ??= new GLTFLoader();
      loader.load(
        url,
        (gltf) => {
          try {
            const model = normalise(gltf.scene);
            resolved.push(model);
            resolve(model);
          } catch (err) {
            console.warn(`[three] model ${url} could not be prepared`, err);
            resolve(null);
          }
        },
        undefined,
        (err) => {
          console.warn(`[three] model ${url} failed to load`, err);
          resolve(null);
        },
      );
    });
    cache.set(url, pending);
  }
  return pending;
}

/**
 * Drop every cached model and dispose its geometries and materials. Models stay cached across
 * scene mounts on purpose (a StrictMode re-mount would otherwise reload them); call this from tests
 * or when the renderer is switched off for good.
 */
export function clearModelCache(): void {
  for (const model of resolved) {
    model.group.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      o.geometry.dispose();
      forEachMaterial(o.material, (m) => m.dispose());
    });
  }
  resolved.length = 0;
  cache.clear();
}

function normalise(scene: Group): LoadedModel {
  const box = new Box3().setFromObject(scene);
  const size = box.getSize(new Vector3());
  const centre = box.getCenter(new Vector3());
  scene.position.set(-centre.x, -box.min.y, -centre.z);
  scene.traverse((o) => {
    if (o instanceof Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  const group = new Group();
  group.add(scene);
  return { group, size: { x: size.x, y: size.y, z: size.z } };
}

function forEachMaterial(m: Material | Material[], fn: (m: Material) => void): void {
  if (Array.isArray(m)) for (const x of m) fn(x);
  else fn(m);
}

function mapMaterial(
  m: Material | Material[],
  fn: (m: Material) => Material,
): Material | Material[] {
  return Array.isArray(m) ? m.map(fn) : fn(m);
}

// ---- piece composition ----------------------------------------------------------------------------

interface PartResult {
  object: Object3D;
  top: number;
}

async function buildModelPart(
  part: ModelPart,
  kind: FurnitureKind,
  w: number,
  h: number,
  top: number,
  isBase: boolean,
  res: Resources,
): Promise<PartResult | null> {
  const model = await loadModel(part.model);
  if (!model) {
    if (!isBase) return null;
    const built = buildFallbackBox(kind, res);
    return { object: built.group, top: built.top };
  }
  const clone = model.group.clone();
  if (part.model === SCREEN_MODEL) clone.userData = { ...clone.userData, screen: true };
  if (part.model === DOOR_MODEL) hingeDoorLeaf(clone);
  const s = partScale(part, model.size, w, h);
  clone.scale.set(s.x, s.y, s.z);
  clone.rotation.y = part.yawOffset ?? 0;
  const baseY = part.y === 'top' ? top : (part.y ?? 0);
  const y = baseY + (part.lift ?? 0);
  clone.position.set(part.x ?? 0, y, part.z ?? 0);
  if (part.castShadow === false)
    clone.traverse((o) => {
      if (o instanceof Mesh) o.castShadow = false;
    });
  return { object: clone, top: y + model.size.y * s.y };
}

function buildProceduralPart(shape: string, res: Resources): Built {
  switch (shape) {
    case 'server_rack':
      return buildServerRack(res);
    case 'whiteboard':
      return buildWhiteboard(res);
    case 'counter':
      return buildCounter(res);
    default:
      return buildTable(res);
  }
}

async function buildPart(
  part: PiecePart,
  kind: FurnitureKind,
  w: number,
  h: number,
  top: number,
  isBase: boolean,
  res: Resources,
): Promise<PartResult | null> {
  if (part.kind === 'gltf') return buildModelPart(part, kind, w, h, top, isBase, res);
  const built = buildProceduralPart(part.shape, res);
  const y = part.y === 'top' ? top : (part.y ?? 0);
  built.group.position.set(part.x ?? 0, y, part.z ?? 0);
  return { object: built.group, top: y + built.top };
}

/** Books on the shelves of each bookcase part (same Kenney scale, so proportions match). */
async function buildBooks(id: string, cases: ModelPart[]): Promise<Object3D[]> {
  const books = await loadModel('books');
  if (!books) return [];
  const out: Object3D[] = [];
  const slots = BOOKCASE_SHELVES.length * BOOKCASE_SLOTS.length;
  cases.forEach((bookcase, caseIndex) => {
    const s = bookcase.scale ?? 1;
    const first = variantIndex(`${id}:${caseIndex}`, slots);
    for (let n = 0; n < BOOKS_PER_CASE; n++) {
      const slot = (first + n * 2 + caseIndex) % slots;
      const shelf = BOOKCASE_SHELVES[Math.floor(slot / BOOKCASE_SLOTS.length)] ?? 0;
      const slotX = BOOKCASE_SLOTS[slot % BOOKCASE_SLOTS.length] ?? 0;
      const clone = books.group.clone();
      clone.scale.setScalar(s);
      clone.rotation.y = (slot + caseIndex) % 2 === 0 ? 0 : Math.PI;
      clone.position.set((bookcase.x ?? 0) + slotX * s, shelf * s, bookcase.z ?? 0);
      out.push(clone);
    }
  });
  return out;
}

/**
 * Compose a piece's parts into `target`, in order (part 0 sets `'top'` for the rest). Every part
 * is reported through `onPart` as soon as it is added; `isLive()` false aborts the rest.
 */
async function buildPiece(
  kind: FurnitureKind,
  id: string,
  w: number,
  h: number,
  res: Resources,
  target: Group,
  isLive: () => boolean,
  onPart: (object: Object3D) => void,
): Promise<void> {
  const parts = partsFor(kind, id);
  // Start every fetch now so a composed piece does not load its models one after the other.
  for (const p of parts) if (p.kind === 'gltf') void loadModel(p.model);
  let top = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const built = await buildPart(part, kind, w, h, top, i === 0, res);
    if (!isLive()) return;
    if (!built) continue;
    target.add(built.object);
    onPart(built.object);
    if (i === 0) top = built.top;
  }
  if (MODEL_MANIFEST[kind].books) {
    const cases = parts.filter((p): p is ModelPart => p.kind === 'gltf');
    const books = await buildBooks(id, cases);
    if (!isLive()) return;
    for (const b of books) {
      target.add(b);
      onPart(b);
    }
  }
}

/**
 * Re-parent the doorway's leaf under a hinge group at its +X edge (`door-math.ts`), so the layer
 * can swing it. Runs on the untransformed clone (identity root), so the leaf bounds are in the
 * model frame. Quietly does nothing when the leaf cannot be found (the door then stays shut).
 */
function hingeDoorLeaf(root: Object3D): void {
  const leaves: Object3D[] = [];
  root.traverse((o) => {
    if (o !== root && isDoorLeafName(o.name)) leaves.push(o);
  });
  // Traversal is parent-first, so the first match is the leaf node, not one of its primitives.
  const found = leaves[0];
  const parent = found?.parent;
  if (!found || !parent) return;
  root.updateMatrixWorld(true);
  const box = new Box3().setFromObject(found);
  if (box.isEmpty()) return;
  const h = doorHinge({
    minX: box.min.x,
    minY: box.min.y,
    minZ: box.min.z,
    maxX: box.max.x,
    maxY: box.max.y,
    maxZ: box.max.z,
  });
  const hinge = new Group();
  hinge.name = DOOR_HINGE_NAME;
  hinge.position.copy(parent.worldToLocal(new Vector3(h.x, h.y, h.z)));
  parent.add(hinge);
  hinge.updateMatrixWorld(true);
  hinge.attach(found);
}

// ---- layer ----------------------------------------------------------------------------------------

interface PieceNode {
  piece: Furniture;
  group: Group;
  res: Resources;
  gen: number;
  /** Original materials of meshes whose materials were cloned for an effect. */
  overrides: Map<Mesh, Material | Material[]> | null;
  /** Cloned screen-panel materials while any effect is on (driven by the glow flicker). */
  panels: MeshStandardMaterial[];
  highlighted: boolean;
  dimmed: boolean;
  glowing: boolean;
  /** Door pieces: the swinging leaf's hinge (once its model loaded), the tiles that open it, and the state. */
  door: { hinge: Group | null; tiles: Point[]; state: DoorState } | null;
}

interface GhostNode {
  kind: FurnitureKind;
  rotation: number;
  group: Group;
  res: Resources;
  /** Unlit so `GHOST_VALID` / `GHOST_INVALID` show as drawn (lit, the green read as dark olive). */
  material: MeshBasicMaterial;
  gen: number;
}

/** Whether a mesh is a computer screen panel (inside a screen model, with the panel material). */
function isScreenPanel(mesh: Mesh): boolean {
  const m = mesh.material;
  const name = Array.isArray(m) ? m[0]?.name : m.name;
  if (name !== SCREEN_PANEL_MATERIAL) return false;
  let node: Object3D | null = mesh;
  while (node) {
    if (node.userData.screen === true) return true;
    node = node.parent;
  }
  return false;
}

/** Furniture pieces of one room plus the editor ghost, under one parent. */
export class FurnitureLayer {
  readonly group = new Group();
  private readonly nodes = new Map<string, PieceNode>();
  private ghost: GhostNode | null = null;
  private gen = 0;
  private highlightedId: string | null = null;
  private clock = 0;
  /** Interaction tile → id of a piece with a screen (desks, library PCs), for the monitor glow. */
  private screenSeats = new Map<string, string>();
  private readonly glowIds = new Set<string>();
  private lastGlowTiles: Iterable<string> = [];
  private avatarPositions: readonly Point[] = [];

  constructor(private readonly parent: Object3D) {
    this.group.name = 'furniture';
    parent.add(this.group);
  }

  setRoom(room: Room): void {
    const seen = new Set<string>();
    for (const piece of room.furniture) {
      seen.add(piece.id);
      const existing = this.nodes.get(piece.id);
      if (
        existing &&
        existing.piece.kind === piece.kind &&
        existing.piece.rotation === piece.rotation
      ) {
        existing.piece = piece;
        if (!existing.dimmed) this.moveTo(existing, piece.x, piece.y);
        // A moved door opens for its new tiles (the node survives the move).
        if (existing.door) existing.door.tiles = doorTiles(piece);
        continue;
      }
      if (existing) this.removeNode(existing);
      this.nodes.set(piece.id, this.createNode(piece));
    }
    for (const [id, node] of this.nodes) {
      if (seen.has(id)) continue;
      this.removeNode(node);
      this.nodes.delete(id);
    }
    this.screenSeats = new Map();
    for (const piece of room.furniture) {
      if (!hasScreen(piece.kind)) continue;
      for (const t of interactionTiles(piece.kind, piece.x, piece.y, piece.rotation))
        this.screenSeats.set(tileKey(t.x, t.y), piece.id);
    }
    this.setGlowTiles(this.lastGlowTiles);
  }

  /**
   * Monitor glow: the screens of the pieces whose interaction tile is in `tiles` (tile keys of the
   * avatars currently typing) flicker; every other screen is dark. Idempotent per frame.
   */
  setGlowTiles(tiles: Iterable<string>): void {
    this.lastGlowTiles = tiles;
    const want = new Set<string>();
    for (const key of tiles) {
      const id = this.screenSeats.get(key);
      if (id) want.add(id);
    }
    for (const id of this.glowIds) {
      if (want.has(id)) continue;
      this.glowIds.delete(id);
      const node = this.nodes.get(id);
      if (node) {
        node.glowing = false;
        this.applyEffects(node);
      }
    }
    for (const id of want) {
      if (this.glowIds.has(id)) continue;
      const node = this.nodes.get(id);
      if (!node) continue;
      this.glowIds.add(id);
      node.glowing = true;
      this.applyEffects(node);
    }
  }

  /** Where the avatars are this frame (fractional tiles): doors open for anyone within reach. */
  setAvatarPositions(positions: readonly Point[]): void {
    this.avatarPositions = positions;
  }

  /** Pickable roots, for the scene's raycaster (the ghost is not among them). */
  get pickables(): Object3D[] {
    const out: Object3D[] = [];
    for (const n of this.nodes.values()) out.push(n.group);
    return out;
  }

  /** The furniture id under a ray, or null. */
  pick(raycaster: Raycaster): string | null {
    const hits = raycaster.intersectObjects(this.pickables, true);
    for (const hit of hits) {
      const id = furnitureIdOf(hit.object);
      if (id) return id;
    }
    return null;
  }

  setHighlight(id: string | null): void {
    if (id === this.highlightedId) return;
    const prev = this.highlightedId ? this.nodes.get(this.highlightedId) : undefined;
    if (prev) {
      prev.highlighted = false;
      this.applyEffects(prev);
    }
    this.highlightedId = id;
    const next = id ? this.nodes.get(id) : undefined;
    if (next) {
      next.highlighted = true;
      this.applyEffects(next);
    }
  }

  /** Drag preview: dim and move to `origin`; null restores the real origin. */
  setPreview(id: string, origin: TilePoint | null): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.dimmed = origin !== null;
    this.applyEffects(node);
    if (origin) this.moveTo(node, origin.x, origin.y);
    else this.moveTo(node, node.piece.x, node.piece.y);
  }

  setGhost(ghost: Ghost | null): void {
    if (!ghost) {
      if (this.ghost) this.removeGhost();
      return;
    }
    let g = this.ghost;
    if (g && (g.kind !== ghost.kind || g.rotation !== ghost.rotation)) {
      this.removeGhost();
      g = null;
    }
    if (!g) g = this.createGhost(ghost);
    g.material.color.setHex(ghostTint(ghost.valid));
    const p = placement(ghost.kind, ghost.x, ghost.y, ghost.rotation);
    g.group.position.set(p.x, 0, p.z);
  }

  update(dtMs: number): void {
    this.clock += dtMs / 1000;
    const node = this.highlightedId ? this.nodes.get(this.highlightedId) : undefined;
    if (node?.overrides) {
      const t = (Math.sin(this.clock * HIGHLIGHT_HZ * 2 * Math.PI) + 1) / 2;
      const intensity = HIGHLIGHT_MIN + (HIGHLIGHT_MAX - HIGHLIGHT_MIN) * t;
      for (const mesh of node.overrides.keys())
        forEachMaterial(mesh.material, (m) => {
          if (m instanceof MeshStandardMaterial) m.emissiveIntensity = intensity;
        });
    }
    if (this.glowIds.size > 0) {
      const flicker = SCREEN_GLOW_INTENSITY * screenFlicker(this.clock);
      for (const id of this.glowIds) {
        const glow = this.nodes.get(id);
        if (!glow) continue;
        for (const m of glow.panels) m.emissiveIntensity = flicker;
      }
    }
    const dt = dtMs / 1000;
    for (const n of this.nodes.values()) {
      const door = n.door;
      if (!door) continue;
      door.state = doorState(door.state, countNearDoor(this.avatarPositions, door.tiles), dt);
      if (door.hinge) door.hinge.rotation.y = doorAngle(door.state.openness);
    }
  }

  dispose(): void {
    for (const node of this.nodes.values()) this.removeNode(node);
    this.nodes.clear();
    this.removeGhost();
    this.parent.remove(this.group);
  }

  // ---- pieces ---------------------------------------------------------------------------------------

  private createNode(piece: Furniture): PieceNode {
    const group = new Group();
    group.name = piece.id;
    group.userData = { furnitureId: piece.id, kind: piece.kind };
    const node: PieceNode = {
      piece,
      group,
      res: new Resources(),
      gen: ++this.gen,
      overrides: null,
      panels: [],
      highlighted: piece.id === this.highlightedId,
      dimmed: false,
      glowing: this.glowIds.has(piece.id),
      door:
        piece.kind === 'door' ? { hinge: null, tiles: doorTiles(piece), state: DOOR_CLOSED } : null,
    };
    group.rotation.y = placement(piece.kind, piece.x, piece.y, piece.rotation).yaw;
    this.moveTo(node, piece.x, piece.y);
    this.group.add(group);
    const gen = node.gen;
    void buildPiece(
      piece.kind,
      piece.id,
      // Parts are composed in the rotation-0 frame; the group's yaw turns the whole piece.
      rotatedSize(piece.kind, 0).w,
      rotatedSize(piece.kind, 0).h,
      node.res,
      group,
      () => node.gen === gen && this.nodes.get(piece.id) === node,
      (object) => {
        this.applyEffects(node);
        if (node.door && !node.door.hinge) {
          const hinge = object.getObjectByName(DOOR_HINGE_NAME);
          if (hinge instanceof Group) node.door.hinge = hinge;
        }
      },
    );
    return node;
  }

  private removeNode(node: PieceNode): void {
    node.gen = -1;
    this.restoreMaterials(node);
    this.group.remove(node.group);
    node.res.dispose();
  }

  private moveTo(node: PieceNode, x: number, y: number): void {
    const p = placement(node.piece.kind, x, y, node.piece.rotation);
    node.group.position.set(p.x, 0, p.z);
  }

  /**
   * Highlight (emissive pulse), dim (drag preview) and the monitor glow share one mechanism: the
   * piece's meshes get cloned materials while any effect is on (the cached model materials are
   * shared between clones and must never be tinted) and the originals back when all are off. Also
   * called as parts drop in, so a late-loading screen joins an active glow.
   */
  private applyEffects(node: PieceNode): void {
    if (!node.highlighted && !node.dimmed && !node.glowing) {
      this.restoreMaterials(node);
      return;
    }
    node.overrides ??= new Map();
    const overrides = node.overrides;
    node.group.traverse((o) => {
      if (!(o instanceof Mesh) || overrides.has(o)) return;
      overrides.set(o, o.material);
      o.material = mapMaterial(o.material, (m) => m.clone());
    });
    node.panels = [];
    for (const mesh of overrides.keys()) {
      const panel = node.glowing && isScreenPanel(mesh);
      forEachMaterial(mesh.material, (m) => {
        m.transparent = node.dimmed;
        m.opacity = node.dimmed ? DRAG_OPACITY : 1;
        if (m instanceof MeshStandardMaterial) {
          if (panel) {
            m.color.setHex(SCREEN_GLOW_BASE_COLOR);
            m.emissive.setHex(SCREEN_GLOW_COLOR);
            m.emissiveIntensity = SCREEN_GLOW_INTENSITY * 0.5;
            node.panels.push(m);
          } else {
            m.emissive.setHex(node.highlighted ? HIGHLIGHT_COLOR : 0x000000);
            m.emissiveIntensity = node.highlighted ? HIGHLIGHT_MIN : 0;
          }
        }
        m.needsUpdate = true;
      });
    }
  }

  private restoreMaterials(node: PieceNode): void {
    node.panels = [];
    const overrides = node.overrides;
    if (!overrides) return;
    for (const [mesh, original] of overrides) {
      forEachMaterial(mesh.material, (m) => m.dispose());
      mesh.material = original;
    }
    node.overrides = null;
  }

  // ---- ghost ----------------------------------------------------------------------------------------

  private createGhost(ghost: Ghost): GhostNode {
    const group = new Group();
    group.name = 'ghost';
    group.userData = { pickable: false };
    group.rotation.y = placement(ghost.kind, ghost.x, ghost.y, ghost.rotation).yaw;
    const res = new Resources();
    const material = res.material(
      new MeshBasicMaterial({
        color: ghostTint(ghost.valid),
        transparent: true,
        opacity: GHOST_ALPHA,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    const node: GhostNode = {
      kind: ghost.kind,
      rotation: ghost.rotation,
      group,
      res,
      material,
      gen: ++this.gen,
    };
    this.ghost = node;
    this.group.add(group);
    const gen = node.gen;
    const { w, h } = rotatedSize(ghost.kind, 0);
    void buildPiece(
      ghost.kind,
      'ghost',
      w,
      h,
      res,
      group,
      () => this.ghost === node && node.gen === gen,
      (object) =>
        object.traverse((o) => {
          if (!(o instanceof Mesh)) return;
          o.material = material;
          o.castShadow = false;
          o.receiveShadow = false;
        }),
    );
    return node;
  }

  private removeGhost(): void {
    const g = this.ghost;
    if (!g) return;
    this.ghost = null;
    g.gen = -1;
    this.group.remove(g.group);
    g.res.dispose();
  }
}

/** Kinds whose manifest includes a computer screen (their seats light the monitor when typed at). */
function hasScreen(kind: FurnitureKind): boolean {
  const spec = MODEL_MANIFEST[kind];
  const parts = [...spec.parts, ...(spec.variants ?? []).flat()];
  return parts.some((p) => p.kind === 'gltf' && p.model === SCREEN_MODEL);
}

/** Walk up from a hit mesh to the piece group carrying the furniture id. */
export function furnitureIdOf(object: Object3D): string | null {
  let node: Object3D | null = object;
  while (node) {
    const id: unknown = node.userData.furnitureId;
    if (typeof id === 'string') return id;
    node = node.parent;
  }
  return null;
}
