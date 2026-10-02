import type { Avatar, Facing, Room } from '@agenthotel/shared';
import type { CameraView } from '../../src/game/camera.js';
import type { Pose } from '../../src/game/pose.js';
import type { Scene, SceneAvatarInit, SceneHit, SceneHost } from '../../src/game/scene.js';
import type { BubbleKind, Ghost, TilePoint } from '../../src/game/types.js';

export interface SceneCall {
  method: string;
  args: unknown[];
}

export const FAKE_WIDTH = 800;
export const FAKE_HEIGHT = 600;

/**
 * A `Scene` that only records. `pick` answers with whatever the test scripted in `hit`;
 * `isAvatarFinished` reports the ids in `finished`. The canvas is a plain object exposing just
 * what `WorldCore` touches (`getBoundingClientRect`, `focus`, `tabIndex`, `style`).
 */
export class FakeScene implements Scene {
  readonly calls: SceneCall[] = [];
  host: SceneHost | null = null;
  mounted = 0;
  destroyed = 0;
  hit: SceneHit = null;
  readonly finished = new Set<string>();
  /** Last transform pushed by the camera (zoom, offset x, offset y). */
  transform = { zoom: 1, x: 0, y: 0 };
  readonly focusCalls: number[] = [];
  readonly canvas: HTMLCanvasElement;
  readonly cameraView: CameraView = {
    setTransform: (zoom, x, y) => {
      this.transform = { zoom, x, y };
    },
  };
  readonly screenWidth = FAKE_WIDTH;
  readonly screenHeight = FAKE_HEIGHT;

  constructor() {
    const canvas = {
      tabIndex: -1,
      style: {} as Record<string, string>,
      focus: () => {
        this.focusCalls.push(1);
      },
      getBoundingClientRect: () => ({
        left: 10,
        top: 20,
        width: FAKE_WIDTH,
        height: FAKE_HEIGHT,
        right: 10 + FAKE_WIDTH,
        bottom: 20 + FAKE_HEIGHT,
        x: 10,
        y: 20,
        toJSON: () => ({}),
      }),
    };
    this.canvas = canvas as unknown as HTMLCanvasElement;
  }

  /** Calls of one method, in order. */
  of(method: string): SceneCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** The last call of one method, or undefined. */
  last(method: string): SceneCall | undefined {
    return this.of(method).at(-1);
  }

  /** The current value of a per-avatar setter (`setAvatarPose`, `setAvatarPosition`, …). */
  lastFor(method: string, id: string): unknown[] | undefined {
    return this.of(method)
      .filter((c) => c.args[0] === id)
      .at(-1)?.args;
  }

  clear(): void {
    this.calls.length = 0;
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  mount(_container: HTMLElement, host: SceneHost): Promise<void> {
    this.mounted++;
    this.host = host;
    this.record('mount');
    return Promise.resolve();
  }

  destroy(): void {
    this.destroyed++;
    this.host = null;
    this.record('destroy');
  }

  setRoom(room: Room): void {
    this.record('setRoom', room);
  }
  setGridVisible(visible: boolean): void {
    this.record('setGridVisible', visible);
  }
  setEditorMode(on: boolean): void {
    this.record('setEditorMode', on);
  }
  setGhost(ghost: Ghost | null): void {
    this.record('setGhost', ghost);
  }
  setHoverTile(tile: TilePoint | null): void {
    this.record('setHoverTile', tile);
  }
  setHighlightTile(tile: TilePoint | null): void {
    this.record('setHighlightTile', tile);
  }
  setHighlightFurniture(id: string | null): void {
    this.record('setHighlightFurniture', id);
  }
  setFurniturePreview(id: string, origin: TilePoint | null): void {
    this.record('setFurniturePreview', id, origin);
  }
  addAvatar(init: SceneAvatarInit): void {
    this.record('addAvatar', init);
  }
  removeAvatar(id: string): void {
    this.record('removeAvatar', id);
  }
  setAvatarName(id: string, name: string): void {
    this.record('setAvatarName', id, name);
  }
  setAvatarAppearance(id: string, avatar: Avatar, isIntern: boolean): void {
    this.record('setAvatarAppearance', id, avatar, isIntern);
  }
  setAvatarPose(id: string, pose: Pose): void {
    this.record('setAvatarPose', id, pose);
  }
  setAvatarFacing(id: string, facing: Facing): void {
    this.record('setAvatarFacing', id, facing);
  }
  setAvatarSeated(id: string, seated: boolean): void {
    this.record('setAvatarSeated', id, seated);
  }
  setAvatarPosition(id: string, x: number, y: number): void {
    this.record('setAvatarPosition', id, x, y);
  }
  setAvatarHighlighted(id: string, on: boolean): void {
    this.record('setAvatarHighlighted', id, on);
  }
  poofAvatar(id: string): void {
    this.record('poofAvatar', id);
  }
  isAvatarFinished(id: string): boolean {
    return this.finished.has(id);
  }
  showBubble(id: string, text: string, kind: BubbleKind, durationMs: number): void {
    this.record('showBubble', id, text, kind, durationMs);
  }
  hideBubble(id: string): void {
    this.record('hideBubble', id);
  }
  update(dtMs: number): void {
    this.record('update', dtMs);
  }
  pick(sx: number, sy: number): SceneHit {
    this.record('pick', sx, sy);
    return this.hit;
  }
}
