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
 * @param {object} L      the layout
 * @param {object} spec   { kind, x, z, rot }
 * @param {object} [opts] { ignoreId } — the fixture being moved, so it doesn't
 *                        block its own new position when they overlap.
 * @returns {{ok: boolean, reason?: string}}
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

  // ---- somewhere to stand and use it -------------------------------------
  if (def.anchor) {
    const a = anchorTile(x, z, spec.rot ?? 0);
    const at = effective(a.x, a.z);
    if (!WALKABLE.has(at)) return no('nowhere to stand on that side — rotate it');
    if (!insideStore(L, a.x, a.z)) return no('you would be standing outside — rotate it');
  } else {
    const reachable = FACING.some((f) => WALKABLE.has(effective(x + f.dx, z + f.dz)));
    if (!reachable) return no('you could never reach it');
  }

  // ---- a till needs a queue ----------------------------------------------
  if (spec.kind === 'checkout') {
    const serve = anchorTile(x, z, spec.rot ?? 0);
    const clash = (L.checkouts ?? []).some((c) => c.id !== ignoreId
      && c.serveAt?.x === serve.x && c.serveAt?.z === serve.z);
    if (clash) return no('another till already serves that spot');
    const best = Math.max(...queueAxis(spec.rot ?? 0)
      .map((d) => openRun({ ...L, tiles: withTile(L, x, z, def.tile) }, serve, d)));
    if (best < 1) return no('no room for a queue — rotate it or move along');
  }

  // ---- and the shop has to stay one connected space -----------------------
  if (!staysConnected(L, { ...spec, x, z }, def, ignoreId)) {
    return no('that would block the way through');
  }

  return { ok: true };
}

const no = (reason) => ({ ok: false, reason });

/** The tiles a fixture we're about to pick up currently occupies. */
function removedTiles(L, ignoreId) {
  const set = new Set();
  if (!ignoreId) return set;
  for (const f of fixturesOf(L)) {
    if (f.id === ignoreId) set.add(`${f.x},${f.z}`);
  }
  return set;
}

/** What a tile would revert to if whatever is on it were taken away. */
function baseTile(L, x, z) {
  return insideStore(L, x, z) ? T.FLOOR : T.GRASS;
}

function withTile(L, x, z, v) {
  const copy = Uint8Array.from(L.tiles);
  copy[z * L.w + x] = v;
  return copy;
}

/**
 * Would placing this cut the shop in half?
 *
 * Flood fills from the door with the new fixture in place and checks that every
 * working spot is still reachable. Cheap at this world size, and it's the only
 * thing stopping you from walling yourself out of your own aisle.
 */
function staysConnected(L, spec, def, ignoreId) {
  const tiles = Uint8Array.from(L.tiles);
  if (ignoreId) {
    for (const f of fixturesOf(L)) {
      if (f.id === ignoreId) tiles[f.z * L.w + f.x] = baseTile(L, f.x, f.z);
    }
  }
  tiles[spec.z * L.w + spec.x] = def.tile;

  const probe = { ...L, tiles };
  const seen = new Set();
  const start = `${L.door.x},${L.door.z}`;
  const stack = [[L.door.x, L.door.z]];
  seen.add(start);
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

  const need = [];
  for (const f of fixturesOf(L)) {
    if (f.id === ignoreId) continue;
    if (f.kind === 'plot') {
      need.push(...FACING.map((d) => ({ x: f.x + d.dx, z: f.z + d.dz })).filter((p) => WALKABLE.has(tileAt(probe, p.x, p.z))).slice(0, 1));
    } else {
      const a = f.browseAt ?? f.serveAt ?? f.useAt;
      if (a) need.push(a);
    }
  }
  need.push(L.spawn);
  if (L.bay) need.push({ x: Math.round(L.bay.x), z: Math.round(L.bay.z) });

  return need.every((p) => seen.has(`${Math.round(p.x)},${Math.round(p.z)}`));
}
