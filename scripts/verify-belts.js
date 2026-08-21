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
 * - **A run advances as a LINE**, which is the whole of why `beltOrder` exists.
 *   Stepped in list order a crate crosses the shop in one tick; stepped against
 *   a snapshot a run drains like a slinky. Both read as belts being broken, and
 *   neither is a crash.
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
import { writeContent, refresh } from '../server/content.js';
import { remove } from '../server/db.js';
import { MILESTONES } from '../server/sim/goals.js';
import { canPlace, anchorTile, isWalkableTile, edgeAt, beltRunCells, BELT_RUN_MAX } from '../shared/build.js';
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
    ['fixtures', BELT.id], ['fixtures', ARM.id], ['workers', STOCKER.id]]) {
    try { remove(t, id); } catch { /* best effort */ }
  }
});
for (const [kind, row] of [['item', GOODS], ['item', COLD], ['fixture', BELT], ['fixture', ARM],
  ['worker', STOCKER]]) {
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
  for (let i = 0; i < 3; i++) {
    eq(crates[i].belt, belts[i].id, `box ${i} held its cell rather than piling up`);
    eq(lotQty(crates[i], GOODS.id), 2, `...and box ${i} did not merge with its neighbour`);
  }
  check(!g.deliveries.some((d) => !d.belt), 'nothing spilled onto the floor at the end of the run');

  // And it un-jams the moment the way clears, rather than needing a nudge.
  g.deliveries = g.deliveries.filter((d) => d.id !== crates[2].id);
  run(g, 20);
  eq(crates[1].belt, belts[2].id, 'clearing the head lets the line move up');
  eq(crates[0].belt, belts[1].id, '...all of it, not just the front box');
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
    // A loader swings at 0.9s and a belt cell takes 0.6s, so by two seconds the
    // box has been lifted AND carried on. Asked at 1.1s, which is after the
    // swing and before the hand-off.
    run(g, 11);
    eq(crate.belt, loader.id, 'the loader lifted the crate off the floor onto itself');
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
        check(on(warm) > 0 && on(cold) > 0,
          'ONE swing stocked both sides', `shelf ${on(warm)}, freezer ${on(cold)}`);
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
    const crate = crateOn(g, g.beltAt(ring[0].x, ring[0].z), GOODS, 3);
    run(g, 7); // one belt-second's worth, at BELT_SECONDS 0.6
    const now = g.beltAt(crate.x, crate.z);
    check(now && `${now.x},${now.z}` !== `${ring[0].x},${ring[0].z}`,
      'a crate on a ring moves');
    eq(`${now?.x},${now?.z}`, `${ring[1].x},${ring[1].z}`,
      '...exactly one cell, rather than lapping the whole ring in a tick');
  }
}

// ---------------------------------------------------------------------------
// 15. A box that was held up still TRAVELS when the way clears.
//
// The one claim in here about how a thing is drawn, and it is here because a
// jammed queue is the state the whole feature is meant to make readable. A
// hand-off is instant — the tween happens on the cell you land on — so a crate
// whose charge was still at the brim when it arrived moves again on the very
// next tick, and a crate queued behind another is blocked EVERY time it lands.
// It therefore jumps cell to cell for ever while the box in front of it glides,
// which reads as two of the three being drawn wrong rather than as a queue.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cells = beltRun(g, 3);
  const belts = lay(g, cells);
  // The lead box runs into the end of the line and stops there; the one behind
  // it is held until that happens, which is the state being tested.
  crateOn(g, belts[1], GOODS, 2);
  const follow = crateOn(g, belts[0], COLD, 2);

  let held = false;
  let tweened = false;
  for (let i = 0; i < 80; i++) {
    g.step(0.1);
    if (follow.belt === belts[0].id && follow.x === belts[0].x && follow.z === belts[0].z) held = true;
    // Still filed on its own cell, drawn somewhere between it and the next.
    if (follow.belt === belts[0].id && (follow.x !== belts[0].x || follow.z !== belts[0].z)) {
      tweened = true;
    }
  }
  check(held, 'the second box is held while the first is in the way');
  check(tweened, '...and travels its cell rather than jumping when the way clears');
  eq(follow.belt, belts[1].id, '...arriving one cell along');
}

// ---------------------------------------------------------------------------
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
    }
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
  }
}
{
  // An L, which is what makes a loop four drags instead of eight — and the cap,
  // which is the 4KB argument said about work rather than about bytes.
  const bend = beltRunCells({ x: 2, z: 2 }, { x: 6, z: 4 });
  eq(bend.length, 7, 'a diagonal drag lays an L');
  check(bend.every((c, i) => i === 0 || c.x === bend[i - 1].x || c.z === bend[i - 1].z),
    '...one axis at a time');
  eq(beltRunCells({ x: 0, z: 0 }, { x: 900, z: 0 }).length, BELT_RUN_MAX,
    'and a drag across the world is capped');
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
