import { FURNITURE_CATALOG, type FurnitureKind, rotatedSize } from '@deskhaven/shared';
import { PX_PER_HEIGHT_UNIT } from './camera.js';

/**
 * Furniture model manifest and placement maths for the Three renderer. Pure (numbers and plain
 * objects only, no loader, no DOM) so the conventions are testable under Node.
 *
 * ## Conventions
 *
 * **Piece-local frame.** Every piece is built in its rotation-0 frame: the footprint's `w` runs
 * along +X and `h` along +Z, the footprint is centred on the origin on the floor (y = 0), and
 * **local +Z is the piece's front** — the side the catalog's interaction tiles are on. A desk at
 * rotation 0 has its seat at `dy = +1`, i.e. the sitter stands south of the desk (world +Z) facing
 * north (world −Z): the screen must therefore face local +Z.
 *
 * **Piece yaw.** `rotation r` rotates the footprint with `rotateOffset` (90° steps, clockwise when
 * seen from above with +X right and +Z down, which on the isometric screen is clockwise too). The
 * seat of a 2×1 desk moves from the south (r = 0) to the west (r = 1), north (r = 2) and east
 * (r = 3) side, so the front vector goes (0, +1) → (−1, 0) → (0, −1) → (+1, 0) in (x, z). A yaw of
 * θ about +Y maps local +Z to (sin θ, cos θ); θ = −90° gives (−1, 0), so **yaw = r × −90°**.
 * `placement()` returns the centre of the rotated footprint and that yaw.
 *
 * **Model yaw offsets.** Each Kenney model has its own idea of "front" (the desk's drawers face
 * model −Z, the chair's backrest sits at model +Z, …). `ModelPart.yawOffset` turns the model so its
 * front lands on local +Z; it is data in `MODEL_MANIFEST`, never code. The offsets were read from
 * the GLB geometry (`scripts/inspect-gltf.mjs` plus a face-area dump) and are recorded per part.
 *
 * **Fit rule.** Models are normalised on load (XZ bounding-box centre at the origin, base at
 * y = 0). `fit: 'footprint'` scales uniformly so the model's XZ box (after the yaw offset) fits
 * inside `(w − FIT_MARGIN, h − FIT_MARGIN)` tiles, taking the smaller ratio; height follows.
 * `fit: 'fill'` (rugs) scales X and Z independently to fill the same box. `fit: 'none'` uses the
 * fixed `scale` (Kenney furniture is modelled at 1 unit ≈ 0.2 m, so `KENNEY_METRIC = 0.2` makes a
 * chair, door or plant metre-sized next to a 1-unit tile; footprint fitting would blow small models
 * up to the tile).
 */

export const FIT_MARGIN = 0.1;
/** Uniform scale that makes a Kenney Furniture Kit model roughly metric (1 tile = 1 m). */
export const KENNEY_METRIC = 0.2;
/** Rugs float this far above the floor so they never z-fight with it. */
export const RUG_LIFT = 0.01;

export type ModelName =
  | 'desk'
  | 'chairDesk'
  | 'computerScreen'
  | 'computerKeyboard'
  | 'computerMouse'
  | 'laptop'
  | 'kitchenCoffeeMachine'
  | 'doorway'
  | 'pottedPlant'
  | 'plantSmall1'
  | 'plantSmall2'
  | 'loungeSofa'
  | 'bookcaseOpen'
  | 'bookcaseClosedWide'
  | 'rugRectangle'
  | 'books';

export function modelUrl(name: ModelName): string {
  return `/models/furniture/${name}.glb`;
}

export type FitMode = 'footprint' | 'fill' | 'none';

/** A glTF model composed into a piece, positioned in the piece-local frame (tile units). */
export interface ModelPart {
  kind: 'gltf';
  model: ModelName;
  /** How the model is scaled; `none` uses `scale` (default `KENNEY_METRIC`). */
  fit?: FitMode;
  scale?: number;
  /** Yaw (radians, about +Y) that turns the model's own front onto local +Z. */
  yawOffset?: number;
  /** Local position of the model's base centre: x and z in tiles. */
  x?: number;
  z?: number;
  /** Base height: a number in tiles, or `'top'` to stand on the first part's top surface. */
  y?: number | 'top';
  castShadow?: boolean;
  /** Extra lift above `y` (rugs). */
  lift?: number;
}

/** A procedural part built in code (`procedural.ts`), positioned like a model part. */
export interface ProceduralPart {
  kind: 'procedural';
  shape: 'server_rack' | 'whiteboard' | 'counter' | 'table';
  x?: number;
  z?: number;
  y?: number | 'top';
}

export type PiecePart = ModelPart | ProceduralPart;

export interface KindModel {
  /** Parts in build order; part 0 defines `'top'` for the others. */
  parts: PiecePart[];
  /** Alternative part lists chosen by `variantIndex(id)` (e.g. plant varieties); `parts` is variant 0. */
  variants?: PiecePart[][];
  /** Extra parts added per bookshelf: books on shelves (model units of the bookcase). */
  books?: boolean;
}

const SCREEN: ModelPart = {
  kind: 'gltf',
  model: 'computerScreen',
  fit: 'none',
  scale: KENNEY_METRIC,
  // The screen panel faces model −Z (its back shell is at +Z): turn it to face the sitter.
  yawOffset: Math.PI,
  y: 'top',
  z: -0.27,
};
const KEYBOARD: ModelPart = {
  kind: 'gltf',
  model: 'computerKeyboard',
  fit: 'none',
  scale: KENNEY_METRIC,
  // The raised edge (the back of the keyboard) is at model +Z.
  yawOffset: Math.PI,
  y: 'top',
  x: -0.1,
  z: 0.14,
};
const MOUSE: ModelPart = {
  kind: 'gltf',
  model: 'computerMouse',
  fit: 'none',
  scale: KENNEY_METRIC,
  yawOffset: Math.PI,
  y: 'top',
  x: 0.38,
  z: 0.14,
};

export const MODEL_MANIFEST: Record<FurnitureKind, KindModel> = {
  desk: {
    parts: [
      // Drawers (and their handle) are at model −Z, the modesty panel at +Z: the sitter is at −Z.
      { kind: 'gltf', model: 'desk', fit: 'footprint', yawOffset: Math.PI },
      SCREEN,
      KEYBOARD,
      MOUSE,
    ],
  },
  chair: {
    // Backrest at model +Z; at rotation 0 the sitter faces north (−Z), so the backrest stays south.
    parts: [{ kind: 'gltf', model: 'chairDesk', fit: 'none', scale: KENNEY_METRIC, yawOffset: 0 }],
  },
  bookshelf: {
    // The wide closed-back bookcase is 8 Kenney units wide: at 0.235 it spans 1.88 of the 2×1
    // footprint in one model (G1b used two open bookcases; this halves the draw calls).
    parts: [{ kind: 'gltf', model: 'bookcaseClosedWide', fit: 'none', scale: 0.235 }],
    books: true,
  },
  server_rack: { parts: [{ kind: 'procedural', shape: 'server_rack' }] },
  coffee_machine: {
    parts: [
      { kind: 'procedural', shape: 'counter' },
      // Mug and spout are at model −Z, the water tank's flat face at +Z.
      {
        kind: 'gltf',
        model: 'kitchenCoffeeMachine',
        fit: 'none',
        scale: 0.25,
        yawOffset: Math.PI,
        y: 'top',
      },
    ],
  },
  sofa: {
    // Backrest at model +Z; the seats face south (+Z) at rotation 0, so the backrest goes north.
    parts: [{ kind: 'gltf', model: 'loungeSofa', fit: 'footprint', yawOffset: Math.PI }],
  },
  plant: {
    parts: [{ kind: 'gltf', model: 'pottedPlant', fit: 'none', scale: 0.25 }],
    variants: [
      [{ kind: 'gltf', model: 'pottedPlant', fit: 'none', scale: 0.25 }],
      [{ kind: 'gltf', model: 'plantSmall1', fit: 'none', scale: 0.7 }],
      [{ kind: 'gltf', model: 'plantSmall2', fit: 'none', scale: 0.7 }],
    ],
  },
  whiteboard: { parts: [{ kind: 'procedural', shape: 'whiteboard' }] },
  library_pc: {
    parts: [
      { kind: 'procedural', shape: 'table' },
      { ...SCREEN, scale: 0.17, z: -0.2 },
      { ...KEYBOARD, scale: 0.17, x: 0, z: 0.16 },
    ],
  },
  door: {
    // The frame runs along model X; yawOffset +90° turns it along local Z so that at rotation 0 it
    // stands against the west wall (rotation 1 → north wall). `x` pushes it to the tile's −X edge:
    // frame thickness 0.89 × 0.2 = 0.178 → centre at −0.5 + 0.089 + 0.01.
    parts: [
      {
        kind: 'gltf',
        model: 'doorway',
        fit: 'none',
        scale: KENNEY_METRIC,
        yawOffset: Math.PI / 2,
        x: -0.4,
      },
    ],
  },
  rug: {
    parts: [
      { kind: 'gltf', model: 'rugRectangle', fit: 'fill', castShadow: false, lift: RUG_LIFT },
    ],
  },
};

/**
 * `bookcaseClosedWide` shelf tops in Kenney units (up-facing faces of the GLB at these heights,
 * spanning the full 8-unit width; the top board is at 7.9).
 */
export const BOOKCASE_SHELVES = [0.7, 3.1, 5.5] as const;
/** Book-set centres on a shelf, in Kenney units from the bookcase centre (a set is 1.5 wide). */
export const BOOKCASE_SLOTS = [-2.9, -1.0, 1.0, 2.9] as const;
/** Book sets placed per bookcase (4 sets × 4 materials keeps the bookshelf under 20 draw calls). */
export const BOOKS_PER_CASE = 4;

/** Stable variant choice for a piece id (same hash as `rng.ts`' FNV-style mixing, inlined). */
export function variantIndex(id: string, count: number): number {
  if (count <= 1) return 0;
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % count;
}

/** The parts to build for a piece: its variant when the kind has several. */
export function partsFor(kind: FurnitureKind, id: string): PiecePart[] {
  const spec = MODEL_MANIFEST[kind];
  const variants = spec.variants;
  if (!variants || variants.length === 0) return spec.parts;
  return variants[variantIndex(id, variants.length)] ?? spec.parts;
}

export interface Placement {
  /** World centre of the rotated footprint on the floor. */
  x: number;
  z: number;
  /** Yaw about +Y in radians. */
  yaw: number;
  /** Rotated footprint size in tiles. */
  w: number;
  h: number;
}

/** Yaw for a catalog rotation: `r × −90°` (see the module comment for the derivation). */
export function rotationYaw(rotation: number): number {
  const quarter = ((rotation % 4) + 4) % 4;
  return quarter === 0 ? 0 : quarter * (-Math.PI / 2);
}

/** Where a piece's group goes: the centre of its rotated footprint, and its yaw. */
export function placement(kind: FurnitureKind, x: number, y: number, rotation: number): Placement {
  const { w, h } = rotatedSize(kind, rotation);
  return { x: x + (w - 1) / 2, z: y + (h - 1) / 2, yaw: rotationYaw(rotation), w, h };
}

/** Unit front vector (x, z) of a piece with this yaw: local +Z rotated about +Y. */
export function frontVector(yaw: number): { x: number; z: number } {
  return { x: Math.sin(yaw), z: Math.cos(yaw) };
}

export interface Size3 {
  x: number;
  y: number;
  z: number;
}

/** Whether a yaw offset is an odd multiple of 90° (the model's X and Z extents swap). */
function swapsAxes(yawOffset: number): boolean {
  const quarter = Math.round(yawOffset / (Math.PI / 2));
  return Math.abs(quarter % 2) === 1;
}

/** The model's XZ extents as seen in the piece frame, i.e. after its yaw offset. */
export function orientedSize(size: Size3, yawOffset = 0): Size3 {
  return swapsAxes(yawOffset) ? { x: size.z, y: size.y, z: size.x } : size;
}

/**
 * Uniform scale that fits a model of `size` (already oriented) inside a `w × h` tile footprint
 * with `FIT_MARGIN` to spare on each axis: the smaller of the two ratios, so neither axis spills.
 */
export function fitToFootprint(size: Size3, w: number, h: number, margin = FIT_MARGIN): number {
  const sx = Math.max(w - margin, 0.01) / Math.max(size.x, 1e-6);
  const sz = Math.max(h - margin, 0.01) / Math.max(size.z, 1e-6);
  return Math.min(sx, sz);
}

/** Non-uniform scale that fills the footprint (rugs); Y keeps the smaller ratio so it stays thin. */
export function fillFootprint(size: Size3, w: number, h: number, margin = FIT_MARGIN): Size3 {
  const sx = Math.max(w - margin, 0.01) / Math.max(size.x, 1e-6);
  const sz = Math.max(h - margin, 0.01) / Math.max(size.z, 1e-6);
  return { x: sx, y: Math.min(sx, sz), z: sz };
}

/** Scale vector for a model part given the model's normalised size and the piece footprint. */
export function partScale(part: ModelPart, size: Size3, w: number, h: number): Size3 {
  const oriented = orientedSize(size, part.yawOffset ?? 0);
  switch (part.fit ?? 'none') {
    case 'footprint': {
      const s = fitToFootprint(oriented, w, h);
      return { x: s, y: s, z: s };
    }
    case 'fill': {
      const s = fillFootprint(oriented, w, h);
      // The fill is expressed in the oriented frame; map it back onto the model's own axes.
      return swapsAxes(part.yawOffset ?? 0) ? { x: s.z, y: s.y, z: s.x } : s;
    }
    default: {
      const s = part.scale ?? KENNEY_METRIC;
      return { x: s, y: s, z: s };
    }
  }
}

/** Height in world units of the Pixi placeholder prism for a kind (its `height` is in pixels). */
export function fallbackHeight(kind: FurnitureKind): number {
  return FURNITURE_CATALOG[kind].height / PX_PER_HEIGHT_UNIT;
}
