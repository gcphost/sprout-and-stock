#!/usr/bin/env node
/**
 * VERIFY: GOODS OUTLIVE THE ROW THAT NAMED THEM, AND SOMETHING HAS TO COLLECT.
 *
 * Content is edited live. `delete_content` is one call, and the moment it
 * lands there can be cases of that item standing on a board, sitting in a
 * crate on the bay, held in somebody's hands, on a hire's shoulder, part-way
 * through a hopper, in a finished tray, and paid for on a van that has not
 * arrived yet. Every loop in the sim that touches stock opens by looking the
 * row up and skipping what it cannot find — which is individually correct in
 * all of them, and adds up to goods that can never be sold, shelved, spoiled
 * or shifted, holding a board and a bay cell for ever.
 *
 * **None of it is visible.** A crate whose item has gone renders as a crate
 * with nothing in it and its count still on the front, because `syncPallet`
 * has no model to draw — so the symptom points at the renderer and the cause
 * is a row somebody deleted in another window. Shop 2 collected 84 units of
 * two `verify` test items this way, on a nine-cell bay, and the tell was not
 * the crates at all: it was `bayRoom` reporting 6 out of 108 and the shop
 * quietly failing to order anything.
 *
 * Which is why this sweep is mostly about places rather than about behaviour.
 * There are six of them and they are six different shapes — a shelf's
 * `stacks`, a lot, two lots on a person, a hopper's plain object, a tray, and
 * a pending order — so the failure mode is not "the bin is wrong", it is "the
 * bin has never heard of shoulders", which passes every other assertion.
 *
 * The two claims that are NOT about places are the ones worth reading:
 *
 * - **A re-flow still forgives, and this still collects.** `applyPlacements`
 *   deliberately lets an unknown item ride, because a re-flow fires on every
 *   wall segment and a bin there would be instant and unrecoverable. Those two
 *   rules must not fight: the stock has to survive the re-flow and go at the
 *   roll. Assert both or the next person "unifies" them.
 *
 * - **A day is a day of grace.** Delete a row and put it back before midnight
 *   and nothing is lost, which is the whole reason the sweep hangs off the day
 *   roll rather than off the delete.
 *
 * Authors two item rows into whatever content database it is pointed at —
 * usually the live shared one — and removes them on exit, exactly the way
 * verify:catalog, verify:economy and verify:yard do.
 *
 *   node scripts/verify-orphans.js
 */

import { Game } from '../server/sim/index.js';
import { writeContent, refresh } from '../server/content.js';
import { remove } from '../server/db.js';
import { lotQty, lotTotal } from '../shared/lot.js';
import { MILESTONES } from '../server/sim/goals.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SHOP = { shelf: 6, freezer: 0, checkout: 1, plot: 0 };

/**
 * Two rows, and the second one is the point.
 *
 * DEAD is what gets deleted. LIVE is authored identically, never deleted, and
 * put in every single place DEAD is put — because a bin that took the whole
 * shelf, the whole crate and both hands would pass every assertion about DEAD
 * being gone. Nearly every way of getting this wrong destroys too much rather
 * than too little.
 *
 * `shelf-stable` on both, so nothing here can rot: `spoilStock` runs in the
 * same roll, and a sweep that could not tell binning from spoiling would be
 * asserting the wrong function.
 */
const DEAD = {
  id: 'zz-orphan-dead', name: 'Test Ghost', tags: ['pantry', 'shelf-stable'],
  base_cost: 1, base_price: 3, stack: 20,
  model: { parts: [{ shape: 'box', color: '#8a8a8a', pos: [0, 0.1, 0], scale: [0.2, 0.2, 0.2] }] },
};
const LIVE = {
  ...DEAD, id: 'zz-orphan-live', name: 'Test Keeper',
};

process.on('exit', () => {
  for (const r of [DEAD, LIVE]) { try { remove('items', r.id); } catch { /* best effort */ } }
});
for (const row of [DEAD, LIVE]) {
  const res = writeContent('item', row, 'verify');
  check(res.ok, `the catalog accepts ${row.id}`, res.error ?? '');
}

/**
 * Both write straight to the database and then `refresh()`, which is the room's
 * own 250ms tick said by hand. `content()` reloads on a version bump and
 * nothing here has a room to do it — without this the registry answers out of
 * a cache written before the delete, so every assertion below passes for the
 * wrong reason: the sweep finds the row, bins nothing, and reports that a live
 * item survived.
 */
const author = (row) => {
  const res = writeContent('item', row, 'verify');
  check(res.ok, `${row.id} is back in the catalog`, res.error ?? '');
  refresh();
};
const kill = (row) => {
  check(remove('items', row.id), `${row.id} is deleted from the catalog`);
  refresh();
};

function fresh() {
  const g = Game.create({ worldId: 'verify-orphans', seed: 'orphans', ephemeral: true });
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
  // Every rung marked passed. A milestone pays a free run of stock onto the
  // bay, which is goods this sweep did not put there and would then count.
  for (const m of MILESTONES) g.milestones.done.push(m.id);
  g.cash = 50000;
  // Shut, so the day this rolls over has nobody in it. The claims below are
  // about what a sweep at midnight does to stock standing still — a shopper
  // buying the live control mid-assertion is a failure with nothing wrong.
  g.open = false;
  g.addPlayer('me', 'Tester');
  return g;
}

/**
 * Six units of something, in all six places stock can be, plus the two
 * references that hold capacity without holding goods.
 *
 * Returns nothing and asserts nothing — every section reads the places back
 * for itself, because "where did it end up" is the question and a helper that
 * answered it would be the thing under test.
 */
function stash(g, id) {
  const shelf = g.layout.shelves[0];
  shelf.stacks = [...(shelf.stacks ?? []), { item_id: id, qty: 4, stockedDay: g.day }];
  shelf.assigned = [...(shelf.assigned ?? []), id];

  g.dropGoods(id, 5, { x: g.layout.bay.cells[0].x, z: g.layout.bay.cells[0].z });

  const p = g.players.me;
  p.carry = { stacks: [...(p.carry?.stacks ?? []), { item_id: id, qty: 2 }] };
  p.haul = { stacks: [...(p.haul?.stacks ?? []), { item_id: id, qty: 6 }] };

  // A station record rather than a built appliance. An appliance needs an
  // upgrade that sells it and a recipe to run, which is three content rows to
  // assert one `delete` on a plain object — and `binOrphans` walks
  // `layout.stations`, so what is under test is the walk.
  //
  // One machine per item, because a tray holds ONE thing: share it and the
  // second stash quietly overwrites the first, so the control ends up in the
  // tray the dead item was supposed to be in and the sweep asserts the bin
  // took something it never put there.
  (g.layout.stations ??= []).push({
    id: `zz-orphan-urn-${id}`,
    station: `zz-orphan-urn-${id}`,
    contents: { [id]: 3 },
    output: { item_id: id, qty: 7 },
    useAt: { x: g.layout.store.x + 1, z: g.layout.store.z + 1 },
  });

  g.orders.pending.push({ id: `ord-${id}`, item_id: id, qty: 9, cost: 0, placedDay: g.day, at: '10:00' });
}

/** How much of it the whole shop can find, everywhere at once. */
function everywhere(g, id) {
  let n = 0;
  for (const s of g.layout.shelves) n += g.shelfStack(s, id)?.qty ?? 0;
  for (const d of g.deliveries) n += lotQty(d, id);
  for (const p of Object.values(g.players)) n += lotQty(p.carry, id) + lotQty(p.haul, id);
  for (const st of g.layout.stations ?? []) {
    n += st.contents?.[id] ?? 0;
    if (st.output?.item_id === id) n += st.output.qty;
  }
  for (const o of g.orders.pending) if (o.item_id === id) n += o.qty;
  return n;
}

/** Everything one stash puts in: 4 + 5 + 2 + 6 + 3 + 7 + 9. */
const STASHED = 36;

const reserved = (g, id) => g.layout.shelves.some((s) => (s.assigned ?? []).includes(id));

/** Midnight, for real, through `step` — so the wiring is asserted and not just the method. */
function rollDay(g) {
  const was = g.day;
  g.time = 0.995;
  for (let i = 0; g.day === was && i < 400; i++) g.step(0.25);
  return g.day !== was;
}

const saidBinned = (g) => g.log.filter((l) => /^Binned /.test(l.msg));

// ---------------------------------------------------------------------------
// 1. A shop with nothing dead in it loses nothing.
//
// First, because it is the assertion that fails if the bin is too eager, and
// too eager is the expensive direction: this runs unattended at every roll of
// every shop in the world, and a `gone` predicate that answered yes to a live
// row would quietly empty everybody's shelves overnight.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  stash(g, LIVE.id);
  eq(everywhere(g, LIVE.id), STASHED, 'the stash puts 36 units in six places');

  check(rollDay(g), 'the clock rolls over midnight');
  eq(everywhere(g, LIVE.id), STASHED, 'and a day passing costs a live item nothing');
  check(reserved(g, LIVE.id), 'its reservation is still standing');
  eq(saidBinned(g).length, 0, 'and the shop says nothing about binning');
}

// ---------------------------------------------------------------------------
// 2. All six places, and the two references.
//
// One assertion per place rather than one on the total, because the total is
// what a bin that misses shoulders still nearly passes — and "nearly" in a
// sweep is a number nobody reads.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  stash(g, DEAD.id);
  stash(g, LIVE.id);
  const shelf = g.layout.shelves[0];
  const st = g.layout.stations.find((s) => s.id === `zz-orphan-urn-${DEAD.id}`);

  kill(DEAD);
  g.binOrphans();

  eq(g.shelfStack(shelf, DEAD.id), null, 'a board of it is cleared');
  check(!reserved(g, DEAD.id), 'and the reservation that was holding that board goes with it');
  eq(g.deliveries.reduce((n, d) => n + lotQty(d, DEAD.id), 0), 0, 'a crate of it in the yard is cleared');
  eq(lotQty(g.players.me.carry, DEAD.id), 0, 'an armful of it is cleared');
  eq(lotQty(g.players.me.haul, DEAD.id), 0, 'and so is a crate on the shoulder');
  eq(st.contents[DEAD.id], undefined, 'a hopper part-way through it is cleared');
  eq(st.output, null, 'and the finished tray with it');
  eq(g.orders.pending.filter((o) => o.item_id === DEAD.id).length, 0,
    'and the order still on the van is cancelled, or one lands again tomorrow');

  eq(everywhere(g, DEAD.id), 0, 'nothing of it is left anywhere in the shop');
  eq(everywhere(g, LIVE.id), STASHED, 'and the live item beside it in all six is untouched');

  const said = saidBinned(g);
  eq(said.length, 1, 'it is said once, not once per place');
  check(said[0]?.msg.includes(`${STASHED} units`), 'with the whole count', said[0]?.msg ?? 'nothing');
  check(said[0]?.msg.includes(DEAD.id), 'named by its id, since the name went with the row', said[0]?.msg ?? '');

  author(DEAD);
}

// ---------------------------------------------------------------------------
// 3. Pile by pile, never box by box.
//
// `spoilStock` learned this and the same trap is here: a mixed crate is three
// kinds in one container, and binning the box because one of them died takes
// the other two with it. That is a conservation hole dressed as the feature
// working, and it is invisible — a crate that lost a third of itself and a
// crate that lost all of itself are the same picture.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const at = { x: g.layout.bay.cells[0].x, z: g.layout.bay.cells[0].z };
  g.dropGoods(DEAD.id, 4, at);
  g.dropGoods(LIVE.id, 5, at);
  const crate = g.deliveries.find((d) => lotQty(d, DEAD.id) > 0);
  check(!!crate && lotQty(crate, LIVE.id) === 5, 'both kinds went into one box');

  kill(DEAD);
  g.binOrphans();

  check(g.deliveries.includes(crate), 'the box is still there');
  eq(lotQty(crate, DEAD.id), 0, 'with the dead pile out of it');
  eq(lotQty(crate, LIVE.id), 5, 'and the live pile beside it untouched');

  author(DEAD);
}

// ---------------------------------------------------------------------------
// ...and the other half of that rule: a box with nothing left in it goes.
//
// Its own shop rather than another crate in the one above, because
// `dropGoods` tops up any box within 2.2 tiles before opening a new one — a
// second pallet on the same pad merges into the first, and the assertion would
// be about a crate that was never made.
//
// This is the exact thing the whole feature was reported as: crates standing
// in the yard with nothing visible in them.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const solo = g.dropGoods(DEAD.id, 3, { x: g.layout.bay.cells[0].x, z: g.layout.bay.cells[0].z });
  check(!!solo && g.deliveries.length === 1, 'one box, holding nothing but the dead item');

  kill(DEAD);
  g.binOrphans();

  eq(g.deliveries.length, 0, 'a box with nothing left in it is taken away');
  eq(lotTotal(solo), 0, 'and there is nothing in it to take away twice');

  author(DEAD);
}

// ---------------------------------------------------------------------------
// 4. The bay comes back.
//
// The claim that actually cost money. `bayRoom` counts what is standing on the
// pad AND what is in flight, so dead stock throttles ordering from both ends —
// and `buyStock` refuses against it, which reads as the supplier having
// stopped rather than as a content edit.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const room = g.bayRoom();
  check(room > 0, 'a fresh shop has room at the bay', String(room));

  for (const c of g.layout.bay.cells) g.dropGoods(DEAD.id, g.crateCapacity(), c);
  g.orders.pending.push({ id: 'ord-dead', item_id: DEAD.id, qty: 5, cost: 0, placedDay: g.day, at: '10:00' });
  eq(g.bayRoom(), 0, 'and a yard full of it has none');

  kill(DEAD);
  g.binOrphans();
  eq(g.bayRoom(), room, 'clearing it hands the whole bay back');

  author(DEAD);
}

// ---------------------------------------------------------------------------
// 5. A re-flow still forgives. Both rules, together.
//
// `applyPlacements` keeps an unknown item on its board on purpose, and the
// note there says why: a re-flow fires on every wall segment, so binning at
// that clock would delete somebody's shop a frame after a content edit. This
// asserts the pair — survives the re-flow, goes at the roll — because either
// one alone reads as an argument for changing the other.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const shelf = g.layout.shelves[0];
  shelf.stacks = [{ item_id: DEAD.id, qty: 4, stockedDay: g.day }];

  kill(DEAD);
  // A purchase, which is the ordinary way a shop re-flows.
  g.placeFixture('me', { kind: 'shelf', x: g.layout.store.x + 1, z: g.layout.store.z + 1, rot: 0 });
  const after = g.layout.shelves.find((s) => s.id === shelf.id);
  eq(g.shelfStack(after, DEAD.id)?.qty, 4, 'a re-flow leaves stock whose row has gone exactly where it was');

  check(rollDay(g), 'the clock rolls over midnight');
  eq(g.shelfStack(g.layout.shelves.find((s) => s.id === shelf.id), DEAD.id), null,
    'and the roll is what clears it');

  author(DEAD);
}

// ---------------------------------------------------------------------------
// 6. A day of grace, which is the reason for the clock this hangs off.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const shelf = g.layout.shelves[0];
  shelf.stacks = [{ item_id: DEAD.id, qty: 4, stockedDay: g.day }];

  kill(DEAD);
  author(DEAD);
  g.binOrphans();
  eq(g.shelfStack(shelf, DEAD.id)?.qty, 4,
    'a row deleted and put back before midnight costs the shop nothing');
}

// ---------------------------------------------------------------------------
// 7. It moves no money.
//
// Spoilage bins without charging and prices what it took into `spoiledValue`.
// Half of that applies here and half cannot: pricing needs the row, and the
// row is the thing that has gone. So the assertion is that neither number
// moves — a bin that quietly refunded would make deleting an item a way to
// turn stock back into cash.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  stash(g, DEAD.id);
  const cash = g.cash;
  const spoiled = g.stats.spoiledValue;
  const spent = g.stats.spent;

  kill(DEAD);
  g.binOrphans();

  eq(g.cash, cash, 'binning it neither charges nor refunds');
  eq(g.stats.spoiledValue, spoiled, 'and it is not filed as spoilage, which it is not');
  eq(g.stats.spent, spent, 'nor billed a second time for goods already paid for');

  author(DEAD);
}

// ---------------------------------------------------------------------------

console.log(`\nverify:orphans — ${checks} assertions`);
if (failures.length) {
  console.error(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✅  goods whose row has gone are cleared at the roll, from all six places, and nothing else moves.\n');
