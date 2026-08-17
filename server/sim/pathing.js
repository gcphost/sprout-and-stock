/**
 * Grid pathfinding (A*).
 *
 * Shops are full of shelves, so customers genuinely need to route around
 * things — walking straight at a target looks broken the moment there's an
 * aisle in the way. This is plain A* on the tile grid with 4-way movement,
 * which is plenty for a world this size and keeps paths looking tidy rather
 * than diagonal-shuffly.
 *
 * Paths are computed once when a customer picks a destination, then followed
 * over many ticks — not recomputed per frame.
 */

import { isWalkable } from '../layout.js';
import { SOLID, edgeBetween } from '../../shared/edges.js';
import { T } from '../../shared/tiles.js';

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * What one step costs, and the whole of "people use the pavement if there is
 * one".
 *
 * The road's design said about feet, and the two numbers are the same bargain:
 * a pavement is never *cheaper* than an ordinary step, everything else outdoors
 * is dearer. That direction is not a style choice — `h` below is Manhattan
 * distance, which is only admissible while no step costs less than 1, and a
 * discount on pavement would quietly turn A* into something that returns a
 * route rather than the shortest one.
 *
 * **The penalty is outdoors only**, and that is the half worth keeping. Nothing
 * indoors is ever a pavement, so a uniform surcharge in a shop would change
 * every gScore, leave every ordering identical, and cost real time — a weaker
 * heuristic expands more nodes, and in-shop pathing is the hot loop in this
 * game. Indoors every step is 1 and the search is bit-identical to the one that
 * was here before. The sentence it comes to is also the true one: *inside a
 * shop, the floor is the path.*
 *
 * 1.25 is a quarter further round, which is far enough to take a pavement laid
 * roughly the right way and near enough that nobody walks the long way round the
 * building to use one. It is not a speed: what a step costs the SEARCH and what
 * it costs the walker are different questions, and nobody moves faster on paving.
 */
const PAVED = 1;
const ROUGH = 1.25;
const stepCost = (layout, x, z) => {
  const i = z * layout.w + x;
  if (layout.indoor?.[i]) return PAVED;
  return layout.tiles[i] === T.PATH ? PAVED : ROUGH;
};

/**
 * @returns {Array<{x:number,z:number}>|null} tile path excluding the start
 *   tile, or null if unreachable.
 */
export function findPath(grid, layout, start, goal, { maxNodes = 4000 } = {}) {
  const sx = Math.round(start.x);
  const sz = Math.round(start.z);
  const gx = Math.round(goal.x);
  const gz = Math.round(goal.z);

  if (sx === gx && sz === gz) return [];

  // If the goal itself is blocked (a shelf tile), aim for the nearest walkable
  // neighbour instead. Callers usually pass a `browseAt`, but this keeps things
  // robust when they don't.
  let tx = gx;
  let tz = gz;
  if (!isWalkable(grid, layout, tx, tz)) {
    const alt = NEIGHBOURS
      .map(([dx, dz]) => ({ x: gx + dx, z: gz + dz }))
      .find((p) => isWalkable(grid, layout, p.x, p.z));
    if (!alt) return null;
    tx = alt.x;
    tz = alt.z;
  }

  const w = layout.w;
  const key = (x, z) => z * w + x;
  const goalKey = key(tx, tz);

  const open = new MinHeap();
  const gScore = new Map();
  const cameFrom = new Map();

  const h = (x, z) => Math.abs(x - tx) + Math.abs(z - tz);

  const startKey = key(sx, sz);
  gScore.set(startKey, 0);
  open.push(startKey, h(sx, sz));

  let expanded = 0;

  while (open.size > 0) {
    const current = open.pop();
    if (current === goalKey) return reconstruct(cameFrom, current, w);
    if (++expanded > maxNodes) break;

    const cx = current % w;
    const cz = (current - cx) / w;
    const cg = gScore.get(current);

    for (const [dx, dz] of NEIGHBOURS) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (!isWalkable(grid, layout, nx, nz)) continue;
      // A walkable tile you cannot get to is not a step. Walls live on the
      // boundary between cells, so the crossing has to be checked separately
      // from the destination — see shared/edges.js.
      if (SOLID.has(edgeBetween(layout, cx, cz, nx, nz))) continue;

      const nk = key(nx, nz);
      // Charged on the cell you step ONTO, so the pavement you are walking
      // along is what is being paid for rather than the one you left.
      const tentative = cg + stepCost(layout, nx, nz);
      if (tentative < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, tentative);
        cameFrom.set(nk, current);
        open.push(nk, tentative + h(nx, nz));
      }
    }
  }

  return null;
}

function reconstruct(cameFrom, endKey, w) {
  const path = [];
  let cur = endKey;
  while (cur !== undefined) {
    const x = cur % w;
    const z = (cur - x) / w;
    path.push({ x, z });
    cur = cameFrom.get(cur);
  }
  path.pop(); // drop the start tile — we're already standing on it
  return path.reverse();
}

/** Binary heap keyed by priority. Small and allocation-light. */
class MinHeap {
  constructor() {
    this.items = [];
    this.prio = [];
  }

  get size() { return this.items.length; }

  push(item, priority) {
    this.items.push(item);
    this.prio.push(priority);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.prio[p] <= this.prio[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop() {
    const top = this.items[0];
    const lastItem = this.items.pop();
    const lastPrio = this.prio.pop();
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.prio[0] = lastPrio;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < this.items.length && this.prio[l] < this.prio[best]) best = l;
        if (r < this.items.length && this.prio[r] < this.prio[best]) best = r;
        if (best === i) break;
        this.swap(i, best);
        i = best;
      }
    }
    return top;
  }

  swap(a, b) {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.prio[a], this.prio[b]] = [this.prio[b], this.prio[a]];
  }
}

/**
 * Advance a mover along its path. Mutates `entity.x/z/path`.
 * @returns true when the path is finished.
 */
export function followPath(entity, speed, dt) {
  if (!entity.path || entity.path.length === 0) return true;

  let budget = speed * dt;
  while (budget > 0 && entity.path.length > 0) {
    const next = entity.path[0];
    const dx = next.x - entity.x;
    const dz = next.z - entity.z;
    const dist = Math.hypot(dx, dz);

    if (dist <= budget) {
      entity.x = next.x;
      entity.z = next.z;
      entity.path.shift();
      budget -= dist;
    } else {
      entity.x += (dx / dist) * budget;
      entity.z += (dz / dist) * budget;
      // Face the direction of travel so the sprite doesn't moonwalk.
      entity.facing = Math.atan2(dx, dz);
      budget = 0;
    }
  }
  return entity.path.length === 0;
}
