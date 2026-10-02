import {
  type Behavior,
  defaultRoom,
  type Facing,
  type Room,
  stationForBehavior,
} from '@agenthotel/shared';
import { Application, Container, type FederatedPointerEvent, type Ticker } from 'pixi.js';
import { loadPainters, type Painters } from './assets/index.js';
import { AvatarSprite } from './avatar.js';
import { Bubble } from './bubble.js';
import { Camera, type CameraView, isTypingTarget } from './camera.js';
import {
  beginFurnitureDrag,
  beginPaint,
  clampOrigin,
  type DragGrab,
  dragOriginFor,
  editorKeyFor,
  type PaintStroke,
  paintStep,
  samePoint,
} from './editor.js';
import {
  buildGrid,
  type Grid,
  inBounds,
  isWalkable,
  nearestWalkable,
  randomWalkable,
  tileKey,
} from './grid.js';
import { depthKey, facingFromDelta, roomBounds, screenToTile, tileToScreen } from './iso.js';
import { advanceMotion, buildMotion, type Motion } from './motion.js';
import { findPath } from './pathfinding.js';
import { poseFor } from './pose.js';
import { hashString, mulberry32, range } from './rng.js';
import { FurnitureSprite, RoomView } from './room.js';
import { resolveStation, type StationTarget } from './stations.js';
import type {
  BubbleKind,
  Ghost,
  TilePoint,
  World,
  WorldAvatarInput,
  WorldEvents,
} from './types.js';
import type { WorldExtras } from './world-extras.js';

/** Avatars sort above furniture sharing their tile row (see `depthKey`). */
const AVATAR_DEPTH_EXTRA = 500;
const WANDER_MIN_S = 6;
const WANDER_MAX_S = 12;
const CLICK_SLOP_PX = 4;
const MAX_FRAME_MS = 100;
const BACKGROUND = 0x1d2229;

interface AvatarState {
  input: WorldAvatarInput;
  sprite: AvatarSprite;
  bubble: Bubble;
  /** Logical tile: the tile the avatar is on, or is about to reach while walking. */
  tile: TilePoint;
  /** Fractional render position in tile units. */
  pos: { x: number; y: number };
  motion: Motion | null;
  target: StationTarget | null;
  /** Behaviour to enact on arrival. */
  pending: Behavior | null;
  behavior: Behavior;
  /** Seconds until the next roam while idle-wandering. */
  wanderTimer: number;
  rng: () => number;
  leaving: boolean;
  /** For interns: face this avatar once in place. */
  faceAvatarId: string | null;
}

/** A furniture piece being dragged in editor mode. The sprite only previews; `setRoom` moves it. */
interface FurnitureDrag {
  id: string;
  sprite: FurnitureSprite;
  grab: DragGrab;
  /** Origin the preview currently shows (starts at the piece's real origin). */
  origin: TilePoint;
  /** True once the preview left the real origin; a release without moving is a click. */
  moved: boolean;
}

export type { WorldExtras } from './world-extras.js';

export function createPixiWorld(): World & WorldExtras {
  return new PixiWorld();
}

class PixiWorld implements World, WorldExtras {
  private app: Application | null = null;
  private painters: Painters | null = null;
  private roomView: RoomView | null = null;
  private readonly viewport = new Container();
  private readonly layers = {
    floor: new Container(),
    grid: new Container(),
    objects: new Container(),
    bubbles: new Container(),
    ui: new Container(),
  };
  private readonly camera = new Camera(pixiCameraView(this.viewport));
  private room: Room = defaultRoom();
  private grid: Grid = buildGrid(this.room);
  private readonly avatars = new Map<string, AvatarState>();
  private events: WorldEvents = {};
  private highlightedAvatar: string | null = null;
  private pointerDown: { x: number; y: number; target: unknown; button: number } | null = null;
  private destroyed = false;
  /** Incremented per `mount` so a mount that lost a race with `destroy`/re-mount tears itself down. */
  private mountGen = 0;
  /** The user's grid toggle; the grid is also forced on in editor mode. */
  private showGrid = true;
  /** Calls made before `mount` resolved, replayed once Pixi is ready. */
  private preMount: (() => void)[] = [];
  private readonly removeQueue: string[] = [];

  // Editor mode state.
  private editorMode = false;
  private ghost: Ghost | null = null;
  /** Last tile reported through `onTileHover` (deduped per tile). */
  private hoverTile: TilePoint | null = null;
  private paint: PaintStroke | null = null;
  private drag: FurnitureDrag | null = null;
  /** Element carrying the keydown listener (the mount container, so canvas or container focus works). */
  private keyTarget: HTMLElement | null = null;

  private readonly tick = (ticker: Ticker): void => this.step(ticker.deltaMS);
  private readonly onResize = (w: number, h: number): void => {
    this.camera.setScreen(w, h);
    if (this.app) this.app.stage.hitArea = this.app.screen;
  };

  async mount(container: HTMLElement): Promise<void> {
    this.destroyed = false;
    const gen = ++this.mountGen;
    const app = new Application();
    await app.init({
      resizeTo: container,
      background: BACKGROUND,
      antialias: false,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    const painters = await loadPainters();
    if (this.destroyed || gen !== this.mountGen) {
      app.destroy({ removeView: true }, { children: true });
      return;
    }
    this.app = app;
    this.painters = painters;
    app.canvas.style.display = 'block';
    // Focusable so editor shortcuts work; focus is taken on pointer down in editor mode.
    app.canvas.tabIndex = 0;
    app.canvas.style.outline = 'none';
    container.appendChild(app.canvas);
    container.addEventListener('keydown', this.onKeyDown);
    this.keyTarget = container;

    const { floor, grid, objects, bubbles, ui } = this.layers;
    objects.sortableChildren = true;
    bubbles.eventMode = 'none';
    ui.eventMode = 'none';
    grid.eventMode = 'none';
    this.viewport.addChild(floor, grid, objects, bubbles, ui);
    app.stage.addChild(this.viewport);

    this.roomView = new RoomView(this.layers, painters);
    this.roomView.setRoom(this.room);
    this.roomView.setGridVisible(this.showGrid || this.editorMode);
    this.roomView.setEditorMode(this.editorMode);
    this.roomView.setGhost(this.ghost);
    this.camera.setScreen(app.screen.width, app.screen.height);
    this.camera.setBounds(roomBounds(this.room.width, this.room.height), true);
    this.camera.attach(app.canvas);
    app.renderer.on('resize', this.onResize);

    const stage = app.stage;
    stage.eventMode = 'static';
    stage.hitArea = app.screen;
    stage.on('pointerdown', this.onPointerDown);
    stage.on('pointerup', this.onPointerUp);
    stage.on('pointerupoutside', this.onPointerCancel);
    stage.on('pointermove', this.onPointerMove);
    stage.on('pointerleave', this.onPointerLeave);
    app.ticker.add(this.tick);

    const queued = this.preMount;
    this.preMount = [];
    for (const fn of queued) fn();
  }

  destroy(): void {
    this.destroyed = true;
    this.camera.detach();
    this.keyTarget?.removeEventListener('keydown', this.onKeyDown);
    this.keyTarget = null;
    this.drag = null;
    this.paint = null;
    this.hoverTile = null;
    this.pointerDown = null;
    for (const st of this.avatars.values()) this.disposeAvatar(st);
    this.avatars.clear();
    this.roomView?.destroy();
    this.roomView = null;
    const app = this.app;
    if (app) {
      app.ticker.remove(this.tick);
      app.renderer.off('resize', this.onResize);
      app.stage.removeAllListeners();
      // Keep our layer containers alive (avatars and room graphics were destroyed above) so the
      // same World can be mounted again, e.g. under React StrictMode.
      this.viewport.removeFromParent();
      app.destroy({ removeView: true }, { children: true });
    }
    this.app = null;
    this.painters = null;
    this.preMount = [];
  }

  setGridVisible(visible: boolean): void {
    this.showGrid = visible;
    this.roomView?.setGridVisible(visible || this.editorMode);
  }

  get gridVisible(): boolean {
    return this.showGrid;
  }

  setRoom(room: Room): void {
    const sizeChanged = room.width !== this.room.width || room.height !== this.room.height;
    this.room = room;
    this.grid = buildGrid(room);
    // The layout changed under the pointer: drop the preview and wait for the next press.
    this.cancelDrag();
    if (this.roomView) {
      this.roomView.setRoom(room);
      this.camera.setBounds(roomBounds(room.width, room.height), sizeChanged);
    }
    this.settleAvatars();
    for (const st of this.avatars.values()) this.refreshDestination(st);
  }

  upsertAvatar(input: WorldAvatarInput): void {
    if (!this.painters) {
      this.preMount.push(() => this.upsertAvatar(input));
      return;
    }
    const existing = this.avatars.get(input.id);
    if (existing && !existing.leaving) {
      existing.input = input;
      existing.sprite.setName(input.name);
      existing.sprite.setAppearance(input.avatar, input.isIntern ?? false);
      return;
    }
    if (existing) {
      this.disposeAvatar(existing);
      this.avatars.delete(input.id);
    }
    const sprite = new AvatarSprite({ ...input, painters: this.painters });
    const bubble = new Bubble();
    const rng = mulberry32(hashString(input.id));
    const st: AvatarState = {
      input,
      sprite,
      bubble,
      tile: { x: 0, y: 0 },
      pos: { x: 0, y: 0 },
      motion: null,
      target: null,
      pending: null,
      behavior: { kind: 'idle', variant: 'wander' },
      wanderTimer: range(rng, WANDER_MIN_S, WANDER_MAX_S),
      rng,
      leaving: false,
      faceAvatarId: null,
    };
    this.avatars.set(input.id, st);
    this.layers.objects.addChild(sprite);
    this.layers.bubbles.addChild(bubble);

    const occupied = this.occupiedExcept(input.id);
    if (input.isIntern) {
      // Interns come in through the door and stand next to their parent.
      const door =
        resolveStation(this.room, { kind: 'wait' }, this.stationAvatar(st), occupied, {
          grid: this.grid,
        }) ?? nearestWalkable(this.grid, { x: 0, y: this.room.height - 1 });
      const spawn = door ?? randomWalkable(this.grid, rng) ?? { x: 0, y: 0 };
      this.place(st, spawn);
      // Visual only: the UI plays the matching sound.
      sprite.poof();
      const parent = input.parentId ? this.avatars.get(input.parentId) : undefined;
      if (parent) {
        const exclude = new Set(occupied);
        exclude.add(tileKey(parent.tile.x, parent.tile.y));
        const beside = nearestWalkable(this.grid, parent.tile, exclude);
        if (beside) {
          st.faceAvatarId = parent.input.id;
          this.goTo(st, { ...beside, facing: 2, seated: false, furnitureId: null }, null);
          return;
        }
      }
      const roam = randomWalkable(this.grid, rng, (t) => !occupied.has(tileKey(t.x, t.y)));
      if (roam) this.goTo(st, { ...roam, facing: 2, seated: false, furnitureId: null }, null);
      return;
    }
    const seat = resolveStation(
      this.room,
      { kind: 'working', label: '' },
      this.stationAvatar(st),
      occupied,
      { grid: this.grid },
    );
    if (seat) {
      this.place(st, seat);
      sprite.setFacing(seat.facing);
      sprite.setSeated(seat.seated);
    } else {
      const free = randomWalkable(this.grid, rng, (t) => !occupied.has(tileKey(t.x, t.y)));
      this.place(st, free ?? { x: 0, y: 0 });
    }
    sprite.setPose('idle');
  }

  removeAvatar(id: string): void {
    if (!this.painters) {
      this.preMount.push(() => this.removeAvatar(id));
      return;
    }
    const st = this.avatars.get(id);
    if (!st || st.leaving) return;
    st.leaving = true;
    st.behavior = { kind: 'leave' };
    st.bubble.hide();
    const door = resolveStation(
      this.room,
      { kind: 'leave' },
      this.stationAvatar(st),
      this.occupiedExcept(id),
      { grid: this.grid },
    );
    this.goTo(st, door, { kind: 'leave' });
  }

  applyBehavior(avatarId: string, behavior: Behavior): void {
    const st = this.avatars.get(avatarId);
    if (!st) {
      if (!this.painters) this.preMount.push(() => this.applyBehavior(avatarId, behavior));
      return;
    }
    if (st.leaving) return;
    if (behavior.kind === 'leave') {
      this.removeAvatar(avatarId);
      return;
    }
    st.behavior = behavior;
    st.faceAvatarId = null;
    const station = stationForBehavior(behavior);
    if (station === 'stay') {
      this.goTo(st, null, behavior);
      return;
    }
    const target = resolveStation(
      this.room,
      behavior,
      this.stationAvatar(st),
      this.occupiedExcept(avatarId),
      { grid: this.grid, rng: st.rng },
    );
    this.goTo(st, target, behavior);
  }

  walkTo(avatarId: string, tile: TilePoint): void {
    const st = this.avatars.get(avatarId);
    if (!st || st.leaving || !inBounds(this.grid, tile.x, tile.y)) return;
    // A manual walk drops the current activity; the avatar idles (and later wanders) there.
    st.behavior = { kind: 'idle', variant: 'wander' };
    st.faceAvatarId = null;
    const from = this.pathOrigin(st);
    const path = findPath(this.grid, from, tile);
    if (path === null) return;
    const end = path.at(-1) ?? from;
    this.goTo(
      st,
      { x: end.x, y: end.y, facing: st.sprite.facing, seated: false, furnitureId: null },
      null,
    );
  }

  say(avatarId: string, text: string, opts?: { durationMs?: number; kind?: BubbleKind }): void {
    const st = this.avatars.get(avatarId);
    if (!st || st.leaving) return;
    st.bubble.show(text, opts?.kind ?? 'speech', opts?.durationMs ?? 4000);
  }

  setEvents(events: WorldEvents): void {
    this.events = events;
  }

  getAvatarAt(tile: TilePoint): string | null {
    for (const st of this.avatars.values())
      if (st.tile.x === tile.x && st.tile.y === tile.y) return st.input.id;
    for (const st of this.avatars.values())
      if (Math.round(st.pos.x) === tile.x && Math.round(st.pos.y) === tile.y) return st.input.id;
    return null;
  }

  screenToTile(clientX: number, clientY: number): TilePoint | null {
    if (!this.app) return null;
    const r = this.app.canvas.getBoundingClientRect();
    return this.tileAtScreen(clientX - r.left, clientY - r.top);
  }

  setHighlight(target: { tile?: TilePoint; avatarId?: string; furnitureId?: string } | null): void {
    this.roomView?.setHighlightTile(target?.tile ?? null);
    this.roomView?.setHighlightFurniture(target?.furnitureId ?? null);
    const next = target?.avatarId ?? null;
    if (next !== this.highlightedAvatar) {
      if (this.highlightedAvatar)
        this.avatars.get(this.highlightedAvatar)?.sprite.setHighlighted(false);
      if (next) this.avatars.get(next)?.sprite.setHighlighted(true);
      this.highlightedAvatar = next;
    }
  }

  // ---- editor mode ------------------------------------------------------------------------------

  setEditorMode(on: boolean): void {
    if (on === this.editorMode) return;
    this.editorMode = on;
    this.roomView?.setGridVisible(this.showGrid || on);
    this.roomView?.setEditorMode(on);
    if (on) return;
    this.cancelDrag();
    this.paint = null;
    this.hoverTile = null;
    this.setGhost(null);
    this.roomView?.setHighlightFurniture(null);
  }

  setGhost(ghost: Ghost | null): void {
    this.ghost = ghost;
    this.roomView?.setGhost(ghost);
  }

  /** Snap a dragged piece back to its real origin without emitting anything. */
  private cancelDrag(): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    // The sprite may have been replaced by `setRoom`; only touch it while it is still the live one.
    if (this.roomView?.furnitureById(d.id) === d.sprite) d.sprite.setDragging(false);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.editorMode || isTypingTarget(e.target)) return;
    const key = editorKeyFor(e.key);
    if (!key) return;
    e.preventDefault();
    this.events.onEditorKey?.(key);
  };

  // ---- frame loop -------------------------------------------------------------------------------

  private step(rawDeltaMS: number): void {
    const deltaMS = Math.min(rawDeltaMS, MAX_FRAME_MS);
    const dt = deltaMS / 1000;
    this.removeQueue.length = 0;
    for (const st of this.avatars.values()) {
      this.advance(st, dt);
      st.sprite.update(deltaMS);
      const { sx, sy } = tileToScreen(st.pos.x, st.pos.y);
      st.sprite.position.set(sx, sy);
      st.sprite.zIndex = depthKey(st.pos.x, st.pos.y, AVATAR_DEPTH_EXTRA);
      st.bubble.update(deltaMS);
      if (st.bubble.active) {
        const lift = (st.sprite.seated ? 56 : 62) * (st.input.isIntern ? 0.8 : 1);
        st.bubble.position.set(sx, sy - lift);
      }
      if (st.sprite.finished) this.removeQueue.push(st.input.id);
    }
    for (const id of this.removeQueue) {
      const st = this.avatars.get(id);
      if (st) this.disposeAvatar(st);
      this.avatars.delete(id);
      if (this.highlightedAvatar === id) this.highlightedAvatar = null;
    }
  }

  private advance(st: AvatarState, dt: number): void {
    const m = st.motion;
    if (m) {
      const sample = advanceMotion(m, dt);
      if (sample) {
        st.pos.x = sample.x;
        st.pos.y = sample.y;
        st.sprite.setFacing(
          facingFromDelta(sample.to.x - sample.from.x, sample.to.y - sample.from.y),
        );
        st.tile = { x: Math.round(sample.to.x), y: Math.round(sample.to.y) };
      }
      if (!sample || sample.done) {
        st.motion = null;
        this.arrive(st);
      }
      return;
    }
    if (st.leaving || st.pending) return;
    if (st.behavior.kind === 'idle' && st.behavior.variant === 'wander') {
      st.wanderTimer -= dt;
      if (st.wanderTimer <= 0) {
        st.wanderTimer = range(st.rng, WANDER_MIN_S, WANDER_MAX_S);
        const target = resolveStation(
          this.room,
          st.behavior,
          this.stationAvatar(st),
          this.occupiedExcept(st.input.id),
          { grid: this.grid, rng: st.rng },
        );
        if (target) this.goTo(st, target, st.behavior);
      }
    }
  }

  // ---- movement ---------------------------------------------------------------------------------

  /**
   * Walk to `target` then enact `pending`. A null target (or an unreachable one) means "stay":
   * finish the current step, then enact in place.
   */
  private goTo(st: AvatarState, target: StationTarget | null, pending: Behavior | null): void {
    st.pending = pending;
    const from = this.pathOrigin(st);
    const path = target ? findPath(this.grid, from, target) : null;
    if (!target || path === null) {
      st.target = null;
      if (st.motion) this.truncateMotion(st);
      else this.arrive(st);
      return;
    }
    st.target = target;
    const points: TilePoint[] = [{ x: st.pos.x, y: st.pos.y }];
    if (st.pos.x !== from.x || st.pos.y !== from.y) points.push(from);
    points.push(...path);
    if (points.length === 1) {
      st.motion = null;
      this.arrive(st);
      return;
    }
    st.sprite.setSeated(false);
    st.sprite.setPose('walk');
    st.motion = buildMotion(points);
  }

  /** Whole tile to path from: the waypoint being approached while walking, else the current tile. */
  private pathOrigin(st: AvatarState): TilePoint {
    return { x: st.tile.x, y: st.tile.y };
  }

  /** Cut the current path short so the avatar stops at the next whole tile. */
  private truncateMotion(st: AvatarState): void {
    const next = this.pathOrigin(st);
    if (next.x === st.pos.x && next.y === st.pos.y) {
      st.motion = null;
      this.arrive(st);
      return;
    }
    st.motion = buildMotion([{ x: st.pos.x, y: st.pos.y }, next]);
  }

  private arrive(st: AvatarState): void {
    const target = st.target;
    st.target = null;
    if (target) {
      st.sprite.setFacing(target.facing);
      st.sprite.setSeated(target.seated);
    }
    if (st.faceAvatarId) {
      const other = this.avatars.get(st.faceAvatarId);
      if (other)
        st.sprite.setFacing(facingFromDelta(other.tile.x - st.tile.x, other.tile.y - st.tile.y));
    }
    const pending = st.pending;
    st.pending = null;
    const wasLeaving = st.sprite.pose === 'leave';
    if (pending) this.enact(st, pending);
    else st.sprite.setPose(st.leaving ? 'leave' : 'idle');
    // Interns vanish in a puff once they reach the door (first time the leave fade starts).
    if (st.input.isIntern && !wasLeaving && st.sprite.pose === 'leave') st.sprite.poof();
    if (st.behavior.kind === 'idle' && st.behavior.variant === 'wander')
      st.wanderTimer = range(st.rng, WANDER_MIN_S, WANDER_MAX_S);
  }

  /** Play the pose (and bubble) for a behaviour where the avatar stands. */
  private enact(st: AvatarState, b: Behavior): void {
    const id = st.input.id;
    const pose = poseFor(b);
    st.sprite.setPose(pose);
    switch (b.kind) {
      case 'thinking':
        this.say(id, '…', { kind: 'thought', durationMs: 3000 });
        break;
      case 'reading':
        if (b.label) this.say(id, b.label, { kind: 'thought' });
        break;
      case 'typing':
        if (b.label) this.say(id, b.label);
        break;
      case 'terminal':
        if (b.command) this.say(id, b.command, { kind: 'code', durationMs: 5000 });
        break;
      case 'browsing':
        if (b.query) this.say(id, b.query, { kind: 'thought' });
        break;
      case 'delegating':
      case 'working':
        if (b.label) this.say(id, b.label, { kind: 'thought' });
        break;
      case 'raise_hand':
        this.say(id, `! ${RAISE_HAND_TEXT[b.reason]}`, { kind: 'alert', durationMs: 8000 });
        break;
      case 'sweat':
        this.say(id, b.message || SWEAT_TEXT[b.reason], { durationMs: 5000 });
        break;
      case 'cooldown':
        this.say(id, b.resetsAt ? `cooling down until ${formatTime(b.resetsAt)}` : 'cooling down', {
          kind: 'thought',
          durationMs: 6000,
        });
        break;
      default:
        break;
    }
  }

  // ---- room changes -----------------------------------------------------------------------------

  /**
   * After a layout change: anyone standing (or stepping) inside new furniture hops to the nearest
   * free tile; everyone else keeps their place, pose and walk. Avatars are never recreated.
   */
  private settleAvatars(): void {
    const taken = new Set<string>();
    for (const st of this.avatars.values()) {
      const here = { x: Math.round(st.pos.x), y: Math.round(st.pos.y) };
      if (isWalkable(this.grid, here.x, here.y) && !taken.has(tileKey(here.x, here.y))) {
        taken.add(tileKey(here.x, here.y));
        // The waypoint being approached may now be blocked: path from the tile we are on instead.
        if (!isWalkable(this.grid, st.tile.x, st.tile.y)) st.tile = here;
        continue;
      }
      const dest = nearestWalkable(this.grid, here, taken) ?? { x: 0, y: 0 };
      taken.add(tileKey(dest.x, dest.y));
      st.motion = null;
      st.target = null;
      st.pending = null;
      st.sprite.setSeated(false);
      this.place(st, dest);
      st.sprite.setPose('idle');
    }
  }

  /**
   * Re-resolve where an avatar should be after `setRoom`. Station-bound behaviours (a desk, the
   * bookshelf, the door, …) are re-applied once so an avatar whose station moved walks to its new
   * seat; walkers re-path over the new grid; stay/roam avatars keep standing where they are.
   */
  private refreshDestination(st: AvatarState): void {
    const station = stationForBehavior(st.behavior);
    if (station !== 'stay' && station !== 'roam') {
      const target = resolveStation(
        this.room,
        st.behavior,
        this.stationAvatar(st),
        this.occupiedExcept(st.input.id),
        { grid: this.grid, rng: st.rng },
      );
      const heading = st.motion ? st.target : st.tile;
      if (target && !(heading && heading.x === target.x && heading.y === target.y)) {
        this.goTo(st, target, st.behavior);
        return;
      }
      if (target && !st.motion) {
        // Same seat, possibly rotated: just face the new way.
        st.sprite.setFacing(target.facing);
        st.sprite.setSeated(target.seated);
      }
    }
    if (!st.motion) return;
    // Still walking: recompute the path over the new grid, or stop at the next tile if the goal vanished.
    const target = st.target;
    if (target && isWalkable(this.grid, target.x, target.y)) this.goTo(st, target, st.pending);
    else {
      st.target = null;
      this.truncateMotion(st);
    }
  }

  // ---- helpers ----------------------------------------------------------------------------------

  private place(st: AvatarState, tile: TilePoint): void {
    st.tile = { x: tile.x, y: tile.y };
    st.pos = { x: tile.x, y: tile.y };
    st.motion = null;
    const { sx, sy } = tileToScreen(tile.x, tile.y);
    st.sprite.position.set(sx, sy);
    st.sprite.zIndex = depthKey(tile.x, tile.y, AVATAR_DEPTH_EXTRA);
  }

  private stationAvatar(st: AvatarState): {
    id: string;
    deskId: string | null;
    tile: TilePoint;
    facing: Facing;
  } {
    return { id: st.input.id, deskId: st.input.deskId, tile: st.tile, facing: st.sprite.facing };
  }

  /** Tiles claimed by every other avatar: where they stand and where they are heading. */
  private occupiedExcept(id: string): Set<string> {
    const out = new Set<string>();
    for (const st of this.avatars.values()) {
      if (st.input.id === id) continue;
      out.add(tileKey(st.tile.x, st.tile.y));
      if (st.target) out.add(tileKey(st.target.x, st.target.y));
    }
    return out;
  }

  private disposeAvatar(st: AvatarState): void {
    st.sprite.removeFromParent();
    st.bubble.removeFromParent();
    st.sprite.destroy({ children: true });
    st.bubble.destroy({ children: true });
  }

  private tileAtScreen(sx: number, sy: number): TilePoint | null {
    const w = this.camera.screenToWorld(sx, sy);
    const t = screenToTile(w.x, w.y);
    return inBounds(this.grid, t.x, t.y) ? t : null;
  }

  // ---- pointer ----------------------------------------------------------------------------------

  private readonly onPointerDown = (e: FederatedPointerEvent): void => {
    this.pointerDown = { x: e.global.x, y: e.global.y, target: e.target, button: e.button };
    if (!this.editorMode || e.button !== 0 || this.camera.panModifier) return;
    this.app?.canvas.focus({ preventScroll: true });
    const target = e.target;
    if (target instanceof AvatarSprite) return;
    const tile = this.tileAtScreen(e.global.x, e.global.y);
    if (target instanceof FurnitureSprite) {
      const piece = target.piece;
      const home = { x: piece.x, y: piece.y };
      this.drag = {
        id: target.furnitureId,
        sprite: target,
        grab: beginFurnitureDrag(piece, tile ?? home),
        origin: home,
        moved: false,
      };
      return;
    }
    if (tile) this.paint = beginPaint(tile);
  };

  private readonly onPointerCancel = (): void => {
    this.pointerDown = null;
    this.paint = null;
    this.cancelDrag();
  };

  private readonly onPointerUp = (e: FederatedPointerEvent): void => {
    const down = this.pointerDown;
    this.pointerDown = null;
    const drag = this.drag;
    this.drag = null;
    const paint = this.paint;
    this.paint = null;
    if (drag) {
      // The world never moves the piece itself: snap back and let the UI answer with `setRoom`.
      if (this.roomView?.furnitureById(drag.id) === drag.sprite) drag.sprite.setDragging(false);
      if (drag.moved) this.events.onFurnitureDragEnd?.(drag.id, drag.origin);
      else this.events.onFurnitureClick?.(drag.id);
      return;
    }
    if (down?.button !== 0 || this.camera.dragging || this.camera.panModifier) return;
    if (paint) {
      const tile = this.tileAtScreen(e.global.x, e.global.y);
      if (paint.emitted) {
        for (const t of paintStep(paint, tile)) this.events.onTileDrag?.(t);
      } else if (tile) {
        // Never left the press tile: a plain click, however much the pointer jittered.
        this.events.onTileClick?.(tile);
      }
      return;
    }
    if (Math.hypot(e.global.x - down.x, e.global.y - down.y) > CLICK_SLOP_PX) return;
    const target = down.target;
    if (target instanceof AvatarSprite) {
      this.events.onAvatarClick?.(target.id);
      return;
    }
    if (target instanceof FurnitureSprite) {
      this.events.onFurnitureClick?.(target.furnitureId);
      return;
    }
    const tile = this.tileAtScreen(e.global.x, e.global.y);
    if (tile) this.events.onTileClick?.(tile);
  };

  private readonly onPointerMove = (e: FederatedPointerEvent): void => {
    const tile = this.tileAtScreen(e.global.x, e.global.y);
    this.roomView?.setHover(tile);
    if (!this.editorMode) return;
    if (!samePoint(tile, this.hoverTile)) {
      this.hoverTile = tile;
      this.events.onTileHover?.(tile);
    }
    const drag = this.drag;
    if (drag) {
      // Outside the room the preview stays where it last snapped.
      if (!tile) return;
      const origin = clampOrigin(dragOriginFor(drag.grab, tile), drag.grab, this.room);
      if (samePoint(origin, drag.origin)) return;
      if (!drag.moved) {
        drag.moved = true;
        drag.sprite.setDragging(true);
      }
      drag.origin = origin;
      drag.sprite.moveTo(origin.x, origin.y);
      return;
    }
    const paint = this.paint;
    if (paint) {
      if ((e.buttons & 1) === 0) {
        // Released outside the canvas; the stroke is over.
        this.paint = null;
        return;
      }
      for (const t of paintStep(paint, tile)) this.events.onTileDrag?.(t);
    }
  };

  private readonly onPointerLeave = (): void => {
    this.roomView?.setHover(null);
    if (this.editorMode && this.hoverTile !== null) {
      this.hoverTile = null;
      this.events.onTileHover?.(null);
    }
  };
}

// ---- pure helpers ---------------------------------------------------------------------------------

/** Adapts the Pixi viewport container to the renderer-agnostic camera contract. */
function pixiCameraView(view: Container): CameraView {
  return {
    setTransform(zoom, x, y) {
      view.scale.set(zoom);
      view.position.set(x, y);
    },
  };
}

const RAISE_HAND_TEXT: Record<Extract<Behavior, { kind: 'raise_hand' }>['reason'], string> = {
  permission: 'needs permission',
  question: 'has a question',
  plan: 'plan ready for review',
  input: 'needs input',
};

const SWEAT_TEXT: Record<Extract<Behavior, { kind: 'sweat' }>['reason'], string> = {
  tool_failed: 'tool failed',
  error: 'something went wrong',
  auth: 'authentication problem',
  rate_limit: 'rate limited',
  billing: 'billing problem',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
