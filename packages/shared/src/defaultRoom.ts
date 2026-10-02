import type { Furniture, Room } from './dto.js';

export const DEFAULT_ROOM_ID = 'lobby';

/** 14×10 starter office. Coordinates are tile x (left→right along the iso "east" axis) and y. */
export function defaultRoom(now = Date.now()): Room {
  const width = 14;
  const height = 10;
  const f = (
    id: string,
    kind: Furniture['kind'],
    x: number,
    y: number,
    rotation = 0,
    meta: Record<string, unknown> = {},
  ): Furniture => ({
    id,
    roomId: DEFAULT_ROOM_ID,
    kind,
    x,
    y,
    rotation,
    meta,
  });
  const furniture: Furniture[] = [
    f('door-1', 'door', 0, 9),
    f('desk-1', 'desk', 2, 1),
    f('desk-2', 'desk', 5, 1),
    f('desk-3', 'desk', 8, 1),
    f('desk-4', 'desk', 2, 4),
    f('desk-5', 'desk', 5, 4),
    f('desk-6', 'desk', 8, 4),
    f('bookshelf-1', 'bookshelf', 11, 0),
    f('rack-1', 'server_rack', 13, 2),
    f('rack-2', 'server_rack', 13, 3),
    f('library-1', 'library_pc', 11, 3),
    f('whiteboard-1', 'whiteboard', 0, 0),
    f('coffee-1', 'coffee_machine', 12, 7),
    f('sofa-1', 'sofa', 4, 8),
    f('plant-1', 'plant', 0, 3),
    f('plant-2', 'plant', 13, 9),
    f('plant-3', 'plant', 10, 8),
    f('rug-1', 'rug', 6, 7),
  ];
  const floor = new Array<number>(width * height).fill(0);
  for (let y = 7; y < 9; y++) for (let x = 6; x < 8; x++) floor[y * width + x] = 1;
  return {
    id: DEFAULT_ROOM_ID,
    name: 'Lobby office',
    width,
    height,
    floor,
    walls: new Array<number>(width + height).fill(0),
    furniture,
    updatedAt: now,
  };
}
