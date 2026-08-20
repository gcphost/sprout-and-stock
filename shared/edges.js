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
  // The same three ways through, with a rule about WHO. See WAYS below: these
  // are not new kinds of wall, they are the doorway you already built with a
  // sign on it, and the player is offered them as a property rather than as
  // four more palette buttons.
  /** A doorway shoppers do not use. Back-of-house. */
  DOOR_STAFF: 6,
  /** In only. A shopper may cross it into the shop, never out. */
  DOOR_IN: 7,
  /** Out only. */
  DOOR_OUT: 8,
  /** A gate shoppers do not use — how you keep the shop floor out of a field. */
  GATE_STAFF: 9,
  // ...and the same wall, glazed four ways. See GLAZING: these differ in nothing
  // but where the glass starts and stops, which is why they are looks rather than
  // kinds of wall — every one of them blocks you, encloses, and costs the same.
  /** Floor-to-lintel glass. A shopfront. */
  WINDOW_FULL: 10,
  /** Standard glazing that projects out over a sill. */
  WINDOW_BAY: 11,
  /** A strip up under the lintel: light, no view. What a stockroom gets. */
  WINDOW_HIGH: 12,
};

/**
 * A WAY THROUGH, and who it is for.
 *
 * The one table behind the whole feature, and the reason it cost four enum
 * values rather than a parallel `private` mask beside the two edge arrays: the
 * player is offered a *property* of the opening they already built, and the
 * representation stays one array lookup, because `SOLID.has(edgeBetween(...))`
 * is in the inner loop of A* and runs a few thousand times per path.
 *
 * `base` is what it is built out of — which decides enclosure, price and how it
 * draws. `rule` is who may cross:
 *
 *   all    everybody, which is what a doorway has always been
 *   staff  you and whoever works for you. A shopper treats it as a wall.
 *   in     a shopper may cross it into the shop, never back out
 *   out    the other way round
 *
 * There is deliberately no GATE_IN/GATE_OUT. Which way is "in" is read off the
 * enclosure rather than stored (see `shopperCanCross`), and a fence never
 * encloses — so a one-way gate would be a rung that changes no number, which
 * is the trap CLAUDE.md names about tiers. Staff-only needs no direction and so
 * a gate gets that one.
 */
export const WAYS = new Map([
  [E.DOOR, { base: 'door', rule: 'all' }],
  [E.DOOR_STAFF, { base: 'door', rule: 'staff' }],
  [E.DOOR_IN, { base: 'door', rule: 'in' }],
  [E.DOOR_OUT, { base: 'door', rule: 'out' }],
  [E.GATE, { base: 'gate', rule: 'all' }],
  [E.GATE_STAFF, { base: 'gate', rule: 'staff' }],
]);

/** Which rules each sort of opening can be given, in the order a menu lists them. */
export const WAY_RULES = {
  door: ['all', 'staff', 'in', 'out'],
  gate: ['all', 'staff'],
};

/** What sort of opening this is, or null for anything that isn't one. */
export const wayBase = (kind) => WAYS.get(kind)?.base ?? null;

/** Who may cross, or null for anything that isn't an opening. */
export const wayRule = (kind) => WAYS.get(kind)?.rule ?? null;

/** The kind that is this sort of opening with this rule on it. */
export function wayKind(base, rule) {
  for (const [kind, w] of WAYS) if (w.base === base && w.rule === rule) return kind;
  return null;
}

/**
 * A WALL WITH GLASS IN IT, and how much.
 *
 * `WAYS`'s sibling, and the distinction between the two is worth keeping: an
 * opening's kinds differ in *who may cross*, which is behaviour the sim reads,
 * while these differ in **where the glass starts and stops**, which nothing reads
 * but the renderer. Four looks of one thing.
 *
 * So they are priced identically and they are the codebase's own rule about
 * variants said about an edge: a look must never move a number, or restyling your
 * frontage is a balance change and `simulate` has to be re-run over a colour. That
 * also makes the swap between them free — see the refit in `buildEdge`.
 *
 * The day a window *does* something — daylight a lamp doesn't have to pay for,
 * charm, a shoplifter who can see the till — that is a number, and it belongs on
 * the piece it distinguishes rather than in here. Charm is the first of those to
 * arrive, and it landed on the FAMILY rather than on the four looks (see
 * `EDGE_CHARM`), which is this paragraph's rule holding rather than bending: a
 * bay window and a shopfront are worth the same, so reglazing is still free and
 * still never a balance change.
 */
export const GLAZING = new Map([
  [E.WINDOW, { base: 'window', look: 'standard' }],
  [E.WINDOW_FULL, { base: 'window', look: 'full' }],
  [E.WINDOW_BAY, { base: 'window', look: 'bay' }],
  [E.WINDOW_HIGH, { base: 'window', look: 'high' }],
]);

/** Which looks a window can be given, in the order a menu lists them. */
export const GLAZING_LOOKS = ['standard', 'full', 'bay', 'high'];

/**
 * HOW NICE AN EDGE MAKES THE SHOP — `charm` on a catalog row, said about the
 * wall rather than about a thing standing against it.
 *
 * Everything else that has ever moved charm is a *placement*, so the whole
 * shell of the building — walls, glass, doorways, the frontage — counted for
 * nothing, and a shop you had glazed end to end reached exactly as far across
 * town as a concrete box. Which is upside down: the frontage is the only part
 * of a shop somebody who has never been in has ever seen.
 *
 * Three decisions in one small table.
 *
 * **It is per family, not per look.** All four glazings are worth the same,
 * which is the note above holding rather than bending — a look must never move
 * a number, so a bay window is prettier than a shopfront to you and identical
 * to the town, and reglazing stays free.
 *
 * **A wall and a doorway are worth nothing**, deliberately. Charm is what a
 * shop has that it did not need, and every building in the game is made of
 * walls — paying for them would be paying everybody for existing, which moves
 * the whole curve and distinguishes nobody. Glass is the part you could have
 * left out.
 *
 * **Every glazed edge counts, wherever it is** — including a partition between
 * two rooms, which is a slightly generous answer chosen over an exactly right
 * one. The precise rule is "glass that looks outside", and that is a question
 * about the `indoor` mask: enclosure in this game is all-or-nothing, so the day
 * somebody takes a wall out, *every* window in the shop would stop earning at
 * once, footfall would drop, and nothing anywhere would say why. CLAUDE.md has
 * that trap twice already. A glass partition is a fair thing to be able to buy.
 *
 * 0.4 is under the going rate per dollar (a $35 planter is 1.5), and that is on
 * purpose: you would have built a wall along that run anyway, so what the charm
 * is priced against is the $14 the glass costs OVER a wall, not the $26.
 */
export const EDGE_CHARM = new Map([...GLAZING.keys()].map((k) => [k, 0.4]));

/**
 * What the whole shell is worth, walked once.
 *
 * Over both arrays rather than over a list of what somebody built, because
 * there is no such list — an edge is a number on a lattice line, which is the
 * same reason a doorway is the one thing you can point at that has no id.
 */
export function edgeCharm(L) {
  if (!L) return 0;
  let sum = 0;
  for (const arr of [L.edgesV, L.edgesH]) {
    for (let i = 0; i < (arr?.length ?? 0); i++) sum += EDGE_CHARM.get(arr[i]) ?? 0;
  }
  return sum;
}

export const glazingBase = (kind) => GLAZING.get(kind)?.base ?? null;
export const glazingLook = (kind) => GLAZING.get(kind)?.look ?? null;

export function glazingKind(look) {
  for (const [kind, g] of GLAZING) if (g.look === look) return kind;
  return null;
}

/**
 * What FAMILY an edge belongs to — the one question both tables answer.
 *
 * Two callers, and both of them are about the thing you already own: `buildEdge`
 * charges a **refit** rather than a swap within a family, because signing a door
 * or reglazing a window leaves you with the door and the wall; and the edge menu
 * offers exactly the kinds that share a family with the one under your pointer.
 * Anything with no family — a wall, a fence — has nothing to choose and no menu.
 */
export const edgeFamily = (kind) => wayBase(kind) ?? glazingBase(kind);

/** Edges you cannot walk through. */
export const SOLID = new Set([E.WALL, E.FENCE, ...GLAZING.keys()]);

/**
 * Edges that make an enclosure.
 *
 * A DOOR is in here and that is the whole trick: leave it out and the fill
 * walks straight in through the front door, every cell is reachable from the
 * map border, and the entire shop reports as outdoors. Every *doorway* is in
 * here for the same reason, sign or no sign: leave a staff doorway out and your
 * stockroom is a patio, every shelf in it is refused, and the refusal reads
 * "something is already there" — which sends you looking in the wrong place.
 *
 * A FENCE is deliberately absent, and so is every gate. Fencing a field must
 * never roof it.
 */
export const ENCLOSING = new Set([E.WALL,
  ...GLAZING.keys(),
  ...[...WAYS].filter(([, w]) => w.base === 'door').map(([kind]) => kind)]);

/**
 * Openings with a rule on them — the ones that are not a way through for
 * everybody.
 *
 * Named as a set because two callers want "is there anything to think about
 * here" rather than the answer to "who": the queue, which refuses to grow
 * through one at all, and the menu, which lights the row you are on.
 */
export const RULED = new Set([...WAYS].filter(([, w]) => w.rule !== 'all').map(([k]) => k));

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

/**
 * May a SHOPPER cross this boundary — the first rule in the game whose answer
 * depends on who is asking.
 *
 * Everything else here is a fact about the wall. This is a fact about the wall
 * and the person at it, which is why it is a function of the step rather than a
 * set: a one-way door is passable in one direction and a wall in the other, so
 * there is no set of kinds that could answer it.
 *
 * Which way is "in" is READ rather than stored, off the enclosure the walls
 * already make. That is what keeps the toggle to two more enum values instead of
 * a stored side per edge — and it is also the honest answer, because "in" means
 * indoors and nothing else in this game has ever meant anything else by it.
 *
 * The consequence is worth knowing: on a boundary whose two sides agree about
 * being indoors — an interior door between two rooms, a gate in a fence, any
 * opening at all once somebody takes enough wall out that `computeIndoor`
 * returns zero cells — a one-way rule has nothing to say and lets everybody
 * through. A shop with no inside has no in and no out, and refusing at that
 * point would seal every door in the world on the day a wall came down.
 */
export function shopperCanCross(L, x, z, nx, nz) {
  const kind = edgeBetween(L, x, z, nx, nz);
  if (SOLID.has(kind)) return false;
  const rule = WAYS.get(kind)?.rule;
  if (rule === undefined || rule === 'all') return true;
  if (rule === 'staff') return false;
  const mask = L.indoor;
  if (!mask) return true;
  const from = isIndoor(L, mask, x, z);
  const to = isIndoor(L, mask, nx, nz);
  // Not a way in or out of anywhere: no direction to be one-way about.
  if (from === to) return true;
  return rule === 'in' ? to : from;
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

/**
 * Every cell you could walk to from here, obeying tiles *and* edges.
 *
 * The question behind "would this wall seal my shop": build the set once from
 * the doorway and ask it about every working spot, rather than pathfinding to
 * each one in turn.
 *
 * `cross` is an extra test on the boundary, for the one caller that asks this
 * question about somebody in particular: "can a SHOPPER still get in" is not the
 * same flood as "is this cell walled off", and since step 15 those two answers
 * differ by exactly one signed doorway.
 */
export function reachable(L, sx, sz, standable = defaultStandable, cross = null) {
  const seen = new Set();
  const x0 = Math.round(sx);
  const z0 = Math.round(sz);
  const stack = [[x0, z0]];
  seen.add(`${x0},${z0}`);
  while (stack.length) {
    const [x, z] = stack.pop();
    for (const [dx, dz] of NEIGHBOURS) {
      const nx = x + dx;
      const nz = z + dz;
      const k = `${nx},${nz}`;
      if (seen.has(k)) continue;
      if (!canStep(L, x, z, nx, nz, standable)) continue;
      if (cross && !cross(L, x, z, nx, nz)) continue;
      seen.add(k);
      stack.push([nx, nz]);
    }
  }
  return seen;
}


/** A copy of `L` with one edge changed, for asking "what if". */
export function withEdge(L, { o, x, z }, kind) {
  const edgesV = Uint8Array.from(L.edgesV ?? []);
  const edgesH = Uint8Array.from(L.edgesH ?? []);
  if (o === 'v') edgesV[eviOf(L.w, x, z)] = kind;
  else edgesH[ehiOf(L.w, x, z)] = kind;
  return { ...L, edgesV, edgesH };
}

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
