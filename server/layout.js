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
import { E, eviOf, ehiOf, computeIndoor } from '../shared/edges.js';
import { anchorTile, queueAxis, canPlaceCleanly, isProp } from '../shared/build.js';

export { T };

// Minimum world size. The world actually grows to fit whatever you own — a
// fixed grid either wastes space early or runs out of room once the farm gets
// big, and both look bad. Deliberately snug: extra ground is just extra
// walking between the till and the fields.
export const WORLD_W = 26;
export const WORLD_H = 22;

/**
 * Smallest a shop can be, measured in usable floor. Everything grows up from
 * here. This was 11 when the rect included a wall ring that ate a tile a side;
 * every cell is floor now, so 9 keeps the starting shop exactly the size it was
 * and leaves the balance alone.
 */
const MIN_STORE_W = 9;
const MIN_STORE_H = 9;

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
 * @param {object} [opts.shell]     a building that already exists, {w, h}. Given
 *   one, this stops searching for a size and builds exactly that — see below.
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
  edits = [],
  shell = null,
} = {}) {
  const req = {
    seed, shelves, freezers, checkouts, plots, stations,
    placements: placements ?? [],
    // Walls, windows and doorways the player drew. An overlay for the same
    // reason `placements` is one: the generator rebuilds the shell from scratch
    // on every re-flow, so anything hand-built has to be re-applied on top or a
    // shelf purchase quietly demolishes your back room.
    edits: edits ?? [],
    doorShift: Math.trunc(doorShift) || 0,
  };

  // ---- a building that already exists ------------------------------------
  //
  // STEP 4, and the whole of it. A shop with a stored shell is not searched for
  // any more: it is built at the size it already is, once, and everything in it
  // arrives as a placement. Nothing below this line can then move under you —
  // which is what "stamp once" means, and why `droppedPlacements` stopped being
  // something that happens in ordinary play.
  //
  // Why the shell has to be *stored* rather than re-derived: with every fixture
  // a placement, the budgets are all zero, so the size search below would find
  // that a 9x9 holds everything it was asked for (nothing) and shrink the
  // building back to the minimum — stranding every placement outside it. The
  // size of your shop is a fact about your shop, not a function of your
  // shopping list.
  if (shell) {
    const attempt = compose(req, Math.max(MIN_STORE_W, Math.trunc(shell.w)),
      Math.max(MIN_STORE_H, Math.trunc(shell.h)), true);
    // A stamped shop's ledger is in step with its placements by construction, so
    // there is nothing procedural left to fail to fit. If that ever stops being
    // true the symptom is a shop that quietly loses its shelving, which is worth
    // a line in the log rather than a silent empty building.
    if (!attempt.complete) {
      console.warn('[layout] stored shell cannot hold what the ledger asks for', {
        shell, shelves: req.shelves, freezers: req.freezers, checkouts: req.checkouts,
      });
    }
    return attempt.layout;
  }

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

  // The last row of shop floor. Walls sit on the boundary *between* cells now,
  // so the doorway is an edge on the line below this row rather than a tile of
  // its own — which is why every "outside" measurement below still reads
  // `doorZ + 1` exactly as it did when doorZ was the wall itself.
  const doorZ = store.z + store.h - 1;
  const doorLine = store.z + store.h;
  // Two cells wide, roughly centred, jittered by seed, and nudged by however
  // far the player has dragged it. Clamped so a run of wall remains either side.
  const doorX = clampInt(
    store.x + Math.floor(store.w / 2) + rng.int(-1, 1) + req.doorShift,
    store.x, store.x + store.w - 2,
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

  // What is *standing* on a cell, which used to be the same array as what the
  // cell is made of. Kept alongside rather than derived at the end, because
  // `canPlaceCleanly` is asked about the half-built shop as it goes: every
  // fixture placed has to be visible to the next one's reachability flood.
  const blocked = new Uint8Array(worldW * worldH);
  const occupy = (x, z) => {
    if (x >= 0 && z >= 0 && x < worldW && z < worldH) blocked[idx(x, z)] = 1;
  };

  // ---- shell --------------------------------------------------------------
  // Every cell of the rect is shop floor. The walls are the ring of edges
  // around it, which is where the two tiles per side that the old wall ring
  // used to eat come back from.
  const edgesV = new Uint8Array((worldW + 1) * worldH);
  const edgesH = new Uint8Array(worldW * (worldH + 1));
  const setV = (x, z, v) => {
    if (x >= 0 && z >= 0 && x <= worldW && z < worldH) edgesV[eviOf(worldW, x, z)] = v;
  };
  const setH = (x, z, v) => {
    if (x >= 0 && z >= 0 && x < worldW && z <= worldH) edgesH[ehiOf(worldW, x, z)] = v;
  };

  for (let z = store.z; z < store.z + store.h; z++) {
    for (let x = store.x; x < store.x + store.w; x++) set(x, z, T.FLOOR);
  }
  for (let z = store.z; z < store.z + store.h; z++) {
    setV(store.x, z, E.WALL);
    setV(store.x + store.w, z, E.WALL);
  }
  for (let x = store.x; x < store.x + store.w; x++) {
    setH(x, store.z, E.WALL);
    setH(x, doorLine, E.WALL);
  }
  setH(doorX, doorLine, E.DOOR);
  setH(doorX + 1, doorLine, E.DOOR);

  // ---- what the player has drawn by hand ----------------------------------
  // Applied over the generated shell, so knocking a wall through or adding a
  // back room survives every later re-flow.
  const editedEdges = new Set();
  for (const e of req.edits) {
    const ex = Math.round(e.x);
    const ez = Math.round(e.z);
    if (e.o === 'v') setV(ex, ez, e.k);
    else if (e.o === 'h') setH(ex, ez, e.k);
    else continue;
    editedEdges.add(`${e.o}:${ex},${ez}`);
  }

  // What the walls close in. Computed once, here, rather than per query: the
  // build ghost asks `insideStore` sixty times a second, and only an edge can
  // change the answer. Fences are stamped further down and never enclose, so
  // nothing below this line moves it.
  const indoor = computeIndoor({ w: worldW, h: worldH, edgesV, edgesH });

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

  // ---- where shoppers walk on from ----------------------------------------
  // The edge of the map, not a point in the middle of the field. A customer
  // blinking into existence five tiles south of the door and evaporating on the
  // same spot is the one thing that most gave away that the world stops at the
  // fence — so arrivals start *off* the grid and walk in, and leavers walk back
  // off it before they despawn.
  //
  // `off` is deliberately outside the tile grid: it's a position, never a
  // pathing goal. A* routes between the edge tile and the door, and the last
  // few metres in from nowhere are a straight line tacked onto that path.
  //
  // Four along the south edge (that's the side the path and the fence gap are
  // on, so it's the short walk), one each on the east and west flanks below the
  // building. Nothing on the north edge: arriving behind the shop means walking
  // the entire perimeter, which reads as a lost tourist rather than a shopper.
  // How far off the grid they appear. Has to clear the view or you just watch
  // them blink into being on the grass instead of in the middle of the field:
  // at the default zoom the camera sees about 9 tiles ahead of the player, and
  // the map edge is already ~11 from someone standing at a till, so 8 more puts
  // the arrival comfortably off-screen. Zoomed all the way out you can still
  // catch one appearing, but by then it's a few pixels at the horizon.
  const APPROACH_OUT = 8;
  const approachSpots = [];
  for (let i = 1; i <= 4; i++) {
    const x = clampInt((worldW * i) / 5, 1, worldW - 2);
    approachSpots.push({ x, z: worldH - 1, off: { x, z: worldH - 1 + APPROACH_OUT } });
  }
  for (let i = 1; i <= 2; i++) {
    const z = clampInt(doorZ + ((worldH - doorZ) * i) / 3, doorZ + 1, worldH - 2);
    approachSpots.push({ x: 0, z, off: { x: -APPROACH_OUT, z } });
    approachSpots.push({ x: worldW - 1, z, off: { x: worldW - 1 + APPROACH_OUT, z } });
  }

  const spawn = { x: doorX, z: Math.min(worldH - 2, doorZ + 5) };

  // Checked against the tiles as they finally are, not as they were planned:
  // a hand-placed fixture is allowed to sit on the perimeter, and an approach
  // buried under one would spawn shoppers inside it. Falling back to `spawn`
  // keeps the old behaviour rather than a shop nobody can ever reach.
  const approachList = () => {
    const open = approachSpots.filter((a) => WALKABLE.has(at(a.x, a.z)));
    return open.length > 0 ? open : [{ ...spawn, off: { ...spawn } }];
  };

  // ---- what the player has positioned by hand ------------------------------
  // Applied before anything procedural, so the generator flows around the
  // player's choices rather than fighting them.
  const shelvesOut = [];
  const checkoutsOut = [];
  const stationsOut = [];
  const plotsOut = [];
  const propsOut = [];
  const layoutSoFar = () => ({
    w: worldW, h: worldH, tiles, edgesV, edgesH, indoor, store, door: { x: doorX, z: doorZ }, bay,
    spawn, approaches: approachList(),
    shelves: shelvesOut, checkouts: checkoutsOut, stations: stationsOut, plots: plotsOut,
    props: propsOut,
    blocked,
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
  const free = (x, z) => at(x, z) === T.FLOOR
    && blocked[idx(x, z)] === 0
    && !reserved.has(`${x},${z}`);

  for (const p of req.placements) {
    const drop = () => {
      if (!allowDrops) return false;
      dropped.push(p);
      return true;
    };

    // Decorations. Nothing procedural ever places one, so there is no budget to
    // spend and nothing to grow the building for: a prop exists exactly where
    // somebody put it or not at all. It stamps no tile either, which is why this
    // arm neither `set`s nor `reserve`s — the cell it stands in is still the
    // floor it was, and everything below flows over it as if it weren't there.
    if (isProp(p.kind)) {
      if (!canPlaceCleanly(layoutSoFar(), p).ok) { dropped.push(p); continue; }
      propsOut.push(makeProp(p));
      continue;
    }

    if (p.kind === 'station') {
      const i = stationQueue.indexOf(p.station);
      // An appliance whose upgrade has been sold isn't a fit problem, so this
      // one is always just dropped rather than grown for.
      if (i === -1) { dropped.push(p); continue; }
      if (reserved.has(`${p.x},${p.z}`) || !canPlaceCleanly(layoutSoFar(), p).ok) {
        if (!drop()) return incomplete(layoutSoFar(), null);
        continue;
      }
      stationQueue.splice(i, 1);
      occupy(p.x, p.z);
      const st = makeStation(p.id, p.station, p.x, p.z, p.rot ?? 2);
      st.tier = p.tier ?? 1;
      st.variant = p.variant ?? '';
      st.piece = p.piece ?? null;
      stationsOut.push(st);
      reserve(st.useAt);
      continue;
    }
    if (!(budget[p.kind] > 0)) { dropped.push(p); continue; }
    if (reserved.has(`${p.x},${p.z}`) || !canPlaceCleanly(layoutSoFar(), p).ok) {
      if (!drop()) return incomplete(layoutSoFar(), null);
      continue;
    }
    budget[p.kind]--;
    if (p.kind === 'plot') {
      set(p.x, p.z, T.PLOT);
      plotsOut.push(Object.assign(makePlot(p.id, p.x, p.z), {
        tier: p.tier ?? 1, variant: p.variant ?? '', piece: p.piece ?? null,
      }));
    } else if (p.kind === 'checkout') {
      occupy(p.x, p.z);
      const till = makeCheckout(layoutSoFar(), p.id, p.x, p.z, p.rot ?? 1, checkoutsOut);
      till.tier = p.tier ?? 1;
      till.variant = p.variant ?? '';
      till.piece = p.piece ?? null;
      checkoutsOut.push(till);
      reserve(till.serveAt);
    } else {
      occupy(p.x, p.z);
      const shelf = makeShelf(p.id, p.kind, p.x, p.z, p.rot ?? 0);
      shelf.tier = p.tier ?? 1;
      shelf.variant = p.variant ?? '';
      // Which design it is, carried across the re-flow exactly as the tier and
      // the shape are. A procedural fixture leaves it null on purpose: nobody
      // chose one, so it draws as whatever its kind currently defaults to, and
      // redrawing that kind reaches every unit the generator ever laid.
      shelf.piece = p.piece ?? null;
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
    if (at(cx, serveRow) !== T.FLOOR || blocked[idx(cx, serveRow)]) continue;
    if (takenServe.has(`${cx},${serveRow}`)) continue;

    occupy(cx, checkoutZ);
    const till = makeCheckout(layoutSoFar(), `till-p${nTill}`, cx, checkoutZ, 1, checkoutsOut);
    if (till.queueMax < 1) { blocked[idx(cx, checkoutZ)] = 0; continue; }
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
      if (blocked[idx(stationX - 1, sz)]) continue;   // nowhere to stand and work
      occupy(stationX, sz);
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
      // Nowhere to browse from. Both halves: floor, and nothing standing on it.
      if (at(sx + 1, sz) !== T.FLOOR || blocked[idx(sx + 1, sz)]) continue;
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
    occupy(x, z);
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

    // A fence is edges too, so it costs the farm no ground at all. It never
    // encloses (see ENCLOSING in shared/edges.js) — fencing a field must not
    // quietly roof it.
    for (let x = fenceLeft; x <= fenceRight; x++) {
      // Leave a gap where the path runs out of the shop.
      if (x === doorX || x === doorX + 1) continue;
      if (!editedEdges.has(`h:${x},${fenceTop}`)) setH(x, fenceTop, E.FENCE);
      if (!editedEdges.has(`h:${x},${fenceBottom + 1}`)) setH(x, fenceBottom + 1, E.FENCE);
    }
    for (let z = fenceTop; z <= fenceBottom; z++) {
      if (!editedEdges.has(`v:${fenceLeft},${z}`)) setV(fenceLeft, z, E.FENCE);
      if (!editedEdges.has(`v:${fenceRight + 1},${z}`)) setV(fenceRight + 1, z, E.FENCE);
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
      /** Walls, windows and doorways, on the boundaries between cells. */
      edgesV: Array.from(edgesV),
      edgesH: Array.from(edgesH),
      /** Which cells the walls close in. See insideStore in shared/build.js. */
      indoor: Array.from(indoor),
      /**
       * Which cells have something standing in them. Derived from the fixture
       * lists below rather than authored, and emitted rather than recomputed by
       * every reader — pathing asks this per step and the build ghost asks it
       * per cell of a flood fill, sixty times a second.
       */
      blocked: Array.from(blocked),
      store,
      door: { x: doorX, z: doorZ },
      doorShift: req.doorShift,
      /** Where pallets land and where you can put things down. */
      bay,
      /** Where players clock on, and the anchor for "is outside still reachable". */
      spawn: layout.spawn,
      /** Map-edge tiles shoppers walk on from and back off to. */
      approaches: layout.approaches,
      shelves: shelvesOut,
      checkouts: checkoutsOut,
      stations: stationsOut,
      plots: plotsOut,
      /** Decorations. Placed only, never generated. */
      props: propsOut,
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
    tier: 1,
    // Which shape it is. Empty means the kind's own model — Standard.
    variant: '',
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
    tier: 1,
    // Which shape it is. Empty means the kind's own model — Standard.
    variant: '',
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
    tier: 1,
    // Which shape it is. Empty means the kind's own model — Standard.
    variant: '',
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

/**
 * A decoration, straight off its placement.
 *
 * The only fixture constructor that reads its whole self from what the player
 * asked for, because that is all a prop is: no working spot to derive, no queue
 * to measure, no contents. `kind` and `piece` both ride along — the kind because
 * where a hanging lamp may go is not where a planter may go, the piece because
 * the kind alone no longer says what to draw.
 */
function makeProp(p) {
  return {
    id: p.id,
    kind: p.kind,
    piece: p.piece ?? p.kind,
    x: p.x,
    z: p.z,
    rot: p.rot ?? 0,
    tier: p.tier ?? 1,
    variant: p.variant ?? '',
  };
}

function makePlot(id, x, z) {
  return {
    tier: 1,
    // Which shape it is. Empty means the kind's own model — Standard.
    variant: '',
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
    // Both halves. The ground has to be walkable AND nothing may be standing on
    // it — one array said both until fixtures stopped stamping tiles, and a
    // walk grid built from the ground alone routes shoppers through shelving.
    grid[i] = WALKABLE.has(layout.tiles[i]) && !layout.blocked?.[i] ? 1 : 0;
  }
  return grid;
}

export function isWalkable(grid, layout, x, z) {
  if (x < 0 || z < 0 || x >= layout.w || z >= layout.h) return false;
  return grid[z * layout.w + x] === 1;
}

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
