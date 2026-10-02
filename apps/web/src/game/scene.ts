import type { Avatar, Facing, Room } from '@agenthotel/shared';
import type { CameraView } from './camera.js';
import type { Pose } from './pose.js';
import type { BubbleKind, Ghost, TilePoint } from './types.js';

export type { CameraView } from './camera.js';

/**
 * The renderer port driven by `WorldCore`. A scene owns everything that touches a graphics
 * library (canvas, sprites, meshes, bubbles) and nothing that decides *what* happens: tiles,
 * paths, stations, behaviours, the editor state machine and input classification live in the
 * core. `PixiScene` and `ThreeScene` implement it; `FakeScene` records it in tests.
 */

/** What the pointer is over, as resolved by the backend's own hit testing. Tiles are the core's job. */
export type SceneHit = { kind: 'avatar'; id: string } | { kind: 'furniture'; id: string } | null;

/** Callbacks a mounted scene drives from its own frame loop and resize handling. */
export interface SceneHost {
  /** One animation frame; `dtMs` is the unclamped time since the previous frame. */
  onFrame(dtMs: number): void;
  /** The canvas changed size (CSS pixels). */
  onResize(width: number, height: number): void;
}

export interface SceneAvatarInit {
  id: string;
  name: string;
  avatar: Avatar;
  isIntern: boolean;
}

export interface Scene {
  /** Creates the canvas inside `container` and loads assets. Resolves when the first frame can render. */
  mount(container: HTMLElement, host: SceneHost): Promise<void>;
  /** Tears everything down. Called at most once, after `mount`; the core creates a fresh scene per mount. */
  destroy(): void;

  /** Valid between `mount` and `destroy`. The core only needs `getBoundingClientRect`, `focus`, `tabIndex`, `style`. */
  readonly canvas: HTMLCanvasElement;
  readonly cameraView: CameraView;
  /** Canvas size in CSS pixels, for `Camera.setScreen` right after mount. */
  readonly screenWidth: number;
  readonly screenHeight: number;

  setRoom(room: Room): void;
  setGridVisible(visible: boolean): void;
  /** Editor mode affordances only (e.g. a grab cursor on furniture); the core owns the behaviour. */
  setEditorMode(on: boolean): void;
  setGhost(ghost: Ghost | null): void;
  setHoverTile(tile: TilePoint | null): void;
  setHighlightTile(tile: TilePoint | null): void;
  setHighlightFurniture(id: string | null): void;
  /**
   * Furniture drag preview: a non-null origin shows the piece dimmed there; null shows it undimmed,
   * snapped back to its real origin. No-op when the id is unknown.
   */
  setFurniturePreview(id: string, origin: TilePoint | null): void;

  addAvatar(init: SceneAvatarInit): void;
  removeAvatar(id: string): void;
  setAvatarName(id: string, name: string): void;
  setAvatarAppearance(id: string, avatar: Avatar, isIntern: boolean): void;
  setAvatarPose(id: string, pose: Pose): void;
  setAvatarFacing(id: string, facing: Facing): void;
  setAvatarSeated(id: string, seated: boolean): void;
  /** Fractional tile coordinates; the scene derives the screen position and draw order. */
  setAvatarPosition(id: string, x: number, y: number): void;
  setAvatarHighlighted(id: string, on: boolean): void;
  /** Brief puff of particles around the avatar (interns appearing / vanishing). */
  poofAvatar(id: string): void;
  /** True once the avatar's leave fade has completed and it can be removed. */
  isAvatarFinished(id: string): boolean;

  showBubble(id: string, text: string, kind: BubbleKind, durationMs: number): void;
  hideBubble(id: string): void;

  /** Advance sprite and bubble animations by one frame (also re-anchors bubbles). */
  update(dtMs: number): void;
  /** Hit test at canvas-local pixels: avatars over furniture, null for the floor or nothing. */
  pick(sx: number, sy: number): SceneHit;
}

export type SceneFactory = () => Promise<Scene>;
