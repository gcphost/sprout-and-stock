#!/usr/bin/env node
/**
 * VERIFY: THE TRIP NOBODY WALKS.
 *
 * Every case of stock in this shop has always been moved by somebody with legs,
 * and the last five rungs of docs/workers.md are each a way of making that walk
 * cheaper. A belt is the first thing that does not take it — and nothing about
 * that is visible. A crate that rode a conveyor and a crate a hire carried are
 * the same box, on the same shelf, in the same shop; only the wage bill moved.
 * So this file ships with the feature, the way `verify:doors`, `verify:park`,
 * `verify:price` and `verify:routes` did.
 *
 * What it guards:
 *
 * - **The control: a shop with no belts is the old game.** Every existing save
 *   has two empty lists, and the two new passes must cost it nothing and change
 *   nothing. This is the assertion that decides whether any of it is opt-in.
 * - **A belt is ground, and the ground is what refuses the second one.** It
 *   stamps `T.BELT`, blocks nobody, stays walkable — and because a non-blocking
 *   fixture is invisible to `blocked`, that stamp is the *only* thing stopping
 *   two belts sharing a square, exactly as `T.PLOT` is for two beds.
 * - **…and it is still a belt after a re-flow**, which is the trap CLAUDE.md
 *   records the hot counter dying in twice: `compose`'s `else` is `makeShelf`,
 *   which runs whatever it is handed through `shelfKind`, so a kind with no
 *   branch is not refused — it is silently BUILT AS SHELVING, keeps its id and
 *   its price, and takes bread.
 * - **A run IS a line**, which since the rewrite is literal: `conveyorLines`
 *   cuts the shop's conveyors into objects with a path and a length, a crate on
 *   one has a single number, and the stepping order is downstream-first over
 *   those. Stepped the other way a crate crosses the shop in one tick; stepped
 *   against a snapshot a run drains like a slinky. Both read as belts being
 *   broken, and neither is a crash.
 * - **…and it is continuous**, asserted every tick over a straight run, a bend
 *   and a junction: nothing goes backwards along the path and nothing steps
 *   further than one tick of travel. That is the claim the per-cell shape could
 *   not make, because a cell owning a crate, a clock and a decision put a SEAM
 *   between every pair of them.
 * - **Corners are free.** An east belt feeding a north belt IS a corner. If
 *   this ever needs a corner piece, the design was wrong.
 * - **Backpressure**, and it is the centrepiece of the step-1 half. A belt that
 *   cannot hand on must STOP — never spill to the floor, never merge with the
 *   box in front of it, never quietly drop one. A jam is a row of boxes not
 *   moving, which is a picture the player can read; a spill buries the shop
 *   while looking like it is working.
 * - **The arm obeys the placement rule and exactly one judgement rule.** It is
 *   aimed, so it does not ask `homeShelves` or `handMayTouch` — asserted as a
 *   value each way, because "obeys everything" passes every other claim here.
 *   It does ask `givenUp`, because that is the one rule that exists for things
 *   acting unattended in a loop, which is what an arm is and hands are not.
 * - **A thousand idle ticks open no boards.** `boardFor` is not a predicate: it
 *   calls `openStack`, which pushes a real priced board as a side effect of
 *   being asked. A hire probes a few times a minute; an arm would twenty times
 *   a second, and each one divides `shelfCapacity` for the whole unit.
 * - **Conservation, at every hop**, because a new place goods move between has
 *   been a hole every single time in this game.
 * - **The spoilage stamp survives the ride.** `verify:pack`'s centrepiece
 *   pointed at a belt: a kind arriving as a bare `{item_id, qty}` reads as fresh
 *   for ever, and a crate of laundered flour looks exactly like flour.
 * - **A re-flow parks a crate rather than stranding it.** Build mode re-flows on
 *   every wall segment, so a crate holding a demolished belt's id would never be
 *   stepped and never be swept — standing in the aisle for the rest of the save,
 *   counted by `homeSupply` as supply nothing can reach.
 * - **…and `homeSupply` counts one that is still riding**, or the shop buys a
 *   second van-load of what is thirty seconds from the shelf.
 *
 * Runs on ephemeral Games. It writes one item row and two fixture rows into the
 * content database — usually the live shared one — and removes them on exit.
 *
 *   node scripts/verify-belts.js
 */

import { Game } from '../server/sim/index.js';
import { writeContent, refresh, content } from '../server/content.js';
import { remove } from '../server/db.js';
import { MILESTONES } from '../server/sim/goals.js';
import { canPlace, anchorTile, isWalkableTile, edgeAt, runCells, BELT_RUN_MAX, conveyorBranches, conveyorMeets, conveyorNext, tunnelExit, TUNNEL_SPAN, conveyorFeeders, mergeStraight, mergeRoute } from '../shared/build.js';
import { E, canStep, shopperCanCross } from '../shared/edges.js';
import { T } from '../shared/tiles.js';
import { lotQty, lotTotal, lotStacks } from '../shared/lot.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
/** ...and the same for a distance along a line, which is arithmetic on floats. */
const near = (a, b, label, eps = 1e-6) => check(Math.abs(a - b) <= eps, label,
  `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SHOP = { shelf: 4, freezer: 0, warmer: 0, checkout: 1, plot: 0, stations: [] };

/** Ordinary shelf-stable goods, so nothing here turns on spoilage by accident. */
const GOODS = {
  id: 'zz-belt-good', name: 'Test Crackers', category: 'ambient',
  tags: ['shelf-stable', 'cheap'], base_cost: 1, base_price: 3, shelf_life_days: 300,
};
/** Frozen, purely so the arm can be offered something a plain shelf refuses. */
const COLD = {
  id: 'zz-belt-cold', name: 'Test Ice', category: 'frozen',
  tags: ['needs-freezer', 'cheap'], base_cost: 1, base_price: 3, shelf_life_days: 300,
};
const BELT = {
  id: 'zz-belt-piece', kind: 'belt', name: 'Test Belt', cost: 10,
  model: { parts: [{ shape: 'box', color: '#3b3f46', pos: [0, 0.06, 0], scale: [0.9, 0.12, 0.9] }] },
  tiers: [{ name: 'Standard', cost: 0 }],
};
const ARM = {
  id: 'zz-belt-arm', kind: 'arm', name: 'Test Arm', cost: 50,
  model: { parts: [{ shape: 'box', color: '#6b7280', pos: [0, 0.4, 0], scale: [0.4, 0.8, 0.4] }] },
  tiers: [{ name: 'Standard', cost: 0 }],
};
/** Storage to paint a SECOND island of drop-off with. See 18c. */
const STORE = {
  id: 'zz-belt-store', kind: 'drop', name: 'Test Storage', cost: 1,
  surface: { color: '#8b8f96' },
};

/**
 * A run that is already quick, and a junction with a ladder on it. See 20.
 *
 * Two pieces rather than one because the claim only EXISTS when the sorter is
 * the slow cell: a junction running at the same speed as the belts either side
 * of it is never what a queue forms at, so a sweep laid on `zz-belt-piece`
 * would be measuring the run and calling it the junction. `QUICK_BELT` is fast
 * at its first rung — no ladder, nothing to upgrade — so the only thing that
 * differs between the two shops is the rung on the sorter.
 *
 * Its ladder is this file's own, at numbers nobody would ship, for the reason
 * `verify:till` gives about its Test Till: an extreme rung makes a throughput
 * difference something you assert on rather than argue about, and if the
 * shipped Quick/Maglev Sorter is ever retuned this file must not start failing
 * over a balance decision it has no opinion about. Three rungs, because the
 * claim is rung one against the TOP one and two rungs cannot tell the top rung
 * from the next one.
 */
const BELT_MULT = 3;
const SORT_MULT = 3;
const QUICK_BELT = {
  id: 'zz-belt-quick', kind: 'belt', name: 'Test Quick Belt', cost: 10,
  model: { parts: [{ shape: 'box', color: '#3b3f46', pos: [0, 0.06, 0], scale: [0.9, 0.12, 0.9] }] },
  tiers: [{ name: 'Quick', cost: 0, speed_mult: BELT_MULT }],
};
const JUNCTION = {
  id: 'zz-belt-junction', kind: 'sorter', name: 'Test Junction', cost: 10,
  model: { parts: [{ shape: 'box', color: '#55606e', pos: [0, 0.4, 0], scale: [0.8, 0.8, 0.8] }] },
  tiers: [
    { name: 'Slow', cost: 0, speed_mult: 1 },
    { name: 'Middling', cost: 0, speed_mult: 2 },
    { name: 'Quick', cost: 0, speed_mult: SORT_MULT },
  ],
};
/** ...and a mouth with the same ladder on it. See 21. */
const MOUTH = {
  id: 'zz-belt-mouth', kind: 'under', name: 'Test Mouth', cost: 10,
  model: { parts: [{ shape: 'box', color: '#c8d0da', pos: [0, 0.1, 0], scale: [0.9, 0.2, 0.7] }] },
  tiers: [
    { name: 'Slow', cost: 0, speed_mult: 1 },
    { name: 'Middling', cost: 0, speed_mult: 2 },
    { name: 'Quick', cost: 0, speed_mult: SORT_MULT },
  ],
};

/**
 * The farm, for section 22 — the one place a loader takes goods out of
 * something that produced them rather than off something the shop stocked.
 *
 * The pen's batch is deliberately SMALLER than a crate holds and the crop's
 * yield deliberately fixed: every claim down there is a count, and a batch that
 * happened to straddle `crateLot().cap` would make each of them a test of the
 * split as well as of the collect.
 */
const PEN_BATCH = 5;
const FARM_PEN = {
  id: 'zz-belt-pen', kind: 'pen', name: 'Test Coop', cost: 0,
  produces: { item_id: GOODS.id, qty: PEN_BATCH, every: 1 },
  model: { parts: [{ shape: 'box', color: '#a85a3a', pos: [0, 0.3, 0], scale: [0.6, 0.6, 0.6] }] },
  tiers: [{ name: 'Basic', cost: 0 }],
};
const CROP_YIELD = 4;
const FARM_CROP = {
  id: 'zz-belt-crop', name: 'Test Sprout', item_id: GOODS.id,
  grow_minutes: 1, seed_cost: 1, yield_min: CROP_YIELD, yield_max: CROP_YIELD,
  seasons: ['spring', 'summer', 'autumn', 'winter'],
  model: { parts: [{ shape: 'sphere', color: '#7bbf5a', pos: [0, 0.1, 0], scale: [0.2, 0.2, 0.2] }] },
};

/**
 * An ordinary stocker, so the belt can be asked the one question a sweep over
 * pure functions cannot: does the CREW use it.
 */
const STOCKER = {
  id: 'zz-belt-stocker', name: 'Test Stocker', color: '#6b8fb5',
  jobs: [{ job: 'unload', weight: 10 }, { job: 'shelve', weight: 10 }],
  cost: 0, wage: 0, speed: 20, pace: 0.05, carry: 6,
  tiers: [{ name: 'Standard', cost: 0 }],
};

process.on('exit', () => {
  for (const [t, id] of [['items', GOODS.id], ['items', COLD.id],
    ['fixtures', BELT.id], ['fixtures', ARM.id], ['fixtures', STORE.id],
    ['fixtures', QUICK_BELT.id], ['fixtures', JUNCTION.id], ['fixtures', MOUTH.id],
    ['fixtures', FARM_PEN.id], ['crops', FARM_CROP.id],
    ['workers', STOCKER.id]]) {
    try { remove(t, id); } catch { /* best effort */ }
  }
});
for (const [kind, row] of [['item', GOODS], ['item', COLD], ['fixture', BELT], ['fixture', ARM],
  ['fixture', STORE], ['fixture', QUICK_BELT], ['fixture', JUNCTION], ['fixture', MOUTH],
  ['fixture', FARM_PEN], ['crop', FARM_CROP], ['worker', STOCKER]]) {
  const res = writeContent(kind, row, 'verify');
  check(res.ok, `the catalog accepts the test ${kind} ${row.id}`, res.error ?? '');
}
refresh();

function fresh({ crew = null } = {}) {
  const g = Game.create({ worldId: 'verify-belts', seed: 'belt', ephemeral: true });
  g.placements = [];
  g.grow = { w: 0, h: 0 };
  g.doorShift = 0;
  g.edits = [];
  g.ground = [];
  g.yardStamped = false;
  // `shell` and `ownedUpgrades` for the reason CLAUDE.md gives about `fresh()`:
  // a stored shell makes the generator re-apply a shop of a different size, and
  // an owned upgrade makes every price here a discounted one.
  g.shell = null;
  g.ownedUpgrades = [];
  g.roster = [];
  g.regenerateLayout(null, {}, { want: SHOP });
  g.freezeShell();
  g.freezeYard();
  for (const m of MILESTONES) g.milestones.done.push(m.id);
  g.orders.auto = false;
  g.orders.assign = false;
  g.orders.items = {};
  g.orders.dropped = {};
  g.orders.pending = [];
  g.deliveries = [];
  g.cash = 50000;
  g.open = false;
  for (const sh of g.layout.shelves ?? []) sh.stacks = [];
  g.addPlayer('me', 'Tester');
  g.players.me.build = { on: true };
  if (crew) {
    const res = g.hire(crew);
    check(res.ok, 'the hire joins', res.error ?? '');
    g.step(0.1);
  }
  return g;
}

const hire = (g) => g.players[`staff-${g.roster[g.roster.length - 1]?.id}`];
const run = (g, ticks) => { for (let i = 0; i < ticks; i++) g.step(0.1); };
function until(g, done, limit = 1500) {
  for (let i = 0; i < limit; i++) { g.step(0.1); if (done()) return true; }
  return false;
}
const units = (g) => g.deliveries.reduce((n, d) => n + lotTotal(d), 0)
  + (g.layout.shelves ?? []).reduce((n, s) => n
    + (s.stacks ?? []).reduce((m, st) => m + (st.qty ?? 0), 0), 0);

/**
 * A straight east-west run of cells a belt may legally stand on.
 *
 * Asked of `canPlace` rather than of the tiles directly, because the whole
 * point is that the sweep builds through the same door the player does — a
 * helper that wrote `layout.belts` by hand would pass while every real press
 * was refused, which is the trap `verify:ferry` names about `setBackOfHouse`.
 */
function beltRun(g, n) {
  for (let z = 1; z < g.layout.h - 1; z++) {
    for (let x = 1; x + n < g.layout.w - 1; x++) {
      const cells = [];
      for (let i = 0; i < n; i++) cells.push({ x: x + i, z });
      if (cells.every((c) => canPlace(g.layout, { kind: 'belt', x: c.x, z: c.z, rot: 0 }).ok)) return cells;
    }
  }
  return null;
}

/** Lay a run of belt all facing east, through the real build verb. */
function lay(g, cells, rot = 0) {
  const out = [];
  for (const c of cells) {
    const res = g.placeFixture('me', { kind: 'belt', piece: BELT.id, x: c.x, z: c.z, rot });
    check(res.ok, `a belt goes down at ${c.x},${c.z}`, res.error ?? '');
    out.push(g.beltAt(c.x, c.z));
  }
  return out;
}

/**
 * Somewhere an arm may stand such that it feeds `belt` from a cell a crate can
 * sit on. Searched rather than computed, because which side of a run is indoors
 * is a fact about the shell rather than about the run.
 */
function armFeeding(g, belt) {
  for (const rot of [0, 1, 2, 3]) {
    const a = anchorTile(belt.x, belt.z, (rot + 2) % 4); // the cell that faces INTO the belt
    if (!canPlace(g.layout, { kind: 'arm', x: a.x, z: a.z, rot }).ok) continue;
    const to = anchorTile(a.x, a.z, rot);
    if (to.x !== belt.x || to.z !== belt.z) continue;
    const behind = anchorTile(a.x, a.z, rot + 2);
    if (!isWalkableTile(g.layout, behind.x, behind.z)) continue;
    return { x: a.x, z: a.z, rot, behind };
  }
  return null;
}

/** Whichever of the two test items this unit will actually have, if either. */
function shelfWants(g, shelf) {
  return [GOODS.id, COLD.id].find((id) => g.shelfAccepts(shelf, id)) ?? null;
}

/** A crate of `qty` standing on a belt, put there the way an arm would. */
function crateOn(g, belt, item = GOODS, qty = 4) {
  const crate = g.dropGoods(item.id, qty, { x: belt.x, z: belt.z }, { exact: true });
  check(!!crate, 'the test crate exists');
  g.loadBelt(belt, crate);
  return crate;
}

// ---------------------------------------------------------------------------
// 1. The control: a shop that never built one is the old game.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  eq((g.layout.belts ?? []).length, 0, 'a fresh shop owns no belts');
  eq((g.layout.arms ?? []).length, 0, 'a fresh shop owns no arms');

  const before = JSON.stringify({ t: g.layout.tiles, b: g.layout.blocked, i: g.layout.indoor });
  const cash = g.cash;
  run(g, 100);
  const after = JSON.stringify({ t: g.layout.tiles, b: g.layout.blocked, i: g.layout.indoor });
  eq(after, before, 'a hundred ticks of the belt pass move no tile, no block and no wall');
  eq(g.cash, cash, '...and cost nothing');
  eq(g.deliveries.length, 0, '...and conjure no crates');
}

// ---------------------------------------------------------------------------
// 1b. A drag says which way; R says the rest — and for a drag of ONE it says all.
//
// `runCells` is pure and this is the one claim in the file that is about a
// gesture rather than about goods, which is why it is worth pinning here: a
// press that never travelled has no direction in it, so the seed IS the answer,
// and seeded at a literal 0 the one fixture whose entire point is which way it
// points was the only one in the game that could not be turned before being put
// down. It is not invisible — a belt facing north is a belt facing north — but
// it is invisible in the FILE, because a run of two or more overwrites the seed
// on its very first cell and every test anybody would think to write uses one.
// ---------------------------------------------------------------------------
{
  const from = { x: 5, z: 5 };
  for (const rot of [0, 1, 2, 3]) {
    const one = runCells(from, from, BELT_RUN_MAX, rot);
    eq(one.length, 1, `a press that never travelled lays one cell (rot ${rot})`);
    eq(one[0].rot, rot, `...facing the way R left it (rot ${rot})`);
  }

  // ...and the drag still wins wherever it has something to say. Every cell but
  // the last faces the next one whatever was armed, or turning the ghost before
  // a drag would lay a run that does not join up.
  const east = runCells(from, { x: from.x + 3, z: from.z }, BELT_RUN_MAX, 2);
  eq(east.length, 4, 'a drag of three lays four cells');
  const heads = new Set(east.slice(0, 3).map((c) => c.rot));
  eq(heads.size, 1, 'every cell but the last faces the same way');
  check(!heads.has(2) || east[0].rot === 2,
    'and faces the way the gesture went rather than the way R did');
  eq(east[3].rot, east[2].rot, 'the last cell keeps the facing it arrived with');
}

// ---------------------------------------------------------------------------
// 2. A belt is ground: it stamps its tile, blocks nobody, and refuses the second.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 3);
  check(!!cells, 'there is a straight run of floor to lay belt on');

  const blockedBefore = JSON.stringify(g.layout.blocked);
  lay(g, cells);

  const [a] = cells;
  eq(g.layout.tiles[a.z * g.layout.w + a.x], T.BELT, 'the cell is made of belt now');
  check(isWalkableTile(g.layout, a.x, a.z), 'and it is still walked over');
  eq(JSON.stringify(g.layout.blocked), blockedBefore,
    'a belt occupies nothing — `blocked` is byte-identical');

  // The stamp is the only refusal there is, since `blocked` never heard of it.
  const again = canPlace(g.layout, { kind: 'belt', x: a.x, z: a.z, rot: 0 });
  check(!again.ok, 'a second belt on the same cell is refused', JSON.stringify(again));

  // ...AND A MACHINE IN THE RUN IS THE OTHER ANSWER, which is why this is here
  // rather than taken as read from the line above. A belt is ground and a loader
  // is a housing standing in it — waist-high, with the crate going inside — so
  // the two disagree about the walk grid while sharing a tile stamp, and that
  // pair is the easiest thing in this file to half-implement.
  //
  // It shipped half-implemented: `blocks` was flipped in `shared/build.js`, so
  // `canPlace` refused the cell, and `compose`'s arm branch went on saying "same
  // non-blocking" in a comment and never called `occupy`. Every sweep passed,
  // because not one of them asked. What it looks like in play is shoppers
  // strolling straight through the machine — a rule enforced in one of the two
  // places it lives is not half enforced, it is off.
  {
    const gm = fresh();
    const line = beltRun(gm, 3);
    check(!!line, 'there is a run to stand a loader in');
    lay(gm, [line[0], line[2]]);
    const mid = line[1];
    const put = gm.placeFixture('me', { kind: 'arm', piece: ARM.id, x: mid.x, z: mid.z, rot: 0 });
    check(put.ok, 'a loader goes in the middle of the run', JSON.stringify(put));
    const at = mid.z * gm.layout.w + mid.x;
    eq(gm.layout.tiles[at], T.BELT, 'a loader still stamps belt — it is part of the run');
    eq(gm.layout.blocked[at], 1, 'and it occupies its cell, unlike the belt either side');
    check(!isWalkableTile(gm.layout, mid.x, mid.z), 'so nobody walks through the machine');
    // Both halves, or a re-flow hands the cell back: `compose` rebuilds every
    // record from its placement, and this is the branch that forgot once.
    gm.regenerateLayout();
    eq(gm.layout.blocked[mid.z * gm.layout.w + mid.x], 1, 'and it is still occupied after a re-flow');
    // The control, in the same shop: the belt beside it did not become a wall.
    eq(gm.layout.blocked[line[0].z * gm.layout.w + line[0].x], 0,
      'while the belt next to it still blocks nobody');
  }

  // The `else`-is-`makeShelf` trap. A purchase re-flows, so this is the state
  // the shop is actually in a moment later — not a hypothetical.
  const ids = cells.map((c) => g.beltAt(c.x, c.z).id);
  g.regenerateLayout();
  eq((g.layout.belts ?? []).length, 3, 'all three survive the re-flow as belts');
  for (const id of ids) {
    check((g.layout.belts ?? []).some((b) => b.id === id), `belt ${id} is still a belt`);
    check(!(g.layout.shelves ?? []).some((sh) => sh.id === id), `belt ${id} did not come back as shelving`);
  }
}

// ---------------------------------------------------------------------------
// 3. A run advances as a line, and a corner costs nothing.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 4);
  const belts = lay(g, cells);
  const crate = crateOn(g, belts[0]);

  // Long enough that a line moves the whole way; `beltSeconds` is 0.6 at tier 1.
  run(g, 60);
  eq(crate.belt, belts[3].id, 'the crate reaches the far end of the run');
  eq(crate.x, belts[3].x, '...and its position went with it');
  eq(lotQty(crate, GOODS.id), 4, '...with everything still in it');

  // A crate that crossed in ONE tick is the other failure, and it looks the
  // same at the end of a long run — so ask a fresh one after a single step.
  const g2 = fresh();
  const c2 = beltRun(g2, 4);
  const b2 = lay(g2, c2);
  const crate2 = crateOn(g2, b2[0]);
  run(g2, 7);
  check(crate2.belt === b2[1].id, 'one belt-time is one cell, not the whole run',
    `landed on ${crate2.belt}`);
}
{
  // The corner: east into north. Nothing anywhere knows what a corner is.
  const g = fresh();
  const cells = beltRun(g, 3);
  const [p, q] = cells;
  const belts = lay(g, [p]);
  // The second belt sits east of the first and faces NORTH, so the first hands
  // to it and it hands on up the map.
  const res = g.placeFixture('me', { kind: 'belt', piece: BELT.id, x: q.x, z: q.z, rot: 3 });
  check(res.ok, 'the corner belt goes down', res.error ?? '');
  const corner = g.beltAt(q.x, q.z);
  const up = anchorTile(corner.x, corner.z, 3);
  const third = g.placeFixture('me', { kind: 'belt', piece: BELT.id, x: up.x, z: up.z, rot: 3 });

  const crate = crateOn(g, belts[0]);
  run(g, 20);
  eq(crate.belt, corner.id, 'a crate takes the bend with no corner piece anywhere');
  if (third.ok) {
    run(g, 20);
    eq(crate.belt, g.beltAt(up.x, up.z).id, '...and carries on the new way');
  }
}

// ---------------------------------------------------------------------------
// 4. Backpressure. The centrepiece of step 1.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 3);
  const belts = lay(g, cells);
  // Nothing beyond the last belt: it faces east at ordinary floor, so the run
  // is a dead end and every box on it should simply stop.
  const crates = belts.map((b) => crateOn(g, b, GOODS, 2));
  const total = units(g);

  run(g, 200);

  eq(g.deliveries.length, 3, 'three boxes on a jammed run stay three boxes');
  eq(units(g), total, '...and nothing was created or destroyed waiting');
  // They CLOSE UP rather than each holding the cell they started on — see
  // `CRATE_PITCH`, which is a box-width now. Which cell each is filed on is a
  // consequence of that and not a claim; what has to hold is the queue: in
  // order, exactly one pitch apart, none of them merged, and none of them on
  // the floor.
  const along = crates.map((d) => g.beltSpot(d)?.at ?? NaN);
  check(along.every(Number.isFinite), 'every box in the jam is still on the run');
  for (let i = 0; i < 3; i++) {
    eq(lotQty(crates[i], GOODS.id), 2, `box ${i} did not merge with its neighbour`);
    if (i) {
      near(along[i] - along[i - 1], Game.CRATE_PITCH,
        `...and box ${i} closed up to exactly one pitch ahead of the one behind it`);
    }
  }
  check(!g.deliveries.some((d) => !d.belt), 'nothing spilled onto the floor at the end of the run');

  // And it un-jams the moment the way clears, rather than needing a nudge.
  const wasAt = crates.map((d) => g.beltSpot(d)?.at ?? NaN);
  g.deliveries = g.deliveries.filter((d) => d.id !== crates[2].id);
  run(g, 20);
  check(g.beltSpot(crates[1]).at > wasAt[1], 'clearing the head lets the line move up');
  check(g.beltSpot(crates[0]).at > wasAt[0], '...all of it, not just the front box');
}

// ---------------------------------------------------------------------------
// 4b. A MERGE UNSTICKS ITSELF, which is backpressure's own failure mode.
//
// Two runs joining one is the commonest shape in a real shop — an aisle and a
// spur into the same line — and a box crossing the gap between two lines is
// counted against the line it is heading for, so a second feeder holds back.
// Right, until BOTH of them are part way in: each counts the other, neither may
// go backwards (`cap = Math.max(cap, at)`), and the pair stands there for the
// rest of the save with every line behind them backing up.
//
// It is invisible as a bug and unmistakable as a picture: nothing errors,
// nothing spills, no crate is lost, and what you watch is thirty boxes standing
// still on a conveyor that is working perfectly. A live shop had two rows and
// thirty-eight crates wedged on one square, and sixty-seven in-game minutes
// went by without a single one of them moving a pixel.
//
// The guard is supposed to stop them both committing and cannot be relied on to:
// a crate's address is a cell plus an offset, `conveyorLines` re-cuts the shop
// on every purchase, and a box that was mid-LINE can come back mid-GAP. So the
// claim here is recovery rather than prevention — put two boxes in the state by
// hand, the way a re-flow leaves them, and the merge must sort itself out.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 3);
  check(!!cells, 'there is room for a three-cell run to merge into');
  const belts = cells ? lay(g, cells) : [];
  // A second run coming in from the side, onto the middle cell — so the middle
  // of the row is fed by two.
  const side = [3, 1].map((rot) => ({ ...anchorTile(cells[1].x, cells[1].z, (rot + 2) % 4), rot }))
    .find((c) => canPlace(g.layout, { kind: 'belt', x: c.x, z: c.z, rot: c.rot }).ok);
  check(!!side, 'there is room beside it for a second run to join');
  if (cells && side) {
    const put = g.placeFixture('me', { kind: 'belt', piece: BELT.id, x: side.x, z: side.z, rot: side.rot });
    check(put.ok, 'the joining belt goes down', put.error ?? '');
    const spur = g.beltAt(side.x, side.z);

    // The shape has to be the one this is about, or every assertion below is
    // true of a run that never merges.
    const net = g.beltLines();
    const mid = net.byCell.get(belts[1].id)?.line;
    const from = (c) => net.byCell.get(c.id)?.line;
    check(!!mid && from(belts[0]) !== mid && from(spur) !== mid,
      'the two runs are lines of their own, joining a third');
    const feeds = (net.feeds.get(mid?.id) ?? []).map((l) => l.id);
    check(feeds.includes(from(belts[0])?.id) && feeds.includes(from(spur)?.id),
      '...and the line they join knows both of them feed it');

    // Both part way across the gap at once — the state a re-cut leaves, and the
    // one the guard is meant to make unreachable. Written on the crates rather
    // than driven into, because driving into it is exactly what cannot be done.
    const a = crateOn(g, belts[0], GOODS, 2);
    const b = crateOn(g, spur, GOODS, 3);
    a.off = 0.4;
    b.off = 0.4;
    const total = units(g);
    check(g.beltSpot(a).at > from(belts[0]).len && g.beltSpot(b).at > from(spur).len,
      'both boxes have left their own line and neither has arrived');

    run(g, 200);

    const landed = [a, b].filter((c) => c.belt === belts[1].id || c.belt === belts[2].id);
    eq(landed.length, 2, 'both boxes finish the merge rather than holding each other in the gap');
    check(a.belt !== b.belt, '...one behind the other, not two on one cell');
    eq(units(g), total, '...and nothing was created or destroyed sorting it out');
    check(!g.deliveries.some((d) => !d.belt), '...and neither of them spilled onto the floor');
  }
}

// ---------------------------------------------------------------------------
// 5. A loader lifts a crate off the floor beside it, and the run carries it.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 3);
  // A loader at the head of the run, then two belts. This is how goods get out
  // of the yard without a second kind of machine.
  const head = g.placeFixture('me', { kind: 'arm', piece: ARM.id, x: cells[0].x, z: cells[0].z, rot: 0 });
  check(head.ok, 'a loader goes down at the head of the run', head.error ?? '');
  const belts = lay(g, cells.slice(1));
  const loader = g.beltAt(cells[0].x, cells[0].z);

  // Somewhere beside it that is not part of the run.
  const spot = [0, 1, 2, 3]
    .map((r) => anchorTile(cells[0].x, cells[0].z, r))
    .find((c) => !g.beltAt(c.x, c.z) && isWalkableTile(g.layout, c.x, c.z));
  check(!!spot, 'there is floor beside the loader to stand a crate on');
  if (spot) {
    const crate = g.dropGoods(GOODS.id, 5, spot, { exact: true });
    const total = units(g);
    // A BOX IS LEFT WHERE YOU CAN SEE IT FIRST, which is the one thing between
    // the drop and the swing. A machine decides in no time, so a loader beside
    // the bay used to lift every crate on the tick it landed and a delivery
    // arrived as goods already on the belt — the van, the pad and the boxes all
    // drawn correctly and never on screen together. Asked at 1.1s, a hair inside
    // `CRATE_REST_SECONDS`, because a rest nobody can measure is a rest that is
    // not there: this passes identically on a loader that simply swings slowly,
    // which is why the claim below is a value at a time rather than "eventually".
    run(g, 11);
    eq(crate.belt, undefined, 'a box that has only just landed is left where it fell');

    // ...and then it goes, which is the half that stops the rest being a machine
    // that has quietly stopped working.
    check(until(g, () => crate.belt === loader.id),
      'the loader lifted the crate off the floor onto itself');
    eq(units(g), total, '...and conserved it');
    eq(lotQty(crate, GOODS.id), 5, '...whole, rather than a handful at a time');

    run(g, 60);
    check(belts.some((b) => b.id === crate.belt), 'and the run carried it on', `at ${crate.belt}`);
  }
}

// ---------------------------------------------------------------------------
// 6. The arm pours into a shelf — through the shop's own rule, not its own.
// ---------------------------------------------------------------------------
function armIntoShelf(g, { item = GOODS, prep = null, turn = 0, past = false, load = true } = {}) {
  // A loader stands IN the run, beside a unit. Searched over every shelf rather
  // than computed, because whether any particular unit has a free cell next to
  // it is a fact about the generated shop.
  for (const shelf of g.layout.shelves ?? []) {
    for (const rot of [0, 1, 2, 3]) {
      const cell = anchorTile(shelf.x, shelf.z, rot);
      // Never the browsing tile: a loader does not block, but standing one
      // there is still the cell a shopper needs, and the rig should look like
      // something a player would really build.
      if (shelf.browseAt && cell.x === shelf.browseAt.x && cell.z === shelf.browseAt.z) continue;
      if (!canPlace(g.layout, { kind: 'arm', x: cell.x, z: cell.z, rot: 0 }).ok) continue;

      // `turn` points the loader somewhere else on purpose — a loader unloads
      // sideways to ALL four of its neighbours, so its own facing decides only
      // where a crate goes next, never whether it stocks.
      const placed = g.placeFixture('me', {
        kind: 'arm', piece: ARM.id, x: cell.x, z: cell.z, rot: turn % 4,
      });
      if (!placed.ok) continue;
      const loader = g.beltAt(cell.x, cell.z);
      const unit = (g.layout.shelves ?? []).find((sh) => sh.id === shelf.id);
      if (!loader || !unit) continue;
      if (prep) prep(unit);
      const crate = load ? crateOn(g, loader, item, 4) : null;
      void past;
      return { shelf: unit, crate, belt: loader, loader };
    }
  }
  return null;
}

{
  const g = fresh();
  const set = armIntoShelf(g);
  check(!!set, 'the arm-and-belt rig stands up');
  if (set) {
    const total = units(g);
    run(g, 60);
    const on = (set.shelf.stacks ?? []).reduce((n, s) => n + (s.qty ?? 0), 0);
    check(on > 0, 'the arm filled the shelf with nobody walking', `${on} units`);
    eq(units(g), total, 'nothing was created or destroyed on the way onto the board');
    eq(on + lotTotal(set.crate), 4, 'what left the crate is exactly what landed on the shelf');
  }
}
{
  // The kind rule, which the arm must not have its own copy of. A plain shelf
  // refuses frozen goods for the arm exactly as it does for your hands.
  const g = fresh();
  const set = armIntoShelf(g, { item: COLD });
  if (set) {
    run(g, 60);
    const on = (set.shelf.stacks ?? []).reduce((n, s) => n + (s.qty ?? 0), 0);
    eq(on, 0, 'a plain shelf takes no frozen goods from an arm either');
    eq(lotTotal(set.crate), 4, '...and the crate keeps them rather than losing them');
  }
}

// ---------------------------------------------------------------------------
// 7. One judgement rule, and only one.
// ---------------------------------------------------------------------------
{
  // `givenUp` — the rule that exists for unattended loops, which is what an arm
  // is. Without it, an arm feeding a dropped board is `merchandise`'s round
  // trip with no hire in it.
  const g = fresh();
  const set = armIntoShelf(g, { prep: () => { g.dropItem(GOODS.id, 5); } });
  if (set) {
    run(g, 60);
    const on = (set.shelf.stacks ?? []).reduce((n, s) => n + (s.qty ?? 0), 0);
    eq(on, 0, 'an arm never feeds a board the shop has given up on');
    eq(lotTotal(set.crate), 4, '...and leaves the goods in the box');
  }
}
{
  // ...and the other half, which is otherwise unprovable: "obeys every rule a
  // hire obeys" would satisfy every assertion above this one.
  const g = fresh();
  const set = armIntoShelf(g, { prep: (shelf) => { shelf.managed = false; } });
  if (set) {
    run(g, 60);
    const on = (set.shelf.stacks ?? []).reduce((n, s) => n + (s.qty ?? 0), 0);
    check(on > 0, 'hands-off is about rearranging, so an arm still fills the unit', `${on} units`);
  }
}
{
  // The same again for the one-home rule: an arm is AIMED, so a unit that is
  // not the item's home is exactly where you said to put it.
  const g = fresh();
  const other = (g.layout.shelves ?? [])[1];
  if (other) {
    other.stacks = [{ item_id: GOODS.id, qty: 9, price: 3, stockedDay: g.day }];
    const set = armIntoShelf(g);
    if (set) {
      run(g, 60);
      const on = (set.shelf.stacks ?? []).reduce((n, s) => n + (s.qty ?? 0), 0);
      check(on > 0, 'an arm fills the unit it is bolted to, home or not', `${on} units`);
    }
  }
}

// ---------------------------------------------------------------------------
// 7b. An arm is not aimed: it works between any two of its four sides.
// ---------------------------------------------------------------------------
{
  // The same rig, with the arm turned to face somewhere else entirely. It has a
  // belt on one side and a shelf on another and that is all it needs — and this
  // is the claim that decides whether the rotation problem exists at all, since
  // an arm turned a quarter wrong is a post that looks exactly like one that
  // works.
  const g = fresh();
  const set = armIntoShelf(g, { turn: 1 });
  check(!!set, 'the rig stands up with the arm pointed elsewhere');
  if (set) {
    run(g, 60);
    const on = (set.shelf.stacks ?? []).reduce((n, s) => n + (s.qty ?? 0), 0);
    check(on > 0, 'an arm facing the wrong way still fills the shelf beside it', `${on} units`);
  }
}
{
  // ...and all four rotations agree, or "works whichever way" is one lucky
  // angle rather than a rule.
  for (const turn of [0, 1, 2, 3]) {
    const g = fresh();
    const set = armIntoShelf(g, { turn });
    if (!set) continue;
    run(g, 60);
    const on = (set.shelf.stacks ?? []).reduce((n, s) => n + (s.qty ?? 0), 0);
    check(on > 0, `an arm at rot+${turn} works`, `${on} units`);
  }
}

// ---------------------------------------------------------------------------
// 8. A thousand idle ticks open no boards.
// ---------------------------------------------------------------------------
{
  // The `boardFor` mutation trap. Frozen goods on a plain shelf means the arm
  // can never succeed, so every tick is a probe and nothing else.
  const g = fresh();
  const set = armIntoShelf(g, { item: COLD });
  if (set) {
    const before = JSON.stringify(set.shelf.stacks ?? []);
    run(g, 400);
    eq(JSON.stringify(set.shelf.stacks ?? []), before,
      'an arm that can never fill a board never opens one either');
  }
}

// ---------------------------------------------------------------------------
// 9. The stamp survives the ride, and the shop can see what is on the belt.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 3);
  const belts = lay(g, cells);
  const crate = crateOn(g, belts[0], GOODS, 3);
  // Age it, the way a box that has sat in the yard for a week is aged.
  for (const s of crate.stacks) s.day = g.day - 5;

  eq(g.homeSupply(GOODS.id), 3, 'a crate riding a belt is supply the shop can see');

  run(g, 60);
  const stamps = lotStacks(crate).map((s) => s.day);
  check(stamps.every((d) => d === g.day - 5),
    'the ride does not launder the spoilage stamp', JSON.stringify(stamps));
}

// ---------------------------------------------------------------------------
// 10. A re-flow parks a crate rather than stranding it.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 3);
  const belts = lay(g, cells);
  const crate = crateOn(g, belts[1], GOODS, 3);
  const total = units(g);

  const gone = g.removeFixture('me', belts[1].id);
  check(gone.ok, 'the belt under the crate comes out', gone.error ?? '');

  eq(crate.belt ?? null, null, 'the crate is set down rather than left holding a dead id');
  eq(units(g), total, '...with everything still in it');
  check(g.deliveries.some((d) => d.id === crate.id), '...and still in the world');

  // And it is an ordinary crate again — the thing that proves it is not
  // stranded is that the ordinary machinery can see it.
  eq(g.homeSupply(GOODS.id), 3, 'it counts as supply on the floor');
  run(g, 40);
  eq(crate.belt ?? null, null, 'and nothing puts it back on a belt that is gone');
}

// ---------------------------------------------------------------------------
// 11. A belt is a square you can post goods onto by hand.
//
// The gesture is `dropCarry`/`dropCrate` and the target is an ordinary tile, so
// almost everything about this is the setdown that already existed. The one
// thing that is NOT the old verb is the refusal: `dropGoods` tops up a box on
// the cell or stacks a second one, and a conveyor holds exactly one crate. A
// setdown that quietly stacked would put two boxes on a square the belt pass can
// only ever move one of, which is backpressure destroyed by the one hand that
// was trying to help.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 3);
  const belts = lay(g, cells);
  const me = g.players.me;
  // Standing ON it, which is only possible because a belt does not block.
  me.x = belts[0].x;
  me.z = belts[0].z;
  me.carry = { stacks: [{ item_id: GOODS.id, qty: 4, day: g.day - 5 }] };
  // Hands and shoulder are goods too — `units` counts what is on the floor and
  // on the boards, so a baseline taken without them says the drop CREATED four.
  const all = () => units(g) + lotTotal(me.carry ?? { stacks: [] })
    + lotTotal(me.haul ?? { stacks: [] });
  const total = all();

  const res = g.dropCarry('me', belts[0].x, belts[0].z);
  check(res.ok, 'an armful goes down onto a belt', res.error ?? '');
  eq(me.carry ?? null, null, '...and the hands are empty afterwards');
  const box = g.deliveries.find((d) => d.belt === belts[0].id);
  check(!!box, '...as a crate the belt is carrying, not one standing on it');
  eq(all(), total, '...with nothing created or destroyed on the way');
  if (box) {
    eq(lotStacks(box)[0].day, g.day - 5,
      '...keeping the spoilage stamp it had in your hands');
  }

  // One crate per cell. The whole texture, said about the player.
  me.carry = { stacks: [{ item_id: GOODS.id, qty: 2 }] };
  const again = g.dropCarry('me', belts[0].x, belts[0].z);
  check(!again.ok, 'a cell that already has a box on it refuses a second');
  eq(lotTotal(me.carry), 2, '...and the goods stay in your hands rather than vanishing');

  // ...and it RIDES, which is the difference between posting and putting down.
  run(g, 30);
  const now = g.deliveries.find((d) => d.id === box?.id);
  check(!!now?.belt && now.belt !== belts[0].id, 'the box you posted travels down the run');
}
{
  // The same on a shoulder, because `haul` and `carry` are two fields and a
  // shared function is one caller reading the wrong one of them.
  const g = fresh();
  const cells = beltRun(g, 3);
  const belts = lay(g, cells);
  const me = g.players.me;
  me.x = belts[0].x;
  me.z = belts[0].z;
  me.haul = { stacks: [{ item_id: GOODS.id, qty: 9, day: g.day }] };
  const all = () => units(g) + lotTotal(me.carry ?? { stacks: [] })
    + lotTotal(me.haul ?? { stacks: [] });
  const total = all();

  const res = g.dropCrate('me', belts[0].x, belts[0].z);
  check(res.ok, 'a crate on the shoulder goes down onto a belt', res.error ?? '');
  eq(me.haul ?? null, null, '...and the shoulder is empty afterwards');
  eq(all(), total, '...with nothing created or destroyed');
  eq(g.deliveries.filter((d) => d.belt === belts[0].id).length, 1,
    '...as exactly one box on that cell');
}

// ---------------------------------------------------------------------------
// 11b. ...and it may not REST on one.
//
// The square being part of a run and the box being ON the run are two claims,
// and a box could satisfy the first without the second for as long as there
// have been belts. Rot is how it happens without anybody asking for it:
// `dropWaste` puts it down where the food was, and in a shop with a line down
// the aisle that is a conveyor cell. Nothing then owns it — `stepBelts` moves
// what has `d.belt`, `armDrop` refuses to put anything on a rail, and a loader's
// side scan is about the floor. So it stands there with goods gliding through
// it, untouchable by every machine in the building, which looks exactly like a
// belt that refused it. Four crates on one live save.
//
// Both halves, because either alone is the wrong feature: what may ride goes ON
// (a run you built is a thing that takes goods somewhere), and what may not is
// moved CLEAR. And the control, which is most of the risk in a rule that moves
// boxes: a crate that was never on a rail must not shuffle anywhere.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 3);
  const belts = lay(g, cells);
  const total = units(g);

  // Set down on the middle of the run, riding nothing — the state `dropWaste`
  // leaves rot in, written the short way.
  const stray = g.dropGoods(GOODS.id, 3, { x: belts[1].x, z: belts[1].z }, { exact: true });
  check(!!stray && !stray.belt, 'a box can end up standing on a run without riding it');
  run(g, 40);
  check(!!stray.belt, '...and the run takes it rather than letting it stand there');
  eq(units(g), total + 3, '...with nothing created or destroyed getting it on');
}
{
  // Rubbish, with no skip anywhere on the network: it may never ride, or it is
  // a passenger the run can never be rid of. So it has to be moved clear.
  const g = fresh();
  const cells = beltRun(g, 3);
  const belts = lay(g, cells);
  const before = units(g);
  const rot = g.dropWaste(GOODS.id, 2, { x: belts[1].x, z: belts[1].z });
  check(!!rot?.waste, 'rot goes down as a rubbish crate');
  run(g, 60);
  check(!rot.belt, 'rubbish with no skip down the line never joins the run');
  check(!g.beltAt(Math.round(rot.x), Math.round(rot.z)),
    '...and is moved clear of the rails rather than left standing on them');
  eq(units(g), before + 2, '...and it is the same rubbish, moved rather than binned');
  check(isWalkableTile(g.layout, Math.round(rot.x), Math.round(rot.z)),
    '...onto a square somebody can walk to and pick it up from');
}
{
  // The control. A box on ordinary floor is not the rails' business, and a rule
  // that moved one would be goods shuffling round the shop on their own.
  const g = fresh();
  const cells = beltRun(g, 3);
  lay(g, cells);
  const off = { x: cells[0].x, z: cells[0].z + 1 };
  const spot = isWalkableTile(g.layout, off.x, off.z) ? off : { x: cells[0].x, z: cells[0].z - 1 };
  const box = g.dropGoods(GOODS.id, 2, spot, { exact: true });
  check(!!box, 'a box stands on the floor beside the run');
  const was = `${box.x},${box.z}`;
  run(g, 60);
  eq(`${box.x},${box.z}`, was, 'and a box that was never on the rails does not move');
  check(!box.belt, '...nor is it helped onto a belt nobody put it on');
}

// ---------------------------------------------------------------------------
// 11c. A LOADER AIMED AT A PILE OF ROT LIFTS IT.
//
// The one side a loader would not lift from was the side it FACES, and the
// reason is real: that tile is its off-ramp, so a box set down there and picked
// straight back up is a two-swing shuttle for the rest of the save. Three sides
// in, one side out.
//
// It is false about rubbish, and false in the worst direction. Rot never
// reaches the off-ramp — the waste branch of the swing returns above it,
// deliberately, because `armDrop` goes through `dropGoods` and would hand the
// rot back as food — so there is no loop on that side to prevent. What the
// exclusion bought instead was that pointing a loader AT a pile of rot, which
// is the one gesture anybody makes when they want that pile gone, is the single
// aim that refuses it, while all three other sides of the same machine work.
// Nothing logs it, the loader is visibly running, and the pile does not move.
//
// Asserted as a value each way against the same rig, because "it collects rot"
// passes on a loader that was never aimed at any.
// ---------------------------------------------------------------------------
{
  /**
   * belt → loader → skip, with a spare walkable square on one of the loader's
   * other sides. Returns null if the shell leaves no room for the shape.
   */
  const rig = () => {
    const g = fresh();
    const cells = beltRun(g, 2);
    if (!cells) return null;
    lay(g, [cells[0]]);
    for (const r of [0, 1, 2, 3]) {
      const n = anchorTile(cells[1].x, cells[1].z, r);
      if (g.beltAt(n.x, n.z) || !isWalkableTile(g.layout, n.x, n.z)) continue;
      if (!canPlace(g.layout, { kind: 'bin', x: n.x, z: n.z, rot: 0 }).ok) continue;
      const put = g.placeFixture('me', { kind: 'arm', piece: ARM.id, x: cells[1].x, z: cells[1].z, rot: r });
      if (!put.ok) continue;
      // The skip goes on a DIFFERENT side, so the tile the loader faces stays
      // bare floor a crate can stand on — which is the case being asked about.
      let skip = null;
      let spare = null;
      for (const q of [0, 1, 2, 3]) {
        if (q === r) continue;
        const m = anchorTile(cells[1].x, cells[1].z, q);
        if (g.beltAt(m.x, m.z)) continue;
        if (!skip && g.placeFixture('me', { kind: 'bin', piece: 'bin', x: m.x, z: m.z, rot: 0 }).ok) {
          skip = (g.layout.bins ?? []).find((b) => b.x === m.x && b.z === m.z);
          continue;
        }
        if (skip && !spare && isWalkableTile(g.layout, m.x, m.z)) spare = m;
      }
      if (!skip || !spare) continue;
      return { g, arm: g.beltAt(cells[1].x, cells[1].z), faced: n, spare, skip };
    }
    return null;
  };

  const aimed = rig();
  check(!!aimed, 'a belt, a loader and a skip stand in a shop with room to spare');
  if (aimed) {
    const { g, arm, faced } = aimed;
    check(conveyorMeets(g.layout, arm).bins.length > 0,
      'the run knows there is a skip on it, or rubbish may not ride at all');
    const rot = g.dropWaste(GOODS.id, 3, faced);
    check(!!rot?.waste, 'rot stands on the tile the loader is pointing at');
    check(until(g, () => !g.deliveries.some((d) => d.id === rot.id), 900),
      '...and the loader lifts it and the run takes it to the skip',
      `left at ${rot.x},${rot.z} belt=${rot.belt ?? 'none'}`);
  }

  // The pair: the three incidental sides were never the broken half, and a
  // sweep that only asserted the faced one would pass on a loader that lifts
  // rot from nowhere else.
  const beside = rig();
  if (beside) {
    const { g, spare } = beside;
    const rot = g.dropWaste(GOODS.id, 3, spare);
    check(until(g, () => !g.deliveries.some((d) => d.id === rot.id), 900),
      'and rot on a side it is NOT pointing at still goes',
      `left at ${rot.x},${rot.z} belt=${rot.belt ?? 'none'}`);
  }

  // The control, and it is the loop the exclusion exists for: a loader with no
  // skip on its run may not lift rot from the tile it faces either, or the box
  // is a passenger the run can never be rid of.
  {
    const g = fresh();
    const cells = beltRun(g, 2);
    if (cells) {
      lay(g, [cells[0]]);
      let faced = null;
      for (const r of [0, 1, 2, 3]) {
        const n = anchorTile(cells[1].x, cells[1].z, r);
        if (g.beltAt(n.x, n.z) || !isWalkableTile(g.layout, n.x, n.z)) continue;
        if (!g.placeFixture('me', { kind: 'arm', piece: ARM.id, x: cells[1].x, z: cells[1].z, rot: r }).ok) continue;
        faced = n;
        break;
      }
      check(!!faced, 'a loader with no skip anywhere on its run');
      if (faced) {
        const rot = g.dropWaste(GOODS.id, 3, faced);
        run(g, 120);
        check(g.deliveries.some((d) => d.id === rot.id) && !rot.belt,
          '...refuses rot off the tile it faces, exactly as it refuses it off any other');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 11d. THE DUMP HAS AN EXIT, AND IT IS ONLY EVER OPEN TO DEAD STOCK.
//
// A loader that off-ramps what nothing on the run wants is a dump, and the pile
// it makes is by definition unliftable: `shelvesFor` refuses a given-up item
// every board in the building, so no hire will ever come for it and `mayRide`
// will not let it back on the belt. The only way out was to ROT where it stood
// and leave as rubbish days later — which reads as a machine working perfectly
// in a shop that fills up with boxes anyway.
//
// So a skip takes stock too, and the whole safety of that is one word:
// `givenUp`. Which makes the CONTROL the centrepiece rather than the feature —
// a conveyor that can bin things is one wrong predicate away from a machine
// that eats your shop, and live stock going into a skip is invisible twice
// over: nothing logs a shortfall, and a shelf that never got filled and a shelf
// whose delivery was destroyed are the same empty shelf.
//
// Asserted as a value each way against one rig, plus the mixed box, because
// "it bins dead stock" is satisfied by a loader that bins everything.
// ---------------------------------------------------------------------------
{
  /** belt → loader aimed at a skip. The dump, built the way a player would. */
  const rig = () => {
    const g = fresh();
    const cells = beltRun(g, 2);
    if (!cells) return null;
    lay(g, [cells[0]]);
    for (const r of [0, 1, 2, 3]) {
      const n = anchorTile(cells[1].x, cells[1].z, r);
      if (g.beltAt(n.x, n.z)) continue;
      if (!g.placeFixture('me', { kind: 'bin', piece: 'bin', x: n.x, z: n.z, rot: 0 }).ok) continue;
      const put = g.placeFixture('me', { kind: 'arm', piece: ARM.id, x: cells[1].x, z: cells[1].z, rot: r });
      if (!put.ok) continue;
      // A spare side to stand a crate on, so the loader has something to lift.
      let spare = null;
      for (const q of [0, 1, 2, 3]) {
        if (q === r) continue;
        const m = anchorTile(cells[1].x, cells[1].z, q);
        if (!g.beltAt(m.x, m.z) && isWalkableTile(g.layout, m.x, m.z)) { spare = m; break; }
      }
      if (!spare) continue;
      return { g, cells, arm: g.beltAt(cells[1].x, cells[1].z), spare, skip: n };
    }
    return null;
  };

  const dead = rig();
  check(!!dead, 'a belt, a loader and the skip it is aimed at');
  if (dead) {
    const { g, spare } = dead;
    // What `giveUpBoard` writes, and the only thing that opens this door.
    g.orders.dropped[GOODS.id] = g.day;
    check(g.droppedItem(GOODS.id), 'the shop has given up on the goods');
    const cash = g.cash;
    const box = g.dropGoods(GOODS.id, 5, spare, { exact: true });
    check(until(g, () => !g.deliveries.length, 900),
      'a loader aimed at a skip bins stock the shop has given up on',
      `left ${g.deliveries.map((d) => `${lotTotal(d)}@${d.x},${d.z}`).join(' ')}`);
    eq(g.cash, cash, '...and no money moves in either direction');
    check(!box.stacks?.length || !lotTotal(box), '...with nothing left in the box');
  }

  // THE CONTROL. The same rig, the same crate, the shop has NOT given up.
  const live = rig();
  if (live) {
    const { g, spare } = live;
    g.dropGoods(GOODS.id, 5, spare, { exact: true });
    run(g, 900);
    eq(units(g), 5, 'and live stock is never binned, however long it sits by that loader');
  }

  // The mixed box: the dead half goes, the live half stays in the crate.
  const mixed = rig();
  if (mixed) {
    const { g, spare } = mixed;
    g.orders.dropped[GOODS.id] = g.day;
    const box = g.dropGoods(GOODS.id, 4, spare, { exact: true });
    g.dropGoods(COLD.id, 3, spare, { exact: true });
    check(lotQty(box, GOODS.id) === 4 && lotQty(box, COLD.id) === 3,
      'one box holds a dead pile and a live one');
    run(g, 900);
    eq(g.deliveries.reduce((n, d) => n + lotQty(d, GOODS.id), 0), 0,
      '...the skip takes the pile the shop gave up on');
    eq(units(g), 3, '...and leaves the other one alone');
  }

  // And the way in: a wholly given-up box may ride to a skip, and may not ride
  // a run that has none. Both halves — the second is the rule this relaxed, and
  // without it a dead box rides for ever instead of waiting where it fell.
  {
    const g = fresh();
    const cells = beltRun(g, 3);
    const belts = lay(g, cells);
    g.orders.dropped[GOODS.id] = g.day;
    const box = g.dropGoods(GOODS.id, 3, { x: belts[1].x, z: belts[1].z }, { exact: true });
    run(g, 60);
    check(!box.belt, 'given-up stock never joins a run with no skip on it');
    check(!g.beltAt(Math.round(box.x), Math.round(box.z)),
      '...and is moved clear of the rails, exactly as rubbish is');
  }
  const way = rig();
  if (way) {
    const { g, cells } = way;
    g.orders.dropped[GOODS.id] = g.day;
    const box = g.dropGoods(GOODS.id, 3, { x: cells[0].x, z: cells[0].z }, { exact: true });
    check(until(g, () => !!box.belt || !g.deliveries.some((d) => d.id === box.id), 120),
      '...but it does join one that has a skip down the line');
  }
}

// ---------------------------------------------------------------------------
// 11e. A LOAD-ONLY SHELF LOADER CAN START THE TRIP TO A SKIP.
//
// The destination half already accepted given-up stock in 11d, but the source
// half refused it: `armPull` skipped every given-up stack before making the
// crate. That left a perfectly connected shelf → load → unload → skip rig
// idle at its first machine. The controls are both sides of the safety rule:
// live stock is never pulled just because a skip exists, and dead stock is not
// put on a run that has no skip downstream.
// ---------------------------------------------------------------------------
{
  const sourceRig = () => {
    const g = fresh();
    for (const old of g.layout.shelves ?? []) {
      for (const q of [0, 1, 2, 3]) {
        const at = anchorTile(old.x, old.z, q);
        const rot = [0, 1, 2, 3].find((r) => {
          const faced = anchorTile(at.x, at.z, r);
          return faced.x === old.x && faced.z === old.z;
        });
        if (rot == null) continue;
        if (!canPlace(g.layout, { kind: 'arm', x: at.x, z: at.z, rot }).ok) continue;
        const put = g.placeFixture('me', {
          kind: 'arm', piece: ARM.id, x: at.x, z: at.z, rot,
        });
        if (!put.ok) continue;
        const arm = g.beltAt(at.x, at.z);
        const room = (g.layout.shelves ?? []).find((sh) => sh.x === old.x && sh.z === old.z);
        if (arm && room) return { g, arm, room };
      }
    }
    return null;
  };
  const stock = (g, room) => {
    room.assigned = [];
    room.stacks = [{ item_id: GOODS.id, qty: 5, price: GOODS.base_price, stockedDay: g.day }];
  };

  const dead = sourceRig();
  check(!!dead, 'a loader can stand aimed at a shop-floor shelf');
  if (dead) {
    const { g, arm, room } = dead;
    stock(g, room);
    g.orders.dropped[GOODS.id] = g.day;
    check(g.droppedItem(GOODS.id), 'the source shelf holds stock the shop has given up on');
    const pulled = g.armPull(arm, room, { shelves: [], bins: [{ id: 'downstream-skip' }] });
    check(pulled, 'a downstream skip lets the load-only half pull it off the shelf');
    eq(g.shelfStack(room, GOODS.id)?.qty ?? 0, 0, '...leaving none behind on the board');
    check(g.deliveries.some((d) => d.belt === arm.id && lotQty(d, GOODS.id) === 5),
      '...and making the crate the unload half can bin');
  }

  const live = sourceRig();
  if (live) {
    const { g, arm, room } = live;
    stock(g, room);
    check(!g.armPull(arm, room, { shelves: [], bins: [{ id: 'downstream-skip' }] }),
      'the same route never pulls live stock merely because it reaches a skip');
    eq(g.shelfStack(room, GOODS.id)?.qty ?? 0, 5, '...so every live unit stays on the board');
  }

  const nowhere = sourceRig();
  if (nowhere) {
    const { g, arm, room } = nowhere;
    stock(g, room);
    g.orders.dropped[GOODS.id] = g.day;
    check(!g.armPull(arm, room, { shelves: [], bins: [] }),
      'given-up stock is not pulled onto a run with no skip downstream');
    eq(g.shelfStack(room, GOODS.id)?.qty ?? 0, 5, '...and remains recoverable on its shelf');
  }
}

// ---------------------------------------------------------------------------
// 12. One swing stocks every side, not the first one that takes something.
//
// Invisible in play and invisible in a still frame: a loader that served two
// units and one that served the nearer of them twice as often draw the same
// picture, and over a long enough run both shelves fill either way. So it is
// asserted of ONE swing, which is the only place the difference exists.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const set = armIntoShelf(g, { load: false });
  check(!!set, 'the loader stands beside a unit');
  if (set) {
    // A FREEZER on another side, so the two units want different things and
    // neither can swallow the other's share. With two plain shelves the first
    // takes the lot and the assertion would pass on a broken loader.
    let coldId = null;
    for (const r of [0, 1, 2, 3]) {
      const n = anchorTile(set.loader.x, set.loader.z, r);
      if (n.x === set.shelf.x && n.z === set.shelf.z) continue;
      const put = g.placeFixture('me', { kind: 'freezer', x: n.x, z: n.z, rot: 0 });
      if (put.ok) { coldId = put.placed; break; }
    }
    check(!!coldId, 'a freezer stands on another side of the same loader');
    if (coldId) {
      // Ids survive a re-flow; the records do not. Re-read both.
      const byId = (id) => (g.layout.shelves ?? []).find((sh) => sh.id === id);
      const loader = g.beltAt(set.loader.x, set.loader.z);
      const warm = byId(set.shelf.id);
      const cold = byId(coldId);
      const on = (sh) => (sh?.stacks ?? []).reduce((n, st) => n + (st.qty ?? 0), 0);
      check(!!loader && !!warm && !!cold, 'the rig survived the re-flow');

      if (loader && warm && cold) {
        const crate = g.dropGoods(GOODS.id, 3, { x: loader.x, z: loader.z }, { exact: true });
        crate.stacks.push({ item_id: COLD.id, qty: 3, day: g.day });
        g.loadBelt(loader, crate);
        const total = units(g);

        const moved = g.armSwing(loader);
        check(moved, 'the swing did something');
        // ...and what it did was SEND the box, not empty it.
        //
        // A swing used to serve every side it could reach in the tick it fired,
        // which is what made the transfer undrawable: the goods were on the
        // board and the crate was gone before anything could show a box moving.
        // A spur takes real time now, so a swing chooses a side and sets the
        // crate off down it, and the goods change hands when it ARRIVES.
        //
        // Which makes this a claim about a machine rather than about an instant:
        // both sides are still served off one box, one after the other, with the
        // crate riding back onto the loader in between. The old wording ("in ONE
        // swing") was the implementation showing through — nobody playing could
        // ever have told the difference, and the thing they CAN tell is that the
        // box is visibly on its way somewhere.
        check(!!crate.spur, '...which is to send the crate down a spur, not to empty it');
        // BOTH steps, because a spur is advanced by `stepBelts` rather than by
        // `stepArms` — it is a length of the run, and `beltOrder` is what walks
        // the run. Driving the arms alone dispatches a crate that then never
        // moves, which is a sweep that hangs rather than one that fails.
        for (let i = 0; i < 400 && !(on(warm) > 0 && on(cold) > 0); i++) {
          g.stepBelts(0.05);
          g.stepArms(0.05);
        }
        check(on(warm) > 0 && on(cold) > 0,
          'both sides are stocked off one box', `shelf ${on(warm)}, freezer ${on(cold)}`);
        eq(units(g), total, '...and nothing was created or destroyed reaching two of them');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 13. The crew know the belt is there — and leave what is on it alone.
//
// This is the half the whole feature is worth: the pitch of docs/belts.md is
// that the WALK is the product, and a hire who cannot see a conveyor goes on
// walking. Nothing in it can be looked at — a box on a shelf that rode a belt
// and one a stocker carried are the same box on the same shelf, and the only
// thing that moved is the wage bill.
// ---------------------------------------------------------------------------
{
  // A hire never lifts a box that is riding. `stockCrates` deliberately keeps
  // the whole list — `homeSupply` counts a belted crate as supply and is right
  // to — and `unload` scores a crate off a pad as a STRAY, which carries a 1e6
  // bonus. Unfiltered, every stocker in the shop abandons the bay and beelines
  // for whatever is going past: the conveyor would work perfectly and be emptied
  // by the crew it exists to replace.
  const g = fresh({ crew: STOCKER.id });
  const cells = beltRun(g, 3);
  const belts = lay(g, cells);
  // A run with nothing at the end of it, so the box simply sits there. The only
  // thing that can move it is somebody deciding to.
  const crate = crateOn(g, belts[2], GOODS, 4);
  const total = units(g);

  check(g.stockCrates().some((d) => d.id === crate.id),
    'a crate on a belt is still stock the shop owns');
  check(!g.floorCrates().some((d) => d.id === crate.id),
    '...and is not a crate anybody may walk up to and lift');

  run(g, 600);
  eq(g.deliveries.find((d) => d.id === crate.id)?.belt ?? null, belts[2].id,
    'six hundred ticks later it is still on the belt');
  eq(lotTotal(hire(g)?.carry ?? { stacks: [] }), 0, '...and nobody took an armful out of it');
  eq(units(g), total, '...and nothing went missing while they thought about it');
}
{
  // ...and the positive half. A crate on the pad that a run would deliver goes
  // ON the run rather than being carried to the shelf.
  const g = fresh({ crew: STOCKER.id });
  const set = armIntoShelf(g, { load: false });
  check(!!set, 'the rig stands up for the crew case');
  if (set) {
    const pad = g.dropPad();
    check(!!pad, 'the shop has a drop-off to leave a box on');
    g.dropGoods(GOODS.id, 4, pad);
    const total = units(g);

    check(until(g, () => g.deliveries.some((d) => d.belt)),
      'a stocker posts the box onto the conveyor instead of walking it to a shelf');
    eq(units(g), total, '...and nothing is created or destroyed by the hand-off');

    // ...and the run finishes the job, which is what the trip was for.
    check(until(g, () => ((g.layout.shelves ?? []).find((sh) => sh.id === set.shelf.id)
      ?.stacks ?? []).some((st) => st.item_id === GOODS.id && st.qty > 0)),
      '...and the loader puts it on the board with nobody walking');
    eq(units(g), total, '...conserved end to end');
  }
}
{
  // The control that decides whether any of this is opt-in, and it is doubled:
  // a shop with no conveyor at all, and a conveyor that goes NOWHERE. The second
  // is the one that could break a working shop — a hire who read "there is a
  // belt" rather than "the belt serves this" would walk every delivery onto a
  // dead-ended run and the shop would fill with boxes it could never shelve.
  const g = fresh({ crew: STOCKER.id });
  const cells = beltRun(g, 3);
  lay(g, cells);
  const pad = g.dropPad();
  g.dropGoods(GOODS.id, 4, pad);
  const total = units(g);

  check(until(g, () => (g.layout.shelves ?? [])
    .some((sh) => (sh.stacks ?? []).some((st) => st.item_id === GOODS.id && st.qty > 0))),
  'with no loader on the run the stocker shelves it the old way');
  check(!g.deliveries.some((d) => d.belt),
    '...and never posts anything onto a belt that serves nothing');
  eq(units(g), total, '...conserved');
}

// ---------------------------------------------------------------------------
// 14. A run of loaders, and a ring.
//
// Both are what a shop actually builds and neither existed while the sweep only
// laid straight lines of plain belt. A loader has no authored output — `rot` is
// the shelf it unloads into — so which way it hands on is DERIVED, and for two
// steps the derivation refused to ask a neighbouring loader (its answer is
// derived too, so asking is circular). That is right for a loader with a belt on
// either side and wrong for every run made of loaders, which is what an aisle
// becomes once each cell is stocking a shelf: nobody in the row has a feeder,
// nobody carries straight on, and the run bends wherever rotation order points.
//
// It is invisible twice over. A loader handing the wrong way is the same dark
// rectangle, the flow marks draw amber both ways across a two-cell tug of war,
// and the shop simply does nothing.
// ---------------------------------------------------------------------------

/** The quarter turn that points `from` at `to`. */
const aim = (from, to) => [0, 1, 2, 3].find((r) => {
  const a = anchorTile(from.x, from.z, r);
  return a.x === to.x && a.z === to.z;
}) ?? 0;

{
  // A straight line of loaders behind one belt. Every one of them must carry on
  // in the belt's direction rather than turning into its neighbour.
  const g = fresh();
  const cells = beltRun(g, 4);
  check(!!cells, 'there is room for a four-cell run');
  if (cells) {
    const head = g.placeFixture('me', { kind: 'belt', piece: BELT.id, x: cells[0].x, z: cells[0].z, rot: aim(cells[0], cells[1]) });
    check(head.ok, 'the belt at the head of the run goes down', head.error ?? '');
    for (const c of cells.slice(1)) {
      const put = g.placeFixture('me', { kind: 'arm', piece: ARM.id, x: c.x, z: c.z, rot: 0 });
      check(put.ok, `a loader goes down at ${c.x},${c.z}`, put.error ?? '');
    }
    for (let i = 0; i < cells.length - 1; i++) {
      const cell = g.beltAt(cells[i].x, cells[i].z);
      const to = g.beltNext(cell);
      eq(`${to?.x},${to?.z}`, `${cells[i + 1].x},${cells[i + 1].z}`,
        `the cell at ${cells[i].x},${cells[i].z} carries on down the run`);
    }
    // ...and it still delivers, which is the point of the whole line.
    const crate = crateOn(g, g.beltAt(cells[0].x, cells[0].z), GOODS, 4);
    run(g, 40);
    check(crate.belt !== g.beltAt(cells[0].x, cells[0].z).id
      || lotTotal(crate) < 4, 'and a box put on the head of it goes somewhere');
  }
}

/** Six cells in a 2x3 block, all of them placeable — the smallest real ring. */
function beltRect(g) {
  for (let z = 1; z + 2 < g.layout.h - 1; z++) {
    for (let x = 1; x + 1 < g.layout.w - 1; x++) {
      const block = [
        { x, z }, { x, z: z + 1 }, { x, z: z + 2 },
        { x: x + 1, z: z + 2 }, { x: x + 1, z: z + 1 }, { x: x + 1, z },
      ];
      if (block.every((c) => canPlace(g.layout, { kind: 'belt', x: c.x, z: c.z, rot: 0 }).ok)) return block;
    }
  }
  return null;
}

{
  // The ring, in the order a crate should travel it. Two of the six are plain
  // belts — one per side — which is the shape the tie-break argues for: belts on
  // the corners is not a rule anybody has to be told, it is what happens when
  // you lay a run first and then decide which cells stock a shelf.
  const g = fresh();
  const ring = beltRect(g);
  check(!!ring, 'there is room for a ring');
  if (ring) {
    ring.forEach((c, i) => {
      const to = ring[(i + 1) % ring.length];
      // The two opposite sides get the authored direction; the rest derive.
      const asBelt = i === 1 || i === 4;
      const put = g.placeFixture('me', {
        kind: asBelt ? 'belt' : 'arm', piece: asBelt ? BELT.id : ARM.id,
        x: c.x, z: c.z, rot: aim(c, to),
      });
      check(put.ok, `the ring cell at ${c.x},${c.z} goes down`, put.error ?? '');
    });

    // Walk it. Six hops from any cell must come back to where it started,
    // having touched all six — a ring that dead-ends, doubles back or misses a
    // cell fails this and draws identically.
    const walked = [];
    let at = g.beltAt(ring[0].x, ring[0].z);
    for (let i = 0; i < ring.length; i++) {
      walked.push(`${at.x},${at.z}`);
      const to = g.beltNext(at);
      at = to ? g.beltAt(to.x, to.z) : null;
      if (!at) break;
    }
    eq(new Set(walked).size, ring.length, 'the ring visits every cell once');
    eq(at ? `${at.x},${at.z}` : null, `${ring[0].x},${ring[0].z}`, '...and closes');

    // ...and a lap takes a lap. Stepped in list order every cell of a ring is
    // a leftover — there is no terminus to seed Kahn's algorithm with — so a
    // crate crossed the whole loop in one tick and the belt was an animation
    // over an instant hand-off. Nobody builds a ring in step 1, which is
    // exactly why this looked harmless.
    // Started on one of the two PLAIN BELTS, because the claim is about the
    // stepping order and a loader would answer a different question: a machine
    // holds a box for one swing before letting the run take it on, so a crate
    // put on a loader has not moved a cell in a belt-second and that is the
    // hold rather than the ring.
    const crate = crateOn(g, g.beltAt(ring[1].x, ring[1].z), GOODS, 3);
    run(g, 7); // one belt-second's worth, at BELT_SECONDS 0.6
    const now = g.beltAt(crate.x, crate.z);
    check(now && `${now.x},${now.z}` !== `${ring[1].x},${ring[1].z}`,
      'a crate on a ring moves');
    eq(`${now?.x},${now?.z}`, `${ring[2].x},${ring[2].z}`,
      '...exactly one cell, rather than lapping the whole ring in a tick');
  }
}

// ---------------------------------------------------------------------------
// 15. CONTINUITY: a box never jumps, and a jam is one crate per cell.
//
// The centrepiece of the line rewrite, and the only claim in this file about
// the SHAPE of the code rather than about goods — which is exactly why it is
// written as a measurement taken every tick rather than as a value read at the
// end. A crate that skipped a tile and a crate that travelled it are the same
// box on the same shelf a second later, so nothing downstream of here can tell
// them apart, and watching the game is the one way anybody ever could.
//
// It replaces a claim about `BELT_CREEP_MAX` — a blocked crate creeping up
// behind the one in front, bounded by its own leading edge — which was a claim
// about the per-cell implementation and not about anything a player can name.
// A cell owned a crate, a clock and a decision, so the code between two cells
// was a SEAM, and the seams disagreed: boxes skipped at a T, would not tween
// through a bend, appeared at the end of a segment, and snapped back to the
// start of a cell when a jam cleared. The unit is the LINE now, a crate on one
// has a single number, and the two properties below are what that buys.
//
//   nothing ever goes BACKWARDS along the path — measured as distance along the
//   line plus the length of every line already finished, so a hand-off is only
//   continuous if both lines agree where the seam is;
//
//   and no step is bigger than ONE TICK OF TRAVEL, which is what a teleport, a
//   skip and a snap-back all are.
//
// Asked of a straight run, a bend and a junction, each with the jam that used
// to break it, because the old failures were at the seams and every one of
// those three is a different seam.
// ---------------------------------------------------------------------------

/** One tick of travel at tier 1, and what `r2` costs on the way to the wire. */
const TRAVEL = 0.1 / Game.BELT_SECONDS;
const ROUNDING = 0.02;

/**
 * Step `ticks` ticks, checking both properties of every crate on every one.
 *
 * `progress` is the crate's own distance along its line plus the total of the
 * lines behind it, which is the number a disagreement between two lines would
 * break. `jump` is ordinary distance across the floor, which is the number a
 * teleport would break.
 */
function smooth(g, label, crates, ticks, at = {}) {
  const state = new Map();
  const seat = (d) => {
    if (!state.has(d.id)) state.set(d.id, { base: 0, x: d.x, z: d.z, line: null });
    return state.get(d.id);
  };
  let jumped = null;
  let back = null;
  let biggest = 0;
  for (let i = 0; i < ticks; i++) {
    at[i]?.();
    g.step(0.1);
    for (const d of crates) {
      const s = seat(d);
      const live = g.deliveries.find((q) => q.id === d.id);
      if (!live) { s.gone = true; continue; }
      if (s.gone) continue;
      const jump = Math.hypot(live.x - s.x, live.z - s.z);
      biggest = Math.max(biggest, jump);
      if (jump > TRAVEL + ROUNDING) {
        jumped ??= `${jump.toFixed(3)} tiles at t=${(i * 0.1).toFixed(1)}`;
      }
      s.x = live.x; s.z = live.z;
      const spot = g.beltSpot(live);
      if (!spot) { s.line = null; continue; }
      // A line runs to the FIRST CELL of the next one, so what a crate finished
      // when it changed hands is that overlap included.
      if (s.line && spot.line !== s.line) s.base += s.finished ?? 0;
      s.line = spot.line;
      const ex = g.beltExit(spot.line, live);
      s.finished = ex ? ex.total : spot.line.len;
      const now = s.base + spot.at;
      if (s.was != null && now < s.was - 1e-6) {
        back ??= `${s.was.toFixed(3)} → ${now.toFixed(3)} at t=${(i * 0.1).toFixed(1)}`;
      }
      s.was = now;
    }
  }
  check(!jumped, `${label}: no box ever jumps further than one tick of travel`,
    jumped ? `${jumped}, against ${TRAVEL.toFixed(3)}` : '');
  check(!back, `${label}: no box ever goes backwards along the path`, back ?? '');
  check(biggest > 0.01, `${label}: ...and they did in fact move`);
}

{
  // A straight run of five into a dead end, three boxes on it, and the head
  // taken away half way through — which is the moment a per-cell charge dropped
  // to zero and re-drew a crept crate back at its own centre. That is the
  // "resets to the start of a cell when a jam clears" report, and it fires
  // exactly when a jam clears, which is why it read as the busy junction.
  const g = fresh();
  const cells = beltRun(g, 5);
  check(!!cells, 'there is room for a run to queue along');
  if (cells) {
    const belts = lay(g, cells);
    const head = crateOn(g, belts[4], GOODS, 2);
    const mid = crateOn(g, belts[2], COLD, 2);
    const tail = crateOn(g, belts[0], GOODS, 2);
    smooth(g, 'straight run', [head, mid, tail], 120, {
      60: () => { g.deliveries = g.deliveries.filter((d) => d.id !== head.id); },
    });

    // ...AND THE JAM CLOSES UP TO THE CLAMP, which is what `CRATE_PITCH` is:
    // boxes touching, one box-width apart, however far along a cell that leaves
    // them. It was a whole cell and the two claims traded places — see the note
    // on the constant. The HEAD is the box that sits squarely somewhere, because
    // it stopped where the line stops; everything behind it is measured off the
    // box in front rather than off the ground, or the clamp is not what is
    // holding the queue and a jam would draw with gaps in it.
    //
    // The capacity claim did not go away, it moved: `CRATES_PER_CELL` is this
    // same number said the other way, and the yard sweep at the foot of this
    // file is where it is spent. The pair is the assertion — a pitch that
    // tightened without the credit following is a run that silently eats an
    // allowance nobody gave it.
    run(g, 120);
    const settled = [mid, tail].map((d) => d.belt);
    check(g.beltSpot(mid).at > g.beltSpot(tail).at,
      'two boxes queued behind the end are still in the order they arrived',
      `${g.beltSpot(mid).at} > ${g.beltSpot(tail).at}`);
    check(settled.every((b) => b != null), 'and both are filed on a cell of the run');
    const gap = Math.abs(g.beltSpot(mid).at - g.beltSpot(tail).at);
    near(gap, Game.CRATE_PITCH, 'closed up to exactly one pitch — boxes touching');
    eq(Game.CRATES_PER_CELL, Math.floor(1 / Game.CRATE_PITCH),
      '...and the capacity credit is that same pitch counted per cell');
  }
}

{
  // The bend. A corner used to be the place two cells with two clocks and two
  // opinions met at a right angle, so a crate would arrive without having
  // travelled — the picture the run of the belt is drawn to say.
  const g = fresh();
  const cells = beltRun(g, 3);
  if (cells) {
    const [p, q] = cells;
    lay(g, [p]);
    g.placeFixture('me', { kind: 'belt', piece: BELT.id, x: q.x, z: q.z, rot: 3 });
    const up = anchorTile(q.x, q.z, 3);
    const on = g.placeFixture('me', { kind: 'belt', piece: BELT.id, x: up.x, z: up.z, rot: 3 });
    if (on.ok) {
      const head = crateOn(g, g.beltAt(up.x, up.z), GOODS, 2);
      const round = crateOn(g, g.beltAt(p.x, p.z), GOODS, 2);
      smooth(g, 'bend', [head, round], 120, {
        50: () => { g.deliveries = g.deliveries.filter((d) => d.id !== head.id); },
      });
    }
  }
}

{
  // The junction, which is where every one of these bugs showed up first — a
  // crate changing which way it was going is a crate changing which piece of
  // code owned where it was.
  const g = fresh();
  const cells = beltRun(g, 3);
  if (cells) {
    lay(g, [cells[0], cells[2]]);
    let branch = null;
    for (const r of [0, 1, 2, 3]) {
      const n = anchorTile(cells[1].x, cells[1].z, r);
      if (g.beltAt(n.x, n.z)) continue;
      if (!canPlace(g.layout, { kind: 'belt', x: n.x, z: n.z, rot: 0 }).ok) continue;
      const away = { x: n.x + (n.x - cells[1].x), z: n.z + (n.z - cells[1].z) };
      const put = g.placeFixture('me', { kind: 'belt', piece: BELT.id, x: n.x, z: n.z, rot: aim(n, away) });
      if (!put.ok) continue;
      branch = g.beltAt(n.x, n.z);
      break;
    }
    const made = branch && g.placeFixture('me', {
      kind: 'sorter', piece: 'sorter', x: cells[1].x, z: cells[1].z, rot: aim(cells[1], branch),
    });
    if (branch && made?.ok) {
      // A stream of boxes onto the head, so the junction is asked over and over
      // with traffic behind it and both of its ways out taken in turn.
      const fed = [];
      const feed = () => {
        const cell = g.beltAt(cells[0].x, cells[0].z);
        if (g.beltCellFree(cell)) fed.push(crateOn(g, cell, GOODS, 2));
      };
      feed();
      const at = {};
      for (let i = 8; i <= 100; i += 8) at[i] = feed;
      smooth(g, 'junction', fed, 130, at);
      check(fed.length >= 4, '...with real traffic through it', `${fed.length} boxes`);
    }
  }
}

{
  // ...AND A MACHINE MUST NOT GRAB A BOX THAT IS ALREADY LEAVING IT.
  //
  // The one bug the line model introduced, found in a real shop and not by any
  // assertion above it. A loader asks what it is HOLDING, and a crate that has
  // begun to cross onto the next square is no longer that — which is right
  // about the machine and wrong about the square, because one cell still holds
  // one crate and the box on its way out is still it. So a loader with a crate
  // half a tile gone read as empty, went to lift the box lying beside it, and
  // `armSend` — which looked up "whichever crate names this cell" — put the
  // DEPARTING one down the spur instead. What that draws is a crate jumping
  // backwards a tile and setting off sideways, which is the exact report this
  // whole rewrite was done for, arriving through a new door.
  //
  // Both halves are pinned: the machine may not lift while its square is
  // crossing, and `armSend` may only ever move what `armHolds` names.
  const g = fresh();
  const cells = beltRun(g, 3);
  if (cells) {
    lay(g, [cells[0], cells[2]]);
    const made = g.placeFixture('me', {
      kind: 'arm', piece: ARM.id, x: cells[1].x, z: cells[1].z, rot: aim(cells[1], cells[2]),
    });
    check(made.ok, 'a loader goes in the middle of the run', made.error ?? '');
    const arm = g.beltAt(cells[1].x, cells[1].z);
    const beside = [0, 1, 2, 3]
      .map((r) => anchorTile(arm.x, arm.z, r))
      .find((c) => !g.beltAt(c.x, c.z) && isWalkableTile(g.layout, c.x, c.z)
        && (c.x !== cells[2].x || c.z !== cells[2].z));
    check(!!beside, 'there is floor beside the loader to leave a box on');
    if (beside) {
      const leaving = crateOn(g, arm, GOODS, 2);
      const loose = g.dropGoods(GOODS.id, 2, beside, { exact: true });
      const total = units(g);
      smooth(g, 'a loader whose box is leaving', [leaving, loose], 120);
      eq(units(g), total, '...and nothing was created or destroyed doing it');
    }
  }
}

{
  // ...AND EVERY BOX THAT GOES PAST A LOADER IS OFFERED TO IT. ONCE, ALWAYS.
  //
  // The claim that decides whether an aisle stocks at all, and the one that
  // reads as the feature not working rather than as a bug. A crate crosses a
  // cell in one cell-time and a loader swings on a clock of its own, so a
  // machine that only looks at what is squarely on it sees one tick in twelve
  // and the aisle it was bought to fill quietly stays empty — with every box
  // visibly trundling past every one of them. A machine that looks at whatever
  // names its cell has the mirror problem: it grabs boxes that have already
  // begun to leave and yanks them backwards.
  //
  // So a loader HOLDS a box for one swing, and this is the assertion that says
  // so: several boxes down one run, and every single one of them is served.
  // Written as "all of them" rather than "some of them", because a lottery
  // passes any weaker claim — the broken version stocked about one box in
  // twelve and looked exactly like a slow shop.
  const g = fresh();
  let built = null;
  for (const shelf of g.layout.shelves ?? []) {
    for (const rot of [0, 1, 2, 3]) {
      const cell = anchorTile(shelf.x, shelf.z, rot);
      const back = anchorTile(cell.x, cell.z, (rot + 1) % 4);
      const front = anchorTile(cell.x, cell.z, (rot + 3) % 4);
      if (!canPlace(g.layout, { kind: 'arm', x: cell.x, z: cell.z, rot: (rot + 2) % 4 }).ok) continue;
      if (!canPlace(g.layout, { kind: 'belt', x: back.x, z: back.z, rot: 0 }).ok) continue;
      if (!canPlace(g.layout, { kind: 'belt', x: front.x, z: front.z, rot: 0 }).ok) continue;
      built = { shelf, cell, back, front };
      break;
    }
    if (built) break;
  }
  check(!!built, 'there is a shelf with a run that can pass a loader');
  if (built) {
    const { shelf, cell, back, front } = built;
    g.placeFixture('me', { kind: 'belt', piece: BELT.id, x: back.x, z: back.z, rot: aim(back, cell) });
    g.placeFixture('me', { kind: 'arm', piece: ARM.id, x: cell.x, z: cell.z, rot: aim(cell, shelf) });
    g.placeFixture('me', {
      kind: 'belt', piece: BELT.id, x: front.x, z: front.z,
      rot: aim(front, { x: front.x * 2 - cell.x, z: front.z * 2 - cell.z }),
    });
    const feeder = g.beltAt(back.x, back.z);
    const item = shelfWants(g, shelf);
    check(!!item, 'the unit beside it will take one of the test items');
    if (feeder && item) {
      const sent = [];
      const total0 = units(g);
      for (let i = 0; i < 400 && sent.length < 5; i++) {
        if (g.beltCellFree(feeder)) {
          const d = g.dropGoods(item, 3, { x: feeder.x, z: feeder.z }, { exact: true });
          if (d && g.loadBelt(feeder, d)) sent.push({ crate: d, had: lotTotal(d) });
        }
        g.step(0.1);
      }
      run(g, 200);
      eq(sent.length, 5, 'five boxes went down the run');
      const served = sent.filter(({ crate, had }) => {
        const live = g.deliveries.find((d) => d.id === crate.id);
        return !live || lotTotal(live) < had;
      }).length;
      eq(served, sent.length, 'the loader served EVERY box that passed it',
        `${served} of ${sent.length} — a machine that only sees a box squarely on its cell catches about one in twelve`);
      eq(units(g), total0 + sent.reduce((n, s) => n + s.had, 0),
        '...and conserved every unit doing it');
    }
  }
}

{
  // ...AND A BELT FULL OF STOCK MUST NOT WELD THE SHOP'S BOARDS OPEN.
  //
  // The one claim in this file that is not about a conveyor at all, and it is
  // here because a conveyor is what makes it happen. `releaseBoards` holds an
  // empty board while `homeSupply` says stock of that item exists — reasonable,
  // since it might refill — and `homeSupply` counts every crate in the shop
  // including the ones riding a belt. So a board that is empty *because* the
  // goods are stuck going round resets its own clock on the strength of the
  // goods that are stuck, for ever. It never ages, so it never releases.
  //
  // The closed state is stable rather than slow, which is what makes it worth an
  // assertion: `shelfCapacity` is shared among the boards a unit has open, so a
  // unit with every board open and empty has room on none of them, `pourInto`
  // moves nothing, the box rides on and off-ramps onto the drop-off, and the
  // board holds itself open on the strength of the box it could not take. A live
  // shop reached fifteen units of twenty like that, with a warmer reading 19/10
  // because the capacity had been divided under stock already standing on it.
  // What it looks like is a shop that quietly stopped shelving anything, days
  // after the belts filled up.
  //
  // So a bare board on a unit with no spare is given back whatever `homeSupply`
  // says. Asserted with the crate ON A BELT, because that is the supply that
  // cannot land and the reason the guard was immortal.
  const g = fresh();
  const cells = beltRun(g, 2);
  const id = (g.layout.shelves ?? []).find((u) => u.kind === 'shelf' && !u.boh)?.id;
  check(!!cells && !!id, 'there is a run and a plain shelf to fill the boards of');
  if (cells && id) {
    const belts = lay(g, cells);
    // AFTER the run is laid, because laying it re-flows: a record captured
    // before is a copy of a shelf that no longer exists, and every assertion
    // below would be read off the ghost while the roll walked the live one.
    const shelf = (g.layout.shelves ?? []).find((u) => u.id === id);
    check(!!shelf, 'the unit survives the run being laid');
    // Every board on the unit opened and left empty, which is the state a shop
    // gets into by pouring a little of everything and selling it down.
    for (const item of Object.values(content().byId.items)) {
      if (g.shelfStacks(shelf).length >= g.shelfBoards(shelf)) break;
      g.boardFor(shelf, item);
    }
    const bare = g.shelfStacks(shelf).filter((k) => !(k.qty > 0)).map((k) => k.item_id);
    check(g.shelfStacks(shelf).length >= g.shelfBoards(shelf), 'the unit has every board open',
      `${g.shelfStacks(shelf).length} of ${g.shelfBoards(shelf)}`);
    check(bare.length > 0, '...and all of them bare');

    if (bare.length) {
      // A crate of one of those very items, riding the belt: supply the shop
      // owns and cannot put anywhere, which is exactly what the guard reads.
      const stuck = g.dropGoods(bare[0], 4, { x: belts[0].x, z: belts[0].z }, { exact: true });
      check(!!stuck && g.loadBelt(belts[0], stuck), 'a crate of one of them is on the belt');
      check(g.homeSupply(bare[0]) > 0, '...and the shop counts it as supply it already has');

      const before = g.shelfStacks(shelf).length;
      g.tradedToday = true;
      g.releaseBoards(true);
      const after = g.shelfStacks(shelf).length;
      check(after < before, 'the roll gives a bare board back on a unit with none to spare',
        `${before} boards before, ${after} after — the supply guard used to hold it open for ever`);
      check(g.shelfStacks(shelf).length < g.shelfBoards(shelf),
        '...so the unit has somewhere to put the next crate');
      eq(lotQty(stuck, bare[0]), 4, '...and the crate it was holding out for is untouched');
    }
  }
}

// 16. The off-ramp: a loader facing bare ground sets the box down.
//
// Without one a belt has exactly one exit — a board that will take the goods —
// so a crate holding anything no unit on the run wants rides for ever, round a
// loop or parked at a dead end where nothing can reach it, since the crew are
// told to leave a riding box alone. It looks exactly like a working conveyor.
//
// The two claims that stop it being a shop that buries its own floor are the
// ones that cannot be looked at: that it is only reached once every unit beside
// it has had its share, and that the loader does not pick straight back up what
// it has just put down.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 2);
  check(!!cells, 'there is room for a loader and a mat in front of it');
  if (cells) {
    const put = g.placeFixture('me', {
      kind: 'arm', piece: ARM.id, x: cells[0].x, z: cells[0].z, rot: aim(cells[0], cells[1]),
    });
    check(put.ok, 'the loader goes down facing bare floor', put.error ?? '');
    const arm = g.beltAt(cells[0].x, cells[0].z);
    // Frozen, in a shop with no freezer in it — so no unit anywhere beside the
    // loader can take a single one and the only way off is the floor.
    const crate = crateOn(g, arm, COLD, 4);
    const total = units(g);

    run(g, 40);
    check(!g.deliveries.some((d) => d.belt === arm.id),
      'the loader unloaded the box it could not shelve');
    const down = g.deliveries.filter((d) => !d.belt
      && Math.round(d.x) === cells[1].x && Math.round(d.z) === cells[1].z);
    check(down.length > 0, '...onto the square it faces, as an ordinary pallet');
    eq(down.reduce((n, d) => n + lotQty(d, COLD.id), 0), 4, '...with everything in it');
    eq(units(g), total, '...and nothing created or destroyed on the way off');
    void crate;

    // ...and it does NOT pick it straight back up, which is the loop this whole
    // branch would otherwise be: three sides in, one side out.
    run(g, 200);
    check(!g.deliveries.some((d) => d.belt === arm.id),
      'and it never lifts back what it just set down');

    // It stacks, the way every other pile in the game does — and it stops. An
    // uncapped mat is a loader that buries the floor for the rest of the save;
    // a mat of one is a stockroom that holds a single box.
    const mat = () => g.deliveries.filter((d) => !d.belt
      && Math.round(d.x) === cells[1].x && Math.round(d.z) === cells[1].z).length;
    for (let i = 0; i < 4; i++) { crateOn(g, arm, GOODS, 8); run(g, 40); }
    eq(mat(), 3, 'the mat stacks to the cap and no further');
    check(g.deliveries.some((d) => d.belt === arm.id),
      '...and the next box waits on the loader rather than spilling');
  }
}
{
  // The control, and it is the one that decides whether this buries your floor:
  // a loader bolted to a unit that WANTS the goods must put them on the board
  // and never on the ground, however its facing happens to point.
  const g = fresh();
  const set = armIntoShelf(g);
  if (set) {
    run(g, 80);
    const on = (set.shelf.stacks ?? []).reduce((n, st) => n + (st.qty ?? 0), 0);
    check(on > 0, 'the shelf still gets its goods');
    eq(g.deliveries.filter((d) => !d.belt).length, 0,
      '...and nothing was set down on the floor instead');
  }
}

// ---------------------------------------------------------------------------
// 16b. …AND THE OFF-RAMP IS AT THE END OF THE RUN, nowhere else.
//
// The pair to 16, and the one that says what the exit is FOR. A loader with
// somewhere to hand the box on passes it, whatever is lying beside it — so a
// jam is a row of boxes not moving, which is the picture 16 above is careful
// about everywhere except here.
//
// It was the other way round for eight steps, and the reason it gave is still
// the right reason: without an exit a crate nothing wants rides for ever. What
// changed is that a dead end stopped being the only shape a run comes in. Since
// docs/belts.md step 9 an aisle can send what its shelves would not take back
// over the top and round, and under the old rule the FIRST loader with a full
// board and a walkable tile beside it emptied the box onto the floor long
// before it ever reached the return leg. Every box that came off was a box the
// shelf genuinely refused, so the machine reads as working — and what you watch
// is a conveyor that spits your stock out whenever it gets busy.
//
// Invisible either way: a crate on the floor beside a loader is a crate on the
// floor beside a loader, and the only thing that says which rule put it there
// is whether the run carried on past that cell.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 3);
  check(!!cells, 'there is room for a loader with a run past it');
  if (cells) {
    // A loader in the MIDDLE, aimed across the run at bare floor, with a belt
    // still in front of it. Frozen goods in a shop with no freezer, so nothing
    // anywhere beside it will take a single one — which is exactly the box 16
    // above puts on the ground.
    const side = [1, 3].map((r) => anchorTile(cells[1].x, cells[1].z, r))
      .find((s) => canPlace(g.layout, { kind: 'belt', x: s.x, z: s.z, rot: 0 }).ok);
    check(!!side, 'and bare floor beside it to dump onto');
    const head = g.placeFixture('me', {
      kind: 'belt', piece: BELT.id, x: cells[0].x, z: cells[0].z, rot: aim(cells[0], cells[1]),
    });
    check(head.ok, 'the belt behind it goes down', head.error ?? '');
    const put = g.placeFixture('me', {
      kind: 'arm', piece: ARM.id, x: cells[1].x, z: cells[1].z, rot: aim(cells[1], side),
    });
    check(put.ok, 'the loader goes down facing that floor', put.error ?? '');
    const tail = g.placeFixture('me', {
      kind: 'belt', piece: BELT.id, x: cells[2].x, z: cells[2].z, rot: aim(cells[1], cells[2]),
    });
    check(tail.ok, 'and the run carries on past it', tail.error ?? '');

    const arm = g.beltAt(cells[1].x, cells[1].z);
    check(!!conveyorNext(g.layout, arm), 'the loader has somewhere to hand on');
    crateOn(g, g.beltAt(cells[0].x, cells[0].z), COLD, 4);
    const total = units(g);
    run(g, 200);

    // THE CLAIM. Nothing on the ground anywhere, and the goods are still on the
    // run — which is the pair, because "nothing on the floor" is also satisfied
    // by a box that was destroyed.
    eq(g.deliveries.filter((d) => !d.belt).length, 0,
      'a loader with a run in front of it never sets the box down');
    eq(g.deliveries.filter((d) => d.belt).length, 1, '...and the box is still on the run');
    eq(units(g), total, '...with nothing created or destroyed');
  }
}

// ---------------------------------------------------------------------------
// 17. A loader AIMED at a conveyor feeds it, rather than joining it.
//
// `rot` on a loader is the side its output goes to, and until this it only ever
// meant a shelf or bare ground — the pass-through was derived, which is right
// for a cell sitting IN a run and leaves no way at all to say "this one feeds
// that line". A loader taking off a shelf and injecting into a loop beside it is
// an ordinary thing to build and no rotation would do it.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 3);
  check(!!cells, 'there is room for a run to feed');
  if (cells) {
    const belts = lay(g, cells);
    // Beside the middle cell, aimed at it. Searched over both flanks, because
    // which side of a run is free is a fact about the shell.
    let feeder = null;
    for (const r of [0, 1, 2, 3]) {
      const n = anchorTile(cells[1].x, cells[1].z, r);
      if (g.beltAt(n.x, n.z)) continue;
      const put = g.placeFixture('me', {
        kind: 'arm', piece: ARM.id, x: n.x, z: n.z, rot: aim(n, cells[1]),
      });
      if (put.ok) { feeder = g.beltAt(n.x, n.z); break; }
    }
    check(!!feeder, 'a loader stands beside the run, aimed at it');
    if (feeder) {
      const to = g.beltNext(feeder);
      eq(`${to?.x},${to?.z}`, `${cells[1].x},${cells[1].z}`,
        'it hands into the run rather than joining its flow');
      // ...and the run it is feeding is unchanged, which is the half that says
      // this is an injection rather than a rerouting.
      for (let i = 0; i < 2; i++) {
        const on = g.beltNext(g.beltAt(cells[i].x, cells[i].z));
        eq(`${on?.x},${on?.z}`, `${cells[i + 1].x},${cells[i + 1].z}`,
          `the run still runs at ${cells[i].x},${cells[i].z}`);
      }
      // A box put on the feeder ends up on the run, which is the whole point.
      const crate = crateOn(g, feeder, COLD, 2);
      run(g, 40);
      check(crate.belt && crate.belt !== feeder.id, 'and a box on it joins the line');
    }
  }
}
{
  // ...and never back onto its own feeder. A loader whose rotation happens to
  // point at the belt behind it would otherwise make the pair a two-cell tug of
  // war, which is a run that dead-ends in the middle of itself and draws exactly
  // like a working one.
  const g = fresh();
  const cells = beltRun(g, 3);
  if (cells) {
    const belts = lay(g, cells);
    const gone = g.removeFixture('me', belts[1].id);
    check(gone.ok, 'the middle cell comes out to make room', gone.error ?? '');
    const put = g.placeFixture('me', {
      kind: 'arm', piece: ARM.id, x: cells[1].x, z: cells[1].z, rot: aim(cells[1], cells[0]),
    });
    check(put.ok, 'a loader goes back in facing the belt that feeds it', put.error ?? '');
    const arm = g.beltAt(cells[1].x, cells[1].z);
    const to = g.beltNext(arm);
    check(!to || to.x !== cells[0].x || to.z !== cells[0].z,
      'it does not hand back to the cell feeding it');
  }
}

// ---------------------------------------------------------------------------
// 18. The sorter, which is a splitter with an opinion.
//
// Its whole claim is that it sorts by DESTINATION rather than by a filter, and
// that claim is invisible: a box that went the right way and a box that went the
// way it happened to be pushed are the same box on the same line. The control is
// the splitter — `auto: false`, and a mixed crate, and a crate nothing anywhere
// wants — because a sorter that diverted everything would pass every assertion
// about diverting.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 3);
  check(!!cells, 'there is room for a run to sort along');
  if (cells) {
    // The junction in the middle of a straight run, branching to one side.
    const belts = lay(g, [cells[0], cells[2]]);
    let branch = null;
    for (const r of [0, 1, 2, 3]) {
      const n = anchorTile(cells[1].x, cells[1].z, r);
      if (g.beltAt(n.x, n.z)) continue;
      if (!canPlace(g.layout, { kind: 'belt', x: n.x, z: n.z, rot: 0 }).ok) continue;
      // Pointing AWAY. A branch aimed back at the junction is a two-cell tug of
      // war, and it is the mistake that makes this sweep pass on a broken sorter.
      const away = { x: n.x + (n.x - cells[1].x), z: n.z + (n.z - cells[1].z) };
      const put = g.placeFixture('me', { kind: 'belt', piece: BELT.id, x: n.x, z: n.z, rot: aim(n, away) });
      if (!put.ok) continue;
      branch = g.beltAt(n.x, n.z);
      break;
    }
    check(!!branch, 'a branch line goes down beside the junction');
    const made = branch && g.placeFixture('me', {
      kind: 'sorter', piece: 'sorter', x: cells[1].x, z: cells[1].z,
      rot: aim(cells[1], branch),
    });
    check(!!made?.ok, 'the sorter goes down between them', made?.error ?? '');

    if (branch && made?.ok) {
      const sorter = g.beltAt(cells[1].x, cells[1].z);
      eq(sorter?.kind, 'sorter', 'and it is still a sorter after the re-flow');
      // The trap `verify:bin` names: `compose`'s `else` is `makeShelf`, so a
      // kind with no branch is not refused, it is silently built as shelving.
      check(!(g.layout.shelves ?? []).some((sh) => sh.x === cells[1].x && sh.z === cells[1].z),
        '...rather than shelving on the same square');

      // Its two ways out are different cells, and the branch is the one `rot`
      // named. Without the exclusion in `choose` the derivation would happily
      // pick the branch as the pass-through and it would have one output twice.
      const straight = g.beltNext(sorter);
      check(straight && (straight.x !== branch.x || straight.z !== branch.z),
        'straight on is not the branch');

      // The splitter, which is what it is with the thinking off: alternate.
      g.setSorterAuto('me', sorter.id, false);
      // ...and the switch is on the WIRE, which is the half the sim cannot
      // fail. `sortRows` reads `live.auto` off the snapshot, so a flag that
      // only ever reached the layout leaves the menu describing a junction that
      // has moved: the row you are on stays lit, its press is dead by design,
      // and the other row sends, works, logs and never takes the highlight.
      // Two dead buttons, one of them silent — see `managed`, same bug.
      eq(g.snapshot().sorters?.find((s) => s.id === sorter.id)?.auto, false,
        'the snapshot carries which way a sorter sends things');
      g.setSorterAuto('me', sorter.id, true);
      eq(g.snapshot().sorters?.find((s) => s.id === sorter.id)?.auto, true,
        '...and carries it back the other way');
      const favoured = g.setSorterRoute('me', sorter.id, 'straight');
      check(favoured.ok, 'a sorter can favour its straight-through leg', favoured.error ?? '');
      eq(g.snapshot().sorters?.find((s) => s.id === sorter.id)?.route, 'straight',
        "the snapshot carries a sorter's straight-through preference");
      const priorityCrate = crateOn(g, sorter, GOODS, 2);
      const priorityOut = g.sorterOut(sorter, priorityCrate);
      eq(g.beltAt(priorityOut?.x, priorityOut?.z)?.id, g.beltAt(straight.x, straight.z)?.id,
        'the straight-through preference uses the straight leg before an equally eligible branch');
      g.deliveries = g.deliveries.filter((d) => d.id !== priorityCrate.id);

      /*
       * ...and the OTHER half of the same setting, which is worthless split in
       * two. Asked of the same junction with the same box, because either claim
       * alone is satisfied by a preference that does nothing at all: the chooser
       * below already has an order of its own, so "favour straight sends it
       * straight" passes on a junction that was going to send it straight
       * anyway. The two answers have to DIFFER, and the leg the second one names
       * is `rot`'s — which is what makes turning a sorter a press with something
       * on the far side of it.
       */
      const aimed = g.setSorterRoute('me', sorter.id, 'branch');
      check(aimed.ok, 'a sorter can favour the leg it is aimed at', aimed.error ?? '');
      eq(g.snapshot().sorters?.find((s) => s.id === sorter.id)?.route, 'branch',
        "the snapshot carries a sorter's aimed-leg preference");
      const aimedCrate = crateOn(g, sorter, GOODS, 2);
      const aimedOut = g.sorterOut(sorter, aimedCrate);
      eq(g.beltAt(aimedOut?.x, aimedOut?.z)?.id, g.beltAt(branch.x, branch.z)?.id,
        'the aimed-leg preference uses the branch `rot` names, where straight used the straight leg');
      g.deliveries = g.deliveries.filter((d) => d.id !== aimedCrate.id);

      g.setSorterAuto('me', sorter.id, false);
      const went = [];
      for (let i = 0; i < 4; i++) {
        const crate = crateOn(g, sorter, GOODS, 2);
        run(g, 20);
        went.push(crate.belt === (g.beltAt(branch.x, branch.z)?.id) ? 'b' : 's');
        g.deliveries = g.deliveries.filter((d) => d.id !== crate.id);
      }
      eq(new Set(went).size, 2, 'a splitter uses both ways out', went.join(''));

      // ...and nothing is created or destroyed at a junction, which is a new
      // place goods move between and every one of those has been a hole.
      g.setSorterAuto('me', sorter.id, true);
      const crate = crateOn(g, sorter, GOODS, 5);
      const total = units(g);
      run(g, 60);
      eq(units(g), total, 'nothing is created or destroyed going through it');

      /*
       * ...and the trap `reject`, `auto` and `managed` each sprang, which is the
       * one a favoured leg is most exposed to: `compose` rebuilds this record
       * from its PLACEMENT on every re-flow, and build mode re-flows on every
       * wall segment of a drag. A route written only onto the layout is one that
       * hands itself back to the crew behind you while you are still drawing —
       * and what that reads as is the menu's highlight moving on its own.
       *
       * Last, because a re-flow re-mints these records and every reference taken
       * above it is stale afterwards.
       */
      g.setSorterRoute('me', sorter.id, 'branch');
      g.regenerateLayout();
      const reflowed = g.beltAt(cells[1].x, cells[1].z);
      eq(reflowed?.route, 'branch', 'a favoured leg survives a re-flow');
      eq(g.snapshot().sorters?.find((s) => s.id === reflowed?.id)?.route, 'branch',
        '...and is still on the wire afterwards');

      /*
       * ...AND WHETHER IT HAS ANYTHING TO CHOOSE BETWEEN AT ALL, which is the
       * one state on a conveyor that is invisible by construction.
       *
       * A sorter draws its blades from `conveyorBranches`, so one with no
       * branch has a smooth roof — and a smooth roof reads as art that has not
       * turned yet, not as a machine doing nothing. Every box that reaches it
       * carries straight on and arrives correctly, so nothing says a word. A
       * live shop had FIVE OF SIX like that: junctions laid meaning to run the
       * spur off them, and the spur never built.
       *
       * The control is first and it is the assertion that decides whether the
       * marker is a signal or noise. It also caught the bug on its first run:
       * `conveyorBranches` EXCLUDES the straight leg, so the obvious test —
       * fewer than two branches — flags every ordinary two-way junction in the
       * game. A lamp that lights on a working sorter is the shop reporting a
       * fault it has not got, which is `LAMP_PASS`'s own argument for not being
       * red. Ways out are the straight-on PLUS the branches.
       *
       * Its centrepiece is that the flag tracks the RUN rather than the cell:
       * nothing about this sorter changes when the belt beside it is torn out,
       * which is why the answer is computed on the wire rather than baked in
       * when the piece is placed — the trap `sortReject` names one field up.
       *
       * Last in the block, for the reason the re-flow assertions above it are:
       * `removeFixture` re-mints every record and each one taken earlier is
       * stale afterwards.
       */
      const live = () => g.snapshot().sorters?.find((x) => x.id === reflowed?.id);
      check(!live()?.straight, 'a junction with somewhere to send things is NOT flagged');
      const spur = g.beltAt(branch.x, branch.z);
      const tornOut = spur && g.removeFixture('me', spur.id);
      check(!!tornOut?.ok, 'the branch line comes out', tornOut?.error ?? '');
      // By ID off the re-flowed LAYOUT, never by tile off the snapshot: a
      // sorter on the wire carries its settings and no coordinates at all, so a
      // lookup by x/z there silently answers undefined and the assertion below
      // fails as "not flagged" — which is the bug it is testing for, wearing a
      // typo.
      const now = g.beltAt(cells[1].x, cells[1].z);
      const after = g.snapshot().sorters?.find((x) => x.id === now?.id);
      check(after?.straight === true,
        '...and the moment its only branch is gone, the junction says so',
        'a sorter with one way out is an expensive belt');
    }
  }
}

// ---------------------------------------------------------------------------
// 18d. A split is between the lines that WANT it, never across the junction.
//
// The claim only exists at a junction with THREE ways out, which is why nothing
// above catches it: with two, "exactly one is keen" and "alternate" cover the
// ground between them. With three — a spur to the yard, a line still being
// built, a column with no loader on it yet, all perfectly ordinary — one exit is
// never keen, can never win the single-keen test, and used to draw its full
// share of the alternation anyway.
//
// It is invisible because every box that went the right way went the right way.
// A third of the frozen goods riding off down a dead line reads as a sorter that
// works intermittently, which cannot be told from one that is guessing — and it
// gets worse the more of the shop you automate, since each line you add is one
// more slot for goods that had somewhere to be.
//
// Asked of `sorterOut` rather than of a run, because the failure is a choice and
// a run would only show it as a box in the wrong place several seconds later.
// The paired assertion is that both keen lines are still used: narrowing the
// pool to a single winner would satisfy "never the dead one" while quietly
// turning the splitter off.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  let rig = null;
  for (const sh of g.layout.shelves ?? []) {
    // Shelf at (x,z); loaders at (x+1,z) and (x,z+1) both touch it; the sorter
    // at (x+1,z+1) touches both loaders; the feeder comes up from the south and
    // the dead line leaves to the east.
    for (const [ax, az] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const armA = { x: sh.x + ax, z: sh.z };
      const armB = { x: sh.x, z: sh.z + az };
      const sorter = { x: sh.x + ax, z: sh.z + az };
      const dead = { x: sh.x + ax * 2, z: sh.z + az };
      const feeder = { x: sh.x + ax, z: sh.z + az * 2 };
      const plan = [
        ['arm', armA, aim(armA, sh)],
        ['arm', armB, aim(armB, sh)],
        ['sorter', sorter, aim(sorter, armB)],
        ['belt', dead, aim(dead, { x: dead.x + ax, z: dead.z })],
        ['belt', feeder, aim(feeder, sorter)],
      ];
      if (!plan.every(([kind, at]) => canPlace(g.layout, { kind, x: at.x, z: at.z, rot: 0 }).ok)) continue;
      const built = plan.every(([kind, at, rot]) => g.placeFixture('me', {
        kind, piece: kind === 'sorter' ? 'sorter' : (kind === 'arm' ? ARM.id : BELT.id),
        x: at.x, z: at.z, rot,
      }).ok);
      if (!built) continue;
      rig = { sorter: g.beltAt(sorter.x, sorter.z), armA, armB, dead };
      break;
    }
    if (rig) break;
  }
  check(!!rig, 'a junction with three ways out, two of them serving a shelf');

  if (rig) {
    const ways = [g.beltNext(rig.sorter), ...conveyorBranches(g.layout, rig.sorter)]
      .filter((w) => w && g.beltAt(w.x, w.z));
    eq(ways.length, 3, 'the junction really has three ways out');

    const serves = (w) => {
      const met = conveyorMeets(g.layout, g.beltAt(w.x, w.z));
      return met.shelves.some((u) => g.shelfAccepts(u, GOODS.id));
    };
    const live = ways.filter(serves);
    eq(live.length, 2, '...two of which can put the box away');
    const dud = ways.find((w) => !serves(w));
    check(!!dud, '...and one that serves nothing at all');

    if (dud && live.length === 2) {
      const went = [];
      for (let i = 0; i < 12; i++) {
        // A crate of its own each time, or `sortChoice` answers with the one it
        // remembers and twelve draws is one draw asked twelve times.
        const to = g.sorterOut(rig.sorter, { id: `probe-${i}`, stacks: [{ item_id: GOODS.id, qty: 2 }] });
        went.push(to && to.x === dud.x && to.z === dud.z ? 'x'
          : `${live.findIndex((w) => w.x === to?.x && w.z === to?.z)}`);
      }
      eq(went.filter((w) => w === 'x').length, 0,
        'nothing is ever sent down the line that serves nothing', went.join(''));
      eq(new Set(went).size, 2, '...and both lines that want it are still shared', went.join(''));
    }
  }
}

// ---------------------------------------------------------------------------
// 18f. A loader that only loads, and the pad it stands beside.
//
// Its centrepiece is a round trip that must NOT happen, and the shape is the one
// `verify:hand` was written for: a board the hand clears must not come straight
// back. Here it is a pad. `armDrop` prefers painted ground over everything —
// consent already given — so a loader with a yard on one side and no shelving
// beside it lifts a box off that yard and puts it straight back down on it. The
// run it was bought to feed never gets anything, and every frame of it is a
// machine doing its job.
//
// The control is `both`, which is every loader ever built: the round trip has to
// still happen there, or this is not a switch, it is a change to every save.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const pad = g.dropPad();
  check(!!pad?.cells?.length, 'the shop has a yard to stand beside');

  // A loader touching a pad cell with no shelving anywhere near it.
  let arm = null; // eslint-disable-line prefer-const
  let cell = null;
  for (const c of pad?.cells ?? []) {
    for (const r of [0, 1, 2, 3]) {
      const n = anchorTile(c.x, c.z, r);
      if (!canPlace(g.layout, { kind: 'arm', x: n.x, z: n.z, rot: 0 }).ok) continue;
      if ((g.layout.shelves ?? []).some((sh) => [0, 1, 2, 3]
        .map((q) => anchorTile(n.x, n.z, q))
        .some((s) => s.x === sh.x && s.z === sh.z))) continue;
      if (!g.placeFixture('me', { kind: 'arm', piece: ARM.id, x: n.x, z: n.z, rot: 0 }).ok) continue;
      arm = g.beltAt(n.x, n.z);
      cell = c;
      break;
    }
    if (arm) break;
  }
  check(!!arm, 'a loader stands on the yard with nothing to stock');

  if (arm && cell) {
    eq(arm.mode ?? 'both', 'both', 'a loader is built doing both halves');

    // The control. `both` lifts it and — with nowhere better — puts it back.
    const put = () => {
      g.deliveries = [];
      g.dropGoods(GOODS.id, 4, { x: cell.x, z: cell.z }, { exact: true });
    };
    put();
    const total = units(g);
    run(g, 40);
    const backOnPad = g.deliveries.some((d) => !d.belt
      && Math.round(d.x) === cell.x && Math.round(d.z) === cell.z);
    check(backOnPad, 'doing both, it sets the box back down on the yard');
    eq(units(g), total, '...losing nothing on the way');

    // The version has to MOVE, which is `verify:pick`'s centrepiece said about a
    // setting instead of a selection. The marks and chutes this flag decides all
    // live in `staticRoot`, and the client rebuilds that only when the number
    // changes — so without a bump the switch takes effect in the sim while the
    // picture goes on showing the old one until the next wall you draw. A switch
    // that works and looks like it did nothing is worse than one that does
    // nothing, because you press it again.
    const wasVersion = g.layoutVersion;
    const set = g.setArmMode('me', arm.id, 'load');
    check(set.ok, 'it can be told to only put goods on', set.error ?? '');
    check(g.layoutVersion !== wasVersion, '...and the shop is told to redraw');
    eq(g.snapshot().arms?.find((a) => a.id === arm.id)?.mode, 'load',
      'the snapshot carries it, or the menu describes a machine that has moved');

    put();
    const t2 = units(g);
    run(g, 40);
    const stillPad = g.deliveries.some((d) => !d.belt
      && Math.round(d.x) === cell.x && Math.round(d.z) === cell.z);
    check(!stillPad, 'told to only load, it never puts one back on the yard');
    check(g.deliveries.some((d) => d.belt), '...it is on the line instead');
    eq(units(g), t2, '...and nothing is created or destroyed either way');

    // A re-flow rebuilds the record from the placement — build mode re-flows on
    // every wall segment, so a field the generator forgets clears itself.
    g.regenerateLayout();
    eq(g.beltAt(arm.x, arm.z)?.mode, 'load', '...and it survives a re-flow');

    // ...and it lifts from the pad even when it is POINTING at it. `armSwing`
    // refuses to lift off the side it unloads onto, which is what stops the
    // off-ramp being a two-tick loop — and a load-only loader has no off-ramp,
    // so the exclusion prevents nothing and costs it the one square it was
    // turned toward. Two loaders side by side, one aimed at the yard and one at
    // bare floor, would do different things with nothing on screen to say why.
    // Turned through the real verb rather than by writing `rot`, which is
    // `verify:ferry`'s note about `setBackOfHouse`: a sweep that sets the field
    // passes while the actual press is refused.
    let facing = arm.id;
    for (let i = 0; i < 4; i++) {
      const now = g.findFixture(facing);
      const n = anchorTile(now.x, now.z, now.rot ?? 0);
      if (n.x === cell.x && n.z === cell.z) break;
      const spun2 = g.rotateFixture('me', facing, 1);
      if (!spun2.ok) break;
      facing = spun2.rotated;
    }
    const aimedAtPad = (() => {
      const now = g.findFixture(facing);
      const n = anchorTile(now.x, now.z, now.rot ?? 0);
      return n.x === cell.x && n.z === cell.z;
    })();
    check(aimedAtPad, 'the loader can be turned to face the yard');
    if (aimedAtPad) {
      g.setArmMode('me', facing, 'load');
      g.deliveries = [];
      g.dropGoods(GOODS.id, 4, { x: cell.x, z: cell.z }, { exact: true });
      run(g, 40);
      check(g.deliveries.some((d) => d.belt),
        'a load-only loader lifts from the pad it is POINTING at');
    }
    arm = g.findFixture(facing) ?? arm;

    // ...and a ROTATION, which is a different path and the one that actually
    // happens. `repositionFixture` builds a fresh placement naming each field it
    // keeps, so a setting left out is not un-copied, it is RESET — by the
    // re-flow that same call triggers. The press that does it is R, which is
    // the press you use to aim a loader at the line you want, so the machine
    // hands its pickup back at the exact moment you are setting it up. It looks
    // like the button not working, because the turn you asked for did happen.
    const turned = g.rotateFixture('me', arm.id, 1);
    check(turned.ok, 'the loader can be turned', turned.error ?? '');
    // A turn RE-MINTS the id, which is the trap `bulkFixtures` already records:
    // anything captured before the press goes stale under it.
    const spun = g.findFixture(turned.rotated ?? arm.id);
    eq(spun?.mode, 'load', '...and turning it does not hand back its pickup');
    const armId = spun?.id ?? arm.id;

    // The mirror, which is the claim that keeps this from being one switch with
    // two names: told to only unload, it must never lift.
    const flip = g.setArmMode('me', armId, 'unload');
    check(flip.ok, 'it can be told to only take goods off', flip.error ?? '');
    g.deliveries = [];
    g.dropGoods(GOODS.id, 4, { x: cell.x, z: cell.z }, { exact: true });
    run(g, 40);
    check(!g.deliveries.some((d) => d.belt), 'told to only unload, it lifts nothing');
  }
}

// ---------------------------------------------------------------------------
// 18e. The reject line: where a box nothing wants goes.
//
// Its control is every sorter ever built — `reject` null, and an unwanted box
// splits across the junction exactly as it did before this existed. That
// assertion is the one that decides whether this is opt-in or a change to every
// save in the world.
//
// The claim that costs a shop is the negative one: a reject line must never take
// a box a line WOULD have shelved. That is the `homeFull` spread bug with a
// switch on it, and it is invisible — goods arriving at the yard instead of the
// shelf look exactly like goods that had nowhere else to go.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  let rig = null;
  for (const sh of g.layout.shelves ?? []) {
    for (const [ax, az] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const arm = { x: sh.x + ax, z: sh.z };
      const sorter = { x: sh.x + ax, z: sh.z + az };
      const dead = { x: sh.x + ax * 2, z: sh.z + az };
      const feeder = { x: sh.x + ax, z: sh.z + az * 2 };
      const plan = [
        ['arm', arm, aim(arm, sh)],
        ['sorter', sorter, aim(sorter, arm)],
        ['belt', dead, aim(dead, { x: dead.x + ax, z: dead.z })],
        ['belt', feeder, aim(feeder, sorter)],
      ];
      if (!plan.every(([kind, at]) => canPlace(g.layout, { kind, x: at.x, z: at.z, rot: 0 }).ok)) continue;
      if (!plan.every(([kind, at, rot]) => g.placeFixture('me', {
        kind, piece: kind === 'sorter' ? 'sorter' : (kind === 'arm' ? ARM.id : BELT.id),
        x: at.x, z: at.z, rot,
      }).ok)) continue;
      rig = { sorter: g.beltAt(sorter.x, sorter.z), arm, dead, feeder };
      break;
    }
    if (rig) break;
  }
  check(!!rig, 'a junction with a shelf line and a line that serves nothing');

  if (rig) {
    const s = rig.sorter;
    eq(s.reject ?? null, null, 'a sorter is built with no reject line');

    // The control: with none set, a box nothing wants is shared out.
    const stray = (i) => ({ id: `stray-${i}`, stacks: [{ item_id: COLD.id, qty: 2 }] });
    // COLD needs a freezer and this shop has none, so no line is ever keen.
    const before = [];
    for (let i = 0; i < 8; i++) {
      const to = g.sorterOut(s, stray(i));
      before.push(`${to?.x},${to?.z}`);
    }
    check(new Set(before).size > 1, 'with no reject line, strays are split', before.join(' '));

    const toDead = [0, 1, 2, 3].find((r) => {
      const n = anchorTile(s.x, s.z, r);
      return n.x === rig.dead.x && n.z === rig.dead.z;
    });
    const set = g.setSorterReject('me', s.id, toDead);
    check(set.ok, 'the dead line can be named as the reject', set.error ?? '');
    eq(g.snapshot().sorters?.find((q) => q.id === s.id)?.reject, toDead,
      'the snapshot carries it, or the menu describes a junction that has moved');

    // Every stray, down the one line, every time.
    const after = [];
    for (let i = 0; i < 8; i++) {
      const to = g.sorterOut(rig.sorter, stray(100 + i));
      after.push(to && to.x === rig.dead.x && to.z === rig.dead.z ? 'r' : 'x');
    }
    eq(after.filter((w) => w === 'x').length, 0,
      'every box nothing wants goes down the reject line', after.join(''));

    // ...and the one that would be a leak: a box a line CAN shelve still goes
    // to that line. Asserted after the reject is set, because "sends strays
    // away" passes on a sorter that sends everything away.
    const keen = g.sorterOut(rig.sorter, { id: 'keen-1', stacks: [{ item_id: GOODS.id, qty: 2 }] });
    check(keen && !(keen.x === rig.dead.x && keen.z === rig.dead.z),
      'a box the shelf line will take is NOT rejected');

    // A re-flow rebuilds the record from the placement — build mode re-flows on
    // every wall segment, so a field the generator forgets clears itself behind
    // you while you are still drawing.
    g.regenerateLayout();
    eq(g.beltAt(s.x, s.z)?.reject, toDead, '...and it survives a re-flow');

    // ...and a rotation keeps BOTH of a sorter's settings. `auto` has had this
    // hole since the day it shipped: turning a junction switched the crew back
    // on, silently, in the one press you use to aim its branch.
    g.setSorterAuto('me', s.id, false);
    const spun = g.rotateFixture('me', s.id, 1);
    check(spun.ok, 'the sorter can be turned', spun.error ?? '');
    const now = g.findFixture(spun.rotated ?? s.id);
    eq(now?.auto, false, '...and turning it does not switch the crew back on');
    eq(now?.reject, toDead, '...nor forget where strays go');
    g.setSorterAuto('me', now.id, true);

    const off = g.setSorterReject('me', now.id, null);
    check(off.ok, 'and it can be cleared again', off.error ?? '');
    eq(g.findFixture(now.id)?.reject ?? null, null, '...back to splitting');

    // ...and a reject that matched the AIM follows the aim through a turn.
    //
    // The pair above says a reject side is not forgotten by R. This is the
    // other half and it only exists because of what writes the field: one menu
    // row, "send strays the way it points", which sends whatever `rot` is when
    // you press it. So the two are set together and R moved only one of them —
    // and the side it left behind is not merely stale, it is very often the
    // FEEDER, which is the tug of war `conveyorBranches` has always refused.
    //
    // Both halves or neither: a reject that differs from the aim is somebody
    // naming a side, and turning the piece must not overwrite it.
    // Turned to face the dead line first, so the state under test is reached
    // rather than hoped for: `rot` and `reject` naming the same side, which is
    // the only state that one menu row can leave a junction in.
    let aimed = g.findFixture(now.id);
    for (let i = 0; i < 4 && (aimed.rot ?? 0) !== toDead; i++) {
      const spin = g.rotateFixture('me', aimed.id, 1);
      aimed = g.findFixture(spin.rotated ?? aimed.id);
    }
    eq(aimed.rot ?? 0, toDead, 'a junction can be aimed at the dead line');
    const same = g.setSorterReject('me', aimed.id, toDead);
    check(same.ok, '...and given that same side as its reject', same.error ?? '');
    const spun2 = g.rotateFixture('me', aimed.id, 1);
    check(spun2.ok, 'a junction aimed at its own reject can be turned', spun2.error ?? '');
    const after2 = g.findFixture(spun2.rotated ?? aimed.id);
    eq(after2?.reject, after2?.rot, 'a reject that followed the aim follows the turn');
    check((after2?.rot ?? 0) !== toDead, '...to a side it was not on before');

    // ...and the side the run ARRIVES on is refused outright.
    //
    // It looks exactly as usable as the other three — a conveyor cell touching
    // a conveyor cell — and what it does is worse than nothing: `sorterOut`
    // hands the box to the feeder, `beltExit` puts it back on the feeding line,
    // and it rides into the junction again. Nothing spills, nothing is lost and
    // nothing is logged. The crate circles two cells for the rest of the save,
    // which reads as a reject line that never fires.
    const at = after2;
    const toFeeder = [0, 1, 2, 3].find((r) => {
      const n = anchorTile(at.x, at.z, r);
      return n.x === rig.feeder.x && n.z === rig.feeder.z;
    });
    check(Number.isInteger(toFeeder), 'the feeder is one of the junction\'s four sides');
    const bad = g.setSorterReject('me', at.id, toFeeder);
    check(!bad.ok, 'the side the run arrives on is refused as a reject line');
    check((g.findFixture(at.id)?.reject ?? null) !== toFeeder,
      '...and the refusal came before anything was stored');

    // ...and a save that is ALREADY in that state is not honoured either.
    //
    // Written straight onto the record rather than through the press, which is
    // the one place in here that is right to do: it is a state the press now
    // refuses, so there is no other way to be in it — and every junction given
    // one before today is in it.
    const rec = g.beltAt(at.x, at.z);
    const was = rec.reject;
    rec.reject = toFeeder;
    const back = [];
    for (let i = 0; i < 8; i++) {
      const to = g.sorterOut(rec, stray(200 + i));
      back.push(`${to?.x},${to?.z}`);
    }
    check(!back.includes(`${rig.feeder.x},${rig.feeder.z}`),
      'a stored feeder reject never hands a box back up the run', back.join(' '));
    check(new Set(back).size > 1,
      '...it splits, exactly as a junction with no reject line does', back.join(' '));
    rec.reject = was;
  }
}

// ---------------------------------------------------------------------------
// 18b. ...and the reject side pointed at GROUND, which is a box coming OFF.
//
// A reject line was a line and that was the whole of what it could be: both the
// branch test and the reject test ask `beltAt`, so a junction aimed at a pad or
// at bare floor had a side the piece could not see. Not refused and not warned —
// INVISIBLE, which is the failure worth a sweep: the player says "put what
// nothing wants over there", the shop accepts the press, and the box goes down
// the trunk anyway. Nothing anywhere disagrees with them.
//
// Its control is the pair that must NOT eject: a box a line will take, and a
// sorter with no reject at all. Nearly every way of getting an off-ramp wrong
// takes too much rather than too little — an ejector that fires whenever it is
// asked passes "strays come off" and quietly empties the whole run onto the
// floor, which reads as the belt leaking rather than as the rule being wrong.
//
// And the one that is a claim about a thing NOT happening: a loader cannot
// stand in for this. It offers the box to whatever is beside IT and off-ramps
// the remainder, so it has no way to ask what is further down the run — which
// is why the piece that chooses between lines is the only one that can.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  let rig = null;
  for (const sh of g.layout.shelves ?? []) {
    for (const [ax, az] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const arm = { x: sh.x + ax, z: sh.z };
      const sorter = { x: sh.x + ax, z: sh.z + az };
      const feeder = { x: sh.x + ax, z: sh.z + az * 2 };
      // The square the strays are meant to land on — ordinary walkable floor,
      // with nothing built on it at all. That is the whole point: it is not a
      // conveyor, so nothing about the junction can currently see it.
      const ground = { x: sh.x + ax * 2, z: sh.z + az };
      const plan = [
        ['arm', arm, aim(arm, sh)],
        ['sorter', sorter, aim(sorter, arm)],
        ['belt', feeder, aim(feeder, sorter)],
      ];
      if (!plan.every(([kind, at]) => canPlace(g.layout, { kind, x: at.x, z: at.z, rot: 0 }).ok)) continue;
      if (g.beltAt(ground.x, ground.z)) continue;
      if (!isWalkableTile(g.layout, ground.x, ground.z)) continue;
      if (!plan.every(([kind, at, rot]) => g.placeFixture('me', {
        kind, piece: kind === 'sorter' ? 'sorter' : (kind === 'arm' ? ARM.id : BELT.id),
        x: at.x, z: at.z, rot,
      }).ok)) continue;
      rig = { sorter: g.beltAt(sorter.x, sorter.z), ground };
      break;
    }
    if (rig) break;
  }
  check(!!rig, 'a junction with a shelf line and bare floor beside it');

  if (rig) {
    const s = rig.sorter;
    const stray = (i) => ({ id: `gstray-${i}`, stacks: [{ item_id: COLD.id, qty: 2 }] });
    const takeable = (i) => ({ id: `gkeen-${i}`, stacks: [{ item_id: GOODS.id, qty: 2 }] });

    // THE CONTROL, and it is the assertion that decides whether any of this is
    // opt-in: every sorter ever built has `reject` null, and one of those must
    // never set a box down however unwanted it is.
    eq(g.sorterEject(s, stray(0)), null,
      'with no reject set, nothing is ever ejected — every sorter in every save');

    const toGround = [0, 1, 2, 3].find((r) => {
      const n = anchorTile(s.x, s.z, r);
      return n.x === rig.ground.x && n.z === rig.ground.z;
    });
    const set = g.setSorterReject('me', s.id, toGround);
    check(set.ok, 'bare floor can be named as the reject side', set.error ?? '');

    // COLD wants a freezer and this shop has none, so no line is ever keen.
    const out = g.sorterEject(s, stray(1));
    check(out && out.x === rig.ground.x && out.z === rig.ground.z,
      'a box nothing wants is ejected onto the named square', JSON.stringify(out));

    // ...and the leak, which is the half that matters: a box a line WILL take
    // stays on the run. "Strays come off" passes on an ejector that ejects
    // everything, and that one empties the shop onto the floor.
    eq(g.sorterEject(s, takeable(1)), null,
      'a box the shelf line will take is NOT ejected');

    // A conveyor on the reject side is the hand-off, never a setdown — going
    // through the drop door would put two crates on one cell. The sorter's own
    // `rot` points at the loader that feeds the shelf, so it is one by
    // construction; asserted rather than assumed, or the rig could drift.
    const named = anchorTile(s.x, s.z, s.rot ?? 0);
    check(!!g.beltAt(named.x, named.z), 'the side it points at is a conveyor');
    const line = g.setSorterReject('me', s.id, s.rot ?? 0);
    check(line.ok, 'a line can still be named as the reject', line.error ?? '');
    eq(g.sorterEject(g.beltAt(s.x, s.z), stray(2)), null,
      'a reject side that is a LINE hands on rather than setting down');
    g.setSorterReject('me', s.id, toGround);

    // The goods actually arrive, and nothing is created or destroyed doing it.
    const s2 = g.beltAt(s.x, s.z);
    const box = { id: 'gride-1', belt: s2.id, x: s2.x, z: s2.z, stacks: [{ item_id: COLD.id, qty: 5 }] };
    g.deliveries.push(box);
    const held = units(g);
    for (let i = 0; i < 400; i++) g.step(0.05);
    const landed = g.deliveries.filter((d) => !d.belt
      && Math.round(d.x) === rig.ground.x && Math.round(d.z) === rig.ground.z);
    check(landed.length > 0, 'the crate leaves the run and stands on that square');
    eq(units(g), held, '...and conservation holds across the ejection');

    // It survives the two things that rebuild the record — a re-flow fires on
    // every wall segment of a drag, and R re-mints the id of what it turns.
    g.regenerateLayout();
    eq(g.beltAt(s.x, s.z)?.reject, toGround, '...and a ground reject survives a re-flow');
  }
}

// ---------------------------------------------------------------------------
// 19. A strip curtain over the run: goods through, shoppers not.
//
// The claim is a PAIR, and neither half means anything without the other. That
// the crate crosses is only interesting because a shopper standing on the same
// two cells cannot, and that the shopper is refused is only interesting because
// the run it is hung over goes on working. Split them and each half is satisfied
// by a wall or by nothing at all.
//
// It lives here rather than in `verify:doors` because the thing being protected
// is the belt. Nothing in `stepBelts` consults an edge today — a hand-off is
// between two conveyor cells and asks nothing about the line between them — so
// this passes for a reason that is currently one layer away from the feature.
// That is exactly why it is worth writing down: the day somebody makes a run
// respect the walls it passes through, which is an entirely reasonable thing to
// want, a curtain has to be the exception, and there would otherwise be nothing
// anywhere to say so. What it fails as is a conveyor that stops dead at a
// partition you were told it would carry on through.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 3);
  const belts = lay(g, cells);

  // On the line between the first cell and the second, which the crate crosses
  // on its first hand-off. `edgesV` at x+1 is the west face of the second cell.
  const at = { o: 'v', x: belts[1].x, z: belts[1].z };
  const res = g.buildEdge('me', { ...at, kind: E.CURTAIN_STAFF });
  check(res.ok, 'a curtain hangs over the run', res.error ?? '');
  eq(edgeAt(g.layout, at), E.CURTAIN_STAFF, '...and it is still there after the re-flow');

  check(!shopperCanCross(g.layout, belts[0].x, belts[0].z, belts[1].x, belts[1].z),
    'a shopper may not step across it');
  check(!shopperCanCross(g.layout, belts[1].x, belts[1].z, belts[0].x, belts[0].z),
    '...in either direction');
  check(canStep(g.layout, belts[0].x, belts[0].z, belts[1].x, belts[1].z),
    'while a hire walks straight through');

  const crate = crateOn(g, belts[0]);
  const total = units(g);
  run(g, 60);
  eq(crate.belt, belts[2].id, 'and the crate rides under it to the far end');
  eq(units(g), total, '...with nothing lost on the way through');
}

// ---------------------------------------------------------------------------
// 18b. A pad is consent, so a loader beside one offloads onto it unaimed.
//
// Bare floor needs `rot` — a loader that dumped on whatever open ground it
// passed would spill boxes down the length of every run — and a pad is exactly
// the case where that argument does not apply: painted ground that means *goods
// go here* is permission already given, said once, about that square. Having to
// aim a loader at your own yard is asking for it twice.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const pad = g.dropPad();
  check(!!pad?.cells?.length, 'the shop has a drop-off');
  if (pad?.cells?.length) {
    // A loader touching a pad cell, aimed at something else entirely.
    let arm = null;
    for (const cell of pad.cells) {
      for (const r of [0, 1, 2, 3]) {
        const n = anchorTile(cell.x, cell.z, r);
        if (!canPlace(g.layout, { kind: 'arm', x: n.x, z: n.z, rot: 0 }).ok) continue;
        // Deliberately facing AWAY from the pad, which is the whole claim.
        const away = [0, 1, 2, 3].find((q) => {
          const f = anchorTile(n.x, n.z, q);
          return f.x !== cell.x || f.z !== cell.z;
        });
        const put = g.placeFixture('me', { kind: 'arm', piece: ARM.id, x: n.x, z: n.z, rot: away });
        if (!put.ok) continue;
        arm = g.beltAt(n.x, n.z);
        break;
      }
      if (arm) break;
    }
    check(!!arm, 'a loader stands beside the pad, aimed elsewhere');
    if (arm) {
      // Frozen, in a shop with no freezer: nothing beside it can take a unit,
      // so the pad is the only way off and the claim is not about ranking.
      const crate = crateOn(g, arm, COLD, 4);
      const total = units(g);
      run(g, 60);
      check(!g.deliveries.some((d) => d.belt === arm.id),
        'it offloads onto the pad without being aimed at it');
      const onPad = g.deliveries.filter((d) => !d.belt
        && pad.cells.some((c) => c.x === Math.round(d.x) && c.z === Math.round(d.z)));
      check(onPad.length > 0, '...as a crate standing in the yard');
      eq(units(g), total, '...and nothing created or destroyed on the way');
      void crate;
    }
  }
}

// ---------------------------------------------------------------------------
// 18c. ...and it lands on the pad cell it is TOUCHING.
//
// The claim is that a crate does not teleport, and it is invisible twice over:
// a box that rode to the end of a run and was set down beside it, and one that
// was set down thirty tiles away, are the same box on the same pad — and the
// place you were watching is empty either way, which reads as goods having been
// destroyed rather than moved.
//
// A pad is ONE named region and has never had to be one shape: the brush paints
// cells, so a drop-off is whatever you dragged over, in as many pieces as you
// felt like. `dropGoods` fills a region by list order, so a lone storage cell
// painted at the end of an aisle handed its boxes to the yard by the back door.
// `stow` is right to take the whole region — you walked there, so you are at the
// pad — and that is exactly what a machine standing on one cell cannot say.
//
// Written as a pair, because either half alone passes on the bug: the box has
// to arrive on the near island AND nothing may appear on the far one. A sweep
// that only counted crates-on-the-pad was satisfied by the teleport.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const yard = (g.dropPad()?.cells ?? []).map((c) => ({ x: c.x, z: c.z }));
  check(yard.length > 0, 'the shop starts with a yard to be far from');

  const far = (c) => yard.every((y) => Math.abs(y.x - c.x) + Math.abs(y.z - c.z) > 2);
  const S = g.layout.store;
  let spot = null;
  let arm = null; // eslint-disable-line prefer-const
  for (let z = S.z + 1; z < S.z + S.h - 1 && !arm; z++) {
    for (let x = S.x + 1; x < S.x + S.w - 1 && !arm; x++) {
      const cell = { x, z };
      if (!far(cell)) continue;
      // A neighbour the loader can stand on, aimed at anything but the cell —
      // the pad is consent, so being pointed elsewhere is the whole of 18b and
      // this inherits it rather than restating it.
      const side = [0, 1, 2, 3].map((r) => anchorTile(x, z, r))
        .find((n) => canPlace(g.layout, { kind: 'arm', x: n.x, z: n.z, rot: 0 }).ok);
      if (!side) continue;
      const paint = g.buildGround('me', { x, z, w: 1, d: 1, piece: STORE.id });
      if (!paint.ok) continue;
      const away = [0, 1, 2, 3].find((q) => {
        const f = anchorTile(side.x, side.z, q);
        return f.x !== x || f.z !== z;
      });
      const put = g.placeFixture('me', { kind: 'arm', piece: ARM.id, x: side.x, z: side.z, rot: away });
      if (!put.ok) continue;
      spot = cell;
      arm = g.beltAt(side.x, side.z);
    }
  }
  check(!!arm, 'a lone storage cell is painted away from the yard, with a loader beside it');

  if (arm && spot) {
    const cells = g.dropPad()?.cells ?? [];
    check(cells.some((c) => c.x === spot.x && c.z === spot.z)
      && yard.every((y) => Math.abs(y.x - spot.x) + Math.abs(y.z - spot.z) > 1),
      'the pad is now one region in two pieces');

    const crate = crateOn(g, arm, COLD, 4);
    const total = units(g);
    run(g, 60);

    const onCell = g.deliveries.filter((d) => !d.belt
      && Math.round(d.x) === spot.x && Math.round(d.z) === spot.z);
    const onYard = g.deliveries.filter((d) => !d.belt
      && yard.some((y) => y.x === Math.round(d.x) && y.z === Math.round(d.z)));
    check(onCell.length > 0, 'the box is set down on the cell the loader touches');
    eq(onYard.length, 0, '...and none of it turns up in the yard across the shop');
    eq(units(g), total, '...and nothing created or destroyed on the way');
    void crate;
  }
}

// ---------------------------------------------------------------------------
// 19. Laying a run in one drag.
//
// Twelve cells was twelve presses and twelve re-flows. The claims here are the
// ones a screenshot cannot make: that the facings CHAIN (each cell faces the
// next, which is the whole reason a belt wants a drag), that a square that is
// already taken is skipped rather than stopping the run, and that the whole
// thing is one re-flow — `layoutVersion` moving once, which is `verify:pick`'s
// centrepiece said about a gesture instead of a selection.
//
// It also exists because this verb is reached from ONE message and nothing else
// in the sweeps touched it: it shipped with a bare `CONVEYOR_KINDS` reference
// and every press of a conveyor tool threw. On `ChannelHost` that is swallowed;
// on Colyseus it is not, and what it reads as is the server dying when you place
// a loader.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 5);
  check(!!cells, 'there is room for a five-cell run');
  if (cells) {
    const before = g.layoutVersion;
    const res = g.buildRun('me', {
      kind: 'belt', piece: BELT.id, x: cells[0].x, z: cells[0].z, to: cells[4],
    });
    check(res.ok, 'the run goes down in one call', res.error ?? '');
    eq(res.laid, 5, '...as five cells');
    eq(g.layoutVersion, before + 1, '...and ONE re-flow, not five');

    for (let i = 0; i < 4; i++) {
      const cell = g.beltAt(cells[i].x, cells[i].z);
      const to = cell && g.beltNext(cell);
      eq(`${to?.x},${to?.z}`, `${cells[i + 1].x},${cells[i + 1].z}`,
        `the cell at ${cells[i].x},${cells[i].z} faces the next one`);
    }

    // ...and a square that is already taken is skipped, not fatal. A drag across
    // a shop will clip a shelf, and refusing the whole gesture for one cell
    // would make the tool useless in the shop it exists for.
    const over = g.buildRun('me', {
      kind: 'belt', piece: BELT.id, x: cells[0].x, z: cells[0].z, to: cells[4],
    });
    check(!over.ok, 'a run over ground that is entirely taken is an error');

    // The other direction of the same claim: a run whose FIRST cell is taken
    // still lays the rest.
    const on = beltRun(g, 3);
    if (on) {
      const mixed = g.buildRun('me', {
        kind: 'belt', piece: BELT.id, x: cells[0].x, z: cells[0].z, to: on[2],
      });
      check(mixed.ok, 'a run that starts on a taken square lays the rest anyway',
        mixed.error ?? '');
    }

    // A DIFFERENT conveyor used to be accepted as a swap by `canPlace`, so a
    // belt drag across a loader silently sold the loader and replaced it. A
    // sweep adds around existing machinery; only a deliberate one-cell press
    // may replace it.
    const guarded = fresh();
    const path = beltRun(guarded, 5);
    check(!!path, 'there is room for a run that crosses existing machinery');
    if (path) {
      const machine = guarded.placeFixture('me', {
        kind: 'arm', piece: ARM.id, x: path[2].x, z: path[2].z, rot: 0,
      });
      check(machine.ok, 'a loader stands in the path before the drag', machine.error ?? '');
      const kept = guarded.beltAt(path[2].x, path[2].z);
      const swept = guarded.buildRun('me', {
        kind: 'belt', piece: BELT.id, x: path[0].x, z: path[0].z, to: path[4],
      });
      check(swept.ok, 'the belt run lays around the loader', swept.error ?? '');
      eq(swept.laid, 4, 'the occupied cell is skipped');
      eq(guarded.beltAt(path[2].x, path[2].z)?.id, kept?.id,
        'and the existing loader is not erased');
      eq(guarded.beltAt(path[2].x, path[2].z)?.kind, 'arm',
        'nor replaced by the dragged belt');
    }
  }
}
{
  // An L, which is what makes a loop four drags instead of eight — and the cap,
  // which is the 4KB argument said about work rather than about bytes.
  const bend = runCells({ x: 2, z: 2 }, { x: 6, z: 4 });
  eq(bend.length, 7, 'a diagonal drag lays an L');
  check(bend.every((c, i) => i === 0 || c.x === bend[i - 1].x || c.z === bend[i - 1].z),
    '...one axis at a time');
  eq(runCells({ x: 0, z: 0 }, { x: 900, z: 0 }).length, BELT_RUN_MAX,
    'and a drag across the world is capped');
}

// ---------------------------------------------------------------------------
// 20. A rung on the JUNCTION's ladder is a rung on what gets through it.
//
// The belt and the loader have had speed ladders since they shipped and the
// sorter had one rung, so you could make a run faster and the machines on it
// faster and the junction in the middle stayed at track speed for ever — which
// on a busy shop is exactly where the queue forms.
//
// Nothing about that is visible. A box through a quick junction and a box
// through a slow one are the same box on the same shelf; only the clock moved.
// And the failure this file exists to catch is quieter still: CLAUDE.md's
// flattest warning is that a tier which changes no number is a button that
// takes money and does nothing, which is what `verify:till` was written for
// after three constructors shipped without a `kind` on their record and
// `fixtureStats` answered 1/1/1 at a machine that still worked.
//
// So it is measured as boxes past the junction over a window against a real
// queue, never as `fixtureStats` — asserting a rung against the function that
// resolves it passes whatever that function does.
//
// The run either side is a belt that is ALREADY quick, and that is the whole
// rig rather than a detail: a junction running at the speed of the belts
// touching it is not what anything queues at, so laid on ordinary track this
// would measure the run and call it the sorter.
// ---------------------------------------------------------------------------
{
  const LEN = 14;
  const AT = 6; // six cells of queue behind it, seven of empty line in front

  /** A straight east run of `LEN` cells with room for a junction at `AT`. */
  const laneFor = (g) => {
    for (let z = 1; z < g.layout.h - 1; z++) {
      for (let x = 1; x + LEN < g.layout.w - 1; x++) {
        const cells = [];
        for (let i = 0; i < LEN; i++) cells.push({ x: x + i, z });
        if (!cells.every((c) => canPlace(g.layout, { kind: 'belt', x: c.x, z: c.z, rot: 0 }).ok)) continue;
        if (!canPlace(g.layout, { kind: 'sorter', x: cells[AT].x, z: cells[AT].z, rot: 0 }).ok) continue;
        return cells;
      }
    }
    return null;
  };

  /**
   * A quick run with a junction in it, at `tier`.
   *
   * The rungs are climbed through `upgradeFixture` rather than written onto the
   * record, and the cell is looked up again on every pass because an upgrade
   * re-flows and a re-flow re-mints ids — the same trap `repositionFixture`
   * springs on a field it forgets to name.
   */
  function lane(tier) {
    const g = fresh();
    const cells = laneFor(g);
    if (!cells) return null;
    for (const [i, c] of cells.entries()) {
      const kind = i === AT ? 'sorter' : 'belt';
      const put = g.placeFixture('me', {
        kind, piece: kind === 'sorter' ? JUNCTION.id : QUICK_BELT.id, x: c.x, z: c.z, rot: 0,
      });
      if (!put.ok) return null;
    }
    for (let n = 1; n < tier; n++) {
      const at = g.beltAt(cells[AT].x, cells[AT].z);
      const up = g.upgradeFixture('me', at.id);
      check(up.ok, `the junction climbs to rung ${n + 1}`, up.error ?? '');
    }
    return { g, cells };
  }

  /** Six boxes queued nose to tail behind the junction, and a window. */
  function through(tier, seconds) {
    const rig = lane(tier);
    if (!rig) return null;
    const { g, cells } = rig;
    const junction = g.beltAt(cells[AT].x, cells[AT].z);
    for (let i = 0; i < 6; i++) {
      const c = cells[AT - 1 - i];
      const crate = g.dropGoods(GOODS.id, 1, { x: c.x, z: c.z }, { exact: true });
      if (!crate) return null;
      g.loadBelt(g.beltAt(c.x, c.z), crate);
    }
    const was = units(g);
    run(g, Math.round(seconds * 10));
    return {
      past: g.deliveries.filter((d) => d.belt && d.x > junction.x + 0.5).length,
      mult: g.fixtureStats(g.beltAt(cells[AT].x, cells[AT].z)).speed_mult,
      kept: units(g) === was,
    };
  }

  const slow = through(1, 2);
  const quick = through(3, 2);
  check(!!slow && !!quick, 'there is room for a queue, a junction and a line out of it');

  if (slow && quick) {
    eq(slow.mult, 1, 'a junction on its first rung runs at its authored speed');
    eq(quick.mult, SORT_MULT, '...and one on its top rung at its own');
    check(slow.past > 0, 'boxes get through a slow junction', `${slow.past} of 6 in 2s`);
    check(quick.past > slow.past,
      '...and more of them through a quick one in the same window',
      `slow ${slow.past}, quick ${quick.past}`);
    check(slow.kept && quick.kept, 'and nothing is created or destroyed either way');
  }

  // ...and the spur it EJECTS down takes the same rung, which is the other half
  // of what a sorter's clock governs. `stepSpur` reads `beltSeconds` off the
  // cell the spur belongs to, so leaving this out would buy a quick junction
  // with a slow throat — a box that crosses the machine in a blink and then
  // crawls off the side of it, which reads as the off-ramp being broken rather
  // than as a rung that was only half wired up.
  //
  // COLD needs a freezer and this shop has none, so nothing down the line is
  // ever keen and every box is a stray for the reject side to take.
  function ejectTicks(tier) {
    const rig = lane(tier);
    if (!rig) return null;
    const { g, cells } = rig;
    const s = g.beltAt(cells[AT].x, cells[AT].z);
    const rot = [0, 1, 2, 3].find((r) => {
      const n = anchorTile(s.x, s.z, r);
      return !g.beltAt(n.x, n.z) && isWalkableTile(g.layout, n.x, n.z);
    });
    if (rot == null) return null;
    const set = g.setSorterReject('me', s.id, rot);
    check(set.ok, 'the junction can be given a reject side', set.error ?? '');
    const cell = g.beltAt(cells[AT].x, cells[AT].z);
    const crate = g.dropGoods(COLD.id, 2, { x: cell.x, z: cell.z }, { exact: true });
    if (!crate) return null;
    g.loadBelt(cell, crate);
    for (let i = 1; i <= 200; i++) {
      g.step(0.1);
      if (crate.spur?.done) return i;
    }
    return null;
  }

  const slowSpur = ejectTicks(1);
  const quickSpur = ejectTicks(3);
  check(!!slowSpur && !!quickSpur, 'a stray comes off the junction at both rungs');
  if (slowSpur && quickSpur) {
    check(quickSpur < slowSpur,
      'a quick junction ejects down its spur quicker than a slow one does',
      `slow ${slowSpur} ticks, quick ${quickSpur}`);
  }
}

// ---------------------------------------------------------------------------
// 21. A rung on a MOUTH, which is the longest hop in the shop.
//
// The same claim as 20 and worth making twice, because a tunnel is the one
// place a cell's rung is not worth one cell: the span between two mouths is a
// SINGLE leg of the line, so the whole crossing is travelled at the entry
// mouth's own speed. Five tiles at one cell's rate — three seconds of ordinary
// track — and a tunnel one rung behind the run it joins is therefore the worst
// slow cell a shop can own, in the piece bought precisely to shorten a journey.
//
// It also asserts the half that could easily have been a dead button. A tunnel
// is TWO fixtures, either of which can be upgraded on its own, and only the
// upstream one governs the span. That is the ordinary rule (a cell's rung buys
// the hop OUT of it), but it means an exit mouth's rung is worth nothing at all
// unless its own onward step moves — so both are measured, separately, and a
// rig where only one mouth is quick is the control for each.
//
// Nothing here was covered before: `under` shipped with one rung and this file
// had no tunnel in it, so the whole kind was a hole.
// ---------------------------------------------------------------------------
{
  const LEN = 13;
  const IN = 4;
  const OUT = IN + TUNNEL_SPAN + 1; // the far mouth, with bare ground between

  const laneFor = (g) => {
    const kindAt = (i) => (i === IN || i === OUT ? 'under' : 'belt');
    for (let z = 1; z < g.layout.h - 1; z++) {
      for (let x = 1; x + LEN < g.layout.w - 1; x++) {
        const cells = [];
        for (let i = 0; i < LEN; i++) cells.push({ x: x + i, z });
        if (cells.every((c, i) => canPlace(g.layout, { kind: kindAt(i), x: c.x, z: c.z, rot: 0 }).ok)) return cells;
      }
    }
    return null;
  };

  /** Quick track, a tunnel in the middle of it, and a rung on each mouth. */
  function lane(inTier, outTier) {
    const g = fresh();
    const cells = laneFor(g);
    if (!cells) return null;
    for (const [i, c] of cells.entries()) {
      // The span stamps nothing and reserves nothing — that is the whole of
      // what a tunnel gives back — so those cells stay bare ground.
      if (i > IN && i < OUT) continue;
      const kind = (i === IN || i === OUT) ? 'under' : 'belt';
      const put = g.placeFixture('me', {
        kind, piece: kind === 'under' ? MOUTH.id : QUICK_BELT.id, x: c.x, z: c.z, rot: 0,
      });
      if (!put.ok) return null;
    }
    for (const [i, want] of [[IN, inTier], [OUT, outTier]]) {
      for (let n = 1; n < want; n++) {
        const at = g.beltAt(cells[i].x, cells[i].z);
        const up = g.upgradeFixture('me', at.id);
        check(up.ok, `the mouth at ${i} climbs to rung ${n + 1}`, up.error ?? '');
      }
    }
    const mouth = g.beltAt(cells[IN].x, cells[IN].z);
    const far = tunnelExit(g.layout, mouth);
    check(far && far.x === cells[OUT].x && far.z === cells[OUT].z,
      'the two mouths are a tunnel rather than two short belts');
    return { g, cells };
  }

  // The visible stroke before the old hidden long hop. One crate owns the
  // carrier through its loaded descent and empty return; the next waits on the
  // incoming rail rather than floating over a piston that is below the floor.
  {
    const rig = lane(1, 1);
    check(!!rig, 'there is a tunnel whose piston can be watched');
    if (rig) {
      const { g, cells } = rig;
      const mouth = g.beltAt(cells[IN].x, cells[IN].z);
      const feeder = g.beltAt(cells[IN - 1].x, cells[IN - 1].z);
      const queue = g.beltAt(cells[IN - 2].x, cells[IN - 2].z);
      const first = g.dropGoods(GOODS.id, 1, { x: feeder.x, z: feeder.z }, { exact: true });
      const next = g.dropGoods(GOODS.id, 1, { x: queue.x, z: queue.z }, { exact: true });
      check(!!first && !!next, 'two crates can queue at the tunnel mouth');
      check(g.loadBelt(feeder, first) && g.loadBelt(queue, next),
        'both start on the incoming rail');

      let arrived = false;
      for (let i = 0; i < 20 && !arrived; i++) {
        g.step(0.1);
        arrived = first.belt === mouth.id && Math.abs(first.off) < 1e-9;
      }
      check(arrived, 'the first crate stops exactly on the piston before descending');
      eq(first.x, mouth.x, 'it does not roll forward through the mouth seam');
      eq(first.deck ?? 0, 0, 'and it is standing at floor level, not already sinking');
      g.step(0.1);
      // THE DESCENT IS THE CRATE'S OWN `deck`, which is the whole of what makes
      // a tunnel the lift's mechanism rather than a second one beside it. It
      // was two clocks on the crate and a `carrier` record per box on the wire;
      // a fraction between two storeys says all of it, and the shaft already
      // spoke that language.
      check(first.deck < 0 && first.deck > -1,
        'the accepted crate is between the floor and the span', `${first.deck}`);
      eq(first.x, mouth.x, 'it does not move along the span while descending');
      eq(first.z, mouth.z, '...on either axis');
      check(!g.beltHidden(first), 'and it stays visible for that descent');
      const wire = g.snapshot().deliveries.find((d) => d.id === first.id);
      near(wire?.deck, first.deck, 'the renderer receives that same fraction', 0.011);
      eq(wire?.carrier, undefined, 'and no second per-crate carrier record beside it');
      eq(wire?.under, undefined, '...nor a depth of the tunnel\'s own');

      let buried = false;
      for (let i = 0; i < 20 && !buried; i++) {
        g.step(0.1);
        buried = g.beltHidden(first);
      }
      check(buried, 'only reaching the bottom hides the crate');
      near(first.deck, -1, 'which is the span itself, one storey down', 0.011);
      check(next.belt !== mouth.id,
        'the following crate stays off the mouth while the span is occupied');
      let admitted = false;
      for (let i = 0; i < 100 && !admitted; i++) {
        g.step(0.1);
        admitted = next.belt === mouth.id;
      }
      check(admitted, 'and the following crate is admitted once the span is free');
    }
  }

  // The other visible half: the hidden leg must stop exactly under the output
  // carrier, then rise before it is allowed onto the outgoing rail.
  {
    const rig = lane(1, 1);
    check(!!rig, 'there is a tunnel whose exit piston can be watched');
    if (rig) {
      const { g, cells } = rig;
      const mouth = g.beltAt(cells[IN].x, cells[IN].z);
      const exit = g.beltAt(cells[OUT].x, cells[OUT].z);
      const crate = g.dropGoods(GOODS.id, 1, { x: mouth.x, z: mouth.z }, { exact: true });
      check(!!crate && g.loadBelt(mouth, crate), 'a crate starts into that tunnel');
      // ARRIVAL IS GEOMETRY, not `belt`. A crate is filed against the cell it
      // last left for the whole of a long hop, so the exit's id does not appear
      // until the box is up and away — the question here is where it physically
      // is, which is over the far mouth's square and below the floor.
      let arrived = false;
      for (let i = 0; i < 100 && !arrived; i++) {
        g.step(0.1);
        arrived = Math.abs(crate.x - exit.x) < 1e-6 && Math.abs(crate.z - exit.z) < 1e-6
          && crate.deck < -1e-6;
      }
      check(arrived, 'the hidden leg reaches the output mouth');
      check(crate.deck <= -1 + 1e-6 || !g.beltHidden(crate),
        'and it arrives from below rather than along the floor');
      const bottomWire = g.snapshot().deliveries.find((d) => d.id === crate.id);
      near(bottomWire?.deck, crate.deck, 'the renderer receives it at that depth', 0.011);

      // The rise is the descent's mirror and is asserted as one, because the
      // half that looks perfect is the one that ships broken: a riser put on
      // the near cell carries a box UP correctly and steps the box coming DOWN
      // off the end of its own shaft. `conveyorLines` makes the same choice for
      // a lift and its note says the same thing.
      let rising = false;
      let rose = null;
      for (let i = 0; i < 40 && !rising; i++) {
        g.step(0.1);
        rising = crate.deck < -1e-6 && crate.deck > -1 + 1e-6 && !g.beltHidden(crate);
        if (rising) rose = { x: crate.x, z: crate.z };
      }
      check(rising, 'the crate rises out of the output mouth before moving onward');
      eq(rose?.x, exit.x, 'it remains stopped horizontally throughout that rise');
      eq(rose?.z, exit.z, '...on either axis');
    }
  }

  /** Boxes out of the far mouth over a window, against a queue at the near one. */
  function through(inTier, seconds) {
    const rig = lane(inTier, 1);
    if (!rig) return null;
    const { g, cells } = rig;
    const exit = g.beltAt(cells[OUT].x, cells[OUT].z);
    for (let i = 0; i < 4; i++) {
      const c = cells[IN - i];
      const crate = g.dropGoods(GOODS.id, 1, { x: c.x, z: c.z }, { exact: true });
      if (!crate) return null;
      g.loadBelt(g.beltAt(c.x, c.z), crate);
    }
    const was = units(g);
    // Ticks any box spent part way down the shaft. The stroke used to be a
    // constant of its own with a rung divided into it; it is a leg of the path
    // now, so what a quicker mouth buys has to show up as a shorter DESCENT and
    // not only as more boxes out the far end — otherwise the rung is buying the
    // crossing alone and the two vertical strokes are free.
    let sinking = 0;
    for (let i = 0; i < Math.round(seconds * 10); i++) {
      g.step(0.1);
      if (g.deliveries.some((d) => d.belt && d.deck < -1e-6 && d.deck > -1 + 1e-6)) sinking++;
    }
    return {
      past: g.deliveries.filter((d) => d.belt && d.x >= exit.x - 0.01).length,
      mult: g.fixtureStats(g.beltAt(cells[IN].x, cells[IN].z)).speed_mult,
      sinking,
      kept: units(g) === was,
    };
  }

  const slow = through(1, 4);
  const quick = through(3, 4);
  check(!!slow && !!quick, 'there is room for a queue, a tunnel and a line out of it');

  if (slow && quick) {
    eq(slow.mult, 1, 'a mouth on its first rung runs at its authored speed');
    eq(quick.mult, SORT_MULT, '...and one on its top rung at its own');
    check(quick.sinking < slow.sinking,
      'a quicker mouth spends less of the window part way down its own shaft',
      `slow ${slow.sinking} ticks, quick ${quick.sinking}`);
    check(slow.past > 0, 'boxes come out of a slow tunnel', `${slow.past} of 4 in 4s`);
    check(quick.past > slow.past,
      '...and more of them out of a quick one in the same window',
      `slow ${slow.past}, quick ${quick.past}`);
    check(slow.kept && quick.kept, 'and nothing is created or destroyed in the span');
  }

  /** Ticks to reach the far mouth, and ticks from there to the next belt. */
  function legs(inTier, outTier) {
    const rig = lane(inTier, outTier);
    if (!rig) return null;
    const { g, cells } = rig;
    const mouth = g.beltAt(cells[IN].x, cells[IN].z);
    const exit = g.beltAt(cells[OUT].x, cells[OUT].z);
    const next = g.beltAt(cells[OUT + 1].x, cells[OUT + 1].z);
    const crate = g.dropGoods(GOODS.id, 1, { x: mouth.x, z: mouth.z }, { exact: true });
    if (!crate) return null;
    g.loadBelt(mouth, crate);
    let span = null;
    for (let i = 1; i <= 400; i++) {
      g.step(0.1);
      if (span == null && crate.belt === exit.id) span = i;
      if (crate.belt === next.id) return { span, out: i - span };
    }
    return null;
  }

  // Only the UPSTREAM mouth is under the span, so its rung is the one that buys
  // the crossing — and the far one's has to buy its own step, or half of every
  // tunnel in the shop has an upgrade button that takes money and does nothing.
  const both = legs(1, 1);
  const nearQuick = legs(3, 1);
  const farQuick = legs(1, 3);
  check(!!both && !!nearQuick && !!farQuick, 'a box crosses the tunnel at every pairing');

  if (both && nearQuick && farQuick) {
    check(nearQuick.span < both.span,
      'a rung on the mouth goods go IN by shortens the whole span',
      `slow ${both.span} ticks, quick ${nearQuick.span}`);
    eq(farQuick.span, both.span,
      '...and a rung on the far one does not, because the span is not its hop');
    check(farQuick.out < both.out,
      'the far mouth buys its own step out instead, or its ladder is a dead button',
      `slow ${both.out} ticks, quick ${farQuick.out}`);
  }
}

// ---------------------------------------------------------------------------
// 21b. WHICH two ends found each other, which is a matching and not a lookup.
//
// A mouth is an entry if there is another one ahead of it facing the same way,
// and that sentence is complete for two mouths and wrong for four. Asked cell
// by cell, the middle of a chain answers yes twice: it is somebody's exit AND
// its own entry, so a row of two tunnels is three, and the middle one swallows
// whatever the run was supposed to do in between.
//
// Everything about it is invisible twice over. A crate that crossed a span and
// a crate that rode the surface are the same box on the same shelf, so what the
// shop looks like afterwards says nothing — and the one thing you CAN see is
// the art, which is the wrong tell: both halves of the middle pair draw as
// entries, so it reads as a mouth that will not turn rather than as the wrong
// two ends having paired.
//
// Its rig is the live save it came off: two mouths dropped next to each other,
// a working run of three cells beyond them, then the far pair. The bug handed
// the near pair's exit four cells down the row to the far pair's entry, over
// the top of the run in between — which never carried a thing, and an unbuilt
// run and a bypassed one are the same still frame.
//
// The claims are a PAIR and worthless split in half: the near exit hands to the
// surface cell in front of it, AND the far pair still opens a tunnel of its own.
// A rule that simply refused a second tunnel on the row passes the first and
// turns the far one off.
// ---------------------------------------------------------------------------
{
  // Four mouths and three ordinary belts between the pairs — the gap is under
  // `TUNNEL_SPAN`, which is what puts the far pair's entry in range of the near
  // pair's exit and is the whole of how this happens.
  const MOUTHS = new Set([0, 1, 5, 6]);
  const LEN = 8;
  const g = fresh();
  const cells = beltRun(g, LEN);
  check(!!cells, 'there is room for two tunnels with a run between them');
  if (cells) {
    for (const [i, c] of cells.entries()) {
      const kind = MOUTHS.has(i) ? 'under' : 'belt';
      const put = g.placeFixture('me', {
        kind, piece: kind === 'under' ? MOUTH.id : BELT.id, x: c.x, z: c.z, rot: 0,
      });
      check(put.ok, `a ${kind} goes down at ${c.x},${c.z}`, put.error ?? '');
    }
    const at = (i) => g.beltAt(cells[i].x, cells[i].z);
    const pair = (i) => tunnelExit(g.layout, at(i));

    // The near pair, which is the ordinary reading and was never in doubt.
    const near = pair(0);
    check(near && near.x === cells[1].x, 'the first mouth pairs with the one in front of it');

    // ...and its exit is an exit and NOTHING else. A mouth that answered here
    // is drawn turned round, so this is also the assertion about the picture.
    eq(pair(1), null, 'that pair\'s far end does not open a second tunnel of its own');

    const on = conveyorNext(g.layout, at(1));
    check(on && on.x === cells[2].x && on.z === cells[2].z,
      'it hands to the cell standing in front of it instead of four down the row',
      on ? `${on.x},${on.z}` : 'nowhere');

    // The half that a blanket refusal would fail: the far pair is still a
    // tunnel, because the mouth that could have claimed its entry is spoken for.
    const far = pair(5);
    check(far && far.x === cells[6].x, 'the far pair is still a tunnel');
    eq(pair(6), null, '...whose own far end is likewise only an exit');

    // And the run in between actually carries, which is the failure said as a
    // journey rather than as a lookup: conservation plus a box that was seen on
    // every surface cell the bypass used to skip.
    const crate = g.dropGoods(GOODS.id, 2, { x: cells[0].x, z: cells[0].z }, { exact: true });
    check(!!crate, 'a crate goes on the first mouth');
    if (crate) {
      const was = units(g);
      g.loadBelt(at(0), crate);
      const seen = new Set();
      for (let i = 0; i < 600; i++) {
        g.step(0.1);
        if (crate.belt) seen.add(crate.belt);
      }
      for (const i of [2, 3, 4]) {
        check(seen.has(at(i).id), `the box rode the surface cell at ${i} rather than over it`);
      }
      eq(units(g), was, 'and nothing is created or destroyed on the way');
    }
  }
}

// ---------------------------------------------------------------------------
// 22. A junction says which way it sent that one.
//
// The roof marks are one bar per side and the lit one is the way the goods
// went, which is the only reason a player can read a splitter at all — and a
// loader has had `move` on the wire since spurs, while a sorter never did. Its
// choice lived and died inside `sortChoice`, deleted on the tick it was acted
// on, so the one piece in the shop whose whole job is choosing between ways out
// was the one piece with nothing to report.
//
// It is asserted here rather than left to the eye for the reason every readout
// in this file is: a junction sending everything one way and a junction whose
// marks are wired to nothing draw the same picture, which is a machine that
// looks like it is not sorting.
//
// The counter is the half that is easy to leave out. `n` only goes up, because
// the client needs the EDGE and the window is 1.2s — a junction working flat
// out sends several boxes inside it, and a flag alone would read as one long
// send with every box after the first never drawn.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  // Five cells rather than three, and the tail is the reason: the run is a dead
  // end, so the first box parks on it and the second is held at the junction by
  // ordinary backpressure — which is the machine working correctly and would
  // read here as the counter being broken.
  const cells = beltRun(g, 5);
  check(!!cells, 'there is room for a five-cell run with a tail on it');
  if (cells) {
    cells.forEach((c, i) => {
      const kind = i === 1 ? 'sorter' : 'belt';
      const put = g.placeFixture('me', {
        kind, piece: kind === 'sorter' ? 'sorter' : BELT.id, x: c.x, z: c.z, rot: 0,
      });
      check(put.ok, `the ${kind} at ${c.x},${c.z} goes down`, put.error ?? '');
    });
    const s = g.beltAt(cells[1].x, cells[1].z);
    const said = () => g.snapshot().sorters?.find((q) => q.id === s.id)?.move ?? null;

    eq(said(), null, 'a junction nothing has passed through reports nothing');

    crateOn(g, s, GOODS, 2);
    check(until(g, () => !!said()), 'a box through it puts a way out on the wire');
    const first = said();
    if (first) {
      eq(`${first.d[0]},${first.d[1]}`, '1,0',
        '...and it is the side the box actually left by');
      eq(first.n, 1, '...counted once');
    }

    // ...and the second box is its own event. A window with no counter under it
    // is one long send that the client can never see the end of.
    crateOn(g, g.beltAt(cells[1].x, cells[1].z), GOODS, 2);
    // Asked as a VALUE and not as "bigger than last time": the window is 1.2s
    // and the first send has long since aged out, so `said()` is null in
    // between and a comparison against it is a comparison with nothing.
    check(until(g, () => said()?.n === 2),
      'the next one climbs the counter rather than re-arming a flag');

  }
}

// ---------------------------------------------------------------------------
// 22b. …and it FORGETS a box that stopped existing.
//
// `sortChoice` is which way out a crate was given, remembered so the answer
// cannot flicker twenty times a second, and it is deleted when the box leaves
// the junction's line. That covers every way a crate leaves by TRAVELLING and
// none of the ways it stops existing — a hand lifts it off the belt, `lotAdd`
// merges it into the box in front, it spoils, `binOrphans` takes it at the day
// roll. Eleven places filter a crate out of `this.deliveries` and there is no
// chokepoint to hang a delete on, so tidying at the exits is one new exit away
// from being wrong again: it is pruned against what is RIDING instead.
//
// Ids never repeat, so a stale entry is dead weight for the life of the
// process. It cannot produce a wrong answer — no crash, no misroute, nothing in
// the feed — it can only grow, which is why it is here rather than findable by
// playing. A size is the only shape this claim has.
//
// It needs a junction with a real BRANCH, which is the thing that made the
// first draft of this pass for the wrong reason: `sorterOut` returns before it
// remembers anything when there is only one way out, so a sorter in a straight
// run never fills the map at all and "it was forgotten" is satisfied by "it was
// never written".
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 3);
  check(!!cells, 'there is room for a junction to remember something at');
  if (cells) {
    lay(g, [cells[0], cells[2]]);
    let branch = null;
    for (const r of [0, 1, 2, 3]) {
      const n = anchorTile(cells[1].x, cells[1].z, r);
      if (g.beltAt(n.x, n.z)) continue;
      if (!canPlace(g.layout, { kind: 'belt', x: n.x, z: n.z, rot: 0 }).ok) continue;
      const away = { x: n.x + (n.x - cells[1].x), z: n.z + (n.z - cells[1].z) };
      const put = g.placeFixture('me', {
        kind: 'belt', piece: BELT.id, x: n.x, z: n.z, rot: aim(n, away),
      });
      if (!put.ok) continue;
      branch = g.beltAt(n.x, n.z);
      break;
    }
    check(!!branch, 'a branch line goes down beside it');
    const made = branch && g.placeFixture('me', {
      kind: 'sorter', piece: 'sorter', x: cells[1].x, z: cells[1].z,
      rot: aim(cells[1], branch),
    });
    check(!!made?.ok, 'and the junction between them', made?.error ?? '');

    if (branch && made?.ok) {
      const junction = () => g.beltAt(cells[1].x, cells[1].z);
      const held = crateOn(g, junction(), GOODS, 2);
      check(until(g, () => (g.sortChoice?.size ?? 0) > 0),
        'a box at a junction is remembered while it is deciding');
      // Taken away BY HAND rather than through any of the eleven filters, which
      // is the whole point: the prune is not hung on an exit.
      g.deliveries = g.deliveries.filter((d) => d.id !== held.id);
      g.step(0.1);
      eq(g.sortChoice?.size ?? 0, 0, 'and forgotten the tick after it stops existing');

      // ...and the shop whose last run has GONE, which is the one state the
      // sweep above cannot reach: with no lines left there is nothing riding to
      // compare the memory against, so the pass returns before it prunes.
      crateOn(g, junction(), GOODS, 2);
      check(until(g, () => (g.sortChoice?.size ?? 0) > 0), 'a second box is remembered');
      for (const c of [...cells, { x: branch.x, z: branch.z }]) {
        const at = g.beltAt(c.x, c.z);
        if (at) g.removeFixture('me', at.id);
      }
      g.step(0.1);
      eq(g.sortChoice?.size ?? 0, 0, 'and tearing the run out forgets it too');
    }
  }
}

// ---------------------------------------------------------------------------
// 23. A loader will not LIFT what it would not pour.
//
// The arm has obeyed `givenUp` at one end of its swing since it shipped — it
// never feeds a board the shop has written off — and asked nothing at the other.
// So the crate `merchandise` had just carried off a dead board was lifted onto
// the run, where every unit down it refuses that item for the same reason: a
// box that can never be put down, riding for the rest of the save.
//
// It is `verify:hand`'s centrepiece arriving by machine. That file's whole
// claim is that a board the hand clears does not come straight back, and a
// loader standing beside the shelf undid it — while looking exactly like a
// machine doing its job, which is why it took a screenshot to find.
//
// The pair is what makes it a claim. "Never lifts a given-up box" is satisfied
// by a loader that lifts nothing at all, so the control is the same crate, the
// same tile and the same machine with the shop's mind unchanged. And the mixed
// case is the third: refusing EVERY box with a dead pile in it would strand the
// good half, which is the same over-correction the sorter's purity rule avoids.
// ---------------------------------------------------------------------------
{
  /** A loader within reach of a shelf's browse tile — where a cleared board lands. */
  function clearedRig() {
    const g = fresh();
    for (const sh of g.layout.shelves ?? []) {
      const b = sh.browseAt;
      if (!b) continue;
      for (const r of [0, 1, 2, 3]) {
        const a = anchorTile(b.x, b.z, r);
        if (!canPlace(g.layout, { kind: 'arm', x: a.x, z: a.z, rot: 0 }).ok) continue;
        if (!g.placeFixture('me', { kind: 'arm', piece: ARM.id, x: a.x, z: a.z, rot: 0 }).ok) continue;
        return { g, at: b };
      }
    }
    return null;
  }

  /** Does the machine put this crate on the run, given long enough? */
  function lifted(rig, piles) {
    const { g, at } = rig;
    let crate = null;
    for (const [id, qty] of piles) crate = g.dropGoods(id, qty, at, { exact: true }) ?? crate;
    // Named by tile, so a merge lands them in one box — which is what a hire
    // clearing a mixed board actually leaves behind.
    crate = g.deliveries.find((d) => Math.round(d.x) === at.x && Math.round(d.z) === at.z);
    const was = units(g);
    const got = until(g, () => !!crate?.belt, 400);
    return { got, kept: units(g) === was };
  }

  // The control, and it decides whether this is a rule or a machine that has
  // stopped working: the shop has said nothing about this item, so the box goes.
  const keen = clearedRig();
  check(!!keen, 'a loader can stand within reach of a shelf s browse tile');
  if (keen) {
    const r = lifted(keen, [[GOODS.id, 6]]);
    check(r.got, 'a box on that tile is lifted onto the run when nothing is wrong with it');
    check(r.kept, '...and nothing is lost doing it');
  }

  // ...and the same box, on the same tile, once the shop has given up on it.
  const dead = clearedRig();
  if (dead) {
    dead.g.orders.dropped[GOODS.id] = dead.g.day;
    const r = lifted(dead, [[GOODS.id, 6]]);
    check(!r.got, 'a box the shop has given up on is left where the hand put it');
    check(r.kept, '...and left whole');
  }

  // ...and a MIXED box with one live kind in it still rides, or the fix strands
  // the good half to save the dead one.
  const mixed = clearedRig();
  if (mixed) {
    mixed.g.orders.dropped[GOODS.id] = mixed.g.day;
    const r = lifted(mixed, [[GOODS.id, 3], [COLD.id, 3]]);
    check(r.got, 'a mixed box with something live in it is still lifted');
  }
}

// ---------------------------------------------------------------------------
// 24. A loader does not fill a room the run is about to empty.
//
// The larder trap, said about one machine. `armPull` takes a board out of a
// stockroom the moment the shop floor wants it, and the pour half fills
// anything beside it that will take the goods — so a loader standing between a
// run and a marked room does both, to the same unit, for ever. Twelve donuts
// in, ten straight back out.
//
// Neither half is wrong, which is why it survived: both are the documented
// behaviour and both are working. It is docs/workers.md's own sentence about
// the runner — *the larder is not raided, or the runner and the chef undo each
// other all afternoon with both of them correct* — arriving through a machine
// nobody had pointed that sentence at.
//
// And it is invisible in every measurement except the right one. Counted as
// crate journeys the shop looks healthy: every trip delivers, nothing is lost,
// no crate repeats a side. The oscillation is on the SHELF, not on the box.
//
// The control is what stops this turning the stockroom off: with nothing on the
// floor that wants the item, the room is exactly where it should go.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  // A loader beside a shelf, with a second shelf on the same run.
  let rig = null;
  for (const sh of g.layout.shelves ?? []) {
    for (const rot of [0, 1, 2, 3]) {
      const a = anchorTile(sh.x, sh.z, rot);
      if (!canPlace(g.layout, { kind: 'arm', x: a.x, z: a.z, rot: 0 }).ok) continue;
      const face = [0, 1, 2, 3].find((q) => {
        const t = anchorTile(a.x, a.z, q);
        return t.x === sh.x && t.z === sh.z;
      });
      if (face == null) continue;
      if (!g.placeFixture('me', { kind: 'arm', piece: ARM.id, x: a.x, z: a.z, rot: face }).ok) continue;
      rig = { room: sh, arm: g.beltAt(a.x, a.z) };
      break;
    }
    if (rig) break;
  }
  check(!!rig, 'a loader can stand beside a unit');

  if (rig) {
    const arm = rig.arm;
    const room = g.layout.shelves.find((u) => u.id === rig.room.id);
    const crate = { id: 'probe-room', stacks: [{ item_id: GOODS.id, qty: 4 }] };
    const at = { x: room.x, z: room.z };

    // On the shop floor it is an ordinary unit, and the machine fills it.
    room.boh = false;
    check(g.armTakes(arm, at, crate), 'a loader fills an ordinary unit beside it');

    // Every unit this loader touches, because `conveyorMeets` answers for the
    // whole RUN and a one-cell run is still four sides — a second shelf against
    // the same machine is a floor unit whether the sweep meant it or not.
    const touching = (g.layout.shelves ?? [])
      .filter((u) => Math.abs(u.x - arm.x) + Math.abs(u.z - arm.z) === 1);

    // Marked as a room, with nothing on the floor down this run that wants the
    // goods, it is still exactly where they should go — the control that keeps
    // this from switching stockrooms off.
    for (const u of touching) u.boh = true;
    check(g.armTakes(arm, at, crate),
      'and it still fills a room when nothing on the floor will take them');

    // ...and with a floor unit on the same run that WILL take them, the floor
    // gets first claim — or the very next swing pulls the board back out.
    const floor = touching.find((u) => u.id !== room.id);
    if (floor) {
      floor.boh = false;
      check(g.shelfAccepts(floor, GOODS.id), 'there is a floor unit that wants them');
      check(!g.armTakes(arm, at, crate),
        'a room is not filled while the shop floor still wants the goods');
    } else {
      check(true, 'no second unit touches this loader — the pair claim is skipped');
    }

    /**
     * ...AND A TICK OUTRANKS THE PAIR, which is the only way anybody ever gets
     * a stocked back room.
     *
     * The claim above is right about judgement and cannot survive a run that
     * LOOPS: `conveyorMeets` out of a ring reaches every unit on it, so "a
     * floor unit still wants this" is true for ever and the veto never lifts.
     * A shop wired as a circuit therefore has a stockroom that is refused every
     * box in the building — and it reads as a loader that has stopped working,
     * except that the loader is aimed correctly and boxes are going past it.
     *
     * Both halves or neither, and that is the whole of this section. A tick
     * that lets goods IN while `armPull` still takes them straight back out is
     * the twelve-donut oscillation with a reservation on it: the rack fills and
     * empties for ever, every journey delivering, nothing lost — which is the
     * failure the pour half was written for, arriving through the fix.
     *
     * Its control is what keeps this opt-in: the untouched room above answers
     * exactly as it always did, so no shop that has never ticked a rack moves.
     */
    if (floor) {
      room.assigned = [GOODS.id];
      check(g.armTakes(arm, at, crate),
        'a room you TICKED takes the goods, floor or no floor');
      // The other half, and the pair is worthless without it. Stocked first, so
      // the refusal is the rule rather than an empty board.
      const board = () => [{
        item_id: GOODS.id, qty: 5, price: GOODS.base_price, stockedDay: g.day,
      }];
      room.stacks = board();
      check(!g.armPull(arm, room, conveyorMeets(g.layout, arm)),
        '...and the same loader will not empty it again on the next swing');

      // ...where an untouched room holding exactly that board IS emptied, which
      // is the comparison that stops the claim above passing on a loader that
      // never pulls anything from anywhere.
      room.assigned = [];
      room.stacks = board();
      check(g.armPull(arm, room, conveyorMeets(g.layout, arm)),
        'a room you never ticked still gives its board back to the floor');

      // The override is keyed to the ITEM, or ticking one thing onto a rack
      // reserves the whole rack from the shop's own judgement. Asked of
      // `roomTakes` directly: a reservation makes `shelfAccepts` refuse
      // everything else outright, so through `armTakes` this would pass with
      // the rule under test never having run.
      room.stacks = [];
      room.assigned = [COLD.id];
      check(!g.roomTakes(arm, room, GOODS.id),
        'a room ticked for something ELSE is judged exactly as an untouched one');
      check(g.roomTakes(arm, room, COLD.id),
        '...and the thing it IS ticked for is the thing that gets in');

      // ...and step 4a's aimed loader is untouched by all of it: on a shop-floor
      // unit the aim says work this one and the tick says which goods, so
      // reading the tick as a refusal there turns that rung off.
      room.boh = false;
      room.assigned = [GOODS.id];
      room.stacks = board();
      check(g.armPull(arm, room, conveyorMeets(g.layout, arm)),
        'a reservation never gates a unit that is not a back room');
      room.assigned = [];
      room.stacks = [];
      floor.boh = false;
    } else {
      check(true, 'no second unit touches this loader — the tick claims are skipped');
    }
  }
}

// ---------------------------------------------------------------------------
// 24b. A JUNCTION CAN SEE THE LOADER BOLTED TO IT.
//
// A loader whose `rot` names a shelf, a machine or a skip hands on to nobody:
// what arrives goes into that unit. With nothing feeding it, the derivation was
// made to guess a next cell anyway, and the only neighbour it has is the
// junction you built it off — so it came back as pointing AT the sorter.
// `conveyorBranches` drops any neighbour whose flow points back (a two-cell tug
// of war), so the loader was refused as a way out: no blade drawn, no light on
// that side, nothing ever sent down it.
//
// Which is exactly the build the skip exists for — sorter, loader, bin — and it
// reads as the sorter being unable to see a machine bolted to its own side. The
// loader is aimed correctly and the rubbish routing works; it simply never gets
// a box. A live shop had 1 of 91 conveyor cells able to reach a skip it had
// paid for.
//
// The pair is what keeps it honest: a loader aimed at the junction itself is
// still refused, because that one IS declared to feed it.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 3);
  check(!!cells, 'there is room for a run to hang a loader off');
  if (cells) {
    lay(g, [cells[0], cells[2]]);
    // Sorter, loader, bin — the shop's own way of getting rot off the run, and
    // the arrangement the bug was reported on. A skip is `where: 'any'`, so the
    // whole rig stands where a run does.
    let arm = null;
    let skip = null;
    for (const r of [0, 1, 2, 3]) {
      const n = anchorTile(cells[1].x, cells[1].z, r);
      if (g.beltAt(n.x, n.z)) continue;
      const far = { x: n.x + (n.x - cells[1].x), z: n.z + (n.z - cells[1].z) };
      if (!canPlace(g.layout, { kind: 'arm', x: n.x, z: n.z, rot: aim(n, far) }).ok) continue;
      const bin = g.placeFixture('me', { kind: 'bin', piece: 'bin', x: far.x, z: far.z, rot: aim(far, n) });
      if (!bin.ok) continue;
      const put = g.placeFixture('me', { kind: 'arm', piece: ARM.id, x: n.x, z: n.z, rot: aim(n, far) });
      if (!put.ok) continue;
      arm = g.beltAt(n.x, n.z);
      skip = (g.layout.bins ?? []).find((b) => b.x === far.x && b.z === far.z);
      break;
    }
    check(!!arm && !!skip, 'a loader stands beside the run, emptying into a skip of its own');

    // Aimed at the empty side OPPOSITE the loader, so the loader is one of the
    // three incidental sides — which is the whole case. The side `rot` names has
    // had an exception since splitters shipped, and the run's own continuation
    // is the straight-on, so neither of those is what was broken.
    const away = { x: cells[1].x - (arm.x - cells[1].x), z: cells[1].z - (arm.z - cells[1].z) };
    const made = arm && g.placeFixture('me', {
      kind: 'sorter', piece: 'sorter', x: cells[1].x, z: cells[1].z, rot: aim(cells[1], away),
    });
    check(!!made?.ok, 'and a sorter goes in the run beside it', made?.error ?? '');

    if (arm && made?.ok) {
      const sorter = g.beltAt(cells[1].x, cells[1].z);
      const named = anchorTile(sorter.x, sorter.z, sorter.rot ?? 0);
      check(named.x !== arm.x || named.z !== arm.z,
        'the loader is on a side the sorter was NOT aimed at');
      const on = g.beltNext(sorter);
      check(!!on && on.x === cells[2].x && on.z === cells[2].z,
        '...and the run itself is its straight-on, so the loader is neither');
      const ways = conveyorBranches(g.layout, sorter);
      check(ways.some((w) => w.x === arm.x && w.z === arm.z),
        'the junction offers the loader as a way out',
        `ways: ${ways.map((w) => `${w.x},${w.z}`).join(' ') || 'none'}`);
      eq(g.beltNext(arm) ?? null, null,
        '...because a loader emptying into a unit hands on to nobody');
      // And the whole point of the branch: what the loader fills is now down
      // the line from the run, which is what every routing decision reads —
      // `mayRide` will not put rubbish on a network with no skip on it, so
      // this is the difference between the feature working and being off.
      const met = conveyorMeets(g.layout, g.beltAt(cells[0].x, cells[0].z));
      check(met.bins.some((b) => b.id === skip.id),
        '...so the run knows there is a skip down there');
    }
  }
}
{
  // The pair. A loader AIMED at the junction is declared to feed it, and a
  // junction that pushed back into its own feeder is a two-cell tug of war.
  const g = fresh();
  const cells = beltRun(g, 3);
  if (cells) {
    lay(g, [cells[0], cells[2]]);
    let arm = null;
    for (const r of [0, 1, 2, 3]) {
      const n = anchorTile(cells[1].x, cells[1].z, r);
      if (g.beltAt(n.x, n.z)) continue;
      const put = g.placeFixture('me', {
        kind: 'arm', piece: ARM.id, x: n.x, z: n.z, rot: aim(n, cells[1]),
      });
      if (!put.ok) continue;
      arm = g.beltAt(n.x, n.z);
      break;
    }
    const made = arm && g.placeFixture('me', {
      kind: 'sorter', piece: 'sorter', x: cells[1].x, z: cells[1].z, rot: 0,
    });
    if (arm && made?.ok) {
      const sorter = g.beltAt(cells[1].x, cells[1].z);
      const named = anchorTile(sorter.x, sorter.z, sorter.rot ?? 0);
      if (named.x !== arm.x || named.z !== arm.z) {
        const ways = conveyorBranches(g.layout, sorter);
        check(!ways.some((w) => w.x === arm.x && w.z === arm.z),
          'a loader aimed INTO the junction is still not a way out of it');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 24c. THE SKIP LINE TAKES RUBBISH AND NOTHING ELSE, AND A DEAD END LETS GO.
//
// Two claims about one still frame, because a box parked on the loader beside a
// skip and a box on its way into one are the same picture — and the shop is the
// same shop either way, right up until the day something rots.
//
// The junction half first. `sorterWants` needs EVERY pile placeable, so one
// given-up item in a mixed crate makes the whole junction unkeen — and a box
// nothing is keen on splits across all the ways out, which is right about every
// ordinary line and false about this one. A skip refuses stock at every rung
// (`armTakes`, `armLand`, `mayRide` all branch on `waste`), so a crate sent that
// way arrives somewhere it can never be put away.
//
// Which would only be an odd walk, except that the spur to a skip is the one
// shape in the game with no way back: one cell, so nothing downstream; the tile
// it faces is the bin, which is not walkable, so the off-ramp refuses; and no
// pads. The box parks there for the rest of the save and every crate of rot that
// wants that skip queues behind it for ever. A live shop jammed BOTH its skips
// that way — 5x Kale on one, 9x Salt + 3x Apple on the other — and what it reads
// as is a paid-for skip that never takes anything, days after the mixed box that
// did it.
//
// So the second half is the valve, and it is deliberately about a square
// EXISTING rather than having room: a full mat is a loader holding its box back
// on purpose (18b's cap), and folding the two would leak that cap sideways onto
// the three tiles beside it. The pair is that rubbish still gets through
// afterwards, or the first half is satisfied by a skip nothing reaches at all.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 3);
  check(!!cells, 'there is room for a run to hang a skip off');
  if (cells) {
    lay(g, [cells[0], cells[2]]);
    let arm = null;
    let skip = null;
    for (const r of [0, 1, 2, 3]) {
      const n = anchorTile(cells[1].x, cells[1].z, r);
      if (g.beltAt(n.x, n.z)) continue;
      const far = { x: n.x + (n.x - cells[1].x), z: n.z + (n.z - cells[1].z) };
      if (!canPlace(g.layout, { kind: 'arm', x: n.x, z: n.z, rot: aim(n, far) }).ok) continue;
      if (!g.placeFixture('me', { kind: 'bin', piece: 'bin', x: far.x, z: far.z, rot: aim(far, n) }).ok) continue;
      if (!g.placeFixture('me', { kind: 'arm', piece: ARM.id, x: n.x, z: n.z, rot: aim(n, far) }).ok) continue;
      arm = g.beltAt(n.x, n.z);
      skip = (g.layout.bins ?? []).find((b) => b.x === far.x && b.z === far.z);
      break;
    }
    check(!!arm && !!skip, 'sorter, loader, skip — the rig the whole feature is for');

    const away = arm && { x: cells[1].x - (arm.x - cells[1].x), z: cells[1].z - (arm.z - cells[1].z) };
    const made = arm && g.placeFixture('me', {
      kind: 'sorter', piece: 'sorter', x: cells[1].x, z: cells[1].z, rot: aim(cells[1], away),
    });
    check(!!made?.ok, 'and a sorter in the run beside it', made?.error ?? '');

    if (arm && skip && made?.ok) {
      const sorter = g.beltAt(cells[1].x, cells[1].z);
      const ways = [g.beltNext(sorter), ...conveyorBranches(g.layout, sorter)]
        .filter((w) => w && g.beltAt(w.x, w.z));
      check(ways.some((w) => w.x === arm.x && w.z === arm.z),
        'the junction offers the skip line as a way out');
      check(ways.length > 1, '...and it is not the only way out');

      // A named stray route is an instruction for rubbish, not merely a
      // fallback behind any other path that happens to reach a skip.
      const rejectWay = ways.find((w) => w.x !== arm.x || w.z !== arm.z);
      const rejectRot = rejectWay && [0, 1, 2, 3].find((r) => {
        const at = anchorTile(sorter.x, sorter.z, r);
        return at.x === rejectWay.x && at.z === rejectWay.z;
      });
      const setReject = Number.isInteger(rejectRot)
        && g.setSorterReject('me', sorter.id, rejectRot);
      check(!!setReject?.ok, 'a non-skip side can be named as the waste route', setReject?.error ?? '');
      const wasteWay = g.sorterOut(sorter, {
        id: 'waste-follows-reject', waste: true, stacks: [{ item_id: GOODS.id, qty: 2 }],
      });
      check(wasteWay?.x === rejectWay?.x && wasteWay?.z === rejectWay?.z,
        'waste follows the named stray route even when another exit reaches a skip');
      if (setReject?.ok) g.setSorterReject('me', sorter.id, null);

      // Given up, so nothing anywhere is keen and the split is the branch under
      // test. The live jam was exactly this: one dead item in a mixed box.
      g.giveUpBoard?.(GOODS.id);
      const went = [];
      for (let i = 0; i < 12; i++) {
        const to = g.sorterOut(sorter, { id: `bin-probe-${i}`, stacks: [{ item_id: GOODS.id, qty: 2 }] });
        went.push(to && to.x === arm.x && to.z === arm.z ? 'x' : '.');
      }
      eq(went.filter((w) => w === 'x').length, 0,
        'stock nothing wants is never sent down the line whose only end is a skip',
        went.join(''));

      // ...and the valve, asked of a box already sitting on it — every shop that
      // has one today is in that state, and a fix that only stopped new ones
      // leaves those jammed for ever.
      crateOn(g, arm, GOODS, 4);
      const total = units(g);
      run(g, 60);
      check(!g.deliveries.some((d) => d.belt === arm.id),
        'a box that is not rubbish does not park on the skip loader for ever');
      eq(units(g), total, '...and it is set down rather than binned');
      // By WHERE rather than by id: `armDrop` goes through `dropGoods`, so what
      // lands is a pallet of its own and the box that rode in is gone.
      check(g.deliveries.some((d) => !d.belt && lotQty(d, GOODS.id) > 0
        && isWalkableTile(g.layout, Math.round(d.x), Math.round(d.z))),
        '...on a square somebody can walk to and pick it up from');

      // The pair. Unjammed is worth nothing unless the rubbish then gets through.
      const rot = g.dropWaste(GOODS.id, 2, { x: cells[0].x, z: cells[0].z });
      check(!!rot?.waste, 'rot goes down as a rubbish crate at the head of the run');
      run(g, 400);
      check(!g.deliveries.some((d) => d.id === rot.id),
        '...and the skip takes it, which is what the line was for');
    }
  }
}

// ---------------------------------------------------------------------------
// 25. A run is storage, and it is the third thing you lay that holds crates.
//
// `looseRoom` is a TOTAL rather than a region — every loose crate wherever it
// stands, against the yard you painted — and that is right, and it left the
// conveyor on the wrong side of the line. A box riding a belt is standing
// somewhere, so it counted; the belt it was standing on did not. A shop that
// automated its aisles therefore spent its yard allowance on stock that was
// already on its way to a shelf: a live save had 94 of its 132 units riding,
// 71% of the brake applied to boxes doing exactly what they were bought to do.
//
// What that reads as is the supplier refusing to order for a shop whose floor
// is visibly clear, which is the ordering looking broken.
//
// The control is the shop that never laid one, and it is the assertion that
// decides whether this is opt-in or a change to every save in existence.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cap = () => g.looseRoom();
  const before = cap();
  check(Number.isFinite(before), 'a shop with a yard has a finite crate allowance', `${before}`);

  // The control: laying nothing changes nothing.
  g.regenerateLayout();
  eq(cap(), before, 'a shop with no conveyor is the old game to the unit');

  const cells = beltRun(g, 4);
  check(!!cells, 'there is room for a four-cell run');
  if (cells) {
    lay(g, cells);
    eq(cap(), before + cells.length * Game.CRATES_PER_CELL * g.crateCapacity(),
      'and each cell of it holds what `CRATE_PITCH` lets stand on it');

    // ...and a box riding it still counts against the total, or a run would be
    // free capacity rather than capacity you can fill up. That pairing is the
    // whole of what keeps this honest: a jammed run stops the ordering exactly
    // as a full yard does.
    const room = cap();
    const crate = crateOn(g, g.beltAt(cells[0].x, cells[0].z), GOODS, 5);
    eq(cap(), room - lotTotal(crate), 'a box riding it is still spending the allowance');
  }
}

// ---------------------------------------------------------------------------
// 22. THE FARM. A loader collects a full pen and a ripe bed.
//
// The one place on a run where a loader takes goods out of something that
// PRODUCED them rather than off something the shop stocked, and the reason it
// belongs beside the tray rather than beside the stockroom pull: a full tray
// stops its machine, a full pen stops filling and a ripe bed cannot grow the
// next thing, so all three are swings that unblock something.
//
// None of it is visible. A crate of eggs a loader lifted and a crate of eggs a
// farmhand carried over are the same box on the same belt, and the shop is the
// same shop afterwards — only the wage bill moved. The control is the rest of
// this file: no pen and no bed anywhere near a run is every shop in existence,
// and every section above it is one of those.
// ---------------------------------------------------------------------------

/**
 * A loader on a run with a pen or a bed against one of its sides.
 *
 * Searched rather than computed, for `armFeeding`'s reason: which side of a run
 * has room for a 2x2 is a fact about the shell. Hands back the loader, the run
 * it feeds and the thing it is working.
 */
function farmBeside(g, kind, place) {
  const cells = beltRun(g, 3);
  if (!cells) return null;
  const belts = lay(g, cells);
  for (const belt of belts) {
    const spot = armFeeding(g, belt);
    if (!spot) continue;
    const res = g.placeFixture('me', { kind: 'arm', piece: ARM.id, x: spot.x, z: spot.z, rot: spot.rot });
    if (!res.ok) continue;
    const arm = (g.layout.arms ?? []).find((a) => a.id === res.placed);
    // Every side of the loader except the one it unloads onto (that is the run).
    for (const r of [0, 1, 2, 3]) {
      const at = anchorTile(arm.x, arm.z, r);
      const built = place(at);
      if (built) return { arm, belt, at, built };
    }
    g.removeFixture('me', arm.id);
  }
  return null;
}

const penAt = (g) => (at) => {
  for (const rot of [0, 1, 2, 3]) {
    // A pen is 2x2 and `x, z` is its MIN CORNER, so it has to be offered every
    // corner that would put one of its cells on the loader's side — which is
    // the whole of what section 22c is about.
    for (const [dx, dz] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
      const spec = { kind: 'pen', x: at.x + dx, z: at.z + dz, rot };
      if (!canPlace(g.layout, spec).ok) continue;
      const res = g.placeFixture('me', { ...spec, piece: FARM_PEN.id });
      if (res.ok) return (g.layout.pens ?? []).find((p) => p.id === res.placed) ?? null;
    }
  }
  return null;
};

const bedAt = (g) => (at) => {
  const spec = { kind: 'plot', x: at.x, z: at.z, rot: 0 };
  if (!canPlace(g.layout, spec).ok) return null;
  const res = g.placeFixture('me', spec);
  if (!res.ok) return null;
  return (g.layout.plots ?? []).find((p) => p.id === res.placed) ?? null;
};

// 22a. A full pen goes onto the run, and the pen's CLOCK is reset with it.
//
// The reset is the half that is not about the crate. `stepPens` pins `filledAt`
// to now on every tick a pen stands full, so a collect that left the stamp alone
// would hand the next batch over the instant the gate cleared — "a pen is not a
// hopper" undone by a machine, and invisible because a pen that refilled early
// and one that refilled on time are the same full pen.
{
  const g = fresh();
  const set = farmBeside(g, 'pen', penAt(g));
  check(!!set, 'a loader stands beside a pen');
  if (set) {
    const { arm, built: pen } = set;
    eq(g.penHeads(pen), 1, 'one head, since nothing painted a paddock');

    // Nothing in it yet: the loader must lift nothing at all.
    const boxes = g.deliveries.length;
    run(g, 40);
    eq(g.deliveries.length, boxes, 'an empty pen is left alone');

    // Fill it the way the clock does.
    g.elapsed += 120;
    g.step(0.1);
    eq(pen.qty, PEN_BATCH, 'the pen fills');

    check(until(g, () => pen.qty === 0, 400), 'and the loader empties it');
    const box = g.deliveries.find((d) => lotQty(d, GOODS.id) > 0);
    check(!!box, 'into a crate');
    eq(lotQty(box, GOODS.id), PEN_BATCH, 'holding exactly what was standing in the gate');
    check(!!box.belt, 'and that crate is on the run');

    // The clock: a pen just collected is a whole batch away, not due now.
    eq(g.penFill(pen), 0, 'and the next batch starts from zero rather than being due');
  }
}

// 22b. A ripe bed is picked, and the bed is re-sown exactly as a hire re-sows
// it — seed cost and all. One rule, or the crew and the conveyor undo each
// other down the same row, and a machine that skipped the seed would leave a
// field of rough soil behind something that looked like it was working.
{
  const g = fresh();
  const set = farmBeside(g, 'plot', bedAt(g));
  check(!!set, 'a loader stands beside a bed');
  if (set) {
    const { built: bed } = set;
    const sown = g.sow('me', bed.id, FARM_CROP.id);
    check(sown.ok, 'a crop goes in', sown.error ?? '');

    // Unripe: left alone. The pair to 22a's empty pen, and the assertion that
    // makes "it picks a bed" mean something narrower than "it picks beds".
    const boxes = g.deliveries.length;
    run(g, 40);
    eq(g.deliveries.length, boxes, 'an unripe bed is left alone');
    check(!bed.ready, 'because it is not ready');

    g.elapsed += 120;
    g.step(0.1);
    check(bed.ready, 'the crop ripens');

    const cash = g.cash;
    check(until(g, () => !bed.ready, 400), 'and the loader picks it');
    const box = g.deliveries.find((d) => lotQty(d, GOODS.id) > 0);
    check(!!box, 'into a crate');
    eq(lotQty(box, GOODS.id), CROP_YIELD, 'holding what the bed was drawing');
    eq(bed.crop_id, FARM_CROP.id, 'and the bed is re-sown with the same crop');
    check(g.cash < cash, 'which cost a seed, exactly as a hire picking it would');
  }
}

// 22c. THE 2x2. A pen's record is its min corner, so a loader against any of the
// other three sides has to find it too — `covers`, never `x === x`. This is the
// `fixtureAt` trap docs/pens.md lists among the eight places "a fixture is a
// tile" was load-bearing, arriving on a conveyor: half the placements would work
// perfectly and the other half would do nothing, with nothing anywhere saying
// which you had built.
{
  let corners = 0;
  for (const [dx, dz] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
    const g = fresh();
    const cells = beltRun(g, 3);
    if (!cells) continue;
    const belts = lay(g, cells);
    let done = false;
    for (const belt of belts) {
      if (done) break;
      const spot = armFeeding(g, belt);
      if (!spot) continue;
      const res = g.placeFixture('me', { kind: 'arm', piece: ARM.id, x: spot.x, z: spot.z, rot: spot.rot });
      if (!res.ok) continue;
      const arm = (g.layout.arms ?? []).find((a) => a.id === res.placed);
      for (const r of [0, 1, 2, 3]) {
        const at = anchorTile(arm.x, arm.z, r);
        const spec = { kind: 'pen', x: at.x + dx, z: at.z + dz, rot: 0 };
        if (!canPlace(g.layout, spec).ok) continue;
        const put = g.placeFixture('me', { ...spec, piece: FARM_PEN.id });
        if (!put.ok) continue;
        const pen = (g.layout.pens ?? []).find((p) => p.id === put.placed);
        g.elapsed += 120;
        g.step(0.1);
        if (pen.qty !== PEN_BATCH) break;
        if (until(g, () => pen.qty === 0, 400)) corners++;
        done = true;
        break;
      }
    }
  }
  check(corners > 1, 'a loader collects a pen from more than one of its corners',
    `only ${corners} of the four placements worked`);
}

// 22d. The warning. A loader beside a pen or a bed must NOT be told it has
// nothing to do — which is the exact failure CLAUDE.md already records about the
// skip: the one press that fixes the shop reporting that it changes nothing.
// "A warning is only worth what its silence is worth."
{
  const g = fresh();
  const set = farmBeside(g, 'pen', penAt(g));
  check(!!set, 'a loader stands beside a pen');
  if (set) {
    const { arm, built: pen } = set;
    const verdict = canPlace(g.layout, {
      kind: 'arm', x: arm.x, z: arm.z, rot: arm.rot,
    }, arm.id);
    check(!/nothing beside it/.test(verdict.warn ?? ''),
      'and is not told it has nothing to work', verdict.warn ?? '');
    // ...and the run knows the pen is on it, which is what `armGather` is
    // reached through and what any future "where can this go" would read.
    const met = conveyorMeets(g.layout, arm);
    check((met.pens ?? []).some((p) => p.id === pen.id), 'the run reports the pen it meets');
  }
}

// ---------------------------------------------------------------------------
// 26. A DRAG BACK ALONG A RUN YOU OWN AIMS IT.
//
// Invisible twice over, which is why it is here: a line that reversed and a line
// that ignored you are the same picture until a crate goes down it, and the shop
// is the same shop either way — same cells, same cost, same everything but the
// one number a belt exists to express. The gesture was refused for as long as
// there have been drags ("nothing could go there"), because the skip above it is
// about the KIND and was answering a question about DIRECTION as a side effect.
//
// Its control is the drag that says nothing new — the same run dragged the same
// way is still an error, or "it aims what it crosses" becomes "every sweep is a
// success", and a press that reports a change it did not make is worse than one
// that refuses.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 5);
  check(!!cells, 'there is room for a five-cell run to reverse');
  if (cells) {
    const east = g.buildRun('me', {
      kind: 'belt', piece: BELT.id, x: cells[0].x, z: cells[0].z, to: cells[4],
    });
    eq(east.laid, 5, 'the run goes down east');
    const ids = cells.map((c) => g.beltAt(c.x, c.z)?.id);
    const cash = g.cash;
    const ver = g.layoutVersion;
    // A box already riding it, because a run is storage: reversing a line is a
    // gesture made in a working shop, and whatever it does to the goods on that
    // line is the one thing nobody would think to look at.
    const riding = crateOn(g, g.beltAt(cells[2].x, cells[2].z));
    const held = units(g);

    // The same five squares, dragged the other way.
    const back = g.buildRun('me', {
      kind: 'belt', piece: BELT.id, x: cells[4].x, z: cells[4].z, to: cells[0],
    });
    check(back.ok, 'dragging back along it is not a refusal', back.error ?? '');
    eq(back.laid, 0, '...and lays nothing, because the cells are already there');
    eq(back.aimed, 5, '...it aims all five');
    eq(g.layoutVersion, ver + 1, '...in ONE re-flow');
    eq(g.cash, cash, '...and turning what you already own is free');

    for (let i = 4; i > 0; i--) {
      const cell = g.beltAt(cells[i].x, cells[i].z);
      const to = cell && g.beltNext(cell);
      eq(`${to?.x},${to?.z}`, `${cells[i - 1].x},${cells[i - 1].z}`,
        `the cell at ${cells[i].x},${cells[i].z} now faces west`);
    }

    // The cells are the SAME cells. A re-aim that went through `placeFixture`
    // (or through `repositionFixture`) would re-mint every id on the run, and a
    // crate's address is a cell id — so the run would reverse and every box on
    // it would be orphaned, which is stock destroyed by a gesture that looks
    // like it worked.
    eq(JSON.stringify(cells.map((c) => g.beltAt(c.x, c.z)?.id)), JSON.stringify(ids),
      'and not one cell was re-laid under a new id');
    eq(units(g), held, 'the box on the run is still there');
    check(!!riding.belt && g.deliveries.includes(riding),
      '...and still riding rather than dropped on the floor');

    // The control: nothing new to say is still nothing done.
    const again = g.buildRun('me', {
      kind: 'belt', piece: BELT.id, x: cells[4].x, z: cells[4].z, to: cells[0],
    });
    check(!again.ok, 'dragging it the way it already points changes nothing');
  }
}
{
  // ...and it is the ARMED kind only. A belt swept across a loader still steps
  // round it — the skip this is built beside is about not turning machinery back
  // into plain belt, and re-aiming it instead would be the same loss wearing a
  // rotation: a loader aims at the shelf it stocks, so a sweep that turned it
  // would silently unhook every unit on the aisle.
  const g = fresh();
  const path = beltRun(g, 5);
  check(!!path, 'there is room for a run that crosses a loader');
  if (path) {
    const machine = g.placeFixture('me', {
      kind: 'arm', piece: ARM.id, x: path[2].x, z: path[2].z, rot: 1,
    });
    check(machine.ok, 'a loader stands in the path', machine.error ?? '');
    const was = g.beltAt(path[2].x, path[2].z)?.rot;
    const swept = g.buildRun('me', {
      kind: 'belt', piece: BELT.id, x: path[0].x, z: path[0].z, to: path[4],
    });
    check(swept.ok, 'the belt run lays around it', swept.error ?? '');
    eq(g.beltAt(path[2].x, path[2].z)?.rot, was, 'and the loader still aims where it did');
    eq(swept.aimed, 0, '...with nothing reported as aimed');
  }
}
{
  // ...and a PRESS is not a drag. One cell is still the swap gesture — the hover
  // ghost is drawn from `canPlace`, which refuses a belt on a belt, so a press
  // that turned one would be a green-ghost bug pointed the other way: a click
  // that does something while its own preview stands red over the square.
  const g = fresh();
  const cells = beltRun(g, 2);
  check(!!cells, 'there is room for a cell to press on');
  if (cells) {
    g.buildRun('me', { kind: 'belt', piece: BELT.id, x: cells[0].x, z: cells[0].z, to: cells[1] });
    const was = g.beltAt(cells[0].x, cells[0].z)?.rot;
    const press = g.buildRun('me', {
      kind: 'belt', piece: BELT.id, x: cells[0].x, z: cells[0].z, to: null, rot: (was + 2) % 4,
    });
    check(!press.ok, 'a one-cell press on a belt is still refused');
    eq(g.beltAt(cells[0].x, cells[0].z)?.rot, was, '...and turns nothing');
  }
}

// ---------------------------------------------------------------------------
// 24. THE MERGE — who goes first where two lines meet.
//
// The other half of a T, and the half nobody buys a piece for: two aisles into
// one dock is what a second aisle IS, so this happens on plain belt with nothing
// configured. Everything in here is invisible twice over. A box that went first
// because it was told to and a box that went first because it happened to be
// nearer are the same box on the same cell, and the shop is the same shop
// afterwards either way — only the ORDER moved, and order is the one thing a
// still frame cannot hold.
//
// Its control is the assertion that decides whether any of this is opt-in: every
// belt in every save is `default`, and a control that is wrong there has quietly
// re-timed every run in existence.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 4);
  check(!!cells, 'there is room for two lines to meet');
  if (cells) {
    // A straight run east, and a leg turning into its third cell.
    lay(g, cells);
    const join = g.beltAt(cells[2].x, cells[2].z);
    let leg = null;
    for (const dz of [-1, 1]) {
      const n = { x: cells[2].x, z: cells[2].z + dz };
      if (g.beltAt(n.x, n.z)) continue;
      if (!canPlace(g.layout, { kind: 'belt', x: n.x, z: n.z, rot: 0 }).ok) continue;
      const put = g.placeFixture('me', {
        kind: 'belt', piece: BELT.id, x: n.x, z: n.z, rot: aim(n, cells[2]),
      });
      if (!put.ok) continue;
      leg = g.beltAt(n.x, n.z);
      break;
    }
    check(!!leg, 'a leg turns into the middle of the run');

    if (leg) {
      // --- the control ------------------------------------------------------
      eq(mergeRoute(join), 'default', 'a junction nobody has spoken for takes whoever gets there first');
      check(!g.placements.find((p) => p.id === join.id)?.merge,
        '...and carries no merge field at all, so no save in existence moves');

      // The derivation both ends share. Asked here rather than trusted, because
      // the menu offers its rows off this and the sim applies them off this: two
      // opinions would be rows offered for a merge the sim does not think is one.
      const feeders = conveyorFeeders(g.layout, join);
      eq(feeders.length, 2, 'the junction knows both lines feed it');
      eq(mergeStraight(g.layout, join)?.id, g.beltAt(cells[1].x, cells[1].z)?.id,
        'and that the one behind it is the straight-through line — which is what R decides');

      /**
       * The whole claim, and it is a RACE rather than a value: one box on each
       * feeder, level, and whichever lands on the junction is the one that was
       * let through. Run from the same start twice, once each way round.
       *
       * A value could not say it. "The straight box arrived" passes on a
       * junction with no rule at all, because `barrier` had to pick somebody and
       * ties go by id — so the two settings have to DISAGREE about the same
       * start, which is the only shape of assertion that can tell a preference
       * from a coincidence.
       */
      const race = (merge) => {
        const set = g.setBeltMerge('me', join.id, merge);
        check(set.ok, `a junction can be told: ${merge}`, set.error ?? '');
        const a = crateOn(g, g.beltAt(cells[1].x, cells[1].z), GOODS, 2);
        const b = crateOn(g, g.beltAt(leg.x, leg.z), GOODS, 2);
        let won = null;
        for (let i = 0; i < 40 && !won; i++) {
          run(g, 1);
          if (a.belt === join.id) won = 'straight';
          else if (b.belt === join.id) won = 'leg';
        }
        g.deliveries = g.deliveries.filter((d) => d.id !== a.id && d.id !== b.id);
        return won;
      };
      eq(race('straight'), 'straight', 'told to let the straight line through, it does');
      eq(race('leg'), 'leg', '...and told to let the leg in, the same start goes the other way');

      /**
       * ...and the half that keeps a preference from being a deadlock, which is
       * the one worth the file.
       *
       * A leg told to wait for the main road must wait for TRAFFIC and never for
       * the road. Written as "is there a straight line" rather than "is it busy
       * right now", a priority merge is a leg that never moves again the day
       * anything jams a mile upstream — every box on it correct, none of them
       * going anywhere, which reads as belts being broken rather than as a
       * setting doing exactly what it was told.
       */
      g.setBeltMerge('me', join.id, 'straight');
      const alone = crateOn(g, g.beltAt(leg.x, leg.z), GOODS, 2);
      run(g, 40);
      check(alone.belt !== leg.id, 'a leg is not held by an EMPTY straight line');
      g.deliveries = g.deliveries.filter((d) => d.id !== alone.id);

      /**
       * ...AND UNDER LOAD, which is the assertion that earns this section and
       * the one the race above cannot make.
       *
       * A race is two boxes and a clear run, and every one of these settings
       * passed that while doing nothing whatsoever in a working shop — because a
       * cap taken off the box IN FRONT never asks about the exit, and `CRATE_PITCH`
       * is less than a cell, so on a busy line every box after the first is
       * handed a cap past its own seam and crosses with nothing having asked.
       * Measured at 147 boxes from the straight line against 1 from the leg with
       * take-turns switched on, which is what a merge with no rule at all does.
       *
       * So it is a STREAM: both lines fed every tick, a sink at the far end, and
       * the arrivals counted by which line they came off.
       */
      const stream = (merge, ticks = 600) => {
        g.deliveries = [];
        g.mergeTurn = new Map();
        g.setBeltMerge('me', join.id, merge);
        const heads = [[g.beltAt(cells[0].x, cells[0].z), 'S'], [g.beltAt(leg.x, leg.z), 'L']];
        const end = g.beltAt(cells[3].x, cells[3].z);
        const from = new Map();
        const seen = new Set();
        const seq = [];
        for (let t = 0; t < ticks; t++) {
          for (const [src, tag] of heads) {
            if (!g.beltCellFree(src)) continue;
            const c = g.dropGoods(GOODS.id, 1, { x: src.x, z: src.z }, { exact: true });
            if (c) { g.loadBelt(src, c); from.set(c.id, tag); }
          }
          run(g, 1);
          for (const d of g.deliveries) {
            if (d.belt === end.id && !seen.has(d.id)) { seen.add(d.id); seq.push(from.get(d.id)); }
          }
          // The sink. Without it the run backs up after three boxes and every
          // count below is a measurement of the jam rather than of the rule.
          g.deliveries = g.deliveries.filter((d) => d.belt !== end.id);
        }
        g.deliveries = [];
        return seq.join('');
      };

      const fair = stream('alternate');
      const sN = [...fair].filter((c) => c === 'S').length;
      const lN = [...fair].filter((c) => c === 'L').length;
      check(fair.length > 20, 'the stream actually moved boxes', `${fair.length}`);
      check(Math.abs(sN - lN) <= 2, 'take-turns gives both lines the same share of a busy junction',
        `S=${sN} L=${lN}`);
      check(!/SS|LL/.test(fair), '...strictly, box for box, and never two off one line',
        fair.slice(0, 24));

      // ...and the same stream with a favoured leg is the opposite claim: one
      // line takes the lot. Both halves or neither — a rule that only ever
      // shares is not a priority, and one that only ever starves is not a merge.
      const greedy = stream('leg');
      check(greedy.length > 20 && !greedy.includes('S'),
        'a favoured leg takes a busy junction outright', greedy.slice(0, 24));

      // Conservation, because a merge is a place two lots of goods come together
      // and every one of those in this game has been a hole.
      g.setBeltMerge('me', join.id, 'straight');
      const x = crateOn(g, g.beltAt(cells[0].x, cells[0].z), GOODS, 5);
      const y = crateOn(g, g.beltAt(leg.x, leg.z), GOODS, 3);
      const total = units(g);
      run(g, 120);
      eq(units(g), total, 'nothing is created or destroyed where two lines meet');
      g.deliveries = g.deliveries.filter((d) => d.id !== x.id && d.id !== y.id);

      /**
       * The trap `sorter.auto`, `reject` and `managed` each sprang, and a belt is
       * the most exposed thing in the shop to it: `compose` rebuilds every belt
       * record from its placement, and build mode re-flows on every wall segment
       * of a drag. A merge rule written only onto the layout is one that hands
       * itself back to "whoever gets there first" behind you while you are still
       * drawing — and both states look like a working conveyor.
       */
      g.regenerateLayout();
      const after = g.beltAt(cells[2].x, cells[2].z);
      eq(mergeRoute(after), 'straight', 'a merge rule survives a re-flow');
      eq(g.snapshot().merges?.find((m) => m.id === after?.id)?.merge, 'straight',
        '...and is on the wire, or the menu is a row that can never tick');
      // Sparse, or the biggest array in the game goes down the wire to say
      // nothing twenty times a second.
      eq(g.snapshot().merges?.length, 1, '...while every other belt in the shop sends nothing');
    }
  }
}

// ---------------------------------------------------------------------------

console.log(`\nverify:belts — ${checks} assertions\n`);
if (failures.length) {
  console.log(`  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.log(`      - ${f}`);
  console.log('');
  process.exit(1);
}
console.log('  ✅  goods move without anybody walking, and a jam is a jam.\n');
