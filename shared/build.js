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

/**
 * What each buildable thing is. `anchor` is the tile you have to be able to
 * stand on to use it — a shelf you can't reach is scenery.
 */
export const FIXTURES = {
  shelf: { label: 'Shelf', tile: T.SHELF, where: 'indoor', rotates: true, anchor: 'browseAt' },
  freezer: { label: 'Freezer', tile: T.FREEZER, where: 'indoor', rotates: true, anchor: 'browseAt' },
  checkout: { label: 'Till', tile: T.CHECKOUT, where: 'indoor', rotates: true, anchor: 'serveAt' },
  station: { label: 'Appliance', tile: T.STATION, where: 'indoor', rotates: true, anchor: 'useAt' },
  plot: { label: 'Plot', tile: T.PLOT, where: 'outdoor', rotates: false, anchor: null },
};

export const FIXTURE_KINDS = Object.keys(FIXTURES);

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

/** Strictly inside the building — not the wall ring, not the doorway. */
export function insideStore(L, x, z) {
  const s = L.store;
  return x > s.x && x < s.x + s.w - 1 && z > s.z && z < s.z + s.h - 1;
}

/** How far a queue can run from `from` in `dir` before it leaves the shop. */
export function openRun(L, from, dir, max = 8, blocked = () => false) {
  let n = 0;
  for (let i = 1; i <= max; i++) {
    const x = from.x + dir.x * i;
    const z = from.z + dir.z * i;
    if (!insideStore(L, x, z) || !isWalkableTile(L, x, z) || blocked(x, z)) break;
    n++;
  }
  return n;
}

/** Every fixture currently in the layout, as uniform placement specs. */
export function fixturesOf(L) {
  const out = [];
  for (const s of L.shelves ?? []) out.push({ kind: s.kind === 'freezer' ? 'freezer' : 'shelf', ...s });
  for (const c of L.checkouts ?? []) out.push({ kind: 'checkout', ...c });
  for (const s of L.stations ?? []) out.push({ kind: 'station', ...s });
  for (const p of L.plots ?? []) out.push({ kind: 'plot', ...p });
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
