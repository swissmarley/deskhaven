import { describe, expect, it } from 'vitest';
import { defaultRoom } from '../src/defaultRoom.js';
import { RoomSchema } from '../src/dto.js';
import {
  FURNITURE_CATALOG,
  footprintTiles,
  interactionTiles,
  rotatedSize,
  rotateOffset,
} from '../src/furniture.js';
import { BUILTIN_PRESETS } from '../src/presets.js';
import { classifyTool, isDangerousTool, summarizeToolInput } from '../src/tools.js';

describe('furniture geometry', () => {
  it('rotates a 2x1 footprint', () => {
    expect(rotatedSize('desk', 0)).toEqual({ w: 2, h: 1 });
    expect(rotatedSize('desk', 1)).toEqual({ w: 1, h: 2 });
    expect(footprintTiles('desk', 3, 3, 0)).toEqual([
      { x: 3, y: 3 },
      { x: 4, y: 3 },
    ]);
    expect(footprintTiles('desk', 3, 3, 1)).toEqual([
      { x: 3, y: 3 },
      { x: 3, y: 4 },
    ]);
  });
  it('rotateOffset cycles back after four turns', () => {
    expect(rotateOffset(1, 0, 2, 1, 4)).toEqual({ dx: 1, dy: 0 });
  });
  it('desk seat is in front of the desk at rotation 0', () => {
    expect(interactionTiles('desk', 2, 1, 0)).toEqual([{ x: 2, y: 2, type: 'seat', facing: 0 }]);
  });
  it('interaction points stay adjacent to the footprint when rotated', () => {
    for (const rot of [0, 1, 2, 3]) {
      const tiles = footprintTiles('bookshelf', 5, 5, rot);
      for (const p of interactionTiles('bookshelf', 5, 5, rot)) {
        const adjacent = tiles.some((t) => Math.abs(t.x - p.x) + Math.abs(t.y - p.y) === 1);
        const inside = tiles.some((t) => t.x === p.x && t.y === p.y);
        expect(adjacent && !inside).toBe(true);
      }
    }
  });
});

describe('presets and default room', () => {
  it('ships the five roles plus manager, none with bypassPermissions', () => {
    expect(BUILTIN_PRESETS.map((p) => p.id).sort()).toEqual([
      'architect',
      'engineer',
      'manager',
      'qa',
      'researcher',
      'reviewer',
    ]);
    for (const p of BUILTIN_PRESETS) expect(p.permissionMode).not.toBe('bypassPermissions');
  });
  it('default room: interaction tiles are inside the room and not covered by another piece', () => {
    const room = defaultRoom(0);
    const owner = new Map<string, string>();
    for (const f of room.furniture) {
      if (!FURNITURE_CATALOG[f.kind].blocks) continue;
      for (const t of footprintTiles(f.kind, f.x, f.y, f.rotation))
        owner.set(`${t.x},${t.y}`, f.id);
    }
    for (const f of room.furniture) {
      for (const p of interactionTiles(f.kind, f.x, f.y, f.rotation)) {
        const inside = p.x >= 0 && p.y >= 0 && p.x < room.width && p.y < room.height;
        expect(inside, `${f.id} point outside the room`).toBe(true);
        const o = owner.get(`${p.x},${p.y}`);
        // a seat on the piece itself (sofa, chair, door) is fine; another piece covering it is not
        expect(o === undefined || o === f.id, `${f.id} tile ${p.x},${p.y} covered by ${o}`).toBe(
          true,
        );
      }
    }
  });
  it('default room validates and has six desks', () => {
    const room = RoomSchema.parse(defaultRoom(0));
    expect(room.furniture.filter((f) => f.kind === 'desk')).toHaveLength(6);
    expect(room.floor).toHaveLength(room.width * room.height);
  });
});

describe('tool classification', () => {
  it('classifies the Claude Code tool set', () => {
    expect(classifyTool('Read')).toBe('read');
    expect(classifyTool('Edit')).toBe('edit');
    expect(classifyTool('Bash')).toBe('bash');
    expect(classifyTool('WebFetch')).toBe('web');
    expect(classifyTool('Task')).toBe('subagent');
    expect(classifyTool('mcp__deskhaven__create_task')).toBe('mcp');
    expect(classifyTool('Something')).toBe('other');
    expect(isDangerousTool('Bash')).toBe(true);
    expect(isDangerousTool('Read')).toBe(false);
  });
  it('summarises inputs without throwing on garbage', () => {
    expect(summarizeToolInput('Bash', { command: 'ls' })).toBe('ls');
    expect(summarizeToolInput('Read', null)).toBe('Read');
    expect(summarizeToolInput('Edit', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
  });
});
