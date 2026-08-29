#!/usr/bin/env node
/**
 * ROUTED WALKS.
 *
 * Since the drag-joystick went, a click is a *destination*: the client names a
 * tile or a fixture and the server plans the route (`Game.walkTo`,
 * `Game.walkToFixture`). That moved the player onto the same `findPath` the
 * customers use, and made three claims that are invisible in a screenshot —
 * which is why they are here rather than in a play test:
 *
 * 1. **A route ends where you can work.** A shelf is used from one side, and
 *    A*'s own "goal is blocked, so aim at any walkable neighbour" fallback will
 *    happily park you *behind* it. That looks identical to arriving — same
 *    walk, same animation, one tile out — and the only visible symptom is that
 *    holding still next to a shelf does nothing, which reads as a broken
 *    action rather than a broken route.
 * 2. **Steering always wins.** `stepPlayers` drops the route on the first frame
 *    of key input. A key that merely fought the route would look like lag.
 * 3. **A refusal leaves you standing.** Clicking through a wall you have not
 *    put a door in yet is an ordinary thing to do, not an error state.
 *
 * ...and since first person got a pace of its own, a fourth that is invisible
 * for a different reason: a player walking and a player walking are the same
 * still frame either way, and the shop afterwards is the same shop. See §6,
 * whose centrepiece is that BOTH movers are boosted — a tapped walk carries no
 * input vector at all, so it is the one that fails quietly.
 *
 * Runs on an ephemeral Game, so it never touches the live shop.
 *
 *   node scripts/verify-walk.js
 */

import { Game } from '../server/sim/index.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

/** The shop this sweep wants: enough shelving that routes have to go round it. */
const SHOP = { shelf: 6, freezer: 1, checkout: 1, plot: 4 };

/**
 * The same `fresh()` every sweep here needs, and for the same reason:
 * `Game.create` reads the saved world, so without this the sweep measures
 * whatever the live shop happens to look like today. See verify-build.js for
 * the full list and what each one cost.
 */
function fresh() {
  const g = Game.create({ worldId: 'verify-walk', seed: 'routes', ephemeral: true });
  g.placements = [];
  g.grow = { w: 0, h: 0 };
  g.doorShift = 0;
  g.edits = [];
  g.shell = null;
  g.ownedUpgrades = [];
  g.regenerateLayout(null, {}, { want: SHOP });
  g.freezeShell();
  g.addPlayer('me', 'Tester');
  // The tester holds the button down for the whole sweep.
  //
  // Since the ring stopped winding on its own, an action needs a press — see
  // `Game.stepActions`. A sweep that did not press would find that nothing in
  // the game does anything, which reads as every mechanic being broken rather
  // than as the harness having forgotten to be a player. This is the newest
  // entry in the `fresh()` trap at the top of CLAUDE.md: state that is not new
  // to the save, but newly matters to what fires.
  //
  // It is deliberately NOT the default on a player. A shop where the button is
  // down until somebody lifts it is the auto-fire this replaced.
  g.players.me.pressing = true;
  return g;
}

/** Run the movement tick for a while. Twenty a second, like the room does. */
const step = (g, seconds) => {
  for (let i = 0; i < seconds * 20; i++) g.stepPlayers(1 / 20);
};

const g = fresh();
const p = g.players.me;
const at = (e) => [Math.round(e.x), Math.round(e.z)];

// ---------------------------------------------------------------------------
// 1. A tile you can reach
// ---------------------------------------------------------------------------

const goal = g.layout.shelves[0].browseAt;
const res = g.walkTo('me', goal.x, goal.z);
check(res.ok, 'a reachable tile is accepted', res.error);
check((p.path?.length ?? 0) > 0, 'and a route is planned');
step(g, 60);
check(Math.hypot(p.x - goal.x, p.z - goal.z) < 0.01, 'the walk arrives', `at ${at(p)}, wanted ${goal.x},${goal.z}`);
check(p.path === null, 'and the route clears on arrival');

// Every leg of a planned route is one the player is allowed to walk, which is
// the claim that keeps `followPath` honest without re-checking per step: A*
// reads edge walls at plan time and `canWalk` reads them at move time, and this
// is the only place the two are ever compared.
g.walkTo('me', g.layout.checkouts[0].serveAt?.x ?? g.layout.checkouts[0].x,
  g.layout.checkouts[0].serveAt?.z ?? g.layout.checkouts[0].z);
let legal = true;
let prev = { x: p.x, z: p.z };
for (const node of p.path ?? []) {
  if (!g.canWalk(prev.x, prev.z, node.x, node.z)) legal = false;
  prev = node;
}
check(legal, 'every leg of a route crosses no wall');

// ---------------------------------------------------------------------------
// 2. Steering takes the wheel back
// ---------------------------------------------------------------------------

step(g, 0.1);
g.setInput('me', 1, 0);
step(g, 0.05);
check(p.path === null, 'a keypress drops the route');
const wasAt = p.x;
g.setInput('me', 1, 0);
step(g, 0.5);
check(p.x !== wasAt, 'and keys still move you', `${wasAt.toFixed(2)} -> ${p.x.toFixed(2)}`);
g.setInput('me', 0, 0);

// ---------------------------------------------------------------------------
// 3. Refusals, and the tile you are already on
// ---------------------------------------------------------------------------

const held = { x: p.x, z: p.z };
const off = g.walkTo('me', -5, -5);
check(!off.ok, 'a tile off the map is refused');
step(g, 1);
check(p.x === held.x && p.z === held.z, 'and a refusal leaves you standing still');

const here = g.walkTo('me', Math.round(p.x), Math.round(p.z));
check(here.ok, 'the tile you are stood on is accepted');
check(p.path === null, 'and is not left as a route of no legs');

// ---------------------------------------------------------------------------
// 4. A fixture routes to where you WORK it — the whole point
// ---------------------------------------------------------------------------

for (const shelf of g.layout.shelves) {
  p.path = null;
  g.setInput('me', 0, 0);
  const r = g.walkToFixture('me', shelf.id);
  if (!r.ok) { check(false, `every shelf is reachable (${shelf.id})`, r.error); continue; }
  step(g, 60);
  // A working SIDE, not the anchor. `browseAt` is one stored tile — the side the
  // generator laid the unit against — and a gondola in an aisle is worked from
  // both, so a walk pinned to the anchor took you round the end of the unit to
  // the far aisle whenever you asked from the near one. The route goes to the
  // nearest of `spotsNearest` now, so what is asserted is membership rather than
  // a literal: any side the shop itself calls a working spot is a right answer.
  const sides = g.reachSpots(shelf);
  check(
    sides.some((s) => at(p)[0] === s.x && at(p)[1] === s.z),
    `${shelf.id} lands on a working side`,
    `at ${at(p)}, sides ${sides.map((s) => `${s.x},${s.z}`).join(' ')}`,
  );
  // And the claim that actually matters: arriving means the sim's own reach
  // check finds it, which is what makes "tap it and it happens" true. Asserted
  // through `atFixture` rather than against a distance of our own, because a
  // sweep that invents its own idea of reach passes while the game refuses —
  // and because that is the function every verb in the game asks.
  check(g.atFixture(p, shelf), `${shelf.id} is in reach on arrival`);
}

check(!g.walkToFixture('me', 'no-such-fixture').ok, 'an unknown fixture is refused');

// ---------------------------------------------------------------------------
// 5. An action wants you STOPPED, not merely near
//
// The other half of "tap it and it happens", and the half that used to fire on
// people who never asked. `ACTION_TIME` was the whole defence — a second of
// charge against about three quarters of a second to cross a reach — and that
// only describes a straight line through the middle at full speed. Crawl,
// corner, or walk the length of an aisle and you are in range the whole time.
//
// Tested at 2% throttle: the player never leaves the target's reach and never
// stops either, which is exactly the case the arithmetic missed. Asserting on
// the OUTCOME as well as on `p.action` is deliberate — a charge that is thrown
// away every tick and re-armed the next still reads as null from outside, and
// would still fire.
//
// THE VEHICLE MOVED, and the new one is the only one there can be. This used to
// crawl over a rough bed, on the argument that `till` needs no crop, no cash and
// no season — and tilling came off proximity the day a rack could stand in an
// aisle (`verify:build` §1c). What is left on proximity is `serve`, and there
// is no going back to a NAMED action here: steering cancels an errand on the
// first frame of input (`stepPlayers`), so a sweep that pointed at something and
// then held a key would be measuring that line instead of this one. A shopper at
// the counter is the one thing in the game that can still arm itself while you
// walk past, which makes it both the right subject and the only one.
// ---------------------------------------------------------------------------

const tick = (seconds) => {
  for (let i = 0; i < seconds * 20; i++) { g.stepPlayers(1 / 20); g.stepActions(1 / 20); }
};

const till = g.layout.checkouts[0];
const spawned = g.spawnCustomer();
check(spawned.ok, 'a shopper to stand at the counter', spawned.error);
const shopper = g.customers[spawned.id];
shopper.basket = [{ item_id: 'zz-walk-thing', price: 3 }];
shopper.patience = 1e6;          // a queue that empties by storming out is not this claim
shopper.mood = 1;
shopper.waited = 0;
shopper.impulsed = true;
shopper.till = till.id;
shopper.state = 'QUEUE';
shopper.path = null;
till.queue = [shopper.id];
const slot = g.queueSlot(till, 0);
shopper.x = slot.x;
shopper.z = slot.z;

p.path = null;
p.x = till.serveAt?.x ?? till.x;
p.z = till.serveAt?.z ?? till.z;
check(!!g.actionFor(p), 'and the counter really does offer the serve from here');

g.setInput('me', 0.02, 0);
tick(4);
check(p.action === null, 'nothing arms while you are moving');
check(shopper.state === 'QUEUE', 'and four seconds of crawling past the counter serves nobody');

g.setInput('me', 0, 0);
tick(4);
check(shopper.state !== 'QUEUE', 'and standing still at the same counter does');

// ---------------------------------------------------------------------------
// 6. The pace, which is a fact about the CAMERA and about the player
//
// Everything in here is invisible twice over: a player walking and a player
// walking are the same still frame, and the shop afterwards is the same shop.
// Only the clock moved — which is precisely the report this shipped for.
//
// Its control is the assertion that decides whether any of this is opt-in. A
// player who never said `fpv` is every player who has ever walked anywhere in
// this game, in a sweep, in a balance run, in a shop somebody is playing from
// up there, and a control that is wrong has quietly changed all of them.
//
// Its centrepiece is the ROUTED leg, which is the half that would have been
// forgotten and the half that fails silently: `p.input` is empty for the whole
// of a tapped walk, so a boost hung off the steering vector leaves pointing at
// the far shelf slower than walking to it, in the same view, with nothing on
// screen to say why. Both movers or neither.
//
// `FPV_SPEED` is restated here rather than imported, for the reason
// `verify:grace` restates its ramp: an assertion that reads the constant it is
// checking passes whatever that constant becomes.
// ---------------------------------------------------------------------------

const FPV_PACE = 1.35;

/**
 * Somewhere with a clear run east of it.
 *
 * Found rather than written down, because the shop this sweep furnishes is a
 * generated one: a literal tile is a tile that is open until the day the
 * generator puts a shelf on it, and what that fails as is a pace assertion
 * measuring a wall.
 */
function openRun(game) {
  const { w, h } = game.layout;
  for (let z = 1; z < h - 1; z++) {
    for (let x = 1; x < w - 3; x++) {
      let clear = true;
      for (let s = 0; s < 6; s++) {
        if (!game.canWalk(x + s * 0.5, z, x + (s + 1) * 0.5, z)) { clear = false; break; }
      }
      if (clear) return { x, z };
    }
  }
  return null;
}

const start = openRun(g);
check(!!start, 'the sweep found somewhere with three clear tiles east of it');

if (start) {
  /** Steer east for a fixed slice and answer how far that got you. */
  const steered = (fpv) => {
    const h = fresh();
    h.players.me.x = start.x;
    h.players.me.z = start.z;
    h.setInput('me', 1, 0, false, fpv);
    step(h, 0.5);
    return h.players.me.x - start.x;
  };

  const flat = steered(false);
  const eye = steered(true);
  check(flat > 0.1, 'the control actually walked', `${flat.toFixed(3)} tiles`);
  // To the thousandth, because "faster" is satisfied by a rounding error and
  // the thing being asserted is a specific multiplier.
  check(
    Math.abs(eye - flat * FPV_PACE) < 1e-3,
    'first person steers at exactly the multiplier',
    `${flat.toFixed(3)} -> ${eye.toFixed(3)}, wanted ${(flat * FPV_PACE).toFixed(3)}`,
  );

  /** ...and the same slice of a walk the player TAPPED rather than steered. */
  const routed = (fpv) => {
    const h = fresh();
    h.players.me.x = start.x;
    h.players.me.z = start.z;
    // The flag arrives the way it does in play — on an input message, with no
    // direction on it, which is the state a player who is standing still and
    // about to click is in.
    h.setInput('me', 0, 0, false, fpv);
    const r = h.walkTo('me', start.x + 3, start.z);
    if (!r.ok) return null;
    step(h, 0.5);
    return h.players.me.x - start.x;
  };

  const tapFlat = routed(false);
  const tapEye = routed(true);
  check(tapFlat !== null && tapFlat > 0.1, 'a tapped walk sets off', `${tapFlat}`);
  check(
    tapFlat !== null && tapEye !== null && Math.abs(tapEye - tapFlat * FPV_PACE) < 1e-3,
    'and a tapped walk is boosted by the same multiplier as a steered one',
    `${tapFlat?.toFixed(3)} -> ${tapEye?.toFixed(3)}`,
  );

  // Sprint still multiplies the walk rather than having been replaced by it.
  // Without this the honest way to read the change is "first person IS the
  // sprint", and there would be nothing left to press.
  const h = fresh();
  h.players.me.x = start.x;
  h.players.me.z = start.z;
  h.setInput('me', 1, 0, true, true);
  step(h, 0.25);
  check(
    h.players.me.x - start.x > eye * 0.5 + 1e-3,
    'sprinting in first person still beats walking in it',
  );

  // And the claim that says WHY this rides on the input message rather than
  // being a switch on the shop: one shop, two people, one of them in first
  // person. A mode kept anywhere but on the player answers for both.
  const two = fresh();
  two.addPlayer('you', 'Guest');
  for (const who of ['me', 'you']) {
    two.players[who].x = start.x;
    two.players[who].z = start.z;
  }
  two.setInput('me', 1, 0, false, false);
  two.setInput('you', 1, 0, false, true);
  step(two, 0.5);
  check(
    two.players.you.x - two.players.me.x > 0.1,
    'two people in one shop walk at their own camera\'s pace',
    `${(two.players.me.x - start.x).toFixed(3)} vs ${(two.players.you.x - start.x).toFixed(3)}`,
  );
}

console.log(`\nverify:walk — ${checks} assertions\n`);
if (!failures.length) {
  console.log('  ✅  a click routes you to where you can actually work.\n');
  process.exit(0);
}
console.log(`  ❌  ${failures.length} failures:\n`);
for (const f of failures) console.log(`      ${f}`);
console.log();
process.exit(1);
