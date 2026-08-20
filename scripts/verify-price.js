#!/usr/bin/env node
/**
 * VERIFY: WHAT THE SHOP CHARGES IS A FACT ABOUT THE ITEM, NOT ABOUT A BOARD.
 *
 * A price has lived on `stack.price` since there were shelves — set once, from
 * `suggestedPrice`, at the moment a board opens — which is right about a shop
 * with one shelf and quietly wrong about every shop bigger than that: eggs on
 * three units is three prices, and the fourth board to open says the suggestion
 * back at you however carefully you set the other three. `orders.items[id].price`
 * is the standing answer, beside `min` and `max`, on the same argument step 3 of
 * docs/ordering.md makes about those two — a rule is about the SHOP.
 *
 * Nothing in here can be looked at. A board priced by you and a board priced by
 * the shop are the same board with the same number on it, and the failure this
 * file is really pointed at is the one that only appears later: a price you set
 * that a *refill* silently hands back to the suggestion, which reads as the
 * number resetting itself days after you last touched it.
 *
 * - **A shop that never set one is the old game to the cent.** The control, and
 *   the reason this is opt-in rather than a change to every save in existence:
 *   `itemPrice` with no rule must be `suggestedPrice` exactly, and a board that
 *   opens must open there.
 * - **Both ways a board opens honour it.** `openStack` for a new one, and
 *   `pourInto` refilling one that had emptied — the second is the one that reads
 *   as a reset, because it fires when the shop sells out rather than when you do
 *   anything.
 * - **Setting one lands on the shop in front of you**, on every board holding it
 *   and on nothing else. A standing price that only touched future boards would
 *   be a control you press in a shop with three shelves of eggs where not one
 *   number on the floor moves.
 * - **Clearing it hands the boards back to the suggestion**, which is what makes
 *   the dash mean "whatever the shop thinks" rather than "the last number I
 *   typed, for ever".
 * - **Zero is a price.** `min` and `max` spell "unset" as `<= 0`; a price of
 *   nothing is how you give something away, so it has to store rather than
 *   clear — the same shape as the third kind of shelving, one loop along.
 * - **Nudging a minimum does not walk every shelf in the building**, which is
 *   the other side of the same coin: a reprice on a patch that never mentioned a
 *   price would wipe the per-board prices the shelf menu exists to set.
 *
 * Runs on ephemeral Games, so it never touches the live shop, and authors
 * nothing at all — every item it needs is already in the catalog, and the only
 * thing being asked is what a number does.
 *
 *   node scripts/verify-price.js
 */

import { Game } from '../server/sim/index.js';
import { content } from '../server/content.js';
import { suggestedPrice } from '../server/sim/economy.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SHOP = { shelf: 4, freezer: 0, checkout: 1, plot: 0 };

/**
 * Two ordinary ambient items, and the second one is the CONTROL.
 *
 * Nearly every way of getting a reprice wrong moves too much rather than too
 * little — a loop over shelves that forgot which item it was about would price
 * the whole shop — so a claim about the item you set is worth half of a claim
 * about the one standing next to it.
 */
const c = content();
const AMBIENT = c.items.filter((it) => !it.tags.includes('frozen') && !it.tags.includes('needs-freezer'));
check(AMBIENT.length >= 2, 'the catalog has two ambient items to price', `${AMBIENT.length}`);
const [ITEM_A, ITEM_B] = AMBIENT;

/**
 * The same reset every other sweep makes, plus `orders`.
 *
 * `orders.items` is the one that matters here and is this file's own `fresh()`
 * trap: the standing price rides in exactly the map a live save carries, so a
 * run that did not clear it would measure whatever the shop next door has
 * decided to charge for bread.
 */
function fresh() {
  const g = Game.create({ worldId: 'verify-price', seed: 'price', ephemeral: true });
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
  g.open = false;                     // nobody buying things out from under us
  return g;
}

/** What the shop would suggest for this item today, on this game's own clock. */
const fair = (g, item) => suggestedPrice(item, g.folded(), g.season);

/** Put stock on a board the way a delivery would: through `openStack`. */
function board(g, shelf, item, qty) {
  const stack = g.openStack(shelf, item);
  check(!!stack, `a board opens for ${item.id}`);
  stack.qty = qty;
  return stack;
}

/** Every board in the shop holding this item, in shelf order. */
const boardsOf = (g, item) => g.layout.shelves
  .map((s) => g.shelfStack(s, item.id)).filter(Boolean);

// ---------------------------------------------------------------------------
// 1. THE CONTROL: a shop nobody has priced.
{
  const g = fresh();
  const want = fair(g, ITEM_A);
  eq(g.itemPrice(ITEM_A), want, 'with no rule, an item is worth what the shop suggests');

  const stack = board(g, g.layout.shelves[0], ITEM_A, 6);
  eq(stack.price, want, '…and a board opens there');

  // The rule map stays empty, which is the test the supplier's badge makes and
  // the reason a nudged-and-put-back number does not light every row in the
  // catalogue: a rule that says nothing is deleted rather than stored.
  eq(Object.keys(g.orders.items).length, 0, '…and nothing has been written down');
}

// ---------------------------------------------------------------------------
// 2. SETTING ONE: the boards already standing, and the ones that open after.
{
  const g = fresh();
  const [s0, s1, s2] = g.layout.shelves;
  board(g, s0, ITEM_A, 6);
  board(g, s1, ITEM_A, 4);
  const other = board(g, s2, ITEM_B, 5);
  const otherWas = other.price;

  const res = g.setItemRule(ITEM_A.id, { price: 3.33 });
  check(res.ok, 'the price is accepted', res.error ?? '');
  eq(g.itemRule(ITEM_A.id).price, 3.33, 'and it is written down');

  for (const [i, k] of boardsOf(g, ITEM_A).entries()) {
    eq(k.price, 3.33, `board ${i} of it is repriced`);
  }
  // The control. A reprice that lost track of which item it was about would
  // pass every assertion above it and price the whole shop.
  eq(other.price, otherWas, 'and the item standing next to it is untouched');

  // The board that did not exist when you decided. This is the half a per-board
  // price could never say, and the reason the field is on the rule at all.
  const late = board(g, g.layout.shelves[3], ITEM_A, 2);
  eq(late.price, 3.33, 'a board opened afterwards opens at your price');

  // ...and the one that reads as the number resetting itself: a board that sold
  // out and is refilled takes its price again at that moment (`pourInto`), so a
  // standing price honoured by `openStack` alone would hold only until the shop
  // ran out of eggs.
  const sold = boardsOf(g, ITEM_A)[0];
  sold.qty = 0;
  g.addPlayer('me', 'Tester');
  const p = g.players.me;
  p.carry = { stacks: [{ item_id: ITEM_A.id, qty: 3 }] };
  const pour = g.pourInto(g.layout.shelves[0], p.carry, 3);
  check(pour.moved > 0, 'the armful goes onto the empty board', JSON.stringify(pour.refusal ?? null));
  eq(g.shelfStack(g.layout.shelves[0], ITEM_A.id).price, 3.33,
    '…and a board refilled after selling out keeps your price');
}

// ---------------------------------------------------------------------------
// 3. CLEARING IT: the boards go back to the shop's own answer.
{
  const g = fresh();
  const [s0, s1] = g.layout.shelves;
  board(g, s0, ITEM_A, 6);
  board(g, s1, ITEM_A, 6);
  g.setItemRule(ITEM_A.id, { price: 9.99 });
  eq(boardsOf(g, ITEM_A)[0].price, 9.99, 'priced high');

  g.setItemRule(ITEM_A.id, { price: null });
  eq(g.itemRule(ITEM_A.id).price, undefined, 'clearing it forgets the number');
  const want = fair(g, ITEM_A);
  for (const [i, k] of boardsOf(g, ITEM_A).entries()) {
    eq(k.price, want, `board ${i} goes back to the suggestion`);
  }
  eq(Object.keys(g.orders.items).length, 0,
    'and the rule is deleted rather than left as a row of nulls');
}

// ---------------------------------------------------------------------------
// 4. ZERO IS A PRICE, and a minimum is not a reprice.
{
  const g = fresh();
  board(g, g.layout.shelves[0], ITEM_A, 6);

  // `min`/`max` spell "unset" as `<= 0`, and a price sharing that loop would
  // make giving something away indistinguishable from never having said.
  g.setItemRule(ITEM_A.id, { price: 0 });
  eq(g.itemRule(ITEM_A.id).price, 0, 'nothing is a price you are allowed to charge');
  eq(boardsOf(g, ITEM_A)[0].price, 0, '…and the board says so');

  // The other side of the same coin: the shelf menu is where a per-board price
  // is set, so a patch that never mentioned a price must not walk the shop and
  // wipe one.
  g.setItemRule(ITEM_A.id, { price: null });
  const hand = boardsOf(g, ITEM_A)[0];
  hand.price = 7.77;                   // as if set from the shelf's own menu
  g.setItemRule(ITEM_A.id, { min: 5 });
  eq(hand.price, 7.77, 'nudging a minimum reprices nothing');
  eq(g.itemRule(ITEM_A.id).min, 5, '…and still sets the minimum');
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\nverify:price — ${failures.length} of ${checks} assertions FAILED\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\nverify:price — ${checks} assertions\n`);
console.log('  ✅  a price is a fact about the item, and a refill does not undo it.\n');
