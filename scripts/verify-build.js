#!/usr/bin/env node
/**
 * MECHANICS INVARIANTS.
 *
 * `verify-layout.js` proves the generator places what it was asked for.
 * This one drives an actual `Game` through the things a player does — turning
 * soil, clearing their hands, stripping a shelf, building and moving and
 * selling back a fixture — and checks that nothing is created or destroyed
 * along the way.
 *
 * Runs on an ephemeral Game, so it never touches the live shop.
 *
 *   node scripts/verify-build.js
 */

import { Game } from '../server/sim/index.js';
import { content } from '../server/content.js';
import { canPlace } from '../shared/build.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${b}, got ${a}`);
const round2 = (v) => Math.round(v * 100) / 100;

function fresh() {
  const g = Game.create({ seed: 'mech', ephemeral: true });
  g.cash = 5000;
  g.addPlayer('me', 'Tester');
  return g;
}
/** Stand next to something (the bot in simulate.js does the same thing). */
const stand = (g, at) => Object.assign(g.players.me, { x: at.x, z: at.z });
const totalOnFloor = (g, itemId) => g.deliveries
  .filter((d) => !itemId || d.item_id === itemId)
  .reduce((s, d) => s + d.qty, 0);

const c = content();
const anyItem = c.items.find((i) => !c.recipes.some((r) => r.output_id === i.id));
/** A crop that will actually grow in whatever season the world is in. */
const cropFor = (g) => c.crops.find((cr) => !cr.seasons.length || cr.seasons.includes(g.season))
  ?? c.crops[0];

// ---------------------------------------------------------------------------
// 1. Tilling — soil is a real gate, and harvesting exhausts it.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const plot = g.layout.plots[0];
  eq(plot.soil, 'untilled', 'a fresh plot starts untilled');

  stand(g, plot);
  const anyCrop = cropFor(g);
  const early = g.plant('me', plot.id, anyCrop.id);
  check(!early.ok, 'planting into untilled soil is refused');
  eq(g.cash, 5000, 'a refused planting costs nothing');

  check(g.till('me', plot.id).ok, 'tilling works');
  eq(plot.soil, 'tilled', 'tilling turns the soil');
  check(!g.till('me', plot.id).ok, 'tilling twice is refused');

  check(g.plant('me', plot.id, anyCrop.id).ok, 'planting into tilled soil works');
  check(!g.till('me', plot.id).ok, 'you cannot till a planted bed');

  plot.ready = true;
  g.players.me.carry = null;
  check(g.harvest('me', plot.id).ok, 'harvesting works');
  eq(plot.soil, 'untilled', 'harvesting exhausts the bed back to untilled');

  // And the held-action list has to agree, or the ring never appears.
  g.players.me.carry = null;
  const action = g.actionFor(g.players.me);
  eq(action?.kind, 'till', 'standing at a rough plot offers tilling');
  check((action?.time ?? 1) > 1, 'tilling takes longer than a flat second');
}

// ---------------------------------------------------------------------------
// 2. Clearing your hands — nothing is ever destroyed.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  g.players.me.carry = { item_id: anyItem.id, qty: 4 };

  const away = g.stow('me');
  check(!away.ok, 'you cannot put things down away from the bay');

  stand(g, g.layout.bay);
  check(g.stow('me').ok, 'stowing at the bay works');
  check(!g.players.me.carry, 'stowing empties your hands');
  eq(totalOnFloor(g, anyItem.id), 4, 'every unit survives as a crate');

  // Two loads of the same thing become one crate, not a forest of them.
  g.players.me.carry = { item_id: anyItem.id, qty: 3 };
  g.stow('me');
  eq(g.deliveries.length, 1, 'stowing the same item twice merges the crate');
  eq(totalOnFloor(g, anyItem.id), 7, 'and keeps the total');

  // ...and it can be picked straight back up.
  const back = g.unload('me', g.deliveries[0].id);
  check(back.ok, 'a stowed crate can be picked back up');
  check(g.players.me.carry?.qty > 0, 'picking it back up fills your hands');

  // The proximity list must offer it, or none of the above is reachable.
  g.players.me.carry = { item_id: anyItem.id, qty: 2 };
  g.deliveries = [];
  g.players.me.stowLock = false;
  eq(g.actionFor(g.players.me)?.kind, 'stow', 'standing at the bay with full hands offers stow');

  // Putting something down next to a crate of the same thing must not pick it
  // straight back up — both actions re-arm instantly, so that loops forever.
  g.players.me.carry = { item_id: anyItem.id, qty: 2 };
  g.dropGoods(anyItem.id, 5, g.layout.bay);
  check(g.stow('me').ok, 'stowing beside a matching crate works');
  eq(g.actionFor(g.players.me), null, 'and does not immediately offer to unload it again');
  g.setInput('me', 1, 0);
  g.stepPlayers(0.1);
  eq(g.actionFor(g.players.me)?.kind, 'unload', 'walking clears the lock, so pickup works again');
}

// ---------------------------------------------------------------------------
// 3. Clearing a fixture — stock lands on the floor rather than vanishing.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const shelf = g.layout.shelves.find((s) => s.kind !== 'freezer');
  shelf.item_id = anyItem.id;
  shelf.qty = 9;
  shelf.price = 3;
  stand(g, shelf.browseAt);

  check(g.stripShelf('me', shelf.id).ok, 'stripping a shelf works');
  eq(shelf.qty, 0, 'the shelf ends up empty');
  eq(shelf.item_id, null, 'and unlabelled, so anything can go on it next');
  eq(totalOnFloor(g, anyItem.id), 9, 'all nine units are on the floor beside it');

  // An unlabelled shelf must accept anything again — that's the whole point.
  g.players.me.carry = { item_id: anyItem.id, qty: 2 };
  check(g.stockShelf('me', shelf.id).ok, 'a stripped shelf takes new stock');

  // Emptying an appliance.
  const g2 = fresh();
  g2.ownedUpgrades = c.upgrades.filter((u) => u.kind === 'station').map((u) => u.id);
  g2.regenerateLayout();
  const st = g2.layout.stations[0];
  if (st) {
    st.contents = { [anyItem.id]: 5 };
    stand(g2, st.useAt);
    check(g2.dumpStation('me', st.id).ok, 'dumping a hopper works');
    eq(Object.keys(st.contents).length, 0, 'the hopper ends up empty');
    eq(totalOnFloor(g2, anyItem.id), 5, 'the ingredients survive as a crate');
    check(!g2.dumpStation('me', st.id).ok, 'dumping an empty hopper is refused');
  } else {
    check(false, 'no appliance to test dumping with');
  }
}

// ---------------------------------------------------------------------------
// 4. Building, moving and selling back.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  g.setBuildMode('me', true, 'shelf');
  const before = g.layout.shelves.length;
  const cash0 = g.cash;
  const unit = g.fixtureUnitCost('shelf');
  check(unit > 0, 'a shelf has a price derived from the upgrades that sell it');

  // Find somewhere legal by asking the same validator the client asks.
  const spot = findFreeFloor(g);
  check(!!spot, 'there is somewhere to build');

  const placed = g.placeFixture('me', { kind: 'shelf', x: spot.x, z: spot.z, rot: spot.rot });
  check(placed.ok, 'placing a shelf works', placed.error);
  eq(g.layout.shelves.length, before + 1, 'the shop has one more shelf');
  eq(round2(cash0 - g.cash), unit, 'and it cost exactly the palette price');
  const mine = g.layout.shelves.find((s) => s.id === placed.placed);
  check(!!mine, 'the placed shelf is in the layout');
  check(mine && mine.x === spot.x && mine.z === spot.z, 'it landed on the tile asked for');

  // Stock it, then move it — the stock has to come along.
  mine.item_id = anyItem.id;
  mine.qty = 7;
  stand(g, mine);
  check(g.liftFixture('me', mine.id).ok, 'lifting a fixture works');
  eq(g.layout.shelves.length, before + 1, 'lifting does not remove it from the world');

  const dest = findFreeFloor(g, mine.id);
  const cashBeforeMove = g.cash;
  const moved = g.dropFixture('me', { kind: 'shelf', x: dest.x, z: dest.z, rot: dest.rot });
  check(moved.ok, 'setting it down elsewhere works', moved.error);
  eq(g.cash, cashBeforeMove, 'moving a fixture is free');
  eq(g.layout.shelves.length, before + 1, 'and does not change the shelf count');
  const after = g.layout.shelves.find((s) => s.id === moved.moved);
  check(!!after, 'the moved shelf exists');
  eq(after?.qty, 7, 'its stock came with it');
  eq(after?.item_id, anyItem.id, 'including what it was labelled as');
  check(after && after.x === dest.x && after.z === dest.z, 'it landed where it was put');

  // Selling it back: has to be emptied first, and refunds half.
  stand(g, after);
  const tooFull = g.removeFixture('me', after.id);
  check(!tooFull.ok, 'a stocked fixture cannot be removed');
  check(g.emptyFixture('me', after.id).ok, 'emptying it first works');
  eq(totalOnFloor(g, anyItem.id), 7, 'its stock is on the floor, not gone');

  const cashBeforeSell = g.cash;
  const gone = g.removeFixture('me', after.id);
  check(gone.ok, 'removing an empty fixture works', gone.error);
  eq(g.layout.shelves.length, before, 'the shop is back to where it started');
  eq(round2(g.cash - cashBeforeSell), round2(unit / 2), 'and refunded half the price');

  // You must never be able to remove your last till. The shop this test boots
  // from is the live save, so tear down to one rather than assuming there is.
  const g3 = fresh();
  g3.setBuildMode('me', true);
  while (g3.layout.checkouts.length > 1) {
    const spare = g3.layout.checkouts[g3.layout.checkouts.length - 1];
    check(g3.removeFixture('me', spare.id).ok, 'a spare till can be removed');
  }
  eq(g3.layout.checkouts.length, 1, 'down to one till');
  check(!g3.removeFixture('me', g3.layout.checkouts[0].id).ok, 'the last till cannot be removed');
}

// ---------------------------------------------------------------------------
// 5. Build mode is the safety catch — and the only way in.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const shelf = g.layout.shelves.find((s) => s.kind !== 'freezer');
  shelf.item_id = anyItem.id;
  shelf.qty = 5;
  stand(g, shelf.browseAt);

  g.players.me.carry = { item_id: anyItem.id, qty: 2 };
  eq(g.actionFor(g.players.me)?.kind, 'stock', 'outside build mode a shelf gets stocked');

  // Outside build mode, none of the destructive verbs answer at all — no menu
  // can be open, so nothing should reach them.
  check(!g.liftFixture('me', shelf.id).ok, 'you cannot lift a fixture outside build mode');
  check(!g.emptyFixture('me', shelf.id).ok, 'you cannot empty one outside build mode');
  check(!g.removeFixture('me', shelf.id).ok, 'you cannot remove one outside build mode');
  check(!g.rotateFixture('me', shelf.id).ok, 'you cannot turn one outside build mode');
  eq(shelf.qty, 5, 'and the shelf is untouched by any of it');

  // Inside build mode, standing next to something arms nothing. Proximity used
  // to pick a target here, and in a dense aisle it picked the wrong one.
  g.setBuildMode('me', true);
  eq(g.actionFor(g.players.me), null, 'build mode arms no proximity action at all');
  g.setHold('me', true);
  for (let i = 0; i < 60; i++) g.stepActions(0.1);
  eq(shelf.qty, 5, 'and holding the button next to a shelf does nothing to it');
  eq(g.players.me.holding ?? null, null, 'nor picks anything up');

  g.setBuildMode('me', false);
  eq(g.actionFor(g.players.me)?.kind, 'stock', 'leaving build mode restores the normal job');
}

// ---------------------------------------------------------------------------
// 8. Aiming. The whole point: you get the fixture you pointed at, not the
//    nearest one. Two shelves side by side, stand closer to the first, ask for
//    the second — and get the second.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  g.setBuildMode('me', true);

  const spotA = findFreeFloor(g);
  const near = g.placeFixture('me', { kind: 'shelf', ...spotA });
  // Asked for *after* the first one is standing there, so the two really are
  // legal together — that's the case where "the nearest fixture" gives up.
  const spotB = findFreeNeighbour(g, spotA);
  check(!!spotB, 'there is room for a second shelf right beside the first');
  const far = g.placeFixture('me', { kind: 'shelf', ...spotB });
  check(near.ok && far.ok, 'both shelves went down', near.error ?? far.error);

  const a = g.layout.shelves.find((s) => s.id === near.placed);
  const b = g.layout.shelves.find((s) => s.id === far.placed);
  // Stand right on top of the first one, so "nearest" is unambiguous.
  stand(g, a);
  const dA = Math.hypot(g.players.me.x - a.x, g.players.me.z - a.z);
  const dB = Math.hypot(g.players.me.x - b.x, g.players.me.z - b.z);
  check(dA < dB, 'the first shelf really is the nearer of the two');

  // The tile is the whole disambiguation: one tile, one fixture.
  eq(g.fixtureAt(b.x, b.z)?.id, b.id, 'the far shelf is what is on the far tile');
  eq(g.fixtureAt(a.x, a.z)?.id, a.id, 'and the near shelf is what is on the near tile');

  b.item_id = anyItem.id;
  b.qty = 3;
  const lifted = g.liftFixture('me', b.id);
  check(lifted.ok, 'lifting the far one by id works', lifted.error);
  eq(g.players.me.holding?.id, b.id, 'and you are holding the far one, not the near one');
  eq(a.qty, 0, 'the near shelf was never touched');

  // Distance is not a gate any more. You aimed at it; placing never required
  // you to walk over there either.
  g.players.me.x = 1;
  g.players.me.z = 1;
  const dest = findFreeFloor(g, b.id);
  check(!!dest, 'there is somewhere else to put it');
  const away = g.dropFixture('me', dest);
  check(away.ok, 'you can set it down from across the shop', away.error);
  const moved = g.layout.shelves.find((s) => s.id === away.moved);
  eq(moved?.qty, 3, 'and its stock came with it');
  eq(g.fixtureAt(a.x, a.z)?.id, a.id, 'the shelf you did not pick is still where it was');
}

// ---------------------------------------------------------------------------
// 9. Turning something on the spot. Same tile, same stock, new facing.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  g.setBuildMode('me', true);
  const shelf = g.layout.shelves.find((s) => s.kind !== 'freezer');
  shelf.item_id = anyItem.id;
  shelf.qty = 6;
  const { x, z } = shelf;
  const rot0 = shelf.rot;
  const oldId = shelf.id;
  const browse0 = { ...shelf.browseAt };
  const stockBefore = g.layout.shelves.reduce((s, o) => s + (o.qty ?? 0), 0);

  const turned = g.rotateFixture('me', shelf.id, 1);
  check(turned.ok, 'turning a shelf works', turned.error);

  const now = g.fixtureAt(x, z);
  check(!!now, 'it is still on the same tile');
  check(now.rot !== rot0, 'and it is facing somewhere else');
  eq(now.qty, 6, 'its stock stayed on it');
  eq(now.item_id, anyItem.id, 'and so did its label');
  check(now.browseAt.x !== browse0.x || now.browseAt.z !== browse0.z,
    'shoppers now browse it from a different side');
  // `layout.shelves` holds freezers too, so count against both ledgers.
  eq(g.layout.shelves.length, g.fixtures.shelf + g.fixtures.freezer,
    'turning did not create or destroy a shelf');
  eq(g.layout.shelves.reduce((s, o) => s + (o.qty ?? 0), 0), stockBefore,
    'and no stock migrated to another shelf on the way');

  // The id it had is now free, and the generator hands out `shelf-pN` by
  // position — so after a re-flow that name can belong to a different shelf
  // entirely. Anything holding onto an id across a re-flow (the fixture menu
  // did) has to key off the tile instead.
  const recycled = g.findFixture(oldId);
  check(!recycled || recycled.id !== now.id,
    'the old procedural id no longer means the fixture we turned');

  // A plot has no front, so there is nothing to turn.
  check(!g.rotateFixture('me', g.layout.plots[0].id).ok, 'a plot does not face anywhere');
}

// ---------------------------------------------------------------------------
// 6. The ledger survives a save/restore round trip.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  g.setBuildMode('me', true, 'plot');
  const before = { ...g.fixtures };
  const spot = findFreeGrass(g);
  check(!!spot, 'there is somewhere to dig a plot');
  const res = g.placeFixture('me', { kind: 'plot', x: spot.x, z: spot.z, rot: 0 });
  check(res.ok, 'digging a new plot works', res.error);
  eq(g.fixtures.plot, before.plot + 1, 'the ledger counts the new plot');
  eq(g.layout.plots.length, g.fixtures.plot, 'and the layout matches the ledger');

  const restored = Game.restore(g.serialize());
  eq(restored.fixtures.plot, g.fixtures.plot, 'the ledger survives serialisation');
  eq(restored.placements.length, g.placements.length, 'so do the placements');
  restored.regenerateLayout();
  eq(restored.layout.plots.length, g.fixtures.plot, 'and regenerate still honours them');
}

// ---------------------------------------------------------------------------
// 7. Hold to act. Standing next to something arms it; only the button fires it.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const plot = g.layout.plots[0];
  stand(g, plot);

  const armed = g.actionFor(g.players.me);
  eq(armed?.kind, 'till', 'standing at a rough plot arms tilling');
  check(!!armed?.at, 'an armed action says where its target is');
  check(armed.at.x === plot.x && armed.at.z === plot.z, 'and points at the right tile');

  // Not holding: the action stays armed forever and never fires.
  for (let i = 0; i < 60; i++) g.stepActions(0.1);
  eq(plot.soil, 'untilled', 'proximity alone never fires the action');
  eq(g.players.me.action?.kind, 'till', 'but it stays armed so the UI can show it');
  eq(g.players.me.action?.elapsed, 0, 'with no progress on the clock');

  // Holding: it charges, and only fires once the full time has elapsed.
  g.setHold('me', true);
  g.stepActions(0.5);
  eq(plot.soil, 'untilled', 'half way through, nothing has happened yet');
  check(g.players.me.action.elapsed > 0, 'but the charge is running');

  // Letting go throws the charge away rather than banking it.
  g.setHold('me', false);
  eq(g.players.me.action.elapsed, 0, 'releasing discards the progress');
  g.stepActions(0.5);
  eq(plot.soil, 'untilled', 'and two half-holds do not add up to one action');

  g.setHold('me', true);
  for (let i = 0; i < 30; i++) g.stepActions(0.1);
  eq(plot.soil, 'tilled', 'holding it through fires the action');

  // Walking out of range drops it entirely. Corner of the map, because the
  // farm is laid out in rows and "twelve tiles east" lands on another plot.
  g.setHold('me', false);
  g.players.me.x = 1;
  g.players.me.z = 1;
  g.stepActions(0.1);
  eq(g.players.me.action, null, 'walking away disarms it');
}

// ---------------------------------------------------------------------------

function findFreeFloor(g, ignoreId = null) {
  const L = g.layout;
  for (let z = L.store.z + 1; z < L.store.z + L.store.h - 1; z++) {
    for (let x = L.store.x + 1; x < L.store.x + L.store.w - 1; x++) {
      for (const rot of [0, 1, 2, 3]) {
        const spec = { kind: 'shelf', x, z, rot };
        if (canPlaceHere(g, spec, ignoreId)) return { x, z, rot };
      }
    }
  }
  return null;
}

/** A legal shelf tile orthogonally touching `at` — its neighbour in the aisle. */
function findFreeNeighbour(g, at) {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const rot of [0, 1, 2, 3]) {
      const spec = { kind: 'shelf', x: at.x + dx, z: at.z + dz, rot };
      if (canPlaceHere(g, spec)) return { x: spec.x, z: spec.z, rot };
    }
  }
  return null;
}

function findFreeGrass(g) {
  const L = g.layout;
  for (let z = L.door.z + 4; z < L.h - 2; z++) {
    for (let x = 2; x < L.w - 2; x++) {
      if (canPlaceHere(g, { kind: 'plot', x, z, rot: 0 })) return { x, z };
    }
  }
  return null;
}

function canPlaceHere(g, spec, ignoreId = null) {
  // Deliberately the same entry point the client and the server both use.
  return canPlace(g.layout, spec, { ignoreId }).ok;
}

console.log(`\n${checks} assertions\n`);
if (!failures.length) {
  console.log('  ✅  tilling, clearing, building, moving and selling back all hold.\n');
  process.exit(0);
}
console.log(`  ❌  ${failures.length} failures:\n`);
for (const f of failures) console.log(`      ${f}`);
console.log();
process.exit(1);
