#!/usr/bin/env node
/**
 * VERIFY: KINDS ARE CODE, PIECES ARE CONTENT.
 *
 * `verify-layout` proves the generator places what it was asked for and
 * `verify-build` proves nothing is created or destroyed by building. This one
 * guards the seam between them: that a piece is what gets drawn, priced and
 * upgraded, that a decoration is genuinely weightless, and that neither can
 * reach into anything the other two are asserting about.
 *
 * Three things this is built to catch, each of which would otherwise look like
 * something else entirely:
 *
 * - **A piece resolving to its kind.** Every fixture in the game was drawn from
 *   a row whose id IS its kind, so a lookup that quietly falls back to the kind
 *   passes every eyeball test in a shop that only owns the original five. It
 *   fails the day somebody authors a second shelf — as "my new shelf looks like
 *   the old one", which reads as a modelling mistake rather than a wiring one.
 * - **A prop weighing something.** A decoration that stamped a tile, reserved a
 *   working spot or took a generator budget would show up as a shop that
 *   re-flows when you put a plant down. So the assertions here are against the
 *   *tiles and the fixtures*, not against the prop.
 * - **An assertion that decays.** Half of these place a prop and then check
 *   something did not change. If placing ever silently fails, "did not change"
 *   passes perfectly. So every one of them asserts the placement worked first,
 *   and the sweep asserts at the end that it actually exercised a prop at all.
 *
 * Runs on an ephemeral Game, so it never touches the live shop.
 *
 *   node scripts/verify-catalog.js
 */

import { Game } from '../server/sim/index.js';
import { content, writeContent } from '../server/content.js';
import { remove } from '../server/db.js';
import {
  BUILD_KINDS, FIXTURE_KINDS, PROP_KINDS, FIXTURES, isProp, isFloor, canPlace,
} from '../shared/build.js';
import { kindOf, pieceFor, defaultPiece, piecesOf, countKey } from '../shared/pieces.js';
import { WALKABLE } from '../shared/tiles.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/** Same pinned shop `verify-build` uses, and for the same reason. */
const SHOP = { shelf: 6, freezer: 1, checkout: 1, plot: 4 };

function fresh() {
  const g = Game.create({ worldId: 'verify', seed: 'catalog', ephemeral: true });
  g.placements = [];
  g.grow = { w: 0, h: 0 };
  g.doorShift = 0;
  g.edits = [];
  // The stored shell goes too, and this one is the subtlest of the lot. With a
  // shell set, the building is the size it already is and the generator stops
  // growing one to fit — so asking for the shop below and leaving the shell
  // alone asks a 10x9 shop to hold a 10x11 shop's worth of shelving, and
  // `compose` hands back a layout with no shelves in it at all.
  g.shell = null;
  // `want` is how a shop of a stated shape is asked for now. It used to be
  // `g.fixtures = {...SHOP}` — the stored ledger, which step 9 retired: the
  // generator is handed either the base shop or whatever is already standing,
  // and neither of those is a sweep's pinned six-and-a-freezer.
  g.regenerateLayout(null, {}, { want: SHOP });
  // ...and re-stamp, so what the sweep drives is a stamped shop like any other.
  g.freezeShell();
  g.cash = 5000;
  g.addPlayer('me', 'Tester');
  g.players.me.build = { on: true, tool: 'shelf' };
  return g;
}

/** A free indoor floor tile with nothing on it and nothing hand-placed on it. */
function freeFloor(g, taken = new Set()) {
  const L = g.layout;
  for (let z = L.store.z; z < L.store.z + L.store.h; z++) {
    for (let x = L.store.x; x < L.store.x + L.store.w; x++) {
      if (taken.has(`${x},${z}`)) continue;
      if (!WALKABLE.has(L.tiles[z * L.w + x])) continue;
      if (g.fixtureAt(x, z)) continue;
      if ((L.props ?? []).some((p) => p.x === x && p.z === z)) continue;
      return { x, z };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test pieces.
//
// Authored here rather than assumed to exist, because this suite is about what
// happens when somebody adds a SECOND design — and a sweep that only ever sees
// the five shipped rows cannot tell a piece lookup from a kind lookup. Removed
// again at the end, so running this never leaves anything in the catalog.
// ---------------------------------------------------------------------------
const box = (color, scale, pos = [0, 0, 0]) => ({ shape: 'box', color, pos, scale });

const TEST_PIECES = [
  {
    id: 'zz-test-shelf',
    kind: 'shelf',
    name: 'Test Shelving',
    model: { parts: [box('#8a6f4e', [0.8, 0.9, 0.8], [0, 0.45, 0])] },
    // A deliberately different ladder from the shipped shelf: one rung, so
    // "which ladder did you read" has a visible answer.
    tiers: [{ name: 'Only', cost: 0, capacity_mult: 2 }],
  },
  {
    id: 'zz-test-planter',
    kind: 'prop-floor',
    name: 'Test Planter',
    model: { parts: [box('#a4552f', [0.5, 0.4, 0.5], [0, 0.2, 0])] },
    cost: 25,
  },
  {
    id: 'zz-test-lamp',
    kind: 'prop-ceiling',
    name: 'Test Pendant',
    model: { parts: [box('#ffe9b0', [0.3, 0.25, 0.3], [0, -0.2, 0])] },
    cost: 40,
    emits: { color: '#ffd9a0', intensity: 1.2, range: 5 },
  },
];

// Registered before the first write, not after the last one. This sweep runs
// against whatever database it is pointed at, which in practice is the live
// shared one — so a crash halfway through must not leave "Test Planter" sitting
// on somebody else's build palette until the next person notices.
process.on('exit', () => {
  for (const p of TEST_PIECES) {
    try { remove('fixtures', p.id); } catch { /* the DB is already gone */ }
  }
});

for (const p of TEST_PIECES) {
  const res = writeContent('fixture', p, 'verify');
  check(res.ok, `the catalog accepts a ${p.kind} piece called ${p.id}`, res.error ?? '');
}

// ---------------------------------------------------------------------------
// 1. The vocabulary itself.
// ---------------------------------------------------------------------------
{
  // Three buckets now, not two. A floor joined the vocabulary without joining
  // `FIXTURES`, because everything in that table answers "where may this stand
  // and who reaches it" and a floor answers neither — it is what the cell is
  // made of. Counted rather than asserted per kind so that adding a fourth
  // category has to come past this line: a kind in no bucket is a kind nothing
  // in the game knows how to treat, which is the scenery failure the whole
  // kinds/pieces split exists to prevent.
  const floors = BUILD_KINDS.filter((k) => isFloor(k));
  eq(floors.length, 1, 'there is exactly one kind that is ground rather than a thing');
  eq(BUILD_KINDS.length, FIXTURE_KINDS.length + PROP_KINDS.length + floors.length,
    'every kind is exactly one of: a fixture, a decoration, or the floor');
  for (const k of floors) {
    check(!FIXTURES[k], `${k} has no placement rules — it is not placed, it is painted`);
    check(!isProp(k), `${k} is not a decoration`);
    check(!FIXTURE_KINDS.includes(k), `${k} is not a fixture — nothing procedural has a budget for ground`);
  }
  for (const k of FIXTURE_KINDS) {
    // A fixture is something you own and the generator has a budget for. It
    // earns its cell either by standing in it or by *being* it — a plot is dug
    // ground, which is why "blocks" alone is not the test.
    check(FIXTURES[k].blocks === true || FIXTURES[k].ground != null,
      `${k} either occupies its cell or is what the cell is made of`);
    check(!isProp(k), `${k} is a fixture, not a decoration`);
  }
  for (const k of PROP_KINDS) {
    check(FIXTURES[k].blocks === false, `${k} blocks nobody`);
    check(FIXTURES[k].ground == null, `${k} does not change what the floor is made of`);
    check(isProp(k), `${k} reads as a prop`);
    check(FIXTURES[k].anchor == null, `${k} has no working spot — nobody stands at a decoration`);
  }
  // The kinds a shipped row names have to still exist, or the shop everybody is
  // already playing loses its shelves.
  for (const row of content().fixtures) {
    check(BUILD_KINDS.includes(kindOf(row)), `the shipped piece "${row.id}" names a real kind`, kindOf(row));
  }
}

// ---------------------------------------------------------------------------
// 2. A row written before the split still names itself.
//
// The whole migration, and it is a read-time default rather than a database
// change — so this is the assertion standing in for a migration script that
// deliberately does not exist.
// ---------------------------------------------------------------------------
{
  eq(kindOf({ id: 'shelf' }), 'shelf', 'a row with no kind is its own kind');
  eq(kindOf({ id: 'anything', kind: 'freezer' }), 'freezer', 'a row with a kind uses it');
  eq(kindOf({ id: 'shelf', kind: '' }), 'shelf', 'a blank column reads as no kind at all');
}

// ---------------------------------------------------------------------------
// 3. Which piece a fixture resolves to.
// ---------------------------------------------------------------------------
{
  const rows = content().fixtures;
  eq(defaultPiece(rows, 'shelf')?.id, 'shelf',
    'the kind\'s own row stays the default, so every shelf already standing keeps its design');
  check(piecesOf(rows, 'shelf').length >= 2, 'a kind can have more than one piece');

  eq(pieceFor(rows, { kind: 'shelf', piece: 'zz-test-shelf' })?.id, 'zz-test-shelf',
    'a fixture that names a piece gets that piece');
  eq(pieceFor(rows, { kind: 'shelf' })?.id, 'shelf',
    'a fixture that names none gets the default');
  eq(pieceFor(rows, { kind: 'shelf', piece: 'zz-test-planter' })?.id, 'shelf',
    'a piece of the wrong kind is not honoured — a shelf cannot be drawn as a planter');
  eq(pieceFor(rows, { kind: 'shelf', piece: 'deleted-yesterday' })?.id, 'shelf',
    'a piece that no longer exists falls back rather than drawing nothing');
}

// ---------------------------------------------------------------------------
// 4. A second design of a kind builds, and is priced and laddered as itself.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const spot = freeFloor(g);
  check(!!spot, 'the test shop has somewhere to build');

  const built = g.placeFixture('me', { kind: 'shelf', piece: 'zz-test-shelf', x: spot.x, z: spot.z, rot: 0 });
  check(built.ok, 'a second shelf design can be built', built.error ?? '');

  const f = g.findFixture(built.placed);
  check(!!f, 'and it is in the layout');
  eq(f.piece, 'zz-test-shelf', 'the layout remembers which design it is');
  eq(g.fixtureContent(f)?.id, 'zz-test-shelf', 'and resolves to that piece, not to its kind');

  // The ladder is the sharpest of these: reading the kind's row instead would
  // hand this fixture the shipped shelf's tiers, which are longer.
  eq(g.fixtureTiers(f).length, 1, 'it climbs its own ladder');
  eq(g.nextTier(f), null, 'a one-rung piece has nothing to upgrade to');
  eq(g.fixtureStats(f).capacity_mult, 2, 'and its own multipliers reach the sim');

  // Moving it must not restyle it. Picking a shelf up and putting it down went
  // through a spec that had no `piece` on it at all until this was wired.
  const dest = freeFloor(g, new Set([`${spot.x},${spot.z}`]));
  check(g.liftFixture('me', f.id).ok, 'it can be picked up');
  const moved = g.dropFixture('me', { x: dest.x, z: dest.z, rot: 0 });
  check(moved.ok, 'and set down again', moved.error ?? '');
  eq(g.findFixture(moved.moved)?.piece, 'zz-test-shelf', 'and it is still the design it was');

  // Counting. The old stored ledger had to file this under `shelf`, because it
  // doubled as the generator's shopping list and a design counted under its own
  // name got no budget asked for it — so `compose` dropped the placement on the
  // next re-flow, silently, one shelf at a time. Nothing is asked for any more,
  // so a piece counts as itself.
  eq(countKey('shelf', { piece: 'zz-test-shelf' }), 'zz-test-shelf',
    'a second shelf design counts under its own name');
  const counts = g.fixtureCounts();
  eq(counts['zz-test-shelf'], 1, 'one of the new design is standing in the shop');
  eq(counts.shelf, SHOP.shelf, '...and the originals still count as the original');
  eq(Object.values(counts).reduce((s, n) => s + n, 0), SHOP.shelf + SHOP.freezer
    + SHOP.checkout + SHOP.plot + 1, 'and nothing was counted twice');

  // The claim the old ledger key existed to protect, asserted directly rather
  // than through the mechanism that used to guarantee it: it has to still be
  // there afterwards. Three re-flows, because "dropped one at a time" is what
  // the failure looked like and once is not a trend.
  for (let i = 0; i < 3; i++) g.regenerateLayout();
  check(!!g.findFixture(moved.moved), 'and it survives being re-flowed three times');
  eq(g.fixtureCounts()['zz-test-shelf'], 1, 'still exactly one of it');
}

// ---------------------------------------------------------------------------
// 5. A decoration is weightless.
//
// Asserted against the shop rather than against the prop, because "the prop is
// fine" is not the claim — the claim is that nothing else moved.
// ---------------------------------------------------------------------------
let exercisedProp = false;
{
  const g = fresh();
  const spot = freeFloor(g);
  const before = {
    tile: g.layout.tiles[spot.z * g.layout.w + spot.x],
    shelves: g.layout.shelves.length,
    walk: g.walk.slice(),
    cash: g.cash,
  };

  const put = g.placeFixture('me', { kind: 'prop-floor', piece: 'zz-test-planter', x: spot.x, z: spot.z, rot: 0 });
  check(put.ok, 'a decoration can be placed', put.error ?? '');
  exercisedProp = put.ok;

  eq(g.layout.props.length, 1, 'it lands in the props list');
  eq(g.layout.tiles[spot.z * g.layout.w + spot.x], before.tile, 'it stamps no tile');
  eq(g.layout.shelves.length, before.shelves, 'and displaces no shelving');
  check(g.walk.every((v, i) => v === before.walk[i]), 'the walk grid is untouched — you walk past a plant');
  eq(g.fixtureCounts().shelf, SHOP.shelf, 'and it is not counted as a shelf');
  eq(g.fixtureCounts()['zz-test-planter'], 1, 'a prop counts under its own name');
  eq(Math.round(before.cash - g.cash), 25, 'the piece\'s own price is what was charged');

  // The cell is still floor, so a shopper can stand on it — but nothing else may
  // be put there, or the pointer would name two things and open neither.
  const again = g.placeFixture('me', { kind: 'prop-floor', piece: 'zz-test-planter', x: spot.x, z: spot.z, rot: 0 });
  check(!again.ok, 'two decorations cannot share a cell');

  // ...and it survives the generator, which is the failure mode `placements`
  // exists for: re-flow rebuilds the shop from scratch every time you buy.
  const id = put.placed;
  g.regenerateLayout();
  check(!!g.findFixture(id), 'a decoration survives a re-flow');

  const sold = g.removeFixture('me', id);
  check(sold.ok, 'and can be sold back', sold.error ?? '');
  eq(g.layout.props.length, 0, 'which takes it out of the world');
  eq(g.fixtureCounts()['zz-test-planter'], undefined, 'and stops being counted at all');
}

// ---------------------------------------------------------------------------
// 6. Where a decoration may go, and where it may not.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const L = g.layout;
  const shelf = L.shelves[0];
  const floor = freeFloor(g);
  const grass = (() => {
    for (let z = 0; z < L.h; z++) {
      for (let x = 0; x < L.w; x++) {
        if (!WALKABLE.has(L.tiles[z * L.w + x])) continue;
        if (L.indoor[z * L.w + x] === 1) continue;
        if (x < 1 || z < 1 || x >= L.w - 1 || z >= L.h - 1) continue;
        return { x, z };
      }
    }
    return null;
  })();
  check(!!grass, 'the test world has ground outside');

  check(canPlace(L, { kind: 'prop-floor', ...floor, rot: 0 }).ok, 'a floor prop goes indoors');
  check(canPlace(L, { kind: 'prop-floor', ...grass, rot: 0 }).ok, '...and outdoors');
  check(!canPlace(L, { kind: 'prop-floor', x: shelf.x, z: shelf.z, rot: 0 }).ok,
    '...but not inside a shelf');

  check(canPlace(L, { kind: 'prop-ceiling', ...floor, rot: 0 }).ok, 'a hanging prop goes indoors');
  check(!canPlace(L, { kind: 'prop-ceiling', ...grass, rot: 0 }).ok,
    '...and not out in a field, because there is no ceiling out there');

  // Every soft answer `canPlace` gives is about occupying a cell, and a prop
  // doesn't — so a prop should never warn. If one ever does, the reason is a
  // fixture rule that has leaked into the prop path.
  for (const kind of PROP_KINDS) {
    const v = canPlace(L, { kind, ...floor, rot: 0 });
    check(!v.warn, `placing a ${kind} has no consequences to warn about`, v.warn ?? '');
  }
}

// ---------------------------------------------------------------------------
// 7. A prop nobody has drawn is nothing.
//
// The one place props and fixtures are deliberately treated differently, and
// the palette makes the same call — so if this flips, the bar starts offering
// something the server refuses.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const rows = content().fixtures;
  eq(g.pieceId('shelf', 'no-such-design'), 'shelf',
    'an unknown design falls back to the kind\'s own row');

  // Deliberately not asserted against a named id. Which planter is "the default"
  // depends on what anybody has authored, so pinning one here would fail the day
  // somebody adds a second — as a red sweep about a feature nobody touched. The
  // claim is the property: you get back a real piece, of the kind you asked for.
  const fallback = g.pieceId('prop-floor', 'no-such-design');
  check(!!fallback, 'a prop with an unknown design still resolves, while the kind has any pieces');
  eq(kindOf(rows.find((p) => p.id === fallback)), 'prop-floor',
    'and what comes back is genuinely a piece of that kind');

  const spot = freeFloor(g);
  const bogus = g.placeFixture('me', { kind: 'prop-floor', piece: 'no-such-design', x: spot.x, z: spot.z, rot: 0 });
  check(bogus.ok, 'so a stale piece id still builds something rather than erroring');
  eq(g.layout.props[0].piece, fallback, 'as that same fallback design');
}

// ---------------------------------------------------------------------------
// 8. Lamps: emits reaches the renderer's list, and the cap is real.
//
// The renderer itself is not importable headlessly (it needs a WebGL context),
// so what is asserted here is the part that decides *which* lights exist —
// which is the part that can be wrong in a way nobody sees until the frame rate
// drops on somebody else's laptop.
// ---------------------------------------------------------------------------
{
  const { emittersIn } = await import('../client/render/lights.js');
  const g = fresh();
  const rows = content().fixtures;
  const pieceOf = (f) => pieceFor(rows, f);

  const lit = { id: 'a', kind: 'prop-ceiling', piece: 'zz-test-lamp', x: 4, z: 5, rot: 0 };
  const dark = { id: 'b', kind: 'prop-floor', piece: 'zz-test-planter', x: 6, z: 5, rot: 0 };

  const found = emittersIn([lit, dark], pieceOf, 1.15);
  eq(found.length, 1, 'only the piece carrying `emits` is a light');
  eq(found[0].color, '#ffd9a0', 'and it lights in the colour it was authored');
  eq(found[0].range, 5, 'at the range it was authored');
  check(found[0].y > 1, 'a hanging lamp lights from the ceiling, not the floor');

  eq(emittersIn(g.layout.shelves.map((s) => ({ ...s, kind: 'shelf' })), pieceOf, 1.15).length, 0,
    'and nothing that was never authored as a light is one');
}

// ---------------------------------------------------------------------------

check(exercisedProp, 'this sweep actually placed a decoration');

console.log(`\nverify:catalog — ${checks} assertions`);
if (failures.length) {
  console.error(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✅  pieces resolve to themselves, and a decoration weighs nothing.\n');
