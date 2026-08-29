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
  FLOOR_KIND, groundTile, padCells, ROAD_THICK, shelfKind, FIXTURE_KINDS, FIXTURES,
  footprint, sizeOf, deckOf, CEILING, LIFT_WAYS, rot4, sorterRoute, mergeRoute,
  standableSide,
} from '../shared/build.js';
import { LOT_KINDS } from '../shared/lot.js';

export { T };

// Minimum world size. The world actually grows to fit whatever you own — a
// fixed grid either wastes space early or runs out of room once the farm gets
// big, and both look bad. Deliberately snug: extra ground is just extra
// walking between the till and the fields.
export const WORLD_W = 26;
export const WORLD_H = 22;

/**
 * Smallest a shop can be, measured in usable floor. Everything grows up from
 * here, and the search above grows it until what was asked for genuinely fits —
 * so this is a *floor*, never a size, and lowering it makes small shops small
 * rather than making any shop too small to work.
 *
 * It was 11 when the rect included a wall ring that ate a tile a side, then 9
 * to keep the six-shelf starting shop exactly the size it had been. Both of
 * those were reverse-engineered from a starting shop that no longer exists: the
 * smallest tier opens with two shelves and a cooler (`shared/start.js`), and at
 * a floor of 9 that came out as a 9x9 hall with three fixtures in it and the
 * counter a long walk from the door — which reads as the game being slow, not
 * as the building being too big for what is in it.
 *
 * 7 is where the shelf loop's own arithmetic bottoms out rather than a number
 * picked to look tidy: `shelfBottom` is `store.z + h - 5` and `shelfTop` is
 * `store.z + 2`, so a building shorter than 7 has nowhere at all to put a unit
 * and every size below it is a probe the search throws away. Ask for more than
 * a couple of shelves and you get more than this — a mini-mart and a
 * supermarket come out at the sizes they always did, because their contents are
 * what decides.
 */
const MIN_STORE_W = 7;
const MIN_STORE_H = 7;

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
/**
 * Exported for the ONE other reader that has to answer the same question from
 * outside a layout: `planOf` in server/worlds.js draws a save's floor plan for
 * the front door without generating one, so it has to place the building the
 * same way this file would. A second literal `2` over there is the `shell.z`
 * strike waiting to happen again — a shop drawn two tiles off its own farm.
 */
export const STORE_NORTH_LEGACY = 2;
const storeNorth = (shell) => {
  if (!shell) return STORE_NORTH;                       // a world nobody has stamped
  return Math.max(1, Math.trunc(shell.z ?? STORE_NORTH_LEGACY));
};

/**
 * ...and the same question on the other axis, which only became a question the
 * day the WORLD could grow.
 *
 * The building has always been centred east-west — `(worldW - storeW) / 2`,
 * derived fresh every re-flow — and that was safe for exactly as long as
 * `worldW` was a constant. Now that land is bought, a re-derived centre slides
 * the whole building sideways the moment you buy any, and every fixture in it
 * is an absolute tile: the shop would move out from under its own contents, and
 * `applyPlacements` would hand the strays back with a refund. That is the
 * `shell.z` disaster exactly (see `Game.buyUpgrade`), on the axis nobody had
 * pinned.
 *
 * So a stamped shop remembers where it stands. A shell written before this
 * field falls back to `baseW` — the width the world would be with no land
 * bought — which is where it is standing right now, because no save that
 * predates the field can have bought land under the new rule. `WORLD_W` alone
 * would not do: a shop with a big building or a wide farm already sits in a
 * world wider than the minimum, and centring it in the minimum would move it.
 */
const storeWest = (shell, worldW, storeW, baseW) => {
  if (!shell) return Math.floor((worldW - storeW) / 2);
  if (shell.x == null) return Math.floor((baseW - storeW) / 2);
  return Math.max(1, Math.trunc(shell.x));
};

/**
 * How far apart the generator spaces things, and it is three numbers now
 * because they were one number doing three jobs.
 *
 * `COL_PITCH` is a unit and the aisle you browse it from: 2, so the floor plan
 * reads unit / aisle / unit / aisle, the way shelving in a shop actually
 * stands. It was 3, which laid a whole DEAD column between every aisle and the
 * next run of units — invisible in a big shop, where there is other stuff in
 * the way, and the entire complaint in a small one: three fixtures in a
 * seven-wide building with a corridor of nothing between each of them.
 *
 * `ROW_PITCH` is what a unit and the next unit *behind* it need, which is
 * nothing at all: they share the aisle beside them, so a run of shelving is
 * solid down the column, which is what a run of shelving is. It stays 2 for the
 * appliances below, which are worked from the tile at their side and want the
 * elbow room, and for the world-width reservation the farm makes.
 *
 * `PLOT_PITCH` was the farm, and 1 for the same reason: a bed IS the ground, you
 * stand on the one you are picking, so beds laid touching are a field. At 2
 * four beds were a dotted diagonal line strung eight tiles down the flank, and
 * what that reads as is the farm having been scattered rather than planted.
 *
 * IT IS TWO NUMBERS NOW, and the split is exactly the shelf's — because a rack
 * is exactly a shelf. The day `plot` started blocking its cell, a packed square
 * of them stopped being a field and became a solid block, and a bed in the
 * middle of one has no side anybody can stand on: nine plots came out as a 3x3
 * with an unreachable centre, which `canPlaceCleanly` refuses and the generator
 * then reports as `incomplete`. A dotted diagonal is still the wrong answer, and
 * it is not the only alternative — `SHELF_ROW_PITCH`/`ROW_PITCH` have laid runs
 * of shelving with an aisle between them since there were aisles. So: touching
 * along the row, a gap between rows. A grow room is racks and aisles.
 *
 * Both together, or neither is right. Along alone is the block again; between
 * alone is the diagonal the old comment threw out.
 */
const COL_PITCH = 2;
const SHELF_ROW_PITCH = 1;
const ROW_PITCH = 2;
const PLOT_COL_PITCH = 1;
const PLOT_ROW_PITCH = 2;

/**
 * Generate the whole world.
 *
 * @param {object} opts
 * @param {string|number} opts.seed
 * @param {number} opts.shelves     how many plain shelf units to place
 * @param {number} opts.freezers    how many freezer units to place
 * @param {number} opts.checkouts   how many tills
 * @param {number} opts.plots       how many farm plots
 * @param {number} opts.pens        how many animal pens (placed only)
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
 *
 *   `u` is the optional second half — `{k, p}`, the LOOK remembered under a job,
 *   which is what stops a floor dragged across your stockroom taking the storage
 *   away with it (`groundPaint`, `shared/build.js`). It is carried out because
 *   the build ghost reads it, and it decides nothing here: `k` is the tile, and
 *   a cell with a floor under its delivery bay is a delivery bay.
 * @param {object} [opts.shell]     a building that already exists, {w, h}. Given
 *   one, this stops searching for a size and builds exactly that — see below.
 */
export function generateLayout({
  seed = 'sprout-1',
  shelves = 4,
  freezers = 0,
  // Never generated, only ever re-applied from a placement — so unlike the
  // three around it this is always whatever `budgetOf` counted, and 0 for every
  // shop that has not bought one.
  warmers = 0,
  // Placed only — a shop is never generated one, so this is always whatever
  // `budgetOf` counted and 0 for every shop that has never bought one.
  bins = 0,
  // Placed only, both of them, for the same reason `bins` is: nothing
  // procedural lays a conveyor, so these are always whatever `budgetOf`
  // counted and 0 for every shop that has never built one.
  belts = 0,
  arms = 0,
  sorters = 0,
  unders = 0,
  lifts = 0,
  packers = 0,
  checkouts = 1,
  plots = 4,
  // Placed only, for `bins`' reason: nothing procedural puts an animal in a
  // shop, so this is always whatever `budgetOf` counted and 0 for every shop
  // that has never bought one.
  pens = 0,
  stations = [],
  placements = [],
  grow = { w: 0, h: 0 },
  doorShift = 0,
  edits = [],
  ground = [],
  shell = null,
} = {}) {
  const req = {
    seed, shelves, freezers, warmers, bins, belts, arms, sorters, unders, lifts, packers, checkouts, plots, pens, stations,
    placements: placements ?? [],
    // Walls, windows and doorways the player drew. An overlay for the same
    // reason `placements` is one: the generator rebuilds the shell from scratch
    // on every re-flow, so anything hand-built has to be re-applied on top or a
    // shelf purchase quietly demolishes your back room.
    edits: edits ?? [],
    /** ...and the same again for ground, for exactly the same reason. */
    ground: ground ?? [],
    doorShift: Math.trunc(doorShift) || 0,
    /**
     * Land you bought, in extra world tiles east and south — NOT extra
     * building. See `compose`, where it is applied, and the note in stage 2
     * below for why it moved.
     */
    grow: grow ?? { w: 0, h: 0 },
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

  // Stage 2: build at that size.
  //
  // Bought land used to be added HERE, as extra building — `space` grew the
  // shell and the shell re-stamped its walls three tiles further out. That is
  // the wrong shape for a game where you draw your own rooms: what you had
  // customised got a new outer wall stamped past it and the old one left
  // stranded inside as a line to knock through, and the thing you actually
  // wanted more of — ground to build ON — only appeared once the building had
  // grown past `WORLD_W - 8`. `grow` is the world's size now (see `compose`),
  // and the building is only ever as big as its own contents need.
  for (const allowDrops of [false, true]) {
    let storeW = fitW;
    let storeH = fitH;
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

  // ---- world size, sized around the building, the fields and what you own --
  //
  // `grow` is bought LAND, and it is the world's size rather than the
  // building's. Everything the shop is made of is something you draw — walls on
  // edges, floor with a brush, fixtures on tiles you picked — so the thing an
  // extension should sell is somewhere to draw it, not a bigger box stamped
  // around what you already drew.
  const growW = Math.max(0, Math.trunc(req.grow?.w ?? 0));
  const growH = Math.max(0, Math.trunc(req.grow?.h ?? 0));
  const farmHalfSpan = 2 + (PLOTS_PER_SIDE - 1) * ROW_PITCH;
  // The two widths a stamped shop needs to tell apart: what the world would be
  // with no land bought, and what it is. See `storeWest`.
  const baseW = Math.max(WORLD_W, storeW + 8, farmHalfSpan * 2 + 10);
  const worldW = Math.max(baseW, WORLD_W + growW);

  const storeX = storeWest(req.shell, worldW, storeW, baseW);
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
   *
   * ...and it grows across only as far as it has to. `farmCols` used to be
   * however many beds the map was wide enough for, which laid every farm as a
   * single long row: four beds came out as a line eight tiles down the flank
   * with a gap between each, so the whole of a starting farm was further from
   * the back door than the far corner of the shop. Roughly square and packed
   * (`PLOT_COL_PITCH`/`PLOT_ROW_PITCH`), so a field is a field.
   *
   * ...and it sits at the BACK of that flank, level with the north wall, which
   * is where the yard is. It was bottom-aligned with the door for one round, on
   * the argument that the shop is entered from the south so the shortest walk
   * to a bed should start at the front — and that is true of the *player* and
   * wrong about the shop: goods come off a bed and go to the drop-off, which is
   * behind the building, so a farm by the front door is every armful of crop
   * carried the length of the shop. It also puts the fields between the street
   * and the shopfront, which is what moving the farm off the front path fixed.
   *
   * One clear tile off the east wall. That column is where an annex hangs off
   * the building — a bed standing in it is ground you may not build on — so the
   * farm may come in as far as it likes except for that.
   *
   * ⚠️ NOTHING IS LAID OUT HERE ANY MORE. The plots went indoors — see "the grow
   * corner" below — and what is left of this is a *height*: `worldH` reserves
   * the rows the field would have taken. It is kept rather than deleted, and
   * the reason is the one `shell.z` gives. The term only ever binds on a shop
   * with a lot of beds (about 24 of them, on the starting building), and for
   * one of those, taking it away shortens the map — so every absolute tile
   * south of the old field goes off the end of the world, and `compose` sheds
   * and refunds whatever was standing on it. A world that is a few rows of
   * spare grass too tall costs nothing; one that is two rows too short quietly
   * bulldozes the far end of somebody's car park.
   */
  const farmX0 = store.x + store.w + 2;
  const farmRoom = Math.max(1, Math.floor((worldW - 2 - farmX0) / PLOT_COL_PITCH) + 1);
  const farmCols = Math.max(1, Math.min(farmRoom, Math.ceil(Math.sqrt(Math.max(1, req.plots)))));
  const plotRows = Math.max(1, Math.ceil(req.plots / farmCols));
  const plotTop = store.z;

  /**
   * How much room the front needs, below the doorway: forecourt, pavement, road.
   *
   * A floor under the world's height rather than a thing added to it, so a shop
   * that has not grown comes out at exactly `WORLD_H` and no existing save moves
   * — `doorLine + FRONT_DEPTH` is 22 for the starting building, which is what
   * `WORLD_H` already was.
   */
  // ...plus bought land, the same way the width takes it. Only the south edge
  // moves: the building is pinned to `storeZ` and everything in it is an
  // absolute tile, so growing northward would push the whole shop off its own
  // contents — which is the `shell.z` disaster in CLAUDE.md.
  /**
   * ...and the term that says BOUGHT DEPTH ACTUALLY ARRIVES, which is the third
   * one and is the only one written against the shop rather than a constant.
   *
   * `WORLD_H + growH` is what promised it and it is a promise about a shop the
   * size the game shipped with. The moment a building is tall enough that
   * `doorLine + FRONT_DEPTH` passes it, that term stops binding and land you
   * paid for simply does not appear: the world comes back the size it was, with
   * nothing anywhere to say why. It was latent for as long as the farm was
   * outdoors and it is not any more, because a grow corner is rows of building
   * where a field was rows of grass.
   *
   * `STORE_NORTH + store.h` rather than `doorLine`, and that is the whole care
   * needed. `grow` deliberately HAS NO SIDES — north and west are the same pair
   * of numbers as south and east, and what puts the land on the far side is
   * `growWorld` sliding everything over (see `buyUpgrade`). So a northward
   * purchase has already moved `store.z`, and a term measured from the door
   * would count it twice: 20 rows bought north would hand out 20 more of
   * southern grass as well. Measured from where an unshifted shop's north wall
   * would be, the answer is the same whichever side the land landed on.
   */
  const worldH = Math.max(
    WORLD_H + growH,
    doorLine + FRONT_DEPTH,
    STORE_NORTH + store.h + FRONT_DEPTH + growH,
    plotTop + plotRows * PLOT_ROW_PITCH + FRONT_DEPTH,
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

  // ...and the front of it is GLAZED, because the door line is the one side of
  // the building anybody who has not been in has ever seen, and a blank run of
  // render either side of the door reads as the back of the shop from the only
  // angle the camera gives you. `WINDOW_FULL` is a LOOK of the wall (`GLAZING`)
  // rather than a kind of its own — SOLID, enclosing, same price — so nothing
  // the sim reads moves, which is what makes this safe to do to a shell that is
  // regenerated on every re-flow rather than stamped once. Two things it is
  // not: it is not free, because `EDGE_CHARM` pays for glass wherever it is, so
  // every shop now opens a little more charming than a concrete box; and it is
  // not permanent, because `req.edits` is applied below and has the last word
  // on its line, so a player who walls a pane back up keeps the wall.
  //
  // The corners stay solid — a pane wants a pier to stop against — and a door
  // clamped hard against one (`doorX` can be) simply leaves that flank blank.
  for (let x = store.x + 1; x < store.x + store.w - 1; x++) {
    if (x === doorX || x === doorX + 1) continue;
    setH(x, doorLine, E.WINDOW_FULL);
  }

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
    if (tile == null) continue;
    // Rebuilt field by field rather than spread, which is `surfaceOf`'s trap and
    // is deliberate: what crosses into the layout is a closed list. `u` — the
    // look remembered under a job — is here because the GHOST reads it. It moves
    // no tile and never could: the tile is `k`'s, one line up, and a second
    // opinion about that is the two-layer shape docs/building.md turned down.
    const out = { x: fx, z: fz, k: kind, p: f.p ?? null };
    if (f.u?.p) out.u = { k: f.u.k, p: f.u.p };
    groundOut.push(out);
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
  const pensOut = [];
  const propsOut = [];
  const binsOut = [];
  const beltsOut = [];
  const armsOut = [];
  const sortersOut = [];
  const undersOut = [];
  const liftsOut = [];
  const packersOut = [];
  const layoutSoFar = () => ({
    w: worldW, h: worldH, tiles, edgesV, edgesH, indoor, store, door: { x: doorX, z: doorZ },
    bay, drop, break: breakRoom,
    spawn, approaches: approachList(),
    shelves: shelvesOut, checkouts: checkoutsOut, stations: stationsOut, plots: plotsOut,
    pens: pensOut,
    props: propsOut, bins: binsOut, belts: beltsOut, arms: armsOut, sorters: sortersOut,
    unders: undersOut, lifts: liftsOut, packers: packersOut,
    ground: groundOut,
    blocked,
  });

  /**
   * How many of each kind this pass may lay, spent by placements first.
   *
   * Derived from `FIXTURE_KINDS` rather than written out, and that is the whole
   * of the fix for a bug the hot counter found. This was four literal keys, and
   * the check below is `if (!(budget[p.kind] > 0)) shed(p)` — so a kind nobody
   * remembered to add a line for is a fixture that can be BUILT, is charged for,
   * and is then dropped and refunded by the re-flow that same purchase
   * triggers. It reads as the shop refusing a purchase it had just accepted,
   * with the money handed back so nothing looks stolen.
   *
   * `warmer` has no procedural loop and that is deliberate rather than
   * unfinished: nothing generates a hot counter, so its budget is only ever
   * whatever placements the player made (`budgetOf`), and it is spent entirely
   * by re-applying them. `totalUnits` below is untouched for the same reason —
   * a warmer must never come out of the shelf loop.
   */
  const budget = Object.fromEntries(FIXTURE_KINDS.map((k) => [k, 0]));
  Object.assign(budget, {
    shelf: req.shelves,
    freezer: req.freezers,
    warmer: req.warmers,
    bin: req.bins,
    belt: req.belts,
    arm: req.arms,
    sorter: req.sorters,
    under: req.unders,
    lift: req.lifts,
    packer: req.packers,
    checkout: req.checkouts,
    plot: req.plots,
    pen: req.pens,
  });
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
  /**
   * The squares a SHAFT owns, which it owns on both storeys.
   *
   * `conveyorAt` gives a lift's square to the lift on each deck — that is what
   * lets a run on either one hand to it — so any other conveyor cell standing
   * on that square is not a second run. It is a cell nothing in the game can
   * address: no feeder can name it, its own hand-off is never travelled, and
   * the renderer strips it (`conveyorBody` drops a belt sharing a lift's roof),
   * so it cannot even be pointed at to be deleted.
   *
   * `conveyorSwap` stops a new one being made, in both orders. This is the same
   * rule said about the ones that ALREADY EXIST — laid before that fix, by the
   * obvious build order: draw the duct, then drop a shaft under it. A keeping
   * rule rather than a migration, for `canKeep`'s own reason: an unaddressable
   * cell is not a fact about the cell, it is a fact about what is standing next
   * to it, so it has to be re-answered every re-flow rather than once.
   *
   * Gathered before the loop because placements are in build order and the
   * shaft is usually the LATER of the two — asked as we go, the belt is already
   * in `beltsOut` by the time its lift turns up.
   */
  const shaftSquares = new Set((req.placements ?? [])
    .filter((p) => p.kind === 'lift').map((p) => `${p.x},${p.z}`));

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
    // ...and a conveyor standing on a SHAFT'S square is a cell nothing can ever
    // address again — see `shaftSquares`. Refunded like any other shed, so the
    // orphan a save has been carrying costs nothing to be rid of.
    if (p.kind !== 'lift' && FIXTURES[p.kind]?.flow && shaftSquares.has(`${p.x},${p.z}`)) {
      if (!drop()) return incomplete(layoutSoFar(), null);
      continue;
    }
    if (!canKeep(layoutSoFar(), p).ok) {
      if (!drop()) return incomplete(layoutSoFar(), null);
      continue;
    }
    budget[p.kind]--;
    if (p.kind === 'plot') {
      // Ground AND occupant, which a bed was not: it stamped its tile and stood
      // on nothing, so a shopper walked through the carrots. A rack blocks like
      // any other unit and reserves the side you pick from — the till's shape,
      // arriving at the farm.
      set(p.x, p.z, T.PLOT);
      occupy(p.x, p.z);
      const bed = Object.assign(makePlot(p.id, p.x, p.z, p.rot ?? 2), {
        tier: p.tier ?? 1, variant: p.variant ?? '', piece: p.piece ?? null,
      });
      plotsOut.push(bed);
      reserve(bed.useAt);
    } else if (p.kind === 'pen') {
      // A hutch stands ON its cell rather than being it, so this is the till's
      // and the skip's shape rather than the bed's: occupy, and reserve the gate
      // you collect from. What it holds and how far through the current batch it
      // is are NOT here — those live on the layout record and ride a re-flow
      // through `carryOver`, exactly as a bed's crop and clock do.
      // EVERY cell it covers. `canKeep` above has already agreed all four are
      // free — this is the half that makes them stop being free, and a block
      // that only stamped its corner is a fixture three quarters of which
      // shoppers walk straight through.
      for (const c of footprint('pen', p.x, p.z)) occupy(c.x, c.z);
      const pen = makePen(p.id, p.x, p.z, p.rot ?? 2);
      pen.tier = p.tier ?? 1;
      pen.variant = p.variant ?? '';
      pen.piece = p.piece ?? null;
      pensOut.push(pen);
      reserve(pen.useAt);
    } else if (p.kind === 'bin') {
      // Its own branch, and the `else` below is why it needs one: everything
      // that is not a plot, a till or an appliance falls through to
      // `makeShelf`, which normalises whatever it is handed into shelving. A
      // bin with no branch is not refused, it is silently BUILT AS A SHELF —
      // the exact shape CLAUDE.md records the hot counter dying in twice.
      occupy(p.x, p.z);
      const bin = makeBin(p.id, p.x, p.z, p.rot ?? 2);
      bin.tier = p.tier ?? 1;
      bin.variant = p.variant ?? '';
      bin.piece = p.piece ?? null;
      binsOut.push(bin);
      reserve(bin.useAt);
    } else if (p.kind === 'belt') {
      // No `occupy`: a belt is walked over. The tile stamp is doing the work
      // `blocked` does for everything else — it is what makes the square a
      // conveyor, and it is what refuses the second belt on it, exactly as
      // `T.PLOT` refuses the second bed.
      //
      // ...and OVERHEAD it does neither, which is the whole of what a ceiling
      // run buys: the square underneath keeps its floor, its walk grid and its
      // right to hold a shelf. `canPlace` does the refusing up there instead,
      // because there is no tile left to do it.
      if (deckOf(p) !== CEILING) set(p.x, p.z, T.BELT);
      const belt = makeBelt(p.id, p.x, p.z, p.rot ?? 0);
      belt.tier = p.tier ?? 1;
      belt.variant = p.variant ?? '';
      belt.piece = p.piece ?? null;
      belt.deck = deckOf(p);
      // ...and how it settles a MERGE, which is the one thing a plain belt has
      // ever had to decide. Carried across from the placement with the same trap
      // `sorter.auto` and `reject` name: this record is rebuilt from scratch on
      // every re-flow, and build mode re-flows on every wall segment of a drag,
      // so a setting left out here is one that clears itself behind you while
      // you are still drawing.
      belt.merge = mergeRoute(p);
      beltsOut.push(belt);
      // Nothing reserved. A belt has no working spot, so there is no tile the
      // generator has to keep clear for it.
    } else if (p.kind === 'under') {
      // A mouth IS a belt cell, but unlike the buried span its visible housing
      // occupies the square. What it does NOT do is stamp or occupy anything on
      // the cells it reaches over: those belong to nobody, which is the entire
      // feature. An overhead mouth has no floor footprint, like every other
      // ceiling conveyor.
      if (FIXTURES[p.kind]?.blocks && deckOf(p) !== CEILING) occupy(p.x, p.z);
      if (deckOf(p) !== CEILING) set(p.x, p.z, T.BELT);
      const under = makeUnder(p.id, p.x, p.z, p.rot ?? 0);
      under.tier = p.tier ?? 1;
      under.variant = p.variant ?? '';
      under.piece = p.piece ?? null;
      under.deck = deckOf(p);
      // ...and whether this mouth comes up onto the OTHER storey — the sorter's
      // own field, on the piece that is now the same mechanism. Carried across a
      // re-flow with the rest, or every wall segment you drag puts the shop's
      // tunnels back on the floor behind you.
      under.riser = p.riser === true;
      // ...and who goes first where two lines meet on it, carried for the reason
      // the line above is carried — see the belt branch.
      under.merge = mergeRoute(p);
      undersOut.push(under);
    } else if (p.kind === 'lift') {
      // The one piece on both storeys, so it stamps and occupies the floor cell
      // like the housing it is — you cannot walk through the column.
      occupy(p.x, p.z);
      set(p.x, p.z, T.BELT);
      const lift = makeLift(p.id, p.x, p.z, LIFT_WAYS.includes(p.way) ? p.way : null, p.rot ?? 0);
      lift.tier = p.tier ?? 1;
      lift.variant = p.variant ?? '';
      lift.piece = p.piece ?? null;
      // ...and its merge — two runs arriving on one square is the ordinary way
      // two storeys of a loop rejoin. Same trap as `way` above.
      lift.merge = mergeRoute(p);
      liftsOut.push(lift);
    } else if (p.kind === 'arm') {
      // A loader is a belt cell by its STAMP and not by its footprint, and those
      // two came apart the day it became a housing. It still sets `T.BELT` — that
      // is what makes the square a conveyor and what refuses a second piece on it
      // — and it also occupies, because it is a waist-high machine you would walk
      // into. See `FIXTURES.arm`.
      //
      // Asked of the table rather than written here, which is the whole point of
      // this line existing: `blocks` was flipped in `shared/build.js` and this
      // branch went on saying "same non-blocking" in a comment, so `canPlace`
      // refused the cell and the walk grid never heard about it. What that looks
      // like is shoppers strolling straight through the machine — a rule that is
      // enforced in one of the two places it has to be is not half enforced, it
      // is off.
      // Overhead it does neither — see the belt branch. A loader four metres up
      // is not a machine you walk into.
      if (FIXTURES[p.kind]?.blocks && deckOf(p) !== CEILING) occupy(p.x, p.z);
      if (deckOf(p) !== CEILING) set(p.x, p.z, T.BELT);
      const arm = makeArm(p.id, p.x, p.z, p.rot ?? 0);
      arm.tier = p.tier ?? 1;
      arm.variant = p.variant ?? '';
      arm.piece = p.piece ?? null;
      arm.deck = deckOf(p);
      // Which half of its job it does. Carried across a re-flow like a sorter's
      // `auto`, or every wall segment you drag hands the shop's loaders back
      // their pickup behind you.
      arm.mode = p.mode === 'load' || p.mode === 'unload' ? p.mode : 'both';
      // ...and its merge, on the same terms and for the same reason: a loader
      // stands IN a run, so it is a square two lines can arrive at.
      arm.merge = mergeRoute(p);
      armsOut.push(arm);
      // Nothing occupied and nothing reserved — see `makeArm`.
    } else if (p.kind === 'sorter') {
      // A sorter is a belt cell by its stamp too, and wears the loader's housing
      // — so the same pair, read from the same table. The only thing it has that
      // a belt has not is a second way out, and that is read at tick time off
      // `rot` rather than reserved here.
      if (FIXTURES[p.kind]?.blocks && deckOf(p) !== CEILING) occupy(p.x, p.z);
      if (deckOf(p) !== CEILING) set(p.x, p.z, T.BELT);
      const sorter = makeSorter(p.id, p.x, p.z, p.rot ?? 0);
      sorter.riser = p.riser === true;
      sorter.tier = p.tier ?? 1;
      sorter.variant = p.variant ?? '';
      sorter.piece = p.piece ?? null;
      sorter.deck = deckOf(p);
      // Whether the crew choose its branch for it. Carried across a re-flow like
      // a shelf's `managed`, or every wall segment you drag turns the shop's
      // sorters back on behind you.
      sorter.auto = p.auto !== false;
      // A junction can favour a leg — the straight-through one, or the one it is
      // aimed at — without giving up the item-aware routing that `auto` means.
      // Older saves have no `route` at all, so `sorterRoute` reads the pair
      // together and their two existing answers stay smart and alternate.
      sorter.route = sorterRoute(p);
      // ...and the side rejects go down, for the same reason and with the same
      // trap: a re-flow rebuilds this record from the placement, so a field left
      // out here is one that clears itself on the next wall you draw.
      sorter.reject = Number.isInteger(p.reject) ? p.reject : null;
      // ...and who goes first where two lines meet ON it, which is the other
      // half of a T. Carried with the same trap as the three above, and it
      // matters most here: a sorter is what people build where lines meet, so
      // this is the junction the setting is usually made on.
      sorter.merge = mergeRoute(p);
      sortersOut.push(sorter);
    } else if (p.kind === 'packer') {
      // A belt cell by its stamp, a machine by its footprint — the loader's
      // pair, read from the same table for the same reason. See `FIXTURES.arm`
      // for what happens when this branch and `shared/build.js` disagree.
      if (FIXTURES[p.kind]?.blocks && deckOf(p) !== CEILING) occupy(p.x, p.z);
      if (deckOf(p) !== CEILING) set(p.x, p.z, T.BELT);
      const packer = makePacker(p.id, p.x, p.z, p.rot ?? 0);
      packer.tier = p.tier ?? 1;
      packer.variant = p.variant ?? '';
      packer.piece = p.piece ?? null;
      packer.deck = deckOf(p);
      // What it has been told to build, which is the one field it has that a
      // belt has not. Carried across the re-flow with the same trap `mode`,
      // `auto` and `reject` each name: build mode re-flows on every wall
      // segment of a drag, so a tick list left out here is one that clears
      // itself behind you while you are still drawing.
      packer.assigned = Array.isArray(p.assigned) ? p.assigned.slice(0, LOT_KINDS) : [];
      // ...and its merge, because a packer stands IN a run and is therefore a
      // square two lines can arrive at.
      packer.merge = mergeRoute(p);
      packersOut.push(packer);
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
  // at any legal store height (MIN_STORE_H is 7 and this is `h - 4` in from the
  // north wall, so the tightest legal building still leaves three rows between
  // it and the back wall), so this guard is really about a hand-placed shelf
  // having taken the tile — the same thing the `serveRow` guard above is about.
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
  /**
   * The first column of shelving, and therefore the width of the grow corner.
   *
   * It was written inline in the shelf loop as `store.x + 2` and it is named
   * here because a second thing depends on it now. Everything west of it is
   * clear floor by construction — a unit at `sx` is browsed from `sx + 1`, so
   * the loop starting two in leaves the two columns against the west wall
   * untouched — and that, plus the two rows above `shelfTop`, is the only
   * interior the generator has never had a use for. The racks go there. Which
   * means the two numbers have to agree or they are not a corner: widen the
   * grow block by hand and it lands under the first aisle, narrow the shelf
   * loop and there is a column of shop floor nobody can reach.
   */
  const shelfX0 = store.x + 2;
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
  for (let sx = shelfX0; sx < store.x + store.w - 1; sx += COL_PITCH) {
    if (stationsOut.length && sx >= stationX - 1) break;
    for (let sz = shelfTop; sz <= shelfBottom; sz += SHELF_ROW_PITCH) {
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

  // ---- the grow corner -----------------------------------------------------
  /**
   * THE FARM CAME INDOORS, and this is the last place that had not heard.
   *
   * A plot was a bed you dug into grass: it stamped `T.PLOT`, you stood ON it
   * to work it, and a field of them down the east flank was the whole of what
   * a farm looked like. It is a grow rack now (docs/vats.md) — a unit that
   * blocks its cell and is worked from the aisle in front, `where: 'any'`, and
   * therefore a thing that belongs in the building with the shelving rather
   * than out on the lawn. So a starting shop was opening with four of them out
   * in a field, which is not a legacy layout so much as a picture of a
   * mechanic the game no longer has.
   *
   * The BACK-LEFT corner: along the back wall from the west end, then down two
   * rows and again. The top two rows of the interior are the strip nothing else
   * has ever wanted (`shelfTop` starts below them) and the two columns west of
   * `shelfX0` are the other one — so the block runs across the free rows and
   * then continues down the free columns, and it can stay where it always was,
   * after the shelving, because it is not competing for a cell with anything
   * above it.
   *
   * FACING THE AISLE, which is the bit that was quietly wrong outdoors. A rack
   * is worked from the tile it is turned toward, and `makePlot`'s default is
   * `rot: 2` — WEST, not the row below, whatever its own note said. Packed at
   * `PLOT_COL_PITCH` on grass every rack but the first in a row was therefore
   * reaching into its neighbour, failed `standableSide`, and was skipped: what
   * came out was a single column of beds however many you owned, and it read as
   * the farm being laid out that way on purpose. Turned south, the row below IS
   * the aisle, which is what `PLOT_ROW_PITCH` has been leaving room for all
   * along.
   *
   * It stops WEST of the doorway. `doorX` is cut through both walls, so a rack
   * on that column against the back wall is a rack standing in the service
   * door — and stopping short of it is also what makes this a corner rather
   * than a wall of racks across the top of the shop.
   */
  const GROW_ROT = 1;                          // south: the aisle is below
  const growEast = Math.max(store.x + 1, doorX);
  const growFloor = checkoutZ - 2;
  let nPlot = 0;
  for (let pz = store.z; pz <= growFloor && budget.plot > 0; pz += PLOT_ROW_PITCH) {
    for (let px = store.x; px < growEast && budget.plot > 0; px += PLOT_COL_PITCH) {
      if (!free(px, pz)) continue;
      // The aisle a rack faces has to be free for somebody to stand in, which a
      // bed never needed — it was the standing spot. `PLOT_ROW_PITCH` is what
      // leaves the gap; this is the check that it is still a gap, since the row
      // below may already be built on.
      const bed = makePlot(`plot-p${nPlot}`, px, pz, GROW_ROT);
      if (!standableSide(layoutSoFar(), bed, bed.useAt)) continue;
      set(px, pz, T.PLOT);
      occupy(px, pz);
      nPlot++;
      plotsOut.push(bed);
      reserve(bed.useAt);
      budget.plot--;
    }
  }
  // A taller building is what buys more growing room, exactly as it always was
  // — it is just that the rows being added are indoors now.
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
      /** Animals. Placed only — nothing procedural ever puts one down. */
      pens: pensOut,
      /** Decorations. Placed only, never generated. */
      props: propsOut,
      /**
       * Where rubbish goes. Placed only — a shop starts without one, and every
       * shop that already exists opens with an empty list and plays exactly as
       * it did.
       */
      bins: binsOut,
      /**
       * The conveyor, one record per cell, and the arms that load and unload
       * it. Both placed only — nothing generates either, so every shop that
       * already exists opens with two empty lists and plays exactly as it did.
       *
       * Their own lists rather than entries in `props`: a prop is a thing that
       * weighs nothing and is never asked a question, and both of these are
       * ticked every frame. A belt is also not in `shelves` for a sharper
       * reason — `makeShelf` runs everything it is handed through `shelfKind`,
       * which normalises an unknown kind to `'shelf'`, so a belt filed there
       * would come back from the next re-flow as shelving with bread on it.
       */
      belts: beltsOut,
      arms: armsOut,
      /**
       * ...and the junctions. A third list rather than a flag on `belts`,
       * because every loop that walks a run asks `conveyorsOf` and the one that
       * decides where a crate goes has to be able to tell a two-output cell from
       * a one-output cell without reading a field that most rows do not have.
       */
      sorters: sortersOut,
      /**
       * ...and the tunnel mouths. A fourth list for the third time and the same
       * reason: `conveyorsOf` is the one place that knows a run is made of more
       * than one kind, and everything downstream asks that rather than each list
       * by name.
       */
      unders: undersOut,
      /**
       * ...and the lifts. A fifth list for the same reason again, and one of
       * its own rather than a `deck` on `belts`, because a lift is the only
       * cell that is on BOTH storeys — so it is the one piece `conveyorAt`
       * answers with whichever deck it is asked about.
       */
      lifts: liftsOut,
      /**
       * ...and the packers. A sixth list for the same reason again: the run is
       * made of six kinds now and everything that walks one asks `conveyorsOf`
       * rather than any list by name. Its own rather than a flag on `belts`,
       * because a packer is the only cell in the game that keeps a crate
       * between ticks, so the two things that ask "which cell is this" — the
       * flow map and the box's own address — must be able to tell it apart
       * from an ordinary belt without reading a field most rows have not got.
       */
      packers: packersOut,
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
    // `shelfKind` rather than a ternary, and this is the one site where that
    // mattered most: every player-placed unit comes back through here on every
    // re-flow (`makeShelf(p.id, p.kind, …)` above), so a kind this function
    // cannot name is a kind that survives being built and is quietly demoted to
    // plain shelving the next time anybody buys anything. The stock would come
    // with it, onto a unit that should never have taken it.
    kind: shelfKind(kind),
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
    // One bin, shared by every head — see `Game.stationHopperCap` for why a
    // hopper per head is the wrong answer.
    contents: {},
    /**
     * The heads. One per recipe this machine may be set to at once, which is
     * `lines` on its tier and is 1 on every rung ever authored.
     *
     * `recipe` null means nobody has said, which on the first head reads as the
     * first recipe it knows — see `Game.stationRecipes`. A decision, the way a
     * shelf's `assigned` is, and it survives the same two things: a re-flow
     * (`carryOver`) and a restart (`persist`).
     *
     * A record from before there were heads carries `recipe`, `making`,
     * `startedAt`, `busyUntil` and `output` loose on itself, and `stationSlots`
     * reads those as one head rather than migrating them.
     */
    lines: [{
      recipe: null, making: null, startedAt: 0, busyUntil: 0, output: null,
    }],
  };
}

/**
 * The bin, which is the simplest fixture in here: a tile and a side to stand at.
 *
 * No contents, and that is a decision rather than an omission. A skip that
 * FILLS UP would need emptying, which is a second job, a second readout and a
 * second way for the shop to jam — and the thing it would model is a chore
 * nobody is asking for. What goes in is gone, and what limits it is the walk.
 *
 * `kind` on the record for the reason `makeStation`'s note gives at length:
 * `pieceFor` matches on `piece` AND `kind`, so a constructor that forgets it
 * resolves to no catalog row and `fixtureStats` quietly answers 1/1/1.
 */
/**
 * One pen, with an animal in it and nothing collected yet.
 *
 * `qty` and `filledAt` are the two halves of "what is in there": how much is
 * standing ready, and when the batch now filling started. Both are on the RECORD
 * rather than on the placement, which is the bed's arrangement and not the
 * loader's — a plot keeps `crop_id` and `plantedAt` here and `carryOver` walks
 * them across a re-flow. That is what keeps `repositionFixture` out of it: the R
 * key rebuilds a placement and would reset anything stored there, and a pen
 * emptied by being turned round looks exactly like the button not working.
 *
 * `kind`, for the reason every constructor in here carries one — `pieceFor`
 * matches on `piece` AND `kind`, so forgetting it resolves to no catalog row,
 * `fixtureStats` answers 1/1/1, and every rung of the ladder you sold silently
 * changes nothing.
 */
function makePen(id, x, z, rot) {
  return {
    tier: 1,
    variant: '',
    id,
    kind: 'pen',
    x,
    z,
    rot,
    /** The gate — the one side you collect from. */
    useAt: anchorTile(x, z, rot, sizeOf('pen')),
    /** How much is standing ready to be collected. */
    qty: 0,
    /**
     * When the batch now filling started, against `elapsed`.
     *
     * Saved as how long it HAS filled and never as this stamp — `elapsed`
     * restarts at zero on every load, so a raw stamp would put every pen's batch
     * in the future and freeze the whole farm. Same write-around `plantedAt`
     * has.
     */
    filledAt: 0,
  };
}

function makeBin(id, x, z, rot) {
  return {
    tier: 1,
    variant: '',
    id,
    kind: 'bin',
    x,
    z,
    rot,
    useAt: anchorTile(x, z, rot),
  };
}

/**
 * One cell of conveyor.
 *
 * No working spot, because there is no side you stand at to use a belt — you
 * point at the crate on it, and the crate is aimed at the way every other crate
 * in the game is. `anchorTile` is still what says where it HANDS TO, but that
 * is read at tick time off `rot` rather than stored, because the answer has to
 * be re-derived every time anyway: the cell in front of a belt may hold a belt
 * this second and an arm the next, and a stored neighbour id would be a link
 * that survives its own target being demolished.
 *
 * `kind` for the reason every constructor here carries one — `pieceFor` matches
 * on `piece` AND `kind`, so forgetting it resolves to no catalog row and every
 * speed tier you sold silently does nothing.
 */
/**
 * One mouth of a tunnel.
 *
 * Exactly a belt with a different kind on it: the span it reaches is derived
 * from where the other mouth is standing (`tunnelExit`), so there is no partner,
 * no length and no direction to keep here. See `FIXTURES.under`.
 */
function makeUnder(id, x, z, rot) {
  return {
    tier: 1,
    variant: '',
    id,
    kind: 'under',
    x,
    z,
    rot,
  };
}

function makeBelt(id, x, z, rot) {
  return {
    tier: 1,
    variant: '',
    id,
    kind: 'belt',
    x,
    z,
    rot,
  };
}

/**
 * One shaft — the only piece that stands on both storeys.
 *
 * `way` is the field a belt has not got, and it is deliberately NOT `rot`: up
 * and down are not quarter turns. `null` is every shaft ever built and means
 * *derive it* — a floor run arriving lifts, a duct arriving drops — which is
 * right until two runs arrive, when the derivation has to pick one arbitrarily
 * and half the time picks the other one. Set, it is the answer, and the crates
 * that were already going that way simply pass through.
 *
 * `rot` is the other half of the same question and answers the other axis:
 * `way` is which STOREY it lands on, `rot` is which SIDE it carries on to once
 * it is there. It was pinned at 0 here for as long as a lift was unturnable,
 * and this is the place that would have made R a dead key however rotatable the
 * kind said it was: `compose` rebuilds every record from its placement, so a
 * field this constructor writes as a literal is a field the press cannot move.
 */
function makeLift(id, x, z, way = null, rot = 0) {
  return {
    tier: 1,
    variant: '',
    id,
    kind: 'lift',
    x,
    z,
    rot: rot4(rot),
    deck: 0,
    way,
  };
}

/**
 * One junction of conveyor.
 *
 * `auto` is the only field a belt has not got: whether the crew decide its
 * branch for it. True by default, because a sorter that does nothing until you
 * have told it what to do is a piece you buy and then have to configure, and the
 * shop already knows what is down each of its two lines.
 */
function makeSorter(id, x, z, rot) {
  return {
    tier: 1,
    variant: '',
    id,
    kind: 'sorter',
    x,
    z,
    rot,
    auto: true,
    // Which quarter turn takes what nothing wants. Null on every sorter ever
    // built, which is what makes the reject line opt-in — see `sorterOut`.
    reject: null,
    // ...and whether the square on the OTHER STOREY is a way out at all. False
    // on every junction ever built, and it has to be asked rather than derived:
    // a belt beside a junction was laid at the junction, where a duct over one
    // is a route across the shop that happens to pass over it. See
    // `conveyorBranches`.
    riser: false,
  };
}

/**
 * A packer. Holds one box and fills it from the boxes going past.
 *
 * `assigned` is the only field a belt has not got, and it is empty on every
 * packer ever built — which is what makes the tick list an override rather than
 * a configuration step. Empty means *read the shop*: what the run downstream can
 * actually take, which is the same evidence a sorter routes on, so a packer you
 * have said nothing to is useful the moment you lay it.
 *
 * What it is NOT is a store. The box it is building is an ordinary `deliveries`
 * entry standing on this tile — see `Game.packerBox` — so there is no contents
 * field here to save, to migrate, or to lose on a re-flow.
 */
function makePacker(id, x, z, rot) {
  return {
    tier: 1,
    variant: '',
    id,
    kind: 'packer',
    x,
    z,
    rot,
    assigned: [],
  };
}

/**
 * An arm. Takes from the cell behind it, gives to the cell in front.
 *
 * No working spot, and that is the whole of what is worth knowing about this
 * constructor. The two cells an arm cares about are `anchorTile(rot)` (what it
 * gives to) and `behindTile(rot)` (what it takes from), both derived at tick
 * time — and an `anchor` would RESERVE one of them, which is the generator
 * keeping clear the exact square the belt or shelf being fed has to stand on.
 */
function makeArm(id, x, z, rot) {
  return {
    tier: 1,
    variant: '',
    id,
    kind: 'arm',
    x,
    z,
    rot,
    // Both halves, which is every loader ever built — see `setArmMode`.
    mode: 'both',
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

function makePlot(id, x, z, rot = 2) {
  return {
    tier: 1,
    rot,
    /**
     * The side you work it from, which a bed did not have.
     *
     * It stood on `anchor: null` — you stood on the bed itself — and the day it
     * started blocking its cell that stopped being a spot anybody could reach.
     * `rot: 2` is the generator's default for everything worked from one side
     * (see `makeBin`, `makePen`): the aisle a farm row faces is the one below
     * it, which is where `PLOT_ROW_PITCH` leaves the gap.
     */
    useAt: anchorTile(x, z, rot),
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
 * Four cells each, which is how many they have always been — a pad's cells are
 * how many crates it holds (`bayRoom`, `padRoom`), so changing the count is a
 * balance change wearing a layout change, and orders that stop fitting on the
 * bay come back as refusals nothing in the yard explains.
 *
 * What did change is the SHAPE and where they sit. They used to run four along
 * the back wall at its two far corners, which is where the generator drew them
 * — and on a shop that is not nine wide any more, "the two far corners" is the
 * two ends of a walk. A 2x2 block either side of the back doorway is the same
 * four cells with the goods next to the door they come through, which is most
 * of what carrying stock across a yard costs.
 *
 * **The seed may only lay ground the player could lay themselves**, or the pads
 * are not really theirs, and that is what the fallback below is for rather than
 * tidiness. A block wants two rows of yard; a shop stamped before `STORE_NORTH`
 * moved south has one, because row 0 is the world's border and `canPaintGround`
 * refuses it to everybody. So the cells are *offered in preference order* and
 * the first four legal ones win: a modern shop gets its block, an old one gets
 * the strip it always had, and neither gets a pad three quarters of which it is
 * allowed to delete — which is worse than one it cannot delete at all, because
 * it looks like it worked.
 *
 * They are laid with no design (`p: null`) on purpose. A pad with no piece
 * renders in the tile's own palette colour — `surfaceOf` falls back — so the
 * seed does not have to reach for the catalog, and a world stamped before
 * anybody authored a bay design still gets a bay.
 */
export const PAD_SEED_CELLS = 4;

export function defaultPads(L) {
  const out = [];
  const taken = new Set();

  /**
   * One pad, growing away from the doorway at `x0` in the direction `dir`.
   *
   * Nearest the back wall first and nearest the door first, so what gets
   * dropped when the yard is shallow or the world runs out is always the far
   * corner of the pad rather than the cell beside the door.
   */
  const pad = (x0, dir, kind) => {
    const cells = [];
    for (let dx = 0; dx < L.w; dx++) {
      for (let dz = 1; dz <= 2; dz++) {
        cells.push({ x: x0 + dir * dx, z: L.store.z - dz, band: dx });
      }
    }
    // Band by band outward, so a 2x2 fills before a third column is touched.
    cells.sort((a, b) => a.band - b.band);

    let laid = 0;
    for (const c of cells) {
      if (laid >= PAD_SEED_CELLS) break;
      if (c.x < 1 || c.z < 1 || c.x >= L.w - 1) continue;
      if (taken.has(`${c.x},${c.z}`)) continue;
      // Grass only, the same test the procedural version made: a shop pushed
      // hard against the north edge of the world has less yard than this wants.
      if (L.tiles[c.z * L.w + c.x] !== T.GRASS) continue;
      taken.add(`${c.x},${c.z}`);
      out.push({ x: c.x, z: c.z, k: kind, p: null });
      laid++;
    }
  };

  // Either side of the service doorway. `L.door` is the *front* door, and this
  // reads its `x` on purpose: `compose` cuts the back opening at the same two
  // columns, straight opposite, so that the service route is the corridor
  // behind the tills rather than a squeeze past an aisle end. Those two columns
  // stay clear — a pad across your own way out is a crate you walk around on
  // every single trip.
  pad(L.door.x - 1, -1, 'bay');
  pad(L.door.x + 2, +1, 'drop');
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
