#!/usr/bin/env node
/**
 * VERIFY: THE SHOP HAND TAKES GOODS BACK OFF A SHELF, AND THEY STAY OFF.
 *
 * Every staff job before this one pointed one way. `shelve` puts down what is
 * in hand, `tidy` crates what has nowhere to go, and stock left a board by
 * being bought, by spoiling, or by your own hands — never by a worker's. So a
 * board that stopped selling held its board for the rest of the save:
 * `releaseBoards` only ever looked at boards at *zero*, and a non-perishable
 * has no `shelf_life_days` for spoilage to take it with either.
 *
 * None of what follows is visible in a screenshot, and most of it is not
 * visible in play either — which is the whole reason this file exists.
 *
 * - **A dead board is cleared and a live one is not.** The two look identical
 *   in a still frame: stock on a shelf. The difference is a clock nothing draws.
 * - **The three vetoes hold.** A reservation, supply on its way, and the days.
 *   Each is a board that must NOT be touched, and a sweep that only asserts the
 *   clearing passes just as well with all three ignored.
 * - **The goods survive.** Conservation, the same claim `verify:build` makes:
 *   what came off the board is in a crate, to the unit.
 * - **…and it does not come straight back**, which is the one that decides
 *   whether the feature works at all. The crate the hand makes is an ordinary
 *   pallet: `unload` sees a board with room on it and `shelve` fills it, so
 *   without `giveUpBoard` the whole job is a loop that moves stock around a shop
 *   and changes nothing. It would look *busy*. That is the failure mode this
 *   file is really pointed at.
 * - **Giving up is the SHOP's judgement, not a rule about your hands.** Your own
 *   `stockShelf` still works, and ticking a shelf for it lifts the mark — which
 *   the log line promises out loud, so it has to be true.
 * - **A merge frees a board and conserves the stock**, and then does not
 *   un-merge. Clear and Merge both only ever reduce occupied boards, and the
 *   reason `merchandise` has no third verb is that a job whose verbs disagree
 *   oscillates for ever. That is a claim about a thing NOT happening over time,
 *   which is exactly what eyes are worst at.
 *
 * Runs on ephemeral Games, so it never touches the live shop. It writes one
 * worker row into the content database — usually the live shared one — and
 * removes it on exit, the same way `verify-catalog` and `verify-till` do.
 *
 *   node scripts/verify-hand.js
 */

import { Game } from '../server/sim/index.js';
import { content, writeContent } from '../server/content.js';
import { remove } from '../server/db.js';
import { lotStacks, lotTotal, lotQty, lotHas } from '../shared/lot.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SHOP = { shelf: 4, freezer: 0, checkout: 1, plot: 0 };

/**
 * A hand of this sweep's own: fast, tireless, and given exactly the jobs each
 * section is about.
 *
 * `carry` is deliberately large. A merge is refused unless the whole board fits
 * in one pair of hands — half a board in each of two places is the state the
 * verb exists to remove — so a shipped six-unit armful would decide which of
 * these assertions are reachable, and this file has no opinion about what a
 * worker should be able to hold.
 */
const TEST_WORKER = {
  id: 'verify-hand-worker', name: 'Test Hand', color: '#7a9e4b',
  jobs: [{ job: 'merchandise', weight: 1 }], cost: 0, wage: 0,
  speed: 20, pace: 0.05, carry: 60,
  tiers: [{ name: 'Standard', cost: 0 }],
};
process.on('exit', () => { try { remove('workers', TEST_WORKER.id); } catch { /* best effort */ } });
{
  const res = writeContent('worker', TEST_WORKER, 'verify');
  check(res.ok, 'the catalog accepts the test worker', res.error ?? '');
}

/** Two ordinary ambient items — nothing that needs a freezer. */
const c = content();
const AMBIENT = c.items.filter((it) => !it.tags.includes('frozen') && !it.tags.includes('needs-freezer'));
check(AMBIENT.length >= 2, 'the catalog has two ambient items to shelve', `${AMBIENT.length}`);
const [ITEM_A, ITEM_B] = AMBIENT;

/**
 * The same reset every other sweep makes, plus `orders`.
 *
 * `orders.auto` off is the one that matters here and is the newest trap of the
 * `fresh()` family: with staff ordering on, `restock` buys against every board
 * this file deliberately leaves thin, and `homeSupply` then counts the van —
 * which is a veto. Half these assertions would pass for the wrong reason, and
 * the other half would fail for one.
 *
 * `orders.dropped` has to be cleared for the same reason `verify-economy`
 * clears `ownedUpgrades`: it is state the live save can now carry that changes
 * what the code under test does.
 */
function fresh({ jobs = null } = {}) {
  const g = Game.create({ worldId: 'verify-hand', seed: 'hand', ephemeral: true });
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
  g.orders.auto = false;
  g.orders.assign = false;
  g.orders.items = {};
  g.orders.dropped = {};
  g.orders.pending = [];
  g.deliveries = [];
  g.cash = 50000;
  g.open = false;                     // nobody in the shop buying things out from under us
  g.addPlayer('me', 'Tester');
  if (jobs) {
    const res = g.hire(TEST_WORKER.id);
    check(res.ok, 'the hand joins', res.error ?? '');
    g.roster[g.roster.length - 1].jobs = jobs;
    g.step(0.1);                      // `hire` writes the roster; `syncStaff` puts the body in
  }
  return g;
}

/** Put stock on a board, with a clock of this sweep's choosing. */
function board(g, shelf, item, qty, { soldAgo = 0, stockedAgo = 0 } = {}) {
  const stack = {
    item_id: item.id, qty, price: 3,
    stockedDay: g.day - stockedAgo,
    soldDay: soldAgo === null ? undefined : g.day - soldAgo,
  };
  shelf.stacks = [...(shelf.stacks ?? []), stack];
  return stack;
}

/** Wind the clock on until `done`, or give up. */
function until(g, done, limit = 900) {
  for (let i = 0; i < limit; i++) {
    g.step(0.1);
    if (done()) return (i + 1) * 0.1;
  }
  return null;
}

const run = (g, ticks) => { for (let i = 0; i < ticks; i++) g.step(0.1); };

/** Every unit of an item anywhere in the shop: boards, crates, hands. */
function everywhere(g, itemId) {
  let n = 0;
  for (const sh of g.layout.shelves) n += g.shelfStack(sh, itemId)?.qty ?? 0;
  for (const d of g.deliveries) n += lotQty(d, itemId);
  for (const p of Object.values(g.players)) n += lotQty(p.carry, itemId) + lotQty(p.haul, itemId);
  return n;
}

/** The hired body, by whatever id the roster minted for it. */
const hand = (g) => g.players[`staff-${g.roster[g.roster.length - 1]?.id}`];

/** How many boards in the whole shop are spoken for. */
const boardsUsed = (g) => g.layout.shelves.reduce((n, sh) => n + g.shelfStacks(sh).length, 0);

const onAShelf = (g, itemId) => g.layout.shelves.some((sh) => (g.shelfStack(sh, itemId)?.qty ?? 0) > 0);

// ---------------------------------------------------------------------------
// 1. What counts as dead — the rule, with nobody walking anywhere.
//
// `staleBoards` before the job, because a sweep that only ever asserts through
// a worker cannot tell "the rule is wrong" from "the walk failed", and three of
// the four claims here are about a board the hand must NOT touch.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const [s0, s1, s2, s3] = g.layout.shelves;

  board(g, s0, ITEM_A, 5, { soldAgo: 9 });     // dead
  board(g, s1, ITEM_A, 5, { soldAgo: 1 });     // sold yesterday
  board(g, s2, ITEM_B, 5, { soldAgo: 9 });     // dead, but reserved
  s2.assigned = [ITEM_B.id];
  board(g, s3, ITEM_B, 5, { soldAgo: 9 });     // dead, but a crate is coming
  g.deliveries = [{ id: 'd-test', stacks: [{ item_id: ITEM_B.id, qty: 2 }], x: 3, z: 3 }];

  const stale = g.staleBoards();
  eq(stale.length, 1, 'exactly one board in a shop of four is dead');
  eq(stale[0]?.shelf.id, s0.id, 'and it is the one nothing has bought');
  check(stale[0]?.days >= 4, 'it is reported with how long it has been dead', `${stale[0]?.days}`);

  // Each of these passes trivially if the veto is missing AND the sweep only
  // asserted the positive case, which is why they are named separately.
  check(!stale.some((b) => b.shelf.id === s1.id), 'a board that sold recently is not dead');
  check(!stale.some((b) => b.shelf.id === s2.id), 'a board you ticked is never dead, however long it sits');
  check(!stale.some((b) => b.shelf.id === s3.id), 'a board with a crate on its way is waiting, not dead');

  // The default that decides the case this whole feature is for: an item that
  // was wrong from the moment it went out has no `soldDay` at all.
  const g2 = fresh();
  board(g2, g2.layout.shelves[0], ITEM_A, 5, { soldAgo: null, stockedAgo: 9 });
  eq(g2.staleBoards().length, 1, 'a board that has NEVER sold counts from the day it was filled');

  const g3 = fresh();
  board(g3, g3.layout.shelves[0], ITEM_A, 5, { soldAgo: null, stockedAgo: 1 });
  eq(g3.staleBoards().length, 0, '…and one filled yesterday is not dead yet');
}

// ---------------------------------------------------------------------------
// 2. A sale is what keeps a board alive, through the sim rather than by hand.
//
// The stamp is one line in `takeFromShelf`, and a stamp written in the wrong
// place — on `unshelve`, on a restock — is invisible: the board simply never
// goes stale, which reads as the feature not being finished.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const shelf = g.layout.shelves[0];
  const stack = board(g, shelf, ITEM_A, 20, { soldAgo: 9 });
  eq(g.staleBoards().length, 1, 'the board starts dead');

  g.open = true;
  g.spawnCustomer();
  const sold = until(g, () => stack.qty < 20, 3000);
  check(sold !== null, 'a shopper buys one off it', 'nobody bought anything');
  if (sold !== null) {
    eq(stack.soldDay, g.day, 'and the board is stamped with the day it sold');
    eq(g.staleBoards().length, 0, 'a board that just sold is not dead');
  }
}

// ---------------------------------------------------------------------------
// 3. Clearing: the goods survive, and the board comes back.
// ---------------------------------------------------------------------------
{
  const g = fresh({ jobs: [{ job: 'merchandise', weight: 1 }] });
  const shelf = g.layout.shelves[0];
  board(g, shelf, ITEM_A, 12, { soldAgo: 9 });
  const before = everywhere(g, ITEM_A.id);
  eq(before, 12, 'twelve units to start with');

  const done = until(g, () => !g.shelfStack(shelf, ITEM_A.id) && !hand(g)?.carry);
  check(done !== null, 'the hand clears the dead board', 'still on the shelf after 90s');
  eq(everywhere(g, ITEM_A.id), before, 'and not one unit is lost on the way');
  eq(g.deliveries.reduce((n, d) => n + lotQty(d, ITEM_A.id), 0), before,
    'all of it is in crates');
  eq(g.shelfStacks(shelf).length, 0, 'the board is free again');
  check(g.droppedItem(ITEM_A.id), 'and the shop has said it is not stocking that any more');
}

// ---------------------------------------------------------------------------
// 4. …and it does not come straight back. THE claim.
//
// Give the same worker the jobs that would undo it. Without `giveUpBoard` this
// is a shop where a crate is walked to a shelf and a shelf is walked to a crate,
// for ever — which from the outside looks like a hand doing its job.
// ---------------------------------------------------------------------------
{
  const jobs = [
    { job: 'merchandise', weight: 1 },
    { job: 'unload', weight: 1 },
    { job: 'shelve', weight: 1 },
  ];
  const g = fresh({ jobs });
  const shelf = g.layout.shelves[0];
  board(g, shelf, ITEM_A, 12, { soldAgo: 9 });

  until(g, () => g.droppedItem(ITEM_A.id));
  check(g.droppedItem(ITEM_A.id), 'the hand gives up on it');
  run(g, 1200);                              // two full in-game minutes of trying
  check(!onAShelf(g, ITEM_A.id), 'and nothing puts it back on a shelf', 'it came straight back');
  eq(everywhere(g, ITEM_A.id), 12, 'the stock is still all there, in a crate');

  // The two overrides, both of which already existed before this step.
  const byHand = g.stockShelf.bind(g);
  g.addPlayer('you', 'Hands');
  const you = g.players.you;
  you.x = shelf.browseAt?.x ?? shelf.x;
  you.z = shelf.browseAt?.z ?? shelf.z;
  you.carry = { stacks: [{ item_id: ITEM_A.id, qty: 2 }] };
  const mine = byHand('you', shelf.id);
  check(mine.ok, 'your own hands are unaffected — the shop gave up, you did not', mine.error ?? '');

  const tick = g.assignShelf('me', g.layout.shelves[1].id, ITEM_A.id, true);
  check(tick.ok, 'you can still set a shelf aside for it', tick.error ?? '');
  check(!g.droppedItem(ITEM_A.id),
    'and asking for it back is what lifts the mark — the log line promises exactly this');
}

// ---------------------------------------------------------------------------
// 5. Merging: one board fewer, the same stock, and it stays merged.
// ---------------------------------------------------------------------------
{
  const g = fresh({ jobs: [{ job: 'merchandise', weight: 1 }] });
  const [s0, s1] = g.layout.shelves;
  // Both fresh, so neither is DEAD — this section must exercise Merge and not
  // quietly re-test Clear.
  board(g, s0, ITEM_A, 10, { soldAgo: 0 });
  board(g, s1, ITEM_A, 3, { soldAgo: 0 });
  const before = everywhere(g, ITEM_A.id);
  eq(boardsUsed(g), 2, 'one item across two units, to start');

  // Empty hands as well as one board, and that is not belt-and-braces: the
  // source board is cleared the moment it is lifted, so `boardsUsed` hits 1
  // while the worker is still halfway across the shop holding all of it. The
  // first draft waited on the count alone and read the shop mid-walk.
  const done = until(g, () => boardsUsed(g) === 1 && !hand(g)?.carry);
  check(done !== null, 'the hand merges the split board', `still ${boardsUsed(g)} boards`);
  eq(everywhere(g, ITEM_A.id), before, 'and the stock is conserved, to the unit');
  check(!g.deliveries.length, 'a merge crates nothing — it is a walk between two shelves');

  // The reason there is no third verb. Both verbs only ever reduce occupied
  // boards, so a settled shop has to stay settled: a hand that then spread it
  // back out would be a hire shuffling boxes for the rest of the save, and
  // nothing on screen would say why.
  const settled = boardsUsed(g);
  run(g, 1200);
  eq(boardsUsed(g), settled, 'and it stays merged — the job has no verb that undoes it');
  eq(everywhere(g, ITEM_A.id), before, 'with the stock still conserved after two minutes of idling');
}

// ---------------------------------------------------------------------------
// 6. A reservation decides WHICH board survives a merge.
//
// The first draft of this asserted that a reserved board is never merged and
// failed, correctly: a reservation ranks first in `shelvesFor`, so a reserved
// shelf is always the merge TARGET and never the source. Which is the right
// behaviour and makes the veto invisible from that angle — so the claim has to
// be pointed at the case where the reserved board is the only source going.
//
// The small board is the reserved one here, so a hand that ignored the veto
// would take the path of least work — three units onto the ten — and leave the
// shop's whole holding on a shelf you had said nothing about, with the shelf
// you DID ask for sitting empty. One board either way; the difference is which,
// and nothing on screen would tell you it went the wrong way.
// ---------------------------------------------------------------------------
{
  const g = fresh({ jobs: [{ job: 'merchandise', weight: 1 }] });
  const [s0, s1] = g.layout.shelves;
  board(g, s0, ITEM_A, 3, { soldAgo: 0 });
  board(g, s1, ITEM_A, 10, { soldAgo: 0 });
  s0.assigned = [ITEM_A.id];

  const done = until(g, () => boardsUsed(g) === 1 && !hand(g)?.carry);
  check(done !== null, 'the split still merges', `still ${boardsUsed(g)} boards`);
  eq(g.shelfStack(s0, ITEM_A.id)?.qty, 13, 'and it all ends up on the shelf you set aside');
  eq(g.shelfStacks(s1).length, 0, 'the board you said nothing about is the one that goes');
}

// ---------------------------------------------------------------------------
// 7. "Leave that one alone" — the unit's own switch.
//
// Its own control rather than a side effect of a reservation, and the
// difference is the whole reason it exists: a reservation says what a board is
// FOR and happens to come with hands-off attached, which covers the shelf you
// had plans for and nothing else. Every unit you have said nothing about was
// fair game, and the only way to stop a worker touching one was to tick an item
// onto it that you did not actually want there.
//
// Both directions asserted, because a switch that cannot be turned back on is a
// shelf you have quietly retired.
// ---------------------------------------------------------------------------
{
  const g = fresh({ jobs: [{ job: 'merchandise', weight: 1 }] });
  const [s0, s1] = g.layout.shelves;
  board(g, s0, ITEM_A, 6, { soldAgo: 9 });       // dead, and locked
  const off = g.setShelfHands(s0.id, false);
  check(off.ok, 'a unit can be told to look after itself', off.error ?? '');

  eq(g.staleBoards().length, 0, 'a locked board is never dead, however long it sits');
  run(g, 900);
  eq(g.shelfStack(s0, ITEM_A.id)?.qty, 6, 'and nothing comes off it');
  check(!g.droppedItem(ITEM_A.id), 'nor does the shop give up on what is on it');

  // …and a merge may not walk stock ONTO a locked unit either. Same sentence:
  // a shelf you said to leave alone that quietly grew a board is a shelf the
  // hand rearranged.
  board(g, s1, ITEM_A, 3, { soldAgo: 0 });
  run(g, 900);
  eq(g.shelfStack(s0, ITEM_A.id)?.qty, 6, 'a locked unit is not a merge target');
  eq(g.shelfStack(s1, ITEM_A.id)?.qty, 3, 'and the other board is left where it is');

  // Back on, and the shelf is ordinary again.
  const on = g.setShelfHands(s0.id, true);
  check(on.ok, 'and told to look after itself again', on.error ?? '');
  const done = until(g, () => !g.shelfStack(s0, ITEM_A.id));
  check(done !== null, 'the hand clears it once it is allowed to', 'still there');
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\nverify:hand — ${failures.length} of ${checks} assertions FAILED\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\nverify:hand — ${checks} assertions\n`);
console.log('  ✅  a dead board is taken back, the goods survive, and they stay off.\n');
