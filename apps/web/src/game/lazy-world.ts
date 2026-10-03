import type { Behavior, Room } from '@deskhaven/shared';
import type {
  BubbleKind,
  Ghost,
  TilePoint,
  World,
  WorldAvatarInput,
  WorldEvents,
} from './types.js';
import type { WorldExtras } from './world-extras.js';

type Inner = World & WorldExtras;

/**
 * A `World` whose renderer is loaded on first `mount()`. Every call made before the inner world is
 * ready is queued (FIFO) and replayed onto it once `mount()` resolves; queries answer with safe
 * defaults until then. `destroy()` is idempotent and the instance can be mounted again (React
 * StrictMode mounts, destroys and re-creates; it also destroys once more after `mount` resolves).
 */
export class LazyWorld implements World, WorldExtras {
  private inner: Inner | null = null;
  private queue: ((w: Inner) => void)[] = [];
  private destroyed = false;
  /** Incremented per `mount` so a mount that lost a race with `destroy`/re-mount tears itself down. */
  private mountGen = 0;
  private showGrid = true;

  constructor(private readonly factory: () => Promise<Inner>) {}

  async mount(container: HTMLElement): Promise<void> {
    this.destroyed = false;
    const gen = ++this.mountGen;
    const inner = await this.factory();
    if (this.destroyed || gen !== this.mountGen) {
      inner.destroy();
      return;
    }
    await inner.mount(container);
    if (this.destroyed || gen !== this.mountGen) {
      inner.destroy();
      return;
    }
    this.inner = inner;
    const queued = this.queue;
    this.queue = [];
    for (const fn of queued) fn(inner);
  }

  destroy(): void {
    this.destroyed = true;
    this.queue = [];
    const inner = this.inner;
    this.inner = null;
    inner?.destroy();
  }

  private call(fn: (w: Inner) => void): void {
    if (this.inner) fn(this.inner);
    else if (!this.destroyed) this.queue.push(fn);
  }

  setGridVisible(visible: boolean): void {
    this.showGrid = visible;
    this.call((w) => w.setGridVisible(visible));
  }

  get gridVisible(): boolean {
    return this.inner ? this.inner.gridVisible : this.showGrid;
  }

  setRoom(room: Room): void {
    this.call((w) => w.setRoom(room));
  }

  upsertAvatar(input: WorldAvatarInput): void {
    this.call((w) => w.upsertAvatar(input));
  }

  removeAvatar(id: string): void {
    this.call((w) => w.removeAvatar(id));
  }

  applyBehavior(avatarId: string, behavior: Behavior): void {
    this.call((w) => w.applyBehavior(avatarId, behavior));
  }

  walkTo(avatarId: string, tile: TilePoint): void {
    this.call((w) => w.walkTo(avatarId, tile));
  }

  say(avatarId: string, text: string, opts?: { durationMs?: number; kind?: BubbleKind }): void {
    this.call((w) => w.say(avatarId, text, opts));
  }

  setEvents(events: WorldEvents): void {
    this.call((w) => w.setEvents(events));
  }

  getAvatarAt(tile: TilePoint): string | null {
    return this.inner ? this.inner.getAvatarAt(tile) : null;
  }

  screenToTile(clientX: number, clientY: number): TilePoint | null {
    return this.inner ? this.inner.screenToTile(clientX, clientY) : null;
  }

  setHighlight(target: { tile?: TilePoint; avatarId?: string; furnitureId?: string } | null): void {
    this.call((w) => w.setHighlight(target));
  }

  setEditorMode(on: boolean): void {
    this.call((w) => w.setEditorMode(on));
  }

  setGhost(ghost: Ghost | null): void {
    this.call((w) => w.setGhost(ghost));
  }
}
