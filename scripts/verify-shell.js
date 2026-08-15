#!/usr/bin/env node
/**
 * VERIFY: THE SHOP STAYS WHERE YOU PUT IT.
 *
 * Step 4 of docs/building.md has one claim and it is a negative: after a shop
 * has been stamped, nothing you do to it re-flows anything else. That is a
 * miserable thing to check by eye — you would have to notice that a shelf you
 * were not looking at is one tile from where it was — and it is exactly the
 * class of bug that shipped as `droppedPlacements`, a feature whose whole job
 * was to apologise for the building moving.
 *
 * So the assertions here are all of the form "take a fingerprint, do a thing,
 * compare" — over every fixture's kind, position and, once the shop is stamped,
 * its id. Those are the things a re-flow disturbs and nothing legitimate does.
 *
 * Two ways this could rot, both guarded below:
 *
 * - **It could pass because nothing happened.** A sweep that places a shelf,
 *   silently fails, and then finds the shop unchanged is a sweep that is very
 *   happy about nothing. Every action here asserts it succeeded first, and the
 *   fingerprint is asserted to have *grown by exactly one* rather than merely
 *   to be unchanged.
 * - **It could pass because the shop is empty.** A shop with two fixtures in it
 *   has very little to re-flow. So it asserts up front that the test shop is
 *   actually furnished.
 *
 * Runs on an ephemeral Game against a world id nothing else uses.
 *
 *   node scripts/verify-shell.js
 */

import { Game } from '../server/sim/index.js';
import { generateLayout } from '../server/layout.js';
import { fixturesOf } from '../shared/build.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SHOP = { shelf: 6, freezer: 1, checkout: 1, plot: 4 };

/**
 * Every fixture, as one comparable string. Two of them, because "did anything
 * move" and "is anything still the same thing" are different questions and
 * exactly one moment in the game's life separates them.
 *
 * Stamping deliberately re-mints every generated id: `shelf-p0` was invented
 * fresh on every re-flow, which is why anything remembered against one drifted
 * onto a different shelf, and freezing is where that stops. So across a stamp,
 * ids change and positions must not. After a stamp, both must hold.
 *
 * Sorted rather than taken in list order, because the order the lists come out
 * in is not a promise anybody made.
 */
const shape = (g) => fixturesOf(g.layout)
  .map((f) => `${f.kind}@${f.x},${f.z}r${f.rot ?? 0}`)
  .sort()
  .join('|');

const fingerprint = (g) => fixturesOf(g.layout)
  .map((f) => `${f.id}:${f.kind}@${f.x},${f.z}r${f.rot ?? 0}`)
  .sort()
  .join('|');

function fresh() {
  const g = Game.create({ worldId: 'verify-shell', seed: 'shell', ephemeral: true });
  g.placements = [];
  g.grow = { w: 0, h: 0 };
  g.doorShift = 0;
  g.edits = [];
  g.shell = null;
  // A shop of a stated shape, unstamped — which is what this sweep is here to
  // stamp. `want` replaced `g.fixtures = {...SHOP}` when step 9 retired the
  // stored ledger: the generator is handed the base shop or whatever is already
  // standing, and there is no third thing for a sweep to pin.
  g.regenerateLayout(null, {}, { want: SHOP });
  g.cash = 20000;
  g.addPlayer('me', 'Tester');
  g.players.me.build = { on: true, tool: 'shelf' };
  return g;
}

// ---------------------------------------------------------------------------
// 1. Stamping turns the generated shop into placements, and changes nothing.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const before = shape(g);
  const count = fixturesOf(g.layout).length;
  check(count >= 10, 'the test shop is actually furnished', `${count} fixtures`);
  eq(g.shell, null, 'a shop that has never been stamped has no shell');

  check(g.freezeShell(), 'stamping a fresh shop does something');
  check(!!g.shell, 'and leaves it with a shell');
  eq(g.shell.w, g.layout.store.w, 'the shell is the size the building actually is');
  eq(g.shell.h, g.layout.store.h, 'in both directions');

  // The whole point: converting to placements is not allowed to *move* anything.
  eq(shape(g), before, 'stamping moved nothing');
  check(!fixturesOf(g.layout).some((f) => /-p\d+$/.test(f.id)),
    'and no generated id survives it — those are the ones that used to drift');
  eq(g.placements.length, count, 'every fixture is a placement now');
  check(g.placements.every((p) => p.id.startsWith('fx-')),
    'and every one of them owns a player-namespace id');

  // Idempotent, because it runs on every load. A second stamp that placed
  // everything again would double the shop each time a world was opened.
  check(!g.freezeShell(), 'stamping twice does nothing the second time');
  eq(g.placements.length, count, 'and does not duplicate a thing');
  eq(shape(g), before, 'and still moved nothing');
}

// ---------------------------------------------------------------------------
// 2. A stamped shop does not re-flow when you build in it.
//
// This is the failure `droppedPlacements` was invented to apologise for, and
// the reason step 4 exists at all.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  g.freezeShell();
  const before = fingerprint(g);
  const beforeCount = fixturesOf(g.layout).length;

  // Somewhere legal, found by asking the same validator the game asks.
  const L = g.layout;
  let spot = null;
  for (let z = L.store.z; z < L.store.z + L.store.h && !spot; z++) {
    for (let x = L.store.x; x < L.store.x + L.store.w && !spot; x++) {
      if (g.fixtureAt(x, z)) continue;
      const probe = g.placeFixture('me', { kind: 'shelf', x, z, rot: 0 });
      if (probe.ok) spot = { x, z, id: probe.placed };
    }
  }
  check(!!spot, 'a shelf can be built somewhere in the test shop');

  const after = fingerprint(g);
  eq(fixturesOf(g.layout).length, beforeCount + 1, 'building added exactly one fixture');
  eq((g.layout.droppedPlacements ?? []).length, 0, 'and displaced nothing');

  // Everything that was there before is still there, at the same id, in the
  // same place. `before` is a subset of `after` rather than equal to it,
  // because one thing legitimately arrived.
  const was = new Set(before.split('|'));
  const now = new Set(after.split('|'));
  const moved = [...was].filter((f) => !now.has(f));
  check(moved.length === 0, 'nothing else in the shop moved', moved.slice(0, 3).join(' '));

  // ...and the building itself did not resize under it.
  eq(g.layout.store.w, g.shell.w, 'the building is still the width it was');
  eq(g.layout.store.h, g.shell.h, 'and the height');
}

// ---------------------------------------------------------------------------
// 3. Selling one back does not re-flow either, and the cell reopens.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  g.freezeShell();
  const shelf = g.layout.shelves[0];
  const cell = { x: shelf.x, z: shelf.z };
  check(!!g.layout.blocked[cell.z * g.layout.w + cell.x], 'a shelf occupies its cell');

  const others = fingerprint(g).split('|').filter((f) => !f.startsWith(`${shelf.id}:`));
  const sold = g.removeFixture('me', shelf.id);
  check(sold.ok, 'a shelf can be sold back', sold.error ?? '');

  eq(g.layout.blocked[cell.z * g.layout.w + cell.x], 0,
    'and the floor under it goes back to being floor');
  const now = new Set(fingerprint(g).split('|'));
  check(others.every((f) => now.has(f)), 'selling one back moved nothing else');
}

// ---------------------------------------------------------------------------
// 4. Given a shell, the generator reproduces rather than invents.
//
// Asked of the generator directly, with no Game around it: same inputs, same
// building, every time — and the size it was handed rather than a size it liked.
// ---------------------------------------------------------------------------
{
  const opts = { seed: 'shell', shelves: 6, freezers: 1, checkouts: 1, plots: 4 };
  const grown = generateLayout(opts);
  const shell = { w: grown.store.w, h: grown.store.h };

  const a = generateLayout({ ...opts, shell });
  const b = generateLayout({ ...opts, shell });
  eq(a.store.w, shell.w, 'a stored shell is built at the width it says');
  eq(a.store.h, shell.h, 'and the height it says');
  eq(JSON.stringify(a.tiles), JSON.stringify(b.tiles), 'twice over, the same ground');
  eq(JSON.stringify(a.blocked), JSON.stringify(b.blocked), 'and the same things standing on it');

  // A shell wider than the contents need must not be shrunk back to fit them.
  // That is the failure that would strand every placement outside the building.
  const roomy = generateLayout({ ...opts, shell: { w: shell.w + 4, h: shell.h + 3 } });
  eq(roomy.store.w, shell.w + 4, 'a bigger shell stays bigger');
  eq(roomy.store.h, shell.h + 3, 'in both directions');
}

// ---------------------------------------------------------------------------

console.log(`\nverify:shell — ${checks} assertions`);
if (failures.length) {
  console.error(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✅  the shop is stamped once and stays where you put it.\n');
