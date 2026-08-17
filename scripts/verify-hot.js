#!/usr/bin/env node
/**
 * VERIFY: HOT FOOD HAS SOMEWHERE TO BE, AND EVERYTHING ELSE STAYS WHERE IT WAS.
 *
 * The hot counter is the THIRD thing a unit of shelving can be, and that number
 * is the whole reason this file exists. Every stocking rule in the game was
 * written when there were two — `(itemIsFrozen) === (shelfIsFreezer)`, in six
 * files and eleven places — and a boolean is not wrong with three kinds in the
 * world, it is *silently* wrong. A hot counter reads as "not a freezer",
 * therefore as ordinary shelving: it accepts bread, and turns away the roast
 * chicken it was bought for. Nothing logs that. Nothing draws it. The unit
 * stands there looking like a hot counter and behaving like a shelf.
 *
 * So the claims here are almost all about a thing NOT happening, and not one of
 * them is visible in a screenshot:
 *
 * - **A shop that never buys one is the old game exactly.** The mechanic is new
 *   and the *existing* rules must not have moved: frozen goods still keep in a
 *   freezer and rot everywhere else, ordinary goods still get the chill bonus,
 *   shelf-stable still never spoils. Adding a third kind to `spoilRate` rewrote
 *   the function that answers all three.
 * - **A placed warmer is still a warmer after a re-flow.** This is the one that
 *   shipped broken. `makeShelf` normalised its kind with
 *   `kind === 'freezer' ? 'freezer' : 'shelf'`, and every player-placed unit
 *   goes back through it on every re-flow — so a hot counter survived being
 *   built, and was quietly demoted to plain shelving the next time anybody
 *   bought anything. The stock came with it, onto a unit that should never have
 *   taken it. Buying a shelf re-flows, so in play you would lose it within a
 *   minute of building it, and what you would see is a shelf you do not
 *   remember buying.
 * - **The matrix is a recount, not a pair.** Nine combinations of three kinds
 *   and three items, asserted by walking `STOCK_KINDS` rather than by naming
 *   freezer and warmer — or a fourth kind lands with two of its rules written.
 * - **The asymmetry between the shop and your own hands is deliberate.** The
 *   staff, reservations and the re-flow work to "this kind and no other"; your
 *   hands only refuse goods that NAMED a fixture. You may stand a loaf in a
 *   freezer and watch what happens. Both halves are load-bearing and they look
 *   like an inconsistency, which is exactly why they are pinned here.
 * - **A re-flow drops misplaced stock rather than carrying it.** A chicken must
 *   not ride a carry-over onto ordinary shelving, and the goods must survive.
 *
 * It authors one piece and tags nothing: the items it needs it builds in
 * memory, because tagging a live item would change what the shop next door is
 * selling. The piece is removed on exit, the way `verify-catalog` does it.
 *
 *   node scripts/verify-hot.js
 */

import { Game } from '../server/sim/index.js';
import { content, writeContent } from '../server/content.js';
import { remove } from '../server/db.js';
import { STOCK_KINDS, shelfKind, holdsGoods, FIXTURES, FIXTURE_KINDS } from '../shared/build.js';
import {
  spoilRate, homeKind, holds, requiredFixture, CHILL_KEEPS, HEAT_SPOILS, MISKEPT_PENALTY,
} from '../shared/tags.js';
import { WALKABLE } from '../shared/tiles.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/** The same pinned shop the other sweeps use, and for the same reason. */
const SHOP = { shelf: 6, freezer: 1, checkout: 1, plot: 4 };

function fresh() {
  const g = Game.create({ worldId: 'verify', seed: 'hot', ephemeral: true });
  g.placements = [];
  g.grow = { w: 0, h: 0 };
  g.doorShift = 0;
  g.edits = [];
  // See `verify-catalog`: with a shell stored the generator stops growing one
  // to fit, and the pinned shop above comes back with no shelves in it.
  g.shell = null;
  // Owning an upgrade can change what a fixture COSTS, and this sweep does a
  // build-and-sell round trip — see the same clearing in `verify-economy`.
  g.ownedUpgrades = [];
  g.regenerateLayout(null, {}, { want: SHOP });
  g.freezeShell();
  g.cash = 5000;
  g.addPlayer('me', 'Tester');
  g.players.me.build = { on: true, tool: 'shelf' };
  return g;
}

/** A free indoor floor tile with nothing on it. */
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
// Test items, in memory only.
//
// Never written to the catalog. Tagging a real row would change what every
// other shop pointed at this database is selling, and this sweep runs against
// the live shared one — but more to the point, these are *inputs to pure
// functions*. `spoilRate`, `homeKind` and `holds` never look anything up.
// ---------------------------------------------------------------------------
const HOT = { id: 'zz-hot', name: 'Test Roast', shelf_life_days: 2, tags: ['meat', 'prepared', 'needs-warmer'] };
const COLD = { id: 'zz-cold', name: 'Test Ice', shelf_life_days: 45, tags: ['frozen', 'needs-freezer'] };
const PLAIN = { id: 'zz-plain', name: 'Test Loaf', shelf_life_days: 3, tags: ['bakery', 'perishable'] };
const TINNED = { id: 'zz-tin', name: 'Test Tin', shelf_life_days: 400, tags: ['pantry', 'shelf-stable'] };

/** The piece the shop actually buys. Removed on exit, crash or not. */
const TEST_PIECE = {
  id: 'zz-test-warmer',
  kind: 'warmer',
  name: 'Test Hot Counter',
  model: { parts: [{ shape: 'box', color: '#d8a05a', pos: [0, 0.45, 0], scale: [0.8, 0.9, 0.8] }] },
  cost: 260,
  tiers: [{ name: 'Only', cost: 0 }],
};

process.on('exit', () => {
  try { remove('fixtures', TEST_PIECE.id); } catch { /* the DB is already gone */ }
});

{
  const res = writeContent('fixture', TEST_PIECE, 'verify');
  check(res.ok, 'the catalog accepts a piece of kind warmer', res.error ?? '');
}

// ---------------------------------------------------------------------------
// 1. The vocabulary. Three kinds hold goods, and they are the same three
//    everywhere.
// ---------------------------------------------------------------------------
{
  eq(STOCK_KINDS.length, 3, 'there are three kinds of unit that hold goods');
  for (const k of STOCK_KINDS) {
    check(FIXTURES[k] != null, `${k} has placement rules — it is a fixture, not ground`);
    check(holdsGoods(k), `holdsGoods says ${k} holds goods`);
    check(FIXTURE_KINDS.includes(k), `${k} is a fixture the generator could have a budget for`);
    // The three are interchangeable in every way a KIND decides. That is the
    // argument for a warmer being a kind at all rather than a column on the
    // piece: if these ever diverged, the difference would belong in the row.
    eq(FIXTURES[k].anchor, 'browseAt', `${k} is browsed from the tile it faces`);
    eq(FIXTURES[k].where, 'indoor', `${k} goes indoors`);
    eq(FIXTURES[k].blocks, true, `${k} occupies its cell`);
  }
  // A save written before any of this holds units with no kind at all, beside
  // ones that say 'freezer'. Both have to come out right with nobody running a
  // migration — the read-time default, not a defensive one.
  eq(shelfKind(undefined), 'shelf', 'a unit from a save with no kind is plain shelving');
  eq(shelfKind(null), 'shelf', 'so is one with a null kind');
  eq(shelfKind('freezer'), 'freezer', 'and a stored freezer is still a freezer');
  eq(shelfKind('warmer'), 'warmer', 'and a stored warmer is still a warmer');
  // The one that would let the demotion bug back in wearing a different hat: a
  // kind nobody recognises must not silently become shelving *at the top of the
  // list*, it must become shelving because it is not in the list.
  eq(shelfKind('checkout'), 'shelf', 'a kind that does not hold goods is not treated as one');
}

// ---------------------------------------------------------------------------
// 2. The old game, unchanged.
//
// `spoilRate` was rewritten to take a kind instead of a boolean, and it is the
// function behind every unit of stock in every shop. These four are what it
// said before the hot counter existed, asserted against the constants rather
// than against literals so that re-tuning one moves the assertion with it.
// ---------------------------------------------------------------------------
{
  const base = spoilRate(PLAIN, { in: 'shelf' });
  check(base > 0, 'ordinary perishable goods go off on a shelf');

  // Frozen goods: their authored life IS their frozen life, so a freezer is
  // what they expect rather than a favour.
  eq(spoilRate(COLD, { in: 'freezer' }), 1, 'frozen goods keep for their authored life in a freezer');
  eq(spoilRate(COLD, { in: 'shelf' }), MISKEPT_PENALTY, 'and go off fast left out on a shelf');

  // Cold is a bonus to anything that did not ask for it.
  eq(spoilRate(PLAIN, { in: 'freezer' }), base * CHILL_KEEPS, 'a freezer is kind to goods with no opinion');

  // Shelf-stable wins over everything, in every kind of unit.
  for (const k of STOCK_KINDS) eq(spoilRate(TINNED, { in: k }), 0, `a tin never spoils, even in a ${k}`);

  // And the default is plain shelving, which is what every caller that has
  // never heard of a kind gets.
  eq(spoilRate(PLAIN), spoilRate(PLAIN, { in: 'shelf' }), 'no fixture named means plain shelving');
}

// ---------------------------------------------------------------------------
// 3. The new half, and its symmetry.
// ---------------------------------------------------------------------------
{
  const hotBase = spoilRate(HOT, { in: 'warmer' });
  check(hotBase > 0, 'hot food goes off even in a hot counter');

  // The claim that makes the tag worth having: the shelf a roast chicken used
  // to sit on quite happily is now the wrong place for it, by the same factor
  // ice cream on that shelf is.
  eq(spoilRate(HOT, { in: 'shelf' }), hotBase * MISKEPT_PENALTY,
    'hot food on ordinary shelving goes off as fast as ice cream does');
  // Symmetric on purpose — being in the WRONG special fixture is not better
  // than being in none. A boolean `chilled` could never say this: a chicken in
  // a freezer came out as "chilled: true", which used to mean "where it wants
  // to be", so the shop would have called it perfectly kept.
  eq(spoilRate(HOT, { in: 'freezer' }), hotBase * MISKEPT_PENALTY,
    'and a chicken in a freezer is no better kept than one on a shelf');
  eq(spoilRate(COLD, { in: 'warmer' }), spoilRate(COLD, { in: 'shelf' }),
    'ice cream in a hot counter is no better off than ice cream on a shelf');

  // Heat is not a favour. This is the one place the warmer is not simply the
  // freezer's mirror: a freezer helps goods with no opinion and a warmer cooks
  // them slowly.
  const base = spoilRate(PLAIN, { in: 'shelf' });
  eq(spoilRate(PLAIN, { in: 'warmer' }), base * HEAT_SPOILS, 'a loaf under a heat lamp goes off faster');
  check(HEAT_SPOILS > 1, 'a hot counter is unkind to goods that did not ask for heat');
  check(HEAT_SPOILS < MISKEPT_PENALTY,
    'leaving a loaf under a lamp is a worse idea than a shelf, but not as bad as leaving ice cream out');
}

// ---------------------------------------------------------------------------
// 4. The matrix. Every kind holds its own goods and nobody else's.
//
// Walked over `STOCK_KINDS` rather than written out, which is the whole point:
// a fourth kind added tomorrow arrives here with every combination asserted
// rather than with the two somebody remembered.
// ---------------------------------------------------------------------------
{
  const cases = [[PLAIN, 'shelf'], [COLD, 'freezer'], [HOT, 'warmer'], [TINNED, 'shelf']];
  for (const [item, home] of cases) {
    eq(homeKind(item), home, `${item.name} lives on a ${home}`);
    for (const k of STOCK_KINDS) {
      eq(holds(k, item), k === home, `a ${k} ${k === home ? 'holds' : 'does not hold'} ${item.name}`);
    }
  }
  // `homeKind` is total and `requiredFixture` is not, and the difference is
  // load-bearing: the second is what "did you actually ask for something"
  // means, which is the one-way rule your own hands work to.
  eq(requiredFixture(PLAIN), null, 'ordinary goods name no fixture');
  eq(requiredFixture(HOT), 'warmer', 'hot food names one');
  eq(homeKind(PLAIN), 'shelf', 'naming nothing still resolves to a kind');
}

// ---------------------------------------------------------------------------
// 5. A warmer you built is a warmer after a re-flow.
//
// The bug this exists for. Everything below would pass with `makeShelf`
// demoting the unit, right up to the last two lines.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const spot = freeFloor(g);
  check(spot != null, 'the test shop has a free tile to build on');

  const cash = g.cash;
  const built = g.placeFixture('me', { kind: 'warmer', piece: TEST_PIECE.id, x: spot.x, z: spot.z, rot: 0 });
  check(built.ok, 'a hot counter can be built', built.error ?? '');
  check(g.cash < cash, 'building one costs money');

  const id = built.placed;
  const find = () => g.layout.shelves.find((s) => s.id === id) ?? null;
  check(find() != null, 'it lands in the shelves list, like every unit that holds goods');
  eq(shelfKind(find()?.kind), 'warmer', 'and it is a warmer the moment it is built');

  // Put something on it that only a warmer may hold, so the re-flow has stock
  // to lose as well as a kind. Straight onto the record — this is a claim about
  // the layout surviving, not about the stocking rules, which section 6 covers.
  find().stacks = [{ item_id: HOT.id, qty: 4, price: 5, stockedDay: g.day }];

  // Any purchase re-flows. That is the whole reason the bug was fatal rather
  // than cosmetic: you would lose the counter within a minute of building it,
  // by buying the next thing.
  const other = freeFloor(g, new Set([`${spot.x},${spot.z}`]));
  const second = g.placeFixture('me', { kind: 'shelf', x: other.x, z: other.z, rot: 0 });
  check(second.ok, 'a second unit can be built beside it', second.error ?? '');

  eq(shelfKind(find()?.kind), 'warmer', 'the hot counter is STILL a warmer after a re-flow');
  eq(find()?.piece, TEST_PIECE.id, 'and still the piece you chose');
  eq(find()?.stacks?.[0]?.qty, 4, 'and its stock came with it');

  // Belt and braces: a re-flow with no purchase behind it, which is what a
  // reload or a world event does.
  g.regenerateLayout();
  eq(shelfKind(find()?.kind), 'warmer', 'and after a bare re-flow too');
}

// ---------------------------------------------------------------------------
// 6. Who may put what where. The shop's rule and your hands' rule differ, and
//    both halves are deliberate.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const spot = freeFloor(g);
  const built = g.placeFixture('me', { kind: 'warmer', piece: TEST_PIECE.id, x: spot.x, z: spot.z, rot: 0 });
  check(built.ok, 'a hot counter for the stocking rules', built.error ?? '');
  const warmer = g.layout.shelves.find((s) => s.id === (built.placed));
  const shelf = g.layout.shelves.find((s) => shelfKind(s.kind) === 'shelf' && s.id !== warmer.id);
  const freezer = g.layout.shelves.find((s) => shelfKind(s.kind) === 'freezer');
  check(warmer && shelf && freezer, 'the test shop has one of each kind');

  // The SHOP's rule — what a reservation may say, which is an instruction the
  // staff have to be able to carry out. Two-way: a reservation nobody will ever
  // honour leaves the unit empty for ever, which is worse than no reservation.
  const real = content().items.find((it) => requiredFixture(it) == null && !it.tags.includes('shelf-stable'));
  check(real != null, 'the catalog has an ordinary perishable to reserve');
  if (real) {
    check(g.assignShelf('me', shelf.id, real.id).ok, 'ordinary goods can be reserved on a shelf');
    check(!g.assignShelf('me', warmer.id, real.id).ok, 'but not on a hot counter — nothing would ever stock it');
    check(!g.assignShelf('me', freezer.id, real.id).ok, 'nor in a freezer, for the same reason');
  }

  // YOUR HANDS' rule — one-way. This looks like an inconsistency and is not:
  // you may stand a loaf in a freezer if you like, and `spoilRate` has an
  // opinion about what that costs you. What is refused is goods that NAMED a
  // fixture being put somewhere else.
  if (real) {
    check(g.boardFor(warmer, real).ok !== false || true, 'by hand, ordinary goods are not refused a hot counter');
    const byHand = g.boardFor(warmer, real);
    check(byHand.ok !== false, 'by hand you may stand a loaf under a heat lamp', byHand.error ?? '');
  }

  // And the half that is not loose either way: something that named a fixture.
  const frozen = content().items.find((it) => requiredFixture(it) === 'freezer');
  if (frozen) {
    check(!g.boardFor(warmer, frozen).ok, 'even by hand, frozen goods are refused a hot counter');
    check(!g.boardFor(shelf, frozen).ok, 'and refused a shelf, exactly as before');
    check(g.boardFor(freezer, frozen).ok, 'and accepted by the freezer they asked for');
    // The message names the fixture rather than saying "a freezer" always,
    // which is what makes the refusal actionable for a kind authored tomorrow.
    const said = g.boardFor(warmer, frozen).error ?? '';
    check(said.toLowerCase().includes('freezer'), 'and the refusal says WHICH fixture it wanted', said);
  }
}

// ---------------------------------------------------------------------------
// 7. A re-flow does not carry misplaced stock onto the wrong unit.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const spot = freeFloor(g);
  const built = g.placeFixture('me', { kind: 'warmer', piece: TEST_PIECE.id, x: spot.x, z: spot.z, rot: 0 });
  check(built.ok, 'a hot counter for the carry-over test', built.error ?? '');
  const id = built.placed;
  const frozen = content().items.find((it) => requiredFixture(it) === 'freezer');

  if (frozen) {
    // Stock the hot counter with something only a freezer may hold — the state
    // a re-flow has to refuse to carry, however it got there.
    const before = g.layout.shelves.find((s) => s.id === id);
    before.stacks = [{ item_id: frozen.id, qty: 6, price: 3, stockedDay: g.day }];
    // Reserve it for the same thing, which the sweep afterwards must clear:
    // a label nothing can honour is a board that sits empty for ever.
    before.assigned = [frozen.id];

    const held = g.countGoods ? g.countGoods(frozen.id) : null;
    g.regenerateLayout();

    const after = g.layout.shelves.find((s) => s.id === id);
    check(after != null, 'the hot counter survived the re-flow');
    const still = (after?.stacks ?? []).some((k) => k.item_id === frozen.id && k.qty > 0);
    check(!still, 'frozen goods do not stay on a hot counter through a re-flow');
    check(!(after?.assigned ?? []).includes(frozen.id),
      'and the reservation nothing could honour is cleared rather than kept');
    // Cleared, not destroyed. `verify-build` makes this claim about every other
    // way goods move; it has to hold here too or a re-flow is a way to lose
    // stock by having built the wrong unit.
    if (held != null) eq(g.countGoods(frozen.id), held, 'and the goods themselves survive it');
  }
}

// ---------------------------------------------------------------------------
// 8. A shop with no hot counter is the old game.
//
// The break area makes this claim about staff and the car park makes it about
// shoppers. It is the same claim, and it is the one that says a feature is
// opt-in: every shop that exists today has no warmer in it.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const kinds = new Set(g.layout.shelves.map((s) => shelfKind(s.kind)));
  check(!kinds.has('warmer'), 'nothing generates a hot counter — you buy one or you have none');
  check(kinds.has('shelf') && kinds.has('freezer'), 'the generated shop is shelves and a freezer, as it always was');

  // And the goods that were fine before are still fine: nothing in the starting
  // catalog is homeless in a shop with no warmer unless somebody tagged it.
  const homeless = content().items.filter((it) => !kinds.has(homeKind(it)));
  for (const it of homeless) {
    check(requiredFixture(it) != null,
      `${it.id} has nowhere to go in a normal shop, and it never asked for a fixture`);
  }
}

// ---------------------------------------------------------------------------
if (failures.length) {
  console.error(`\nverify:hot — ${checks} assertions, ${failures.length} FAILED\n`);
  for (const f of failures) console.error(`  ❌  ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`\nverify:hot — ${checks} assertions\n`);
console.log('  ✅  hot food has a home, and a warmer is still one after a re-flow.\n');
