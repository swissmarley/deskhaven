import type { Avatar, Facing, Room } from '@agenthotel/shared';
import {
  ACESFilmicToneMapping,
  PCFShadowMap,
  SRGBColorSpace,
  Scene as ThreeSceneGraph,
  WebGLRenderer,
} from 'three';
import type { CameraView } from '../camera.js';
import type { Pose } from '../pose.js';
import type { Scene, SceneAvatarInit, SceneHit, SceneHost } from '../scene.js';
import type { BubbleKind, Ghost, TilePoint } from '../types.js';
import { IsoCamera } from './camera.js';
import { createLights, type Lights } from './lights.js';
import { RoomMeshes } from './room.js';
import { disposeTextures } from './textures.js';

/** Same background as the Pixi scene. */
const BACKGROUND = 0x1d2229;
const MAX_PIXEL_RATIO = 2;

export function createThreeScene(): Scene {
  return new ThreeScene();
}

/**
 * Three.js backend behind the `Scene` port. G1a renders the room only (floor, walls, lighting,
 * soft shadows, grid) and keeps the camera exact; avatar, bubble, ghost and highlight calls are
 * accepted and their state kept so G1b can render them. `pick` finds nothing yet, so every press
 * resolves to a tile in the core.
 */
export class ThreeScene implements Scene {
  private renderer: WebGLRenderer | null = null;
  private graph: ThreeSceneGraph | null = null;
  private roomMeshes: RoomMeshes | null = null;
  private lights: Lights | null = null;
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
  /** State kept for G1b; nothing is drawn yet. */
  private ghost: Ghost | null = null;
  private hoverTile: TilePoint | null = null;
  private highlightTile: TilePoint | null = null;
  private highlightFurniture: string | null = null;
  private readonly avatars = new Map<string, SceneAvatarInit>();

  mount(container: HTMLElement, host: SceneHost): Promise<void> {
    const renderer = new WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearColor(BACKGROUND, 1);
    container.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.container = container;
    this.host = host;

    const graph = new ThreeSceneGraph();
    this.graph = graph;
    this.lights = createLights(graph);
    this.roomMeshes = new RoomMeshes(graph);
    this.roomMeshes.setGridVisible(this.showGrid);

    this.resize();
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(container);
    } else {
      window.addEventListener('resize', this.onWindowResize);
      this.cleanup.push(() => window.removeEventListener('resize', this.onWindowResize));
    }
    this.lastTime = null;
    renderer.setAnimationLoop(this.frame);
    return Promise.resolve();
  }

  destroy(): void {
    this.host = null;
    this.observer?.disconnect();
    this.observer = null;
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.avatars.clear();
    this.roomMeshes?.dispose();
    this.roomMeshes = null;
    this.lights?.dispose();
    this.lights = null;
    this.graph?.clear();
    this.graph = null;
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
    this.lights?.fit(room.width, room.height);
  }

  setGridVisible(visible: boolean): void {
    this.showGrid = visible;
    this.roomMeshes?.setGridVisible(visible);
  }

  setEditorMode(): void {
    // G1b: cursor affordances.
  }

  setGhost(ghost: Ghost | null): void {
    this.ghost = ghost;
  }

  setHoverTile(tile: TilePoint | null): void {
    this.hoverTile = tile;
  }

  setHighlightTile(tile: TilePoint | null): void {
    this.highlightTile = tile;
  }

  setHighlightFurniture(id: string | null): void {
    this.highlightFurniture = id;
  }

  setFurniturePreview(): void {
    // G1b: furniture drag preview.
  }

  // ---- avatars (state only until G1b) -----------------------------------------------------------

  addAvatar(init: SceneAvatarInit): void {
    this.avatars.set(init.id, init);
  }

  removeAvatar(id: string): void {
    this.avatars.delete(id);
  }

  setAvatarName(id: string, name: string): void {
    const a = this.avatars.get(id);
    if (a) this.avatars.set(id, { ...a, name });
  }

  setAvatarAppearance(id: string, avatar: Avatar, isIntern: boolean): void {
    const a = this.avatars.get(id);
    if (a) this.avatars.set(id, { ...a, avatar, isIntern });
  }

  setAvatarPose(_id: string, _pose: Pose): void {}

  setAvatarFacing(_id: string, _facing: Facing): void {}

  setAvatarSeated(_id: string, _seated: boolean): void {}

  setAvatarPosition(_id: string, _x: number, _y: number): void {}

  setAvatarHighlighted(_id: string, _on: boolean): void {}

  poofAvatar(_id: string): void {}

  isAvatarFinished(_id: string): boolean {
    // No leave fade yet: a leaving avatar is removed as soon as it reaches the door.
    return false;
  }

  showBubble(_id: string, _text: string, _kind: BubbleKind, _durationMs: number): void {}

  hideBubble(_id: string): void {}

  // ---- frame --------------------------------------------------------------------------------------

  update(_dtMs: number): void {
    void this.ghost;
    void this.hoverTile;
    void this.highlightTile;
    void this.highlightFurniture;
  }

  pick(_sx: number, _sy: number): SceneHit {
    return null;
  }

  private readonly frame = (time: number): void => {
    const renderer = this.renderer;
    const graph = this.graph;
    if (!renderer || !graph) return;
    if (document.hidden) {
      this.lastTime = null;
      return;
    }
    const dt = this.lastTime === null ? 0 : time - this.lastTime;
    this.lastTime = time;
    this.host?.onFrame(dt);
    renderer.render(graph, this.iso.camera);
  };

  private resize(): void {
    const renderer = this.renderer;
    const container = this.container;
    if (!renderer || !container) return;
    this.width = Math.max(1, container.clientWidth);
    this.height = Math.max(1, container.clientHeight);
    renderer.setSize(this.width, this.height);
    this.iso.setScreen(this.width, this.height);
    this.host?.onResize(this.width, this.height);
  }

  private readonly onWindowResize = (): void => this.resize();
}
