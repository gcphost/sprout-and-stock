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
 * - **…and a board YOU clear does not come back either.** Same loop, your hands:
 *   the board you cleared is bare and unlabelled, which is the best shelf in the
 *   shop as far as `shelvesFor` is concerned, so the next stocker walks the crate
 *   you just made straight back onto it. It only holds while nothing else is
 *   holding the item, which is the half that keeps consolidating two boards into
 *   one from retiring what is on them. Tipping the whole unit out says it board
 *   by board, and the reservation it deliberately keeps is what carves the
 *   exception — one item walks back on and the other does not.
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
import { MILESTONES } from '../server/sim/goals.js';

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
 * The longest-lived and the shortest-lived of them, for 4bb.
 *
 * That section is about a clock measured in DAYS, so it rolls ten of them — and
 * every ambient item in the shipped catalog rots (bread in 3, carrot in 8).
 * Written against `ITEM_A` the board simply spoiled away, and then `staleBoards`
 * was empty because there was no board, which is a pass. A sweep about one clock
 * has to not be quietly measuring the other.
 *
 * Picked by span rather than by id, because what rots is content somebody edits
 * on a Tuesday — the same argument `verify:yard` makes about seasons.
 */
const bySpan = AMBIENT.slice().sort((a, b) => (b.shelf_life_days ?? 0) - (a.shelf_life_days ?? 0));
const KEEPER = bySpan[0];
const PERISHABLE = bySpan[bySpan.length - 1];
check((KEEPER?.shelf_life_days ?? 0) > 12,
  'the catalog has something that keeps long enough to outlive a stale clock',
  `${KEEPER?.id} keeps ${KEEPER?.shelf_life_days}`);
check((PERISHABLE?.shelf_life_days ?? 0) > 0, 'and something that rots');

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
  // Every milestone marked as already passed, which is a third thing that can
  // put goods in the shop and the one nothing here switches off. Taking the
  // hand on is itself what earns "someone else to do it", so the setup for a
  // section is what triggers the gift — and it arrives as an ordinary van a
  // couple of shop-minutes later, carrying a crate of the item being counted.
  // Whether it lands inside a run is a question about how far people walked.
  for (const m of MILESTONES) g.milestones.done.push(m.id);
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
// 4b. …and giving up is a decision you can SEE, UNDO, and outlive.
//
// The half that was missing for as long as the job existed, and the one that
// cost a real save. The mark is shop-wide, compounding and was permanent, and
// nothing in the game could show it to you: `orders.dropped` rode in the
// snapshot from the day it was written and no line in `client/` ever read it,
// so the only trace was one log entry that scrolls. Shop 2 collected eight in a
// week — every crate of them stranded, `padRoom` at zero, and because the farm
// and the kitchen are gated on `padRoom` the whole crew went idle beside them.
//
// Three claims, none of which is visible in a screenshot: a still frame of a
// robot standing next to a crate is the same picture whether the shop has
// stopped stocking that line or the robot is simply between jobs.
// ---------------------------------------------------------------------------
{
  const g = fresh({ jobs: [{ job: 'merchandise', weight: 1 }] });
  const shelf = g.layout.shelves[0];
  board(g, shelf, ITEM_A, 12, { soldAgo: 9 });
  until(g, () => g.droppedItem(ITEM_A.id));
  check(g.droppedItem(ITEM_A.id), 'the hand gives up on it');

  // ON SCREEN. `notStocking` is the panel's whole source, and it is asserted
  // off `snapshot()` rather than off `orders.dropped` on purpose: the maps were
  // always there, and being in the save is exactly what this state already was
  // when nobody could see it.
  const listed = g.snapshot().orders.notStocking ?? [];
  const row = listed.find((d) => d.itemId === ITEM_A.id);
  check(!!row, 'and the supplier is handed a row saying so', JSON.stringify(listed));
  check(row?.left > 0, 'with how many days it has left, not just that it happened', String(row?.left));

  // UNDOABLE, by a control rather than by a side effect. Ticking a shelf and
  // shelving one by hand both lifted the mark before this and both are ways of
  // doing something else — a control used for its side effect is the shape of a
  // missing control.
  const back = g.stockAgain(ITEM_A.id);
  check(back.ok && back.resumed, 'one press puts it back on the list', back.error ?? '');
  check(!g.droppedItem(ITEM_A.id), 'and the shop is stocking it again');
  check(!(g.snapshot().orders.notStocking ?? []).some((d) => d.itemId === ITEM_A.id),
    'so the row is gone from the panel');
  // Pressing it twice is a race, not an error: the button is drawn off a
  // snapshot that can be a tick old, and the mark can lapse on its own underneath.
  check(g.stockAgain(ITEM_A.id).ok, 'pressing it again is harmless');
}

// ---------------------------------------------------------------------------
// 4bb. A day the shutters never went up does not age a board.
//
// `staleBoards` is "nothing sold in four days", which is a fair signal about an
// item right until the reason nothing sold is that the shop was shut. Then it
// is a signal about the PLAYER, and the shop draws the wrong conclusion from it
// four days running: the range retired item by item, the crates piling up in a
// yard nobody is selling out of, and the crew stood idle beside them because
// `shelvesFor` will not send them anywhere.
//
// It reads as a shop that argues with you. Turning something back on bought
// three days on a real save before the same clock retired the same board again.
//
// Nothing here is visible: a shut shop on day 1 and a shut shop on day 8 are
// the same screen, and the only difference is a stamp.
// ---------------------------------------------------------------------------
{
  const roll = (g, days) => {
    for (let d = 0; d < days; d++) { g.day++; g.onNewDay(); }
  };

  // Shut, and stays shut. `fresh()` already shuts the shop, and `tradedToday`
  // is what the day actually was — set true by `step` on any tick the doors are
  // open, which is a tick this never runs.
  {
    const g = fresh();
    const shelf = g.layout.shelves[0];
    board(g, shelf, KEEPER, 6, { soldAgo: 0 });
    g.tradedToday = false;
    eq(g.staleBoards().length, 0, 'a board that just sold is not stale');

    roll(g, 10);
    check(!!g.shelfStack(shelf, KEEPER.id), 'the board is still there ten days on',
      'it rotted, so everything below passes for the wrong reason');
    eq(g.staleBoards().length, 0,
      'and ten shut days later it still is not stale — the shutters are not evidence');
    check(!g.droppedItem(KEEPER.id), 'so the shop never gives up on it either');
  }

  // ...and the moment the doors open, the clock is a clock again. The failure
  // this guards is the opposite one and just as plausible: hold it too well and
  // `merchandise` never fires in any shop, which passes every assertion above
  // and quietly deletes the feature.
  {
    const g = fresh();
    const shelf = g.layout.shelves[0];
    board(g, shelf, KEEPER, 6, { soldAgo: 0 });
    for (let d = 0; d < 10; d++) { g.day++; g.tradedToday = true; g.onNewDay(); }
    check(!!g.shelfStack(shelf, KEEPER.id), 'the board survives ten trading days too');
    check(g.staleBoards().some((x) => x.stack.item_id === KEEPER.id),
      'ten TRADING days with no sale is exactly what the hand is for');
  }

  // The empty-board half of the same clock, which keeps its own counter rather
  // than reading a stamp — so holding the stamps would have missed it entirely.
  // Held, not reset: two quiet days already served still count when you reopen.
  {
    const g = fresh();
    const shelf = g.layout.shelves[0];
    board(g, shelf, ITEM_A, 0, { soldAgo: 0 });
    g.orders.pending = [];
    g.deliveries = [];
    roll(g, 6);
    check(!!g.shelfStack(shelf, ITEM_A.id),
      'an empty board is not handed back over shut days either');

    g.day++; g.tradedToday = true; g.onNewDay();
    g.day++; g.tradedToday = true; g.onNewDay();
    check(!g.shelfStack(shelf, ITEM_A.id),
      'and two open days is still two open days');
  }

  // Spoilage is deliberately NOT held. Food rots whether or not you opened, and
  // a shop that could stop the clock on its stock by shutting would make the
  // shutters the cheapest preservation in the game.
  if (PERISHABLE) {
    const g = fresh();
    const shelf = g.layout.shelves[0];
    board(g, shelf, PERISHABLE, 6, { soldAgo: 0 });
    roll(g, PERISHABLE.shelf_life_days * 4 + 4);
    eq(g.shelfStack(shelf, PERISHABLE.id), null,
      'a shut shop does not keep its perishables for ever');
  }
}

// ---------------------------------------------------------------------------
// 4bb2. …and the shop stops BUYING it, which is the half that cost real money.
//
// The mark is read by `shelvesFor`, which refuses a dropped item a shelf —
// larder or floor — before it asks anything else. For two steps the buying half
// had never been told: `pickItem` checks it, so a BARE board was safe, and the
// top-up path picks the emptiest pile already standing on the unit, which a
// given-up item still is on every other board it was on. So the vans kept
// coming, and every case of it landed somewhere nothing could ever shelve from.
//
// Found on a live save: six items given up over two days, the next morning's log
// ordering 9x Dried Pasta, 25x Liquorice and a Breakfast Cereal against all six,
// and the stranded pile going 33 units → 59 in a day. Not one symptom of it
// appears where the bug is — the yard fills, so `putDown` cannot stow and the
// crew stand about holding armfuls, which reads as the STAFF being broken.
//
// The control is the whole section, and it is the assertion that would have
// caught the over-correction: "nothing was ordered" passes just as well when
// restocking never ran at all.
// ---------------------------------------------------------------------------
{
  const g = fresh({ jobs: [{ job: 'restock', weight: 1 }] });
  g.orders.auto = true;
  // Two thin boards on two SEPARATE units, which is not tidiness: `restock`
  // orders for one pile per unit per pass — the emptiest homed one — so a
  // control sharing a shelf with the subject is starved by it rather than by
  // the rule under test, and would fail this section for the wrong reason.
  board(g, g.layout.shelves[0], ITEM_A, 1);
  board(g, g.layout.shelves[1], KEEPER, 1);
  check(g.dropItem(ITEM_A.id), 'the shop gives up on one of the two');

  const ordered = (id) => (g.orders.pending ?? []).some((o) => o.item_id === id)
    || g.deliveries.some((d) => lotQty(d, id) > 0);
  until(g, () => ordered(KEEPER.id));
  check(ordered(KEEPER.id), 'a van is still sent for the line it still stocks');
  check(!ordered(ITEM_A.id), '…and never for the one it gave up on');

  // …and the SAME board, unmarked, is bought for. Without this the assertion
  // above is satisfied by an item that was never orderable in the first place —
  // a passing negative that proves nothing, which is the failure mode a sweep
  // written for a specific bug is most prone to.
  const g1 = fresh({ jobs: [{ job: 'restock', weight: 1 }] });
  g1.orders.auto = true;
  board(g1, g1.layout.shelves[0], ITEM_A, 1);
  const bought = (id) => (g1.orders.pending ?? []).some((o) => o.item_id === id)
    || g1.deliveries.some((d) => lotQty(d, id) > 0);
  until(g1, () => bought(ITEM_A.id));
  check(bought(ITEM_A.id), 'the very same board is bought for when nobody gave up on it');

  // A RESERVATION OVERRULES, exactly as it does in `shelvesFor` — and the two
  // have to agree, or the shop refuses to buy for a board it would happily
  // shelve. Shop-wide (`keptFor`), because ticking a unit is you saying the
  // judgement was wrong and that cannot depend on which shelf is being asked.
  const g2 = fresh({ jobs: [{ job: 'restock', weight: 1 }] });
  g2.orders.auto = true;
  const sh2 = g2.layout.shelves[0];
  board(g2, sh2, ITEM_A, 1);
  check(g2.dropItem(ITEM_A.id), 'the shop gives up on it here too');
  sh2.assigned = [ITEM_A.id];
  const got = (id) => (g2.orders.pending ?? []).some((o) => o.item_id === id)
    || g2.deliveries.some((d) => lotQty(d, id) > 0);
  until(g2, () => got(ITEM_A.id));
  check(got(ITEM_A.id), 'but a board you ticked for it is bought for anyway');
}

// ---------------------------------------------------------------------------
// 4c. It LAPSES, including on a save written while it did not.
//
// Forever was argued from the crate — the goods are on a pad, so a mark that
// lapsed would send somebody to carry the same units back to the same board and
// start the same four days again. The argument is sound and what pays it off is
// 4d: the crate is not on the drop-off any more.
//
// The second half is the one that matters to a shop that already exists. A mark
// made before any of this has no `dropFor` entry, and reading that as "forever"
// is right about what the code used to do and wrong about what it should have
// done — it would leave the damage in place on exactly the saves that suffered
// it. `dropSpan` defaults it, measured from the day on the mark rather than
// from the load that noticed.
// ---------------------------------------------------------------------------
{
  const g = fresh({ jobs: [{ job: 'merchandise', weight: 1 }] });
  const shelf = g.layout.shelves[0];
  board(g, shelf, ITEM_A, 12, { soldAgo: 9 });
  until(g, () => g.droppedItem(ITEM_A.id));

  const span = g.dropSpan(ITEM_A.id);
  check(span > 0 && Number.isFinite(span), 'the mark has a span', String(span));
  g.day += span - 1;
  check(g.droppedItem(ITEM_A.id), 'a day short of it, the shop is still not stocking it');
  g.day += 1;
  check(!g.droppedItem(ITEM_A.id), 'and on the day it is up, it comes back by itself');

  // An old save: the mark with no span beside it.
  const old = fresh();
  old.orders.dropped = { [ITEM_A.id]: old.day };
  old.orders.dropFor = {};
  check(old.droppedItem(ITEM_A.id), 'a mark from before any of this still holds');
  const shown = old.snapshot().orders.notStocking.find((d) => d.itemId === ITEM_A.id);
  eq(shown?.left, span, 'and is shown with the same countdown a new one gets');
  old.day += span;
  check(!old.droppedItem(ITEM_A.id), 'so a shop that collected these does not keep them for ever');

  // ...and YOUR clear is untouched by that default. It has always written its
  // own span, and it is deliberately the shorter of the two: a tidy-up is not a
  // decision about the range.
  const mine = fresh();
  mine.orders.dropped = {};
  mine.dropItem(ITEM_B.id, 5);
  eq(mine.dropSpan(ITEM_B.id), 5, 'a mark that carries its own span keeps it');
}

// ---------------------------------------------------------------------------
// 4d. The crate goes to the BAY, and that is what makes lapsing safe.
//
// The claim that cost the most and is the least visible: two pads of painted
// ground, and a crate on either one is the same picture. The drop-off is the
// shop's PRODUCTION buffer — `padRoom` is what `hasSomewhere` and `hasHome`
// gate the farm and the kitchen on — so a line the shop has stopped selling,
// parked there, does not merely sit in the way. It stops your beds being picked
// and your machines being emptied, days later, with nothing connecting the two.
//
// On a real save that read as seven robots standing still. `padRoom` was 0.
// ---------------------------------------------------------------------------
{
  const g = fresh({ jobs: [{ job: 'merchandise', weight: 1 }] });
  const shelf = g.layout.shelves[0];
  board(g, shelf, ITEM_A, 12, { soldAgo: 9 });
  const roomBefore = g.padRoom();
  check(roomBefore > 0, 'the drop-off starts with room on it', String(roomBefore));

  until(g, () => !g.shelfStack(shelf, ITEM_A.id) && !hand(g)?.carry);
  eq(everywhere(g, ITEM_A.id), 12, 'the goods all survive the trip');

  const onPad = (kind) => g.deliveries
    .filter((d) => (g.layout[kind]?.cells ?? []).some((c) => c.x === d.x && c.z === d.z))
    .reduce((n, d) => n + lotQty(d, ITEM_A.id), 0);
  eq(onPad('bay'), 12, 'and every unit of it is standing on the BAY');
  eq(onPad('drop'), 0, 'with none of it in the way of what the shop makes');
  eq(g.padRoom(), roomBefore, 'so the production buffer is exactly as big as it was');

  // ...and the ordinary case is untouched: goods the shop still wants, put down
  // because no board will have them, go to the drop-off the way they always did.
  const g2 = fresh({ jobs: [{ job: 'tidy', weight: 1 }] });
  const worker = hand(g2);
  worker.carry = { stacks: [{ item_id: ITEM_B.id, qty: 3 }] };
  check(!g2.droppedItem(ITEM_B.id), 'nothing has been given up on');
  until(g2, () => !hand(g2)?.carry);
  const bOn = (kind) => g2.deliveries
    .filter((d) => (g2.layout[kind]?.cells ?? []).some((c) => c.x === d.x && c.z === d.z))
    .reduce((n, d) => n + lotQty(d, ITEM_B.id), 0);
  eq(bOn('drop'), 3, 'an ordinary armful still goes to the drop-off');
  eq(bOn('bay'), 0, 'and not to the bay');
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
// 8. …and a board YOU cleared does not come straight back either.
//
// Section 4's claim, asked of the other pair of hands. Every part of the loop it
// describes is still standing when the player is the one who pressed Clear: the
// crate is an ordinary pallet, `unload` lifts it, and the board it came off is
// bare and unlabelled — which makes it the best shelf going in `shelvesFor` — so
// the next stocker to walk past undoes the thing you just did. What that reads
// as is the button not working, and the shop looks BUSY while it happens. It is
// invisible in a still frame twice over: one frame is a crate beside a shelf,
// and the next one is a stocked shelf.
// ---------------------------------------------------------------------------
{
  const jobs = [{ job: 'unload', weight: 1 }, { job: 'shelve', weight: 1 }];
  const g = fresh({ jobs });
  const shelf = g.layout.shelves[0];
  // Selling perfectly well and not stale — this is your call, not the shop's,
  // which is the difference between this section and section 4.
  board(g, shelf, ITEM_A, 8, { soldAgo: 0 });

  const res = g.clearBoard('me', shelf.id, ITEM_A.id);
  check(res.ok, 'you can take a board off a unit', res.error ?? '');
  eq(g.shelfStacks(shelf).length, 0, 'the board is free the moment you press it');
  check(g.droppedItem(ITEM_A.id), 'and the shop hears it as "we do not stock this any more"');

  run(g, 1200);                                // two full in-game minutes of trying
  check(!onAShelf(g, ITEM_A.id), 'so nothing walks it back on', 'a stocker undid it');
  eq(everywhere(g, ITEM_A.id), 8, 'and the goods are all still there, in the crate');

  // …and taking the LABEL off a board with nothing on it is not that sentence.
  // Nothing moved, so there is nothing for anybody to walk back, and a shop that
  // retired an item every time you tidied a row of ghosts would be one you could
  // not tidy.
  shelf.assigned = [ITEM_B.id];
  const untick = g.clearBoard('me', shelf.id, ITEM_B.id);
  check(untick.ok, 'a bare reservation comes off too', untick.error ?? '');
  check(!g.droppedItem(ITEM_B.id), 'and that alone retires nothing');
}

// ---------------------------------------------------------------------------
// 9. …but only while nothing else in the shop is holding it.
//
// The mark is on the ITEM, because giving up on one board alone lands the same
// goods on the unit next door with the next van. Which is right for the hand,
// whose whole reason for clearing is that nothing is selling — and wrong here,
// where you may simply be consolidating two boards into one. Marking it then
// strands the crate on the floor AND quietly stops restocking a shelf you never
// touched, both of which look like the shop breaking somewhere else.
// ---------------------------------------------------------------------------
{
  const jobs = [{ job: 'unload', weight: 1 }, { job: 'shelve', weight: 1 }];
  const g = fresh({ jobs });
  const [s0, s1] = g.layout.shelves;
  board(g, s0, ITEM_A, 2, { soldAgo: 0 });
  board(g, s1, ITEM_A, 2, { soldAgo: 0 });

  const res = g.clearBoard('me', s0.id, ITEM_A.id);
  check(res.ok, 'one of two boards comes off', res.error ?? '');
  check(!g.droppedItem(ITEM_A.id),
    'and the shop does not stop stocking it — a shelf you never touched still sells it');

  const done = until(g, () => (g.shelfStack(s1, ITEM_A.id)?.qty ?? 0) === 4);
  check(done !== null, 'so the crate goes to that shelf rather than back where it came from',
    `${g.shelfStack(s1, ITEM_A.id)?.qty ?? 0} on it`);
  eq(g.shelfStacks(s0).length, 0, 'and the board you cleared stays cleared');
}

// ---------------------------------------------------------------------------
// 10. Tipping the WHOLE unit out says the same thing, board by board.
//
// "Empty it" is the same intent as Clear said about three boards at once — I
// will refill this myself — so it lets go of what comes off, or the crates it
// makes are walked back on one at a time and the unit is as it was inside a
// minute. The reservation is the exception and gets no code of its own: strip
// deliberately keeps `assigned`, and a board still set aside is the shop still
// being asked for it. That split is the whole claim here, and it is invisible in
// play precisely because it looks like nothing happening — one item comes back
// and the other does not.
// ---------------------------------------------------------------------------
{
  const jobs = [{ job: 'unload', weight: 1 }, { job: 'shelve', weight: 1 }];
  const g = fresh({ jobs });
  const shelf = g.layout.shelves[0];
  board(g, shelf, ITEM_A, 4, { soldAgo: 0 });    // never spoken for — let go of
  board(g, shelf, ITEM_B, 4, { soldAgo: 0 });    // kept for — refilled as ever
  shelf.assigned = [ITEM_B.id];

  const res = g.stripShelf('me', shelf.id);
  check(res.ok, 'the whole unit tips out', res.error ?? '');
  eq(g.shelfStacks(shelf).length, 0, 'both boards are free');
  check(g.droppedItem(ITEM_A.id), 'the shop lets go of what it was never asked for');
  check(!g.droppedItem(ITEM_B.id),
    'and holds on to what you kept a board for — strip keeps `assigned` on purpose');

  const done = until(g, () => (g.shelfStack(shelf, ITEM_B.id)?.qty ?? 0) === 4);
  check(done !== null, 'so the kept one is walked back on', 'the reservation stopped meaning anything');
  check(!onAShelf(g, ITEM_A.id), 'and the other one is not', 'a stocker undid the strip');
  eq(everywhere(g, ITEM_A.id), 4, 'with every unit of it still in the crate');
}

// ---------------------------------------------------------------------------
// 11. One place per thing — the claim about a second board never being started
//     WHILE THE FIRST ONE CAN HOLD IT.
//
// The other end of everything above. Sections 1–10 are about giving a board
// BACK; this is about not taking a second one while the first has room, and it
// is the half that was missing for the whole life of the game.
//
// The qualifier is not a softening, it is where the rule's authority ends. A
// home with room is the shop keeping one thing in one place; a home with none
// is a rule that has stopped gathering goods and started refusing them, and the
// goods it refuses are already in a crate in the yard that nothing will lift.
// See (a). What actually stops the spread compounding is (e) and (f).
//
// `shelvesFor` has always ranked the unit an item is already on first, which is
// a preference and is therefore only consulted when there is a choice. Fill that
// unit and there is none: the next armful claims a bare board next door, and one
// item has two homes for the rest of the save. Nothing about that is visible —
// every frame of it is a worker putting goods on a shelf with room, which is
// what a working shop looks like — and it compounds, because each board is its
// own line in `restockQueue` and the shop then buys for both. A real save
// reached three tomato boards, two chocolate boards and a 15/14 carrot split by
// day 10, and it reads as the staff being stupid rather than as a missing rule.
//
// Five claims, and the first is the only one you could ever see:
// ---------------------------------------------------------------------------
{
  const jobs = [{ job: 'unload', weight: 1 }, { job: 'shelve', weight: 1 }];
  const cap = (g, sh) => g.shelfCapacity(sh, ITEM_A);

  // (a) The home binds while it CAN, and stops binding when it is full.
  //
  //     This claim used to be the stronger one — a full home never spills, and
  //     the goods stay in the crate "where `unload` has always put a crate
  //     nothing will take". It was written about an armful with nowhere to go,
  //     and it is false about the place those goods actually end up. Nothing
  //     lifts a crate no shelf will take: `unload` asks `roomAcross` before it
  //     bends down, so a full home meant that item's crates stood in the yard
  //     until something sold. On a real save that was five items at once, a
  //     dozen legal shelves standing empty behind them, and the whole crew
  //     parked alongside with nothing to do — while `padRoom` ran to zero and
  //     took the farm and the kitchen down with it, because both are gated on it.
  //
  //     What made the old claim look necessary is (e) and (f), and both of them
  //     still hold: the spare board is handed back the moment it empties, and
  //     the shop never buys for it. Those are the compounding harms. A second
  //     board that drains and disappears is not one of them.
  //
  //     So: while the home has room, one unit — the original claim, and the one
  //     that stops an item getting two homes out of a preference. Once it does
  //     not, the goods you have already paid for go on a shelf.
  {
    const g = fresh({ jobs });
    const [s0] = g.layout.shelves;
    // Part-full, with room for MORE than is waiting. The room has to be able to
    // swallow the lot: leave one slot against six units and five of them have
    // nowhere to be but the unit next door, which is the second half of the rule
    // firing correctly and reads as the first half failing.
    const ROOM = 4;
    board(g, s0, ITEM_A, Math.max(1, cap(g, s0) - ROOM), { soldAgo: 0 });
    const waiting = ROOM - 1;
    g.dropGoods(ITEM_A.id, waiting, g.layout.bay.cells[0]);
    const held = g.shelfStack(s0, ITEM_A.id).qty;
    run(g, 1200);
    eq(g.layout.shelves.filter((sh) => g.shelfStack(sh, ITEM_A.id)).length, 1,
      'a home with room for all of it takes all of it, and nothing else starts a board');
    eq(g.shelfStack(s0, ITEM_A.id)?.qty, held + waiting, 'every unit of it onto the home');
  }
  // A full home spills onto a board that is ALREADY holding this, and never
  // onto a bare one. Both halves are the rule: the waiver exists so goods you
  // paid for are not stranded behind a full unit, and opening boards with it is
  // the spread bug back in other clothes — with a farm behind it, "any other
  // legal unit" is every bare board in the shop, so a shop with four beds of
  // carrots turns into three shelves of carrots and stops widening its range.
  {
    const g = fresh({ jobs });
    const [s0, s1] = g.layout.shelves;
    board(g, s0, ITEM_A, cap(g, s0), { soldAgo: 0 });
    board(g, s1, ITEM_A, 1, { soldAgo: 0 });
    g.dropGoods(ITEM_A.id, 6, g.layout.bay.cells[0]);
    const before = everywhere(g, ITEM_A.id);

    run(g, 1200);                              // two in-game minutes of trying
    eq(everywhere(g, ITEM_A.id), before, 'with every unit of it accounted for');
    eq(g.deliveries.reduce((n, d) => n + lotQty(d, ITEM_A.id), 0), 0,
      'a full home lets the rest onto a board that already holds it');
    eq(g.shelfStack(s1, ITEM_A.id)?.qty, 7, 'which is the second board topped up');
    eq(g.shelfStack(s0, ITEM_A.id)?.qty, cap(g, s0), 'and the home is untouched');
    eq(g.layout.shelves.filter((sh) => g.shelfStack(sh, ITEM_A.id)).length, 2,
      'and no THIRD board was opened on the way');

    // ...and the home is STILL the home, which is what makes the spill settle
    // rather than spread. `homeShelves` picks the unit holding the most, so the
    // spare is the one that drains — and (e) hands it back the moment it does.
    const homes = g.homeShelves(ITEM_A.id);
    check(g.homedAt(s0, ITEM_A.id, homes), 'the fuller board is still the home');
    check(!g.homedAt(s1, ITEM_A.id, homes), 'and the spare is not — so (f) still refuses it a van');
  }
  // ...and with nowhere it already lives, the surplus WAITS. This is the claim
  // that costs something, and it is the one that was asked for: a crate on the
  // pad is the honest signal that the shop needs another unit, where a bare
  // board silently spent on a second home is a range that never grows.
  {
    const g = fresh({ jobs });
    const [s0] = g.layout.shelves;
    board(g, s0, ITEM_A, cap(g, s0), { soldAgo: 0 });
    const bare = g.layout.shelves.filter((sh) => !g.shelfStacks(sh).length).length;
    check(bare > 0, 'there is a bare unit standing there to be claimed');
    g.dropGoods(ITEM_A.id, 6, g.layout.bay.cells[0]);
    const before = everywhere(g, ITEM_A.id);

    run(g, 1200);
    eq(g.layout.shelves.filter((sh) => g.shelfStack(sh, ITEM_A.id)).length, 1,
      'a full home with no second board opens none');
    eq(everywhere(g, ITEM_A.id), before, 'and nothing is created or destroyed by the refusal');
    eq(g.deliveries.reduce((n, d) => n + lotQty(d, ITEM_A.id), 0), 6,
      'the surplus stays in the crate it came in');
  }

  // (b) …and the FIRST board is still freely claimed. `homeShelves` answers null
  //     rather than an empty Set for an item with no home, and a caller that
  //     conflated the two would refuse every board an item ever gets — which is
  //     a shop that cannot be stocked at all, passing (a) perfectly.
  {
    const g = fresh({ jobs });
    g.dropGoods(ITEM_A.id, 6, g.layout.bay.cells[0]);
    check(until(g, () => onAShelf(g, ITEM_A.id)) !== null,
      'an item with no home anywhere still gets one', 'nothing was ever shelved');
    eq(g.layout.shelves.filter((sh) => g.shelfStack(sh, ITEM_A.id)).length, 1,
      'and exactly one unit takes it');
  }

  // (c) Ticking a second unit is the override, and it has to be the WHOLE
  //     override — a reservation that merely ranked first would leave this
  //     failing exactly as (a) does.
  {
    const g = fresh({ jobs });
    const [s0, s1] = g.layout.shelves;
    board(g, s0, ITEM_A, cap(g, s0), { soldAgo: 0 });
    s1.assigned = [ITEM_A.id];
    g.dropGoods(ITEM_A.id, 6, g.layout.bay.cells[0]);

    const done = until(g, () => (g.shelfStack(s1, ITEM_A.id)?.qty ?? 0) === 6, 1200);
    check(done !== null, 'a unit you ticked for it is a second home',
      `${g.shelfStack(s1, ITEM_A.id)?.qty ?? 0} on it`);
  }

  // (d) Your own hands never read it. The same line `orders.assign` and
  //     `giveUpBoard` draw twice already: the shop's judgement about its own
  //     range was never a rule about what you may do. Asserted against the two
  //     functions the press and the highlight actually run, because asking the
  //     staff's own question here would pass however wrong they are.
  {
    const g = fresh();
    const [s0, s1] = g.layout.shelves;
    board(g, s0, ITEM_A, cap(g, s0), { soldAgo: 0 });
    check(g.boardFor(s1, ITEM_A).ok, 'you may still stand it on any shelf you like',
      g.boardFor(s1, ITEM_A).error ?? '');
    check(g.shelfAccepts(s1, ITEM_A.id), 'and the shelf still lights up as somewhere it could go');
  }

  // (e) The spare board is handed back the moment it empties, and neither of the
  //     two things that protect an ordinary empty board protects it.
  //
  //     This is the line that made those boards immortal: `releaseBoards` skips
  //     an empty board while `homeSupply` is above zero, and for anything you
  //     farm — or anything with a van out — that is for ever. A spare tomato
  //     board next to two tomato beds could not age a single day. It has to be
  //     asked BEFORE the supply guard, which is an ordering claim and invisible
  //     from either side of it.
  {
    const g = fresh();
    const [s0, s1] = g.layout.shelves;
    board(g, s0, ITEM_A, 9, { soldAgo: 0 });        // the home: most on it
    board(g, s1, ITEM_A, 0, { soldAgo: 0 });        // the spare, emptied
    g.orders.pending = [{ id: 'o-test', item_id: ITEM_A.id, qty: 4, cost: 1, placedDay: g.day }];
    check(g.homeSupply(ITEM_A.id) > 0, 'there is supply on its way, which normally protects a board');

    g.releaseBoards();
    eq(g.shelfStacks(s1).length, 0, 'the spare board goes back on the spot, not after the days');
    eq(g.shelfStack(s0, ITEM_A.id)?.qty, 9, 'and the home board is untouched');
  }

  // (f) …and the shop stops BUYING for it, which is the half that costs money.
  //
  //     A spare board is its own line in `restockQueue` however the goods got
  //     there, so without the guard in `buy` the shop orders a van for a board
  //     no stocker will ever walk to: the crate lands, `shelvesFor` sends it
  //     home, the home is full, and it sits on the pad until it rots. Both
  //     directions asserted — a sweep that only checked the refusal would pass
  //     with restocking switched off entirely.
  {
    const g = fresh({ jobs: [{ job: 'restock', weight: 1 }] });
    const [s0, s1] = g.layout.shelves;
    g.orders.auto = true;
    board(g, s0, ITEM_A, cap(g, s0), { soldAgo: 0 });   // the home, full
    board(g, s1, ITEM_A, 0, { soldAgo: 0 });            // the spare, bare
    run(g, 300);
    check(!g.orders.pending.some((o) => o.item_id === ITEM_A.id),
      'no van is bought for a board nothing will ever walk to');

    const g2 = fresh({ jobs: [{ job: 'restock', weight: 1 }] });
    g2.orders.auto = true;
    board(g2, g2.layout.shelves[0], ITEM_A, 0, { soldAgo: 0 });
    check(until(g2, () => g2.orders.pending.some((o) => o.item_id === ITEM_A.id), 300) !== null,
      '…and the home board itself is still ordered for', 'restocking never fired at all');
  }
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\nverify:hand — ${failures.length} of ${checks} assertions FAILED\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\nverify:hand — ${checks} assertions\n`);
console.log('  ✅  a dead board is taken back, the goods survive, and they stay off.\n');
