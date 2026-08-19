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
// Tested on `till`, which needs no crop, no cash and no season, so this stays a
// claim about the charge rather than about content. And tested at 2% throttle:
// the player never leaves the bed's reach and never stops either, which is
// exactly the case the arithmetic missed. Asserting on the *soil* as well as on
// `p.action` is deliberate — a charge that is thrown away every tick and re-armed
// the next still reads as null from outside, and would still till the bed.
// ---------------------------------------------------------------------------

const tick = (seconds) => {
  for (let i = 0; i < seconds * 20; i++) { g.stepPlayers(1 / 20); g.stepActions(1 / 20); }
};

const bed = g.layout.plots[0];
bed.crop_id = null;
bed.soil = 'untilled';
p.path = null;
p.x = bed.x;
p.z = bed.z;

g.setInput('me', 0.02, 0);
tick(4);
check(p.action === null, 'nothing arms while you are moving');
check(bed.soil === 'untilled', 'and four seconds of crawling over a bed does not till it');

g.setInput('me', 0, 0);
tick(4);
check(bed.soil === 'tilled', 'and standing still on the same bed does');

console.log(`\nverify:walk — ${checks} assertions\n`);
if (!failures.length) {
  console.log('  ✅  a click routes you to where you can actually work.\n');
  process.exit(0);
}
console.log(`  ❌  ${failures.length} failures:\n`);
for (const f of failures) console.log(`      ${f}`);
console.log();
process.exit(1);
