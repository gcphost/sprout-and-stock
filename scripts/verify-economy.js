#!/usr/bin/env node
/**
 * VERIFY: WHAT A FIXTURE COSTS, AND HOW MANY OF THEM THERE ARE.
 *
 * Step 9 of docs/building.md moved the price of a fixture onto its catalog row
 * and retired `world.fixtures`, the stored ledger. Both of those are invisible
 * from a screenshot and nearly invisible from play — you would have to notice
 * that a shelf charged you $45 when its row says $137, or that the palette says
 * eleven when the shop holds ten — so this sweep is the thing that notices.
 *
 * Four failures it exists to catch, each of which reads as something else:
 *
 * - **A price that still comes from an upgrade.** The old `fixtureUnitCost`
 *   scanned the upgrade table for whichever row sold the kind and divided its
 *   cost by how many it granted. Delete half of that and the numbers barely
 *   move, because the shipped rows were priced to agree. So this authors an
 *   upgrade that would have priced shelving at a wildly different number and
 *   insists the shelf price does not budge.
 * - **A count that drifts from the shop.** The ledger's whole failure mode was
 *   being a second opinion: it double-counted a freezer on every restart once,
 *   and it could not say "the player tore one out" before that. A recount can
 *   only be wrong in ways that show up immediately, so this drives a build, a
 *   re-flow, a serialise and a tear-out and re-counts after each.
 * - **Money appearing.** A shop that pays you more to remove a thing than it
 *   charged to place it is a printing press, and the loop is three keystrokes.
 *   Every assertion here is a cash delta against an authored literal.
 * - **A discount that leaks.** A deal on shelving must move the price of
 *   shelving and nothing else, and two deals must not multiply into free.
 *
 * The literals matter. Asserting a charge against `fixtureUnitCost` would pass
 * whatever that function did, which is the one thing being tested — so the test
 * pieces below carry deliberately odd prices that appear nowhere else in the
 * game, and every expected number here is arithmetic on those.
 *
 * Runs on an ephemeral Game, so it never touches the live shop. It does write
 * to the content database — usually the live shared one — so it cleans up on
 * exit, the same way `verify-catalog` does.
 *
 *   node scripts/verify-economy.js
 */

import { Game } from '../server/sim/index.js';
import { content, writeContent } from '../server/content.js';
import { remove } from '../server/db.js';
import { FIXTURE_REFUND, canPlace, canPlaceEdges, fixturesOf, FIXTURES } from '../shared/build.js';
import { E } from '../shared/edges.js';
import { WALKABLE, T } from '../shared/tiles.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const near = (a, b, label) => check(Math.abs(a - b) < 0.005, label, `expected ${b}, got ${a}`);
const round2 = (v) => Math.round(v * 100) / 100;

/** The first indoor cell nothing is standing on, for a prop that needs a home. */
function freeIndoorCell(g) {
  const L = g.layout;
  for (let z = L.store.z; z < L.store.z + L.store.h; z++) {
    for (let x = L.store.x; x < L.store.x + L.store.w; x++) {
      if (L.tiles[z * L.w + x] !== T.FLOOR) continue;
      if (L.blocked?.[z * L.w + x]) continue;
      return { x, z };
    }
  }
  return null;
}

/** The same pinned shop the other build sweeps use. */
const SHOP = { shelf: 6, freezer: 1, checkout: 1, plot: 4 };

/**
 * Prices that exist nowhere else, so a number turning up in a cash delta can
 * only have come from the row it was authored on. 137 in particular is not a
 * multiple or a fraction of any shipped fixture price.
 */
const SHELF_PRICE = 137;
const PLANTER_PRICE = 23;
const PLOT_PRICE = 71;

const TEST_PIECES = [
  {
    id: 'zz-econ-shelf',
    kind: 'shelf',
    name: 'Priced Shelving',
    model: { parts: [{ shape: 'box', color: '#7d6a52', pos: [0, 0.45, 0], scale: [0.8, 0.9, 0.8] }] },
    cost: SHELF_PRICE,
  },
  {
    id: 'zz-econ-plot',
    kind: 'plot',
    name: 'Priced Bed',
    model: { parts: [{ shape: 'box', color: '#4b3a24', pos: [0, 0.04, 0], scale: [0.96, 0.08, 0.96] }] },
    cost: PLOT_PRICE,
  },
  {
    id: 'zz-econ-planter',
    kind: 'prop-floor',
    name: 'Priced Planter',
    model: { parts: [{ shape: 'box', color: '#9c5432', pos: [0, 0.2, 0], scale: [0.5, 0.4, 0.5] }] },
    cost: PLANTER_PRICE,
  },
  // Painted over a bed in section 7 as the CONTROL. It used to be what dropped
  // the placement, and since docs/vats.md step 1 made `plot` `where: 'any'` a
  // bed may stand on floor — so this is now the half that must NOT drop.
  {
    id: 'zz-econ-floor',
    kind: 'floor',
    name: 'Priced Paving',
    cost: 3,
    surface: { color: '#8d8d88', pattern: 'plain' },
    tiers: [{ name: 'Standard', cost: 0 }],
  },
  // ...and this is what does drop it. A PAD is in neither `BUILDABLE_INDOOR`
  // nor `BUILDABLE_OUTDOOR`, so it is the one stroke left that genuinely takes
  // the cell away from a `where: 'any'` fixture — CLAUDE.md's "one press of
  // Muddy Yard over your own hen house", which is the exact shape section 7
  // needs to cause a drop it can price.
  {
    id: 'zz-econ-deck',
    kind: 'paddock',
    name: 'Priced Deck',
    cost: 3,
    surface: { color: '#8d8d88', pattern: 'plain' },
    tiers: [{ name: 'Standard', cost: 0 }],
  },
];

const FLOOR_PIECE = 'zz-econ-floor';
const DECK_PIECE = 'zz-econ-deck';

const TEST_UPGRADES = [
  // The one that would have set the price under the old scheme. `shelves: 100`
  // for $1000 divides out at $10 a shelf, which is cheaper than anything shipped
  // — so under the old scan it would have become THE shelf price. It must now
  // do nothing at all to what a shelf costs.
  {
    id: 'zz-econ-pack',
    name: 'Pallet of Shelving',
    description: 'A hundred shelves. Prices nothing, since step 9.',
    cost: 1000,
    kind: 'shelf',
    payload: { shelves: 100 },
  },
  { id: 'zz-econ-deal-a', name: 'Small Deal', cost: 5, kind: 'shelf', payload: { discount: 0.25 } },
  { id: 'zz-econ-deal-b', name: 'Big Deal', cost: 7, kind: 'shelf', payload: { discount: 0.5 } },
  // Priced past the cap on purpose: a typo in an MCP call must not hand out
  // free shelving, and 0.99 is one keystroke from 0.9.
  { id: 'zz-econ-deal-mad', name: 'Absurd Deal', cost: 9, kind: 'plot', payload: { discount: 0.99 } },
];

// Registered before the first write, not after the last: this runs against
// whatever database it is pointed at, in practice the live shared one, so a
// crash halfway through must not leave "Pallet of Shelving" on somebody's
// upgrades menu until the next person notices.
process.on('exit', () => {
  for (const p of TEST_PIECES) {
    try { remove('fixtures', p.id); } catch { /* the DB is already gone */ }
  }
  for (const u of TEST_UPGRADES) {
    try { remove('upgrades', u.id); } catch { /* the DB is already gone */ }
  }
});

for (const p of TEST_PIECES) {
  const res = writeContent('fixture', p, 'verify');
  check(res.ok, `the catalog accepts ${p.id}`, res.error ?? '');
}
for (const u of TEST_UPGRADES) {
  const res = writeContent('upgrade', u, 'verify');
  check(res.ok, `the catalog accepts ${u.id}`, res.error ?? '');
}

/**
 * A shop of a known shape, owning nothing.
 *
 * `ownedUpgrades` is cleared, and that one is new. It never mattered to a build
 * sweep before, because owning an upgrade could not change what anything cost —
 * since step 9 it can, so a run that inherited `shelf-2` off the live save would
 * quietly measure a discounted shelf against an undiscounted literal. Every
 * other line here resets a piece of world state for the same reason: `Game.create`
 * reads the save, so anything left unreset is somebody else's shop.
 *
 * `ground` is the next one along, and it earned its line the same way: section 7
 * now paves over a bed to drop it, so a save that arrived with any ground
 * already painted would be a different experiment. It also carries the yard
 * pads since they stopped being generated, so `yardStamped` has to come with
 * it — reset one without the other and the shop opens with two loading bays it
 * did not have last run. Ask what a save could leak into your assertions, not
 * just which fields are new.
 */
function fresh() {
  const g = Game.create({ worldId: 'verify-economy', seed: 'econ', ephemeral: true });
  g.placements = [];
  g.grow = { w: 0, h: 0 };
  g.doorShift = 0;
  g.edits = [];
  g.ground = [];
  g.yardStamped = false;
  g.shell = null;
  g.ownedUpgrades = [];
  g.roster = [];
  g.regenerateLayout(null, {}, { want: SHOP });
  g.freezeShell();
  // ...and the yard, so this drives a shop shaped like a real one. `fresh`
  // cleared `yardStamped` above, which is what makes this lay pads rather than
  // inherit whatever the live save had painted.
  g.freezeYard();
  g.cash = 20000;
  g.stats.spent = 0;
  g.addPlayer('me', 'Tester');
  g.players.me.build = { on: true, tool: 'shelf' };
  return g;
}

/**
 * Somewhere a fixture of this kind will actually go, and which way to face it.
 *
 * Through the real validator, warnings and all — a warning is a consequence
 * rather than a refusal, and treating one as "no" here would leave this sweep
 * unable to find anywhere in a shop the player is perfectly entitled to build
 * in. Returns null if there is genuinely nowhere, which every caller checks:
 * "there was nowhere to build" and "building did nothing" must not look alike.
 */
function spotFor(g, kind) {
  const L = g.layout;
  // The whole map, not the shop: a plot goes on bare grass, and a sweep that
  // only looked indoors would report "nowhere to dig" in a field.
  for (let z = 1; z < L.h - 1; z++) {
    for (let x = 1; x < L.w - 1; x++) {
      if (!WALKABLE.has(L.tiles[z * L.w + x])) continue;
      for (const rot of [0, 1, 2, 3]) {
        if (canPlace(L, { kind, x, z, rot }).ok) return { x, z, rot };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. The price is the piece's, and an upgrade payload no longer prices anything.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const at = spotFor(g, 'shelf');
  check(!!at, 'there is somewhere to build a shelf');

  const cashWas = g.cash;
  const spentWas = g.stats.spent;
  const built = g.placeFixture('me', { kind: 'shelf', piece: 'zz-econ-shelf', x: at.x, z: at.z, rot: at.rot });
  check(built.ok, 'a shelf of an authored design can be built', built.error ?? '');
  near(round2(cashWas - g.cash), SHELF_PRICE, 'and it charged exactly what its row says');
  near(round2(g.stats.spent - spentWas), SHELF_PRICE, 'and booked the same amount as spent');

  // The point of the whole step. `zz-econ-pack` would have divided out at $10 a
  // shelf and become the cheapest per-unit price in the game, which is precisely
  // what the deleted scan took the minimum of.
  const pack = content().byId.upgrades['zz-econ-pack'];
  check(!!pack && pack.payload.shelves === 100, 'the pallet upgrade is in the catalog to be ignored');
  const g2 = fresh();
  const at2 = spotFor(g2, 'shelf');
  const cash2 = g2.cash;
  check(g2.placeFixture('me', { kind: 'shelf', piece: 'zz-econ-shelf', x: at2.x, z: at2.z, rot: at2.rot }).ok,
    'and one can still be built with it in the catalog');
  near(round2(cash2 - g2.cash), SHELF_PRICE,
    'an upgrade payload prices nothing — the row does');
}

// ---------------------------------------------------------------------------
// 2. A decoration is priced by its row too, and a prop with no price is free.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const at = spotFor(g, 'prop-floor');
  check(!!at, 'there is somewhere to stand a planter');
  const cashWas = g.cash;
  const put = g.placeFixture('me', { kind: 'prop-floor', piece: 'zz-econ-planter', x: at.x, z: at.z, rot: 0 });
  check(put.ok, 'a decoration can be built', put.error ?? '');
  near(round2(cashWas - g.cash), PLANTER_PRICE, 'and charged its own price');

  // A fixture kind with no catalog row falls back to a floor price rather than
  // to nothing; a prop is only ever its row, so an unpriced one is free. The two
  // halves are opposite on purpose — see `fixtureUnitCost`.
  check(g.fixtureUnitCost('shelf', null, 'no-such-piece') > 0,
    'a shelf whose design is missing still costs something');
}

// ---------------------------------------------------------------------------
// 3. You pay to place and get some of it back to tear out — and nothing else.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const at = spotFor(g, 'shelf');
  const cashWas = g.cash;
  const built = g.placeFixture('me', { kind: 'shelf', piece: 'zz-econ-shelf', x: at.x, z: at.z, rot: at.rot });
  check(built.ok, 'built one to tear out', built.error ?? '');

  const gone = g.removeFixture('me', built.placed);
  check(gone.ok, 'and it can be torn out', gone.error ?? '');
  // Against the authored price rather than against `fixtureUnitCost`, which is
  // the function under test. The fraction itself is a tunable balance constant,
  // so it comes from the shared one — what must never move is *which* price the
  // refund is a fraction of.
  near(round2(cashWas - g.cash), round2(SHELF_PRICE * (1 - FIXTURE_REFUND)),
    'the round trip costs exactly the un-refunded half of the piece price');

  // The loop that would print money if the refund ever exceeded the charge.
  const before = round2(g.cash);
  for (let i = 0; i < 5; i++) {
    const spot = spotFor(g, 'shelf');
    const b = g.placeFixture('me', { kind: 'shelf', piece: 'zz-econ-shelf', x: spot.x, z: spot.z, rot: spot.rot });
    check(b.ok, `build ${i + 1} of the round-trip loop worked`, b.error ?? '');
    check(g.removeFixture('me', b.placed).ok, `tear-out ${i + 1} worked`);
  }
  check(round2(g.cash) < before, 'five build-and-sell round trips lose money rather than make it');
  near(round2(before - g.cash), round2(5 * SHELF_PRICE * (1 - FIXTURE_REFUND)),
    'and lose exactly five times one round trip');
}

// ---------------------------------------------------------------------------
// 4. A deal moves the price of its own kind, by the best of what you own.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const plotWas = g.fixtureUnitCost('plot');

  check(g.buyUpgrade('zz-econ-deal-a').ok, 'a fixture upgrade can be bought again at all');
  near(g.fixtureUnitCost('shelf', null, 'zz-econ-shelf'), round2(SHELF_PRICE * 0.75),
    'and takes its cut off every shelf from then on');
  near(g.fixtureUnitCost('plot'), plotWas, 'while leaving another kind exactly where it was');

  check(g.buyUpgrade('zz-econ-deal-b').ok, 'a second, better deal can be bought');
  near(g.fixtureUnitCost('shelf', null, 'zz-econ-shelf'), round2(SHELF_PRICE * 0.5),
    'the best deal wins — two do not stack into 62.5% off');

  // And the price you are quoted is the price you are charged. Two ways of
  // working one number out is two different amounts of money.
  const at = spotFor(g, 'shelf');
  const quoted = g.buildCosts()['zz-econ-shelf'];
  const cashWas = g.cash;
  check(g.placeFixture('me', { kind: 'shelf', piece: 'zz-econ-shelf', x: at.x, z: at.z, rot: at.rot }).ok,
    'a discounted shelf can be built');
  near(round2(cashWas - g.cash), quoted, 'the palette quoted what the till charged');
  near(quoted, round2(SHELF_PRICE * 0.5), '...and both of them were half price');

  // The cap. 0.4 is the literal complement of `MAX_FIXTURE_DISCOUNT`, spelled
  // out rather than imported: it is a deliberate balance floor, and anyone
  // moving it should have to come here and say they meant to.
  const g3 = fresh();
  check(g3.buyUpgrade('zz-econ-deal-mad').ok, 'an absurdly generous deal can be bought');
  check(g3.fixtureUnitCost('plot') > 0, 'but it cannot make anything free');
  near(g3.fixtureUnitCost('plot'), round2(plotWas * 0.4),
    'it is capped rather than honoured — 99% off is a typo, not a deal');
}

// ---------------------------------------------------------------------------
// 5. A fixture upgrade grants nothing you can stand on.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const before = fixturesOf(g.layout).length;
  const placementsBefore = g.placements.length;
  check(g.buyUpgrade('zz-econ-pack').ok, 'a hundred-shelf pack can be bought');
  eq(fixturesOf(g.layout).length, before,
    'and not one shelf appeared — a deal is a rate, not a delivery');
  eq(g.placements.length, placementsBefore, 'nor did anything land in the placements');
}

// ---------------------------------------------------------------------------
// 6. The count IS the shop. Not a number kept alongside it.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const counts = () => g.fixtureCounts();
  eq(counts().shelf, SHOP.shelf, 'a fresh shop counts the shelves it was furnished with');
  eq(counts().plot, SHOP.plot, '...and the plots');
  eq(counts().freezer, SHOP.freezer, '...and the freezer');

  const at = spotFor(g, 'shelf');
  const built = g.placeFixture('me', { kind: 'shelf', piece: 'zz-econ-shelf', x: at.x, z: at.z, rot: at.rot });
  check(built.ok, 'built a shelf of a second design', built.error ?? '');
  eq(counts()['zz-econ-shelf'], 1, 'which counts under its own name');
  eq(counts().shelf, SHOP.shelf, 'and leaves the original design counting the same');

  // A recount cannot double-count on a restart, which the ledger managed to.
  const restored = Game.restore(g.serialize());
  eq(restored.fixtureCounts()['zz-econ-shelf'], 1, 'the count survives a serialise and restore');
  eq(restored.fixtureCounts().shelf, SHOP.shelf, 'with nothing gained on the way');
  for (let i = 0; i < 3; i++) restored.regenerateLayout();
  eq(restored.fixtureCounts()['zz-econ-shelf'], 1, 'and three re-flows in a row');
  eq(fixturesOf(restored.layout).filter((f) => f.piece === 'zz-econ-shelf').length, 1,
    'and it is genuinely still standing there, not just still being counted');

  check(g.removeFixture('me', built.placed).ok, 'tearing it out works');
  eq(counts()['zz-econ-shelf'], undefined, 'and it stops being counted');
  eq(counts().shelf, SHOP.shelf, 'without taking one of the originals with it');
}

// ---------------------------------------------------------------------------
// 7. Nothing is stranded silently. A dropped placement is paid for.
//
// THREE halves now, and each one used to be the one before it. Roofing a bed
// was this sweep's original way of *causing* a drop — one fixture, nothing else
// in the shop moving, so the refund was exact — and it turned out to be the bug
// rather than the fixture: walls move, so "is this indoors" is not a fact about
// a bed that a re-flow may act on. See `canKeep` in shared/build.js. Paving over
// it took over as the cause.
//
// docs/vats.md step 1 moved it along again. `plot` is `where: 'any'`, so floor
// is now a surface a bed may perfectly well stand on and paving one drops
// nothing — which makes paving the CONTROL and a PAD the cause, since a pad is
// in neither buildable set and is the one stroke left that really does take the
// cell away.
//
// Worth being explicit about what is NOT being tested here, because it reads
// like it is: `canPaintGround` refuses all three of these strokes over a bed
// outright ('there is a bed there — clear it first', `groundIsBusy`), and that
// rule is untouched and still live. Every stroke below is written straight into
// `g.ground` to get round it, exactly as the walls go straight into `edits`.
// The subject is the REFUND, not the brush.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const at = spotFor(g, 'plot');
  check(!!at, 'there is bare grass to dig a bed in');
  const dug = g.placeFixture('me', { kind: 'plot', piece: 'zz-econ-plot', x: at.x, z: at.z, rot: 0 });
  check(dug.ok, 'a bed of an authored design can be dug', dug.error ?? '');
  eq(g.fixtureCounts()['zz-econ-plot'], 1, 'and it is standing there');

  // Re-found every time rather than held: a re-flow builds a new `plots` array
  // of new objects, so a reference taken before one is a bed from the last
  // layout that nothing is looking at. (`findFixture` is no use for *writing*
  // either — `allFixtures` hands out copies with a `ref` back to the original.)
  const bed = () => g.layout.plots.find((pl) => pl.id === dug.placed) ?? null;

  // Sown, so there is something to lose besides the bed itself. Written onto
  // the plot rather than driven through `plant`, which wants a player stood next
  // to it, the right season and the seed money — none of which this is about,
  // and the last of which would land in the cash deltas below.
  const crop = (content().crops ?? [])[0];
  check(!!crop, 'there is a crop to plant');
  Object.assign(bed(), {
    soil: 'tilled', crop_id: crop.id, plantedAt: g.elapsed, ready: false,
  });

  // ---- a: build a shed round it. The wall moves; the bed does not. --------
  //
  // Written straight into `edits` rather than through `buildEdge`, so the wall's
  // own price stays out of the arithmetic.
  g.edits = [
    { o: 'h', x: at.x, z: at.z, k: E.WALL },
    { o: 'h', x: at.x, z: at.z + 1, k: E.WALL },
    { o: 'v', x: at.x, z: at.z, k: E.WALL },
    { o: 'v', x: at.x + 1, z: at.z, k: E.WALL },
  ];

  let cashWas = g.cash;
  g.regenerateLayout();
  check(!!bed(), 'roofing a bed does NOT drop it — a wall is not a bulldozer');
  eq(g.fixtureCounts()['zz-econ-plot'], 1, 'so it is still counted');
  eq(round2(g.cash - cashWas), 0, 'and no money changes hands for a wall drawn nearby');
  eq(bed().crop_id, crop.id, 'and what was growing in it is still growing in it');

  // ...and a second re-flow doesn't lose it either, which is the form the wall
  // bug actually took: the loss landed one action AFTER the wall, because the
  // generator spent the freed budget on a replacement that then evaporated.
  g.regenerateLayout();
  check(!!bed(), 'nor does the re-flow after that one');

  // "Nothing grows indoors" is gone entirely, and this is the guard that it
  // does not come back. It used to hold the clock — `stepCrops` pushed
  // `plantedAt` along by the world delta, so a covered crop froze at whatever
  // it had reached. docs/vats.md step 1 made an indoor bed a thing you
  // deliberately build, and a hold left behind would be the worst shape for it:
  // the press succeeds, the money goes, the rack draws, and it never ripens.
  //
  // Asserted as a STRICT INCREASE rather than as "the bed is not frozen",
  // because a held clock reads as exactly equal and nothing anywhere else would
  // say so — a rack at 40% since Tuesday and one that is quietly stopped are the
  // same still frame, the same bar and the same shop.
  const grown = g.plotGrowth(bed());
  for (let i = 0; i < 20; i++) g.step(1);
  check(g.plotGrowth(bed()) > grown, 'a roofed bed goes on growing',
    `${grown} -> ${g.plotGrowth(bed())}`);
  // ...and all the way to ripe, which is what `stepCrops` is actually for and
  // what a reinstated hold would silently never reach. The walls stay UP for
  // this, and for the two parts below — a bed under a roof is not an edge case
  // any more, it is the feature.
  for (let i = 0; i < 200; i++) g.step(1);
  check(bed().ready, 'and ripens under the roof, exactly as it would under the sky');

  // The cell this section paints, replaced rather than appended: two overlay
  // entries for one square is a state no press can produce, and a sweep that
  // stacked them would be measuring whichever one the layout happened to read.
  const elsewhere = () => g.ground.filter((c) => !(c.x === at.x && c.z === at.z));

  // ---- b: pave over it. THE CONTROL — floor is a surface a bed may stand on.
  //
  // This is the assertion that decides whether `where: 'any'` reached the
  // generator at all. `canPlace` answering yes is only half of it: `canKeep` is
  // asked of every placement on every re-flow, and a bed that could be dug on
  // floor and then shed by the next wall segment of a drag would be the
  // shed-and-refund failure arriving one press late, with the money back so
  // nothing reads as stolen.
  //
  // Straight into `ground` for the same reason the walls above went straight
  // into `edits`, and because `canPaintGround` refuses this in normal play. It
  // keeps whatever the yard was laid with: dropping the pads to paint one cell
  // would measure a shop that also lost its delivery bay.
  cashWas = g.cash;
  g.ground = [...elsewhere(), { x: at.x, z: at.z, k: 'floor', p: FLOOR_PIECE }];
  g.regenerateLayout();
  check(!!bed(), 'paving over a bed does NOT drop it — a bed may stand on floor');
  eq(g.fixtureCounts()['zz-econ-plot'], 1, 'so it is still counted');
  eq(round2(g.cash - cashWas), 0, 'and no money changes hands for a floor under a bed');
  check(bed().ready, 'and what had ripened in it is still ripe');

  // ---- c: paint a PAD over it. THAT is a cell taken away. -----------------
  //
  // A pad is in neither `BUILDABLE_INDOOR` nor `BUILDABLE_OUTDOOR`, so it is the
  // one stroke left that strands a `where: 'any'` fixture — and it is the same
  // physics the old paving case relied on rather than a new rule invented to
  // keep this section alive.
  cashWas = g.cash;
  g.ground = [...elsewhere(), { x: at.x, z: at.z, k: 'paddock', p: DECK_PIECE }];
  g.regenerateLayout();
  check(!bed(), 'painting a pad over a bed drops it — a pad is never buildable');
  eq(g.fixtureCounts()['zz-econ-plot'], undefined, 'so it stops being counted');
  // Under the ledger it went back to the generator, which re-sited it somewhere
  // it still owned a budget for. There is nowhere to put it back now, so the
  // money comes back instead — at full price, because you did not choose to
  // sell it, and quietly destroying something somebody bought is the one answer
  // that is worse than either.
  near(round2(g.cash - cashWas), PLOT_PRICE, 'and its full price is handed back');
  check(g.log.some((l) => /refunded/.test(l.msg ?? '')),
    'and the log says what happened, rather than the bed just being gone');
}

// ---------------------------------------------------------------------------
// 8. Walls are priced per edge, and demolition warns about what it un-roofs.
//
// Both of these are answers to questions docs/building.md left open, so they
// are pinned here rather than left as whatever the code happens to do.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const unit = g.buildCosts().wall;
  check(unit > 0, 'a wall segment costs something');

  // Per edge, not per run: a five-segment drag costs five segments. Drawn well
  // inside the shop so it is a fresh line rather than a swap for existing wall.
  const L = g.layout;
  const z = L.store.z + 2;
  const x0 = L.store.x + 1;
  const cashWas = g.cash;
  const drawn = g.buildEdge('me', { o: 'h', x: x0, z, to: x0 + 4 });
  check(drawn.ok, 'a five-segment run can be drawn', drawn.error ?? '');
  eq(drawn.placed, 5, 'and it laid five segments');
  near(round2(cashWas - g.cash), round2(unit * 5), 'charged per edge, five times over');

  // Demolition. Knocking a hole in the outer wall breaks the enclosure, so the
  // fill walks in and everything indoors is suddenly outdoors — which is the one
  // thing removal can cost you, and it used to warn about nothing at all.
  const g2 = fresh();
  const S = g2.layout.store;
  const hole = { o: 'h', x: S.x + 1, z: S.z };          // a segment of the north wall
  const indoorFixtures = fixturesOf(g2.layout)
    .filter((f) => FIXTURES[f.kind]?.where === 'indoor').length;
  check(indoorFixtures > 0, 'the test shop has fixtures that need a roof');
  const knock = canPlaceEdges(g2.layout, [hole], 0);
  check(knock.ok, 'knocking a wall through is still allowed — it is a move, not a mistake');
  check(!!knock.warn, 'but it says what it will cost you', JSON.stringify(knock));
  check(/outside/.test(knock.warn ?? ''), 'namely that the shop stops being indoors', knock.warn ?? '');

  // ...and a harmless one says nothing, or the warning is noise.
  const quiet = canPlaceEdges(g2.layout, [{ o: 'h', x: S.x + 1, z: S.z + 3 }], E.WALL);
  check(quiet.ok, 'an interior wall is allowed');
  check(!quiet.warn, 'and warns about nothing', quiet.warn ?? '');
}

// ---------------------------------------------------------------------------
// A piece that EARNS, and a piece that is merely nice.
//
// `yields` is the only field on a fixture that prints money, so it gets the
// same treatment every other price here gets: the expected figure is the
// authored number, never the function that pays it out. And `charm` is the
// first thing that has ever moved catchment from inside the shop, so what is
// asserted is the CEILING — an unbounded content field feeding an unbounded
// term is how a room full of pot plants becomes the best strategy in the game.
// ---------------------------------------------------------------------------
{
  const PAY = 13.5;                       // deliberately odd, like every price here
  const CHARM = 3;
  const EARNER = 'zz-econ-earner';
  writeContent('fixture', {
    id: EARNER, kind: 'prop-floor', name: 'Econ Earner', cost: 0, charm: CHARM,
    yields: { cash: PAY, every: 1 },
    model: { parts: [{ shape: 'box', color: '#7fbf6a', pos: [0, 0.2, 0], scale: [0.3, 0.4, 0.3] }] },
    tiers: [{ name: 'Standard', cost: 0 }],
  }, 'verify');

  const g = fresh();
  const bare = g.catchment();
  // A DELTA against the shop's own baseline, and it was `0` until the frontage
  // grew glass. `EDGE_CHARM` pays for glazing wherever it is, and the generated
  // shell glazes the front wall now — so an empty building is not a charmless
  // building, and asserting a literal here would be asserting that the shop
  // front is a concrete box. What this section is about is what a ROW is worth,
  // which is what the difference says and the absolute number never did.
  const shell = g.charm();

  // A cell the generator has not already furnished. Hardcoding one picks a
  // shelf on most seeds, and the placement fails for a reason that has nothing
  // to do with earning.
  const spot = freeIndoorCell(g);
  check(!!spot, 'there is an empty cell indoors to stand it on');
  const put = g.placeFixture('me', { kind: 'prop-floor', piece: EARNER, ...spot, rot: 0 });
  check(put.ok, 'the earner goes down', put.error ?? '');
  eq(round2(g.charm() - shell), CHARM, 'and the shop is exactly as charming as the row says');
  check(g.catchment() > bare, 'which reaches further into the town', `${bare} -> ${g.catchment()}`);

  // The ceiling. Charm is authored content and unbounded; catchment must not be.
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: `charm-${i}`, kind: 'prop-floor', piece: EARNER, x: 1, z: 1, rot: 0, tier: 1, variant: '',
  }));
  g.placements = [...g.placements, ...many];
  check(g.charm() > 100, 'sixty of them is a lot of charm', String(g.charm()));
  check(g.catchment() - bare <= 8.001,
    'but catchment saturates — a warehouse of pot plants is not a destination',
    `+${round2(g.catchment() - bare)}`);
  g.placements = g.placements.filter((p) => !p.id.startsWith('charm-'));

  // It pays what it says, into the pile a till already drops.
  g.cashDrops = [];
  const cashWas = g.cash;
  for (let i = 0; i < 400 && g.cashDrops.length < 1; i++) g.step(0.1);
  eq(g.cashDrops.length, 1, 'it pays out on its own clock');
  eq(g.cashDrops[0].amount, PAY, 'exactly what the row authored');
  eq(g.cash, cashWas, 'and into the floor, not the bank — somebody has to fetch it');

  // Nothing authored to earn must be unable to. The failure this guards is a
  // default that pays: every existing piece in the game has `yields` null.
  const plain = fresh();
  plain.cashDrops = [];
  plain.placeFixture('me', { kind: 'prop-floor', piece: 'terracotta-planter', ...freeIndoorCell(plain), rot: 0 });
  for (let i = 0; i < 400; i++) plain.step(0.1);
  eq(plain.cashDrops.length, 0, 'a planter earns nothing, because nothing authored it to');

  remove('fixtures', EARNER);
}

// ---------------------------------------------------------------------------
// 9. A ladder goes both ways, and walking it in a circle always costs money.
//
// Every rung in the game was one-way until now: a fixture's tier and a hire's
// grade could be climbed and never stepped back off, so a rung bought by
// mistake was undone by selling the whole unit — which loses the stock, the
// reservations and the tile — or, for a person, by letting them go, which
// refunds nothing and loses the person.
//
// Three things here are invisible in play, which is why they are asserted
// rather than looked at:
//
// - **The direction of the money.** Half back of the rung you are stepping OFF,
//   so up-then-down is a loss. Refund the rung you are stepping ON TO and a
//   ladder whose rungs get dearer as they climb is a money press: buy the $260
//   rung, step down, collect half of $90, repeat.
// - **What a smaller fixture cannot hold.** A tier is not only a multiplier —
//   a staged model can grow a *board* as it climbs — so stepping down can take
//   away both capacity and the number of kinds a unit holds. Nothing else in
//   the game has ever made a fixture smaller, so nothing else has ever checked.
// - **That the refusal comes before the money.** The same shape as the bay bug
//   in `buyStock`: a guard that is right, sitting after the charge.
//
// The prices are odd on purpose, like every other figure in this file, and the
// expected numbers are arithmetic on them rather than on `prevTier`.
// ---------------------------------------------------------------------------
{
  const RUNG_2 = 91;                        // dearer rungs on the way up, so a
  const RUNG_3 = 259;                       // refund of the wrong one shows up
  // A staged model is at least two stages by schema — a "stage" is a picture at
  // a point on a 0..1 run, and one of them is not a run. So a piece whose art
  // must NOT change as it climbs still authors a stage per rung; it just draws
  // the same thing each time.
  const board = (y) => ({
    shape: 'box', color: '#7d6a52', pos: [0, y, 0], scale: [0.9, 0.08, 0.8], surface: true,
  });
  // `at` is not optional in practice: `stageIndexAt` takes the LAST stage whose
  // `at` is under the progress, and an absent one reads as 0 — so a ladder of
  // stages with no marks is a fixture permanently drawn as its top rung.
  const LADDER_STAGE = (at) => ({ at, parts: [board(0.3), board(0.7)] });
  const LADDER = 'zz-econ-ladder';
  // Checked, unlike the earlier sections' writes only because those go through
  // the loop at the top that checks them: a rejected row falls back to the
  // *kind's* catalog entry, so every price below would quietly become the
  // shipped shelf's and the failures would read as pricing bugs.
  const ladderWritten = writeContent('fixture', {
    id: LADDER,
    kind: 'shelf',
    name: 'Laddered Shelving',
    cost: SHELF_PRICE,
    // The same two boards at every rung, so a down-step here changes capacity
    // and nothing else. What a *board* going away does is section 9c below, on
    // its own piece — one claim per piece, or a failure cannot say which it was.
    model: { stages: [LADDER_STAGE(0), LADDER_STAGE(0.5), LADDER_STAGE(1)] },
    tiers: [
      { name: 'Plain', cost: 0, capacity_mult: 1 },
      { name: 'Better', cost: RUNG_2, capacity_mult: 2 },
      { name: 'Best', cost: RUNG_3, capacity_mult: 3 },
    ],
  }, 'verify');
  check(ladderWritten.ok, 'the catalog accepts the laddered shelf', ladderWritten.error ?? '');

  const g = fresh();
  const at = spotFor(g, 'shelf');
  const built = g.placeFixture('me', { kind: 'shelf', piece: LADDER, x: at.x, z: at.z, rot: at.rot });
  check(built.ok, 'a laddered shelf can be built', built.error ?? '');

  // Re-found every time, for the reason section 7 gives: an upgrade re-flows
  // the shop and mints a new id, so a reference held across one is a fixture
  // from the layout before it.
  let id = built.placed;
  const unit = () => g.findFixture(id);
  // Written onto the layout row rather than through `stockShelf`, which wants
  // somebody stood next to it with the goods in their hands — none of which
  // this is about. `findFixture` hands out a copy, so writing to `unit()` would
  // write to something thrown away on the next line: the trap `setBackOfHouse`
  // documents, and the reason this reaches for `layout.shelves` by hand.
  const row = () => g.layout.shelves.find((s) => s.id === id) ?? null;
  const put = (shelf, itemId, qty) => {
    shelf.stacks = [
      ...(shelf.stacks ?? []).filter((k) => k.item_id !== itemId),
      { item_id: itemId, qty, price: 3, stockedDay: 0 },
    ];
  };

  eq(g.fixtureTier(unit()), 1, 'it starts on the first rung');
  check(!g.prevTier(unit()), 'and there is nothing under the first rung');
  const bottom = g.downgradeFixture('me', id);
  check(!bottom.ok, 'so stepping down off it is refused', JSON.stringify(bottom));

  let cashWas = g.cash;
  const up1 = g.upgradeFixture('me', id);
  check(up1.ok, 'it can be stepped up', up1.error ?? '');
  id = up1.upgraded;
  const up2 = g.upgradeFixture('me', id);
  check(up2.ok, 'and up again', up2.error ?? '');
  id = up2.upgraded;
  eq(g.fixtureTier(unit()), 3, 'which puts it on the top rung');
  near(round2(cashWas - g.cash), RUNG_2 + RUNG_3, 'having charged both rungs');

  // Something on it, and a price and a label, so the down-step is asked to
  // carry the things a sell-and-rebuild would have lost.
  const item = (content().items ?? []).find((i) => (i.stack ?? 1) >= 4) ?? content().items[0];
  put(row(), item.id, 4);
  eq(g.shelfQty(unit()), 4, 'there are four of something on it');
  const where = { x: unit().x, z: unit().z, rot: unit().rot };

  cashWas = g.cash;
  const down1 = g.downgradeFixture('me', id);
  check(down1.ok, 'it can be stepped back down', down1.error ?? '');
  id = down1.downgraded;
  eq(g.fixtureTier(unit()), 2, 'onto the rung below');
  near(round2(g.cash - cashWas), round2(RUNG_3 * FIXTURE_REFUND),
    'handing back half of the rung it stepped OFF, not half of the one it landed on');
  eq(g.shelfQty(unit()), 4, 'and it kept what was on it');
  eq(unit().x, where.x, 'and its tile');
  eq(unit().z, where.z, '...and the other half of its tile');
  eq(unit().rot, where.rot, '...and which way it faces');

  const down2 = g.downgradeFixture('me', id);
  check(down2.ok, 'and down to the bottom', down2.error ?? '');
  id = down2.downgraded;
  eq(g.fixtureTier(unit()), 1, 'which is where it started');

  // The whole circle. Two rungs up and two rungs down is a pure loss, and it is
  // exactly half of what the two rungs cost — the same shape as the build-and-
  // sell loop in section 3, said about a ladder instead of a fixture.
  const round = g.cash;
  for (let i = 0; i < 3; i++) {
    const u = g.upgradeFixture('me', id);
    check(u.ok, `circuit ${i + 1} climbed`, u.error ?? '');
    id = u.upgraded;
    const d = g.downgradeFixture('me', id);
    check(d.ok, `circuit ${i + 1} came back down`, d.error ?? '');
    id = d.downgraded;
  }
  eq(g.fixtureTier(unit()), 1, 'three circuits later it is back on the first rung');
  near(round2(round - g.cash), round2(3 * RUNG_2 * (1 - FIXTURE_REFUND)),
    'and three circuits cost three un-refunded halves — a ladder is not a press');

  // ---- b: a refusal comes before the money moves. -------------------------
  //
  // Filled to what the rung it is ON holds, which is more than the rung below
  // — the state a shop reaches by stocking a unit it upgraded, and exactly the
  // player who would then press Downgrade.
  {
    const u = g.upgradeFixture('me', id);
    check(u.ok, 'stepped up to fill it', u.error ?? '');
    id = u.upgraded;
    const room = g.shelfCapacity(unit(), item);
    const below = g.shelfCapacity({ ...unit(), tier: 1 }, item);
    check(room > below, 'the rung it is on holds more than the one below', `${room} vs ${below}`);
    put(row(), item.id, room);
    eq(g.shelfQty(unit()), room, 'and it is full to that rung');

    const cash = g.cash;
    const tier = g.fixtureTier(unit());
    const refused = g.downgradeFixture('me', id);
    check(!refused.ok, 'stepping down under a full unit is refused', JSON.stringify(refused));
    check(/take \d+ off/.test(refused.error ?? ''), 'and says how much to take off',
      refused.error ?? '');
    eq(round2(g.cash), round2(cash), 'and nothing was handed back for a refusal');
    eq(g.fixtureTier(unit()), tier, 'and it is still on the rung it was on');
  }

  // ---- c: a rung can be a BOARD, and losing one is the same refusal. ------
  //
  // The shipped freezer draws 2, 2, 3 — `boardsOf` reads the art at the tier, so
  // a down-step can take away how many KINDS a unit holds rather than how much
  // of one. A capacity check alone passes this and the shop quietly ends up with
  // three labelled boards on a two-board unit.
  {
    const BOARDS = 'zz-econ-boards';
    const written = writeContent('fixture', {
      id: BOARDS,
      kind: 'shelf',
      name: 'Growing Shelving',
      cost: SHELF_PRICE,
      model: { stages: [{ at: 0, parts: [board(0.3)] }, { at: 1, parts: [board(0.3), board(0.7)] }] },
      tiers: [{ name: 'One board', cost: 0 }, { name: 'Two boards', cost: RUNG_2 }],
    }, 'verify');
    check(written.ok, 'the catalog accepts the growing shelf', written.error ?? '');

    const h = fresh();
    const spot = spotFor(h, 'shelf');
    const b = h.placeFixture('me', { kind: 'shelf', piece: BOARDS, x: spot.x, z: spot.z, rot: spot.rot });
    check(b.ok, 'a shelf that grows a board can be built', b.error ?? '');
    const up = h.upgradeFixture('me', b.placed);
    check(up.ok, 'and stepped up to two boards', up.error ?? '');
    const two = h.findFixture(up.upgraded);
    eq(h.shelfBoards(two), 2, 'which really is two boards');
    eq(h.shelfBoards({ ...two, tier: 1 }), 1, 'against one on the rung below');

    const shelfRow = h.layout.shelves.find((s) => s.id === up.upgraded);
    const kinds = (content().items ?? []).slice(0, 2);
    check(kinds.length === 2, 'there are two things to put on it');
    shelfRow.stacks = kinds.map((it) => ({ item_id: it.id, qty: 1, price: 3, stockedDay: 0 }));
    eq(shelfRow.stacks.filter((s) => s.qty > 0).length, 2, 'and both of them are on it');

    const cash = h.cash;
    const no = h.downgradeFixture('me', up.upgraded);
    check(!no.ok, 'stepping down to one board with two kinds on it is refused', JSON.stringify(no));
    eq(round2(h.cash), round2(cash), 'and cost nothing to be told so');
    remove('fixtures', BOARDS);
  }

  remove('fixtures', LADDER);
}

// ---------------------------------------------------------------------------
// 10. The same ladder, for a person — where a rung is charged every morning.
//
// A hire's grade is the one rung in the game with an ongoing price: `wage_mult`
// scales what `payWages` takes every day. So the way back down is not an undo,
// it is a standing decision, and the two things worth pinning are that the wage
// actually falls and that half of the grade comes back — `fire` refunds nothing
// and is the only other exit, which is what made a promotion in a good season
// permanent.
// ---------------------------------------------------------------------------
{
  const HAND = 'zz-econ-hand';
  const WAGE = 7;
  const GRADE = 63;
  writeContent('worker', {
    id: HAND,
    name: 'Econ Hand',
    cost: 0,
    wage: WAGE,
    jobs: [{ job: 'shelve', weight: 1 }],
    model: { parts: [{ shape: 'capsule', color: '#7a9e4b', pos: [0, 0.6, 0], scale: [0.4, 0.6, 0.4] }] },
    tiers: [
      { name: 'Hand', cost: 0, wage_mult: 1 },
      { name: 'Senior Hand', cost: GRADE, wage_mult: 2, speed_mult: 1.5 },
    ],
  }, 'verify');

  const g = fresh();
  const hired = g.hire(HAND);
  check(hired.ok, 'somebody can be taken on', hired.error ?? '');
  const who = hired.hired;
  const entry = () => g.roster.find((e) => e.id === who);

  const day = () => { const was = g.cash; g.payWages(); return round2(was - g.cash); };
  near(day(), WAGE, 'a day of them costs the authored wage');

  check(!g.demote(who).ok, 'nobody can be stepped down off the first rung');

  let cashWas = g.cash;
  check(g.promote(who).ok, 'they can be promoted');
  eq(entry().tier, 2, 'onto the second grade');
  near(round2(cashWas - g.cash), GRADE, 'for exactly what that grade costs');
  near(day(), WAGE * 2, 'and they cost twice the wage from then on');

  cashWas = g.cash;
  const down = g.demote(who);
  check(down.ok, 'and they can be stepped back down', down.error ?? '');
  eq(entry().tier, 1, 'to the grade below');
  near(round2(g.cash - cashWas), round2(GRADE * FIXTURE_REFUND),
    'handing back half of the grade — the same rate a fixture sells back at');
  near(day(), WAGE, 'and the wage bill falls with them');
  eq(g.roster.length, 1, 'and they are still standing there — this is not `fire`');

  // The circle, once more. A promotion that could be undone for what it cost
  // would be free to try, and a wage that fell further than it rose would be a
  // shop that got paid to demote everybody.
  const before = g.cash;
  for (let i = 0; i < 3; i++) {
    check(g.promote(who).ok, `circuit ${i + 1} promoted`);
    check(g.demote(who).ok, `circuit ${i + 1} stepped back`);
  }
  eq(entry().tier, 1, 'three circuits later they are on the grade they started on');
  near(round2(before - g.cash), round2(3 * GRADE * (1 - FIXTURE_REFUND)),
    'and it cost three un-refunded halves to find that out');

  remove('workers', HAND);
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\nverify:economy — ${failures.length} of ${checks} assertions FAILED\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\nverify:economy — ${checks} assertions\n`);
console.log('  ✅  a fixture costs what its row says, and the count is the shop.\n');
