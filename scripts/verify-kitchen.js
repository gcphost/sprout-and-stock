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
 * - **A second head that changes the machine every shop already owns.** Section
 *   10 is about the `lines` rung, and its loudest claim is the control: a rung
 *   that says nothing about heads is one head, which is every rung ever
 *   authored. Sections 1–9 are the rest of that control — they are written as
 *   they were written when a machine had one head, and they still pass.
 *
 *   The rest of 10 is invisible twice over. Two heads running and one head
 *   running twice as fast make the same amount of the same thing; a chef who
 *   serviced one tray and a chef who serviced both walk the same route. What
 *   separates them is a number in a tray you were not there to watch fill.
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
import { lotStacks, lotTotal, lotQty, lotHas } from '../shared/lot.js';

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
/**
 * ...and a third that wants the same ingredient as the first, for section 10.
 *
 * Two heads competing for the last bean is the only way to ask which one wins,
 * and `brew` and `tea` deliberately share nothing — so a machine set to both of
 * them proves the heads run and proves nothing about the ONE bin they run out
 * of. Appended rather than inserted, because `mine[0]` being `brew` is what
 * "an appliance nobody has set is on its first recipe" rests on.
 */
const MOCHA = 'zz-kit-mocha-recipe';
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
  {
    id: 'zz-kit-mocha', name: 'Test Mocha', tags: ['beverage', 'shelf-stable'],
    base_cost: 2, base_price: 5, stack: 40,
    model: { parts: [{ shape: 'box', color: '#40326b', pos: [0, 0.1, 0], scale: [0.2, 0.3, 0.2] }] },
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
  {
    id: MOCHA, name: 'Test Mocha', station: STATION,
    inputs: [{ item_id: 'zz-kit-bean', qty: BEAN_PER_BATCH }],
    output_id: 'zz-kit-mocha', output_qty: 1, minutes: 1,
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
/**
 * ...and a third rung whose ONLY difference from the second is a second head.
 *
 * Deliberately identical in `capacity_mult` and `speed_mult` to the rung below
 * it, so section 10 cannot pass by accident on a machine that simply got bigger
 * or faster. It is also what makes the step back down a claim about heads alone:
 * Twin → Large loses a head and changes nothing else, which is the shape
 * `tierShortfall` has to refuse over.
 */
const URN_TWIN = 3;
const TEST_PIECE = {
  id: URN_PIECE, kind: 'station', name: 'Test Urn', cost: 0,
  model: { parts: [{ shape: 'box', color: '#8a8a92', pos: [0, 0.5, 0], scale: [0.7, 1, 0.7] }] },
  tiers: [
    { name: 'Small', cost: 0, capacity_mult: 1, speed_mult: 1 },
    { name: 'Large', cost: 0, capacity_mult: URN_TIER2_MULT, speed_mult: 1 },
    { name: 'Twin', cost: 0, capacity_mult: URN_TIER2_MULT, speed_mult: 1, lines: 2 },
  ],
};

/**
 * One job and one only. A hire who could also `shelve` would carry the finished
 * brew off to a shelf mid-assertion, and section 6 counts what is in a hopper.
 */
/**
 * How much brew this kitchen has produced, wherever it ended up.
 *
 * Three places, and the third one is new: the tray, somebody's hands, and a
 * CRATE. Counting the first two was right for as long as a hire with no `tidy`
 * had no way to put anything down — which is what `TEST_HAND` below exists to
 * work around, and what `stepStaff` stopped being true of when `putDown` became
 * something anybody can do rather than a job you have to have been given.
 *
 * The claim being made is "the kitchen made things". A chef who made three
 * trays and walked them out to the drop-off has made three trays, and a sweep
 * that reports zero for that is measuring who is holding the goods rather than
 * whether they exist — which is the same class of mistake as the balance bot
 * that stopped modelling a player (see CLAUDE.md): a broken instrument reads as
 * a broken feature, and this one read as a kitchen that had stopped.
 */
const brewMade = (g, st) => trayQty(g, st)
  + Object.values(g.players).reduce((n, p) => n + lotQty(p.carry, 'zz-kit-brew'), 0)
  + (g.deliveries ?? []).reduce((n, c) => n + lotQty(c, 'zz-kit-brew'), 0);

/**
 * The machine's first head, which is the only one anything in sections 1–9 has.
 *
 * `stationSlots` is the one spelling of where a tray and a batch clock live.
 * They were five loose fields on the record until an appliance could have two
 * heads, and reading them raw here would be asserting against the shape of the
 * record rather than against the machine — which passes right up until the day
 * somebody moves them, and says nothing useful on the day they do.
 */
const head = (g, st, i = 0) => g.stationSlots(st)[i];
/** What is standing on a head's tray, in units. */
const trayQty = (g, st, i = 0) => head(g, st, i).output?.qty ?? 0;

const TEST_WORKER = {
  id: 'zz-kit-chef', name: 'Test Chef', color: '#d98b4a',
  jobs: [{ job: 'craft', weight: 1 }], cost: 0, wage: 0, speed: 20, pace: 0.05,
  tiers: [{ name: 'Standard', cost: 0 }],
};

/**
 * The whole loop in one pair of hands, for section 8 only.
 *
 * A chef who can only `craft` cannot build the pile the section is about: with
 * no `tidy` they end up standing there holding one tray of brew, which looks
 * like a shop that stopped and is really a shop with nobody to put it down.
 * `shelve` and `tidy` are what turn "the machine made another one" into a crate
 * at the drop-off and a machine free to make the next, so they have to be here
 * or the regression this guards against cannot happen in the sweep either.
 */
const TEST_HAND = {
  id: 'zz-kit-hand', name: 'Test Hand', color: '#4ad98b',
  jobs: [{ job: 'craft', weight: 1 }, { job: 'shelve', weight: 1 }, { job: 'tidy', weight: 1 }],
  cost: 0, wage: 0, speed: 20, pace: 0.05,
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
  try { remove('workers', TEST_HAND.id); } catch { /* best effort */ }
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
  const res2 = writeContent('worker', TEST_HAND, 'verify');
  check(res2.ok, 'and the test hand', res2.error ?? '');
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
  // ...and out of build mode, which is the state a player is in by the time they
  // ever touch this machine. `fresh()` switches it on because placing needs it
  // and left it on because nothing cared — and then `notWhileBuilding` gave the
  // mode a meaning for every goods verb, so a sweep that stayed in it was
  // tapping an appliance from a state no shopkeeper can be in. The `fresh()`
  // trap in its usual form: not a field that is new, a field that newly matters.
  g.players.me.build = { on: false, tool: 'station' };
  return st;
}

// A recipe is only "made here" when the shop has both halves of production:
// the matching appliance and somebody assigned to manufacture. This distinction
// is what lets the ordering system use spare stockroom capacity in a shop with
// idle machinery or no chef.
{
  const g = fresh();
  urn(g);
  check(!g.makesHere('zz-kit-brew'),
    'an appliance with no chef does not reserve its output from the supplier');
  check(g.hire(TEST_WORKER.id).ok, 'a chef can be taken on for the production test');
  check(g.makesHere('zz-kit-brew'),
    'a staffed appliance marks its selected output as made here');
  g.roster[g.roster.length - 1].jobs = [{ job: 'shelve', weight: 1 }];
  check(!g.makesHere('zz-kit-brew'),
    'removing the manufacturing directive hands that output back to overstock');
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
  eq(lotTotal(g.players.me.carry), 1, 'and the unit is still in your hands, not gone');

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
  eq(lotTotal(g2.players.me.carry), 4, 'and hands the remainder back');

  // ...and the same out of a CRATE on the shoulder, which is the one hand this
  // funnel never learned about. `loadStation` read `p.carry` and nothing else,
  // so a machine you walked a box of beans over to armed no action, gave no
  // refusal and said nothing — and a machine that offers nothing is a machine
  // that reads as broken. The shelves have poured straight out of a crate since
  // hauling existed (`stockFromCrate`); this was the hole beside it.
  //
  // Both halves matter and only one of them is visible: the beans go in, AND
  // they come off the shoulder rather than being copied off it. A load that
  // filled the hopper and left the crate full is goods created out of nothing,
  // which looks exactly like a load that worked.
  const g3 = fresh();
  const st3 = urn(g3);
  g3.players.me.carry = null;
  g3.players.me.haul = { stacks: [{ item_id: 'zz-kit-bean', qty: 4 }] };
  const off = g3.loadStation('me', st3.id, { from: 'haul' });
  check(off.ok, 'a crate on the shoulder feeds the hopper', off.error ?? '');
  eq(st3.contents['zz-kit-bean'], 4, 'and the beans land in it');
  eq(lotTotal(g3.players.me.haul), 0, 'and leave the crate, rather than being copied out of it');
  eq(lotTotal(g3.players.me.carry), 0, 'without going through your hands on the way');
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
  eq(head(g, st).output?.item_id, 'zz-kit-brew', 'and what is in the tray is what it makes');
  eq(head(g, st).output?.qty, BREW_PER_BATCH * BATCHES,
    'four batches, not one — an appliance is not a slower shelf');
  eq(head(g, st).making, null, 'and it stops when there is nothing left to make');

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
  eq(head(g, st).output?.qty, BREW_PER_BATCH * BATCHES - cap, 'and the rest is still waiting');
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
  eq(head(g, st).output?.qty, trayCap, 'the tray fills to its ceiling');

  // Top it up with nobody collecting. It must refuse to start.
  hold(g, 'zz-kit-bean', BEAN_PER_BATCH * BATCHES);
  check(g.loadStation('me', st.id).ok, 'and it will still accept more ingredients');
  run(g, 60);
  eq(head(g, st).output?.qty, trayCap, 'but makes nothing more with nowhere to put it');
  eq(st.contents['zz-kit-bean'], BEAN_PER_BATCH * BATCHES,
    'and the ingredients are still in the hopper, not spent on a batch that fell on the floor');

  // Take the tray away and it picks straight back up. A machine that needed
  // emptying AND re-loading would be worse than the one this replaced.
  g.players.me.carry = null;
  while (head(g, st).output) {
    const res = g.collectStation('me', st.id);
    if (!res.ok) break;
    g.players.me.carry = null;
  }
  eq(head(g, st).output, null, 'the tray empties');
  run(g, 60);
  eq(head(g, st).output?.qty, trayCap, 'and it gets straight back to work on its own');
}

// ---------------------------------------------------------------------------
// 3b. A LOADER OBEYS THE CHEF'S GATE, BECAUSE THE STALL *IS* THE BRAKE.
//
// Section 3 above proves a full tray stops the machine. That stall is the ONLY
// thing bounding a kitchen: `nextBatch` asks for ingredients and tray room and
// has never asked whether the shop wants the output, so what actually decides
// how much a shop produces is the person who clears the tray — and a chef asks
// `hasHome` before doing it.
//
// Bolt a loader to the same machine and that person is gone. `armFeed` refills
// the hopper, `armTake` empties the tray, `nextBatch` fires again, forever. A
// live shop reached 200 units of toast in the yard against 16 on a shelf, which
// then filled the yard, took `bayRoom` to zero and stopped the shop being able
// to ORDER anything — three symptoms, none of them near the toaster, every
// conveyor working perfectly the whole time.
//
// Invisible by construction, twice: a machine stalled on a full tray and one
// between batches are the same still frame, and a loader that declined to swing
// and one with nothing to lift are the same idle arm.
//
// Both halves or neither. "It refuses" is satisfied by a loader that never
// lifts anything, which turns the feature off; "it lifts" is satisfied by the
// bug. So the control comes first and they are the same shop, one crate apart.
// ---------------------------------------------------------------------------

/**
 * A loader standing anywhere legal. It is handed to `armTake` directly rather
 * than driven through a run, because the claim is about the GATE and not about
 * the belt — `loadBelt` answers false harmlessly with no run under it, and the
 * tray is emptied or it is not either way. `verify:belts` owns the carrying.
 */
function loader(g) {
  // Scanned through `canPlace` rather than `spotFor`, which gates on WALKABLE
  // first and so skips every cell a loader is actually allowed on — it answered
  // null, the placement went out with `x: undefined`, and what that looked like
  // was `armTake` crashing on a null arm.
  // Build mode again: placing the urn COMMITS it, so by the time this runs the
  // mode `fresh` armed is off and the placement comes back "not in build mode"
  // — which arrives as `armTake` crashing on a null arm two lines later.
  g.players.me.build = { on: true, tool: 'arm' };
  const L = g.layout;
  let at = null;
  for (let z = 1; z < L.h - 1 && !at; z++) {
    for (let x = 1; x < L.w - 1 && !at; x++) {
      for (const rot of [0, 1, 2, 3]) {
        if (canPlace(L, { kind: 'arm', x, z, rot }).ok) { at = { x, z, rot }; break; }
      }
    }
  }
  check(!!at, 'there is somewhere to stand a loader');
  if (!at) return null;
  const res = g.placeFixture('me', { kind: 'arm', ...at });
  check(res.ok, 'the loader goes down', res.error ?? '');
  const arm = (g.layout.arms ?? []).find((a) => a.id === res.placed) ?? null;
  check(!!arm, 'and it is standing there as a loader');
  return arm;
}

/** An urn with a full tray, which is section 3's setup as a helper. */
function fullTray(g) {
  const st = urn(g);
  hold(g, 'zz-kit-bean', BEAN_PER_BATCH * BATCHES);
  check(g.loadStation('me', st.id).ok, 'the hopper takes four batches');
  run(g, 60);
  g.players.me.carry = null;
  eq(head(g, st).output?.qty, BREW_PER_BATCH * BATCHES, 'PRECONDITION: the tray is full');
  return st;
}

// 3b-i. THE CONTROL. With somewhere for the brew to go, the loader lifts it.
{
  const g = fresh();
  const st = fullTray(g);
  const arm = loader(g);
  const before = brewMade(g, st);

  check(g.armTake(arm, st), 'a loader empties a tray the shop has room for');
  eq(head(g, st).output, null, '...and the tray is clear');
  eq(brewMade(g, st), before, '...with nothing created or destroyed on the way');
}

// 3b-ii. THE CENTREPIECE. A crate of it already waiting is `hasHome`'s first
// clause, and the loader must decline exactly as the chef would.
{
  const g = fresh();
  const st = fullTray(g);
  const arm = loader(g);
  // One case of brew standing in the shop. This is the same fact that stops a
  // CHEF starting another batch, so a loader that ignored it is the two halves
  // of one kitchen disagreeing about how much to make.
  const put = g.dropGoods('zz-kit-brew', 1, { x: arm.x, z: arm.z }, { exact: true });
  check(!!put, 'a case of the output is standing in the shop');
  const before = brewMade(g, st);

  check(!g.armTake(arm, st), 'a loader REFUSES a tray the shop has nowhere for');
  eq(head(g, st).output?.qty, BREW_PER_BATCH * BATCHES, '...so the tray stays full');
  run(g, 120);
  eq(head(g, st).output?.qty, BREW_PER_BATCH * BATCHES,
    '...and the machine stays stopped rather than making more');
  eq(brewMade(g, st), before, '...and nothing was created while it waited');
}

// 3b-iii. ...and it picks straight back up once the shop has room again, or the
// gate is a machine you can switch off once and never restart.
{
  const g = fresh();
  const st = fullTray(g);
  const arm = loader(g);
  const put = g.dropGoods('zz-kit-brew', 1, { x: arm.x, z: arm.z }, { exact: true });
  check(!g.armTake(arm, st), 'refused while a case is waiting');

  g.deliveries = g.deliveries.filter((d) => d.id !== put.id);
  check(g.armTake(arm, st), 'and lifts it the moment that case is gone');
}

// ---------------------------------------------------------------------------
// 4. A machine that knows two recipes makes the ONE it is set to.
//
// It used to run whichever recipe its hopper happened to satisfy, which is a
// machine nobody is driving: a jar left over from yesterday and the blender you
// loaded for salsa makes smoothies. The choice is the player's now, and every
// claim here is about it being obeyed rather than approximated.
//
// It is also still the conservation count it was written as. The old loop
// checked "is the tray already holding something else" AFTER the timer ran out,
// so a station that could make two things spent ingredients on batches it then
// dropped — nothing logs that and nothing renders it; stock just goes missing.
// So everything loaded has to be in the hopper, in the tray, or in the ledger.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const st = urn(g);

  // Nobody has chosen, so it is on the first recipe it knows. That default is
  // the whole of what makes this safe for a shop that already exists: every
  // appliance standing in one was built before there was anything to choose.
  eq(g.stationRecipe(st)?.id, BREW, 'an appliance nobody has set is on its first recipe');

  hold(g, 'zz-kit-bean', BEAN_PER_BATCH * BATCHES);
  check(g.loadStation('me', st.id).ok, 'beans go in');
  g.players.me.carry = null;

  // The door refuses the other recipe's ingredients, and refuses them with the
  // armful intact. A machine that swallowed them would be holding stock it can
  // never use, recoverable only by tipping the whole thing out.
  hold(g, 'zz-kit-leaf', BATCHES);
  const wrong = g.loadStation('me', st.id);
  check(!wrong.ok, 'and leaves are refused by a machine set to brew', JSON.stringify(wrong));
  eq(lotTotal(g.players.me.carry), BATCHES, 'with the armful still in your hands');
  eq(st.contents['zz-kit-leaf'], undefined, 'and nothing of them in the hopper');
  eq(g.stationHopperCap(st, 'zz-kit-leaf'), 0,
    'the hopper has no room for an ingredient this recipe does not call for');

  // Put them in behind the door's back. The claim is about `nextBatch`, not
  // about `loadStation` — a machine that ran what it found would still make tea
  // out of leaves that got in some other way, and a re-flow or a content edit is
  // exactly such a way.
  st.contents['zz-kit-leaf'] = BATCHES;
  g.players.me.carry = null;

  const collected = { 'zz-kit-brew': 0, 'zz-kit-tea': 0 };
  for (let i = 0; i < 120; i++) {
    run(g, 1);
    if (head(g, st).output) {
      const res = g.collectStation('me', st.id);
      if (res.ok) collected[res.item_id] += res.collected;
      g.players.me.carry = null;
    }
  }

  const beansLeft = st.contents['zz-kit-bean'] ?? 0;
  const inFlight = head(g, st).making ? content_inputs(head(g, st).making) : { bean: 0, leaf: 0 };
  const brewMade = collected['zz-kit-brew'] + (head(g, st).output?.item_id === 'zz-kit-brew' ? head(g, st).output.qty : 0);
  const teaMade = collected['zz-kit-tea'] + (head(g, st).output?.item_id === 'zz-kit-tea' ? head(g, st).output.qty : 0);

  eq(brewMade / BREW_PER_BATCH * BEAN_PER_BATCH + beansLeft + inFlight.bean, BEAN_PER_BATCH * BATCHES,
    'every bean is accounted for — in the tray, in the hopper, or in the batch running');
  eq(teaMade, 0, 'it never makes the recipe it is not set to');
  eq(st.contents['zz-kit-leaf'], BATCHES,
    'and leaves it holds for that recipe untouched rather than spending them');
  check(brewMade > 0, 'while making the one it is set to', `brew ${brewMade}`);

  // Say the word and it switches — and the leaves it was sitting on become the
  // thing it is working through. Nothing was destroyed by the wait.
  const set = g.setStationRecipe('me', st.id, TEA);
  check(set.ok, 'it can be set to the other recipe', set.error ?? '');
  eq(g.stationRecipe(st)?.id, TEA, 'and says so');
  g.players.me.carry = null;
  for (let i = 0; i < 60; i++) {
    run(g, 1);
    if (head(g, st).output) { g.collectStation('me', st.id); g.players.me.carry = null; }
  }
  eq(st.contents['zz-kit-leaf'], undefined, 'the leaves it was holding get made');
  eq(g.stationHopperCap(st, 'zz-kit-leaf'), BATCHES,
    'and the hopper is now sized for THAT recipe instead');

  // A recipe on another machine is not a choice this one has.
  const nope = g.setStationRecipe('me', st.id, 'latte-recipe');
  check(!nope.ok, 'and it cannot be set to a recipe it does not know', JSON.stringify(nope));
}

// ---------------------------------------------------------------------------
// 4b. The choice survives the two things that quietly undo a decision.
//
// A re-flow (buying any fixture triggers one) and a restart. `dev:server` runs
// under `node --watch`, so every edit to `server/` is a restart — a choice that
// only lived on the layout record would hand the kitchen back to its first
// recipe several times an hour, and the tell is a machine that has silently
// gone back to making the wrong thing.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const st = urn(g);
  check(g.setStationRecipe('me', st.id, TEA).ok, 'a machine is set to its second recipe');

  g.regenerateLayout();
  const after = g.layout.stations.find((s) => s.id === st.id);
  check(!!after, 'the appliance survives a re-flow');
  eq(g.stationRecipe(after)?.id, TEA, 'and is still set to what you set it to');

  // The save, and back off it. `saveState` is exactly what `persist` writes and
  // what a cold start reads, so going through it is the whole round trip.
  const rows = g.saveState().hoppers ?? [];
  eq(rows.find((r) => r.id === st.id)?.recipes?.[0], TEA, 'the save carries the choice');

  const back = fresh();
  const stBack = urn(back);
  // The old single-field row, on purpose: a save written before a machine could
  // have two heads is what somebody is mid-game in, and it has to fold into head
  // 0 rather than be refused.
  back.restoreContents([], [], [{ id: stBack.id, recipe: TEA }]);
  eq(back.stationRecipe(stBack)?.id, TEA, 'and a shop read back off it is still set to it');

  // A choice pointing at a recipe somebody has since deleted is a Tuesday
  // afternoon in a game whose content is live-editable, not a corrupt save.
  head(back, stBack).recipe = 'zz-kit-recipe-that-went-away';
  eq(back.stationRecipe(stBack)?.id, BREW,
    'and a choice whose recipe was deleted falls back rather than breaking');
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
  eq(head(g2, large).output?.qty, BREW_PER_BATCH * BATCHES * URN_TIER2_MULT,
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
    peak = Math.max(peak, (st.contents['zz-kit-bean'] ?? 0) + lotTotal(chef.carry));
  }
  check(peak > BEAN_PER_BATCH,
    'the chef fetches more than one batch at a time out of the stockroom',
    `peak ${peak}, one batch is ${BEAN_PER_BATCH}`);
  check(peak >= Math.min(cap, g.carryCapacity()),
    'and carries as much as their hands hold toward filling it',
    `peak ${peak}, hands hold ${g.carryCapacity()}`);
  check(brewMade(g, st) > BREW_PER_BATCH,
    'and the machine gets through more than one batch while they do it',
    `tray ${head(g, st).output?.qty ?? 0}, all told ${brewMade(g, st)}`);

  // Nobody is wedged. A chef holding something the machine has no room for used
  // to walk back to it forever; the job has to hand that armful to `shelve`.
  check(!lotHas(chef.carry, 'zz-kit-bean') || g.stationHopperRoom(st, 'zz-kit-bean') > 0,
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
  const made = brewMade(g, st);
  check(made > 0, 'a kitchen with nowhere to stockpile still makes things', `made ${made}`);
  check(shelf.stacks[0].qty > 30,
    'and the shop floor is borrowed from a batch at a time rather than stripped',
    `${shelf.stacks[0].qty} left of 60`);
}

// ---------------------------------------------------------------------------
// 8. A kitchen with nowhere to put the result stops, rather than piling it up.
//
// The regression that shipped: emptying a full tray was allowed *because* it
// was stopping the machine, so the crate at the drop-off was what let the next
// batch start. A shop with every board spoken for therefore made its crafted
// goods for ever and stacked them at the yard, six at a time, and the only
// symptom is a pile — which reads as a delivery problem, or as a stocker who
// has stopped working, rather than as the kitchen deciding to run.
//
// Both halves are asserted, and the second is the one that keeps this honest:
// "it stopped" is trivially satisfiable by a kitchen that never runs at all.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const st = urn(g);

  // Every board in the shop spoken for by something else, which is what a shop
  // looks like once its range is settled — a crafted good is never `assigned`
  // to anything, so this is the ordinary state that used to build the pile.
  for (const sh of g.layout.shelves) sh.assigned = ['zz-kit-bean'];
  const shelf = g.layout.shelves[0];
  shelf.boh = true;
  shelf.stacks = [{ item_id: 'zz-kit-bean', qty: 60, price: 2, stockedDay: g.day }];

  // The player fills the hopper once, by hand. Nothing after this line is the
  // player: everything that happens next is somebody the shop employs deciding
  // it was worth doing.
  hold(g, 'zz-kit-bean', BEAN_PER_BATCH * BATCHES);
  check(g.loadStation('me', st.id).ok, 'the player fills the hopper by hand');
  g.players.me.carry = null;

  check(g.hire(TEST_HAND.id).ok, 'a hand who can craft, shelve and tidy is taken on');
  g.step(0.1);
  const hand = g.players[`staff-${g.roster[0].id}`];
  check(!!hand, 'and turns up for work');

  run(g, 200);

  const crated = g.deliveries
    .filter((d) => d.item_id === 'zz-kit-brew')
    .reduce((n, d) => n + (d.qty ?? 0), 0);
  eq(crated, 0, 'nothing it makes is ever walked out to the drop-off');
  eq(head(g, st).output?.qty, BREW_PER_BATCH * BATCHES,
    'the hopper it was given runs down and waits on the tray, where it was made');
  eq(shelf.stacks[0].qty, 60,
    'and the stockroom is untouched — nobody fetched a second load for goods with nowhere to go');

  // The other half. Free one board and the shop has somewhere for it again, so
  // the tray comes out and the machine goes back on. Without this the section
  // passes on a kitchen that has simply been switched off.
  shelf.assigned = ['zz-kit-brew'];
  shelf.stacks = [];
  run(g, 200);

  const onShelf = g.shelfStack(shelf, 'zz-kit-brew')?.qty ?? 0;
  const inHand = lotQty(hand.carry, 'zz-kit-brew');
  check(onShelf + inHand > 0,
    'give it a board and the tray comes out to fill it',
    `shelf ${onShelf}, hands ${inHand}, tray ${head(g, st).output?.qty ?? 0}`);
}

// ---------------------------------------------------------------------------
// 9. A tap is ONE, a hold is the lot, and a machine grades in both directions.
//
// The grade every goods gesture in the shop draws, said about an appliance —
// which is the one fixture with an opening at each end, and had neither.
//
// Going IN: a right-tap sent `shelf-one`, so the shop answered **"no such
// shelf"** — an error naming a thing you were not pointing at, about a gesture
// that works one press either side of it. The hold poured the armful throughout,
// which is what made it read as feeding being all-or-nothing rather than as a
// hole. Same shape the skip left when it fell through that branch.
//
// Coming OUT: a machine with a batch ready is `readyToTake`, so a left tap sent
// you to *walk* to it — and standing there, that walk is a no-op. A full tray, a
// press that visibly did nothing, and the goods only moving once you found the
// hold.
//
// None of it is visible in a screenshot: a tray of twelve and a tray of eleven
// are the same picture, and a press that did nothing looks exactly like a press
// you have not made yet.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const st = urn(g);

  // ---- in ----
  hold(g, 'zz-kit-bean', 6);
  const one = g.tapStation('me', st.id, true);
  check(one.ok, 'a tap on an appliance loads it', one.error ?? '');
  eq(one.loaded, 1, 'with exactly one unit');
  eq(st.contents['zz-kit-bean'], 1, 'which is what lands in the hopper');
  eq(lotTotal(g.players.me.carry), 5, 'and the rest stays in your hands');

  // The errand is spent, or the press that armed the pour is still standing and
  // the next machine you walk past takes your armful.
  eq(g.players.me.errand, null, 'and the tap spends the errand it fired');

  // ...and the hold is untouched: the same hands, the same machine, the lot.
  const rest = g.loadStation('me', st.id);
  check(rest.ok, 'and a hold still pours the whole armful in', rest.error ?? '');
  eq(rest.loaded, 5, 'all of it');
  eq(g.players.me.carry, null, 'leaving your hands empty');

  // ---- out ----
  run(g, 30);
  const made = head(g, st).output?.qty ?? 0;
  check(made > 1, 'the machine makes a tray worth grading', `tray ${made}`);

  const took = g.tapStation('me', st.id);
  check(took.ok, 'a tap on a ready machine collects', took.error ?? '');
  eq(took.collected, 1, 'one portion off the tray');
  eq(head(g, st).output?.qty, made - 1, 'and the rest is still in the tray');
  eq(lotTotal(g.players.me.carry), 1, 'with one in your hands');
  eq(g.players.me.errand, null, 'and this tap spends its errand too');

  // The hold is the tray — capped by your hands, which is the one thing that
  // can make it less than the lot, and what does not fit stays in the tray
  // rather than going anywhere.
  const all = g.collectStation('me', st.id);
  check(all.ok, 'and a hold takes what is left', all.error ?? '');
  check(all.collected > 1, 'more than the tap did — the grade is real', `took ${all.collected}`);
  eq(lotTotal(g.players.me.carry), g.carryCapacity(g.players.me),
    'filling your hands to the brim');
  eq(all.collected + 1 + (head(g, st).output?.qty ?? 0), made,
    'and every portion is either in your hands or still in the tray');

  // Empty-handed, the hold clears it outright — which is the press that actually
  // frees the machine, since a tray with anything in it blocks the next batch.
  g.players.me.carry = null;
  check(g.collectStation('me', st.id).ok, 'and empty hands take the rest');
  eq(head(g, st).output, null, 'leaving the tray empty and the machine free');

  // ---- and the two do not fight ----
  // A tray waiting used to take the right button away outright: `actionAt` read
  // the output first, so a ring wound on the button that means "put this in" and
  // collected instead. A machine you cannot feed until you have emptied it is
  // not a rule anybody wrote — and with a chef stood at a full tray it is a
  // kitchen that quietly stops.
  hold(g, 'zz-kit-bean', 2);
  g.loadStation('me', st.id);
  run(g, 30);
  check((head(g, st).output?.qty ?? 0) > 0, 'the machine has a tray ready again');

  hold(g, 'zz-kit-bean', 4);
  g.aimAt('me', st.id);
  check(!!g.players.me.errand?.put, 'the right press says which direction it means');
  const armed = g.errandAction(g.players.me);
  eq(armed?.kind, 'load', 'so the ring loads rather than collecting, tray and all');

  // ...and the left press still means the other thing, from the same spot.
  g.walkToFixture('me', st.id);
  eq(g.errandAction(g.players.me)?.kind, 'collect', 'while the left press collects');

  // ---- a refusal is still a refusal ----
  // One funnel, one rule: a tap that bypassed the recipe check would fill a
  // hopper with ingredients that can only come out by tipping it up.
  const g2 = fresh();
  const st2 = urn(g2);
  check(g2.setStationRecipe('me', st2.id, TEA).ok, 'a machine is set to its second recipe');
  hold(g2, 'zz-kit-bean', 6);
  const wrong = g2.tapStation('me', st2.id, true);
  check(!wrong.ok, 'a tap of the wrong ingredient is refused', JSON.stringify(wrong));
  eq(lotTotal(g2.players.me.carry), 6, 'and nothing leaves your hands');

  // And a tap from across the shop is refused rather than reaching: the walk is
  // what the tap does out there, and `collectStation` makes no reach test of its
  // own — every caller it had was already standing there.
  const away = { x: g2.players.me.x, z: g2.players.me.z };
  Object.assign(g2.players.me, { x: 1, z: 1 });
  check(!g2.tapStation('me', st2.id, true).ok, 'and a tap from across the shop reaches nothing');
  Object.assign(g2.players.me, away);
}

// ---------------------------------------------------------------------------
// 10. A rung buys a HEAD, and a machine that never bought one has not moved.
//
// Everything above this line is a machine with one head, and every one of those
// assertions is the control: they are written as they were written when singular
// was the feature, and they still pass. What is left to say is what a second
// head does — and the loudest claim in here is the first one, because it is the
// one that decides whether this is opt-in or a change to every save in
// existence.
//
// The rest is invisible twice over. Two heads running and one head running twice
// as fast make the same amount of the same thing; a chef who serviced one tray
// and a chef who serviced both walk the same route. What separates them is a
// number in a tray you were not there to watch fill.
// ---------------------------------------------------------------------------
{
  // ---- the control ----
  const g = fresh();
  const single = urn(g, 2);
  eq(g.stationLines(single), 1, 'a rung that says nothing about heads is one head');
  eq(g.stationSlots(single).length, 1, 'and the machine has exactly the one');
  const two = g.setStationRecipes('me', single.id, [BREW, TEA]);
  check(!two.ok, 'a one-headed machine refuses a second recipe', JSON.stringify(two));
  eq(g.stationRecipe(single)?.id, BREW, 'and is still on the one it was on');
  eq(g.stationHopperCap(single, 'zz-kit-bean'), BEAN_PER_BATCH * BATCHES * URN_TIER2_MULT,
    'its hopper is sized to that one recipe, exactly as it always was');
  eq(g.stationHopperCap(single, 'zz-kit-leaf'), 0,
    'and it has no room at all for what the other recipe wants');
}

{
  // ---- two heads, ONE bin ----
  // Its own shop, because `urn` leaves build mode the way a player leaves it —
  // off — and a second machine stood in the same one would be refused.
  const g = fresh();
  const twin = urn(g, URN_TWIN);
  eq(g.stationLines(twin), 2, 'a Twin rung buys a second head');
  eq(g.stationSlots(twin).length, 2, 'and the machine grows one');
  eq(g.stationRecipe(twin)?.id, BREW, 'the first head is still on the first recipe it knows');
  eq(g.stationRecipes(twin)[1], null,
    'and the second is idle rather than quietly running the same thing twice');

  const set = g.setStationRecipes('me', twin.id, [BREW, TEA]);
  check(set.ok, 'both heads can be set in one press', set.error ?? '');
  eq(g.stationRecipes(twin)[0]?.id, BREW, 'the first head keeps what it was on');
  eq(g.stationRecipes(twin)[1]?.id, TEA, 'and the second takes the new one');

  // The whole argument for one bin: the ceiling is the SUM, so a machine set to
  // two recipes takes what both of them want and you load it once.
  eq(g.stationHopperCap(twin, 'zz-kit-bean'), BEAN_PER_BATCH * BATCHES * URN_TIER2_MULT,
    'the hopper still holds a full run of the first head’s ingredient');
  eq(g.stationHopperCap(twin, 'zz-kit-leaf'), 1 * BATCHES * URN_TIER2_MULT,
    'and a full run of the second head’s, in the same bin');

  // ...and your hands go in once. `loadStation` takes the union, so an armful of
  // something only the second head wants is not "no use for that".
  // Two batches' worth between them and no more, so what comes out fits in one
  // pair of hands — the reach below is about two TRAYS, not about `carryCapacity`.
  g.players.me.carry = { stacks: [{ item_id: 'zz-kit-bean', qty: 2 }, { item_id: 'zz-kit-leaf', qty: 2 }] };
  const load = g.loadStation('me', twin.id);
  check(load.ok, 'one press loads for both heads', load.error ?? '');
  eq(twin.contents['zz-kit-bean'], 2, 'the beans go in');
  eq(twin.contents['zz-kit-leaf'], 2, 'and the leaves go in beside them');
  g.players.me.carry = null;

  // ---- both heads run, and both trays fill ----
  run(g, 40);
  const brewTray = g.stationSlots(twin).find((s) => s.output?.item_id === 'zz-kit-brew');
  const teaTray = g.stationSlots(twin).find((s) => s.output?.item_id === 'zz-kit-tea');
  check(!!brewTray, 'the first head made its own thing');
  check(!!teaTray, 'and the second made its own, at the same time');
  eq(brewTray?.output?.qty, BREW_PER_BATCH, 'every bean it was given became brew');
  eq(teaTray?.output?.qty, 2, 'and every leaf became tea');

  // Conservation, over a run long enough for both heads to work through and
  // stop. Two heads sharing one bin is a new place goods move between, and every
  // one of those in this game has been a hole.
  eq(twin.contents['zz-kit-bean'], undefined, 'the hopper is empty of beans');
  eq(twin.contents['zz-kit-leaf'], undefined, 'and empty of leaves');

  // ---- the trays come off together, and a tap takes ONE ----
  const tap = g.collectStation('me', twin.id, { max: 1 });
  check(tap.ok, 'a tap takes off a twin machine', tap.error ?? '');
  eq(tap.collected, 1, 'and takes exactly one');
  const all = g.collectStation('me', twin.id);
  check(all.ok, 'and a hold takes the rest', all.error ?? '');
  check(all.goods.length === 2, 'off BOTH trays in one reach', JSON.stringify(all.goods));
  check(g.stationSlots(twin).every((s) => !s.output), 'leaving the machine free at both heads');
  eq(lotQty(g.players.me.carry, 'zz-kit-brew') + lotQty(g.players.me.carry, 'zz-kit-tea'),
    BREW_PER_BATCH + 2,
    'and every portion either side of the reach is in your hands');
  g.players.me.carry = null;
}

{
  // ---- the tie-break is HEAD ORDER, and never a draw ----
  //
  // Two heads wanting the last bean is the one thing a shared bin makes possible
  // that a machine has never had to answer before. Settled by order, so nothing
  // random happens — a draw here would move the rng stream and two `simulate`
  // runs either side of buying a Twin rung would diverge with nothing in the
  // output to say why.
  const g = fresh();
  const st = urn(g, URN_TWIN);
  check(g.setStationRecipes('me', st.id, [BREW, MOCHA]).ok, 'both heads want the same ingredient');

  // Exactly one batch's worth, in the bin they share. Both heads could start.
  //
  // Asserted on the TRAY rather than on `making`, which is a state that lasts a
  // minute of in-game time and is therefore a stopwatch race with the sweep's
  // own step loop — the same trap `verify:break` names about a charge that ran
  // out. What went in is a fact that stays put.
  st.contents['zz-kit-bean'] = BEAN_PER_BATCH;
  run(g, 30);
  eq(g.stationSlots(st)[0].output?.item_id, 'zz-kit-brew', 'the first head takes it');
  eq(g.stationSlots(st)[1].output, null, 'and the second waits rather than splitting it');
  eq(st.contents['zz-kit-bean'], undefined, 'one batch went in, not two');

  // ...and the one that waited is not stuck. Order is only ever a tie-break, so
  // block the first head — a full tray of its own product, which is the ceiling
  // that keeps "one product at a time" true — and the beans go to the second.
  // Without this the first head wins every time and the second is a head you
  // paid for that never runs, which is a rung that takes money and does nothing.
  g.stationSlots(st)[0].output = {
    item_id: 'zz-kit-brew', qty: BREW_PER_BATCH * g.stationBatches(st),
  };
  st.contents['zz-kit-bean'] = BEAN_PER_BATCH;
  run(g, 30);
  const mocha = g.stationSlots(st).find((s) => s.output?.item_id === 'zz-kit-mocha');
  check(!!mocha, 'the second head runs when the first has nowhere to put anything');
}

{
  // ---- the way back down, before any money moves ----
  //
  // A ladder that goes up and not down is a rung bought by mistake you cannot
  // undo, and a step down that quietly binned whatever was on the head it took
  // away would be the same bug the tray ceiling exists to stop, arriving through
  // the tier menu.
  const g = fresh();
  const st = urn(g, URN_TWIN);
  check(g.setStationRecipes('me', st.id, [BREW, TEA]).ok, 'a twin is set to two things');

  // A tier step is a build verb, so the mode has to be on — `urn` leaves it off
  // because that is the state a player touches a machine in. Without this the
  // refusal below lands for "not in build mode", which is a pass for the wrong
  // reason and would keep passing however the head rule was broken.
  g.players.me.build = { on: true, tool: 'station' };
  const cash = g.cash;
  const down = g.downgradeFixture('me', st.id);
  check(!down.ok, 'stepping back to one head is refused while two are set', JSON.stringify(down));
  check(/Test Tea/.test(down.error ?? ''), 'and the refusal names what it would lose', down.error ?? '');
  eq(g.cash, cash, 'and nothing was charged or refunded on the way');
  eq(g.stationSlots(st).length, 2, 'the machine still has both heads');

  // Take the second head off it and the step goes through — and what is left is
  // the machine the first nine sections are about. Re-found by id rather than
  // reused, because a tier step goes through `repositionFixture`, which re-mints
  // what it touches: the record in hand is the one from before the step, and
  // asking IT is asking the machine you no longer have.
  check(g.setStationRecipes('me', st.id, [BREW]).ok, 'the second head is cleared');
  const ok2 = g.downgradeFixture('me', st.id);
  check(ok2.ok, 'and now it steps down', ok2.error ?? '');
  const small = g.layout.stations.find((s) => s.id === ok2.downgraded);
  check(!!small, 'and it is still standing there');
  eq(g.stationLines(small), 1, 'to one head');
  eq(g.stationSlots(small).length, 1, 'with nothing left of the other');
  eq(g.stationRecipe(small)?.id, BREW, 'still making what it was making');
}

{
  // ---- and the choice survives the round trip, both heads of it ----
  const g = fresh();
  const st = urn(g, URN_TWIN);
  check(g.setStationRecipes('me', st.id, [BREW, TEA]).ok, 'a twin is set to two things');

  g.regenerateLayout();
  const after = g.layout.stations.find((s) => s.id === st.id);
  eq(g.stationRecipes(after)[0]?.id, BREW, 'a re-flow keeps the first head');
  eq(g.stationRecipes(after)[1]?.id, TEA, 'and the second');

  const rows = g.saveState().hoppers ?? [];
  const saved = rows.find((r) => r.id === st.id)?.recipes;
  check(Array.isArray(saved) && saved.length === 2, 'the save carries a head each', JSON.stringify(saved));

  const back = fresh();
  const stBack = urn(back, URN_TWIN);
  back.restoreContents([], [], [{ id: stBack.id, recipes: saved }]);
  eq(back.stationRecipes(stBack)[0]?.id, BREW, 'and both come back in the same order');
  eq(back.stationRecipes(stBack)[1]?.id, TEA, 'which is the order batches start in');
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\nverify:kitchen — ${failures.length} of ${checks} assertions FAILED\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\nverify:kitchen — ${checks} assertions\n`);
console.log('  ✅  an appliance holds four batches and works through them on its own.\n');
