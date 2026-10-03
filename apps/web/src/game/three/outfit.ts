import type { Avatar } from '@agenthotel/shared';
import {
  BoxGeometry,
  type BufferGeometry,
  CircleGeometry,
  CylinderGeometry,
  Group,
  type Material,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { contrastColor, internTint, parseHex, shade } from '../color.js';
import type { PropKind } from './anim.js';

/**
 * Outfit for the rigged character: flat materials per body part from the `Avatar` DTO (the pack's
 * gradient atlas is not used), procedural hair styles and accessories attached to the `head` and
 * `chest` bones, and the two hand props. Three core only (no addons), so it runs under Node.
 *
 * ## Measured head and chest frames (model units, `rogue.glb` bind pose)
 *
 * Both bones have identity orientation in the bind pose (bone X/Y/Z = character X/Y/Z), so offsets
 * below are plain character-frame offsets from the bone origin. Measured by transforming the
 * `Rogue_Head` / `Rogue_Body` skinned-mesh vertices by their world matrix in the bind pose and
 * slicing them by height (`scripts`-style one-off under Node, see the G2 notes in STATUS.md):
 *
 * - `head` bone at (0, 1.241, 0). Head mesh relative to it: x −0.54 … +0.56, y −0.08 … +0.95,
 *   z −0.50 … +0.52 (the face is +Z). The skull is widest (±0.54) at y +0.2 … +0.3 and narrows
 *   above +0.6 (±0.47 at +0.6, ±0.40 at +0.7, ±0.33 at +0.8, ±0.15 at +0.9). The eyes sit around
 *   y +0.38 with the face front at z ≈ +0.50 there.
 * - `chest` bone at (0, 0.973, 0). Torso relative to it: top at +0.28, half-width 0.27 at the top
 *   and 0.38 at the belly, front at z +0.20 (top) … +0.37 (belly).
 */

export type OutfitSlot = 'skin' | 'shirt' | 'pants';

/** Body-part node names in the GLB (mesh names are `Cube.xxx`; nodes carry the meaningful names). */
export const PART_NODES = [
  'Rogue_Body',
  'Rogue_Head',
  'Rogue_ArmLeft',
  'Rogue_ArmRight',
  'Rogue_LegLeft',
  'Rogue_LegRight',
] as const;

/** Nodes removed at load: the cape and the weapons (children of the hand-slot bones). */
export const EXTRA_NODES = [
  'Rogue_Cape',
  'Knife',
  'Knife_Offhand',
  '1H_Crossbow',
  '2H_Crossbow',
  'Throwable',
] as const;

export function slotForNode(name: string): OutfitSlot | null {
  switch (name) {
    case 'Rogue_Head':
      return 'skin';
    case 'Rogue_Body':
    case 'Rogue_ArmLeft':
    case 'Rogue_ArmRight':
      return 'shirt';
    case 'Rogue_LegLeft':
    case 'Rogue_LegRight':
      return 'pants';
    default:
      return null;
  }
}

export const FALLBACK_COLORS = {
  skin: 0xf1c27d,
  hair: 0x4a2c17,
  shirt: 0x3a86ff,
  pants: 0x3d405b,
} as const;

export const BODY_ROUGHNESS = 0.85;
const HAIR_ROUGHNESS = 0.7;
const DARK = 0x1e1e24;
const HEADSET_COLOR = 0x2b2b30;
const BOOK_COVER = 0x8b3a3a;
const BOOK_PAGES = 0xf3ecd8;
const MUG_COLOR = 0xf4f4f0;
const COFFEE = 0x3a2418;

export interface OutfitMaterials {
  skin: MeshStandardMaterial;
  shirt: MeshStandardMaterial;
  pants: MeshStandardMaterial;
}

/** Colour of a slot for an avatar, washed out for interns. */
export function slotColor(avatar: Avatar, slot: OutfitSlot | 'hair', isIntern: boolean): number {
  const c = parseHex(avatar[slot], FALLBACK_COLORS[slot]);
  return isIntern ? internTint(c) : c;
}

export function materialsFor(avatar: Avatar, isIntern: boolean): OutfitMaterials {
  const make = (slot: OutfitSlot): MeshStandardMaterial =>
    new MeshStandardMaterial({
      color: slotColor(avatar, slot, isIntern),
      roughness: BODY_ROUGHNESS,
      metalness: 0,
    });
  return { skin: make('skin'), shirt: make('shirt'), pants: make('pants') };
}

/** Recolour existing materials in place (appearance edits keep the material objects). */
export function applyOutfitColors(mats: OutfitMaterials, avatar: Avatar, isIntern: boolean): void {
  mats.skin.color.setHex(slotColor(avatar, 'skin', isIntern));
  mats.shirt.color.setHex(slotColor(avatar, 'shirt', isIntern));
  mats.pants.color.setHex(slotColor(avatar, 'pants', isIntern));
}

// ---- shared geometries ----------------------------------------------------------------------------

/** Geometries shared by every character in a scene; materials are per avatar. */
export class OutfitResources {
  private readonly geometries = new Map<string, BufferGeometry>();

  get(key: string, build: () => BufferGeometry): BufferGeometry {
    let g = this.geometries.get(key);
    if (!g) {
      g = build();
      this.geometries.set(key, g);
    }
    return g;
  }

  dispose(): void {
    for (const g of this.geometries.values()) g.dispose();
    this.geometries.clear();
  }
}

// ---- hair -----------------------------------------------------------------------------------------

/** Dome centre above the head bone and its radius: hugs the measured skull (±0.54 wide). */
export const HAIR_DOME_CENTER = new Vector3(0, 0.45, -0.02);
export const HAIR_DOME_RADIUS = 0.6;
/** Vertical squash of the dome so its crown clears the skull top (+0.95) by a few hundredths. */
export const HAIR_DOME_SQUASH = 0.92;

function dome(res: OutfitResources, thetaDeg: number, radius = HAIR_DOME_RADIUS): BufferGeometry {
  return res.get(`dome:${thetaDeg}:${radius}`, () =>
    new SphereGeometry(radius, 20, 10, 0, Math.PI * 2, 0, (thetaDeg * Math.PI) / 180).scale(
      1,
      HAIR_DOME_SQUASH,
      1,
    ),
  );
}

function shaded(geometry: BufferGeometry, material: Material, x = 0, y = 0, z = 0): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  return mesh;
}

/**
 * Procedural hair for a style, parented to the `head` bone (model units). `bald` is an empty group.
 * The dome's front edge is its hairline: a 70° cap ends at y ≈ +0.64 (forehead visible), 60° for the
 * cap at +0.73.
 */
export function hairStyleMesh(
  style: Avatar['hairStyle'],
  color: number,
  res: OutfitResources,
): Group {
  const group = new Group();
  group.name = `hair:${style}`;
  if (style === 'bald') return group;
  const material = new MeshStandardMaterial({
    color: style === 'cap' ? shade(color, 0.6) : color,
    roughness: HAIR_ROUGHNESS,
    metalness: 0,
  });
  const c = HAIR_DOME_CENTER;
  switch (style) {
    case 'short':
      group.add(shaded(dome(res, 70), material, c.x, c.y, c.z));
      break;
    case 'long':
      group.add(
        shaded(dome(res, 80), material, c.x, c.y, c.z),
        // Back panel down to the shoulders (shoulder line ≈ −0.14) and two side falls framing the face.
        shaded(
          res.get('hair:back', () => new BoxGeometry(0.95, 0.95, 0.14)),
          material,
          0,
          0.2,
          -0.54,
        ),
        shaded(
          res.get('hair:side', () => new BoxGeometry(0.12, 0.7, 0.5)),
          material,
          -0.58,
          0.25,
          -0.2,
        ),
        shaded(
          res.get('hair:side', () => new BoxGeometry(0.12, 0.7, 0.5)),
          material,
          0.58,
          0.25,
          -0.2,
        ),
      );
      break;
    case 'cap': {
      const visor = shaded(
        res.get(
          'hair:visor',
          () => new CylinderGeometry(0.62, 0.62, 0.05, 16, 1, false, -Math.PI / 2, Math.PI),
        ),
        material,
        0,
        0.72,
        0.1,
      );
      group.add(shaded(dome(res, 60, 0.62), material, c.x, c.y, c.z), visor);
      break;
    }
    case 'bun':
      group.add(
        shaded(dome(res, 75), material, c.x, c.y, c.z),
        shaded(
          res.get('hair:bun', () => new SphereGeometry(0.2, 12, 8)),
          material,
          0,
          0.85,
          -0.42,
        ),
      );
      break;
  }
  return group;
}

// ---- accessories ----------------------------------------------------------------------------------

/** Eye line relative to the head bone and the face plane there (measured, see the module comment). */
export const EYE_Y = 0.38;
export const FACE_Z = 0.5;

/** Which bone an accessory hangs from. */
export function accessoryBone(kind: Avatar['accessory']): 'head' | 'chest' | null {
  switch (kind) {
    case 'glasses':
    case 'headset':
      return 'head';
    case 'tie':
    case 'scarf':
      return 'chest';
    default:
      return null;
  }
}

/**
 * Procedural accessory, in the frame of `accessoryBone(kind)` (model units). `none` is an empty
 * group. Everything casts shadows; materials are per avatar (disposed with `disposeMaterials`).
 */
export function accessoryMesh(
  kind: Avatar['accessory'],
  avatar: Avatar,
  isIntern: boolean,
  res: OutfitResources,
): Group {
  const group = new Group();
  group.name = `accessory:${kind}`;
  switch (kind) {
    case 'glasses': {
      const m = new MeshStandardMaterial({ color: DARK, roughness: 0.4, metalness: 0.2 });
      const ring = res.get('glasses:ring', () => new TorusGeometry(0.13, 0.018, 8, 20));
      group.add(
        shaded(ring, m, -0.21, EYE_Y, FACE_Z),
        shaded(ring, m, 0.21, EYE_Y, FACE_Z),
        shaded(
          res.get('glasses:bridge', () => new BoxGeometry(0.16, 0.03, 0.03)),
          m,
          0,
          EYE_Y,
          FACE_Z,
        ),
      );
      break;
    }
    case 'headset': {
      const m = new MeshStandardMaterial({ color: HEADSET_COLOR, roughness: 0.6, metalness: 0.1 });
      // Band: a half torus in the XY plane, from the left ear over the crown to the right ear.
      const band = shaded(
        res.get('headset:band', () => new TorusGeometry(0.6, 0.03, 8, 24, Math.PI)),
        m,
        0,
        0.42,
        -0.02,
      );
      const cup = res.get('headset:cup', () =>
        new CylinderGeometry(0.15, 0.15, 0.09, 16).rotateZ(Math.PI / 2),
      );
      const from = new Vector3(-0.6, 0.35, 0);
      const to = new Vector3(-0.25, 0.15, 0.45);
      const boom = shaded(
        res.get('headset:boom', () => new CylinderGeometry(0.018, 0.018, 1, 8)),
        m,
        (from.x + to.x) / 2,
        (from.y + to.y) / 2,
        (from.z + to.z) / 2,
      );
      const dir = to.clone().sub(from);
      boom.scale.y = dir.length();
      boom.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
      group.add(
        band,
        shaded(cup, m, -0.585, 0.4, -0.02),
        shaded(cup, m, 0.585, 0.4, -0.02),
        boom,
        shaded(
          res.get('headset:mic', () => new SphereGeometry(0.035, 8, 6)),
          m,
          to.x,
          to.y,
          to.z,
        ),
      );
      break;
    }
    case 'tie': {
      const m = new MeshStandardMaterial({
        color: contrastColor(slotColor(avatar, 'shirt', isIntern)),
        roughness: BODY_ROUGHNESS,
        metalness: 0,
      });
      const body = shaded(
        // Four radial segments give a square section; the quarter turn puts a flat face forward.
        res.get('tie:body', () =>
          new CylinderGeometry(0.045, 0.08, 0.5, 4, 1).rotateY(Math.PI / 4),
        ),
        m,
        0,
        -0.1,
        0.35,
      );
      body.rotation.x = -0.1;
      group.add(
        shaded(
          res.get('tie:knot', () => new BoxGeometry(0.12, 0.09, 0.06)),
          m,
          0,
          0.17,
          0.28,
        ),
        body,
      );
      break;
    }
    case 'scarf': {
      const m = new MeshStandardMaterial({
        color: slotColor(avatar, 'pants', isIntern),
        roughness: BODY_ROUGHNESS,
        metalness: 0,
      });
      group.add(
        shaded(
          res.get('scarf', () => new TorusGeometry(0.36, 0.085, 10, 24).rotateX(Math.PI / 2)),
          m,
          0,
          0.08,
          0,
        ),
      );
      break;
    }
    default:
      break;
  }
  return group;
}

// ---- props ----------------------------------------------------------------------------------------

/**
 * Hand props (model units, centred on their own origin). The book is one box with per-face
 * materials (covers on ±Y and the spine at −X, page colour on the other sides) lying flat with its
 * page normal +Y; the mug is a tapered cylinder with a half-torus handle at −X and a coffee disc.
 */
export function propMesh(kind: PropKind, res: OutfitResources): Group {
  const group = new Group();
  group.name = `prop:${kind}`;
  switch (kind) {
    case 'book': {
      const cover = new MeshStandardMaterial({ color: BOOK_COVER, roughness: 0.8, metalness: 0 });
      const pages = new MeshStandardMaterial({ color: BOOK_PAGES, roughness: 0.95, metalness: 0 });
      const mesh = new Mesh(
        res.get('book', () => new BoxGeometry(0.42, 0.06, 0.32)),
        [pages, cover, cover, cover, pages, pages],
      );
      mesh.castShadow = true;
      group.add(mesh);
      break;
    }
    case 'mug': {
      const m = new MeshStandardMaterial({ color: MUG_COLOR, roughness: 0.5, metalness: 0 });
      const coffee = new MeshStandardMaterial({ color: COFFEE, roughness: 0.3, metalness: 0 });
      const handle = shaded(
        res.get('mug:handle', () =>
          new TorusGeometry(0.07, 0.02, 8, 16, Math.PI).rotateZ(Math.PI / 2),
        ),
        m,
        -0.1,
        0,
        0,
      );
      const liquid = new Mesh(
        res.get('mug:coffee', () => new CircleGeometry(0.1, 14).rotateX(-Math.PI / 2)),
        coffee,
      );
      liquid.position.y = 0.105;
      group.add(
        shaded(
          res.get('mug:body', () => new CylinderGeometry(0.11, 0.095, 0.22, 14)),
          m,
        ),
        handle,
        liquid,
      );
      break;
    }
  }
  return group;
}

/** Dispose every material under `object` once (geometries are shared through `OutfitResources`). */
export function disposeMaterials(object: Object3D): void {
  for (const m of collectMaterials(object)) m.dispose();
}

/** Every material under `object`, once each (for opacity fades). */
export function collectMaterials(object: Object3D, out: Set<Material> = new Set()): Set<Material> {
  object.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const m: Material | Material[] = o.material;
    if (Array.isArray(m)) for (const x of m) out.add(x);
    else out.add(m);
  });
  return out;
}
