#!/usr/bin/env node
/**
 * VERIFY: A TILL HAS A SPEED, AND ONE OF THEM SERVES ITS OWN QUEUE.
 *
 * A checkout was the one fixture whose tier had never meant anything. The
 * ladder shipped priced at 0 and `docs/fixtures.md` said so out loud, which is
 * the honest version of a button that takes money and does nothing — and it
 * hid a second, worse thing: the ladder could not have worked if somebody had
 * priced it. `makeCheckout` never wrote a `kind` on the record it hands the
 * sim, so `pieceFor` matched nothing, `fixtureStats` answered 1/1/1, and every
 * till in every shop was permanently tier 1 whatever anyone paid.
 *
 * That is the third time that exact bug has landed. `makeStation` had it (and
 * the shipped Commercial appliance sold `speed_mult: 2` for $340 and delivered
 * nothing), `makePlot` had it until this file was written (the Raised Bed sold
 * `speed_mult: 1.6` for $90 and grew crops at exactly the old rate), and
 * `makeCheckout` had it too. None of the three is visible: the machine still
 * works, the bed still grows, the queue still moves. They are simply never any
 * faster, and "this feels slow" is not a bug report anybody files.
 *
 * So section 1 is not about tills at all. It is the general claim the other
 * three broke — that a record the sim ticks and the record build mode shows you
 * resolve to the SAME catalog row — asserted over every fixture in a furnished
 * shop, so the next constructor to forget fails here rather than in a year.
 *
 * The rest is what a checkout's ladder now buys:
 *
 * - **speed_mult moves throughput.** Not "the number is stored" — sales, over a
 *   window, against a queue of real shoppers.
 * - **`unattended` is a till that serves itself.** With nobody in the shop at
 *   all: a manual till holds its line for ever, a self-checkout rings it up.
 * - **...and it is slower than a person**, or the top rung is strictly better
 *   than the one below it and there is no decision left to make.
 * - **The takings still land on the counter.** A self-checkout that banked the
 *   money would quietly retire the one job the machine cannot do for you.
 *
 * Runs on ephemeral Games, so it never touches the live shop. It does write
 * pieces into the content database — usually the live shared one — so it cleans
 * up on exit, the same way `verify-catalog` and `verify-kitchen` do.
 *
 *   node scripts/verify-till.js
 */

import { Game } from '../server/sim/index.js';
import { content, writeContent } from '../server/content.js';
import { remove } from '../server/db.js';
import { pieceFor } from '../shared/pieces.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/**
 * A till design of this sweep's own, with a ladder nobody would ship.
 *
 * Deliberately extreme, for the same reason `verify-economy` prices its test
 * fixture at an odd number: a 4x rung makes a throughput difference something
 * you can assert on rather than something you have to argue about, and if the
 * shipped ladder is ever retuned this file must not start failing over a
 * balance decision it has no opinion about.
 *
 * Tier 3 is deliberately NOT the fastest — it is the self-service one, and it
 * is slower at the counter than tier 2. That is the whole shape of the choice
 * and a ladder that climbed monotonically could not test it.
 */
const TILL_PIECE = 'zz-till-piece';
const QUICK_MULT = 4;
const SELF_SHARE = 0.5;
const TEST_TILL = {
  id: TILL_PIECE, kind: 'checkout', name: 'Test Till', cost: 0,
  model: { parts: [{ shape: 'box', color: '#8a8a92', pos: [0, 0.3, 0], scale: [0.7, 0.6, 0.7] }] },
  tiers: [
    { name: 'Slow', cost: 0, speed_mult: 1 },
    { name: 'Quick', cost: 0, speed_mult: QUICK_MULT },
    { name: 'Self', cost: 0, speed_mult: 1, unattended: SELF_SHARE },
  ],
};

/** ...and a bed, because the plot ladder is the same bug and it was live. */
const PLOT_PIECE = 'zz-till-bed';
const BED_MULT = 3;
const TEST_PLOT = {
  id: PLOT_PIECE, kind: 'plot', name: 'Test Bed', cost: 0,
  model: { parts: [{ shape: 'box', color: '#6b4b32', pos: [0, 0.05, 0], scale: [0.9, 0.1, 0.9] }] },
  tiers: [
    { name: 'Bare', cost: 0, speed_mult: 1 },
    { name: 'Raised', cost: 0, speed_mult: BED_MULT },
  ],
};

// Registered before the first write, not after the last: a crash halfway
// through must not leave a Test Till on somebody's build menu.
process.on('exit', () => {
  for (const id of [TILL_PIECE, PLOT_PIECE]) {
    try { remove('fixtures', id); } catch { /* the DB is already gone */ }
  }
});

for (const row of [TEST_TILL, TEST_PLOT]) {
  const res = writeContent('fixture', row, 'verify');
  check(res.ok, `the catalog accepts ${row.id}`, res.error ?? '');
}

/** The same pinned shop the other build sweeps use. */
const SHOP = { shelf: 6, freezer: 1, checkout: 1, plot: 4 };

/**
 * A shop of a known shape, owning nothing and employing nobody.
 *
 * `roster` is cleared for the reason this file exists: a clerk the live save
 * happens to own would stand at the till and serve the queue that section 3 is
 * asserting nobody serves. `shell` is cleared because a stored shell makes
 * every budget zero and the sweep would get a shop with no till in it.
 */
function fresh({ autoServe = false } = {}) {
  const g = Game.create({ worldId: 'verify-till', seed: 'till', autoServe, ephemeral: true });
  g.placements = [];
  g.grow = { w: 0, h: 0 };
  g.doorShift = 0;
  g.edits = [];
  g.ground = [];
  g.yardStamped = false;
  g.shell = null;
  g.ownedUpgrades = [];
  g.roster = [];
  g.regenerateLayout(null, {}, { want: SHOP });
  g.freezeShell();
  g.freezeYard();
  g.cash = 0;
  return g;
}

/**
 * Re-flow the shop with its till (or its beds) built from a given piece and
 * rung, through the real placement path rather than by writing on the record.
 *
 * `freezeShell` has already turned everything generated into a placement, so
 * this is exactly what upgrading one does: change the placement, re-flow, read
 * back what the generator laid.
 */
function rebuild(g, kind, piece, tier) {
  for (const p of g.placements) {
    if (p.kind !== kind) continue;
    p.piece = piece;
    p.tier = tier;
  }
  g.regenerateLayout();
}

/** Wind the clock on. Nobody is touching anything — that is the point. */
const run = (g, seconds) => { for (let i = 0; i < seconds * 10; i++) g.step(0.1); };

/**
 * Put `n` shoppers in a till's line, each holding something to pay for.
 *
 * Built directly rather than walked in off the street: a browse is a long RNG
 * draw against whatever is on the shelves today, and this file is about what
 * happens once somebody is standing at the counter. Patience is set absurdly
 * high on purpose — a queue that empties because everybody stormed out is a
 * measurement of `stepMood`, not of the till.
 */
function queueUp(g, till, n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const res = g.spawnCustomer();
    if (!res.ok) break;
    const cust = g.customers[res.id];
    cust.basket = [{ item_id: 'zz-till-thing', price: 3 }];
    cust.patience = 1e6;
    cust.mood = 1;
    cust.waited = 0;
    cust.impulsed = true;             // no sweets by the till; this is a stopwatch
    cust.till = till.id;
    cust.state = 'QUEUE';
    cust.path = null;
    till.queue = till.queue ?? [];
    till.queue.push(cust.id);
    const slot = g.queueSlot(till, till.queue.length - 1);
    cust.x = slot.x;
    cust.z = slot.z;
    ids.push(cust.id);
  }
  return ids;
}

/** How many of those shoppers have been rung up and are on their way out. */
const servedOf = (g, ids) => ids.filter((id) => {
  const c = g.customers[id];
  return !c || c.state === 'LEAVE' || (c.bought?.length ?? 0) > 0;
}).length;

const tillOf = (g) => g.layout.checkouts[0];

// ---------------------------------------------------------------------------
// 1. Every fixture the sim ticks resolves to the same piece build mode shows.
//
// The general form of the bug that has now shipped three times. `findFixture`
// hands back a COPY with `kind` stamped on it, so the fixture menu, the price
// and the upgrade button have always been right; the sim reads the raw record
// out of `layout.shelves` / `.checkouts` / `.plots` / `.stations`, and a record
// with no `kind` matches no catalog row at all. Everything downstream then
// answers 1/1/1 and no screenshot, log line or verdict says a word.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const rows = content().fixtures ?? [];
  const families = [
    ['shelves', g.layout.shelves],
    ['checkouts', g.layout.checkouts],
    ['plots', g.layout.plots],
    ['stations', g.layout.stations ?? []],
    ['props', g.layout.props ?? []],
  ];

  for (const [name, recs] of families) {
    for (const rec of recs) {
      check(!!rec.kind, `a ${name} record says what kind it is`, rec.id);
      const asTicked = pieceFor(rows, rec);
      const asShown = pieceFor(rows, g.findFixture(rec.id));
      eq(asTicked?.id ?? null, asShown?.id ?? null,
        `the sim and the menu agree which piece ${rec.id} is`);
      // And the consequence, said as the number rather than as the lookup: a
      // record that resolves to nothing answers the same 1/1/1 a correct one
      // does at tier 1, which is exactly why this went unnoticed for so long.
      eq(JSON.stringify(g.fixtureStats(rec)), JSON.stringify(g.fixtureStats(g.findFixture(rec.id))),
        `and the same stat block for ${rec.id}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. A rung on a till's ladder is a rung on its throughput.
//
// Measured as sales over a window against a full queue, not as a stored number.
// `serveSeconds` returning the right figure while nothing calls it is precisely
// the state this whole file exists to end.
// ---------------------------------------------------------------------------
{
  const slow = fresh({ autoServe: true });
  rebuild(slow, 'checkout', TILL_PIECE, 1);
  const slowTill = tillOf(slow);
  check(!!slowTill, 'the shop has a till');
  eq(slow.fixtureStats(slowTill).speed_mult, 1, 'a tier-1 till runs at its authored speed');

  const quick = fresh({ autoServe: true });
  rebuild(quick, 'checkout', TILL_PIECE, 2);
  const quickTill = tillOf(quick);
  eq(quick.fixtureStats(quickTill).speed_mult, QUICK_MULT, 'and a tier-2 till at its own');

  // The same queue, the same window, the same seed.
  const slowIds = queueUp(slow, slowTill, 12);
  const quickIds = queueUp(quick, quickTill, 12);
  eq(slowIds.length, 12, 'twelve shoppers line up at the slow till');
  eq(quickIds.length, 12, 'and twelve at the quick one');

  run(slow, 12);
  run(quick, 12);
  const slowSold = servedOf(slow, slowIds);
  const quickSold = servedOf(quick, quickIds);

  check(slowSold > 0, 'the slow till serves people', `${slowSold} in 12s`);
  check(quickSold > slowSold,
    'and the better till serves more of them in the same time',
    `slow ${slowSold}, quick ${quickSold}`);
}

// ---------------------------------------------------------------------------
// 3. A till with nobody behind it. This is the feature.
//
// No player, no hire, no auto-serve — a shop whose owner is out on the farm.
// A manual till holds its line for ever (that is what a queue IS), and a
// self-checkout works its way through it.
// ---------------------------------------------------------------------------
{
  const manual = fresh();
  rebuild(manual, 'checkout', TILL_PIECE, 1);
  const manualTill = tillOf(manual);
  const manualIds = queueUp(manual, manualTill, 6);
  eq(manual.selfServeSeconds(manualTill), Infinity,
    'a till that needs a person never rings anybody up on its own');
  run(manual, 60);
  eq(servedOf(manual, manualIds), 0, 'and a minute later the line has not moved');
  eq(manual.cash, 0, 'and nothing has been taken');

  const self = fresh();
  rebuild(self, 'checkout', TILL_PIECE, 3);
  const selfTill = tillOf(self);
  eq(self.fixtureStats(selfTill).unattended, SELF_SHARE, 'a self-checkout says it serves itself');
  const selfIds = queueUp(self, selfTill, 6);
  run(self, 60);
  check(servedOf(self, selfIds) === 6,
    'and it works through the whole line with nobody in the shop',
    `${servedOf(self, selfIds)} of 6`);

  // The money is on the counter, not in the bank. A machine can take payment;
  // it cannot walk the takings to you, and a self-checkout that banked them
  // would delete the one job it does not do.
  eq(self.cash, 0, 'the shop has not banked the takings');
  const onCounter = self.cashDrops.reduce((n, d) => n + d.amount, 0);
  check(onCounter > 0, 'they are sitting on the counter waiting to be collected',
    `drops ${self.cashDrops.length}`);
}

// ---------------------------------------------------------------------------
// 4. ...and serving yourself is slower than being served.
//
// Both halves of one claim: the number, and the consequence. If the top rung
// were faster unattended than a person is at the counter, the ladder would
// have no decision on it — buy the machine, never hire again.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  rebuild(g, 'checkout', TILL_PIECE, 3);
  const till = tillOf(g);
  check(g.selfServeSeconds(till) > g.serveSeconds(till),
    'a shopper fumbling through it takes longer than somebody who does it all day',
    `self ${g.selfServeSeconds(till)}s vs served ${g.serveSeconds(till)}s`);

  // The quick manned till against the self-service one, over the same window.
  const manned = fresh({ autoServe: true });
  rebuild(manned, 'checkout', TILL_PIECE, 2);
  const mannedTill = tillOf(manned);
  const mannedIds = queueUp(manned, mannedTill, 12);
  const alone = fresh();
  rebuild(alone, 'checkout', TILL_PIECE, 3);
  const aloneTill = tillOf(alone);
  const aloneIds = queueUp(alone, aloneTill, 12);

  run(manned, 12);
  run(alone, 12);
  check(servedOf(manned, mannedIds) > servedOf(alone, aloneIds),
    'so a staffed queue still beats a self-service one',
    `manned ${servedOf(manned, mannedIds)}, self ${servedOf(alone, aloneIds)}`);
}

// ---------------------------------------------------------------------------
// 5. The bed that was paid for and never grew anything faster.
//
// Same bug, different constructor, and it was live in the shipped catalog until
// this file went in. `plotGrowth` reads the raw layout record, so it is the one
// place a missing `kind` costs the player money on a clock.
// ---------------------------------------------------------------------------
{
  const crop = content().crops[0];
  check(!!crop, 'there is a crop to plant');

  const grown = (tier) => {
    const g = fresh();
    rebuild(g, 'plot', PLOT_PIECE, tier);
    const plot = g.layout.plots[0];
    eq(plot.kind, 'plot', 'a bed says it is a bed');
    plot.soil = 'tilled';
    plot.crop_id = crop.id;
    plot.plantedAt = g.elapsed;
    plot.ready = false;
    run(g, 30);
    return g.plotGrowth(plot);
  };

  const bare = grown(1);
  const raised = grown(2);
  check(bare > 0 && bare < 1, 'a bare bed is part-grown after half a minute', `${bare}`);
  check(raised > bare,
    'and a bed you paid to raise is further along than one you did not',
    `bare ${bare}, raised ${raised}`);
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\nverify:till — ${failures.length} of ${checks} assertions FAILED\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\nverify:till — ${checks} assertions\n`);
console.log('  ✅  a till has a speed, and a self-checkout serves its own queue.\n');
