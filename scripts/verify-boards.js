#!/usr/bin/env node
/**
 * VERIFY: WHICH BOARD A THING IS ON IS A DECISION, AND MOVING IT MOVES NOTHING ELSE.
 *
 * Where goods sit on a unit was never anybody's choice: `openStack` pushes a new
 * kind onto the end of `stacks`, so a board's place is a record of the order
 * things happened to arrive in — and that order is what the renderer draws from
 * (`syncShelves` files each kind by `kinds.indexOf`). A shelf you can see from
 * across the shop was therefore arranged by delivery date.
 *
 * Everything in here is invisible, and in two different ways. A permutation of a
 * list looks like the same shelf however wrong it goes — the goods are all still
 * there, in some order — and the failure that matters most does not show up on
 * this screen at all: it shows up on the shelf, one tick later, in the shop.
 *
 * - **Both lists move, or nothing moved.** `stacks` is what is standing on the
 *   unit and `assigned` is what it is kept for, and the picture is built from
 *   the union with the RESERVATIONS FIRST. Reorder the goods alone and the menu
 *   says one thing while the shelf goes on drawing the old order — which reads
 *   as the drag not having worked, in a shop where it demonstrably just did.
 * - **It is a permutation.** Same kinds, same quantities, same prices, same
 *   spoilage stamps. Every other way goods move between places in this game has
 *   been a hole at some point (see `verify:pack`), and a sort is a place where
 *   losing one is a single missing element nobody would count.
 * - **A list that names something the shelf has not got is still obeyed**, and
 *   what it does not name keeps its place at the end. Two people can be looking
 *   at one shelf, and a delivery can land between the press and the release —
 *   an order built a tick ago must not un-shelve what arrived in between.
 * - **A duplicate cannot duplicate a board.** The list comes off the DOM, and a
 *   list is the one input a menu can hand over twice by accident.
 * - **The refusals come before anything moves**, which is `buyStock`'s lesson:
 *   a guard that runs after the mutation is a guard that reads correctly and
 *   protects nothing.
 *
 * Runs on ephemeral Games, so it never touches the live shop, and authors
 * nothing — every item it needs is already in the catalog and the only thing
 * being asked is what an array does.
 *
 *   node scripts/verify-boards.js
 */

import { Game } from '../server/sim/index.js';
import { content } from '../server/content.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SHOP = { shelf: 4, freezer: 0, checkout: 1, plot: 0 };

const c = content();
const AMBIENT = c.items.filter((it) => !it.tags.includes('frozen') && !it.tags.includes('needs-freezer'));
check(AMBIENT.length >= 3, 'the catalog has three ambient items to shelve', `${AMBIENT.length}`);
const [A, B, C] = AMBIENT;

function fresh() {
  const g = Game.create({ worldId: 'verify-boards', seed: 'boards', ephemeral: true });
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
  g.orders.pending = [];
  g.deliveries = [];
  g.cash = 50000;
  g.open = false;
  return g;
}

/** A unit with all three on it, each with a quantity and a price of its own. */
function stocked(g) {
  const shelf = g.layout.shelves[0];
  [A, B, C].forEach((it, n) => {
    const stack = g.openStack(shelf, it);
    check(!!stack, `a board opens for ${it.id}`);
    stack.qty = (n + 1) * 3;
    stack.price = (n + 1) * 1.11;
    stack.stockedDay = n;
  });
  return shelf;
}

const ids = (shelf) => (shelf.stacks ?? []).map((k) => k.item_id);
/** Everything about the goods that is not their order — the conservation view. */
const goods = (shelf) => JSON.stringify([...(shelf.stacks ?? [])]
  .map((k) => [k.item_id, k.qty, k.price, k.stockedDay])
  .sort((x, y) => String(x[0]).localeCompare(String(y[0]))));

// ---------------------------------------------------------------------------
// 1. IT IS A PERMUTATION, AND BOTH LISTS MOVE.
{
  const g = fresh();
  const shelf = stocked(g);
  shelf.assigned = [A.id, B.id, C.id];
  const before = goods(shelf);
  eq(ids(shelf).join(), [A.id, B.id, C.id].join(), 'they start in the order they arrived');

  const res = g.orderBoards(shelf.id, [C.id, A.id, B.id]);
  check(res.ok, 'the order is accepted', res.error ?? '');
  eq(ids(shelf).join(), [C.id, A.id, B.id].join(), 'the goods are in the order asked for');
  // The whole feature. `syncShelves` files a kind by its place in the union of
  // the two lists with `assigned` first, so a reorder that moved only the goods
  // draws the shelf exactly as it drew it before.
  eq((shelf.assigned ?? []).join(), [C.id, A.id, B.id].join(),
    '…and so is what the unit is kept for');
  eq(goods(shelf), before, 'nothing was created, destroyed or repriced on the way');
}

// ---------------------------------------------------------------------------
// 2. A STALE LIST: what it does not name keeps its place, at the end.
{
  const g = fresh();
  const shelf = stocked(g);
  const before = goods(shelf);
  // As if the third landed between the press and the release.
  const res = g.orderBoards(shelf.id, [B.id, A.id]);
  check(res.ok, 'a list that names some of them is accepted', res.error ?? '');
  eq(ids(shelf).join(), [B.id, A.id, C.id].join(), 'the named ones move and the rest sit after them');
  eq(goods(shelf), before, '…and nothing is dropped for not having been mentioned');
}

// ---------------------------------------------------------------------------
// 3. A LIST NAMING WHAT IS NOT THERE, and one naming a thing twice.
{
  const g = fresh();
  const shelf = stocked(g);
  const before = goods(shelf);

  g.orderBoards(shelf.id, ['zz-not-a-thing', C.id, B.id, A.id]);
  eq(ids(shelf).join(), [C.id, B.id, A.id].join(), 'an item the shelf has not got is simply ignored');
  eq(goods(shelf), before, '…and conjures no board');

  g.orderBoards(shelf.id, [A.id, A.id, B.id]);
  eq(ids(shelf).length, 3, 'a list naming one thing twice still leaves three boards');
  eq(ids(shelf).join(), [A.id, B.id, C.id].join(), '…in the order its first mention asked for');
  eq(goods(shelf), before, '…and still moves nothing');
}

// ---------------------------------------------------------------------------
// 4. THE REFUSALS, before anything moves.
{
  const g = fresh();
  const shelf = stocked(g);
  const before = goods(shelf);
  const was = ids(shelf).join();

  check(!g.orderBoards('no-such-shelf', [A.id]).ok, 'a shelf that does not exist is refused');
  check(!g.orderBoards(shelf.id, []).ok, 'an empty order is refused');
  check(!g.orderBoards(shelf.id, null).ok, 'no order at all is refused');
  eq(ids(shelf).join(), was, 'and a refusal left the boards exactly as they were');
  eq(goods(shelf), before, '…including everything on them');
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\nverify:boards — ${failures.length} of ${checks} assertions FAILED\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\nverify:boards — ${checks} assertions\n`);
console.log('  ✅  a board can be moved up the unit, and moving it moves nothing else.\n');
