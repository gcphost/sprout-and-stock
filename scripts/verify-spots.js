#!/usr/bin/env node
/**
 * VERIFY: WHERE A THING IS STANDING IS WORTH SOMETHING.
 *
 * Placement was the one decision in this shop with no consequence. A shelf by
 * the door and a shelf in the dead corner sold identically, the top board and
 * the bottom board sold identically, and the one rule that made a spot worth
 * money — the endcap — was invisible to everything that decides where stock
 * goes, so the shop cheerfully auto-filled the best unit in the building with
 * dried pasta. Three things changed that, and not one of them can be looked at:
 * a busy aisle and a dead one are the same still frame, and so are a shelf that
 * sells well because of what is on it and one that sells well because of where
 * it is.
 *
 * What it guards:
 *
 * - **A shop nobody has walked in is the old game exactly.** `spotScore` is 1
 *   everywhere until there is footfall to compare, `arranges` is 0 on every
 *   rung ever authored, and a new world therefore behaves as it always did.
 *   This is the assertion that decides whether any of this is opt-in.
 * - **Traffic is a measurement of the PLACE.** Only walking shoppers: not
 *   staff, whose routes are the shop's own plumbing, and not somebody STANDING
 *   at a board, because they are standing there for what is on it — count them
 *   and a shelf scores highly for holding good stock and is then given good
 *   stock on that evidence, which freezes the layout on day one and calls it a
 *   measurement.
 * - **…and it survives a re-flow.** Build mode re-flows on every segment of a
 *   drag, so a map cut fresh each time is a measurement that can never live
 *   long enough to be used. Growing the world must keep what lines up.
 * - **Out AND back.** The `paint` trap, which CLAUDE.md records costing five
 *   steps: `Game.create` names every field, so a save field written on the way
 *   out and forgotten on the way in reads back as the default — and the next
 *   `persist()` writes that default over what was stored. It does not fail to
 *   restore, it DELETES, while the save looks correct in between. A sweep that
 *   asserts only that the save CARRIED it passes for the whole life of the bug.
 * - **Eye level is one rule, asked in three places.** The board a shopper is
 *   aimed at, the roll they make when they get there, and the endcap glance
 *   from the queue. Two of those disagreeing is a shopper walked to the top
 *   board and rolled against the bottom board's odds — invisible, and the
 *   numbers simply never reconcile with where anybody put anything.
 * - **Rearranging TERMINATES**, which is the centrepiece and the only claim
 *   here that is about something NOT happening. Two shelves a hair apart will
 *   pass a box between them for the rest of the save if the move only has to be
 *   *better* — a hire visibly working, all day, changing nothing, which is the
 *   most expensive shape a bug can take because every step looks like the job.
 * - **…and it obeys both switches.** A unit with hands off and a board you
 *   ticked are instructions, at BOTH ends of the move.
 *
 * Runs on ephemeral Games. It writes two worker rows into the content database
 * — usually the live shared one — and removes them on exit.
 *
 *   node scripts/verify-spots.js
 */

import { Game } from '../server/sim/index.js';
import { content, writeContent } from '../server/content.js';
import { remove, insertWorldRow, worldRow, deleteWorldRow } from '../server/db.js';
import { MILESTONES } from '../server/sim/goals.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const near = (a, b, label, tol = 1e-6) => check(Math.abs(a - b) <= tol, label, `expected ~${b}, got ${a}`);

const SHOP = { shelf: 6, freezer: 0, checkout: 1, plot: 0 };

/** Two hands, identical but for the rung — so every claim below is a comparison. */
const PLAIN = {
  id: 'zz-spot-plain', name: 'Test Hand', color: '#7a9e4b',
  jobs: [{ job: 'merchandise', weight: 1 }], cost: 0, wage: 0,
  speed: 20, pace: 0.05, carry: 40,
  tiers: [{ name: 'Standard', cost: 0 }],
};
const ARRANGER = {
  ...PLAIN,
  id: 'zz-spot-arranger', name: 'Test Arranger',
  tiers: [{ name: 'Standard', cost: 0 }, { name: 'Arranges', cost: 0, arranges: 1 }],
};
process.on('exit', () => {
  for (const w of [PLAIN, ARRANGER]) {
    try { remove('workers', w.id); } catch { /* best effort */ }
  }
});
for (const w of [PLAIN, ARRANGER]) {
  const res = writeContent('worker', w, 'verify');
  check(res.ok, `the catalog accepts ${w.name}`, res.error ?? '');
}

const c = content();
const AMBIENT = c.items.filter((it) => !it.tags.includes('frozen') && !it.tags.includes('needs-freezer'));
check(AMBIENT.length >= 2, 'the catalog has two ambient items', `${AMBIENT.length}`);
const [ITEM_A, ITEM_B] = AMBIENT;

function fresh({ hire = null, tier = 1 } = {}) {
  const g = Game.create({ worldId: 'verify-spots', seed: 'spots', ephemeral: true });
  g.placements = [];
  g.grow = { w: 0, h: 0 };
  g.doorShift = 0;
  g.edits = [];
  g.ground = [];
  g.yardStamped = false;
  g.shell = null;
  g.ownedUpgrades = [];
  g.roster = [];
  // The map is state a live save can now carry into a sweep — the `fresh()`
  // trap's newest form. Cleared, or an assertion about a shop nobody has walked
  // in would be measuring somebody else's fortnight.
  g.traffic = null;
  g.trafficW = 0;
  g.trafficH = 0;
  g.trafficSaved = null;
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
  g.addPlayer('me', 'Tester');
  if (hire) {
    const res = g.hire(hire);
    check(res.ok, 'the hire joins', res.error ?? '');
    g.roster[g.roster.length - 1].tier = tier;
    g.step(0.1);
  }
  return g;
}

const hand = (g) => g.players[`staff-${g.roster[g.roster.length - 1]?.id}`];
const run = (g, ticks) => { for (let i = 0; i < ticks; i++) g.step(0.1); };

/** Put stock on a board, with no clock games — this file is not about spoilage. */
function board(g, shelf, item, qty) {
  shelf.stacks = [...(shelf.stacks ?? []), {
    item_id: item.id, qty, price: 3, stockedDay: g.day, soldDay: g.day,
  }];
}

/**
 * Paint footfall straight onto the grid, which is what a fortnight of play is.
 *
 * `_spotTick` is cleared with it, and that is not reaching into private state
 * for convenience — it is the sweep standing in for the thing it is skipping.
 * `spotScore` memoises per tick because it walks every unit in the shop and
 * nothing can change inside one tick; painting a fortnight between two ticks is
 * a thing only a sweep does, and without the reset every assertion below reads
 * the score from before the shop was busy and passes or fails for a reason that
 * has nothing to do with the code under test.
 */
function walked(g, cells, amount = 50) {
  for (const [x, z] of cells) {
    if (x < 0 || z < 0 || x >= g.trafficW || z >= g.trafficH) continue;
    g.traffic[z * g.trafficW + x] += amount;
  }
  g._spotTick = null;
}

// ---------------------------------------------------------------------------
// 1. The control: a shop nobody has walked in.
//
// First, and load-bearing. Every claim below is that something new happens;
// this one is that it does not happen to a shop that has not been played.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  check(!!g.traffic, 'the map is cut to the world by the first re-flow');
  eq(g.trafficW, g.layout.w, 'and it is the width of it');
  eq(g.trafficH, g.layout.h, '…and the height');
  eq(g.traffic.reduce((a, b) => a + b, 0), 0, 'with nothing watched yet');

  // Every unit scores exactly 1 — except the one by the till, which has been
  // worth more since `impulseBuy` existed and is not a footfall claim.
  const tills = g.layout.checkouts ?? [];
  const far = g.layout.shelves.filter((s) => !tills
    .some((t) => Math.hypot(s.x - t.x, s.z - t.z) <= 2.6));
  check(far.length > 0, 'the shop has a shelf that is not an endcap', `${far.length}`);
  for (const s of far) near(g.spotScore(s), 1, 'a spot nobody has walked past scores exactly 1');

  // …and the rung. `arranges` reads 0 for every tier ever authored, so the job
  // is the two verbs it has always had.
  const g2 = fresh({ hire: PLAIN.id });
  const [s0, s1] = g2.layout.shelves;
  board(g2, s0, ITEM_A, 4);
  const where = () => g2.layout.shelves.findIndex((sh) => (g2.shelfStack(sh, ITEM_A.id)?.qty ?? 0) > 0);
  const was = where();
  walked(g2, [[s1.x, s1.z]], 400);           // s1 is now the best spot in the shop
  run(g2, 400);
  eq(where(), was, 'a rung with no `arranges` never moves stock, however good the spot next door');
}

// ---------------------------------------------------------------------------
// 2. Traffic is a measurement of the PLACE.
//
// Three claims that all look like "the number went up": that a walking shopper
// counts, that a standing one does not, and that a worker never does. The
// middle one is the one with a design behind it — see `noteTraffic`.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const total = () => g.traffic.reduce((a, b) => a + b, 0);

  // Somebody standing still, with no route. The shape a shopper has while they
  // are at a board deciding.
  g.customers = { c1: { id: 'c1', x: 5, z: 5, path: [], state: 'BROWSE' } };
  g.noteTraffic(g.customers.c1, 1);
  eq(total(), 0, 'a shopper standing at a board is not footfall — that is about the STOCK');

  // The same person, walking.
  g.customers.c1.path = [{ x: 6, z: 5 }];
  g.noteTraffic(g.customers.c1, 1);
  eq(total(), 1, '…and the same person walking is');
  eq(g.traffic[5 * g.trafficW + 5], 1, 'on the tile they are on');

  // Scaled by dt, not by ticks — or the night shift, which runs at `NIGHT_SPEED`,
  // reads as six times the traffic over the same floor.
  g.noteTraffic(g.customers.c1, 0.5);
  eq(total(), 1.5, 'and it is in seconds of footfall rather than in ticks');

  // Staff never. `noteTraffic` is only ever called from `stepCustomers`, so this
  // is asserted through a real run rather than by calling it: a hire crossing
  // the shop must leave no mark.
  const g2 = fresh({ hire: PLAIN.id });
  board(g2, g2.layout.shelves[0], ITEM_A, 20);
  board(g2, g2.layout.shelves[1], ITEM_A, 4);      // a merge, so they walk
  run(g2, 300);
  const s = hand(g2);
  check(!!s, 'the hand exists');
  eq(g2.traffic.reduce((a, b) => a + b, 0), 0,
    'a worker crossing the shop all day leaves the footfall map empty');
}

// ---------------------------------------------------------------------------
// 3. It survives a re-flow, and grows with the world.
//
// Build mode re-flows on every wall segment of a drag. A map re-cut each time
// is one that can never live long enough to be worth reading, and the failure
// is silent: the overlay simply always looks new.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  walked(g, [[4, 4], [5, 4], [6, 4]], 25);
  const before = g.traffic.reduce((a, b) => a + b, 0);
  eq(before, 75, 'three tiles walked');

  g.regenerateLayout(null, {}, { want: SHOP });
  eq(g.traffic.reduce((a, b) => a + b, 0), before, 'a re-flow keeps every second of it');
  eq(g.traffic[4 * g.trafficW + 4], 25, '…on the same tiles');

  // …and a bigger world keeps what lines up. `grow` is east and south, so the
  // old cells are at the same coordinates.
  const w0 = g.layout.w;
  g.grow = { w: 4, h: 4 };
  g.regenerateLayout(null, {}, { want: SHOP });
  check(g.layout.w > w0, 'the world got bigger', `${w0} → ${g.layout.w}`);
  eq(g.traffic[4 * g.trafficW + 4], 25, 'buying land does not wipe a fortnight of watching');
  eq(g.traffic.reduce((a, b) => a + b, 0), before, '…nor move any of it');

  // And the night fades it, so the map is the shop you have rather than the one
  // you were learning in.
  g.fadeTraffic();
  check(g.traffic[4 * g.trafficW + 4] < 25, 'a night fades it');
  check(g.traffic[4 * g.trafficW + 4] > 20, '…gently — it is a fortnight, not a day');
}

// ---------------------------------------------------------------------------
// 4. Out AND BACK, which are two different pieces of code.
//
// The `paint` trap. Asserting the save carried it is half the test and the half
// that passes for the whole life of the bug.
// ---------------------------------------------------------------------------
{
  // A REAL world row, and `Game.create` rather than the constructor.
  //
  // That is the whole point of this section and it is not convenience: the bug
  // being guarded is `Game.create` naming every field by hand and forgetting
  // one. Driving the constructor directly would test the half that was never
  // broken and pass for the entire life of it — which is exactly what
  // `verify:paint` did for five steps.
  const WORLD = 'zz-verify-spots';
  if (!worldRow(WORLD)) insertWorldRow({ id: WORLD, name: 'verify:spots', seed: 'spots-1' });

  const g = Game.create({ worldId: WORLD, seed: 'spots-1' });
  g.regenerateLayout(null, {}, { want: SHOP });
  walked(g, [[7, 6]], 40);
  const out = g.saveState();
  check(!!out.traffic, 'the save carries the map');
  eq(out.traffic.cells[6 * out.traffic.w + 7], 40, '…with the right number on the right tile');
  g.persist();

  // Back in, the way the game actually comes back.
  const back = Game.create({ worldId: WORLD, seed: 'spots-1' });
  eq(back.traffic?.[6 * back.trafficW + 7], 40, 'and the shop it comes back as has it');
  // The half that IS the bug: a shop that reloaded must write it out again
  // rather than write its own default over it.
  const again = back.saveState();
  eq(again.traffic?.cells?.[6 * again.traffic.w + 7], 40,
    '…and saving THAT shop writes it out again rather than over it');

  deleteWorldRow(WORLD);
  check(worldRow(WORLD) == null, 'the sweep cleaned up its world');

  // A shop nobody has walked in writes nothing rather than a grid of zeros.
  const empty = fresh().saveState();
  eq(empty.traffic, null, 'a shop with no footfall carries no map at all');
}

// ---------------------------------------------------------------------------
// 5. Eye level, asked the same way in all three places.
//
// The claim is not what the multiplier IS — that is a tuning constant — but
// that the three readers agree. A shopper aimed at one board and rolled against
// another's odds is a shop whose numbers never reconcile with its shelves.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const shelf = g.layout.shelves[0];
  board(g, shelf, ITEM_A, 5);
  const one = g.boardPull(shelf, ITEM_A.id);
  check(one > 0, 'a stocked board has a pull', `${one}`);

  // Two kinds on one unit: they take different shares of the boards, so they
  // cannot both be at the same height — that is the whole feature.
  board(g, shelf, ITEM_B, 5);
  const a = g.boardPull(shelf, ITEM_A.id);
  const b = g.boardPull(shelf, ITEM_B.id);
  check(a !== b || g.shelfBoards(shelf) < 2,
    'two kinds on one unit sit at different heights, unless it has one board',
    `${a} vs ${b} over ${g.shelfBoards(shelf)} boards`);
  // The first kind listed gets the TOP share — the order the renderer draws in.
  if (g.shelfBoards(shelf) >= 2) check(a > b, '…and the first one listed is the higher of the two');

  // An item that is not on the unit at all, and a unit that is not a unit.
  eq(g.boardPull(shelf, null), 1, 'no item is no opinion');
  eq(g.boardPull(null, ITEM_A.id), 1, 'and no shelf is no opinion');
}

// ---------------------------------------------------------------------------
// 6. Rearranging: it happens, it obeys the switches, and IT STOPS.
//
// The last is the centrepiece and the only claim in the file about something
// not happening. Everything else here would pass against a job that moves a box
// back and forth for ever — which is a hire crossing the shop all day, looking
// exactly like a hire doing their job.
// ---------------------------------------------------------------------------
{
  const arranged = (g, itemId) => g.layout.shelves.find((sh) => (g.shelfStack(sh, itemId)?.qty ?? 0) > 0);

  // A poor spot and an obviously better one, far enough apart that the endcap
  // is not what is being measured.
  /**
   * A poor spot and an obviously better one — the two units FURTHEST apart.
   *
   * Picked by distance rather than taken off the front of the list, because a
   * generated shop stands its shelves one and two tiles apart and
   * `TRAFFIC_REACH` is 1.4: two neighbouring units share every step anybody
   * takes near either, so a pair chosen by index is a pair this file cannot
   * tell apart. That is the measurement working, not a setup trick — the same
   * fact that set the constant.
   */
  const setup = ({ tier = 2, hire = ARRANGER.id } = {}) => {
    const g = fresh({ hire, tier });
    const tills = g.layout.checkouts ?? [];
    const off = g.layout.shelves.filter((s) => !tills.some((t) => Math.hypot(s.x - t.x, s.z - t.z) <= 2.6));
    check(off.length >= 2, 'two shelves clear of the till', `${off.length}`);
    let pair = null;
    for (const a of off) {
      for (const b of off) {
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (!pair || d > pair.d) pair = { a, b, d };
      }
    }
    check(pair.d > 2.8, 'and they are far enough apart to be different places', `${pair.d}`);
    const poor = pair.a;
    const good = pair.b;
    board(g, poor, ITEM_A, 4);
    // On the tiles AROUND it rather than on its own, because a unit's own tile
    // is blocked — nobody walks there, and a map painted on it is a fortnight
    // of a thing that cannot happen.
    walked(g, [[good.x + 1, good.z], [good.x - 1, good.z], [good.x, good.z + 1]], 300);
    return { g, poor, good };
  };

  {
    const { g, poor, good } = setup();
    check(g.spotScore(good) > g.spotScore(poor) * 1.1,
      'the busy end really is the better spot', `${g.spotScore(good)} vs ${g.spotScore(poor)}`);
    run(g, 600);
    const at = arranged(g, ITEM_A.id);
    eq(at?.id, good.id, 'the arranger moves the stock to where people walk');
    eq(g.shelfStack(at, ITEM_A.id)?.qty, 4, '…all of it, and nothing was lost on the way');
  }

  // IT STOPS. Run it far past the move and assert the stock is where it landed
  // and that nobody is still carrying anything — a loop would show as a hire
  // permanently mid-errand.
  {
    const { g, good } = setup();
    run(g, 600);
    const settled = arranged(g, ITEM_A.id)?.id;
    run(g, 4000);
    const now = arranged(g, ITEM_A.id);
    eq(now?.id, settled, 'and then it stays put — the job does not oscillate');
    eq(now?.id, good.id, '…in the good spot');
    eq(g.shelfStack(now, ITEM_A.id)?.qty, 4, 'with all of it still there');
    const s = hand(g);
    check(!s.carry && !s.shifting, 'and the hand is not still mid-errand', JSON.stringify(s.shifting));
  }

  // Hands off, at the SOURCE.
  {
    const { g, poor } = setup();
    g.setShelfHands(poor.id, false);
    run(g, 1200);
    eq(arranged(g, ITEM_A.id)?.id, poor.id, 'a unit with hands off is never rearranged out of');
  }

  // Hands off, at the TARGET — the half that is easy to leave out, and reads as
  // working right up until somebody locks the shelf they were protecting.
  //
  // The claim is that the locked unit is not USED, not that nothing moves. The
  // painted traffic credits everything within `TRAFFIC_REACH` of it, so its
  // neighbours are good spots too — and a hire choosing one of those instead is
  // the feature working around an instruction rather than ignoring it.
  {
    const { g, good } = setup();
    g.setShelfHands(good.id, false);
    run(g, 1200);
    check(arranged(g, ITEM_A.id)?.id !== good.id, '…and never rearranged INTO');
    eq(g.shelfStack(good, ITEM_A.id)?.qty ?? 0, 0, 'nothing landed on the locked unit');
  }

  // A reservation is an instruction, at both ends.
  {
    const { g, poor } = setup();
    poor.assigned = [ITEM_A.id];
    run(g, 1200);
    eq(arranged(g, ITEM_A.id)?.id, poor.id, 'a board you ticked is left where you ticked it');
  }
  {
    const { g, good } = setup();
    good.assigned = [ITEM_B.id];
    run(g, 1200);
    check(arranged(g, ITEM_A.id)?.id !== good.id,
      '…and a shelf ticked for something else is not a target');
    eq(g.shelfStack(good, ITEM_A.id)?.qty ?? 0, 0, 'nothing landed on the ticked unit');
  }

  // A shop with no better spot in it. This is the hysteresis on its own, and
  // the case that oscillates without it: every unit within a few per cent of
  // every other, so every move is "better" and none of them is worth it.
  //
  // Painted flat rather than picking two shelves a few per cent apart, because
  // the interesting failure is not one pair — it is a crew finding a marginal
  // improvement SOMEWHERE, every time they are asked, for ever.
  {
    const g = fresh({ hire: ARRANGER.id, tier: 2 });
    // Starting ON the endcap, which is the one spot flat footfall cannot level.
    // A shelf by the till is worth `1 + SPOT_PULL` whatever anybody walks, so a
    // run that started anywhere else would move the stock there and be right to
    // — this section is about there being nothing left to improve.
    const tills = g.layout.checkouts ?? [];
    const poor = g.layout.shelves.slice()
      .sort((a, b) => Math.min(...tills.map((t) => Math.hypot(a.x - t.x, a.z - t.z)))
        - Math.min(...tills.map((t) => Math.hypot(b.x - t.x, b.z - t.z))))[0];
    board(g, poor, ITEM_A, 4);
    const cells = [];
    for (const sh of g.layout.shelves) {
      cells.push([sh.x + 1, sh.z], [sh.x - 1, sh.z], [sh.x, sh.z + 1], [sh.x, sh.z - 1]);
    }
    walked(g, cells, 120);
    run(g, 1500);
    eq(arranged(g, ITEM_A.id)?.id, poor.id, 'a shop with no obviously better spot is left alone');
    const s2 = hand(g);
    check(!s2.carry && !s2.shifting, '…and nobody is left holding it', JSON.stringify(s2.shifting));
  }
}

// ---------------------------------------------------------------------------

console.log(`\nverify:spots — ${checks} assertions\n`);
if (failures.length) {
  for (const f of failures) console.log(`  ❌  ${f}`);
  console.log(`\n${failures.length} failed.\n`);
  process.exit(1);
}
console.log('  ✅  where a thing stands is worth something, and rearranging it stops.\n');
