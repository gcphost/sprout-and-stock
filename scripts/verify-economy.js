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
  // Only ever painted over a bed in section 7, to take the ground away from
  // underneath it — which is the one thing left that legitimately drops a
  // placement now that a wall moving around one does not.
  {
    id: 'zz-econ-floor',
    kind: 'floor',
    name: 'Priced Paving',
    cost: 3,
    surface: { color: '#8d8d88', pattern: 'plain' },
    tiers: [{ name: 'Standard', cost: 0 }],
  },
];

const FLOOR_PIECE = 'zz-econ-floor';

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
// Two halves, and the first one used to be the second. Roofing a bed was this
// sweep's way of *causing* a drop — it was one fixture and nothing else in the
// shop moved, which made the refund exact — and it turned out to be the bug
// rather than the fixture: walls move, so "is this indoors" is not a fact about
// a bed that a re-flow may act on. See `canKeep` in shared/build.js. So the
// roofed bed is now the regression guard, and the drop is caused by paving over
// it, which is physics that genuinely takes the cell away.
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

  // What "nothing grows indoors" now means: the clock stops rather than the bed
  // being deleted. Held, not reset — take the roof off and it carries on.
  const grown = g.plotGrowth(bed());
  for (let i = 0; i < 200; i++) g.step(1);
  near(g.plotGrowth(bed()), grown, 'a roofed bed stops growing');
  g.edits = [];
  g.regenerateLayout();
  for (let i = 0; i < 200; i++) g.step(1);
  check(g.plotGrowth(bed()) > grown,
    'and starts again where it left off once the roof comes off');

  // ---- b: pave over it. That IS a cell taken away. ------------------------
  //
  // Straight into `ground` for the same reason the walls above went straight
  // into `edits`, and because `canPaintGround` refuses this in normal play —
  // deliberately, since it would do exactly what is asserted below. It keeps
  // whatever the yard was laid with: dropping the pads to pave one cell would
  // measure a shop that also lost its delivery bay.
  cashWas = g.cash;
  g.ground = [...g.ground, { x: at.x, z: at.z, k: 'floor', p: FLOOR_PIECE }];
  g.regenerateLayout();
  check(!bed(), 'paving over a bed drops it — there is no grass left to dig');
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
  eq(g.charm(), 0, 'a shop with nothing nice in it has no charm');

  // A cell the generator has not already furnished. Hardcoding one picks a
  // shelf on most seeds, and the placement fails for a reason that has nothing
  // to do with earning.
  const spot = freeIndoorCell(g);
  check(!!spot, 'there is an empty cell indoors to stand it on');
  const put = g.placeFixture('me', { kind: 'prop-floor', piece: EARNER, ...spot, rot: 0 });
  check(put.ok, 'the earner goes down', put.error ?? '');
  eq(g.charm(), CHARM, 'and the shop is exactly as charming as the row says');
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

if (failures.length) {
  console.error(`\nverify:economy — ${failures.length} of ${checks} assertions FAILED\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\nverify:economy — ${checks} assertions\n`);
console.log('  ✅  a fixture costs what its row says, and the count is the shop.\n');
