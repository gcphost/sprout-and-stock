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
  check(
    at(p)[0] === shelf.browseAt.x && at(p)[1] === shelf.browseAt.z,
    `${shelf.id} lands on its working side`,
    `at ${at(p)}, wanted ${shelf.browseAt.x},${shelf.browseAt.z}`,
  );
  // And the claim that actually matters: arriving means the sim's own reach
  // check finds it, which is what makes "tap it and it happens" true. Asserted
  // against `nearest` rather than against a distance of our own, because a
  // sweep that invents its own idea of reach passes while the game refuses.
  check(
    g.nearest(g.layout.shelves, p, 1.6, (s) => s.browseAt)?.id === shelf.id,
    `${shelf.id} is in reach on arrival`,
  );
}

check(!g.walkToFixture('me', 'no-such-fixture').ok, 'an unknown fixture is refused');

console.log(`\nverify:walk — ${checks} assertions\n`);
if (!failures.length) {
  console.log('  ✅  a click routes you to where you can actually work.\n');
  process.exit(0);
}
console.log(`  ❌  ${failures.length} failures:\n`);
for (const f of failures) console.log(`      ${f}`);
console.log();
process.exit(1);
