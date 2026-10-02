import type { Avatar, Behavior, Room } from '@agenthotel/shared';

/**
 * Contract between the UI (React, Zustand) and the PixiJS world. The UI never touches Pixi objects;
 * it calls these methods and receives clicks through `WorldEvents`.
 */

export interface TilePoint {
  x: number;
  y: number;
}

export interface WorldAvatarInput {
  id: string;
  name: string;
  avatar: Avatar;
  /** Furniture id of the desk this avatar owns, or null. */
  deskId: string | null;
  /** Interns are temporary subagent avatars: smaller, enter from the door, leave when removed. */
  isIntern?: boolean;
  /** For interns: the agent that spawned them (they stand near its desk). */
  parentId?: string;
}

export interface WorldEvents {
  onTileClick?: (tile: TilePoint) => void;
  onAvatarClick?: (avatarId: string) => void;
  onFurnitureClick?: (furnitureId: string) => void;
}

export type BubbleKind = 'speech' | 'thought' | 'alert' | 'code';

export interface World {
  /** Creates the Pixi application inside `container`. Resolves when the first frame can render. */
  mount(container: HTMLElement): Promise<void>;
  destroy(): void;

  /** Replace the room (tiles, walls, furniture). Avatars re-path to valid tiles. */
  setRoom(room: Room): void;
  upsertAvatar(input: WorldAvatarInput): void;
  /** Avatar walks to the door and disappears. */
  removeAvatar(id: string): void;

  /** The behaviour system: resolves the station from `stationForBehavior`, walks there, plays the pose. */
  applyBehavior(avatarId: string, behavior: Behavior): void;
  /** Direct walk (click-to-walk, debugging). Interrupts the current path. */
  walkTo(avatarId: string, tile: TilePoint): void;
  /** Show a truncated bubble above the avatar for a while. */
  say(avatarId: string, text: string, opts?: { durationMs?: number; kind?: BubbleKind }): void;

  setEvents(events: WorldEvents): void;
  /** Avatar standing on or seated at a tile, if any (used for drag-and-drop onto avatars). */
  getAvatarAt(tile: TilePoint): string | null;
  /** Convert a pointer position (client coordinates) to a tile; null when outside the room. */
  screenToTile(clientX: number, clientY: number): TilePoint | null;
  /** Highlight a tile/avatar (hover feedback for drag-and-drop). Pass null to clear. */
  setHighlight(target: { tile?: TilePoint; avatarId?: string } | null): void;
}
