#!/usr/bin/env node
/**
 * VERIFY: THE WORLD CAN GROW AT THE BACK, AND NOTHING MOVES WHEN IT DOES.
 *
 * Land to the east or the south is free — `x0` and `z0` stay put, so every
 * absolute coordinate in the save still means what it meant and `compose` just
 * gets a bigger number. North and west cannot work that way, because row 0 is
 * the top: there is nowhere above it to put anything, so the only way to sell
 * land at the back is to slide the entire world down and call the new rows the
 * back.
 *
 * Which makes `growWorld` the one operation in the game that rewrites every
 * absolute position at once, and the failure mode is not a crash. It is a
 * MISSED FIELD, and it is invisible twice over: a shop that shifted and a shop
 * that did not are the same picture from a camera that shifted with it, and the
 * thing left behind is left behind *correctly* — no error, no log, nothing in
 * the feed. It has already happened once in this codebase, in `buyUpgrade`,
 * where rewriting `shell` dropped its `z` and jumped the building three rows
 * north: shelves 21 → 14, plots 3 → 0, checkouts 1 → **0**, and revenue $723
 * over sixty days against $33,353 with it fixed. What it presented as was "I
 * bought an upgrade and went broke".
 *
 * So every claim in here is RELATIVE. Nothing asserts a coordinate — a value
 * would only tell you what the shift did to the one field you thought to check,
 * and the whole risk is the field you did not. What it asserts is that the gaps
 * between things are the same afterwards: the wall is the same distance from
 * the shelf, the paint is on the same face of the same wall, the crate is on
 * the same square of the same pad.
 *
 * The claims:
 *
 * - **The control, doubled.** East and south must shift NOTHING — they are the
 *   old upgrade and every save in the world has bought them. And a grow of zero
 *   must be a no-op, because `buyUpgrade` calls it unconditionally.
 * - **Every drawn thing moves together**, over all seven lists at once, each
 *   asserted against its own neighbours rather than against a number.
 * - **Paint follows its wall**, which is the one that cannot be nudged in place:
 *   it is keyed `o:x:z:±1`, so it is rebuilt rather than moved, and a rebuild is
 *   where a side gets dropped and a shop is repainted on the wrong face.
 * - **Nothing is dropped or refunded.** The `shell.z` disaster's actual
 *   symptom: `applyPlacements` sheds what falls outside the building, so the
 *   test is the count AND the cash, since a shed fixture comes back as money.
 * - **The traffic map goes with it**, or the shop is scored on where people
 *   walked before the world moved.
 * - **The back really is bigger** — the point of the whole exercise, and the one
 *   claim that would pass on a function that shifted everything and grew nothing.
 *
 * Runs on ephemeral Games and writes no content at all.
 *
 *   node scripts/verify-grow.js
 */

import { Game } from '../server/sim/index.js';
import { silenceMilestones } from '../server/sim/goals.js';
import { faceKey } from '../shared/build.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SHOP = { shelf: 6, freezer: 1, checkout: 1, plot: 4 };

function fresh() {
  const g = Game.create({ worldId: 'verify-grow', seed: 'grow', ephemeral: true });
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

/**
 * Everything the shop is made of, as one flat list of tagged positions.
 *
 * Deliberately gathered by walking the same seven places `growWorld` walks,
 * because the assertion this file exists for is "they all moved by the same
 * amount" — and a snapshot that read fewer lists than the shift writes would
 * pass on precisely the bug being hunted. Sorted so two snapshots line up
 * element for element without depending on list order surviving a re-flow.
 */
function snap(g) {
  const out = [];
  const put = (tag, o) => { if (o) out.push(`${tag}@${o.x},${o.z}`); };
  put('shell', g.shell);
  for (const p of g.placements) out.push(`fx:${p.kind}:${p.piece ?? ''}@${p.x},${p.z}`);
  for (const e of g.edits) out.push(`edge:${e.o}:${e.k}@${e.x},${e.z}`);
  for (const c of g.ground) out.push(`gnd:${c.k}@${c.x},${c.z}`);
  for (const k of Object.keys(g.paint)) out.push(`paint@${k}`);
  for (const d of g.deliveries) out.push(`crate@${d.x},${d.z}`);
  for (const c of g.cashDrops) out.push(`cash@${c.x},${c.z}`);
  return out.sort();
}

/** The same snapshot with a known shift applied to every coordinate in it. */
function shifted(list, dx, dz) {
  return list.map((s) => s.replace(/@(.+)$/, (_, tail) => {
    // A paint entry is a face key, so its numbers sit in the middle of it.
    const parts = tail.split(',');
    if (parts.length === 2) return `@${Number(parts[0]) + dx},${Number(parts[1]) + dz}`;
    const [o, x, z, side] = tail.split(':');
    return `@${faceKey({ o, x: Number(x) + dx, z: Number(z) + dz, s: Number(side) })}`;
  })).sort();
}

/** Put something of every kind into the shop, so the shift has all seven to miss. */
function furnish(g) {
  const s = g.layout.store;
  // A wall the player drew, a painted face on it, painted ground, a crate and
  // a pile of cash. Written onto the save directly rather than bought, because
  // this file is about the shift and not about whether a purchase is legal.
  g.edits.push({ o: 'v', x: s.x + 2, z: s.z + 2, k: 'wall' });
  g.paint[faceKey({ o: 'v', x: s.x + 2, z: s.z + 2, s: 1 })] = 'paint-white';
  g.ground.push({ x: s.x + 1, z: s.z + 1, k: 'floor', p: null });
  g.deliveries.push({ id: 'cr-1', x: s.x + 3, z: s.z + 3, stacks: [{ item_id: 'zz', qty: 2 }], day: 1 });
  g.cashDrops.push({ id: 'cash-1', x: s.x + 4, z: s.z + 4, amount: 5 });
  g.regenerateLayout();
}

// ---------------------------------------------------------------------------
// 1. The control, doubled: growing east or south moves nothing, and a grow of
//    nothing is a no-op.
//
// The first is every save in the world — both shipped paddocks are east and
// south — so a shift that fired on them would move every shop in existence out
// from under its own contents. The second is not pedantry: `buyUpgrade` calls
// `growWorld` on every space purchase and passes zeroes for the old two.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  furnish(g);
  const before = snap(g);

  g.growWorld(0, 0);
  check(JSON.stringify(snap(g)) === JSON.stringify(before), 'a grow of nothing moves nothing');

  // ...and the shipped payloads, through the real purchase path.
  const g2 = fresh();
  furnish(g2);
  const was = snap(g2);
  g2.grow = { w: g2.grow.w + 3, h: g2.grow.h + 3 };
  g2.growWorld(0, 0);            // what east/south pass
  g2.regenerateLayout();
  check(JSON.stringify(snap(g2)) === JSON.stringify(was), 'buying east and south land moves nothing');
}

// ---------------------------------------------------------------------------
// 2. North and west move everything, together, by exactly what was asked.
//
// One assertion over all seven lists rather than seven assertions, and that is
// the point of `snap`: a per-list check passes for the six you remembered.
// ---------------------------------------------------------------------------
for (const [dx, dz, what] of [[0, 3, 'north'], [3, 0, 'west'], [2, 4, 'both at once']]) {
  const g = fresh();
  furnish(g);
  const before = snap(g);
  const want = shifted(before, dx, dz);

  g.growWorld(dx, dz);
  const after = snap(g);

  eq(after.length, before.length, `growing ${what} loses nothing off the list`);
  check(JSON.stringify(after) === JSON.stringify(want), `growing ${what} moves every drawn thing together`,
    after.filter((s, i) => s !== want[i]).slice(0, 3).join(' | '));
}

// ---------------------------------------------------------------------------
// 3. Paint follows its wall, on the same SIDE.
//
// The one thing that cannot be nudged in place: it is a keyed map, so it is
// rebuilt — and a rebuild is where a side is quietly dropped. A finish that
// moved to the right cell and the wrong face is invisible from a camera that
// can only see one of them, which is `verify:paint`'s whole argument arriving
// through a new door.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const s = g.layout.store;
  const at = { o: 'v', x: s.x + 2, z: s.z + 2 };
  g.edits.push({ ...at, k: 'wall' });
  g.paint[faceKey({ ...at, s: 1 })] = 'paint-white';
  g.paint[faceKey({ ...at, s: -1 })] = 'paint-red';
  g.regenerateLayout();

  g.growWorld(0, 3);
  const moved = { o: 'v', x: at.x, z: at.z + 3 };
  eq(g.paint[faceKey({ ...moved, s: 1 })], 'paint-white', 'the near face keeps its colour');
  eq(g.paint[faceKey({ ...moved, s: -1 })], 'paint-red', '...and the far face keeps its own');
  eq(Object.keys(g.paint).length, 2, '...and no third face is conjured');
  check(!(faceKey({ ...at, s: 1 }) in g.paint), '...and nothing is left on the old wall');
}

// ---------------------------------------------------------------------------
// 4. Nothing is dropped, and nothing is refunded.
//
// The `shell.z` disaster's actual symptom. `applyPlacements` sheds whatever
// falls outside the building and hands the money back, so the count alone is
// not the test — a shop that shed six shelves and was paid for them has the
// same cash story as a bug nobody noticed. Both, or neither.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  furnish(g);
  const fixturesBefore = g.placements.length;
  const cashBefore = g.cash;
  const countsBefore = JSON.stringify(g.fixtureCounts());

  g.growWorld(0, 3);
  g.regenerateLayout();

  eq(g.placements.length, fixturesBefore, 'every fixture survives the shift');
  eq(JSON.stringify(g.fixtureCounts()), countsBefore, '...and the shop still owns the same shop');
  eq(g.cash, cashBefore, '...and nothing was refunded, which is how a shed one would show');
  eq(g.layout.checkouts.length, 1, '...the till in particular, which is what went to 0 last time');
  eq(g.deliveries.length, 1, 'the crate on the ground comes with it');
  eq(g.cashDrops.length, 1, '...and the money on the counter');
}

// ---------------------------------------------------------------------------
// 5. The footfall map goes with it.
//
// `sizeTraffic` copies by absolute cell, so a map left alone hands the new rows
// the old rows' readings — and `spotScore` would then rate a shelf on where
// people walked before the world moved. Invisible: the map is never drawn.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  g.regenerateLayout();
  const w = g.trafficW;
  check(w > 0, 'the shop has a footfall grid to move');

  const s = g.layout.store;
  const x = s.x + 2;
  const z = s.z + 2;
  g.traffic[z * w + x] = 42;

  g.growWorld(0, 3);
  eq(g.traffic[(z + 3) * w + x], 42, 'the footfall reading moves with the tile it was taken on');
  eq(g.traffic[z * w + x], 0, '...and does not stay behind as well');
}

// ---------------------------------------------------------------------------
// 6. ...and the back is actually bigger, which is the entire purchase.
//
// Everything above would pass on a `growWorld` that shifted the world and grew
// nothing at all — a shop shunted three rows south inside a world the same size
// as before, which is strictly worse than not buying it.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const behindBefore = g.layout.store.z;
  const hBefore = g.layout.h;

  g.grow = { w: g.grow.w, h: g.grow.h + 3 };
  g.growWorld(0, 3);
  g.regenerateLayout();

  eq(g.layout.h, hBefore + 3, 'the world is three rows taller');
  eq(g.layout.store.z, behindBefore + 3, '...and the building sits three rows further down it');
  check(g.layout.store.z - 1 >= behindBefore + 2, 'so there are three more usable rows behind the shop');
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ ${failures.length} of ${checks} checks failed:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ grow: ${checks} checks passed`);
