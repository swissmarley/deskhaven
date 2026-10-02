import { DIRS8, type Grid, inBounds, isWalkable } from './grid.js';
import { octile } from './iso.js';
import type { TilePoint } from './types.js';

/**
 * A* over the walkability grid: 8 directions, diagonal cost √2, octile heuristic, no corner
 * cutting. Returns the tiles to visit excluding `start`; `[]` when already there; `null` when
 * unreachable. A blocked goal (e.g. clicking a desk) is replaced by its nearest walkable
 * 8-neighbour, whichever the search reaches first.
 */
export function findPath(grid: Grid, start: TilePoint, goal: TilePoint): TilePoint[] | null {
  if (!inBounds(grid, start.x, start.y) || !inBounds(grid, goal.x, goal.y)) return null;
  if (start.x === goal.x && start.y === goal.y) return [];
  const { width, height } = grid;
  const n = width * height;
  const idx = (x: number, y: number): number => y * width + x;

  const goals = new Set<number>();
  let adjacentMode = false;
  if (isWalkable(grid, goal.x, goal.y)) {
    goals.add(idx(goal.x, goal.y));
  } else {
    adjacentMode = true;
    for (const [dx, dy] of DIRS8) {
      const gx = goal.x + dx;
      const gy = goal.y + dy;
      if (isWalkable(grid, gx, gy)) goals.add(idx(gx, gy));
    }
    if (goals.size === 0) return null;
    if (goals.has(idx(start.x, start.y))) return [];
  }

  // Heuristic to the (possibly blocked) goal; in adjacent mode allow one diagonal of slack so it
  // stays admissible for the neighbouring targets.
  const h = (x: number, y: number): number => {
    const d = octile(x, y, goal.x, goal.y);
    return adjacentMode ? Math.max(0, d - Math.SQRT2) : d;
  };

  const g = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const parent = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();

  const s = idx(start.x, start.y);
  g[s] = 0;
  heap.push(s, h(start.x, start.y));

  while (heap.size > 0) {
    const cur = heap.pop();
    if (closed[cur] === 1) continue;
    closed[cur] = 1;
    if (goals.has(cur)) return reconstruct(parent, cur, s, width);
    const cx = cur % width;
    const cy = (cur - cx) / width;
    const gc = g[cur] ?? Number.POSITIVE_INFINITY;
    for (const [dx, dy] of DIRS8) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!isWalkable(grid, nx, ny)) continue;
      const diagonal = dx !== 0 && dy !== 0;
      if (diagonal && (!isWalkable(grid, cx + dx, cy) || !isWalkable(grid, cx, cy + dy))) continue;
      const ni = idx(nx, ny);
      if (closed[ni] === 1) continue;
      const ng = gc + (diagonal ? Math.SQRT2 : 1);
      if (ng < (g[ni] ?? Number.POSITIVE_INFINITY)) {
        g[ni] = ng;
        parent[ni] = cur;
        heap.push(ni, ng + h(nx, ny));
      }
    }
  }
  return null;
}

function reconstruct(parent: Int32Array, end: number, start: number, width: number): TilePoint[] {
  const out: TilePoint[] = [];
  let cur = end;
  while (cur !== start && cur >= 0) {
    const x = cur % width;
    out.push({ x, y: (cur - x) / width });
    cur = parent[cur] ?? -1;
  }
  out.reverse();
  return out;
}

/** Binary min-heap of node indices keyed by f-score (parallel arrays, no per-node objects). */
class MinHeap {
  private readonly ids: number[] = [];
  private readonly keys: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, key: number): void {
    this.ids.push(id);
    this.keys.push(key);
    let i = this.ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((this.keys[p] ?? 0) <= (this.keys[i] ?? 0)) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.ids[0] ?? -1;
    const lastId = this.ids.pop();
    const lastKey = this.keys.pop();
    if (this.ids.length > 0 && lastId !== undefined && lastKey !== undefined) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      let i = 0;
      const n = this.ids.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < n && (this.keys[l] ?? 0) < (this.keys[m] ?? 0)) m = l;
        if (r < n && (this.keys[r] ?? 0) < (this.keys[m] ?? 0)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const ia = this.ids[a];
    const ib = this.ids[b];
    const ka = this.keys[a];
    const kb = this.keys[b];
    if (ia === undefined || ib === undefined || ka === undefined || kb === undefined) return;
    this.ids[a] = ib;
    this.ids[b] = ia;
    this.keys[a] = kb;
    this.keys[b] = ka;
  }
}
