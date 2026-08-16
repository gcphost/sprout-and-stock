#!/usr/bin/env node
/**
 * VERIFY: AN APPLIANCE HOLDS MORE THAN ONE OF ANYTHING.
 *
 * An appliance used to hold exactly one batch of ingredients and one batch of
 * finished goods, and stop dead between them. Load a coffee machine with a milk
 * and a coffee, and it made one Flat White and then waited — for `minutes`, then
 * for however long it took somebody to walk over. With one chef and three
 * machines that is most of the day, and what you see is a kitchen that produces
 * about one thing however much you feed it.
 *
 * Every claim below is invisible in a screenshot and nearly invisible in play,
 * which is the whole reason for the file. A machine that made four batches while
 * you were on the farm and one that made one look identical when you get back —
 * the difference is a number in a tray, and you were not there for either.
 *
 * What it exists to catch:
 *
 * - **A hopper with no ceiling.** `loadStation` took the whole armful with no
 *   cap at all before, which is not "generous", it is a machine that can be
 *   handed forty tomatoes it will never use and cannot give back except by
 *   tipping the whole thing out. The cap is `STATION_BATCHES` batches, and the
 *   overflow has to stay in your HANDS — vanishing is theft and refusing the
 *   whole armful means doing arithmetic before every load.
 * - **A machine that stops after one batch.** The regression the file is named
 *   for, and it is a one-word change away at all times: a `continue` after a
 *   finished batch, or an `if (st.output)` guard before starting one, and the
 *   kitchen is back to a slower shelf. So this loads four batches, walks away,
 *   and counts.
 * - **A machine that eats what it makes.** The old loop enforced "one product at
 *   a time" AFTER the timer ran out — make the batch, then drop it on the floor
 *   if the tray held something else. On a station with two recipes that is
 *   ingredients destroyed on a clock, and the only symptom is stock going
 *   missing. Section 4 is a conservation count over a long run for that reason:
 *   what went in has to be in the hopper, in the tray, or in the ledger.
 * - **A tier that changes no number.** A station's `capacity_mult` was authored
 *   the day the ladder was and nothing had ever read it — the exact trap
 *   CLAUDE.md names, sitting in the shipped catalog. It sizes the hopper now,
 *   so section 5 asserts a tier-2 machine actually holds more.
 * - **A chef who fetches one batch at a time.** The mechanic is only worth
 *   having if somebody uses it, and nobody watches a hire closely enough to
 *   notice they are walking four times for what one trip would carry.
 *
 * Runs on an ephemeral Game, so it never touches the live shop. It does write to
 * the content database — usually the live shared one — so it cleans up on exit,
 * the same way `verify-catalog` and `verify-economy` do.
 *
 *   node scripts/verify-kitchen.js
 */

import { Game } from '../server/sim/index.js';
import { writeContent } from '../server/content.js';
import { remove } from '../server/db.js';
import { canPlace } from '../shared/build.js';
import { WALKABLE } from '../shared/tiles.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/**
 * The number this whole file is about, spelled out rather than imported.
 *
 * `STATION_BATCHES` is a balance decision — how long a kitchen runs unattended
 * is most of what a kitchen is worth — and asserting against the constant would
 * pass whatever anybody set it to next week. Moving it should mean coming here
 * and saying so out loud.
 */
const BATCHES = 4;

const STATION = 'zz-kit-urn';

/**
 * Two recipes on one machine, with different outputs and deliberately different
 * shapes. `brew` takes 2 and makes 3, `tea` takes 1 and makes 1 — so no
 * assertion below can pass by accident on a machine that quietly treats one
 * batch as one unit of everything.
 */
const BREW = 'zz-kit-brew-recipe';
const TEA = 'zz-kit-tea-recipe';
const BEAN_PER_BATCH = 2;
const BREW_PER_BATCH = 3;

const TEST_ITEMS = [
  {
    id: 'zz-kit-bean', name: 'Test Bean', tags: ['pantry', 'shelf-stable'],
    base_cost: 1, base_price: 2, stack: 40,
    model: { parts: [{ shape: 'box', color: '#6b4b32', pos: [0, 0.1, 0], scale: [0.2, 0.2, 0.2] }] },
  },
  {
    id: 'zz-kit-leaf', name: 'Test Leaf', tags: ['pantry', 'shelf-stable'],
    base_cost: 1, base_price: 2, stack: 40,
    model: { parts: [{ shape: 'box', color: '#4b6b32', pos: [0, 0.1, 0], scale: [0.2, 0.2, 0.2] }] },
  },
  {
    id: 'zz-kit-brew', name: 'Test Brew', tags: ['beverage', 'shelf-stable'],
    base_cost: 2, base_price: 5, stack: 40,
    model: { parts: [{ shape: 'box', color: '#32406b', pos: [0, 0.1, 0], scale: [0.2, 0.3, 0.2] }] },
  },
  {
    id: 'zz-kit-tea', name: 'Test Tea', tags: ['beverage', 'shelf-stable'],
    base_cost: 2, base_price: 5, stack: 40,
    model: { parts: [{ shape: 'box', color: '#6b3240', pos: [0, 0.1, 0], scale: [0.2, 0.3, 0.2] }] },
  },
];

const TEST_RECIPES = [
  {
    id: BREW, name: 'Test Brew', station: STATION,
    inputs: [{ item_id: 'zz-kit-bean', qty: BEAN_PER_BATCH }],
    output_id: 'zz-kit-brew', output_qty: BREW_PER_BATCH, minutes: 1,
  },
  {
    id: TEA, name: 'Test Tea', station: STATION,
    inputs: [{ item_id: 'zz-kit-leaf', qty: 1 }],
    output_id: 'zz-kit-tea', output_qty: 1, minutes: 1,
  },
];

/** An appliance only exists if an upgrade sells it — see `stationUpgrade`. */
const TEST_UPGRADE = {
  id: 'zz-kit-machine', name: 'Test Urn', description: 'Buys the sweep an appliance.',
  cost: 0, kind: 'station', payload: { station: STATION },
};

/**
 * A station design of this sweep's own, with a ladder that actually climbs.
 *
 * The shipped `station` row carries `capacity_mult: 1` on both rungs, so using
 * it for section 5 would assert that a knob nothing reads still reads nothing.
 * Tier 2 here holds three times as much and is deliberately NOT faster, so a
 * hopper measurement cannot be a speed measurement wearing its coat.
 */
const URN_PIECE = 'zz-kit-piece';
const URN_TIER2_MULT = 3;
const TEST_PIECE = {
  id: URN_PIECE, kind: 'station', name: 'Test Urn', cost: 0,
  model: { parts: [{ shape: 'box', color: '#8a8a92', pos: [0, 0.5, 0], scale: [0.7, 1, 0.7] }] },
  tiers: [
    { name: 'Small', cost: 0, capacity_mult: 1, speed_mult: 1 },
    { name: 'Large', cost: 0, capacity_mult: URN_TIER2_MULT, speed_mult: 1 },
  ],
};

/**
 * One job and one only. A hire who could also `shelve` would carry the finished
 * brew off to a shelf mid-assertion, and section 6 counts what is in a hopper.
 */
const TEST_WORKER = {
  id: 'zz-kit-chef', name: 'Test Chef', color: '#d98b4a',
  jobs: [{ job: 'craft', weight: 1 }], cost: 0, wage: 0, speed: 20, pace: 0.05,
  tiers: [{ name: 'Standard', cost: 0 }],
};

// Registered before the first write, not after the last: a crash halfway
// through must not leave a Test Urn on somebody's build menu.
process.on('exit', () => {
  for (const r of TEST_ITEMS) { try { remove('items', r.id); } catch { /* the DB is already gone */ } }
  for (const r of TEST_RECIPES) { try { remove('recipes', r.id); } catch { /* best effort */ } }
  try { remove('upgrades', TEST_UPGRADE.id); } catch { /* best effort */ }
  try { remove('fixtures', TEST_PIECE.id); } catch { /* best effort */ }
  try { remove('workers', TEST_WORKER.id); } catch { /* best effort */ }
});

for (const r of TEST_ITEMS) {
  const res = writeContent('item', r, 'verify');
  check(res.ok, `the catalog accepts the item ${r.id}`, res.error ?? '');
}
for (const r of TEST_RECIPES) {
  const res = writeContent('recipe', r, 'verify');
  check(res.ok, `the catalog accepts the recipe ${r.id}`, res.error ?? '');
}
{
  const res = writeContent('upgrade', TEST_UPGRADE, 'verify');
  check(res.ok, 'the catalog accepts the appliance upgrade', res.error ?? '');
}
{
  const res = writeContent('fixture', TEST_PIECE, 'verify');
  check(res.ok, 'the catalog accepts the appliance design', res.error ?? '');
}
{
  const res = writeContent('worker', TEST_WORKER, 'verify');
  check(res.ok, 'the catalog accepts the test chef', res.error ?? '');
}

/** The same pinned shop the other build sweeps use. */
const SHOP = { shelf: 6, freezer: 1, checkout: 1, plot: 4 };

/**
 * A shop of a known shape, owning nothing and employing nobody.
 *
 * `roster` matters here for the same reason it matters to `verify-break`:
 * section 6 counts what one chef gets done, and a hire the live save happens to
 * own is a second pair of hands in the assertion. `ownedUpgrades` matters
 * because a station tier discount would move the numbers in section 5.
 */
function fresh() {
  const g = Game.create({ worldId: 'verify-kitchen', seed: 'kitchen', ephemeral: true });
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
  g.cash = 50000;
  g.addPlayer('me', 'Tester');
  g.players.me.build = { on: true, tool: 'station' };
  return g;
}

/** Somewhere an appliance will actually go, through the real validator. */
function spotFor(g, kind) {
  const L = g.layout;
  for (let z = 1; z < L.h - 1; z++) {
    for (let x = 1; x < L.w - 1; x++) {
      if (!WALKABLE.has(L.tiles[z * L.w + x])) continue;
      for (const rot of [0, 1, 2, 3]) {
        if (canPlace(L, { kind, x, z, rot }).ok) return { x, z, rot };
      }
    }
  }
  return null;
}

/** Stand one of this sweep's urns in the shop and hand back the live record. */
function urn(g, tier = 1) {
  const at = spotFor(g, 'station');
  check(!!at, 'there is somewhere to stand an appliance');
  const built = g.placeFixture('me', {
    kind: 'station', piece: URN_PIECE, station: STATION, x: at.x, z: at.z, rot: at.rot,
  });
  check(built.ok, 'the appliance goes down', built.error ?? '');
  const st = g.layout.stations.find((s) => s.id === built.placed) ?? null;
  check(!!st, 'and it is standing there as a station');
  if (st) {
    // Both copies. `fixtureTier` reads the layout record first because that is
    // what the sim ticks against, and the placement is what survives a re-flow —
    // setting one and not the other is a machine that changes tier when you buy
    // a shelf.
    st.tier = tier;
    const p = g.placements.find((q) => q.id === built.placed);
    if (p) p.tier = tier;
    // The tester has to be able to reach it. Standing somewhere else is a fair
    // test of `REACH` and not of anything this file is about.
    Object.assign(g.players.me, { x: st.useAt.x, z: st.useAt.z });
  }
  return st;
}

/** Put an armful in somebody's hands. */
const hold = (g, itemId, qty) => { g.players.me.carry = { item_id: itemId, qty }; };

/** Wind the clock on. Nobody is touching anything — that is the point. */
const run = (g, seconds) => { for (let i = 0; i < seconds * 10; i++) g.step(0.1); };

// ---------------------------------------------------------------------------
// 1. A hopper holds four batches, and what will not fit stays in your hands.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const st = urn(g);
  const cap = BEAN_PER_BATCH * BATCHES;
  eq(g.stationHopperCap(st, 'zz-kit-bean'), cap,
    'the hopper is sized at four batches of what the recipe calls for');

  hold(g, 'zz-kit-bean', cap);
  const loaded = g.loadStation('me', st.id);
  check(loaded.ok, 'a full hopper-load goes in in one action', loaded.error ?? '');
  eq(st.contents['zz-kit-bean'], cap, 'and all of it lands in the hopper');
  eq(g.players.me.carry, null, 'with nothing left in hand');

  // The ceiling. One more unit is refused, and refused BEFORE the hands are
  // emptied — a machine that swallows what it cannot use is worse than one that
  // says no, because the only way to get it back is to tip the whole thing out.
  hold(g, 'zz-kit-bean', 1);
  const over = g.loadStation('me', st.id);
  check(!over.ok, 'a full hopper refuses one more', JSON.stringify(over));
  eq(st.contents['zz-kit-bean'], cap, 'and holds exactly what it held');
  eq(g.players.me.carry?.qty, 1, 'and the unit is still in your hands, not gone');

  // A partial load: as much as fits, the rest stays held. The alternative is
  // arithmetic before every trip to the shelf.
  const g2 = fresh();
  const st2 = urn(g2);
  st2.contents['zz-kit-bean'] = cap - 2;
  hold(g2, 'zz-kit-bean', 6);
  const part = g2.loadStation('me', st2.id);
  check(part.ok, 'an armful bigger than the room left still loads', part.error ?? '');
  eq(part.loaded, 2, 'it takes exactly what fits');
  eq(st2.contents['zz-kit-bean'], cap, 'filling the hopper');
  eq(g2.players.me.carry?.qty, 4, 'and hands the remainder back');
}

// ---------------------------------------------------------------------------
// 2. Loaded and left alone, it runs itself down. The whole point of the change.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const st = urn(g);
  hold(g, 'zz-kit-bean', BEAN_PER_BATCH * BATCHES);
  check(g.loadStation('me', st.id).ok, 'four batches go in');

  // Long enough for four one-minute batches with room to spare, and nobody
  // comes near it. A minute of game time is DAY_SECONDS/1440 real seconds.
  run(g, 60);

  eq(st.contents['zz-kit-bean'], undefined, 'it works through the whole hopper unattended');
  eq(st.output?.item_id, 'zz-kit-brew', 'and what is in the tray is what it makes');
  eq(st.output?.qty, BREW_PER_BATCH * BATCHES,
    'four batches, not one — an appliance is not a slower shelf');
  eq(st.making, null, 'and it stops when there is nothing left to make');

  // One line per run rather than one per batch: four "is ready" lines in an
  // eight-line log buries everything else that happened this morning.
  const ready = g.log.filter((l) => /ready at the/.test(l.msg ?? ''));
  eq(ready.length, 1, 'and says so once, with the count');
  check(/12x/.test(ready[0]?.msg ?? ''), 'naming how much is waiting', ready[0]?.msg ?? '');

  // And the tray comes out in armfuls, not in batches.
  const cap = g.carryCapacity();
  const got = g.collectStation('me', st.id);
  check(got.ok, 'the tray can be collected', got.error ?? '');
  eq(got.collected, cap, 'as much as one person can carry');
  eq(st.output?.qty, BREW_PER_BATCH * BATCHES - cap, 'and the rest is still waiting');
}

// ---------------------------------------------------------------------------
// 3. The tray has a ceiling too, and a full one stops the machine.
//
// Without this the hopper cap is the only thing bounding a kitchen, and a
// machine somebody keeps topping up grows an unbounded pile of goods on a
// worktop nobody has to walk to. The ingredients must stay in the hopper rather
// than being spent into a tray that cannot hold the result.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const st = urn(g);
  const trayCap = BREW_PER_BATCH * BATCHES;

  hold(g, 'zz-kit-bean', BEAN_PER_BATCH * BATCHES);
  check(g.loadStation('me', st.id).ok, 'four batches go in');
  run(g, 60);
  eq(st.output?.qty, trayCap, 'the tray fills to its ceiling');

  // Top it up with nobody collecting. It must refuse to start.
  hold(g, 'zz-kit-bean', BEAN_PER_BATCH * BATCHES);
  check(g.loadStation('me', st.id).ok, 'and it will still accept more ingredients');
  run(g, 60);
  eq(st.output?.qty, trayCap, 'but makes nothing more with nowhere to put it');
  eq(st.contents['zz-kit-bean'], BEAN_PER_BATCH * BATCHES,
    'and the ingredients are still in the hopper, not spent on a batch that fell on the floor');

  // Take the tray away and it picks straight back up. A machine that needed
  // emptying AND re-loading would be worse than the one this replaced.
  g.players.me.carry = null;
  while (st.output) {
    const res = g.collectStation('me', st.id);
    if (!res.ok) break;
    g.players.me.carry = null;
  }
  eq(st.output, null, 'the tray empties');
  run(g, 60);
  eq(st.output?.qty, trayCap, 'and it gets straight back to work on its own');
}

// ---------------------------------------------------------------------------
// 4. A machine with two recipes destroys nothing.
//
// The old loop checked "is the tray already holding something else" AFTER the
// timer ran out, so a station that could make two things spent ingredients on
// batches it then dropped. Nothing logs that and nothing renders it; stock just
// goes missing. So this is a count: everything loaded is in the hopper, in the
// tray, or in somebody's hands, converted at the rate its recipe says.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const st = urn(g);

  hold(g, 'zz-kit-bean', BEAN_PER_BATCH * BATCHES);
  check(g.loadStation('me', st.id).ok, 'beans go in');
  g.players.me.carry = null;
  hold(g, 'zz-kit-leaf', BATCHES);
  check(g.loadStation('me', st.id).ok, 'and leaves go in alongside them');
  g.players.me.carry = null;

  const collected = { 'zz-kit-brew': 0, 'zz-kit-tea': 0 };
  // Long enough for both queues, with a collection every so often so neither
  // tray can wedge the machine — which is what a real chef is doing.
  for (let i = 0; i < 120; i++) {
    run(g, 1);
    if (st.output) {
      const res = g.collectStation('me', st.id);
      if (res.ok) collected[res.item_id] += res.collected;
      g.players.me.carry = null;
    }
  }

  const beansLeft = st.contents['zz-kit-bean'] ?? 0;
  const leavesLeft = st.contents['zz-kit-leaf'] ?? 0;
  const inFlight = st.making ? content_inputs(st.making) : { bean: 0, leaf: 0 };
  const brewMade = collected['zz-kit-brew'] + (st.output?.item_id === 'zz-kit-brew' ? st.output.qty : 0);
  const teaMade = collected['zz-kit-tea'] + (st.output?.item_id === 'zz-kit-tea' ? st.output.qty : 0);

  eq(brewMade / BREW_PER_BATCH * BEAN_PER_BATCH + beansLeft + inFlight.bean, BEAN_PER_BATCH * BATCHES,
    'every bean is accounted for — in the tray, in the hopper, or in the batch running');
  eq(teaMade + leavesLeft + inFlight.leaf, BATCHES,
    'and every leaf too');
  check(brewMade > 0 && teaMade > 0,
    'and it genuinely made both things rather than committing to one',
    `brew ${brewMade}, tea ${teaMade}`);
}

/** What the batch currently running took out of the hopper. */
function content_inputs(recipeId) {
  const r = TEST_RECIPES.find((x) => x.id === recipeId);
  return {
    bean: r?.inputs.find((i) => i.item_id === 'zz-kit-bean')?.qty ?? 0,
    leaf: r?.inputs.find((i) => i.item_id === 'zz-kit-leaf')?.qty ?? 0,
  };
}

// ---------------------------------------------------------------------------
// 5. `capacity_mult` moves a hopper — a tier that changes no number is a button
//    that takes money and does nothing, and this one took money for a year.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const small = urn(g, 1);
  const smallCap = g.stationHopperCap(small, 'zz-kit-bean');

  const g2 = fresh();
  const large = urn(g2, 2);
  const largeCap = g2.stationHopperCap(large, 'zz-kit-bean');

  eq(largeCap, smallCap * URN_TIER2_MULT, 'the better machine holds what its tier says it holds');
  eq(g2.stationBatches(large), BATCHES * URN_TIER2_MULT, 'which is three times the batches');

  // And it is genuinely a bigger run, not just a bigger number.
  hold(g2, 'zz-kit-bean', largeCap);
  check(g2.loadStation('me', large.id).ok, 'a large urn takes a large load', '');
  run(g2, 200);
  eq(large.output?.qty, BREW_PER_BATCH * BATCHES * URN_TIER2_MULT,
    'and works through all of it in one unattended run');
}

// ---------------------------------------------------------------------------
// 6. One chef fills a hopper, rather than fetching one batch at a time.
//
// The mechanic is only worth having if the person you pay uses it. Nobody
// watches a hire closely enough to notice they made four trips for what one
// would carry — you notice the kitchen is slow and blame the machine.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const st = urn(g);

  // A stockroom shelf with plenty on it. Back of house, because that is what
  // decides how much the chef takes: fill the hopper out of the stockroom, only
  // borrow one batch off the shop floor.
  const shelf = g.layout.shelves[0];
  check(!!shelf, 'the shop has a shelf to stock');
  shelf.boh = true;
  shelf.stacks = [{ item_id: 'zz-kit-bean', qty: 60, price: 2, stockedDay: g.day }];

  check(g.hire(TEST_WORKER.id).ok, 'a chef can be taken on');
  g.step(0.1);
  const chef = g.players[`staff-${g.roster[0].id}`];
  check(!!chef, 'and turns up for work');

  // Long enough to walk there and back a few times, and no longer — the claim
  // is about ONE trip carrying more than one batch, not about eventually
  // getting there.
  const cap = g.stationHopperCap(st, 'zz-kit-bean');
  let peak = 0;
  for (let i = 0; i < 900; i++) {
    g.step(0.1);
    peak = Math.max(peak, (st.contents['zz-kit-bean'] ?? 0) + (chef.carry?.qty ?? 0));
  }
  check(peak > BEAN_PER_BATCH,
    'the chef fetches more than one batch at a time out of the stockroom',
    `peak ${peak}, one batch is ${BEAN_PER_BATCH}`);
  check(peak >= Math.min(cap, g.carryCapacity()),
    'and carries as much as their hands hold toward filling it',
    `peak ${peak}, hands hold ${g.carryCapacity()}`);
  check((st.output?.qty ?? 0) + (chef.carry?.item_id === 'zz-kit-brew' ? chef.carry.qty : 0) > BREW_PER_BATCH,
    'and the machine gets through more than one batch while they do it',
    `tray ${st.output?.qty ?? 0}`);

  // Nobody is wedged. A chef holding something the machine has no room for used
  // to walk back to it forever; the job has to hand that armful to `shelve`.
  check(chef.carry?.item_id !== 'zz-kit-bean' || g.stationHopperRoom(st, 'zz-kit-bean') > 0,
    'and is never left holding an ingredient nothing has room for');
}

// ---------------------------------------------------------------------------
// 7. A shop with no back of house still works — one batch at a time, as before.
//
// The stockroom rule is a preference, never a requirement. A shop that could
// not craft until the player had painted a stockroom would be a mechanic that
// silently switches off for everybody who has not read the patch notes.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const st = urn(g);
  const shelf = g.layout.shelves[0];
  shelf.boh = false;                       // shop floor, like every generated shelf
  shelf.stacks = [{ item_id: 'zz-kit-bean', qty: 60, price: 2, stockedDay: g.day }];

  check(g.hire(TEST_WORKER.id).ok, 'a chef can be taken on');
  g.step(0.1);

  for (let i = 0; i < 900; i++) g.step(0.1);
  const made = (st.output?.qty ?? 0)
    + Object.values(g.players).reduce((n, p) => n + (p.carry?.item_id === 'zz-kit-brew' ? p.carry.qty : 0), 0);
  check(made > 0, 'a kitchen with nowhere to stockpile still makes things', `made ${made}`);
  check(shelf.stacks[0].qty > 30,
    'and the shop floor is borrowed from a batch at a time rather than stripped',
    `${shelf.stacks[0].qty} left of 60`);
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\nverify:kitchen — ${failures.length} of ${checks} assertions FAILED\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\nverify:kitchen — ${checks} assertions\n`);
console.log('  ✅  an appliance holds four batches and works through them on its own.\n');
