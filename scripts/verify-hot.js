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
 * - **One rule, and the POUR is why.** The staff, reservations, the re-flow and
 *   your own hands all work to "this kind and no other". They did not for two
 *   steps: your hands refused only goods that had NAMED a fixture, which is a
 *   freedom right up until a mixed crate makes the choice for you. `pourInto`
 *   empties pile by pile, so a box of carrots and eggs tipped into a freezer
 *   spent a cold board on the carrots and left the eggs — one press, no
 *   refusal, and the eggs have nowhere else in the shop to be. No ordering of
 *   the piles fixes that, because a sort says which goes on first and cannot
 *   say "and then stop". `shelfAccepts` moved with it, or the highlight
 *   promises a shelf the press refuses.
 * - **A re-flow drops misplaced stock rather than carrying it, and DROPS is the
 *   word.** A chicken must not ride a carry-over onto ordinary shelving — and
 *   the goods have to end up on the floor, not nowhere. Both sides of the
 *   asymmetry above reach this loop and only one of them has a tag on it: the
 *   coffee somebody stood in a freezer is ordinary in every way an item can be,
 *   so the only thing that says it may not stay there is the shop's own rule.
 *   For four steps that rule was a bare `filter` and the stock ceased to exist
 *   on the next wall segment anybody drew, which is invisible twice over — a
 *   shop a few cases poorer looks exactly like a shop that sold them.
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

/**
 * Every case of one item the shop can account for, wherever it is standing.
 *
 * The conservation claims here are all about a re-flow SHEDDING a board, and
 * the failure they exist to catch is the stock simply not being anywhere
 * afterwards — so counting the shelves alone would pass the bug. Boards and
 * crates, which between them is everywhere a re-flow can put goods.
 */
const census = (g, itemId) => onBoards(g, itemId) + onFloor(g, itemId);
/** How much of one item is standing on one unit. */
const qtyOf = (g, shelf, itemId) => (g.layout.shelves.find((s) => s.id === shelf.id)?.stacks ?? [])
  .reduce((n, k) => n + (k.item_id === itemId ? (k.qty ?? 0) : 0), 0);
/** ...and how much of it is in a lot — a crate, a shoulder, a pair of hands. */
const lotOf = (lot, itemId) => (lot?.stacks ?? [])
  .reduce((n, k) => n + (k.item_id === itemId ? (k.qty ?? 0) : 0), 0);
const onBoards = (g, itemId) => (g.layout.shelves ?? [])
  .flatMap((s) => s.stacks ?? [])
  .reduce((n, k) => n + (k.item_id === itemId ? (k.qty ?? 0) : 0), 0);
const onFloor = (g, itemId) => (g.deliveries ?? [])
  .flatMap((d) => d.stacks ?? [])
  .reduce((n, k) => n + (k.item_id === itemId ? (k.qty ?? 0) : 0), 0);

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
// 6. Who may put what where — ONE rule, and the pour is why.
//
//    This section used to pin an asymmetry: the shop refused both ways and your
//    own hands refused only goods that had NAMED a fixture, so you could stand
//    a loaf in a freezer and `spoilRate` would charge you for it. It read as an
//    inconsistency and was argued for as a freedom.
//
//    A crate is what took the freedom back. `pourInto` empties a mixed lot pile
//    by pile, so under the loose rule a crate of carrots and eggs poured into a
//    freezer put carrots on a cold board — one press, no refusal, and the eggs,
//    which have nowhere else in the shop to be, left in the box. There is no
//    ordering of the piles that fixes it, which is the tell: a sort says which
//    pile goes on first and cannot say "and then stop".
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

  // YOUR HANDS' rule — the same one, which is the claim this section exists to
  // make now. Both directions, because only one of them is a fixture you would
  // think to check: "a chicken may not go on a shelf" was always true, and "a
  // loaf may not go in a freezer" is the half that is new.
  if (real) {
    const inWarmer = g.boardFor(warmer, real);
    check(!inWarmer.ok, 'by hand, ordinary goods are refused a hot counter', inWarmer.error ?? '');
    check(!g.boardFor(freezer, real).ok, 'and refused a freezer');
    check(g.boardFor(shelf, real).ok, 'and taken by the shelving they belong on');
    // The refusal is the other one of `assignShelf`'s pair, and it has to be:
    // "needs a hot counter" tells you what to buy, and this direction has to
    // tell you the unit you are standing at is the wrong one. Naming the
    // fixture the goods want would say "needs a shelf" at somebody holding
    // bread, which is a sentence with no instruction in it.
    check(/doesn't need/i.test(inWarmer.error ?? ''),
      'and it says the unit is wrong rather than naming a fixture', inWarmer.error ?? '');
  }

  // ...and the highlight agrees with the press, in both directions. This is the
  // green-ghost rule said about stocking: `shelfAccepts` lights up where an
  // armful could go, so looser than the server is a promise it breaks and
  // tighter is a shelf that refuses a press it would have taken. They were
  // deliberately different functions with deliberately different answers until
  // the rule went two-way, so this is the assertion that keeps them one.
  if (real) {
    for (const [unit, name] of [[shelf, 'shelf'], [freezer, 'freezer'], [warmer, 'hot counter']]) {
      eq(g.shelfAccepts(unit, real.id), g.boardFor(unit, real).ok,
        `the ${name} highlights for ordinary goods exactly when it takes them`);
    }
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

    const held = census(g, frozen.id);
    g.regenerateLayout();

    const after = g.layout.shelves.find((s) => s.id === id);
    check(after != null, 'the hot counter survived the re-flow');
    const still = (after?.stacks ?? []).some((k) => k.item_id === frozen.id && k.qty > 0);
    check(!still, 'frozen goods do not stay on a hot counter through a re-flow');
    check(!(after?.assigned ?? []).includes(frozen.id),
      'and the reservation nothing could honour is cleared rather than kept');
    // Cleared, not destroyed. `verify-build` makes this claim about every other
    // way goods move; it has to hold here too or a re-flow is a way to lose
    // stock by having built the wrong unit — silently, since a shop that is a
    // few cases poorer looks exactly like a shop that sold them.
    eq(census(g, frozen.id), held, 'and the goods themselves survive it');
    eq(onFloor(g, frozen.id), 6, 'as a crate on the floor, the way a stripped shelf leaves them');
  }
}

// ---------------------------------------------------------------------------
// 7b. The same claim about goods that named NOTHING, which nobody can put there
//     any more — and that is the reason it is still here.
// ---------------------------------------------------------------------------
//
// Case 7 is about goods that named a fixture. This is ordinary shelf goods in a
// freezer, and since the rule went two-way (case 6) there is no press in the
// game that produces it. It is arranged directly, because the state still
// happens and the two ways in are both invisible: content is edited live, so an
// item can be tagged `needs-freezer` while cases of it stand on ordinary
// shelving, and every save in existence predates any rule made today.
//
// It went four steps as a bare `filter` — put a case of coffee in a freezer,
// draw one wall segment, and it was gone. That is a claim about a NUMBER rather
// than about a picture, which is what keeps it worth asserting after the press
// that used to reach it went away: a shop a few cases poorer looks exactly like
// a shop that sold them.
{
  const g = fresh();
  const fz = g.layout.shelves.find((s) => shelfKind(s.kind) === 'freezer');
  // Something that asks for nothing at all — not merely "not frozen", or the
  // item might be one a hot counter wants and this would be case 7 again.
  const plain = content().items.find((it) => requiredFixture(it) == null);

  if (fz && plain) {
    const before = g.layout.shelves.find((s) => s.id === fz.id);
    check(!g.boardFor(before, plain).ok,
      'nothing puts ordinary goods in a freezer by hand any more');
    before.stacks = [{ item_id: plain.id, qty: 4, price: 3, stockedDay: g.day }];

    const held = census(g, plain.id);
    g.regenerateLayout();

    const after = g.layout.shelves.find((s) => s.id === fz.id);
    const still = (after?.stacks ?? []).some((k) => k.item_id === plain.id && k.qty > 0);
    check(!still, 'and the re-flow takes them back off it');
    eq(census(g, plain.id), held, 'without destroying them');
    eq(onFloor(g, plain.id), 4, 'they land on the floor as a crate');
  }
}

// ---------------------------------------------------------------------------
// 7c. THE POUR. One press, a mixed box, and a unit that wants half of it.
// ---------------------------------------------------------------------------
//
// The bug the two-way rule was made for, and the only one in this file you can
// reach with a single ordinary input. A crate of carrots and eggs, emptied into
// a freezer: eggs are `needs-freezer` and carrots are not, so the freezer has to
// take the eggs, refuse the carrots, and hand the carrots back on the shoulder
// — rather than filling a cold board with produce and leaving the eggs in the
// box with nowhere in the shop to be.
//
// Asserted through `stockFromCrate` rather than `boardFor`, because it is the
// LOOP that was wrong and not the judgement: `pourInto` asks each pile on its
// own, so a rule that refuses correctly one pile at a time still fills the unit
// wrongly if the refusals do not happen. And the shoulder is asserted too — a
// pour that quietly ate the carrots would pass every board assertion here.
{
  const g = fresh();
  const fz = g.layout.shelves.find((s) => shelfKind(s.kind) === 'freezer');
  const sh = g.layout.shelves.find((s) => shelfKind(s.kind) === 'shelf');
  const frozen = content().items.find((it) => requiredFixture(it) === 'freezer');
  const plain = content().items.find((it) => requiredFixture(it) == null);

  if (fz && sh && frozen && plain) {
    const p = g.players.me;
    // Deliberately with the ordinary goods FIRST in the box. Under the loose
    // rule this is the order that lost, and the sort that used to paper over it
    // is gone — so a regression here reads as "the carrots went in", which is
    // exactly the report this case came from.
    p.haul = { stacks: [{ item_id: plain.id, qty: 8 }, { item_id: frozen.id, qty: 8 }] };
    Object.assign(p, { x: fz.browseAt.x, z: fz.browseAt.z });

    const poured = g.stockFromCrate('me', fz.id);
    check(poured.ok, 'the freezer takes the pour', poured.error ?? '');
    eq(poured.item_id, frozen.id, 'and what went in is the frozen goods');
    eq(qtyOf(g, fz, frozen.id), 8, 'all of them');
    eq(qtyOf(g, fz, plain.id), 0, 'and none of the ordinary goods');
    eq(lotOf(p.haul, plain.id), 8, 'which are still on your shoulder, not eaten');

    // ...and they go somewhere. A refusal that left you carrying goods no unit
    // in the shop would take is a tighter rule that has broken the game rather
    // than fixed it.
    Object.assign(p, { x: sh.browseAt.x, z: sh.browseAt.z });
    const rest = g.stockFromCrate('me', sh.id);
    check(rest.ok, 'and the shelving next door takes them', rest.error ?? '');
    eq(qtyOf(g, sh, plain.id), 8, 'all of them');
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
