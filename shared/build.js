/**
 * BUILD RULES — where a fixture is allowed to go.
 *
 * Shared on purpose. The client needs this to colour the ghost red or green
 * sixty times a second, and the server needs it to be the authority on what
 * actually lands. If those two ever disagree the ghost lies to you, so there is
 * exactly one copy of the rules and both sides import it.
 *
 * Everything here is a pure function of `layout` + a placement spec. No content,
 * no game state, no money — those live on the server side of the fence.
 */

import { T, WALKABLE, BUILDABLE_INDOOR, BUILDABLE_OUTDOOR } from './tiles.js';
import { E, SOLID, edgeBetween, reachable, withEdge } from './edges.js';

/**
 * What each buildable thing is. `anchor` is the tile you have to be able to
 * stand on to use it — a shelf you can't reach is scenery.
 *
 * This is the closed set, and it is closed on purpose: a kind is a set of
 * placement rules, which is behaviour, and behaviour lives in a file that can be
 * reviewed and diffed. What is *not* closed is how many designs name into one —
 * see `shared/pieces.js`. Kinds are code; pieces are content, and unlimited.
 *
 * `tile` is the whole difference between the two halves below. A fixture stamps
 * a tile, so it occupies the cell and pathing has to route round it. A prop
 * stamps nothing: it sits in the cell without owning it, which is why a rug, a
 * planter or a hanging lamp needs no tile kind of its own and cannot break a
 * shop that was walkable before you decorated it.
 */
export const FIXTURES = {
  shelf: { label: 'Shelf', tile: T.SHELF, where: 'indoor', rotates: true, anchor: 'browseAt' },
  freezer: { label: 'Freezer', tile: T.FREEZER, where: 'indoor', rotates: true, anchor: 'browseAt' },
  checkout: { label: 'Till', tile: T.CHECKOUT, where: 'indoor', rotates: true, anchor: 'serveAt' },
  station: { label: 'Appliance', tile: T.STATION, where: 'indoor', rotates: true, anchor: 'useAt' },
  plot: { label: 'Plot', tile: T.PLOT, where: 'outdoor', rotates: false, anchor: null },
  /**
   * Decorations. Both stand in a cell and neither blocks it.
   *
   * Deliberately NOT the authored-`blocks` kind the design doc describes. A
   * barrel that stops nobody is a lie you can see; a barrel that stops people
   * needs a tile stamp, and a tile can only say one thing at a time — which is
   * the whole reason step 5 exists. Until a cell can hold a list, "prop" means
   * "you walk past it", and that is true of everything below.
   */
  'prop-floor': { label: 'Decoration', tile: null, where: 'any', rotates: true, anchor: null, at: 'floor' },
  'prop-ceiling': { label: 'Hanging', tile: null, where: 'indoor', rotates: true, anchor: null, at: 'ceiling' },
};

/** Every kind a piece may name. The closed vocabulary, in one place. */
export const BUILD_KINDS = Object.keys(FIXTURES);

/** The kinds that occupy their cell — the ones the generator has a budget for. */
export const FIXTURE_KINDS = BUILD_KINDS.filter((k) => FIXTURES[k].tile != null);

/** ...and the ones that just stand there. */
export const PROP_KINDS = BUILD_KINDS.filter((k) => FIXTURES[k].tile == null);

export const isProp = (kind) => FIXTURES[kind]?.tile == null;


/**
 * Fraction of what a fixture cost that you get back for tearing it out.
 *
 * Shared for the same reason `canPlace` is: the fixture menu prints the refund
 * on the button *before* you press it, and the server is what actually pays it.
 * Two copies of that number is two different amounts of money.
 */
export const FIXTURE_REFUND = 0.5;

/** Quarter turns, clockwise from "anchor to the east" — which is how the
 *  procedural generator has always laid shelves out. */
const FACING = [
  { dx: 1, dz: 0 },
  { dx: 0, dz: 1 },
  { dx: -1, dz: 0 },
  { dx: 0, dz: -1 },
];

export const rot4 = (rot) => ((Math.round(rot) % 4) + 4) % 4;

/** The tile a worker or shopper stands on to use a fixture placed like this. */
export function anchorTile(x, z, rot) {
  const f = FACING[rot4(rot)];
  return { x: x + f.dx, z: z + f.dz };
}

/**
 * A step in model space, turned to face the way a fixture was actually stood.
 *
 * Models are authored facing east — rot 0 — so "the +z end of this unit" is
 * only a direction in the world once you know which way round it is. One
 * quarter turn takes +x to +z, which is the order `FACING` is indexed in.
 */
export function turn({ dx, dz }, rot) {
  let s = { dx, dz };
  for (let i = rot4(rot); i > 0; i--) s = { dx: -s.dz, dz: s.dx };
  return s;
}

/** For a till, the direction the queue trails off in: along the wall it faces. */
export function queueAxis(rot) {
  // Perpendicular to the serving direction, so the line forms beside the till
  // rather than stacking on top of the person being served.
  return rot4(rot) % 2 === 0
    ? [{ x: 0, z: 1 }, { x: 0, z: -1 }]
    : [{ x: 1, z: 0 }, { x: -1, z: 0 }];
}

// ---------------------------------------------------------------------------
// Reading a layout
// ---------------------------------------------------------------------------

export const tileAt = (L, x, z) =>
  (x < 0 || z < 0 || x >= L.w || z >= L.h ? -1 : L.tiles[z * L.w + x]);

export const isWalkableTile = (L, x, z) => WALKABLE.has(tileAt(L, x, z));

/**
 * Is this cell indoors?
 *
 * Not "within the store rectangle" any more — within *anything the walls close
 * in*. The layout carries an `indoor` mask flooded from the map border through
 * the edges (`computeIndoor`, shared/edges.js), so an L-shaped shop, a lean-to
 * annex, a barn across the yard and a glasshouse in the middle of the field are
 * all indoors, and none of them is a case anybody had to write.
 *
 * Two consequences worth knowing, because they are rules now rather than
 * accidents. Floor you never enclosed is a patio — outdoors, so no shelf may go
 * on it. And a patch of grass you wall in is indoors, so no plot may be dug
 * there. Both fall out of asking the walls instead of asking the rect.
 *
 * The name is kept deliberately: it has call sites on both sides of the wire
 * and in two verify sweeps, and renaming it buys nothing a comment can't say.
 * The rect fallback is for a layout built before masks existed — the generator
 * has emitted one since edges landed.
 */
export function insideStore(L, x, z) {
  if (x < 0 || z < 0 || x >= L.w || z >= L.h) return false;
  if (L.indoor) return L.indoor[z * L.w + x] === 1;
  const s = L.store;
  return x >= s.x && x < s.x + s.w && z >= s.z && z < s.z + s.h;
}

/** How far a queue can run from `from` in `dir` before it leaves the shop. */
export function openRun(L, from, dir, max = 8, blocked = () => false) {
  let n = 0;
  for (let i = 1; i <= max; i++) {
    const x = from.x + dir.x * i;
    const z = from.z + dir.z * i;
    // A queue may not run through a wall, so the boundary crossed to reach each
    // successive tile counts as much as the tile itself.
    const prev = { x: x - dir.x, z: z - dir.z };
    if (SOLID.has(edgeBetween(L, prev.x, prev.z, x, z))) break;
    if (!insideStore(L, x, z) || !isWalkableTile(L, x, z) || blocked(x, z)) break;
    n++;
  }
  return n;
}

/**
 * May a wall, window or doorway go on this line?
 *
 * Same two answers as `canPlace`, and the same reasoning: off the map is
 * physics, but sealing your own shop is a *move*. You are allowed to wall off
 * the aisle, brick up the front door, or box a till into a cupboard — the game
 * says what it will cost and lets you, because a builder that refuses strange
 * buildings is a level editor with opinions.
 *
 * @param {object} spec { o: 'v'|'h', x, z, kind }
 */
export function canPlaceEdge(L, spec) {
  return canPlaceEdges(L, [spec], spec.kind ?? E.WALL);
}

/** Where a wall run from `start` to the far index `to` lays its segments. */
export function edgeRun(start, to, max = 40) {
  const o = start.o === 'v' ? 'v' : 'h';
  const x = Math.round(start.x);
  const z = Math.round(start.z);
  const end = to == null ? (o === 'v' ? z : x) : Math.round(to);
  const from = o === 'v' ? z : x;
  const lo = Math.min(from, end);
  const hi = Math.min(Math.max(from, end), lo + max - 1);
  const out = [];
  // A run follows the line it started on: a horizontal segment lies along x, a
  // vertical one along z. Turning a corner is a second drag, which is both
  // simpler to reason about and what a drawn wall actually wants.
  for (let i = lo; i <= hi; i++) out.push(o === 'v' ? { o, x, z: i } : { o, x: i, z });
  return out;
}

/**
 * The same question for a whole run at once.
 *
 * Asked once for the run rather than once per segment, because "does this seal
 * the shop" is only true of the run as a whole — no single segment of a wall
 * across the aisle seals anything, and validating them one at a time would
 * report no warning at all right up until the shop was shut.
 */
export function canPlaceEdges(L, segs, kind = E.WALL) {
  if (!segs?.length) return no('nothing to build');

  for (const s of segs) {
    const o = s.o;
    const x = Math.round(s.x);
    const z = Math.round(s.z);
    if (o !== 'v' && o !== 'h') return no('that is not a wall line');
    // A lattice line, not a cell: a vertical run has one more column than the
    // grid has cells, and vice versa. Off-by-one here writes into the next row.
    const maxX = o === 'v' ? L.w : L.w - 1;
    const maxZ = o === 'v' ? L.h - 1 : L.h;
    if (x < 1 || z < 1 || x > maxX - 1 || z > maxZ - 1) return no('off the edge of the world');
  }

  // Taking something away can't strand anybody, so there is nothing to warn on.
  if (!kind) return { ok: true };

  let probe = L;
  for (const s of segs) probe = withEdge(probe, s, kind);
  const from = L.spawn ?? L.door;
  const seen = reachable(probe, from.x, from.z);
  const at = (p) => seen.has(`${Math.round(p.x)},${Math.round(p.z)}`);

  if (!at(L.door)) return { ok: true, warn: 'that seals the shop — nobody can get in' };

  const stranded = fixturesOf(L)
    .map((f) => ({ f, spot: f.browseAt ?? f.serveAt ?? f.useAt }))
    .filter(({ spot }) => spot && !at(spot));
  if (stranded.length) {
    const what = FIXTURES[stranded[0].f.kind]?.label.toLowerCase() ?? 'fixture';
    return {
      ok: true,
      warn: stranded.length === 1
        ? `that walls off a ${what} — nobody will reach it`
        : `that walls off ${stranded.length} fixtures — nobody will reach them`,
    };
  }

  return { ok: true };
}

/** Every fixture currently in the layout, as uniform placement specs. */
export function fixturesOf(L) {
  const out = [];
  for (const s of L.shelves ?? []) out.push({ kind: s.kind === 'freezer' ? 'freezer' : 'shelf', ...s });
  for (const c of L.checkouts ?? []) out.push({ kind: 'checkout', ...c });
  for (const s of L.stations ?? []) out.push({ kind: 'station', ...s });
  for (const p of L.plots ?? []) out.push({ kind: 'plot', ...p });
  // Props carry their own kind, because there is more than one and they are not
  // told apart by which list they came out of.
  for (const p of L.props ?? []) out.push({ ...p });
  return out;
}

// ---------------------------------------------------------------------------
// The actual rule
// ---------------------------------------------------------------------------

/**
 * May this fixture go here?
 *
 * Two different answers, and the difference is the whole design.
 *
 * `ok: false` is physics — the tile is taken, or off the map, or a plot is
 * being dug in the shop. There is nowhere for the thing to be.
 *
 * `ok: true` with a `warn` is a *consequence*. Walling a shelf in, sealing the
 * doorway, standing a till where nobody can queue: all of that is allowed, and
 * it is allowed on purpose. A shelf nobody can reach simply never sells, and
 * the sim already copes — a shopper who can't path to a shelf writes it off and
 * picks another, one who can't reach the door leaves, staff cool down and find
 * another job. So the game says what it will cost you and lets you do it, which
 * is a game; refusing would be a level editor with opinions.
 *
 * The one caller that must still refuse a warning is the layout *generator* —
 * a procedurally furnished shop nobody can walk through is a bug, not a choice.
 * `canPlaceCleanly` is that caller's entry point.
 *
 * @param {object} L      the layout
 * @param {object} spec   { kind, x, z, rot }
 * @param {object} [opts] { ignoreId } — the fixture being moved, so it doesn't
 *                        block its own new position when they overlap.
 * @returns {{ok: boolean, reason?: string, warn?: string}}
 */
export function canPlace(L, spec, { ignoreId = null } = {}) {
  const def = FIXTURES[spec.kind];
  if (!def) return no(`"${spec.kind}" is not something you can build`);

  const x = Math.round(spec.x);
  const z = Math.round(spec.z);
  if (x < 1 || z < 1 || x >= L.w - 1 || z >= L.h - 1) return no('off the edge of the world');

  if (!def.tile) return canPlaceProp(L, def, x, z, ignoreId);

  const tile = tileAt(L, x, z);
  const removed = removedTiles(L, ignoreId);
  const effective = (tx, tz) => (removed.has(`${tx},${tz}`) ? baseTile(L, tx, tz) : tileAt(L, tx, tz));

  if (def.where === 'indoor') {
    if (!insideStore(L, x, z)) return no('that has to go inside the shop');
    if (!BUILDABLE_INDOOR.has(effective(x, z))) {
      return no(tile === T.DOOR ? 'not in the doorway' : 'something is already there');
    }
  } else {
    if (insideStore(L, x, z)) return no('plots go outside, on the grass');
    if (!BUILDABLE_OUTDOOR.has(effective(x, z))) return no('you can only dig into bare grass');
  }

  const warn = whatThisCosts(L, { ...spec, x, z }, def, { ignoreId, effective });
  return warn ? { ok: true, warn } : { ok: true };
}

/**
 * May a decoration stand here?
 *
 * Much shorter than the fixture rule, and that is the point rather than an
 * omission. A prop stamps no tile, so it cannot cut a shelf off, cannot seal a
 * doorway and cannot leave a queue nowhere to form — every warning `canPlace`
 * has to reason about is about *occupying* a cell, and this doesn't. So there
 * are no soft answers here at all: what remains is genuine physics.
 *
 * One prop to a cell, though, and that is not fussiness. The pointer names a
 * cell (`fixtureAt`), so two things stacked on one is a menu you cannot open —
 * the same reason build mode aims at named targets rather than at whatever is
 * nearest. A cell holds one thing you can point at.
 */
function canPlaceProp(L, def, x, z, ignoreId) {
  if (def.where === 'indoor' && !insideStore(L, x, z)) return no('that has to go inside the shop');
  // A prop stands *in* the cell, so the cell has to be somewhere a person could
  // stand. This is also what keeps one off a shelf's tile without a second rule.
  if (!isWalkableTile(L, x, z)) return no('something is already there');
  const clash = (L.props ?? []).some((p) => p.id !== ignoreId && p.x === x && p.z === z);
  if (clash) return no('something is already there');
  return { ok: true };
}

/**
 * `canPlace`, for the one caller that cannot live with a warning: the layout
 * generator. It furnishes a shop nobody has looked at yet, so "you could seal
 * this off if you wanted to" is not an offer it can accept on your behalf.
 */
export function canPlaceCleanly(L, spec, opts = {}) {
  const r = canPlace(L, spec, opts);
  return r.ok && r.warn ? no(r.warn) : r;
}

const no = (reason) => ({ ok: false, reason });

/**
 * What placing this here would cost you, or null if it costs nothing.
 *
 * Every one of these used to be a refusal. They are the same checks, asked as
 * "what happens" rather than "may I" — so the order matters only in that the
 * most specific answer should come out first.
 */
function whatThisCosts(L, spec, def, { ignoreId, effective }) {
  const { x, z } = spec;

  // ---- can anything use it, facing that way? -----------------------------
  if (def.anchor) {
    const a = anchorTile(x, z, spec.rot ?? 0);
    if (!WALKABLE.has(effective(a.x, a.z))) return 'nothing can use it facing that way';
    if (!insideStore(L, a.x, a.z)) return 'it faces out of the shop — nobody will use it';
  } else if (!FACING.some((f) => WALKABLE.has(effective(x + f.dx, z + f.dz)))) {
    return 'nothing can get to it';
  }

  // ---- a till wants a queue ----------------------------------------------
  if (spec.kind === 'checkout') {
    const serve = anchorTile(x, z, spec.rot ?? 0);
    const clash = (L.checkouts ?? []).some((c) => c.id !== ignoreId
      && c.serveAt?.x === serve.x && c.serveAt?.z === serve.z);
    if (clash) return 'another till already serves that spot';
    const best = Math.max(...queueAxis(spec.rot ?? 0)
      .map((d) => openRun({ ...L, tiles: withTile(L, x, z, def.tile) }, serve, d)));
    if (best < 1) return 'no room for a queue — shoppers will pile up on one tile';
  }

  // ---- and what it cuts off ----------------------------------------------
  return whatThisBlocks(L, spec, def, ignoreId);
}

/** The tiles a fixture we're about to pick up currently occupies. */
function removedTiles(L, ignoreId) {
  const set = new Set();
  if (!ignoreId) return set;
  for (const f of fixturesOf(L)) {
    if (f.id === ignoreId) set.add(`${f.x},${f.z}`);
  }
  return set;
}

/**
 * What a tile would be with nothing standing on it. The renderer needs this
 * too: a fixture drawn from its own model still has to be given the ground it
 * stands on, or the shop's grass shows through the gaps around it.
 */
export function baseTile(L, x, z) {
  return insideStore(L, x, z) ? T.FLOOR : T.GRASS;
}

function withTile(L, x, z, v) {
  const copy = Uint8Array.from(L.tiles);
  copy[z * L.w + x] = v;
  return copy;
}

/**
 * Would putting this here cut something off — and if so, what?
 *
 * Returns the reason, or null when everything is still reachable. It answers
 * *which* thing rather than a flat yes/no because the two ways to fail read
 * completely differently to whoever is holding the shelf: one tile over is
 * where a shopper stands to reach the unit behind, and being told that "blocks
 * the way through" sends you looking for a corridor that was never the problem.
 *
 * The flood starts at the door, because that is where shoppers come in — a
 * pocket of floor nobody can walk to is not floor.
 */
function whatThisBlocks(L, spec, def, ignoreId) {
  const tiles = Uint8Array.from(L.tiles);
  // The thing being moved has already left its old tile as far as this is
  // concerned, or a shelf could never be shuffled one square along.
  if (ignoreId) {
    for (const f of fixturesOf(L)) {
      if (f.id === ignoreId) tiles[f.z * L.w + f.x] = baseTile(L, f.x, f.z);
    }
  }
  tiles[spec.z * L.w + spec.x] = def.tile;

  const probe = { ...L, tiles };
  const seen = new Set();
  const stack = [[L.door.x, L.door.z]];
  seen.add(`${L.door.x},${L.door.z}`);
  while (stack.length) {
    const [cx, cz] = stack.pop();
    for (const f of FACING) {
      const nx = cx + f.dx;
      const nz = cz + f.dz;
      const k = `${nx},${nz}`;
      if (seen.has(k)) continue;
      if (SOLID.has(edgeBetween(probe, cx, cz, nx, nz))) continue;
      if (!WALKABLE.has(tileAt(probe, nx, nz))) continue;
      seen.add(k);
      stack.push([nx, nz]);
    }
  }

  const reaches = (p) => seen.has(`${Math.round(p.x)},${Math.round(p.z)}`);
  const isHere = (p) => Math.round(p.x) === spec.x && Math.round(p.z) === spec.z;
  const label = (kind) => FIXTURES[kind]?.label.toLowerCase() ?? 'fixture';

  // Whatever you are placing has to be usable itself, and standing somewhere
  // walkable is not the same as standing somewhere you can walk *to*.
  if (def.anchor) {
    const mine = anchorTile(spec.x, spec.z, spec.rot ?? 0);
    if (!reaches(mine)) return 'you could never get round to that side of it';
  }

  for (const f of fixturesOf(L)) {
    if (f.id === ignoreId) continue;
    if (f.kind === 'plot') {
      // A bed is worked from any side, so it only needs one of them.
      const anySide = FACING.some((d) => reaches({ x: f.x + d.dx, z: f.z + d.dz }));
      if (!anySide) return 'that would leave a plot with no way in';
      continue;
    }
    const a = f.browseAt ?? f.serveAt ?? f.useAt;
    if (!a) continue;
    if (isHere(a)) return `that is where you stand to use the ${label(f.kind)} behind it`;
    if (!reaches(a)) return `that would cut off a ${label(f.kind)} you own`;
  }

  if (!reaches(L.spawn)) return 'that would block the way through';
  if (L.bay && !reaches(L.bay)) return 'that would cut the delivery bay off';
  return null;
}
