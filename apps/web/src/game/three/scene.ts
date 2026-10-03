import type { Avatar, Facing, Room } from '@agenthotel/shared';
import {
  ACESFilmicToneMapping,
  Mesh,
  MeshBasicMaterial,
  PCFShadowMap,
  PlaneGeometry,
  Raycaster,
  SRGBColorSpace,
  Scene as ThreeSceneGraph,
  Vector2,
  WebGLRenderer,
} from 'three';
import type { CameraView } from '../camera.js';
import type { Pose } from '../pose.js';
import type { Scene, SceneAvatarInit, SceneHit, SceneHost } from '../scene.js';
import type { BubbleKind, Ghost, TilePoint } from '../types.js';
import { AvatarMeshes } from './avatars.js';
import { IsoCamera } from './camera.js';
import { FurnitureLayer } from './furniture.js';
import { createLights, type Lights, SHADOWS_ENABLED } from './lights.js';
import { canvasToNdc } from './math.js';
import { WorldOverlay } from './overlay.js';
import { DEGRADE_FPS, DEGRADE_HOLD_MS, DegradeMonitor, FpsMeter } from './perf.js';
import { RoomMeshes } from './room.js';
import { StatsOverlay, statsRequested } from './stats.js';
import { disposeTextures } from './textures.js';

/** Same background as the Pixi scene. */
const BACKGROUND = 0x1d2229;

/**
 * Degrade switches (ARCHITECTURE §11.6). The defaults are the full-quality path; after the rolling
 * fps has stayed under `DEGRADE_FPS` for `DEGRADE_HOLD_MS` the scene drops to the degraded values
 * once (one `console.info`) and never re-upgrades in the session. `SHADOWS_ENABLED` and
 * `SHADOW_MAP_SIZE` live in `lights.ts`.
 */
export const MAX_PIXEL_RATIO = 2;
export const DEGRADED_PIXEL_RATIO = 1.5;

/** Hover and highlight quads sit above the grid (`GRID_Y`) and the lifted rug so they stay visible. */
const HOVER_Y = 0.025;
const HIGHLIGHT_Y = 0.027;
const HOVER_ALPHA = 0.18;
const HIGHLIGHT_COLOR = 0xffd166;
const HIGHLIGHT_ALPHA = 0.45;

export function createThreeScene(): Scene {
  return new ThreeScene();
}

/**
 * Three.js backend behind the `Scene` port: room (floor, walls, grid), glTF furniture with the
 * editor affordances (ghost, highlight pulse, drag preview, monitor glow), rigged characters with
 * in-scene emotes, raycast picking, a DOM overlay for name labels and bubbles (`overlay.ts`), and
 * the optional stats overlay with the automatic one-step degrade.
 */
export class ThreeScene implements Scene {
  private renderer: WebGLRenderer | null = null;
  private graph: ThreeSceneGraph | null = null;
  private roomMeshes: RoomMeshes | null = null;
  private furniture: FurnitureLayer | null = null;
  private avatars: AvatarMeshes | null = null;
  private lights: Lights | null = null;
  private overlay: WorldOverlay | null = null;
  private stats: StatsOverlay | null = null;
  private readonly fps = new FpsMeter();
  private readonly degradeMonitor = new DegradeMonitor();
  private degraded = false;
  private avatarCount = 0;
  private readonly typingTiles = new Set<string>();
  private readonly iso = new IsoCamera();
  readonly cameraView: CameraView = this.iso;
  private host: SceneHost | null = null;
  private container: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private cleanup: (() => void)[] = [];
  private lastTime: number | null = null;
  private width = 1;
  private height = 1;
  private showGrid = true;
  private editorMode = false;
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private hoverQuad: Mesh | null = null;
  private highlightQuad: Mesh | null = null;
  /** Cursor affordances: the last pointer seen by the scene's own read-only listeners. */
  private pointer: { sx: number; sy: number; buttons: number } | null = null;
  private spaceHeld = false;
  private cursorDirty = false;
  private cursorWritten = '';

  mount(container: HTMLElement, host: SceneHost): Promise<void> {
    const renderer = new WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    renderer.shadowMap.enabled = SHADOWS_ENABLED;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearColor(BACKGROUND, 1);
    container.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.container = container;
    this.host = host;
    this.overlay = new WorldOverlay(container);
    if (statsRequested()) this.stats = new StatsOverlay(container);

    const graph = new ThreeSceneGraph();
    this.graph = graph;
    this.lights = createLights(graph);
    this.roomMeshes = new RoomMeshes(graph);
    this.roomMeshes.setGridVisible(this.showGrid);
    this.furniture = new FurnitureLayer(graph);
    this.avatars = new AvatarMeshes(graph);
    this.hoverQuad = tileQuad(0xffffff, HOVER_ALPHA, HOVER_Y);
    this.highlightQuad = tileQuad(HIGHLIGHT_COLOR, HIGHLIGHT_ALPHA, HIGHLIGHT_Y);
    graph.add(this.hoverQuad, this.highlightQuad);

    this.resize();
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(container);
    } else {
      window.addEventListener('resize', this.onWindowResize);
      this.cleanup.push(() => window.removeEventListener('resize', this.onWindowResize));
    }
    this.bindCursorListeners(renderer.domElement);
    this.lastTime = null;
    renderer.setAnimationLoop(this.frame);
    this.renderNow();
    return Promise.resolve();
  }

  destroy(): void {
    this.host = null;
    this.observer?.disconnect();
    this.observer = null;
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.avatars?.dispose();
    this.avatars = null;
    this.furniture?.dispose();
    this.furniture = null;
    this.roomMeshes?.dispose();
    this.roomMeshes = null;
    this.lights?.dispose();
    this.lights = null;
    this.overlay?.destroy();
    this.overlay = null;
    this.stats?.destroy();
    this.stats = null;
    for (const quad of [this.hoverQuad, this.highlightQuad]) {
      if (!quad) continue;
      quad.removeFromParent();
      quad.geometry.dispose();
      if (quad.material instanceof MeshBasicMaterial) quad.material.dispose();
    }
    this.hoverQuad = null;
    this.highlightQuad = null;
    this.graph?.clear();
    this.graph = null;
    const renderer = this.renderer;
    this.renderer = null;
    this.container = null;
    this.pointer = null;
    if (renderer) {
      renderer.setAnimationLoop(null);
      disposeTextures();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    }
  }

  get canvas(): HTMLCanvasElement {
    if (!this.renderer) throw new Error('ThreeScene is not mounted');
    return this.renderer.domElement;
  }

  get screenWidth(): number {
    return this.width;
  }

  get screenHeight(): number {
    return this.height;
  }

  // ---- room ---------------------------------------------------------------------------------------

  setRoom(room: Room): void {
    this.roomMeshes?.setRoom(room);
    this.furniture?.setRoom(room);
    this.lights?.fit(room.width, room.height);
    this.cursorDirty = true;
  }

  setGridVisible(visible: boolean): void {
    this.showGrid = visible;
    this.roomMeshes?.setGridVisible(visible);
  }

  setEditorMode(on: boolean): void {
    this.editorMode = on;
    this.cursorDirty = true;
  }

  setGhost(ghost: Ghost | null): void {
    this.furniture?.setGhost(ghost);
  }

  setHoverTile(tile: TilePoint | null): void {
    placeQuad(this.hoverQuad, tile, HOVER_Y);
  }

  setHighlightTile(tile: TilePoint | null): void {
    placeQuad(this.highlightQuad, tile, HIGHLIGHT_Y);
  }

  setHighlightFurniture(id: string | null): void {
    this.furniture?.setHighlight(id);
  }

  setFurniturePreview(id: string, origin: TilePoint | null): void {
    this.furniture?.setPreview(id, origin);
  }

  // ---- avatars ------------------------------------------------------------------------------------

  addAvatar(init: SceneAvatarInit): void {
    this.avatars?.add(init);
    this.overlay?.add(init.id, init.name, init.isIntern);
    this.avatarCount = this.overlay?.size ?? 0;
  }

  removeAvatar(id: string): void {
    this.avatars?.remove(id);
    this.overlay?.remove(id);
    this.avatarCount = this.overlay?.size ?? 0;
  }

  setAvatarName(id: string, name: string): void {
    this.overlay?.setName(id, name);
  }

  setAvatarAppearance(id: string, avatar: Avatar, isIntern: boolean): void {
    this.avatars?.setAppearance(id, avatar, isIntern);
    this.overlay?.setIntern(id, isIntern);
  }

  setAvatarPose(id: string, pose: Pose): void {
    this.avatars?.setPose(id, pose);
  }

  setAvatarFacing(id: string, facing: Facing): void {
    this.avatars?.setFacing(id, facing);
  }

  setAvatarSeated(id: string, seated: boolean): void {
    this.avatars?.setSeated(id, seated);
  }

  setAvatarPosition(id: string, x: number, y: number): void {
    this.avatars?.setPosition(id, x, y);
  }

  setAvatarHighlighted(id: string, on: boolean): void {
    this.avatars?.setHighlighted(id, on);
  }

  poofAvatar(id: string): void {
    this.avatars?.poof(id);
  }

  isAvatarFinished(id: string): boolean {
    return this.avatars?.isFinished(id) ?? false;
  }

  showBubble(id: string, text: string, kind: BubbleKind, durationMs: number): void {
    this.overlay?.showBubble(id, text, kind, durationMs);
  }

  hideBubble(id: string): void {
    this.overlay?.hideBubble(id);
  }

  // ---- frame --------------------------------------------------------------------------------------

  update(dtMs: number): void {
    const avatars = this.avatars;
    const furniture = this.furniture;
    const overlay = this.overlay;
    if (avatars) {
      avatars.update(dtMs, this.iso.camera.quaternion);
      furniture?.setGlowTiles(avatars.typingTiles(this.typingTiles));
      if (overlay) {
        avatars.headAnchors((id, point) => {
          overlay.setAnchor(id, this.iso.project(point));
        });
      }
    }
    furniture?.update(dtMs);
    overlay?.update(dtMs);
    this.updateCursor();
  }

  /** Avatars first, then furniture (rugs included, like the Pixi decal layer); tiles are the core's. */
  pick(sx: number, sy: number): SceneHit {
    if (!this.avatars || !this.furniture) return null;
    const ndc = canvasToNdc(sx, sy, this.width, this.height);
    this.raycaster.setFromCamera(this.ndc.set(ndc.x, ndc.y), this.iso.camera);
    const avatarId = this.avatars.pick(this.raycaster);
    if (avatarId) return { kind: 'avatar', id: avatarId };
    const furnitureId = this.furniture.pick(this.raycaster);
    if (furnitureId) return { kind: 'furniture', id: furnitureId };
    return null;
  }

  private readonly frame = (time: number): void => {
    const renderer = this.renderer;
    const graph = this.graph;
    if (!renderer || !graph) return;
    // Pause only while the canvas is out of the document. No `document.hidden` gate: the desktop
    // browser pane reports hidden while on screen, and browsers already throttle the animation
    // loop for hidden tabs (the core clamps dt).
    if (!renderer.domElement.isConnected) {
      this.lastTime = null;
      return;
    }
    const dt = this.lastTime === null ? 0 : time - this.lastTime;
    this.lastTime = time;
    this.host?.onFrame(dt);
    renderer.render(graph, this.iso.camera);
    this.afterRender(renderer, dt);
  };

  /** Rolling fps, the stats overlay and the one-shot degrade (read `renderer.info` of this frame). */
  private afterRender(renderer: WebGLRenderer, dtMs: number): void {
    if (dtMs <= 0) return;
    this.fps.push(dtMs);
    if (!this.degraded && this.degradeMonitor.sample(this.fps.fps, dtMs, this.fps.warm))
      this.degrade();
    if (this.stats) {
      const info = renderer.info.render;
      this.stats.update(dtMs, {
        fps: this.fps.fps,
        calls: info.calls,
        triangles: info.triangles,
        avatars: this.avatarCount,
        degraded: this.degraded,
      });
    }
  }

  /** One step down: smaller shadow map, lower pixel ratio. Never reversed in the session. */
  private degrade(): void {
    const renderer = this.renderer;
    if (!renderer || this.degraded) return;
    this.degraded = true;
    this.lights?.degrade();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DEGRADED_PIXEL_RATIO));
    renderer.setSize(this.width, this.height);
    console.info(
      `[three] fps under ${DEGRADE_FPS} for ${DEGRADE_HOLD_MS / 1000} s: ` +
        `shadow map 1024², pixel ratio ≤ ${DEGRADED_PIXEL_RATIO} for the rest of the session`,
    );
  }

  /** Paint one frame now so the first paint (and a resize) never waits for the loop. */
  private renderNow(): void {
    if (this.renderer && this.graph) this.renderer.render(this.graph, this.iso.camera);
  }

  private resize(): void {
    const renderer = this.renderer;
    const container = this.container;
    if (!renderer || !container) return;
    this.width = Math.max(1, container.clientWidth);
    this.height = Math.max(1, container.clientHeight);
    renderer.setSize(this.width, this.height);
    this.iso.setScreen(this.width, this.height);
    this.overlay?.setScreen(this.width, this.height);
    this.host?.onResize(this.width, this.height);
    this.renderNow();
  }

  private readonly onWindowResize = (): void => this.resize();

  // ---- cursor affordances -------------------------------------------------------------------------

  /**
   * Read-only listeners for the hover cursor (`pointer` over avatars and furniture, `grab` over
   * furniture in editor mode). The camera owns the cursor while it pans (any button held) or while
   * Space is down, so those states are tracked here and the cursor left alone meanwhile.
   */
  private bindCursorListeners(canvas: HTMLCanvasElement): void {
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ): void => {
      canvas.addEventListener(type, fn);
      this.cleanup.push(() => canvas.removeEventListener(type, fn));
    };
    const onWin = <K extends keyof WindowEventMap>(
      type: K,
      fn: (e: WindowEventMap[K]) => void,
    ): void => {
      window.addEventListener(type, fn);
      this.cleanup.push(() => window.removeEventListener(type, fn));
    };
    const track = (e: PointerEvent): void => {
      const r = canvas.getBoundingClientRect();
      this.pointer = { sx: e.clientX - r.left, sy: e.clientY - r.top, buttons: e.buttons };
      this.cursorDirty = true;
    };
    on('pointermove', track);
    on('pointerdown', track);
    on('pointerup', track);
    on('pointerleave', () => {
      this.pointer = null;
      this.cursorDirty = true;
    });
    onWin('keydown', (e) => {
      if (e.code === 'Space') this.spaceHeld = true;
    });
    onWin('keyup', (e) => {
      if (e.code !== 'Space') return;
      this.spaceHeld = false;
      this.cursorDirty = true;
    });
    onWin('blur', () => {
      this.spaceHeld = false;
      this.cursorDirty = true;
    });
  }

  private updateCursor(): void {
    if (!this.cursorDirty || !this.renderer) return;
    this.cursorDirty = false;
    const canvas = this.renderer.domElement;
    const p = this.pointer;
    // A held button means a pan or a drag is in progress; Space means the camera shows `grab`.
    if (this.spaceHeld || (p && p.buttons !== 0)) return;
    let cursor = '';
    if (p) {
      const hit = this.pick(p.sx, p.sy);
      if (hit?.kind === 'avatar') cursor = 'pointer';
      else if (hit?.kind === 'furniture') cursor = this.editorMode ? 'grab' : 'pointer';
    }
    // Only replace what this scene wrote (or nothing): never fight the camera's own cursor.
    const current = canvas.style.cursor;
    if (current !== '' && current !== this.cursorWritten) return;
    if (current !== cursor) canvas.style.cursor = cursor;
    this.cursorWritten = cursor;
  }
}

/** A unit floor quad for the hover / highlight tile, hidden until placed. */
function tileQuad(color: number, opacity: number, y: number): Mesh {
  const mesh = new Mesh(
    new PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
  );
  mesh.position.y = y;
  mesh.visible = false;
  mesh.userData = { pickable: false };
  return mesh;
}

function placeQuad(quad: Mesh | null, tile: TilePoint | null, y: number): void {
  if (!quad) return;
  if (!tile) {
    quad.visible = false;
    return;
  }
  quad.position.set(tile.x, y, tile.y);
  quad.visible = true;
}
