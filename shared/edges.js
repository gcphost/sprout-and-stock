/**
 * THE EDGE VOCABULARY — walls that live *between* cells, not on them.
 *
 * A tile answers "what is this square made of". An edge answers "can you get
 * from this square to that one", which is a different question and was never
 * expressible before: a wall filled a whole tile, so a 3x3 room cost a 5x5
 * footprint and ate a tile of shopping floor on every side.
 *
 * Two arrays, because an edge is either vertical (running north-south,
 * separating west from east) or horizontal (running east-west):
 *
 *   edgesV[z * (w + 1) + x]   the WEST face of cell (x, z)   — (w+1) x h of them
 *   edgesH[z * w + x]         the NORTH face of cell (x, z)  — w x (h+1) of them
 *
 * So the edge between (x,z) and (x+1,z) is `edgesV` at x+1, and the edge
 * between (x,z) and (x,z+1) is `edgesH` at z+1. Off-grid indices read as NONE
 * rather than throwing, because the flood fills below walk off the map by
 * design and a bounds check at every step is noise.
 *
 * Lives in `shared/` for the same reason `tiles.js` does: the generator writes
 * these, the build validator reads them, the renderer draws them, and the sim
 * paths through them. One definition or four subtly different ones.
 *
 * See docs/building.md.
 */

import { T, WALKABLE } from './tiles.js';

export const E = {
  NONE: 0,
  WALL: 1,
  /** Blocks you, but you can see through it — and it lets daylight in. */
  WINDOW: 2,
  /** A way through a wall. Passable, but still part of the enclosure. */
  DOOR: 3,
  /** A way through a fence. */
  GATE: 4,
  /** Marks a boundary without ever making a room. See ENCLOSING. */
  FENCE: 5,
};

/** Edges you cannot walk through. */
export const SOLID = new Set([E.WALL, E.WINDOW, E.FENCE]);

/**
 * Edges that make an enclosure.
 *
 * A DOOR is in here and that is the whole trick: leave it out and the fill
 * walks straight in through the front door, every cell is reachable from the
 * map border, and the entire shop reports as outdoors.
 *
 * A FENCE is deliberately absent. Fencing a field must never roof it.
 */
export const ENCLOSING = new Set([E.WALL, E.WINDOW, E.DOOR]);

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

export const eviOf = (w, x, z) => z * (w + 1) + x;
export const ehiOf = (w, x, z) => z * w + x;

/** The edge on the west face of (x,z). Off-grid reads as NONE. */
export function edgeW(L, x, z) {
  if (x < 0 || x > L.w || z < 0 || z >= L.h) return E.NONE;
  return L.edgesV?.[eviOf(L.w, x, z)] ?? E.NONE;
}

/** The edge on the north face of (x,z). Off-grid reads as NONE. */
export function edgeN(L, x, z) {
  if (x < 0 || x >= L.w || z < 0 || z > L.h) return E.NONE;
  return L.edgesH?.[ehiOf(L.w, x, z)] ?? E.NONE;
}

/**
 * The edge between two orthogonally adjacent cells, in either direction.
 * Returns NONE for cells that aren't neighbours, which is the honest answer to
 * "what is between them" and keeps callers from having to pre-check.
 */
export function edgeBetween(L, x, z, nx, nz) {
  const dx = nx - x;
  const dz = nz - z;
  if (dx === 1 && dz === 0) return edgeW(L, nx, z);
  if (dx === -1 && dz === 0) return edgeW(L, x, z);
  if (dz === 1 && dx === 0) return edgeN(L, x, nz);
  if (dz === -1 && dx === 0) return edgeN(L, x, z);
  return E.NONE;
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

/**
 * May something step from (x,z) to the adjacent (nx,nz)?
 *
 * Both halves matter and neither implies the other: the destination has to be
 * standable ground, *and* nothing solid may sit on the boundary crossed to
 * reach it. Pathing is strictly 4-way (`NEIGHBOURS` in sim/pathing.js), which
 * is the reason this can stay a single lookup — with diagonals you would also
 * have to stop actors squeezing through the corner where two walls meet.
 */
export function canStep(L, x, z, nx, nz, standable = defaultStandable) {
  if (!standable(L, nx, nz)) return false;
  return !SOLID.has(edgeBetween(L, x, z, nx, nz));
}

const tileOf = (L, x, z) =>
  (x < 0 || z < 0 || x >= L.w || z >= L.h ? -1 : L.tiles[z * L.w + x]);

const defaultStandable = (L, x, z) => WALKABLE.has(tileOf(L, x, z));

// ---------------------------------------------------------------------------
// Enclosure
// ---------------------------------------------------------------------------

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Which cells the walls close in — the replacement for `insideStore`.
 *
 * Floods inward from every map-border cell, refusing to cross an ENCLOSING
 * edge. Whatever the flood cannot reach is enclosed. That is the whole of it,
 * and it is why an L-shaped shop, a lean-to annex and a free-standing
 * greenhouse all work without any of them being a case in the code: "indoor"
 * stops meaning *the building* and starts meaning *anything walls close in*.
 *
 * Note this ignores tiles entirely. A cell is enclosed because of what is
 * around it, not what it is made of, so a patch of grass you wall in is indoors
 * and a floor you never enclosed is a patio.
 *
 * @returns {Uint8Array} 1 where enclosed, 0 where open to the sky.
 */
export function computeIndoor(L) {
  const { w, h } = L;
  const outside = new Uint8Array(w * h);
  const stack = [];

  const visit = (x, z) => {
    if (x < 0 || z < 0 || x >= w || z >= h) return;
    const i = z * w + x;
    if (outside[i]) return;
    outside[i] = 1;
    stack.push(x, z);
  };

  for (let x = 0; x < w; x++) { visit(x, 0); visit(x, h - 1); }
  for (let z = 0; z < h; z++) { visit(0, z); visit(w - 1, z); }

  while (stack.length) {
    const z = stack.pop();
    const x = stack.pop();
    for (const [dx, dz] of NEIGHBOURS) {
      if (ENCLOSING.has(edgeBetween(L, x, z, x + dx, z + dz))) continue;
      visit(x + dx, z + dz);
    }
  }

  const indoor = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) indoor[i] = outside[i] ? 0 : 1;
  return indoor;
}

export const isIndoor = (L, mask, x, z) =>
  (x < 0 || z < 0 || x >= L.w || z >= L.h ? false : mask[z * L.w + x] === 1);

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/** Wall-ring tile kinds, and what each becomes once it is an edge instead. */
const TILE_TO_EDGE = new Map([
  [T.WALL, E.WALL],
  [T.DOOR, E.DOOR],
  [T.FENCE, E.FENCE],
]);

/**
 * Read a layout whose walls are tiles and write the equivalent loop of edges.
 *
 * The subtlety: a wall ring is a tile thick, so it has an inner face and an
 * outer one. Walking every adjacent pair and edging wherever exactly one side
 * is a wall would draw *two* parallel loops and leave a dead ring of cells
 * sealed between them. So the loop is derived from the enclosed side only —
 * for each cell that the old geometry called inside, edge it off from any
 * neighbour that isn't. One closed loop, in the right place.
 *
 * @param {object} L        a layout with `tiles`, `w`, `h`
 * @param {function} inside (x,z) => is this cell within the old wall ring
 */
export function deriveEdges(L, inside) {
  const { w, h } = L;
  const edgesV = new Uint8Array((w + 1) * h);
  const edgesH = new Uint8Array(w * (h + 1));

  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x, z)) continue;
      for (const [dx, dz] of NEIGHBOURS) {
        const nx = x + dx;
        const nz = z + dz;
        if (inside(nx, nz)) continue;
        // A doorway keeps its own kind; anything else backing onto the
        // interior is wall, including the outside world at the map edge.
        const kind = TILE_TO_EDGE.get(tileOf(L, nx, nz)) ?? E.WALL;
        if (dx === 1) edgesV[eviOf(w, nx, z)] = kind;
        else if (dx === -1) edgesV[eviOf(w, x, z)] = kind;
        else if (dz === 1) edgesH[ehiOf(w, x, nz)] = kind;
        else edgesH[ehiOf(w, x, z)] = kind;
      }
    }
  }

  return { edgesV, edgesH };
}
