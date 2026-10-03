import type { Avatar, Facing, Room } from '@deskhaven/shared';
import { Application, Container, type Ticker } from 'pixi.js';
import { loadPainters, type Painters } from '../assets/index.js';
import type { CameraView } from '../camera.js';
import { depthKey, tileToScreen } from '../iso.js';
import type { Pose } from '../pose.js';
import type { Scene, SceneAvatarInit, SceneHit, SceneHost } from '../scene.js';
import type { BubbleKind, Ghost, TilePoint } from '../types.js';
import { AvatarSprite } from './avatar.js';
import { Bubble } from './bubble.js';
import { FurnitureSprite, RoomView } from './room.js';

/** Avatars sort above furniture sharing their tile row (see `depthKey`). */
const AVATAR_DEPTH_EXTRA = 500;
const BACKGROUND = 0x1d2229;

interface SceneAvatar {
  sprite: AvatarSprite;
  bubble: Bubble;
  intern: boolean;
}

export function createPixiScene(): Scene {
  return new PixiScene();
}

/**
 * PixiJS 8 backend: the pixel-art isometric office. Layers (bottom to top): floor (tiles, walls,
 * decals, markers), grid, objects (furniture, ghost and avatars depth-sorted by `zIndex`), bubbles,
 * ui (hover/highlight diamonds). Only the objects layer takes part in hit testing.
 */
export class PixiScene implements Scene {
  private app: Application | null = null;
  private painters: Painters | null = null;
  private roomView: RoomView | null = null;
  private host: SceneHost | null = null;
  private readonly viewport = new Container();
  private readonly layers = {
    floor: new Container(),
    grid: new Container(),
    objects: new Container(),
    bubbles: new Container(),
    ui: new Container(),
  };
  private readonly avatars = new Map<string, SceneAvatar>();
  readonly cameraView: CameraView = pixiCameraView(this.viewport);

  private readonly tick = (ticker: Ticker): void => this.host?.onFrame(ticker.deltaMS);
  private readonly onResize = (w: number, h: number): void => {
    if (this.app) this.app.stage.hitArea = this.app.screen;
    this.host?.onResize(w, h);
  };

  async mount(container: HTMLElement, host: SceneHost): Promise<void> {
    const app = new Application();
    await app.init({
      resizeTo: container,
      background: BACKGROUND,
      antialias: false,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    const painters = await loadPainters();
    this.app = app;
    this.painters = painters;
    this.host = host;
    container.appendChild(app.canvas);

    const { floor, grid, objects, bubbles, ui } = this.layers;
    objects.sortableChildren = true;
    bubbles.eventMode = 'none';
    ui.eventMode = 'none';
    grid.eventMode = 'none';
    this.viewport.addChild(floor, grid, objects, bubbles, ui);
    app.stage.addChild(this.viewport);
    this.roomView = new RoomView(this.layers, painters);

    // The stage stays interactive with a full-screen hit area so Pixi's own EventSystem keeps
    // applying the sprites' `pointer` / `grab` cursors; the core reads hits through `pick`.
    app.stage.eventMode = 'static';
    app.stage.hitArea = app.screen;
    app.renderer.on('resize', this.onResize);
    app.ticker.add(this.tick);
  }

  destroy(): void {
    const app = this.app;
    this.host = null;
    for (const a of this.avatars.values()) this.disposeAvatar(a);
    this.avatars.clear();
    this.roomView?.destroy();
    this.roomView = null;
    if (app) {
      app.ticker.remove(this.tick);
      app.renderer.off('resize', this.onResize);
      this.viewport.removeFromParent();
      app.destroy({ removeView: true }, { children: true });
    }
    this.app = null;
    this.painters = null;
  }

  get canvas(): HTMLCanvasElement {
    return this.live().canvas;
  }

  get screenWidth(): number {
    return this.app?.screen.width ?? 1;
  }

  get screenHeight(): number {
    return this.app?.screen.height ?? 1;
  }

  // ---- room ---------------------------------------------------------------------------------------

  setRoom(room: Room): void {
    this.roomView?.setRoom(room);
  }

  setGridVisible(visible: boolean): void {
    this.roomView?.setGridVisible(visible);
  }

  setEditorMode(on: boolean): void {
    this.roomView?.setEditorMode(on);
  }

  setGhost(ghost: Ghost | null): void {
    this.roomView?.setGhost(ghost);
  }

  setHoverTile(tile: TilePoint | null): void {
    this.roomView?.setHover(tile);
  }

  setHighlightTile(tile: TilePoint | null): void {
    this.roomView?.setHighlightTile(tile);
  }

  setHighlightFurniture(id: string | null): void {
    this.roomView?.setHighlightFurniture(id);
  }

  setFurniturePreview(id: string, origin: TilePoint | null): void {
    const sprite = this.roomView?.furnitureById(id);
    if (!sprite) return;
    if (origin) {
      sprite.setDragging(true);
      sprite.moveTo(origin.x, origin.y);
    } else {
      sprite.setDragging(false);
    }
  }

  // ---- avatars ------------------------------------------------------------------------------------

  addAvatar(init: SceneAvatarInit): void {
    if (!this.painters) return;
    const existing = this.avatars.get(init.id);
    if (existing) this.disposeAvatar(existing);
    const sprite = new AvatarSprite({ ...init, painters: this.painters });
    const bubble = new Bubble();
    this.avatars.set(init.id, { sprite, bubble, intern: init.isIntern });
    this.layers.objects.addChild(sprite);
    this.layers.bubbles.addChild(bubble);
  }

  removeAvatar(id: string): void {
    const a = this.avatars.get(id);
    if (!a) return;
    this.disposeAvatar(a);
    this.avatars.delete(id);
  }

  setAvatarName(id: string, name: string): void {
    this.avatars.get(id)?.sprite.setName(name);
  }

  setAvatarAppearance(id: string, avatar: Avatar, isIntern: boolean): void {
    const a = this.avatars.get(id);
    if (!a) return;
    a.intern = isIntern;
    a.sprite.setAppearance(avatar, isIntern);
  }

  setAvatarPose(id: string, pose: Pose): void {
    this.avatars.get(id)?.sprite.setPose(pose);
  }

  setAvatarFacing(id: string, facing: Facing): void {
    this.avatars.get(id)?.sprite.setFacing(facing);
  }

  setAvatarSeated(id: string, seated: boolean): void {
    this.avatars.get(id)?.sprite.setSeated(seated);
  }

  setAvatarPosition(id: string, x: number, y: number): void {
    const a = this.avatars.get(id);
    if (!a) return;
    const { sx, sy } = tileToScreen(x, y);
    a.sprite.position.set(sx, sy);
    a.sprite.zIndex = depthKey(x, y, AVATAR_DEPTH_EXTRA);
  }

  setAvatarHighlighted(id: string, on: boolean): void {
    this.avatars.get(id)?.sprite.setHighlighted(on);
  }

  poofAvatar(id: string): void {
    this.avatars.get(id)?.sprite.poof();
  }

  isAvatarFinished(id: string): boolean {
    return this.avatars.get(id)?.sprite.finished ?? false;
  }

  showBubble(id: string, text: string, kind: BubbleKind, durationMs: number): void {
    this.avatars.get(id)?.bubble.show(text, kind, durationMs);
  }

  hideBubble(id: string): void {
    this.avatars.get(id)?.bubble.hide();
  }

  // ---- frame --------------------------------------------------------------------------------------

  update(dtMs: number): void {
    for (const a of this.avatars.values()) {
      a.sprite.update(dtMs);
      a.bubble.update(dtMs);
      if (a.bubble.active) {
        const lift = (a.sprite.seated ? 56 : 62) * (a.intern ? 0.8 : 1);
        a.bubble.position.set(a.sprite.x, a.sprite.y - lift);
      }
    }
  }

  /**
   * Same hit test Pixi's EventSystem runs for its pointer events (objects layer sorted by zIndex,
   * decals in the floor layer, bubbles/ui/grid layers non-interactive), so the hit order is the one
   * the federated events used to deliver.
   */
  pick(sx: number, sy: number): SceneHit {
    const app = this.app;
    if (!app) return null;
    const boundary = app.renderer.events.rootBoundary;
    boundary.rootTarget = app.stage;
    let node: Container | null = boundary.hitTest(sx, sy) ?? null;
    while (node) {
      if (node instanceof AvatarSprite) return { kind: 'avatar', id: node.id };
      if (node instanceof FurnitureSprite) return { kind: 'furniture', id: node.furnitureId };
      node = node.parent;
    }
    return null;
  }

  // ---- helpers ------------------------------------------------------------------------------------

  private live(): Application {
    if (!this.app) throw new Error('PixiScene is not mounted');
    return this.app;
  }

  private disposeAvatar(a: SceneAvatar): void {
    a.sprite.removeFromParent();
    a.bubble.removeFromParent();
    a.sprite.destroy({ children: true });
    a.bubble.destroy({ children: true });
  }
}

/** Adapts the Pixi viewport container to the renderer-agnostic camera contract. */
function pixiCameraView(view: Container): CameraView {
  return {
    setTransform(zoom, x, y) {
      view.scale.set(zoom);
      view.position.set(x, y);
    },
  };
}
