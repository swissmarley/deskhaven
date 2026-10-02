import { type Behavior, defaultRoom, type Room } from '@agenthotel/shared';
import { ACESFilmicToneMapping, PCFShadowMap, Scene, SRGBColorSpace, WebGLRenderer } from 'three';
import { Camera, isTypingTarget } from '../camera.js';
import { editorKeyFor, samePoint } from '../editor.js';
import { buildGrid, type Grid, inBounds } from '../grid.js';
import { roomBounds, screenToTile } from '../iso.js';
import type {
  BubbleKind,
  Ghost,
  TilePoint,
  World,
  WorldAvatarInput,
  WorldEvents,
} from '../types.js';
import type { WorldExtras } from '../world-extras.js';
import { IsoCamera } from './camera.js';
import { createLights, type Lights } from './lights.js';
import { RoomMeshes } from './room.js';
import { disposeTextures } from './textures.js';

/** Same background as the Pixi world. */
const BACKGROUND = 0x1d2229;
const MAX_FRAME_MS = 100;
const MAX_PIXEL_RATIO = 2;
const CLICK_SLOP_PX = 4;

export function createThreeWorld(): World & WorldExtras {
  return new ThreeWorld();
}

/**
 * Three.js renderer behind the `World` contract. G0 renders the room only (floor, walls, lighting,
 * soft shadows, grid); avatar, bubble and editor calls are accepted and their state kept so later
 * milestones can render them.
 */
class ThreeWorld implements World, WorldExtras {
  private renderer: WebGLRenderer | null = null;
  private scene: Scene | null = null;
  private roomMeshes: RoomMeshes | null = null;
  private lights: Lights | null = null;
  private readonly iso = new IsoCamera();
  private readonly camera = new Camera(this.iso);
  private room: Room = defaultRoom();
  private grid: Grid = buildGrid(this.room);
  private events: WorldEvents = {};
  private destroyed = false;
  /** Incremented per `mount` so a mount that lost a race with `destroy`/re-mount tears itself down. */
  private mountGen = 0;
  private showGrid = true;
  private editorMode = false;
  private ghost: Ghost | null = null;
  private highlight: { tile?: TilePoint; avatarId?: string; furnitureId?: string } | null = null;
  /** Avatar state is kept for G1; nothing is drawn yet. */
  private readonly avatars = new Map<string, WorldAvatarInput>();
  private readonly behaviors = new Map<string, Behavior>();
  private container: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private cleanup: (() => void)[] = [];
  private lastTime: number | null = null;
  private pointerDown: { x: number; y: number; button: number } | null = null;
  private hoverTile: TilePoint | null = null;

  mount(container: HTMLElement): Promise<void> {
    this.destroyed = false;
    const gen = ++this.mountGen;
    const renderer = new WebGLRenderer({ antialias: true, alpha: false });
    if (this.destroyed || gen !== this.mountGen) {
      renderer.dispose();
      return Promise.resolve();
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearColor(BACKGROUND, 1);
    const canvas = renderer.domElement;
    canvas.style.display = 'block';
    canvas.tabIndex = 0;
    canvas.style.outline = 'none';
    container.appendChild(canvas);
    this.renderer = renderer;
    this.container = container;

    const scene = new Scene();
    this.scene = scene;
    this.lights = createLights(scene);
    this.roomMeshes = new RoomMeshes(scene);
    this.roomMeshes.setRoom(this.room);
    this.roomMeshes.setGridVisible(this.showGrid || this.editorMode);
    this.lights.fit(this.room.width, this.room.height);

    this.resize();
    this.camera.setBounds(roomBounds(this.room.width, this.room.height), true);
    this.camera.attach(canvas);
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(container);
    } else {
      window.addEventListener('resize', this.onWindowResize);
      this.cleanup.push(() => window.removeEventListener('resize', this.onWindowResize));
    }
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ): void => {
      el.addEventListener(type, fn);
      this.cleanup.push(() => el.removeEventListener(type, fn));
    };
    on(canvas, 'pointerdown', this.onPointerDown);
    on(canvas, 'pointerup', this.onPointerUp);
    on(canvas, 'pointercancel', this.onPointerCancel);
    on(canvas, 'pointermove', this.onPointerMove);
    on(canvas, 'pointerleave', this.onPointerLeave);
    on(container, 'keydown', this.onKeyDown);

    this.lastTime = null;
    renderer.setAnimationLoop(this.frame);
    return Promise.resolve();
  }

  destroy(): void {
    this.destroyed = true;
    this.camera.detach();
    this.observer?.disconnect();
    this.observer = null;
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.pointerDown = null;
    this.hoverTile = null;
    this.roomMeshes?.dispose();
    this.roomMeshes = null;
    this.lights?.dispose();
    this.lights = null;
    this.scene?.clear();
    this.scene = null;
    const renderer = this.renderer;
    this.renderer = null;
    this.container = null;
    if (renderer) {
      renderer.setAnimationLoop(null);
      disposeTextures();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    }
  }

  setGridVisible(visible: boolean): void {
    this.showGrid = visible;
    this.roomMeshes?.setGridVisible(visible || this.editorMode);
  }

  get gridVisible(): boolean {
    return this.showGrid;
  }

  setRoom(room: Room): void {
    const sizeChanged = room.width !== this.room.width || room.height !== this.room.height;
    this.room = room;
    this.grid = buildGrid(room);
    if (this.roomMeshes) {
      this.roomMeshes.setRoom(room);
      this.lights?.fit(room.width, room.height);
      this.camera.setBounds(roomBounds(room.width, room.height), sizeChanged);
    }
  }

  upsertAvatar(input: WorldAvatarInput): void {
    this.avatars.set(input.id, input);
  }

  removeAvatar(id: string): void {
    this.avatars.delete(id);
    this.behaviors.delete(id);
  }

  applyBehavior(avatarId: string, behavior: Behavior): void {
    if (behavior.kind === 'leave') {
      this.removeAvatar(avatarId);
      return;
    }
    if (this.avatars.has(avatarId)) this.behaviors.set(avatarId, behavior);
  }

  walkTo(): void {
    // G1: avatars.
  }

  say(_avatarId: string, _text: string, _opts?: { durationMs?: number; kind?: BubbleKind }): void {
    // G2: bubbles.
  }

  setEvents(events: WorldEvents): void {
    this.events = events;
  }

  getAvatarAt(): string | null {
    return null;
  }

  screenToTile(clientX: number, clientY: number): TilePoint | null {
    if (!this.renderer) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    return this.tileAtScreen(clientX - r.left, clientY - r.top);
  }

  setHighlight(target: { tile?: TilePoint; avatarId?: string; furnitureId?: string } | null): void {
    this.highlight = target;
  }

  setEditorMode(on: boolean): void {
    if (on === this.editorMode) return;
    this.editorMode = on;
    this.roomMeshes?.setGridVisible(this.showGrid || on);
    if (on) return;
    this.hoverTile = null;
    this.setGhost(null);
  }

  setGhost(ghost: Ghost | null): void {
    this.ghost = ghost;
  }

  // ---- frame loop -------------------------------------------------------------------------------

  private readonly frame = (time: number): void => {
    const renderer = this.renderer;
    const scene = this.scene;
    if (!renderer || !scene) return;
    if (document.hidden) {
      this.lastTime = null;
      return;
    }
    const dt = this.lastTime === null ? 0 : Math.min(time - this.lastTime, MAX_FRAME_MS);
    this.lastTime = time;
    this.step(dt);
    renderer.render(scene, this.iso.camera);
  };

  private step(_deltaMS: number): void {
    // G1: avatar motion. The highlight and ghost state is kept for G3.
    void this.highlight;
    void this.ghost;
  }

  private resize(): void {
    const renderer = this.renderer;
    const container = this.container;
    if (!renderer || !container) return;
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h);
    this.iso.setScreen(w, h);
    this.camera.setScreen(w, h);
  }

  private readonly onWindowResize = (): void => this.resize();

  private tileAtScreen(sx: number, sy: number): TilePoint | null {
    const w = this.camera.screenToWorld(sx, sy);
    const t = screenToTile(w.x, w.y);
    return inBounds(this.grid, t.x, t.y) ? t : null;
  }

  private canvasPoint(e: PointerEvent): { x: number; y: number } {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ---- pointer ----------------------------------------------------------------------------------

  private readonly onPointerDown = (e: PointerEvent): void => {
    const p = this.canvasPoint(e);
    this.pointerDown = { x: p.x, y: p.y, button: e.button };
    if (this.editorMode && e.button === 0 && !this.camera.panModifier)
      this.renderer?.domElement.focus({ preventScroll: true });
  };

  private readonly onPointerCancel = (): void => {
    this.pointerDown = null;
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (down?.button !== 0 || this.camera.dragging || this.camera.panModifier) return;
    const p = this.canvasPoint(e);
    if (Math.hypot(p.x - down.x, p.y - down.y) > CLICK_SLOP_PX) return;
    const tile = this.tileAtScreen(p.x, p.y);
    if (tile) this.events.onTileClick?.(tile);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.editorMode) return;
    const p = this.canvasPoint(e);
    const tile = this.tileAtScreen(p.x, p.y);
    if (!samePoint(tile, this.hoverTile)) {
      this.hoverTile = tile;
      this.events.onTileHover?.(tile);
    }
  };

  private readonly onPointerLeave = (): void => {
    if (this.editorMode && this.hoverTile !== null) {
      this.hoverTile = null;
      this.events.onTileHover?.(null);
    }
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.editorMode || isTypingTarget(e.target)) return;
    const key = editorKeyFor(e.key);
    if (!key) return;
    e.preventDefault();
    this.events.onEditorKey?.(key);
  };
}
