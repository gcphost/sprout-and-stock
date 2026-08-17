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
import {
  anchorTile, behindTile, queueAxis, queueLane, queueLanes, canPlace, canKeep, isProp,
  FLOOR_KIND, groundTile, padCells, ROAD_THICK,
} from '../shared/build.js';

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

/**
 * What the world is kept wide enough for, in plot columns a side.
 *
 * It used to be a placement rule as well — the farm grew outward from the path
 * four beds a side before starting a new row. The farm moved to the east flank
 * (see `farmX0`) and this is now only a *width*: the map stays big enough for a
 * farm of this span whether or not anybody has dug one, which is what keeps
 * `worldW` independent of how many beds you own. A world that got wider as you
 * bought plots would re-centre the building under a shop whose every fixture is
 * an absolute tile.
 */
const PLOTS_PER_SIDE = 4;

/**
 * How many rows the front needs, below the wall the door is in.
 *
 * Forecourt, pavement, road — `defaultStreet` lays the last two into the bottom
 * two paintable rows and this is the promise the generator makes it: nothing
 * procedural is placed in here. 8 because that is exactly what the starting
 * shop already had (`WORLD_H` 22, door line 14), so a shop that has not grown
 * comes out byte-identical to one generated before there was a street.
 */
const FRONT_DEPTH = 8;

/**
 * How far the building stands from the north edge — the depth of the yard.
 *
 * Two numbers, and which one you get is a fact about your shop rather than a
 * constant, which is the whole point.
 *
 * It was hardcoded at 2 for as long as the yard was two pads the generator drew
 * and nobody could touch. Two rows is barely a yard, and it is really *one*:
 * row 0 is the world's border ring, which `canPaintGround` refuses to everybody
 * — so the moment the pads became ground you paint, half the space behind your
 * shop was somewhere you could look at and never use.
 *
 * A shop that already exists does not move, and that is not a nicety. Every
 * fixture in a live save is a placement at an absolute tile; push the floor
 * three rows south and the entire contents of the building are suddenly outside
 * it, get dropped on the next re-flow and refunded. docs/building.md wrote the
 * old constant down specifically to stop that happening. So the position joins
 * `w` and `h` on the stored shell, and a save that predates the field reads as
 * the number it was built with — a read-time default rather than a migration,
 * the same bargain `kindOf` strikes for a row with no `kind`.
 */
const STORE_NORTH = 5;
const STORE_NORTH_LEGACY = 2;
const storeNorth = (shell) => {
  if (!shell) return STORE_NORTH;                       // a world nobody has stamped
  return Math.max(1, Math.trunc(shell.z ?? STORE_NORTH_LEGACY));
};

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
 * @param {object[]} opts.ground    ground the player laid, [{x, z, k, p}]. `k`
 *   is the ground KIND, which is what decides the tile — floor, delivery bay or
 *   storage — and `p` the design of it. `k` null means they took it back up,
 *   which is a thing that has to be recorded rather than simply absent: the
 *   shell stamps its whole footprint as floor, so "there is no floor here" is
 *   only expressible as an override.
 *
 *   Kind is stored beside the piece rather than looked up from it for the same
 *   reason a placement stores both: this function is pure and has never seen the
 *   catalog, and a generator that had to resolve a piece id to decide what a
 *   cell is made of would need one.
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
  ground = [],
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
    /** ...and the same again for ground, for exactly the same reason. */
    ground: ground ?? [],
    doorShift: Math.trunc(doorShift) || 0,
    // Whether this shop has been stamped, which `compose` needs for exactly one
    // decision: what a dropped placement does to the budget. See `shed`.
    shell: shell ?? null,
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
  const storeZ = storeNorth(req.shell);
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

  const pathZEnd = doorZ + 3;

  /**
   * The farm stands BESIDE the building, not in front of it.
   *
   * It flanked the path out of the front door for as long as there was nothing
   * else for the front to be — which put the fields between the shopper and the
   * shop, and left the one side of the building a customer ever sees looking
   * like the back of a smallholding. The front is the street now
   * (`defaultStreet`), the yard is still behind, and the fields went to the one
   * side that was empty grass in every generated world.
   *
   * East rather than west for no reason except that it has to be one of them,
   * and both are the same width: the building is centred, so the two margins are
   * equal by construction.
   *
   * It grows across first and then DOWN, which is the opposite of the old
   * outward-then-down and is what keeps the world compact — a column runs beside
   * the shop and then past the forecourt, where there is as much room as the
   * farm ever needs, instead of pushing the map wider for every four beds.
   */
  const farmX0 = store.x + store.w + 2;
  const farmCols = Math.max(1, Math.floor((worldW - 2 - farmX0) / ROW_PITCH) + 1);
  const plotTop = store.z;
  const plotRows = Math.max(1, Math.ceil(req.plots / farmCols));

  /**
   * How much room the front needs, below the doorway: forecourt, pavement, road.
   *
   * A floor under the world's height rather than a thing added to it, so a shop
   * that has not grown comes out at exactly `WORLD_H` and no existing save moves
   * — `doorLine + FRONT_DEPTH` is 22 for the starting building, which is what
   * `WORLD_H` already was.
   */
  const worldH = Math.max(
    WORLD_H,
    doorLine + FRONT_DEPTH,
    plotTop + plotRows * ROW_PITCH + FRONT_DEPTH,
  );

  const tiles = new Uint8Array(worldW * worldH).fill(T.GRASS);
  const idx = (x, z) => z * worldW + x;
  const set = (x, z, v) => {
    if (x >= 0 && z >= 0 && x < worldW && z < worldH) tiles[idx(x, z)] = v;
  };
  const at = (x, z) => (x < 0 || z < 0 || x >= worldW || z >= worldH ? -1 : tiles[idx(x, z)]);

  // What is *standing* on a cell, which used to be the same array as what the
  // cell is made of. Kept alongside rather than derived at the end, because
  // `canPlace` is asked about the half-built shop as it goes: every
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

  // ...and the same again in the back wall, opening onto the yard. Without it
  // every armful of stock walks the length of the building and round the
  // outside, twice, which is most of a working day spent on the grass. Cut
  // straight opposite the front door because the two rows behind the tills are
  // the ones the shelf loop already leaves clear (`shelfTop`), so the service
  // route is a corridor rather than a squeeze past an aisle end.
  //
  // Shoppers don't find it: they path to `L.door`, which is the front. This is
  // an opening in the walk grid, not a second entrance.
  setH(doorX, store.z, E.DOOR);
  setH(doorX + 1, store.z, E.DOOR);

  // ---- what the player has drawn by hand ----------------------------------
  // Applied over the generated shell, so knocking a wall through or adding a
  // back room survives every later re-flow.
  // Nothing generated is laid after this point, so an edit is simply the last
  // word on its line. The set of edited lines used to be kept as well, purely so
  // the procedural farm fence could avoid re-drawing itself over one — that
  // fence retired in step 11 and took the bookkeeping with it.
  for (const e of req.edits) {
    const ex = Math.round(e.x);
    const ez = Math.round(e.z);
    if (e.o === 'v') setV(ex, ez, e.k);
    else if (e.o === 'h') setH(ex, ez, e.k);
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

  // ---- the yard ------------------------------------------------------------
  // Two pads behind the building, either side of the service door.
  //
  // They used to be one pad, out front beside the path. Two problems with that,
  // and the second is the one that matters. It sat in the shoppers' eyeline —
  // the bay is the one part of a shop that is never tidy, and `spot: 'bay'` in
  // the pastime table has read "round the back, out of sight of the customers"
  // since before there was a back. And a delivery landing on the same tiles you
  // clear your hands onto is indistinguishable from what you put there: same
  // pallet, same pile, and no way to look at the yard and know which crates are
  // "shelve these" and which are "I'm holding these for a minute".
  //
  // Both rows of yard there are, z = store.z - 2 and store.z - 1. The building
  // is *not* pushed south to make more, and that is deliberate: every fixture
  // in a live save is a placement at an absolute tile, so moving the floor out
  // from under them would drop the shop's entire contents on the next re-flow.
  //
  // Anchored to the building rather than to the door, one pad at each end of
  // the back wall, so the door sits between them however far it has been
  // dragged and neither can ever land on top of the other.
  // ---- the ground the player laid -----------------------------------------
  //
  // Last of everything procedural, and first of everything the player owns, so
  // ground is the last word on what its cell is made of the same way an edit is
  // the last word on its line. Above this: the shell's footprint and the path
  // out to the fields. Below it: every placement, which is checked against the
  // ground as it finally is — so a shelf may stand on floor somebody painted
  // this morning.
  //
  // The two yard pads used to be stamped just above here, procedurally, against
  // the corners of the back wall — which is why you could never move them. They
  // are ground the player owns now, seeded once by `Game.freezeShell` the same
  // way the shop's fixtures are, and after that they are just painted cells:
  // editable, movable, and gone if you paint over them. So this loop is the ONLY
  // thing that writes a yard pad, and there is no procedural half left to
  // disagree with it.
  //
  // Only cells that ended up as something are carried out. A cell taken back up
  // is grass with nothing painted on it, which is the same thing as never having
  // been painted — so the emitted list stays a list of what IS, and a shop
  // nobody has redecorated emits an empty array.
  const groundOut = [];
  for (const f of req.ground) {
    const fx = Math.round(f.x);
    const fz = Math.round(f.z);
    if (fx < 0 || fz < 0 || fx >= worldW || fz >= worldH) continue;
    // What a painter can write is one of the ground kinds or GRASS, and nothing
    // else. If that ever grows an answer outside `GROUND`, every rule that reads
    // `tiles` has to be re-read with a painter in mind.
    const kind = f.k ?? (f.p ? FLOOR_KIND : null);
    const tile = kind ? groundTile(kind) : null;
    set(fx, fz, tile ?? T.GRASS);
    if (tile != null) groundOut.push({ x: fx, z: fz, k: kind, p: f.p ?? null });
  }

  // ---- where the pads ended up --------------------------------------------
  // Read back off the tiles rather than remembered from what was asked for, so
  // a pad is exactly the cells that really are one — including none, if you
  // painted over the lot. `padCells` is the same read `canPaintGround` uses to
  // decide whether a stroke takes your last bay away.
  const padRegion = (kind) => {
    const cells = padCells({ w: worldW, h: worldH, tiles }, kind);
    if (!cells.length) return null;
    // A point for whoever just needs somewhere to walk: the cell nearest the
    // middle of the region, which for the old 2x2 is one of its four and for an
    // L-shaped stockroom is inside it rather than in the notch.
    const mx = cells.reduce((a, c) => a + c.x, 0) / cells.length;
    const mz = cells.reduce((a, c) => a + c.z, 0) / cells.length;
    const mid = cells.reduce((best, c) => (
      Math.hypot(c.x - mx, c.z - mz) < Math.hypot(best.x - mx, best.z - mz) ? c : best
    ), cells[0]);
    return { x: mid.x, z: mid.z, cells };
  };
  const bay = padRegion('bay');
  const drop = padRegion('drop');
  // The third pad, and the only one nothing seeds: a shop opens without a break
  // area and its staff rest where the pastime says, which is what they did
  // before there was one to paint. `break` is a reserved word, so the local is
  // spelled out and the field is not — the layout speaks the kind's own name.
  const breakRoom = padRegion('break');

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
    w: worldW, h: worldH, tiles, edgesV, edgesH, indoor, store, door: { x: doorX, z: doorZ },
    bay, drop, break: breakRoom,
    spawn, approaches: approachList(),
    shelves: shelvesOut, checkouts: checkoutsOut, stations: stationsOut, plots: plotsOut,
    props: propsOut,
    ground: groundOut,
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

  /**
   * Let go of a placement — and, in a stamped shop, of the budget slot it held.
   *
   * That second half is the difference between a loss you can see and one that
   * arrives two actions later wearing a disguise, which is most of why the wall
   * bug read as "deleting randomly bugs out on shit".
   *
   * In a stamped shop the budget IS the placements (`budgetOf`), so every
   * placement either lands and spends its slot or drops and leaves it unspent —
   * and an unspent slot is an instruction to the procedural loops below. So the
   * shop that had just lost eight fixtures immediately grew eight *generated*
   * ones back, at the same tiles, and looked completely fine. The next re-flow
   * then recounted the budget off the placements that were left, asked for four,
   * and the shelves, the freezer and the till went for real — one wall's width
   * of damage, showing up a step after the wall.
   */
  const shed = (p) => {
    dropped.push(p);
    if (req.shell && budget[p.kind] > 0) budget[p.kind]--;
  };

  // Working spots already spoken for. Nothing may be *generated* onto one of
  // these — otherwise the generator happily drops a shelf onto the exact tile
  // you have to stand on to reach a shelf you positioned by hand, and you end
  // up with a fixture you can see but can never use. (Two fixtures *sharing* a
  // working spot is fine; a person only stands on one at a time.)
  //
  // *Generated*, and only generated — read `free` below and note that the loop
  // re-applying your own placements does not consult this. It used to, which
  // was the third arrival of the bug the comment under this one describes, and
  // the worst-hidden: a corner unit reserves the tile beside it along the other
  // wall, so the one square that continues the run was the one square you could
  // never keep. `placeFixture` warned you and charged you, this shed it on the
  // re-flow that same call triggers, and the refund made it look like the tap
  // had simply not registered. A reservation is the generator promising not to
  // build somewhere; it was never a rule about what you may do.
  const reserved = new Set();
  const reserve = (a) => a && reserved.add(`${a.x},${a.z}`);
  const free = (x, z) => at(x, z) === T.FLOOR
    && blocked[idx(x, z)] === 0
    && !reserved.has(`${x},${z}`);

  // ---- what the player has positioned by hand, honoured as placed ----------
  //
  // `canKeep`, NOT `canPlace`, and NOT `canPlaceCleanly`. Three entry points to
  // one rule, and this loop has now been the wrong one twice — both times with
  // the same symptom, a fixture vanishing a tick after you touched something
  // near it, and both times because a rule written for somebody putting a thing
  // DOWN was asked of the code re-applying what is already THERE.
  //
  // The second one is the reason `canKeep` exists. `where` is not a fact about
  // a shelf, it is a fact about the walls around the shelf — so knocking one
  // hole in your wall un-enclosed the building, every fixture in it read as
  // "outdoors", every one failed the indoor test, and the whole shop was
  // dropped and refunded on a gesture the game had called a warning. See
  // `canKeep` in shared/build.js. Physics still drops a placement; the walls
  // moving around one no longer does.
  //
  // The first one is below, and still worth keeping in view:
  //
  // `canPlace` gives two kinds of no: `ok: false` is physics,
  // and `ok: true` with a `warn` is a consequence you are allowed to cause —
  // wall a shelf in, stand a till where nobody can queue, turn a unit to face
  // the wall. That is the whole "warn, don't refuse" design, and `placeFixture`
  // and `rotateFixture` both honour it: they accept the warning and charge you.
  //
  // Then this loop re-judged the same placement with the STRICT variant, which
  // treats a warning as a refusal — so anything you were warned about was
  // accepted, paid for, and dropped on the very next re-flow, one tick later.
  // It came back as a full refund, so nothing was stolen; what you lost was the
  // fixture and whatever was on it, and what you saw was a shelf vanishing as
  // you turned it. Rotation was the worst of it because `rotateFixture`
  // deliberately settles for a warned facing when all three are warned, so a
  // unit in a corner had no angle that could survive.
  //
  // `canPlaceCleanly` is for the caller that cannot accept a warning on your
  // behalf — the generator furnishing a shop nobody has looked at, and the
  // balance bot building unattended. A fixture you positioned yourself is the
  // opposite of that: you were told what it would cost and you did it anyway.
  for (const p of req.placements) {
    const drop = () => {
      if (!allowDrops) return false;
      shed(p);
      return true;
    };

    // Decorations. Nothing procedural ever places one, so there is no budget to
    // spend and nothing to grow the building for: a prop exists exactly where
    // somebody put it or not at all. It stamps no tile either, which is why this
    // arm neither `set`s nor `reserve`s — the cell it stands in is still the
    // floor it was, and everything below flows over it as if it weren't there.
    if (isProp(p.kind)) {
      if (!canKeep(layoutSoFar(), p).ok) { shed(p); continue; }
      propsOut.push(makeProp(p));
      continue;
    }

    if (p.kind === 'station') {
      const i = stationQueue.indexOf(p.station);
      // An appliance whose upgrade has been sold isn't a fit problem, so this
      // one is always just dropped rather than grown for.
      if (i === -1) { shed(p); continue; }
      if (!canKeep(layoutSoFar(), p).ok) {
        // Same as `shed` does for a budget, for the queue an appliance is
        // counted in instead: in a stamped shop a dropped machine must not come
        // back as a generated one down the east wall.
        if (req.shell) stationQueue.splice(i, 1);
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
    if (!(budget[p.kind] > 0)) { shed(p); continue; }
    if (!canKeep(layoutSoFar(), p).ok) {
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
      // Both sides, or the generator fills the clerk's spot with a shelf on the
      // next re-flow and the till you hand-placed quietly stops being staffable.
      reserve(till.tendAt);
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
      // Back of house: staff use it, shoppers never see it. Carried across the
      // re-flow like the tier and the shape, because it is a decision somebody
      // made about this unit rather than a fact about its design — the same
      // shelving is a shop fitting out front and a pantry in the kitchen.
      shelf.boh = p.boh === true;
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
  // And the row the clerk works from, on the other side. Always interior floor
  // at any legal store height (MIN_STORE_H is 9 and this is `h - 4` in from the
  // north wall), so this guard is really about a hand-placed shelf having taken
  // the tile — the same thing the `serveRow` guard above is about.
  const tendRow = checkoutZ - 1;

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
    if (at(cx, tendRow) !== T.FLOOR || blocked[idx(cx, tendRow)]) continue;
    if (takenServe.has(`${cx},${serveRow}`)) continue;

    occupy(cx, checkoutZ);
    const till = makeCheckout(layoutSoFar(), `till-p${nTill}`, cx, checkoutZ, 1, checkoutsOut);
    if (till.queueMax < 1) { blocked[idx(cx, checkoutZ)] = 0; continue; }
    nTill++;
    checkoutsOut.push(till);
    reserve(till.serveAt);
    reserve(till.tendAt);
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
  // A tidy block down the east flank, across then down — see `farmX0`. The world
  // was sized for exactly this many rows, so nothing gets clipped.
  //
  // The bound is the FRONTAGE, not the map edge: a bed in the last few rows
  // would be a bed on the pavement, or in the road. `defaultStreet` lays those
  // two and `FRONT_DEPTH` is the agreement between them.
  const farmFloor = worldH - FRONT_DEPTH;
  let nPlot = 0;
  for (let i = 0; budget.plot > 0; i++) {
    if (i > req.plots * 8 + 64) break;         // belt and braces
    const px = farmX0 + (i % farmCols) * ROW_PITCH;
    const pz = plotTop + Math.floor(i / farmCols) * ROW_PITCH;
    if (pz > farmFloor || px < 1 || px > worldW - 2) continue;
    if (at(px, pz) !== T.GRASS) continue;
    set(px, pz, T.PLOT);
    plotsOut.push(makePlot(`plot-p${nPlot++}`, px, pz));
    budget.plot--;
  }
  // A taller building is what buys more farm: it pushes the door down, which
  // pushes `worldH` down with it, which is another row of flank to grow into.
  if (budget.plot > 0) return incomplete(layoutSoFar(), 'h');

  // ---- no fence ------------------------------------------------------------
  //
  // STEP 11. There used to be one here: a ring of fence edges hugging the
  // bounding box of wherever the plots had landed, drawn purely for looks. It
  // retires, and this note is the reason it isn't simply missing.
  //
  // A fence is an edge kind you can draw (`BUILD_TOOLS`, client/sections.js), and
  // the moment that was true the generated one stopped being scenery and started
  // being something in the way. It was derived from the plots, so it moved every
  // time you dug a bed and re-drew itself over anything you had built on that
  // line — `editedEdges` had to exist purely to stop it eating your own fencing,
  // which is the shape of an argument you are losing. And a fence you cannot own
  // is one you cannot take down: the one thing you would want to do to the ring
  // around your farm is put a gate in it.
  //
  // Nothing else read it. A fence never encloses (`ENCLOSING`, shared/edges.js),
  // so removing it moves no `indoor` mask and no tile; it is SOLID, so what
  // changes is that the way round the farm is open until you fence it yourself.

  const layout = layoutSoFar();

  // ---- the lane the van comes in on ---------------------------------------
  // Last of everything, because it is the only thing here that reads `blocked`
  // as it finally is: the border ring is one of the few places a hand placement
  // is legal, and a shelf somebody stood on it is in the way of a lorry.
  //
  // Computed once per finished layout rather than per tick, and never in
  // `layoutSoFar` — a probe that is about to be thrown away does not need a
  // road, and this loop runs across every bay cell.
  const vanLane = vanRoute(layout, bay);

  // ---- how long each line really is ---------------------------------------
  // Re-measured here rather than trusted from `makeCheckout`, because the
  // shelving goes in *after* the tills — so a lane measured then is a lane
  // measured through an aisle whose shelves did not exist yet. The direction is
  // kept: which way a queue faces is a decision made when the till was placed,
  // and re-deciding it on every re-flow would swing the line across the shop
  // every time somebody bought a freezer.
  for (const [id, lane] of queueLanes(layout)) {
    const till = checkoutsOut.find((c) => c.id === id);
    if (till) till.queueMax = lane.length - 1;
  }

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
      /** Where a wholesale order lands as a pallet. */
      bay,
      /** Where clearing your hands puts a crate. The other half of the yard. */
      drop,
      /** Where the staff take their breaks, if anybody has painted them one. */
      break: breakRoom,
      /**
       * The fixed lane a delivery van drives, or null if there is no way in.
       * `{ dock, in: [...], out: [...] }` — see `vanRoute`. The sim drives it
       * with `followPath` and never pathfinds.
       */
      vanRoute: vanLane,
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
      /**
       * Which design of floor is painted on each cell that has one.
       *
       * Sparse, and separate from `tiles` on purpose: `tiles` says what may
       * stand on a cell and this says what it looks like, and the day those
       * become one field is the day a paint colour can decide whether a shelf
       * fits. Empty for a shop nobody has redecorated.
       */
      ground: groundOut,
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
    /**
     * What is physically on it, one entry per KIND of thing — a board's worth.
     * `[{ item_id, qty, price, stockedDay }]`, and how many entries there may be
     * is `boardsOf`, read off the art (`shared/pieces.js`).
     *
     * A list rather than the four loose fields it replaced, because "there is
     * milk on this" stopped being a single answer the moment a unit could hold
     * milk and cheese. Each entry carries its OWN price and its own stocking
     * day: two things on one shelf are two things to price and two clocks to
     * rot on, and folding either onto the fixture would mean the cheese going
     * off because somebody restocked the milk.
     *
     * Empty is a bare unit. One entry is exactly what every shelf in the game
     * was before this, which is what makes the change invisible in a shop
     * nobody has ticked a second box on.
     */
    stacks: [],
    // What the player *decided* goes here, as opposed to `stacks`, which is
    // whatever happens to be on it. Empty means anything may. A LIST for the
    // same reason `stacks` is, and it is the list that decides how the unit is
    // shared out — see `shelfCapacity`. See `assignShelf`.
    assigned: [],
    /** Staff-only storage. Generated shelving is always shop floor. */
    boh: false,
    // Which shelf the next van fills. -1, 0 or 1 — see `restockQueue`.
    priority: 0,
  };
}

function makeCheckout(L, id, x, z, rot, existing) {
  const serveAt = anchorTile(x, z, rot);
  const taken = new Set(existing.map((c) => `${c.serveAt.x},${c.serveAt.z}`));
  const runs = queueAxis(rot).map((dir) => ({
    dir,
    n: queueLane(L, serveAt, dir, { claimed: taken }).length - 1,
  }));
  const best = runs[0].n >= runs[1].n ? runs[0] : runs[1];
  return {
    tier: 1,
    // Which shape it is. Empty means the kind's own model — Standard.
    variant: '',
    // ...and its kind, for the same reason `makeStation` carries one: a record
    // with no `kind` never resolves to a catalog row at all, so `fixtureStats`
    // hands back 1/1/1 and the tier ladder above it is decoration. Harmless
    // while nothing read a till's tier; the moment `serveSeconds` did, every
    // till in the game would have been permanently tier 1.
    kind: 'checkout',
    id,
    x,
    z,
    rot,
    // Where shoppers stand to be served, and which way the line sets off.
    serveAt,
    /**
     * And the other side — where whoever is working it stands.
     *
     * Stored rather than derived at the point of use for the same reason
     * `serveAt` is: staff, the validator and the ghost all have to agree on one
     * tile, and three callers each doing their own arithmetic off `rot` is
     * three chances to disagree. It was `till.z - 1` in `server/sim/staff.js`
     * until this field existed, which is this arithmetic done once, wrongly,
     * for one facing out of four.
     */
    tendAt: behindTile(x, z, rot),
    queueDir: best.dir,
    /**
     * Slots behind the front one — how long the line came out when this shop
     * was laid, corners included, not how far it runs in a straight line.
     *
     * Advisory, and deliberately so. It picks which way the queue faces here,
     * guards a till with nowhere at all to put shopper #2, and is what the
     * fixture menu prints. Where people actually *stand* is `Game.laneOf`,
     * walked against the finished shop every time the walk grid is rebuilt —
     * this is measured mid-compose, when the shelves that will share the aisle
     * with the line may not have been placed yet.
     */
    queueMax: best.n,
  };
}

function makeStation(id, station, x, z, rot) {
  return {
    tier: 1,
    // Which shape it is. Empty means the kind's own model — Standard.
    variant: '',
    id,
    // Its own kind, and the one field a shelf carried that this didn't.
    //
    // `pieceFor` matches on `piece` AND `kind`, so a record with no kind never
    // resolved to a catalog row at ALL — it fell through to `defaultPiece` of
    // `undefined`, which is nothing, so `fixtureStats` handed back 1/1/1 for
    // every appliance in the game. Which means the shipped Commercial tier has
    // been selling `speed_mult: 2` for $340 and delivering nothing since the
    // day it was authored, and no screenshot and no log line would ever say so:
    // the machine still works, it is simply never any faster.
    kind: 'station',
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
    // Which of its recipes this machine is set to. Null means nobody has said,
    // which reads as the first one it knows — see `Game.stationRecipe`. A
    // decision, the way a shelf's `assigned` is, and it survives the same two
    // things: a re-flow (`carryOver`) and a restart (`persist`).
    recipe: null,
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

// ---------------------------------------------------------------------------
// The van's lane
// ---------------------------------------------------------------------------

/**
 * How far off the map the van starts and finishes.
 *
 * Same number and same argument as `APPROACH_OUT`: far enough that it is not
 * seen popping into being, close enough that the drive in is not most of the
 * journey. Kept as its own constant rather than shared, because the two would
 * be argued about separately the moment either changes — a shopper appearing
 * is a body and this is a lorry.
 */
const VAN_OFF = 8;

/**
 * Ground a vehicle drives on. Deliberately NOT `WALKABLE`.
 *
 * A plot is walkable and a van does not drive over somebody's carrots; a door
 * is walkable and a van does not drive through the shop. Everything left is
 * outdoor going: grass, the path, an outdoor floor somebody paved, the road,
 * and the three pads, which are the one kind of ground whose whole job is that
 * things arrive on them.
 */
const DRIVABLE = new Set([T.GRASS, T.PATH, T.FLOOR, T.BAY, T.DROP, T.PARK, T.ROAD]);

/**
 * What a cell costs to drive over, and the only thing `T.ROAD` does.
 *
 * A road is a *preference*, not a permission — see `GROUND.road`. Every cell in
 * `DRIVABLE` is drivable whether or not anybody painted it, and these two
 * numbers decide only which of several legal lanes the finder picks: a route
 * over tarmac wins until it is more than twice as long as the one across the
 * grass.
 *
 * **A shop with no road painted comes out exactly where it did before this
 * existed**, and that is arithmetic rather than a promise. Every cell then
 * costs the same, so every candidate is scaled by one constant, and scaling
 * both sides of `best.cost <= cost` compares the same two lanes in the same
 * order — including the ties, which is what stops a lane moving on a re-flow
 * for a shop that has never seen a road.
 */
const ROAD_COST = 1;
const OFF_ROAD_COST = 2;

/**
 * How anything with wheels gets from the edge of the map to one cell of this
 * shop, and back. The lorry uses it for the bay; a shopper's car uses it for
 * the space it parks in.
 *
 * **A vehicle is not a person, and this is the whole reason this exists rather
 * than a `findPath` call.** A* walks the same tile grid a shopper walks, and it
 * is *right* for a shopper: it threads between planters, turns on the spot, and
 * takes whichever gap is shortest. A lorry doing that reads as a bug in the
 * renderer. So there is no pathfinding here at all — a vehicle gets a fixed
 * route, computed once per layout, and drives it with `followPath` the same way
 * a customer walks a path A* handed them. Whether the way is clear is decided
 * HERE, once, rather than re-asked every tick by something with wheels.
 *
 * The route is two straight legs and one turn:
 *
 *   1. a **spur**, straight out of the cell to the border ring, and
 *   2. a **run along the ring** to the cheaper end of that border, off the map.
 *
 * Both are straight lines of drivable cells, which is what makes them a lane
 * rather than a path: nothing in either can be walked round, so a shelf on the
 * ring is not an obstacle to steer past, it is a lane that does not exist. Every
 * direction is tried and the cheapest total drive wins — `ROAD_COST` is what
 * "cheapest" means and the only thing a painted road changes — so a bay out the
 * front, or down the east side, gets its own way in for free, and one walled in
 * on all four sides returns null. The sim reads that as "no van today" and lands
 * the goods the way it did before there was anything to look at, which is the
 * honest half: a shop whose yard nobody can drive to must still get the stock it
 * paid for.
 *
 * It is a factory rather than a function because the three closures inside it
 * are the expensive half and a car park asks the same question a dozen times.
 *
 * @returns {(cell: {x,z}) => ({cost, spur, ring, entry}|null)}
 */
function laneFinder(L) {
  const drivable = (x, z) => {
    if (x < 0 || z < 0 || x >= L.w || z >= L.h) return false;
    const i = z * L.w + x;
    return DRIVABLE.has(L.tiles[i]) && !L.blocked[i] && !L.indoor[i];
  };

  // What one cell of driving costs. The road's entire mechanism — see
  // `ROAD_COST`. Read off `tiles` rather than off the ground overlay, because
  // which DESIGN of road you painted is a look and this is not: two roads of
  // different colours must steer a van identically, the same claim
  // `verify:floor` makes about floors.
  const cellCost = (x, z) => (L.tiles[z * L.w + x] === T.ROAD ? ROAD_COST : OFF_ROAD_COST);

  // Straight out of `b` until the world runs out. Null if anything is in the
  // way — there is no going round, that is the point.
  const spur = (b, dx, dz) => {
    const cells = [];
    let cost = 0;
    for (let x = b.x + dx, z = b.z + dz; drivable(x, z); x += dx, z += dz) {
      cells.push({ x, z });
      cost += cellCost(x, z);
      const off = x + dx < 0 || z + dz < 0 || x + dx >= L.w || z + dz >= L.h;
      if (off) return { cells, cost };         // reached the border ring
    }
    return null;
  };

  // ...and along the border the spur came out on, to whichever end of it is
  // cheaper and clear. `axis` is the one the road runs on, which is always the
  // one the spur did not: a spur north hits row 0, and row 0 runs east-west.
  const ringLeg = (ring, axis) => {
    const span = axis === 'x' ? L.w : L.h;
    const here = axis === 'x' ? ring.x : ring.z;
    let best = null;
    for (const step of [-1, 1]) {
      const end = step < 0 ? 0 : span - 1;
      let clear = true;
      let cost = 0;
      for (let a = here + step; step < 0 ? a >= end : a <= end; a += step) {
        const x = axis === 'x' ? a : ring.x;
        const z = axis === 'x' ? ring.z : a;
        if (!drivable(x, z)) { clear = false; break; }
        cost += cellCost(x, z);
      }
      if (!clear) continue;
      if (best && best.cost <= cost) continue;
      const from = end + step * VAN_OFF;
      best = {
        cost,
        entry: axis === 'x' ? { x: from, z: ring.z } : { x: ring.x, z: from },
      };
    }
    return best;
  };

  /** The cheapest way off the map from one cell, or null if there is none. */
  return (cell) => {
    let best = null;
    for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const lane = spur(cell, dx, dz);
      if (!lane) continue;
      const ring = lane.cells[lane.cells.length - 1];
      const leg = ringLeg(ring, dz === 0 ? 'z' : 'x');
      if (!leg) continue;
      const cost = lane.cost + leg.cost;
      if (best && best.cost <= cost) continue;
      best = { cost, spur: lane.cells, ring, entry: leg.entry };
    }
    return best;
  };
}

/**
 * Three points for two legs, and the route both ways.
 *
 * A waypoint in the middle of a straight is a waypoint nobody turns at, so the
 * lane is only ever its ends and its one corner. The ring cell and the stop
 * collapse into one when the vehicle is parking against the border already — it
 * drives up the road and halts without ever turning off, and a repeated point
 * would be a waypoint reached before it was set out for.
 */
function laneVia(entry, ring, stop) {
  const inbound = [entry, ring, stop].filter((p, i, all) => (
    i === 0 || p.x !== all[i - 1].x || p.z !== all[i - 1].z
  ));
  return {
    dock: { ...stop },
    in: inbound.map((p) => ({ ...p })),
    out: [...inbound].reverse().map((p) => ({ ...p })),
  };
}

/**
 * The one lane the delivery van drives, best-of over every cell of the bay.
 *
 * It stops one cell SHORT of the pad rather than on it: goods land on the bay —
 * `dropGoods` picks the cells, as it does for everything else — and a van parked
 * on top of the crates it just put down is a picture of the wrong thing.
 */
function vanRoute(L, bay) {
  if (!bay?.cells?.length) return null;
  const bestFrom = laneFinder(L);

  let best = null;
  for (const b of bay.cells) {
    const lane = bestFrom(b);
    if (!lane) continue;
    if (best && best.cost <= lane.cost) continue;
    best = lane;
  }
  if (!best) return null;

  // `best.spur[0]` is the first cell outside the pad — see above.
  return laneVia(best.entry, best.ring, best.spur[0]);
}

/**
 * ...and one lane per parking space, which is what a shopper's car comes in on.
 *
 * Three things differ from the van's, and only the first is arithmetic.
 *
 * **A car stops ON its space**, where the van stops one short of the pad. The
 * van's reason not to is that goods land on the bay; a car puts nothing down,
 * and a space with the car beside it rather than in it is a car park that does
 * not work.
 *
 * **It is per cell rather than best-of.** One bay takes one van, so its lane is
 * a property of the yard; a car park is a dozen independent spaces and each
 * needs its own way in. Hence a list in and a list out, with the finder built
 * once — the closures are the expensive half and this is the caller that asks
 * a dozen times.
 *
 * **Null is ordinary here**, where for the van it is the walled-in yard. A space
 * with no straight run out is perfectly usable parking; what it loses is the
 * drive, not the space. See `parkSpaces` for why that distinction had to be
 * kept — dropping those cells would quietly move the balance, because how many
 * spaces there are is what catchment reads.
 *
 * @returns {({dock,in,out}|null)[]} one per cell, in the order given
 */
export function carLanes(L, cells) {
  if (!cells?.length) return [];
  const bestFrom = laneFinder(L);
  return cells.map((cell) => {
    const best = bestFrom(cell);
    return best ? laneVia(best.entry, best.ring, cell) : null;
  });
}

function makePlot(id, x, z) {
  return {
    tier: 1,
    // Which shape it is. Empty means the kind's own model — Standard.
    variant: '',
    // And the same missing field, found the same way and costing real money:
    // `plotGrowth` reads `fixtureStats(plot).speed_mult` off the raw layout
    // record, which resolved to no catalog row, so the shipped Raised Bed tier
    // has been charging $90 for `speed_mult: 1.6` and growing crops at exactly
    // the old rate. Nothing says so in play — a bed you paid to improve looks
    // improved, and "crops feel slow" is not a bug report anybody files.
    kind: 'plot',
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

/**
 * The yard pads a shop starts life with, as ground for somebody to own.
 *
 * This is the *seed*, not the rule. `Game.freezeShell` lays these once, the
 * first time a world is stamped, and from that moment they are ordinary painted
 * cells — the generator never looks at this again, and nothing re-applies it.
 * That is the whole difference from what was here before: the pads used to be
 * re-stamped on every single re-flow, which is why moving one was impossible
 * rather than merely unimplemented. Buying a shelf put it back.
 *
 * Four cells each, at the two ends of the back wall, which is where the
 * generator used to put them — so an existing shop and a brand-new one hold the
 * same number of crates in the same corners of the yard on the day this lands.
 *
 * They run four ALONG the wall rather than as the 2x2 the generator drew, and
 * that is not cosmetic. **The seed must only lay ground the player could lay
 * themselves**, or the pads are not really theirs. The yard is the two rows
 * north of the building and the building starts at z=2, so a 2x2 has half of
 * itself on row 0 — and row 0 is the world's border, which `canPaintGround`
 * refuses to anybody. A pad you can delete three quarters of is worse than one
 * you cannot delete at all, because it looks like it worked.
 *
 * They are laid with no design (`p: null`) on purpose. A pad with no piece
 * renders in the tile's own palette colour — `surfaceOf` falls back — so the
 * seed does not have to reach for the catalog, and a world stamped before
 * anybody authored a bay design still gets a bay.
 */
export const PAD_SEED_W = 4;

export function defaultPads(L) {
  // The row immediately behind the building, never the border.
  const z = Math.max(1, L.store.z - 1);
  const out = [];
  const pad = (px, kind) => {
    const x0 = clampInt(px, 1, L.w - 1 - PAD_SEED_W);
    for (let dx = 0; dx < PAD_SEED_W; dx++) {
      const cx = x0 + dx;
      // Grass only, the same test the procedural version made: a shop pushed
      // hard against the north edge of the world has less yard than this wants.
      if (L.tiles[z * L.w + cx] === T.GRASS) out.push({ x: cx, z, k: kind, p: null });
    }
  };
  pad(L.store.x, 'bay');
  pad(L.store.x + L.store.w - PAD_SEED_W, 'drop');
  return out;
}

/**
 * The street out front: a road along the bottom of the world, a pavement above
 * it, and a walk up to the door.
 *
 * `defaultPads`' argument, pointed at the front of the building instead of the
 * back. The yard was generated furniture until it became ground somebody owns;
 * the frontage was never anything at all — a shop opened onto a lawn, and the
 * only thing telling you which side was the front was which way the door faced.
 *
 * Three claims, and the third is the one that makes it worth seeding rather
 * than leaving to the palette:
 *
 * - **The seed may only lay ground the player could lay.** `canPaintGround`
 *   refuses the border ring, so the road is the bottom *paintable* row rather
 *   than the map edge. A street you can only delete three quarters of is worse
 *   than no street, because it looks like it worked — the lesson the first
 *   version of the yard cost.
 * - **It is ground, so it is yours.** Move it, widen it, tear it out, pave the
 *   whole forecourt. Nothing here is a rule; the road prefers itself to the
 *   grass and the pavement does the same for feet, and both of those are
 *   preferences the player can re-point somewhere else.
 * - **No car park.** Deliberately, and not for tidiness: `parkReach` feeds
 *   `catchment`, so a seeded pad would change what a new shop earns on day one
 *   and every balance number taken before today would be measuring a different
 *   game. The road is the invitation; where the cars stop is the player's
 *   decision, and it is the one this whole feature is for.
 *
 * Offered as cells, never placed — see `freezeYard`, which is the one caller and
 * the thing that guarantees it happens once. An existing shop has that mark set
 * already, which is exactly why no save grows a road overnight.
 */
export function defaultStreet(L) {
  const out = [];
  const lay = (x, z, kind) => {
    if (x < 1 || z < 1 || x >= L.w - 1 || z >= L.h - 1) return;
    if (L.tiles[z * L.w + x] !== T.GRASS) return;
    out.push({ x, z, k: kind, p: null });
  };

  // The bottom paintable rows, all the way across: the road, then the pavement
  // between it and the shop. `ROAD_THICK` rather than a 2 written here, because
  // the brush lays that many and a seeded road narrower than a drawn one would
  // be the world shipping something the player cannot reproduce — the yard's
  // rule about laying only what the player could lay, said about width.
  const walkZ = L.h - 2 - ROAD_THICK;
  for (let x = 1; x < L.w - 1; x++) {
    for (let d = 0; d < ROAD_THICK; d++) lay(x, L.h - 2 - d, 'road');
    lay(x, walkZ, 'path');
  }

  // ...and the walk up to the door, which meets the strip the generator lays
  // out of the doorway. Two cells wide, because the doorway is.
  for (let z = L.door.z + 1; z < walkZ; z++) {
    lay(L.door.x, z, 'path');
    lay(L.door.x + 1, z, 'path');
  }
  return out;
}

/**
 * The awning over the front door, as decorations for somebody to own.
 *
 * The same seed-not-rule argument `defaultPads` makes, one step further along.
 * The awning used to be four striped boxes the *renderer* drew over `L.door` on
 * every re-flow (`addAwning`, client/render/scene.js) — so it was not a thing at
 * all: nothing could aim at it, nothing could price it, and there was no way to
 * get rid of it or to put a second one anywhere else. A shop front you may not
 * change is scenery, and this game has one place for scenery, which is behind
 * the camera.
 *
 * Four one-tile sections in the row immediately outside the doorway, facing
 * south (`rot: 1` — quarter turns clockwise from "front to the east"), so the
 * canopy projects out over the path exactly where the drawn one hung. Each
 * section is its own placement, which is the whole point of doing it a tile at
 * a time: you can tear out one, run six along a longer frontage, or restyle the
 * lot without any of them being a special case.
 *
 * It offers cells rather than placing them. Whether one may actually stand on
 * a given cell is `canPlace`'s question and nobody else's — see `freezeAwning`,
 * which asks it — because the seed must only lay what the player could lay.
 */
export function defaultAwning(L) {
  const z = L.door.z + 1;
  const out = [];
  // Centred on the two-cell doorway, which puts one section either side of it:
  // the drawn awning was four tiles wide starting one west of `door.x`.
  for (let dx = -1; dx <= 2; dx++) out.push({ x: L.door.x + dx, z, rot: 1 });
  return out;
}
