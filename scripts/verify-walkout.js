#!/usr/bin/env node
/**
 * VERIFY: THE SHOP THAT STOPPED HAVING QUEUES.
 *
 * A `covers` rung is the end of the checkout ladder rather than another step up
 * it. Every rung below sells a faster counter and the top one sells not needing
 * somebody stood at it; this one sells not needing the COUNTER — shoppers are
 * billed where they stand and walk out, and the shop stops laying lines at all.
 *
 * Nothing in here can be looked at, which is why it ships with the feature the
 * way `verify:price` and `verify:motion` did. A shopper who was billed and a
 * shopper who was not are the same still frame: same person, same door, same
 * armful of shopping, and the shop afterwards is the same shop. Only the
 * takings moved, and they moved by an amount nobody can eyeball against a
 * basket they never saw the contents of.
 *
 * The price of the rung is **shrinkage**, and the shape of that price is the
 * whole design: `walkoutMiss` is the shop's load over the covers it owns, so
 * one sensor in a quiet shop is near enough perfect and the same sensor in a
 * packed one bleeds. That is what makes owning several a decision rather than a
 * formality — the answer to "do I need more than one" is "only once you are
 * busy", and the shop tells you by losing things. A flat rate would be one
 * purchase, one permanent tax, and nothing to do about it ever again.
 *
 * Its control is doubled, because two things have to stay opt-in. A shop that
 * never bought the rung must still queue — and, the sharper half, must take no
 * RNG DRAW: every balance figure in this game is downstream of how many times
 * `this.rng` has been called, so a miss roll on an ordinary counter sale would
 * move every basket, crop and spawn after it in every save in existence, and
 * two `simulate` runs either side of this file would diverge with nothing in
 * the output to say why.
 *
 * The rest:
 *
 * - **No queue at all**, asserted as a value on both sides — `till.queue` empty
 *   and the shopper never in `TO_TILL`, against a control that does both.
 * - **Busier misses more**, and **more covers miss less**. Comparisons rather
 *   than values, or the assertions pass whatever the constants become.
 * - **The cap holds.** A shop slammed to ten times its cover must not approach
 *   billing nothing: a mechanic that looks broken when it is working hardest is
 *   one nobody trusts enough to buy.
 * - **Conservation.** A missed line still leaves in the shopper's arms and
 *   still left the shelf. This is a new place goods move without money changing
 *   hands, and every one of those in this game has been a hole.
 * - **The money adds up**, billed plus unbilled, and **it banks** rather than
 *   landing on a counter that is not there — which is `verify:till`'s claim
 *   about the self-checkout, inverted, and it has to be inverted deliberately.
 * - **Shrinkage moves no reputation.** Nobody who walked in today saw it. Same
 *   argument that keeps spoilage out of `REP_CAUSES`.
 * - **The demand meter still counts what left.** `sold` and `revenue` drop the
 *   missed lines and `byItem` keeps them, because demand is a fact about the
 *   floor rather than about the takings. Those two must NOT be "unified".
 *
 * Runs on ephemeral Games, so it never touches the live shop. It does write one
 * piece into the content database — usually the live shared one — so it cleans
 * up on exit, the same way `verify-till` and `verify-catalog` do.
 *
 *   node scripts/verify-walkout.js
 */

import { Game } from '../server/sim/index.js';
import { isWalkable } from '../server/layout.js';
import { silenceMilestones } from '../server/sim/goals.js';
import { writeContent } from '../server/content.js';
import { remove } from '../server/db.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const close = (a, b, label, tol = 1e-6) => check(Math.abs(a - b) < tol, label, `expected ~${b}, got ${a}`);

/**
 * A checkout design of this sweep's own, with both halves of the ladder on it.
 *
 * `COVERS` is deliberately small. The shipped rung reads about as many people
 * as a till used to serve, which is a sensible number to play with and a
 * useless one to test against — a shop would have to be genuinely packed before
 * the curve moved. Four means three shoppers and twelve are unmistakably
 * different loads, and if the shipped ladder is ever retuned this file must not
 * start failing over a balance decision it has no opinion about.
 *
 * Tier 1 is the control and is exactly what every checkout in the game already
 * is: no `covers`, no opinion, the old shop.
 */
const PIECE = 'zz-walkout-piece';
const COVERS = 4;
const TEST_TILL = {
  id: PIECE, kind: 'checkout', name: 'Test Gate', cost: 0,
  model: { parts: [{ shape: 'box', color: '#8a8a92', pos: [0, 0.3, 0], scale: [0.7, 0.6, 0.7] }] },
  tiers: [
    { name: 'Counter', cost: 0 },
    { name: 'Sensors', cost: 0, covers: COVERS },
  ],
};
const PLAIN = 1;
const SENSOR = 2;

/**
 * The sweep's own shopper.
 *
 * `spawnCustomer()` with no id takes a WEIGHTED DRAW over whatever archetypes
 * the live content database happens to hold, and `basket_min`/`basket_max` then
 * decide how many rolls building their list takes — so authoring a new customer
 * type in another window moves this file's whole RNG stream and a shopper twelve
 * spawns later ends up somewhere `pathTo` cannot leave. What that reads as is
 * this sweep failing on a claim about counters, days after somebody added a
 * Gym Rat, and there is nothing in the output connecting the two.
 *
 * So it authors its own, the way this file already authors its own till and its
 * own item: fixed weight, fixed basket, nothing anybody else can move. It is
 * still a weighted draw, but over a pool this file controls — the two spawn
 * weights it does not control are irrelevant because `spawnCustomer` is asked
 * for this id by name.
 */
const SHOPPER = 'zz-walkout-shopper';
{
  const res = writeContent('archetype', {
    id: SHOPPER,
    name: 'Walkout Test Shopper',
    affinities: { pantry: 1 },
    basket_min: 1,
    basket_max: 1,
    patience: 600,
    spawn_weight: 0,
  }, 'verify');
  check(res.ok, `the catalog accepts ${SHOPPER}`, res.error ?? '');
}

// Registered before the first write, not after the last: a crash halfway
// through must not leave a Test Gate on somebody's build menu.
process.on('exit', () => {
  try { remove('fixtures', PIECE); } catch { /* the DB is already gone */ }
  try { remove('archetypes', SHOPPER); } catch { /* the DB is already gone */ }
});

{
  const res = writeContent('fixture', TEST_TILL, 'verify');
  check(res.ok, `the catalog accepts ${PIECE}`, res.error ?? '');
  // The schema is half the feature: a rung authored with `covers` that parsed
  // into a rung without one would leave every assertion below testing the
  // control twice and passing.
  const back = res.ok ? (res.row ?? TEST_TILL).tiers?.[1]?.covers : undefined;
  eq(back, COVERS, 'and keeps `covers` through the parse');
}

/** The same pinned shop the other build sweeps use. */
const SHOP = { shelf: 6, freezer: 1, checkout: 1, plot: 4 };

/**
 * A shop of a known shape, owning nothing and employing nobody.
 *
 * `roster` is cleared for `verify-till`'s reason — a clerk the live save happens
 * to own would stand at the counter and serve the queue the control is asserting
 * nobody serves. `shell` is cleared because a stored shell makes every budget
 * zero and the sweep would get a shop with no checkout in it at all.
 */
function fresh() {
  const g = Game.create({ worldId: 'verify-walkout', seed: 'walkout', ephemeral: true });
  g.placements = [];
  g.grow = { w: 0, h: 0 };
  g.doorShift = 0;
  g.edits = [];
  g.ground = [];
  g.yardStamped = false;
  g.shell = null;
  g.ownedUpgrades = [];
  g.roster = [];
  silenceMilestones(g);
  g.regenerateLayout(null, {}, { want: SHOP });
  g.freezeShell();
  g.freezeYard();
  g.cash = 0;
  return g;
}

/**
 * Put the shop's checkouts on a given rung, through the real placement path.
 *
 * `freezeShell` has already turned everything generated into a placement, so
 * this is exactly what upgrading one does: change the placement, re-flow, read
 * back what the generator laid. Writing `tier` onto the live record instead
 * would test a field rather than a purchase.
 */
function rebuild(g, tier, count = 1) {
  const tills = g.placements.filter((p) => p.kind === 'checkout');
  for (const p of tills) { p.piece = PIECE; p.tier = tier; }
  // A second sensor is a second placement, not a bigger number on the first —
  // the whole claim in section 3b is that the shop buys HARDWARE to keep up.
  while (g.placements.filter((p) => p.kind === 'checkout').length < count) {
    const from = tills[0];
    const spare = g.placements.find((p) => p.kind === 'checkout' && p !== from);
    if (spare) break;
    g.placements.push({ ...from, id: `${from.id}-x${count}`, x: from.x, z: from.z + 2 });
  }
  g.regenerateLayout();
  return g.layout.checkouts;
}

const ITEM = 'zz-walkout-thing';
const PRICE = 3;

/**
 * The tile just inside the front door — where somebody who has walked in is.
 *
 * `spawnCustomer` puts a new shopper on `approach.off`, which is deliberately
 * **off the tile grid entirely** (`{x: 10, z: 29}` on a map 22 deep), and hands
 * them a route in from it; the first leg of that walk is the one leg that has
 * no tile under it. So a fixture that keeps the spawn and throws the route away
 * has not built somebody stood in the shop, it has built somebody stood off the
 * edge of the world — see `regenerateLayout`, which despawns exactly that
 * person on the stated grounds that "A\* can't route out of a tile that doesn't
 * exist".
 *
 * Which is invisible in all but one assertion in this file, because nothing
 * else here walks anywhere: `walkOut`, `completeSale` and the miss curve are
 * arithmetic about somebody's basket and never ask where their feet are. The
 * one that does ask is section 1's counter walk, and what it reads as is the
 * SHOP being wrong — a plain till that sends people home — rather than as a
 * shopper who was never in it.
 *
 * Worse, it failed *intermittently*, which is what kept it alive. `findPath`
 * keys its grid `z * w + x`, so a start off the WEST edge (`x: -8`) wraps to a
 * perfectly ordinary in-bounds cell and the search succeeds from a tile nobody
 * chose, while one off the SOUTH edge (`z: 29`) indexes past the end and fails.
 * Four of the eight approaches are each. So whether this file passed came down
 * to which approach `rng.pick` landed on, and that moves whenever the content
 * database does — which is why it went red the day eleven archetypes were
 * authored, pointing at a shop and a counter that had not changed.
 */
function standTile(g) {
  const L = g.layout;
  const door = { x: L.door.x, z: L.door.z - 1 };
  if (isWalkable(g.walk, L, door.x, door.z)) return door;
  // A shop shaped differently than this file's own `SHOP` would still get an
  // answer rather than the edge of the world. Scanning is fine here — it runs
  // a few dozen times in a sweep, never in the game.
  for (let z = 0; z < L.h; z++) {
    for (let x = 0; x < L.w; x++) {
      if (L.indoor?.[z * L.w + x] && isWalkable(g.walk, L, x, z)) return { x, z };
    }
  }
  return door;
}

/**
 * Somebody stood in the shop with shopping in their basket.
 *
 * Built directly rather than walked in off the street, for `verify-till`'s
 * reason: a browse is a long RNG draw against whatever is on the shelves today,
 * and this file is about what happens once somebody has decided to leave.
 * `BROWSE` rather than the state they spawn in, because `customersInside` — the
 * divisor the whole curve hangs off — does not count anybody still on the path
 * outside.
 *
 * ...and standing on a real tile, which is the half that was missing — see
 * `standTile`. They all stand on the same one deliberately: a body is a
 * SURCHARGE on a step and never a wall (`CROWD`, capped at four in
 * `pathing.js`), so a dozen of them on the doormat is a slightly dearer route
 * through the door and not a shop nobody can cross. Spreading them out would
 * be a second thing this file decides that the feature does not depend on.
 */
function shopper(g, lines = 1) {
  const res = g.spawnCustomer(SHOPPER);
  if (!res.ok) return null;
  const cust = g.customers[res.id];
  cust.state = 'BROWSE';
  cust.path = null;
  const stand = standTile(g);
  cust.x = stand.x;
  cust.z = stand.z;
  cust.mood = 1;
  cust.patience = 1e6;
  cust.basket = Array.from({ length: lines }, () => ({ item_id: ITEM, price: PRICE }));
  return cust;
}

/** Fill the shop to a given headcount, so `walkoutMiss` has a load to read. */
function crowd(g, n) {
  const made = [];
  while (g.customersInside() < n) {
    const c = shopper(g, 0);
    if (!c) break;
    made.push(c);
  }
  return made;
}

/**
 * How many times the measured stream was drawn from while `fn` ran.
 *
 * The control's sharpest claim, and it cannot be made any other way: `this.rng`
 * is re-seeded `seed:day`, so its VALUE tells you nothing about how many times
 * it has been asked. Counting the calls is the only form of "this change is
 * free to every existing save" there is.
 */
function draws(g, fn) {
  const real = g.rng.next.bind(g.rng);
  let n = 0;
  g.rng.next = () => { n++; return real(); };
  try { fn(); } finally { g.rng.next = real; }
  return n;
}

// ---------------------------------------------------------------------------
// 1. The control, doubled: a shop with no `covers` is the old game.
//
// The first half is the visible one — a counter still has a line and a shopper
// still walks to it. The second is the half that decides whether this feature
// is opt-in or a change to every balance figure ever recorded in this repo.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const [till] = rebuild(g, PLAIN);

  eq(g.walkoutCovers(), 0, 'a plain counter covers nobody');
  eq(g.walkoutMiss(), 0, '...and misses nothing, whoever is in the shop');

  crowd(g, 12);
  eq(g.walkoutMiss(), 0, '...still nothing, with the shop packed');

  const cust = shopper(g);
  g.goToTill(cust);
  eq(cust.state, 'TO_TILL', 'a shopper with no sensors in the shop walks to the counter');
  check(till.queue?.includes(cust.id), '...and joins its queue');

  // The one that costs every save in the game if it is wrong.
  const paying = shopper(g);
  eq(draws(g, () => g.completeSale(paying)), 0, 'a counter sale takes no RNG draw');
  eq(g.stats.unbilled, 0, '...and nothing walks out unbilled');
  // The other half of section 2's banking claim. On its own that one is a value,
  // and a value passes on a harness where the money never moved at all — so the
  // control has to show a counter sale really does leave a pile to sweep up.
  check(g.cashDrops.length > 0, '...and its takings land on the counter as always');
}

// ---------------------------------------------------------------------------
// 2. With sensors, the queue stops existing.
//
// Both halves as values, because "there is no queue" passes just as well on a
// harness where nothing happens at all — so the shopper has to come out the
// other side holding their shopping and the shop has to be the richer for it.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const [gate] = rebuild(g, SENSOR);

  eq(g.walkoutCovers(), COVERS, 'a sensor rung covers its authored number');

  const cust = shopper(g, 2);
  const before = g.cash;
  g.goToTill(cust);

  eq(cust.state, 'LEAVE', 'a shopper in a sensor shop is billed where they stand');
  eq(gate.queue?.length ?? 0, 0, '...and no line is laid at all');
  eq(cust.till, null, '...and they are assigned to no checkout');
  eq(cust.basket.length, 0, '...their basket is emptied');
  eq(cust.bought.length, 2, '...and they leave holding what they came for');

  // The money is not on a counter, because there is not one. This is
  // `verify:till`'s claim about the self-checkout deliberately inverted: a till
  // that banked its takings would retire the one job the machine cannot do for
  // you, and a sensor that dropped cash on the floor would be inventing a
  // counter the shop has just paid to get rid of.
  check(g.cash > before, 'the takings bank rather than landing on a counter');
  eq(g.cashDrops.length, 0, '...with nothing dropped on the floor');
}

// ---------------------------------------------------------------------------
// 3. The curve — the centrepiece, and the thing the rung is priced on.
//
// Comparisons throughout, never values. Every expected figure here would be
// arithmetic on `WALKOUT_MISS`, and an assertion against the constant that
// computes it passes whatever that constant becomes.
// ---------------------------------------------------------------------------
{
  // 3a. Busier misses more.
  const g = fresh();
  rebuild(g, SENSOR);

  crowd(g, 2);
  const quiet = g.walkoutMiss();
  crowd(g, COVERS * 3);
  const busy = g.walkoutMiss();

  check(quiet > 0, 'a sensor shop always misses something');
  check(busy > quiet, 'and a busy shop misses more than a quiet one', `${busy} vs ${quiet}`);

  // ...and it is a DIAL rather than a boolean wearing a float: three loads, three
  // answers. A curve that stepped once would pass the comparison above while
  // being "perfect until suddenly bad", which is not what anybody is buying.
  const g2 = fresh();
  rebuild(g2, SENSOR);
  const seen = [];
  for (const n of [2, 4, 8]) { crowd(g2, n); seen.push(g2.walkoutMiss()); }
  check(seen[0] < seen[1] && seen[1] < seen[2], 'the miss rate is a dial, not a step', seen.join(' / '));
}

{
  // 3b. ...and more covers miss less, at the SAME load. This is the half the
  // player actually buys, and without it "scales with load" is satisfied by a
  // mechanic you can do nothing about.
  const one = fresh();
  rebuild(one, SENSOR, 1);
  crowd(one, 8);
  const alone = one.walkoutMiss();

  const two = fresh();
  const gates = rebuild(two, SENSOR, 2);
  crowd(two, 8);

  eq(gates.length, 2, 'a second sensor is a second fixture');
  eq(two.walkoutCovers(), COVERS * 2, '...and its covers add up');
  check(two.walkoutMiss() < alone, 'buying another sensor cuts the losses at the same crowd',
    `${two.walkoutMiss()} vs ${alone}`);
}

{
  // 3c. The cap. A shop slammed to ten times its cover must still bill most of
  // what goes out of it — not because that is generous, but because a mechanic
  // that looks broken when it is working hardest is one nobody buys.
  const g = fresh();
  rebuild(g, SENSOR);
  crowd(g, COVERS * 40);
  check(g.walkoutMiss() <= 0.5, 'the miss rate is capped however slammed the shop is', `${g.walkoutMiss()}`);
  check(g.walkoutMiss() > 0.1, '...but a hopeless overload really is hopeless', `${g.walkoutMiss()}`);
}

// ---------------------------------------------------------------------------
// 4. Conservation, and the books.
//
// A missed line is a new way for goods to leave the shop without money coming
// back, and every new place goods can move in this game has been a hole. Run
// over a lot of baskets so the roll actually fires: at a low miss rate a single
// sale proves nothing, and a sweep that asserted on one would pass on a
// mechanic that never fired at all.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  rebuild(g, SENSOR);
  crowd(g, COVERS * 2);          // a real miss rate, well inside the cap

  const LINES = 3;
  const SALES = 300;
  let left = 0;
  const before = g.cash;

  for (let i = 0; i < SALES; i++) {
    const cust = shopper(g, LINES);
    if (!cust) break;
    g.goToTill(cust);
    left += cust.bought.length;
    // They are off the map as far as this sweep is concerned, and leaving them
    // standing about would climb the load under the very curve being measured.
    delete g.customers[cust.id];
  }

  const worth = left * PRICE;
  const banked = g.cash - before;

  eq(left, SALES * LINES, 'every unit that was in a basket leaves in somebody\'s arms');
  check(g.stats.unbilled > 0, '...and the sensors really did miss some of it', `${g.stats.unbilled}`);
  check(g.stats.unbilled < left, '...but not all of it');
  close(banked + g.stats.unbilledValue, worth, 'billed plus unbilled is exactly what the shopping was worth', 0.01);
  eq(g.stats.sold, left - g.stats.unbilled, '`sold` counts what was paid for and nothing else');

  // The split that a later tidy-up would "unify", which is why it is pinned:
  // demand is a fact about the shop FLOOR rather than about the takings, so a
  // pizza that walked out unbilled is still a pizza this shop moved. Narrowed
  // to the billed lines, a shop would lose its busiest days' readings and be
  // told to order less as a result.
  eq(g.stats.byItem[ITEM], left, 'the demand meter counts everything that left, billed or not');

  // Shrinkage is money, not reputation. Nobody who walked in today saw it —
  // the same argument that keeps spoilage out of `REP_CAUSES`.
  check(!('unbilled' in g.stats.repMoves), 'shrinkage opens no reputation bucket');
  check(!('shrink' in g.stats.repMoves), '...under either spelling');
}

// ---------------------------------------------------------------------------
// 5. ...and the day says so, in words, naming something to be annoyed about.
//
// The loss is otherwise a number nobody is ever shown: a shop bleeding 8% has
// exactly the same takings graph as a shop that is 8% quieter. "3.4% shrinkage"
// is a figure and "9x Frozen Pizza" is a grievance, and only one of those gets
// somebody to put another sensor in.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const said = g.saidUnbilled({
    unbilled: 9, unbilledValue: 31.5, revenue: 100, unbilledItems: { [ITEM]: 9 },
  });
  check(said.includes('9x'), 'the day names what walked out', said);
  check(said.includes('31.50'), '...and what it was worth', said);
  check(said.includes('Another sensor'), '...and says what to do when it is worth doing', said);

  const mild = g.saidUnbilled({
    unbilled: 1, unbilledValue: 0.4, revenue: 400, unbilledItems: { [ITEM]: 1 },
  });
  check(!mild.includes('Another sensor'), '...and holds its tongue over one dropped apple', mild);
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ ${failures.length} of ${checks} checks failed:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ walk-out: ${checks} checks passed`);
