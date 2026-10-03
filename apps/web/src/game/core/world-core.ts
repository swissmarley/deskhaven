import {
  type Behavior,
  defaultRoom,
  type Facing,
  type Room,
  stationForBehavior,
} from '@agenthotel/shared';
import { Camera, type CameraView } from '../camera.js';
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
} from '../editor.js';
import {
  buildGrid,
  type Grid,
  inBounds,
  isWalkable,
  nearestWalkable,
  randomWalkable,
  tileKey,
} from '../grid.js';
import { facingFromDelta, roomBounds, screenToTile } from '../iso.js';
import { advanceMotion, buildMotion, type Motion } from '../motion.js';
import { findPath } from '../pathfinding.js';
import { type Pose, poseFor } from '../pose.js';
import { hashString, mulberry32, range } from '../rng.js';
import type { Scene, SceneFactory, SceneHit } from '../scene.js';
import { resolveStation, type StationTarget } from '../stations.js';
import type {
  BubbleKind,
  Ghost,
  TilePoint,
  World,
  WorldAvatarInput,
  WorldEvents,
} from '../types.js';
import type { WorldExtras } from '../world-extras.js';
import { bindDomInput, type InputBinder, type InputTarget } from './dom-input.js';

const WANDER_MIN_S = 6;
const WANDER_MAX_S = 12;
const CLICK_SLOP_PX = 4;
const MAX_FRAME_MS = 100;

interface AvatarState {
  input: WorldAvatarInput;
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
  /** Visual state mirrored to the scene (what the sprite used to remember itself). */
  pose: Pose;
  facing: Facing;
  seated: boolean;
}

/** A furniture piece being dragged in editor mode. The scene only previews; `setRoom` moves it. */
interface FurnitureDrag {
  id: string;
  grab: DragGrab;
  /** Origin the preview currently shows (starts at the piece's real origin). */
  origin: TilePoint;
  /** True once the preview left the real origin; a release without moving is a click. */
  moved: boolean;
}

/** What the core resolved under the pointer at press time. */
type PickResult = { kind: 'avatar'; id: string } | { kind: 'furniture'; id: string } | null;

/**
 * The renderer-agnostic simulation behind the `World` contract: tiles, A* paths, motions,
 * stations, behaviour → pose, bubbles, the editor pointer state machine, the pre-mount queue, the
 * camera and the DOM input adapter. Everything drawn goes through the `Scene` port, so the Pixi
 * and Three backends share one simulation and this class runs under plain Node in tests.
 */
export class WorldCore implements World, WorldExtras, InputTarget {
  private scene: Scene | null = null;
  private unbindInput: (() => void) | null = null;
  private readonly camera: Camera;
  private room: Room = defaultRoom();
  private grid: Grid = buildGrid(this.room);
  private readonly avatars = new Map<string, AvatarState>();
  private events: WorldEvents = {};
  private highlightedAvatar: string | null = null;
  private pointer: { x: number; y: number; hit: PickResult; button: number } | null = null;
  private destroyed = false;
  /** Incremented per `mount` so a mount that lost a race with `destroy`/re-mount tears itself down. */
  private mountGen = 0;
  /** The user's grid toggle; the grid is also forced on in editor mode. */
  private showGrid = true;
  /** Calls made before `mount` resolved, replayed once the scene is ready. */
  private preMount: (() => void)[] = [];
  private readonly removeQueue: string[] = [];

  // Editor mode state.
  private editorMode = false;
  private ghost: Ghost | null = null;
  /** Last tile reported through `onTileHover` (deduped per tile). */
  private hoverTile: TilePoint | null = null;
  private paint: PaintStroke | null = null;
  private drag: FurnitureDrag | null = null;

  constructor(
    private readonly createScene: SceneFactory,
    private readonly bindInput: InputBinder = bindDomInput,
  ) {
    // The camera outlives scenes; its view forwards to whichever scene is mounted.
    const view: CameraView = {
      setTransform: (zoom, x, y) => this.scene?.cameraView.setTransform(zoom, x, y),
    };
    this.camera = new Camera(view);
  }

  async mount(container: HTMLElement): Promise<void> {
    this.destroyed = false;
    const gen = ++this.mountGen;
    const scene = await this.createScene();
    const host = {
      onFrame: (dtMs: number): void => {
        if (this.scene === scene) this.step(dtMs);
      },
      onResize: (w: number, h: number): void => {
        if (this.scene === scene) this.camera.setScreen(w, h);
      },
    };
    await scene.mount(container, host);
    if (this.destroyed || gen !== this.mountGen) {
      scene.destroy();
      return;
    }
    this.scene = scene;
    const canvas = scene.canvas;
    canvas.style.display = 'block';
    // Focusable so editor shortcuts work; focus is taken on pointer down in editor mode.
    canvas.tabIndex = 0;
    canvas.style.outline = 'none';

    // Pushed in this order on every mount. `setHighlight` is not replayed on a re-mount (it was
    // never remembered across mounts; the UI re-issues it on hover/selection changes).
    scene.setRoom(this.room);
    scene.setGridVisible(this.showGrid || this.editorMode);
    scene.setEditorMode(this.editorMode);
    scene.setGhost(this.ghost);
    this.camera.setScreen(scene.screenWidth, scene.screenHeight);
    // The first paint is already framed: no easing from the default zoom on mount.
    this.camera.setBounds(roomBounds(this.room.width, this.room.height), true, true);
    this.unbindInput = this.bindInput(canvas, container, this, this.camera);

    const queued = this.preMount;
    this.preMount = [];
    for (const fn of queued) fn();
  }

  destroy(): void {
    this.destroyed = true;
    // Detaches the camera first, before the scene removes the canvas.
    this.unbindInput?.();
    this.unbindInput = null;
    this.drag = null;
    this.paint = null;
    this.hoverTile = null;
    this.pointer = null;
    this.highlightedAvatar = null;
    this.removeQueue.length = 0;
    this.avatars.clear();
    const scene = this.scene;
    this.scene = null;
    scene?.destroy();
    this.preMount = [];
  }

  setGridVisible(visible: boolean): void {
    this.showGrid = visible;
    this.scene?.setGridVisible(visible || this.editorMode);
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
    if (this.scene) {
      this.scene.setRoom(room);
      this.camera.setBounds(roomBounds(room.width, room.height), sizeChanged);
    }
    this.settleAvatars();
    for (const st of this.avatars.values()) this.refreshDestination(st);
  }

  upsertAvatar(input: WorldAvatarInput): void {
    const scene = this.scene;
    if (!scene) {
      this.preMount.push(() => this.upsertAvatar(input));
      return;
    }
    const existing = this.avatars.get(input.id);
    if (existing && !existing.leaving) {
      existing.input = input;
      scene.setAvatarName(input.id, input.name);
      scene.setAvatarAppearance(input.id, input.avatar, input.isIntern ?? false);
      return;
    }
    if (existing) {
      scene.removeAvatar(input.id);
      this.avatars.delete(input.id);
    }
    const rng = mulberry32(hashString(input.id));
    const st: AvatarState = {
      input,
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
      pose: 'idle',
      facing: 2,
      seated: false,
    };
    this.avatars.set(input.id, st);
    scene.addAvatar({
      id: input.id,
      name: input.name,
      avatar: input.avatar,
      isIntern: input.isIntern ?? false,
    });

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
      scene.poofAvatar(input.id);
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
      this.setFacing(st, seat.facing);
      this.setSeated(st, seat.seated);
    } else {
      const free = randomWalkable(this.grid, rng, (t) => !occupied.has(tileKey(t.x, t.y)));
      this.place(st, free ?? { x: 0, y: 0 });
    }
    this.setPose(st, 'idle');
  }

  removeAvatar(id: string): void {
    if (!this.scene) {
      this.preMount.push(() => this.removeAvatar(id));
      return;
    }
    const st = this.avatars.get(id);
    if (!st || st.leaving) return;
    st.leaving = true;
    st.behavior = { kind: 'leave' };
    this.scene.hideBubble(id);
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
      if (!this.scene) this.preMount.push(() => this.applyBehavior(avatarId, behavior));
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
      { x: end.x, y: end.y, facing: st.facing, seated: false, furnitureId: null },
      null,
    );
  }

  say(avatarId: string, text: string, opts?: { durationMs?: number; kind?: BubbleKind }): void {
    const st = this.avatars.get(avatarId);
    if (!st || st.leaving) return;
    this.scene?.showBubble(avatarId, text, opts?.kind ?? 'speech', opts?.durationMs ?? 4000);
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
    if (!this.scene) return null;
    const r = this.scene.canvas.getBoundingClientRect();
    return this.tileAtScreen(clientX - r.left, clientY - r.top);
  }

  setHighlight(target: { tile?: TilePoint; avatarId?: string; furnitureId?: string } | null): void {
    this.scene?.setHighlightTile(target?.tile ?? null);
    this.scene?.setHighlightFurniture(target?.furnitureId ?? null);
    const next = target?.avatarId ?? null;
    if (next !== this.highlightedAvatar) {
      if (this.highlightedAvatar) this.scene?.setAvatarHighlighted(this.highlightedAvatar, false);
      if (next) this.scene?.setAvatarHighlighted(next, true);
      this.highlightedAvatar = next;
    }
  }

  // ---- editor mode ------------------------------------------------------------------------------

  setEditorMode(on: boolean): void {
    if (on === this.editorMode) return;
    this.editorMode = on;
    this.scene?.setGridVisible(this.showGrid || on);
    this.scene?.setEditorMode(on);
    if (on) return;
    this.cancelDrag();
    this.paint = null;
    this.hoverTile = null;
    this.setGhost(null);
    this.scene?.setHighlightFurniture(null);
  }

  setGhost(ghost: Ghost | null): void {
    this.ghost = ghost;
    this.scene?.setGhost(ghost);
  }

  /** Snap a dragged piece back to its real origin without emitting anything. */
  private cancelDrag(): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    this.scene?.setFurniturePreview(d.id, null);
  }

  keyDown(key: string, typingTarget: boolean): boolean {
    if (!this.editorMode || typingTarget) return false;
    const editorKey = editorKeyFor(key);
    if (!editorKey) return false;
    this.events.onEditorKey?.(editorKey);
    return true;
  }

  // ---- frame loop -------------------------------------------------------------------------------

  /** One simulation frame. Public so tests (and the scene host) can drive it. */
  step(rawDeltaMS: number): void {
    const scene = this.scene;
    if (!scene) return;
    const deltaMS = Math.min(rawDeltaMS, MAX_FRAME_MS);
    const dt = deltaMS / 1000;
    this.camera.tick(deltaMS);
    this.removeQueue.length = 0;
    for (const st of this.avatars.values()) {
      this.advance(st, dt);
      scene.setAvatarPosition(st.input.id, st.pos.x, st.pos.y);
    }
    scene.update(deltaMS);
    for (const st of this.avatars.values())
      if (scene.isAvatarFinished(st.input.id)) this.removeQueue.push(st.input.id);
    for (const id of this.removeQueue) {
      if (this.avatars.has(id)) scene.removeAvatar(id);
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
        this.setFacing(
          st,
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
    this.setSeated(st, false);
    this.setPose(st, 'walk');
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
      this.setFacing(st, target.facing);
      this.setSeated(st, target.seated);
    }
    if (st.faceAvatarId) {
      const other = this.avatars.get(st.faceAvatarId);
      if (other)
        this.setFacing(st, facingFromDelta(other.tile.x - st.tile.x, other.tile.y - st.tile.y));
    }
    const pending = st.pending;
    st.pending = null;
    const wasLeaving = st.pose === 'leave';
    if (pending) this.enact(st, pending);
    else this.setPose(st, st.leaving ? 'leave' : 'idle');
    // Interns vanish in a puff once they reach the door (first time the leave fade starts).
    if (st.input.isIntern && !wasLeaving && st.pose === 'leave')
      this.scene?.poofAvatar(st.input.id);
    if (st.behavior.kind === 'idle' && st.behavior.variant === 'wander')
      st.wanderTimer = range(st.rng, WANDER_MIN_S, WANDER_MAX_S);
  }

  /** Play the pose (and bubble) for a behaviour where the avatar stands. */
  private enact(st: AvatarState, b: Behavior): void {
    const id = st.input.id;
    this.setPose(st, poseFor(b));
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
      this.setSeated(st, false);
      this.place(st, dest);
      this.setPose(st, 'idle');
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
        this.setFacing(st, target.facing);
        this.setSeated(st, target.seated);
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
    this.scene?.setAvatarPosition(st.input.id, tile.x, tile.y);
  }

  /** Mirror of `AvatarSprite.setFacing`: only a change reaches the scene. */
  private setFacing(st: AvatarState, facing: Facing): void {
    if (facing === st.facing) return;
    st.facing = facing;
    this.scene?.setAvatarFacing(st.input.id, facing);
  }

  private setSeated(st: AvatarState, seated: boolean): void {
    st.seated = seated;
    this.scene?.setAvatarSeated(st.input.id, seated);
  }

  private setPose(st: AvatarState, pose: Pose): void {
    st.pose = pose;
    this.scene?.setAvatarPose(st.input.id, pose);
  }

  private stationAvatar(st: AvatarState): {
    id: string;
    deskId: string | null;
    tile: TilePoint;
    facing: Facing;
  } {
    return { id: st.input.id, deskId: st.input.deskId, tile: st.tile, facing: st.facing };
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

  private tileAtScreen(sx: number, sy: number): TilePoint | null {
    const w = this.camera.screenToWorld(sx, sy);
    const t = screenToTile(w.x, w.y);
    return inBounds(this.grid, t.x, t.y) ? t : null;
  }

  // ---- pointer ----------------------------------------------------------------------------------

  pointerDown(p: { x: number; y: number; button: number }): void {
    const scene = this.scene;
    if (!scene) return;
    // Picked exactly once per press; the release classifies from this stored hit.
    const hit: SceneHit = scene.pick(p.x, p.y);
    this.pointer = { x: p.x, y: p.y, hit, button: p.button };
    if (!this.editorMode || p.button !== 0 || this.camera.panModifier) return;
    scene.canvas.focus({ preventScroll: true });
    if (hit?.kind === 'avatar') return;
    const tile = this.tileAtScreen(p.x, p.y);
    if (hit?.kind === 'furniture') {
      const piece = this.room.furniture.find((f) => f.id === hit.id);
      if (!piece) return;
      const home = { x: piece.x, y: piece.y };
      this.drag = {
        id: hit.id,
        grab: beginFurnitureDrag(piece, tile ?? home),
        origin: home,
        moved: false,
      };
      return;
    }
    if (tile) this.paint = beginPaint(tile);
  }

  pointerCancel(): void {
    this.pointer = null;
    this.paint = null;
    this.cancelDrag();
  }

  pointerUp(p: { x: number; y: number }): void {
    const down = this.pointer;
    this.pointer = null;
    const drag = this.drag;
    this.drag = null;
    const paint = this.paint;
    this.paint = null;
    if (drag) {
      // The world never moves the piece itself: snap back and let the UI answer with `setRoom`.
      this.scene?.setFurniturePreview(drag.id, null);
      if (drag.moved) this.events.onFurnitureDragEnd?.(drag.id, drag.origin);
      else this.events.onFurnitureClick?.(drag.id);
      return;
    }
    if (down?.button !== 0 || this.camera.dragging || this.camera.panModifier) return;
    if (paint) {
      const tile = this.tileAtScreen(p.x, p.y);
      if (paint.emitted) {
        for (const t of paintStep(paint, tile)) this.events.onTileDrag?.(t);
      } else if (tile) {
        // Never left the press tile: a plain click, however much the pointer jittered.
        this.events.onTileClick?.(tile);
      }
      return;
    }
    if (Math.hypot(p.x - down.x, p.y - down.y) > CLICK_SLOP_PX) return;
    const hit = down.hit;
    if (hit?.kind === 'avatar') {
      this.events.onAvatarClick?.(hit.id);
      return;
    }
    if (hit?.kind === 'furniture') {
      this.events.onFurnitureClick?.(hit.id);
      return;
    }
    const tile = this.tileAtScreen(p.x, p.y);
    if (tile) this.events.onTileClick?.(tile);
  }

  pointerMove(p: { x: number; y: number; buttons: number }): void {
    const tile = this.tileAtScreen(p.x, p.y);
    this.scene?.setHoverTile(tile);
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
      drag.moved = true;
      drag.origin = origin;
      this.scene?.setFurniturePreview(drag.id, origin);
      return;
    }
    const paint = this.paint;
    if (paint) {
      if ((p.buttons & 1) === 0) {
        // Released outside the canvas; the stroke is over.
        this.paint = null;
        return;
      }
      for (const t of paintStep(paint, tile)) this.events.onTileDrag?.(t);
    }
  }

  pointerLeave(): void {
    this.scene?.setHoverTile(null);
    if (this.editorMode && this.hoverTile !== null) {
      this.hoverTile = null;
      this.events.onTileHover?.(null);
    }
  }
}

// ---- pure helpers ---------------------------------------------------------------------------------

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
