#!/usr/bin/env node
/**
 * VERIFY: THE SHOPPER WHO DOES NOT PAY.
 *
 * The shop's first loss with a person attached to it — see docs/security.md.
 * Everything before it was a tax: spoilage is a clock, orphaned goods are a
 * deleted row, walk-out shrinkage is a sensor misreading a crowd. A thief is
 * the first one you could in principle do something about, and step 3 is where
 * that becomes true.
 *
 * Which makes this file mostly about a shopper who is doing something
 * ORDINARY-looking. A thief is a `LEAVE` with a flag on it, deliberately (see
 * `stealAway`), so from every angle that matters they are a customer walking out
 * of a shop with goods in their arms — exactly what a paid trip looks like, at a
 * slightly different speed. Nothing here is visible in a still frame.
 *
 * Its control is doubled, because two things have to stay opt-in: an archetype
 * with no `steal_chance` must never be rolled for, and — the sharper half — must
 * take no RNG DRAW, or every balance figure ever recorded in this repo is
 * measuring a different stream. Same claim `verify:walkout` makes about a
 * counter sale, for the same reason, and it has to be made again because it is
 * a different branch of the same function.
 *
 * The rest:
 *
 * - **Conservation.** The goods leave in their arms rather than being deleted,
 *   which is what makes catching them buildable at all. A `stealAway` that
 *   simply binned the stock would pass every other assertion here and make step
 *   3 impossible without undoing it.
 * - **No money moves, in either direction.** Not the till, not the bank, and
 *   nothing dropped on the floor.
 * - **No reputation moves.** Nobody who walked in today saw it — the argument
 *   that keeps spoilage out of `REP_CAUSES`. A robbery is witnessed and is step
 *   5.
 * - **They are quicker than everybody else**, and the ordering against a
 *   storm-out is asserted rather than assumed, because those two are the same
 *   picture and step 2 exists to tell them apart.
 * - **The two sets of books stay separate.** Stolen and unbilled are the same
 *   units and the same money and prescribe opposite fixes, so a shop must never
 *   be able to report one as the other.
 * - **A thief never joins a queue**, which is the actual behaviour change, and
 *   is asserted against a control that does.
 *
 * Runs on ephemeral Games. Authors one archetype and one item, and removes both
 * on exit, the way `verify-till` and `verify-catalog` do.
 *
 *   node scripts/verify-theft.js
 */

import { Game } from '../server/sim/index.js';
import { silenceMilestones } from '../server/sim/goals.js';
import { content, writeContent } from '../server/content.js';
import { remove } from '../server/db.js';
import { E } from '../shared/edges.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const ITEM = 'zz-theft-thing';
const HONEST = 'zz-theft-honest';
const CROOK = 'zz-theft-crook';
const PRICE = 4;

/**
 * A shoplifter who ALWAYS steals, and an identical shopper who never does.
 *
 * 1 and 0 rather than anything in between, for `verify-till`'s reason: a
 * probability makes every assertion below a sampling argument, and the thing
 * being tested is a branch rather than a distribution. The honest one is the
 * control and is authored identically in every other respect, because nearly
 * every way of getting this wrong makes too MANY people steal.
 */
process.on('exit', () => {
  for (const [t, id] of [['archetypes', HONEST], ['archetypes', CROOK], ['items', ITEM]]) {
    try { remove(t, id); } catch { /* the DB is already gone */ }
  }
});

{
  const base = {
    affinities: {}, price_sensitivity: 0, patience: 600,
    budget_min: 999, budget_max: 999, basket_min: 1, basket_max: 1,
    // Never drawn by the shop's own spawner — every shopper in here is built by
    // hand, and a test archetype loose in a live world is somebody else's bug.
    spawn_weight: 0,
  };
  for (const [id, name, steal] of [[HONEST, 'Test Shopper', 0], [CROOK, 'Test Crook', 1]]) {
    const res = writeContent('archetype', { id, name, ...base, steal_chance: steal }, 'verify');
    check(res.ok, `the catalog accepts ${id}`, res.error ?? '');
  }
  const res = writeContent('item', {
    id: ITEM, name: 'Test Thing', tags: ['produce'], base_cost: 1, base_price: PRICE,
  }, 'verify');
  check(res.ok, 'the catalog accepts the item', res.error ?? '');
}

const SHOP = { shelf: 6, freezer: 1, checkout: 1, plot: 4 };

function fresh() {
  const g = Game.create({ worldId: 'verify-theft', seed: 'theft', ephemeral: true });
  g.placements = [];
  g.grow = { w: 0, h: 0 };
  g.doorShift = 0;
  g.edits = [];
  g.ground = [];
  g.paint = {};
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

/** Somebody done shopping, holding one thing, about to decide how to leave. */
function shopper(g, archId) {
  const res = g.spawnCustomer();
  if (!res.ok) return null;
  const cust = g.customers[res.id];
  cust.archetype_id = archId;
  cust.state = 'BROWSE';
  cust.path = null;
  cust.mood = 1;
  cust.patience = 1e6;
  cust.basket = [{ item_id: ITEM, price: PRICE }];
  return cust;
}

/**
 * The archetype row as the sim would hand it to `goToTill`.
 *
 * Read back through the registry rather than reusing the literal written above,
 * so this exercises what the schema and the column actually stored. A sweep that
 * passes its own object in is testing the object.
 */
const archOf = (id) => content().byId.archetypes[id];

/** How many times the measured stream was drawn from while `fn` ran. */
function draws(g, fn) {
  const real = g.rng.next.bind(g.rng);
  let n = 0;
  g.rng.next = () => { n++; return real(); };
  try { fn(); } finally { g.rng.next = real; }
  return n;
}

// ---------------------------------------------------------------------------
// 1. The control, doubled: nobody steals unless somebody authored a thief.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const till = g.layout.checkouts[0];
  const cust = shopper(g, HONEST);

  const n = draws(g, () => g.goToTill(cust, archOf(HONEST)));
  eq(cust.stole, false, 'a shopper with no steal_chance does not steal');
  eq(cust.state, 'TO_TILL', '...and walks to the counter like anybody else');
  check(till.queue?.includes(cust.id), '...and joins the queue');
  eq(g.stats.stolen, 0, '...and nothing is tallied against the shop');
  // The half that costs every balance figure in the repo if it is wrong.
  eq(n, 0, 'and an honest archetype takes no RNG draw at all');

  // ...and an archetype row that predates the column entirely, which is every
  // row in `data/seed` — read back as 0 rather than as undefined, or the
  // comparison below is `undefined < random()` and nobody ever steals by luck.
  const legacy = { ...archOf(HONEST) };
  delete legacy.steal_chance;
  const other = shopper(g, HONEST);
  eq(draws(g, () => g.goToTill(other, legacy)), 0, 'an archetype with no such column is not rolled for');
  eq(other.stole, false, '...and does not steal');
}

// ---------------------------------------------------------------------------
// 2. A thief walks out with the goods, and the goods are still on them.
//
// The conservation claim is the one that matters most, and it is about step 3
// rather than about step 1: `bought` is what makes a chase worth having, and a
// `stealAway` that deleted the stock would look completely correct here.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const till = g.layout.checkouts[0];
  const cust = shopper(g, CROOK);
  const cashBefore = g.cash;

  g.goToTill(cust, archOf(CROOK));

  eq(cust.stole, true, 'a thief is marked as one');
  eq(cust.state, 'LEAVE', '...and is an ordinary LEAVE, which is the whole design');
  eq(cust.till, null, '...assigned to no checkout');
  eq(till.queue?.length ?? 0, 0, '...and never in the queue');
  eq(cust.basket.length, 0, 'the basket is emptied');
  eq(cust.bought.length, 1, '...into their arms, where step 3 can still get it back');
  eq(cust.bought[0].item_id, ITEM, '...and it is the thing they took');

  // No money, in either direction.
  eq(g.cash, cashBefore, 'no money moves');
  eq(g.stats.revenue, 0, '...none is banked');
  eq(g.cashDrops.length, 0, '...and none lands on the counter');
  eq(g.stats.sold, 0, '...and it does not count as a sale');

  // The books.
  eq(g.stats.stolen, 1, 'the unit is tallied as stolen');
  eq(g.stats.stolenValue, PRICE, '...at what it would have sold for');
  eq(g.stats.stolenItems[ITEM], 1, '...and named, so the day can say what went');

  // Not the sensors' books. These are the same units and the same money and
  // prescribe opposite fixes — another sensor, or standing nearer the door.
  eq(g.stats.unbilled, 0, 'a theft is not reported as shrinkage');
  eq(g.stats.unbilledValue, 0, '...under either tally');

  // Nobody saw it, so the town has no opinion. Spoilage's argument exactly.
  eq(Object.keys(g.stats.repMoves).length, 0, 'and reputation does not move');
}

// ---------------------------------------------------------------------------
// 3. They leg it — and quicker than the shopper who merely gave up on you.
//
// Asserted as an ordering rather than a value. Both are people crossing the
// shop toward the door at a clip, which is the same picture from any camera,
// and step 2 exists precisely because that is not enough to go on.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const walker = shopper(g, HONEST);
  const stormer = shopper(g, HONEST);
  const thief = shopper(g, CROOK);
  stormer.storming = true;
  g.goToTill(thief, archOf(CROOK));

  const walk = g.fleeSpeed(walker);
  const storm = g.fleeSpeed(stormer);
  const flee = g.fleeSpeed(thief);

  eq(walk, 1, 'an ordinary shopper leaves at a walk');
  check(storm > walk, 'somebody storming out is quicker than that', `${storm} vs ${walk}`);
  check(flee > storm, '...and a thief is quicker again', `${flee} vs ${storm}`);
  // The promise step 3 is built on. A thief slower than a sprint is catchable
  // and a thief faster than one is a chase nobody would start; this file cannot
  // see the player's sprint yet, so it pins the half it can.
  check(flee < 3, 'but not so quick that no sprint could ever close on them', `${flee}`);
}

// ---------------------------------------------------------------------------
// 4. The mark reaches the client, which is the whole of step 2's data.
//
// A thief IS a `LEAVE`, so nothing else on the wire distinguishes them — and a
// snapshot that dropped this would leave the alert with nobody to point at.
// The absence on an honest shopper is asserted too, because "always true" is
// the shape that passes both halves of this by accident.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const thief = shopper(g, CROOK);
  const honest = shopper(g, HONEST);
  g.goToTill(thief, archOf(CROOK));
  g.goToTill(honest, archOf(HONEST));

  const wire = g.snapshot().customers;
  const t = wire.find((c) => c.id === thief.id);
  const h = wire.find((c) => c.id === honest.id);

  check(t, 'the thief is on the wire');
  eq(t?.stole, true, '...and marked as one');
  check(h && !('stole' in h), 'an honest shopper carries no mark at all', JSON.stringify(h?.stole));
  // They are carrying it visibly, or the chase is after somebody empty-handed.
  check((t?.basket?.length ?? 0) > 0, 'and the goods are drawn in their arms');
}

// ---------------------------------------------------------------------------
// 5. The chase is winnable and losable — driven, not compared.
//
// THE centrepiece, and it is a behaviour test on purpose. Asserting
// `THIEF_SPEED > 1` and `SPRINT_SPEED > 1` would pass on the numbers this
// shipped with for ten minutes, where a thief ran at 3.85 against a 4.2 walk
// and every chase in the game was won by strolling — two constants that look
// perfectly sensible apart and are broken together. So: put a player behind a
// thief, run both movers for real, and measure the gap.
// ---------------------------------------------------------------------------
{
  /** Run a straight-line chase down an open corridor and report the gap. */
  const chase = (sprint) => {
    const g = fresh();
    const thief = shopper(g, CROOK);
    g.goToTill(thief, archOf(CROOK));

    const me = g.addPlayer('me', 'Tester');
    // Both put on open ground running the same way, so this measures the two
    // speeds and not two different routes round the shelving.
    const z = g.layout.store.z + g.layout.store.h + 2;
    Object.assign(me, { x: 6, z, path: null, stamina: 1 });
    Object.assign(thief, { x: 9, z, path: [{ x: 24, z }], state: 'LEAVE' });

    const gap0 = thief.x - me.x;
    for (let i = 0; i < 20; i++) {
      g.setInput('me', 1, 0, sprint);
      g.stepPlayers(0.1);
      thief.path = [{ x: 24, z }];
      followPathOnce(g, thief, 0.1);
    }
    return { gap: thief.x - me.x, was: gap0, stamina: me.stamina };
  };

  // `followPath` is module-private, so the thief is walked the way the sim
  // walks them — through the real speed function, which is the thing under test.
  function followPathOnce(g, cust, dt) {
    const goal = cust.path[0];
    const speed = 2.2 * g.fleeSpeed(cust);
    const d = goal.x - cust.x;
    cust.x += Math.sign(d) * Math.min(Math.abs(d), speed * dt);
  }

  const walked = chase(false);
  const sprinted = chase(true);

  check(walked.gap > walked.was, 'walking after a thief LOSES ground',
    `gap ${walked.was.toFixed(2)} -> ${walked.gap.toFixed(2)}`);
  check(sprinted.gap < sprinted.was, '...and sprinting closes it',
    `gap ${sprinted.was.toFixed(2)} -> ${sprinted.gap.toFixed(2)}`);
  check(sprinted.stamina < 1, 'sprinting costs stamina', `${sprinted.stamina}`);
  eq(walked.stamina, 1, '...and walking costs none');
}

// ---------------------------------------------------------------------------
// 6. Stamina is a budget that runs out and comes back.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const me = g.addPlayer('me', 'Tester');
  Object.assign(me, { x: 8, z: g.layout.store.z + g.layout.store.h + 2, path: null, stamina: 1 });

  // Held down while going nowhere is free, deliberately — the bar is for
  // closing a gap, and draining it by leaning on a key in an empty shop would
  // mean arriving at the one moment it matters with none of it.
  g.setInput('me', 0, 0, true);
  for (let i = 0; i < 30; i++) g.stepPlayers(0.1);
  eq(me.stamina, 1, 'sprinting on the spot costs nothing');

  // ...and run it flat.
  g.setInput('me', 1, 0, true);
  for (let i = 0; i < 100; i++) g.stepPlayers(0.1);
  let emptied = false;
  for (let i = 0; i < 100 && !emptied; i++) {
    g.stepPlayers(0.1);
    emptied = me.stamina === 0;
  }
  check(emptied, 'a long sprint empties the bar');
  // One more tick, deliberately: the tick that SPENDS the last of the bar was a
  // sprinting tick and is supposed to have been. Stopping is the next tick's
  // job, and asserting it on the same one would be pinning an off-by-one as if
  // it were the rule.
  g.stepPlayers(0.1);
  check(!me.sprinting, '...and the next tick stops you sprinting');
  check(me.winded, '...and leaves you winded');

  /**
   * ...and the recovery comes in STRETCHES, which is the bug this sweep found.
   *
   * Counted as rising edges rather than as sprinting ticks, because "it never
   * sprints again" is the wrong claim — once a real chunk of the bar is back
   * you are supposed to be able to run again, and an assertion that forbade it
   * would be pinning a worse game. What is wrong is the SHAPE: with no
   * hysteresis a sliver of regen buys exactly one sprinting tick, so holding
   * the key gives dozens of restarts a second. It is invisible in the bar,
   * which is sat on the floor throughout either way, and reads as the sprint
   * key being broken rather than as being out of puff.
   */
  let edges = 0;
  let was = me.sprinting;
  for (let i = 0; i < 200; i++) {
    g.setInput('me', 1, 0, true);
    g.stepPlayers(0.1);
    if (me.sprinting && !was) edges++;
    was = me.sprinting;
  }
  // The gap between the two worlds is the whole assertion, so the bound is
  // loose on purpose: with hysteresis this is a handful of long runs, and
  // without it the same twenty seconds gives sixty-odd. A tight threshold here
  // would be pinning the exact regen constants, which this file has no opinion
  // about.
  check(edges <= 8, 'a spent bar recovers in stretches rather than strobing',
    `${edges} sprint restarts in 20s`);

  // ...and the rest beat, driven rather than poked: a short real sprint, then
  // let go. Writing `stamina = 0` by hand would leave `staminaRest` at whatever
  // the last loop left it, and the assertion would pass or fail for a reason
  // unconnected to the code under test.
  const g2 = fresh();
  const you = g2.addPlayer('you', 'Tester');
  Object.assign(you, { x: 8, z: g2.layout.store.z + g2.layout.store.h + 2, path: null, stamina: 1 });
  g2.setInput('you', 1, 0, true);
  for (let i = 0; i < 8; i++) g2.stepPlayers(0.1);
  const spent = you.stamina;
  check(spent < 1, 'a short sprint spends some of the bar', `${spent}`);

  g2.setInput('you', 0, 0, false);
  for (let i = 0; i < 5; i++) g2.stepPlayers(0.1);
  eq(you.stamina, spent, '...which does not start coming back during the rest beat');
  for (let i = 0; i < 200; i++) g2.stepPlayers(0.1);
  eq(you.stamina, 1, '...but does after it');
  check(!you.winded, '...and a full bar is not winded');
}

// ---------------------------------------------------------------------------
// 7. The tazer: the refusals, and what a catch actually does.
//
// The conservation claim is the one that matters — the goods come back to the
// FLOOR rather than being conjured onto a shelf or quietly deleted, and the
// books have to agree afterwards or a caught thief still shows in tomorrow's
// losses.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const thief = shopper(g, CROOK);
  g.goToTill(thief, archOf(CROOK));
  const honest = shopper(g, HONEST);

  const me = g.addPlayer('me', 'Tester');
  Object.assign(me, { x: thief.x + 20, z: thief.z, path: null });

  check(!g.taze('me', thief.id).ok, 'a tazer does not reach across the shop');
  check(!g.taze('me', honest.id).ok, '...and never fires at somebody who took nothing');
  check(!g.taze('me', 'nobody').ok, '...or at nobody at all');

  // Walk up and take the shot.
  Object.assign(me, { x: thief.x + 1, z: thief.z });
  const crates = g.deliveries.length;
  const res = g.taze('me', thief.id);

  check(res.ok, 'up close it fires', res.error ?? '');
  eq(res.recovered, 1, '...and gets the goods back');
  eq(thief.bought.length, 0, '...off the thief');
  eq(g.deliveries.length, crates + 1, '...onto the floor as an ordinary crate');
  eq(g.deliveries.at(-1).stacks[0].item_id, ITEM, '...holding what they took');
  eq(g.stats.recovered, 1, 'the catch is tallied');
  eq(g.stats.stolen, 0, '...and the loss is netted back off the day');
  eq(g.stats.stolenValue, 0, '...in money too');
  check(!(ITEM in g.stats.stolenItems), '...and the item stops being named as stolen');

  // They stay marked, and they stop running.
  eq(thief.stole, true, 'a caught thief is still a thief');
  eq(thief.caught, true, '...and is marked as caught');
  eq(g.fleeSpeed(thief), 1, '...and leaves at a walk, or the tazer looks broken');

  // The cooldown is the price of the shot.
  check((me.tazeCooldown ?? 0) > 0, 'the tazer goes on cooldown');
  check(!g.taze('me', thief.id).ok, '...and refuses until it is charged');

  // And an emptied thief is not a second helping.
  const other = shopper(g, CROOK);
  g.goToTill(other, archOf(CROOK));
  me.tazeCooldown = 0;
  Object.assign(me, { x: other.x, z: other.z });
  g.taze('me', other.id);
  me.tazeCooldown = 0;
  check(!g.taze('me', other.id).ok, 'somebody already emptied cannot be tazed again');
}

// ---------------------------------------------------------------------------
// 8. The guard — deterrence off the roster, and a catch that is the same catch.
//
// Its control is the shop everybody already has: no guard hired, odds
// untouched, `guardDeterrence` exactly 1. Which is the assertion that decides
// whether step 4 is opt-in or a silent nerf to every thief in every save.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  eq(g.guardDeterrence(), 1, 'a shop with no guard changes nobody\'s odds');

  // Hired off the roster rather than by standing somebody on the floor: a guard
  // on their break is still somebody the town knows you employ, and reading
  // positions would make the odds flicker as people walked behind shelving.
  g.roster = [{ id: 'w1', kind: 'guard', jobs: [{ job: 'guard', weight: 10 }] }];
  const one = g.guardDeterrence();
  check(one < 1, 'one guard cuts them', `${one}`);

  g.roster.push({ id: 'w2', kind: 'guard', jobs: [{ job: 'guard', weight: 10 }] });
  const two = g.guardDeterrence();
  check(two < one, '...and a second cuts them further', `${two} vs ${one}`);
  // Saturating rather than linear — `charmReach`'s argument. Linear, the
  // cheapest strategy in the game is a wall of guards and theft stops existing.
  check(two > 0, '...but never to nothing', `${two}`);
  check((one - two) < (1 - one), '...and each one is worth less than the last');

  // A hire with the directive at weight 0 has been told not to do it, and must
  // not count — otherwise turning the job off still buys the deterrent.
  g.roster = [{ id: 'w1', kind: 'guard', jobs: [{ job: 'guard', weight: 0 }] }];
  eq(g.guardDeterrence(), 1, 'a guard told not to guard deters nobody');
}

{
  // ...and the catch itself is the SAME catch. Split out of `taze` the moment
  // there were two callers, so a guard's arrest cannot quietly stop crediting
  // `recovered` while yours goes on doing it.
  const g = fresh();
  const thief = shopper(g, CROOK);
  g.goToTill(thief, archOf(CROOK));
  const crates = g.deliveries.length;

  const res = g.catchThief(thief, { staff: true, name: 'Guard-1' });

  eq(res.recovered, 1, 'a guard recovers the goods');
  eq(thief.bought.length, 0, '...off the thief');
  eq(thief.caught, true, '...and stops them running');
  eq(g.deliveries.length, crates + 1, '...onto the floor as an ordinary crate');
  eq(g.stats.recovered, 1, '...tallied the same way yours is');
  eq(g.stats.stolen, 0, '...and netted off the day the same way');
}

// ---------------------------------------------------------------------------
// 9. The posts — every way OUT, not the one the generator cut.
//
// `layout.door` is the opening the generator made, and a guard posted there is
// watching one hole in a building that has at least two: the shipped shop has a
// back door onto the yard, so for the whole of step 4's first draft a thief
// could stroll out of the service entrance past a guard stood at the front,
// looking exactly like a guard doing their job.
//
// The claim that matters is the one about WHO may cross, not about which edge
// kinds are holes: a staff door is not a way out for a shopper, and only
// `shopperCanCross` knows that. Getting it wrong posts a guard at a door no
// thief can use, which is the same invisible failure one door further along.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const exits = g.shopExits();

  check(exits.length > 0, 'a shop has at least one way out');
  check(exits.some((e) => e.z !== g.layout.door.z),
    'and the posts are not just the generated front door',
    JSON.stringify(exits));
  // Every post is a tile INSIDE the shop — that is where somebody stands to
  // block a hole, and it is the tile A* can actually route a hire to.
  const { w, indoor } = g.layout;
  check(exits.every((e) => indoor[e.z * w + e.x]), 'every post is a tile inside the shop');

  // Cached against the layout, since every guard asks this every tick.
  check(g.shopExits() === exits, 'the list is cached rather than re-walked per tick');
}

{
  // A staff-only door is not a way out for a shopper, so it is not a post.
  // Asserted as a DIFFERENCE against the same wall carrying an ordinary door,
  // because a count on its own passes on a sweep that never cut a hole at all.
  const g = fresh();
  const s = g.layout.store;
  const at = { o: 'h', x: s.x + 2, z: s.z };            // the north wall

  g.edits.push({ ...at, k: E.DOOR });
  g.regenerateLayout();
  const withDoor = g.shopExits().length;

  g.edits = g.edits.filter((e) => !(e.o === at.o && e.x === at.x && e.z === at.z));
  g.edits.push({ ...at, k: E.DOOR_STAFF });
  g.regenerateLayout();
  const withStaffDoor = g.shopExits().length;

  check(withDoor > withStaffDoor, 'an ordinary door is a post and a staff-only one is not',
    `${withDoor} vs ${withStaffDoor}`);
}

{
  // Two guards do not stand on the same hole. The same claim `serve` makes
  // about two clerks and one till, and it is what makes hiring a second guard
  // mean anything in a shop with two ways out.
  const g = fresh();
  const posts = g.shopExits();
  check(posts.length >= 2, 'the shipped shop has more than one way out', `${posts.length}`);

  const ids = new Set(posts.map((e) => e.id));
  eq(ids.size, posts.length, '...and each is its own claim id, so they cannot collide');
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ ${failures.length} of ${checks} checks failed:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ theft: ${checks} checks passed`);
