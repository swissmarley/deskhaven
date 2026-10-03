import { FURNITURE_CATALOG, type FurnitureKind } from '@agenthotel/shared';
import {
  BoxGeometry,
  type BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
} from 'three';
import { FIT_MARGIN, fallbackHeight } from './models.js';

/**
 * Procedural furniture built from boxes (three core only, so it runs under Node in tests). Every
 * builder works in the piece-local frame of `models.ts` (footprint centred on the origin, base at
 * y = 0, front = +Z) and registers what it allocates with a `Resources` so the owner can dispose it.
 */

/** Tracks geometries and materials created for one piece (or ghost) so they can be disposed. */
export class Resources {
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: Material[] = [];

  geometry<T extends BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  material<T extends Material>(m: T): T {
    this.materials.push(m);
    return m;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
  }
}

export interface Built {
  group: Group;
  /** Height of the part's top surface (where stacked parts stand). */
  top: number;
}

// ---- server rack ----------------------------------------------------------------------------------

export const RACK_SIZE = { w: 0.6, h: 1.8, d: 0.6 } as const;
export const RACK_BASE_HEIGHT = 0.04;
export const RACK_LED_COUNT = 8;
export const RACK_BODY_COLOR = 0x22242e;
export const RACK_PANEL_COLOR = 0x3a3d4a;
export const LED_GREEN = 0x5cf27a;
export const LED_AMBER = 0xffb347;

/** Dark cabinet with a lighter front panel, a thin base and a column of small unlit LEDs. */
export function buildServerRack(res = new Resources()): Built {
  const group = new Group();
  const body = new Mesh(
    res.geometry(new BoxGeometry(RACK_SIZE.w, RACK_SIZE.h, RACK_SIZE.d)),
    res.material(
      new MeshStandardMaterial({ color: RACK_BODY_COLOR, roughness: 0.6, metalness: 0.3 }),
    ),
  );
  body.position.y = RACK_BASE_HEIGHT + RACK_SIZE.h / 2;
  const base = new Mesh(
    res.geometry(new BoxGeometry(RACK_SIZE.w + 0.06, RACK_BASE_HEIGHT, RACK_SIZE.d + 0.06)),
    res.material(new MeshStandardMaterial({ color: 0x15161c, roughness: 0.9 })),
  );
  base.position.y = RACK_BASE_HEIGHT / 2;
  const panelDepth = 0.02;
  const panel = new Mesh(
    res.geometry(new BoxGeometry(RACK_SIZE.w - 0.08, RACK_SIZE.h - 0.16, panelDepth)),
    res.material(
      new MeshStandardMaterial({ color: RACK_PANEL_COLOR, roughness: 0.5, metalness: 0.4 }),
    ),
  );
  panel.position.set(0, RACK_BASE_HEIGHT + RACK_SIZE.h / 2, RACK_SIZE.d / 2 + panelDepth / 2);
  const leds = new InstancedMesh(
    res.geometry(new BoxGeometry(0.035, 0.035, 0.02)),
    res.material(new MeshBasicMaterial({ color: 0xffffff })),
    RACK_LED_COUNT,
  );
  leds.name = 'leds';
  const m = new Matrix4();
  const color = new Color();
  for (let i = 0; i < RACK_LED_COUNT; i++) {
    const row = Math.floor(i / 2);
    const x = i % 2 === 0 ? -0.16 : 0.16;
    const y = RACK_BASE_HEIGHT + 0.35 + row * 0.33;
    m.makeTranslation(x, y, RACK_SIZE.d / 2 + panelDepth + 0.01);
    leds.setMatrixAt(i, m);
    leds.setColorAt(i, color.setHex((i * 7) % 3 === 0 ? LED_AMBER : LED_GREEN));
  }
  leds.instanceMatrix.needsUpdate = true;
  if (leds.instanceColor) leds.instanceColor.needsUpdate = true;
  for (const mesh of [body, base, panel]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
  group.add(base, body, panel, leds);
  return { group, top: RACK_BASE_HEIGHT + RACK_SIZE.h };
}

// ---- whiteboard -----------------------------------------------------------------------------------

export const BOARD_SIZE = { w: 1.6, h: 1.0, d: 0.03 } as const;
export const BOARD_LEG_HEIGHT = 0.95;
export const BOARD_STROKE_COUNT = 5;
const STROKE_COLORS = [0xd62828, 0x1d4ed8, 0x15803d, 0x111827, 0xd62828] as const;

/** White board on two thin legs with a grey frame and a few coloured marker strokes on the front. */
export function buildWhiteboard(res = new Resources()): Built {
  const group = new Group();
  const centreY = BOARD_LEG_HEIGHT + BOARD_SIZE.h / 2;
  const board = new Mesh(
    res.geometry(new BoxGeometry(BOARD_SIZE.w, BOARD_SIZE.h, BOARD_SIZE.d)),
    res.material(new MeshStandardMaterial({ color: 0xf7f7f5, roughness: 0.35 })),
  );
  board.position.set(0, centreY, 0);
  const frame = new Mesh(
    res.geometry(new BoxGeometry(BOARD_SIZE.w + 0.06, BOARD_SIZE.h + 0.06, BOARD_SIZE.d)),
    res.material(new MeshStandardMaterial({ color: 0x8a8f98, roughness: 0.6, metalness: 0.3 })),
  );
  frame.position.set(0, centreY, -BOARD_SIZE.d);
  const legGeometry = res.geometry(
    new BoxGeometry(0.04, BOARD_LEG_HEIGHT + BOARD_SIZE.h * 0.6, 0.04),
  );
  const legMaterial = res.material(new MeshStandardMaterial({ color: 0x6b7280, roughness: 0.6 }));
  const legY = (BOARD_LEG_HEIGHT + BOARD_SIZE.h * 0.6) / 2;
  const legL = new Mesh(legGeometry, legMaterial);
  legL.position.set(-BOARD_SIZE.w / 2 + 0.08, legY, -BOARD_SIZE.d * 2);
  const legR = new Mesh(legGeometry, legMaterial);
  legR.position.set(BOARD_SIZE.w / 2 - 0.08, legY, -BOARD_SIZE.d * 2);
  const strokes = new InstancedMesh(
    res.geometry(new BoxGeometry(1, 0.025, 0.004)),
    res.material(new MeshBasicMaterial({ color: 0xffffff })),
    BOARD_STROKE_COUNT,
  );
  strokes.name = 'strokes';
  const m = new Matrix4();
  const scale = new Matrix4();
  const color = new Color();
  const lengths = [0.7, 0.45, 0.6, 0.3, 0.5];
  for (let i = 0; i < BOARD_STROKE_COUNT; i++) {
    const len = lengths[i] ?? 0.4;
    const x = -BOARD_SIZE.w / 2 + 0.15 + len / 2 + (i % 2) * 0.1;
    const y = centreY + BOARD_SIZE.h / 2 - 0.18 - i * 0.16;
    m.makeTranslation(x, y, BOARD_SIZE.d / 2 + 0.003).multiply(scale.makeScale(len, 1, 1));
    strokes.setMatrixAt(i, m);
    strokes.setColorAt(i, color.setHex(STROKE_COLORS[i] ?? 0x111827));
  }
  strokes.instanceMatrix.needsUpdate = true;
  if (strokes.instanceColor) strokes.instanceColor.needsUpdate = true;
  for (const mesh of [board, frame, legL, legR]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
  group.add(board, frame, legL, legR, strokes);
  return { group, top: BOARD_LEG_HEIGHT + BOARD_SIZE.h + 0.03 };
}

// ---- counter and table (bases for the coffee machine and the library pc) ----------------------

export const COUNTER_SIZE = { w: 0.8, h: 0.85, d: 0.8 } as const;
export const TABLE_SIZE = { w: 0.8, h: 0.72, d: 0.8 } as const;

/** Kitchen counter: a light cabinet with a darker worktop. */
export function buildCounter(res = new Resources()): Built {
  const group = new Group();
  const topHeight = 0.04;
  const cabinet = new Mesh(
    res.geometry(new BoxGeometry(COUNTER_SIZE.w, COUNTER_SIZE.h, COUNTER_SIZE.d)),
    res.material(new MeshStandardMaterial({ color: 0xdedbd2, roughness: 0.8 })),
  );
  cabinet.position.y = COUNTER_SIZE.h / 2;
  const worktop = new Mesh(
    res.geometry(new BoxGeometry(COUNTER_SIZE.w + 0.04, topHeight, COUNTER_SIZE.d + 0.04)),
    res.material(new MeshStandardMaterial({ color: 0x5b5f66, roughness: 0.4, metalness: 0.1 })),
  );
  worktop.position.y = COUNTER_SIZE.h + topHeight / 2;
  for (const mesh of [cabinet, worktop]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
  group.add(cabinet, worktop);
  return { group, top: COUNTER_SIZE.h + topHeight };
}

/** Small pedestal table for the library computer. */
export function buildTable(res = new Resources()): Built {
  const group = new Group();
  const slab = 0.05;
  const wood = res.material(new MeshStandardMaterial({ color: 0xb08968, roughness: 0.7 }));
  const top = new Mesh(res.geometry(new BoxGeometry(TABLE_SIZE.w, slab, TABLE_SIZE.d)), wood);
  top.position.y = TABLE_SIZE.h - slab / 2;
  const pedestal = new Mesh(
    res.geometry(new BoxGeometry(0.12, TABLE_SIZE.h - slab, 0.12)),
    res.material(new MeshStandardMaterial({ color: 0x4b5563, roughness: 0.5, metalness: 0.4 })),
  );
  pedestal.position.y = (TABLE_SIZE.h - slab) / 2;
  const base = new Mesh(res.geometry(new BoxGeometry(0.45, 0.03, 0.45)), pedestal.material);
  base.position.y = 0.015;
  for (const mesh of [top, pedestal, base]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
  group.add(base, pedestal, top);
  return { group, top: TABLE_SIZE.h };
}

// ---- fallback -------------------------------------------------------------------------------------

/**
 * The placeholder prism of the Pixi renderer as a box: catalog colour, footprint minus the fit
 * margin, `height / 39.19` units tall. Used when a model fails to load so the room has no holes.
 */
export function buildFallbackBox(kind: FurnitureKind, res = new Resources()): Built {
  const spec = FURNITURE_CATALOG[kind];
  const height = Math.max(0.02, fallbackHeight(kind));
  const group = new Group();
  const mesh = new Mesh(
    res.geometry(new BoxGeometry(spec.w - FIT_MARGIN, height, spec.h - FIT_MARGIN)),
    res.material(new MeshStandardMaterial({ color: spec.color, roughness: 0.8 })),
  );
  mesh.position.y = height / 2;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return { group, top: height };
}
