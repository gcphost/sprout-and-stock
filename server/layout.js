/**
 * PROCEDURAL LAYOUT.
 *
 * The shop and farm aren't hand-placed — they're generated from a seed plus
 * "how much stuff do you own". Buy a shelf upgrade and the aisles re-flow to
 * fit it; buy land and the fields extend. Same seed always gives the same
 * world, which is what makes headless `simulate()` runs reproducible.
 *
 * Since build mode landed, generation is the *starting* layout rather than the
 * only one: anything the player has deliberately positioned arrives in
 * `placements` and is honoured exactly, and the generator fills in whatever is
 * left over. Move nothing and you get the same procedural shop as always.
 *
 * THE INVARIANT: this function places exactly what it was asked for. Never
 * fewer. Two separate bugs here — a shelf loop that dropped its last row, and a
 * checkout loop that marched west into a wall — were both invisible in a
 * screenshot and both cost a paid upgrade its effect. So the building is now
 * *grown until everything fits* rather than sized by a formula and hoped for,
 * and `scripts/verify-layout.js` sweeps the whole range on every change.
 *
 * Everything lives on a tile grid. 1 tile = 1 world unit = 1 metre-ish.
 */

import { makeRng } from '../shared/rng.js';
import { T, WALKABLE } from '../shared/tiles.js';
import { anchorTile, queueAxis, canPlace } from '../shared/build.js';

export { T };

// Minimum world size. The world actually grows to fit whatever you own — a
// fixed grid either wastes space early or runs out of room once the farm gets
// big, and both look bad. Deliberately snug: extra ground is just extra
// walking between the till and the fields.
export const WORLD_W = 26;
export const WORLD_H = 22;

/** Smallest a shop can be. Everything grows up from here. */
const MIN_STORE_W = 11;
const MIN_STORE_H = 11;

/** Farm plots per side of the path, per row. */
const PLOTS_PER_SIDE = 4;

/** Longest queue a till will lay out behind its serving spot. */
const QUEUE_MAX = 8;

/** How far apart shelf columns sit: one unit, then a walkable aisle. */
const COL_PITCH = 3;
const ROW_PITCH = 2;

/**
 * Generate the whole world.
 *
 * @param {object} opts
 * @param {string|number} opts.seed
 * @param {number} opts.shelves     how many plain shelf units to place
 * @param {number} opts.freezers    how many freezer units to place
 * @param {number} opts.checkouts   how many tills
 * @param {number} opts.plots       how many farm plots
 * @param {string[]} opts.stations  appliance kinds, in purchase order
 * @param {object[]} opts.placements player-positioned fixtures, honoured first
 * @param {object} opts.grow        bought floor area, {w, h} extra tiles
 * @param {number} opts.doorShift   player-moved door, tiles east of centre
 */
export function generateLayout({
  seed = 'sprout-1',
  shelves = 4,
  freezers = 0,
  checkouts = 1,
  plots = 4,
  stations = [],
  placements = [],
  grow = { w: 0, h: 0 },
  doorShift = 0,
} = {}) {
  const req = {
    seed, shelves, freezers, checkouts, plots, stations,
    placements: placements ?? [],
    doorShift: Math.trunc(doorShift) || 0,
  };

  // Bought floor area is added on top of whatever the contents need, not used
  // as a minimum. A shop that had already grown past the minimum to fit its
  // shelving would otherwise swallow most of an extension and hand back a
  // single tile for it.
  const growW = Math.max(0, Math.trunc(grow?.w ?? 0));
  const growH = Math.max(0, Math.trunc(grow?.h ?? 0));

  // Grow the building until it genuinely holds everything. A formula that
  // *usually* fits is how both historical off-by-ones got in; measuring is
  // cheap (a few dozen attempts worst case, each one a 500-tile fill).
  //
  // Two passes, because a hand-placed fixture is a promise. The first insists
  // on honouring every placement and grows the shop to make room, so tidying
  // your aisles doesn't get quietly undone the next time you buy a shelf. Only
  // if a placement is impossible at any size — off the map, or the shop shrank
  // past it — does the second pass hand it back to the generator.
  // Stage 1: the smallest building that holds everything, with no bought area
  // counted. This has to be measured separately — fold the two together and the
  // extension you paid for silently pays for the shelving you already owned.
  let fitW = MIN_STORE_W;
  let fitH = MIN_STORE_H;
  for (let i = 0; i < 60; i++) {
    const probe = compose(req, fitW, fitH, true);
    if (probe.complete) break;
    if (probe.want === 'w') fitW++;
    else if (probe.want === 'h') fitH++;
    else if (i % 2 === 0) fitW++;
    else fitH++;
  }

  // Stage 2: build at that size plus whatever floor area has been bought.
  for (const allowDrops of [false, true]) {
    let storeW = fitW + growW;
    let storeH = fitH + growH;
    let attempt = null;
    for (let i = 0; i < 60; i++) {
      attempt = compose(req, storeW, storeH, allowDrops);
      if (attempt.complete) return attempt.layout;
      if (attempt.want === 'w') storeW++;
      else if (attempt.want === 'h') storeH++;
      else if (i % 2 === 0) storeW++;
      else storeH++;
    }
    if (allowDrops) {
      // Should be unreachable for any sane input; returning the best effort
      // beats throwing inside a tick loop, and verify-layout.js will shout.
      console.warn('[layout] could not fit everything requested', req);
      return attempt.layout;
    }
  }
  return null;
}

/**
 * One attempt at a building of a given size.
 * @returns {{complete: boolean, want: 'w'|'h'|null, layout: object}}
 */
function compose(req, storeW, storeH, allowDrops = true) {
  const rng = makeRng(req.seed);
  const totalUnits = req.shelves + req.freezers;

  // ---- world size, sized around the building and the fields ---------------
  const farmHalfSpan = 2 + (PLOTS_PER_SIDE - 1) * ROW_PITCH;
  const worldW = Math.max(WORLD_W, storeW + 8, farmHalfSpan * 2 + 10);

  const storeX = Math.floor((worldW - storeW) / 2);
  const storeZ = 2;
  const store = { x: storeX, z: storeZ, w: storeW, h: storeH };

  const doorZ = store.z + store.h - 1;
  // Two tiles wide, roughly centred, jittered by seed, and nudged by however
  // far the player has dragged it. Clamped so both halves stay in the wall.
  const doorX = clampInt(
    store.x + Math.floor(store.w / 2) + rng.int(-1, 1) + req.doorShift,
    store.x + 1, store.x + store.w - 3,
  );

  // How wide the farm can spread before it runs off the map, and therefore how
  // many rows it needs. Computed up front so no plot is ever silently dropped.
  const perSide = clampInt(
    Math.min(PLOTS_PER_SIDE, Math.floor((Math.min(doorX - 3, worldW - 5 - doorX) - 2) / ROW_PITCH) + 1),
    1, PLOTS_PER_SIDE,
  );
  const pathZEnd = doorZ + 3;
  const plotTop = pathZEnd + 1;
  const plotRows = Math.max(1, Math.ceil(req.plots / (perSide * 2)));
  const worldH = Math.max(WORLD_H, plotTop + plotRows * ROW_PITCH + 3);

  const tiles = new Uint8Array(worldW * worldH).fill(T.GRASS);
  const idx = (x, z) => z * worldW + x;
  const set = (x, z, v) => {
    if (x >= 0 && z >= 0 && x < worldW && z < worldH) tiles[idx(x, z)] = v;
  };
  const at = (x, z) => (x < 0 || z < 0 || x >= worldW || z >= worldH ? -1 : tiles[idx(x, z)]);

  // ---- shell --------------------------------------------------------------
  for (let z = store.z; z < store.z + store.h; z++) {
    for (let x = store.x; x < store.x + store.w; x++) {
      const edge = x === store.x || x === store.x + store.w - 1
        || z === store.z || z === store.z + store.h - 1;
      set(x, z, edge ? T.WALL : T.FLOOR);
    }
  }
  set(doorX, doorZ, T.DOOR);
  set(doorX + 1, doorZ, T.DOOR);

  // ---- the path from the door out to the farm -----------------------------
  for (let z = doorZ + 1; z <= pathZEnd; z++) {
    set(doorX, z, T.PATH);
    set(doorX + 1, z, T.PATH);
  }

  // ---- the loading bay ----------------------------------------------------
  // A wooden pad beside the path: where pallets land, and where you can put
  // down anything you're carrying. Derived from the door so it can never drift
  // out of sync when the building re-flows.
  const bayPad = [
    { x: doorX + 3, z: doorZ + 1 },
    { x: doorX - 4, z: doorZ + 1 },
    { x: doorX + 3, z: doorZ + 2 },
  ].find((c) => c.x >= 1 && c.x + 1 < worldW - 1 && c.z + 1 < worldH - 1)
    ?? { x: doorX, z: doorZ + 1 };
  for (let dz = 0; dz < 2; dz++) {
    for (let dx = 0; dx < 2; dx++) {
      if (at(bayPad.x + dx, bayPad.z + dz) === T.GRASS) set(bayPad.x + dx, bayPad.z + dz, T.BAY);
    }
  }
  const bay = { x: bayPad.x + 0.5, z: bayPad.z + 0.5 };

  // ---- what the player has positioned by hand ------------------------------
  // Applied before anything procedural, so the generator flows around the
  // player's choices rather than fighting them.
  const shelvesOut = [];
  const checkoutsOut = [];
  const stationsOut = [];
  const plotsOut = [];
  const layoutSoFar = () => ({
    w: worldW, h: worldH, tiles, store, door: { x: doorX, z: doorZ }, bay,
    spawn: { x: doorX, z: Math.min(worldH - 2, doorZ + 5) },
    shelves: shelvesOut, checkouts: checkoutsOut, stations: stationsOut, plots: plotsOut,
  });

  const budget = {
    shelf: req.shelves,
    freezer: req.freezers,
    checkout: req.checkouts,
    plot: req.plots,
  };
  const stationQueue = [...req.stations];
  const dropped = [];

  // Working spots already spoken for. Nothing may be *built* on one of these —
  // otherwise the generator happily drops a shelf onto the exact tile you have
  // to stand on to reach a shelf you positioned by hand, and you end up with a
  // fixture you can see but can never use. (Two fixtures *sharing* a working
  // spot is fine; a person only stands on one at a time.)
  const reserved = new Set();
  const reserve = (a) => a && reserved.add(`${a.x},${a.z}`);
  const free = (x, z) => at(x, z) === T.FLOOR && !reserved.has(`${x},${z}`);

  for (const p of req.placements) {
    const drop = () => {
      if (!allowDrops) return false;
      dropped.push(p);
      return true;
    };

    if (p.kind === 'station') {
      const i = stationQueue.indexOf(p.station);
      // An appliance whose upgrade has been sold isn't a fit problem, so this
      // one is always just dropped rather than grown for.
      if (i === -1) { dropped.push(p); continue; }
      if (reserved.has(`${p.x},${p.z}`) || !canPlace(layoutSoFar(), p).ok) {
        if (!drop()) return incomplete(layoutSoFar(), null);
        continue;
      }
      stationQueue.splice(i, 1);
      set(p.x, p.z, T.STATION);
      const st = makeStation(p.id, p.station, p.x, p.z, p.rot ?? 2);
      stationsOut.push(st);
      reserve(st.useAt);
      continue;
    }
    if (!(budget[p.kind] > 0)) { dropped.push(p); continue; }
    if (reserved.has(`${p.x},${p.z}`) || !canPlace(layoutSoFar(), p).ok) {
      if (!drop()) return incomplete(layoutSoFar(), null);
      continue;
    }
    budget[p.kind]--;
    if (p.kind === 'plot') {
      set(p.x, p.z, T.PLOT);
      plotsOut.push(makePlot(p.id, p.x, p.z));
    } else if (p.kind === 'checkout') {
      set(p.x, p.z, T.CHECKOUT);
      const till = makeCheckout(layoutSoFar(), p.id, p.x, p.z, p.rot ?? 1, checkoutsOut);
      checkoutsOut.push(till);
      reserve(till.serveAt);
    } else {
      set(p.x, p.z, p.kind === 'freezer' ? T.FREEZER : T.SHELF);
      const shelf = makeShelf(p.id, p.kind, p.x, p.z, p.rot ?? 0);
      shelvesOut.push(shelf);
      reserve(shelf.browseAt);
    }
  }

  // ---- checkouts, just inside the door ------------------------------------
  // `serveAt` sits on the last floor row before the south wall, so the queue
  // runs *along* that wall. Trailing south (the obvious guess) puts shopper #2
  // inside the wall and everyone after them out on the grass, waiting in a line
  // the till can never reach.
  const checkoutZ = doorZ - 2;
  const serveRow = checkoutZ + 1;

  // West of the door first (that's how the shop has always read), then east.
  const tillSlots = [];
  for (let i = 1; i <= store.w; i++) tillSlots.push(doorX - COL_PITCH * i);
  for (let i = 0; i < store.w; i++) tillSlots.push(doorX + 2 + COL_PITCH * i);

  const takenServe = new Set(checkoutsOut.map((c) => `${c.serveAt.x},${c.serveAt.z}`));
  let nTill = 0;
  for (const cx of tillSlots) {
    if (budget.checkout <= 0) break;
    if (cx <= store.x || cx >= store.x + store.w - 1) continue;
    if (checkoutZ <= store.z || !free(cx, checkoutZ)) continue;
    if (at(cx, serveRow) !== T.FLOOR || takenServe.has(`${cx},${serveRow}`)) continue;

    set(cx, checkoutZ, T.CHECKOUT);
    const till = makeCheckout(layoutSoFar(), `till-p${nTill}`, cx, checkoutZ, 1, checkoutsOut);
    if (till.queueMax < 1) { set(cx, checkoutZ, T.FLOOR); continue; }
    nTill++;
    checkoutsOut.push(till);
    reserve(till.serveAt);
    takenServe.add(`${cx},${serveRow}`);
    budget.checkout--;
  }
  if (budget.checkout > 0) return incomplete(layoutSoFar(), 'w');

  // ---- appliances ----------------------------------------------------------
  // A run down the east side, well clear of the shelf columns, with the tile to
  // their left kept free so there's somewhere to stand and work.
  const shelfTop = store.z + 2;
  const shelfBottom = checkoutZ - 2;
  const stationX = store.x + store.w - 3;
  if (stationQueue.length) {
    let nStation = 0;
    for (let sz = shelfTop; sz <= shelfBottom && stationQueue.length; sz += ROW_PITCH) {
      if (stationX <= store.x + 1) break;
      if (!free(stationX, sz) || at(stationX - 1, sz) !== T.FLOOR) continue;
      set(stationX, sz, T.STATION);
      const st = makeStation(`station-p${nStation++}`, stationQueue.shift(), stationX, sz, 2);
      stationsOut.push(st);
      reserve(st.useAt);
    }
    if (stationQueue.length) return incomplete(layoutSoFar(), 'h');
  }

  // ---- shelving ------------------------------------------------------------
  // Vertical runs with a walkable aisle between each. Collect every usable cell
  // first, then hand the *last* ones to freezers so they end up on the outer
  // wall — the old code only ever considered the final column, which the
  // column-major fill almost never reached, so a bought freezer was silently
  // never placed at all.
  const cells = [];
  for (let sx = store.x + 2; sx < store.x + store.w - 1; sx += COL_PITCH) {
    if (stationsOut.length && sx >= stationX - 1) break;
    for (let sz = shelfTop; sz <= shelfBottom; sz += ROW_PITCH) {
      if (!free(sx, sz)) continue;
      if (at(sx + 1, sz) !== T.FLOOR) continue;   // nowhere to browse from
      cells.push({ x: sx, z: sz });
    }
  }
  const wanted = budget.shelf + budget.freezer;
  if (cells.length < wanted) {
    // Short on columns or short on rows? Grow whichever is scarcer so the shop
    // stays roughly square instead of turning into a corridor.
    const columns = new Set(cells.map((c) => c.x)).size;
    const rows = cells.length / Math.max(1, columns);
    return incomplete(layoutSoFar(), columns <= rows ? 'w' : 'h');
  }
  const used = cells.slice(0, wanted);
  let nShelf = 0;
  let nFreezer = 0;
  for (let i = 0; i < used.length; i++) {
    const isFreezer = i >= budget.shelf;      // freezers take the far cells
    const { x, z } = used[i];
    set(x, z, isFreezer ? T.FREEZER : T.SHELF);
    // Procedural ids live in their own `-pN` namespace so they can never
    // collide with a placement that kept the id of the fixture it came from.
    const shelf = makeShelf(
      isFreezer ? `freezer-p${nFreezer++}` : `shelf-p${nShelf++}`,
      isFreezer ? 'freezer' : 'shelf', x, z, 0,
    );
    shelvesOut.push(shelf);
    reserve(shelf.browseAt);
  }

  // ---- farm plots ----------------------------------------------------------
  // Tidy blocks either side of the path, growing outward then downward. The
  // world was sized for exactly this many rows, so nothing gets clipped.
  let nPlot = 0;
  for (let i = 0, n = 0; budget.plot > 0; i++) {
    if (i > req.plots * 8 + 64) break;         // belt and braces
    const side = i % 2 === 0 ? -1 : 1;
    n = Math.floor(i / 2);
    const px = doorX + side * (2 + (n % perSide) * ROW_PITCH) + (side < 0 ? 0 : 1);
    const pz = plotTop + Math.floor(n / perSide) * ROW_PITCH;
    if (pz >= worldH - 2 || px < 1 || px > worldW - 2) continue;
    if (at(px, pz) !== T.GRASS) continue;
    set(px, pz, T.PLOT);
    plotsOut.push(makePlot(`plot-p${nPlot++}`, px, pz));
    budget.plot--;
  }
  if (budget.plot > 0) return incomplete(layoutSoFar(), 'h');

  // ---- a fence hugging the actual plots, purely for looks -------------------
  // Bound this to where the plots really are. Fencing the whole map (an easy
  // mistake) reads as an empty field with a shed in it rather than a farm.
  if (plotsOut.length > 0) {
    const xs = plotsOut.map((p) => p.x);
    const zs = plotsOut.map((p) => p.z);
    const fenceLeft = Math.max(1, Math.min(...xs) - 2);
    const fenceRight = Math.min(worldW - 2, Math.max(...xs) + 2);
    const fenceTop = Math.max(1, Math.min(...zs) - 2);
    const fenceBottom = Math.min(worldH - 2, Math.max(...zs) + 2);

    for (let x = fenceLeft; x <= fenceRight; x++) {
      for (const z of [fenceTop, fenceBottom]) {
        // Leave a gap where the path runs out of the shop.
        if (x === doorX || x === doorX + 1) continue;
        if (at(x, z) === T.GRASS) set(x, z, T.FENCE);
      }
    }
    for (let z = fenceTop; z <= fenceBottom; z++) {
      for (const x of [fenceLeft, fenceRight]) {
        if (at(x, z) === T.GRASS) set(x, z, T.FENCE);
      }
    }
  }

  const layout = layoutSoFar();
  return {
    complete: true,
    want: null,
    layout: {
      seed: String(req.seed),
      w: worldW,
      h: worldH,
      tiles: Array.from(tiles),
      store,
      door: { x: doorX, z: doorZ },
      doorShift: req.doorShift,
      /** Where pallets land and where you can put things down. */
      bay,
      /** Customers walk on from off-screen here. */
      spawn: layout.spawn,
      shelves: shelvesOut,
      checkouts: checkoutsOut,
      stations: stationsOut,
      plots: plotsOut,
      /** Placements that no longer fit (the building re-flowed under them). */
      droppedPlacements: dropped.map((p) => p.id),
    },
  };
}

const incomplete = (layout, want) => ({ complete: false, want, layout });

// ---------------------------------------------------------------------------
// Fixture constructors — one place per kind, so a hand-placed shelf and a
// generated one are indistinguishable to the rest of the game.
// ---------------------------------------------------------------------------

function makeShelf(id, kind, x, z, rot) {
  return {
    id,
    x,
    z,
    rot,
    kind: kind === 'freezer' ? 'freezer' : 'shelf',
    // Customers browse from the tile this one faces.
    browseAt: anchorTile(x, z, rot),
    item_id: null,
    qty: 0,
    price: 0,
    stockedDay: 0,
  };
}

function makeCheckout(L, id, x, z, rot, existing) {
  const serveAt = anchorTile(x, z, rot);
  const taken = new Set(existing.map((c) => `${c.serveAt.x},${c.serveAt.z}`));
  const runs = queueAxis(rot).map((dir) => ({
    dir,
    n: openRunAvoiding(L, serveAt, dir, taken),
  }));
  const best = runs[0].n >= runs[1].n ? runs[0] : runs[1];
  return {
    id,
    x,
    z,
    rot,
    // Where shoppers stand to be served, and where the queue trails off to.
    serveAt,
    queueDir: best.dir,
    // Slots behind the front one. Past this the line would leave the floor, so
    // shoppers stack on the last slot instead of walking into a wall.
    queueMax: best.n,
  };
}

function makeStation(id, station, x, z, rot) {
  return {
    id,
    station,
    x,
    z,
    rot,
    // Where a worker stands to load and empty it.
    useAt: anchorTile(x, z, rot),
    contents: {},
    busyUntil: 0,
    making: null,
    output: null,
  };
}

function makePlot(id, x, z) {
  return {
    id,
    x,
    z,
    /** untilled -> tilled -> (crop_id set) -> ready. Seeds need broken soil. */
    soil: 'untilled',
    crop_id: null,
    plantedAt: 0,
    ready: false,
  };
}

/** Queue run that also refuses to overlap another till's serving spot. */
function openRunAvoiding(L, from, dir, taken) {
  let n = 0;
  for (let i = 1; i <= QUEUE_MAX; i++) {
    const x = from.x + dir.x * i;
    const z = from.z + dir.z * i;
    const inside = x > L.store.x && x < L.store.x + L.store.w - 1
      && z > L.store.z && z < L.store.z + L.store.h - 1;
    if (!inside) break;
    if (!WALKABLE.has(L.tiles[z * L.w + x])) break;
    if (taken.has(`${x},${z}`)) break;
    n++;
  }
  return n;
}

/**
 * Build the boolean walk grid used by pathfinding.
 * Recomputed whenever the layout changes (rare), not per tick.
 */
export function buildWalkGrid(layout) {
  const grid = new Uint8Array(layout.w * layout.h);
  for (let i = 0; i < layout.tiles.length; i++) {
    grid[i] = WALKABLE.has(layout.tiles[i]) ? 1 : 0;
  }
  return grid;
}

export function isWalkable(grid, layout, x, z) {
  if (x < 0 || z < 0 || x >= layout.w || z >= layout.h) return false;
  return grid[z * layout.w + x] === 1;
}

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
