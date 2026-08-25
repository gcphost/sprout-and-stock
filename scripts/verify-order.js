#!/usr/bin/env node
/**
 * VERIFY: AN ORDER THE YARD CANNOT TAKE IS MADE SMALLER, NOT SKIPPED.
 *
 * `buyStock` refuses an order bigger than `bayRoom` or `looseRoom` **by name**
 * rather than shrinking it, and that is right about the press YOU make: a
 * number silently becoming a smaller number is the complaint said the other way
 * round, and the message tells you what to do about it. It is exactly wrong for
 * the crew, because `restock` and `larderOrder` both CHOOSE the number and both
 * read a refusal as `continue`. So the board is skipped — and skipped again on
 * the next tick, and every tick after, because nothing about it has changed.
 *
 * What that inverts is the thing this file exists to pin: **the emptiest board
 * asks for the most, so the bigger a unit is, the more certain it is never to be
 * bought for.** A live shop on day 322 had a 216-unit stockroom board standing
 * at zero against a bay with 60 free — the buyer computed 216, was turned down,
 * and moved on, for ever. Every small old shelf in that shop had stock on it and
 * every big new one was bare, and the stockroom had never held anything at all.
 * Buying more shelving made it worse. Painting a bigger stockroom made it worse.
 * The one thing that would have helped is a bigger delivery bay, and nothing
 * anywhere said so.
 *
 * Nothing in it can be looked at, twice over. A shop whose buyer was refused and
 * a shop whose buyer had nothing to buy are the same still frame — no refusal
 * reaches the feed, because `buyStock` only logs for `!p.staff` — and the shop
 * is the same shop afterwards either way. It shows up days later as shelves that
 * will not fill, which points at the staff.
 *
 * The claims:
 *
 * - **An order that already fits is untouched.** The control, and the assertion
 *   that decides whether this is a bug fix or a silent rebalance of every save
 *   in existence: with room to spare the quantity is `board room − homeSupply`
 *   to the unit, exactly as it was.
 * - **A board bigger than the yard is bought for at all.** The centrepiece. Not
 *   "bought for correctly" — bought for *at all*, since the number before this
 *   was zero and stayed zero.
 * - **…at the yard's size, not the board's.** Paired with it, because an order
 *   that ignored the yard would satisfy the first half and be refused again.
 * - **It is a RATE and not a ceiling.** The half that makes reserve depth real:
 *   land the van, ask again, and the board fills over successive runs to its own
 *   capacity. Clamping one order must not cap what the shop may eventually own,
 *   or this has fixed the refusal and kept the shallow shop.
 * - **A yard with no room orders NOTHING.** The other side of the clamp. A
 *   floor of zero is what stops `Math.min` handing `buyStock` a negative and
 *   what stops the job spending a tick per board on a shop that is already
 *   drowning.
 * - **The money is what was ordered.** A clamp that charged for the number it
 *   wanted rather than the number it got is a shop that is quietly poorer, and
 *   the crates that arrive look perfectly correct.
 *
 * Runs on ephemeral Games, so it never touches the live shop. It writes one
 * worker row into the content database — usually the live shared one — and
 * removes it on exit, the way `verify-pack` and `verify-hand` do.
 *
 *   node scripts/verify-order.js
 */

import { Game } from '../server/sim/index.js';
import { content, writeContent } from '../server/content.js';
import { remove } from '../server/db.js';
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
 * One hire whose whole day is ordering.
 *
 * `restock` is not exported and is drawn rather than called, so the honest way
 * to reach it is a worker who can do nothing else — a list of one is a draw of
 * one. Fast and tireless, so a run is ticks rather than minutes and no
 * assertion here is quietly measuring `tiredness`.
 */
const BUYER = {
  id: 'zz-order-buyer', name: 'Test Buyer', color: '#4b7a9e',
  jobs: [{ job: 'restock', weight: 1 }], cost: 0, wage: 0,
  speed: 20, pace: 0.05, carry: 6,
  tiers: [{ name: 'Standard', cost: 0 }],
};
process.on('exit', () => {
  try { remove('workers', BUYER.id); } catch { /* best effort */ }
});
{
  const res = writeContent('worker', BUYER, 'verify');
  check(res.ok, 'the catalog accepts the buyer', res.error ?? '');
}

/**
 * An ordinary ambient item nobody makes here.
 *
 * `makesHere` is a `continue` in the same loop, so a recipe output would be
 * skipped for a reason that has nothing to do with the yard and every assertion
 * below would read `undefined` while looking like the clamp had failed.
 */
const c = content();
const PLAIN_ITEMS = c.items.filter((it) => !it.tags.includes('frozen')
  && !it.tags.includes('needs-freezer')
  && !c.recipes.some((r) => r.output_id === it.id));
check(PLAIN_ITEMS.length > 0, 'the catalog has an ambient item nobody cooks', `${PLAIN_ITEMS.length}`);
const ITEM = PLAIN_ITEMS[0];

/** The same reset every other sweep makes — see `verify-pack` on each field. */
function fresh() {
  const g = Game.create({ worldId: 'verify-order', seed: 'order', ephemeral: true });
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
  for (const m of MILESTONES) g.milestones.done.push(m.id);
  g.orders.items = {};
  g.orders.dropped = {};
  g.orders.pending = [];
  g.deliveries = [];
  g.cash = 500000;                   // never the binding ceiling in this file
  g.open = false;                    // nobody buying stock out from under us
  // OFF until `oneBoard` says otherwise, and this is not tidiness: the step
  // below is a live tick with four furnished shelves still standing, so a buyer
  // whose ordering was on placed a van's worth against somebody else's board
  // before the section under test had begun — and every total in this file then
  // carried it.
  g.orders.auto = false;
  g.addPlayer('me', 'Tester');
  const res = g.hire(BUYER.id);
  check(res.ok, 'the buyer joins', res.error ?? '');
  g.step(0.1);                       // `hire` writes the roster; `syncStaff` puts the body in
  g.orders.pending = [];
  return g;
}

const run = (g, ticks) => { for (let i = 0; i < ticks; i++) g.step(0.1); };

/**
 * One board, on one unit, holding one thing — and every other unit stripped.
 *
 * The queue is walked from the top and the job returns on the first order it
 * can place, so a shop with four thin units would have this file asserting
 * about whichever one `restockQueue` happened to sort first. One candidate
 * makes every assertion below about the board it names.
 */
function oneBoard(g, item) {
  // ONE unit in the whole shop, rather than one stocked unit among four. The
  // three others were stripped and still ordered — a generated shelf can carry
  // an `assigned`, which is a want with no stock under it and sorts to the
  // FRONT of the queue, so the control was measuring somebody else's board.
  g.layout.shelves = g.layout.shelves.slice(0, 1);
  const [target] = g.layout.shelves;
  target.assigned = [];
  target.stacks = [{ item_id: item.id, qty: 0, price: 1, cap: g.shelfCapacity(target, item) }];
  // Ordering is the whole subject, so it is switched on here rather than in
  // `fresh` — and `assign` stays off, or `pickItem` gives the three stripped
  // units a range of their own and the queue stops being one board long.
  g.orders.auto = true;
  g.orders.assign = false;
  return target;
}

/** Everything ordered so far, landed or not. */
const orderedSoFar = (g) => g.orders.pending.reduce((n, o) => n + (o.qty ?? 0), 0);

/** How much the yard will take, which is the number the job has to respect. */
const yardOf = (g) => Math.min(g.bayRoom(), g.looseRoom());

/**
 * Shrink the bay to `cells` squares, which is how every "too big to order"
 * setup in this file is built.
 *
 * Shrinking the YARD rather than authoring a giant fixture is deliberate: the
 * bug is a comparison between two numbers, so it does not care which of them
 * moved, and a sweep that authored its own 216-unit shelf would be asserting
 * against a piece nobody has ever built. Every shop in the game has a bay.
 *
 * It must NOT re-flow, and that cost this file two rounds: `layout.bay` is
 * rebuilt from the painted ground on every `regenerateLayout`, so a slice
 * followed by a re-flow is the full bay back, silently — every precondition
 * below then reads `want === yard` and passes while asserting nothing.
 */
function shrinkBay(g, cells) {
  g.layout.bay.cells = g.layout.bay.cells.slice(0, cells);
  return yardOf(g);
}

// ---------------------------------------------------------------------------
// 1. The control: an order that already fits is the order it always was.
//
// First and load-bearing. Everything below asserts that a number gets smaller;
// this asserts that it does NOT when it did not have to, which is the whole
// difference between fixing a refusal and quietly re-pricing every shop that
// was working fine.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const target = oneBoard(g, ITEM);
  const want = g.shelfCapacity(target, ITEM) - g.homeSupply(ITEM.id);
  const yard = yardOf(g);
  check(want > 0, 'the board wants something', `${want}`);
  check(yard >= want,
    'PRECONDITION: the untouched yard is big enough to take it whole',
    `yard ${yard} vs want ${want}`);

  run(g, 60);
  eq(g.orders.pending.length, 1, 'one order goes on the van');
  eq(orderedSoFar(g), want, '…for exactly the board room less what the shop already owns');
}

// ---------------------------------------------------------------------------
// 2. THE CENTREPIECE. A board bigger than the yard is bought for at all —
//    and no single van carries more than the bay can take.
//
// Both halves or neither. "It ordered something" is satisfied by an order that
// still ignores the bay and is refused a second time; "no van exceeds the bay"
// is satisfied by ordering nothing at all, which is the bug.
//
// The TOTAL is deliberately not asserted against one van, and that is the
// behaviour rather than a looser test: `looseRoom` counts a pending order as a
// commitment, so the buyer goes on placing bay-sized orders until the whole
// yard is spoken for and then stops. Pinning the total to one van would be
// asserting that the shop may only ever have one order in flight, which is a
// different game and not this one.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const target = oneBoard(g, ITEM);
  const yard = shrinkBay(g, 1);
  const want = g.shelfCapacity(target, ITEM) - g.homeSupply(ITEM.id);
  check(want > yard,
    'PRECONDITION: the board wants more than the yard will take',
    `want ${want} vs yard ${yard}`);

  run(g, 60);
  check(g.orders.pending.length > 0,
    'a board too big for the yard is ordered for AT ALL — this was zero for ever');
  check(g.orders.pending.every((o) => o.qty <= yard),
    'no single order is bigger than the bay will take',
    JSON.stringify(g.orders.pending.map((o) => o.qty)));
  check(g.orders.pending.every((o) => o.item_id === ITEM.id),
    '…and all of it is for the board that asked');
  check(orderedSoFar(g) <= yard * g.orders.pending.length,
    'the committed total never runs past the yard it was measured against');
}

// ---------------------------------------------------------------------------
// 3. It is a rate, not a ceiling — which is the half that makes depth real.
//
// One clamped order is a fix for the refusal and would still leave a shop that
// can never hold more than one van of anything. `homeSupply` counts a pending
// order, so the board asks for the remainder the moment the yard clears: land
// the crates, shelve them, and the next pass tops it up again.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const target = oneBoard(g, ITEM);
  const yard = shrinkBay(g, 1);
  const cap = g.shelfCapacity(target, ITEM);
  check(cap > yard * 1.5,
    'PRECONDITION: the board is worth more than one van',
    `cap ${cap} vs yard ${yard}`);

  let total = 0;
  // Four runs of the same shop, each one landing what the last one bought
  // straight onto the board — which is what a stocker does, and what makes the
  // yard free again.
  for (let van = 0; van < 4; van++) {
    run(g, 40);
    const placed = orderedSoFar(g);
    if (!placed) break;
    total += placed;
    const stack = g.shelfStack(target, ITEM.id);
    stack.qty = Math.min(cap, stack.qty + placed);
    g.orders.pending = [];
    g.deliveries = [];
  }
  check(total > yard,
    'successive vans put MORE than one yard-full on the board — the clamp is a rate',
    `${total} against a yard of ${yard}`);
  eq(g.shelfStack(target, ITEM.id).qty, cap, '…and the board reaches its own capacity');
}

// ---------------------------------------------------------------------------
// 4. A yard with no room orders nothing, and spends nothing.
//
// The other side of the clamp, and the reason it has a floor: without one,
// `Math.min` hands `buyStock` a negative, which is refused by name — back to a
// board skipped every tick, wearing the fix.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  oneBoard(g, ITEM);
  shrinkBay(g, 1);
  // Fill the yard to the brim with something else, so the shop is drowning
  // rather than merely short of pad.
  const cell = g.layout.bay.cells[0];
  g.dropGoods(ITEM.id, g.crateCapacity() * 4, { x: cell.x, z: cell.z }, { exact: true });
  check(yardOf(g) <= 0, 'PRECONDITION: the yard has no room at all', `${yardOf(g)}`);

  const before = g.cash;
  run(g, 60);
  eq(g.orders.pending.length, 0, 'a shop with a full yard orders nothing');
  eq(g.cash, before, '…and spends nothing doing it');
}

// ---------------------------------------------------------------------------
// 5. The money is what was ordered, not what was wanted.
//
// A clamp applied to the quantity and not to the charge is a shop that is
// quietly poorer, with crates that arrive looking perfectly correct and nothing
// anywhere to compare them against.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  oneBoard(g, ITEM);
  const yard = shrinkBay(g, 1);
  const before = g.cash;

  run(g, 60);
  const [order] = g.orders.pending;
  check(!!order, 'an order was placed to charge for');
  eq(order?.qty, yard, 'the first order is the clamped quantity');
  // Every order placed in the run, because the buyer keeps going until the yard
  // is committed — see section 2. Summed rather than taking the head, or this
  // measures one van against the price of five.
  const billed = g.orders.pending.reduce((n, o) => n + o.cost, 0);
  const paid = before - g.cash;
  check(Math.abs(paid - billed) < 0.01,
    'the till is down by what was ordered and no more',
    `paid ${paid.toFixed(2)} vs orders ${billed.toFixed(2)}`);
  check(paid > 0, '…and it did cost something, or this section proves nothing');
}

// ---------------------------------------------------------------------------

console.log(`\nverify:order — ${checks} assertions\n`);
if (failures.length) {
  for (const f of failures) console.log(`  ❌  ${f}`);
  console.log(`\n${failures.length} failed.\n`);
  process.exit(1);
}
console.log('  ✅  an order too big for the yard is made smaller, never skipped.\n');
