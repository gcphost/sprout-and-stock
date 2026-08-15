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
import { canPlace, canPlaceCleanly } from '../shared/build.js';
import {
  partsAt, stageIndexAt, isStaged, modelHeight, tierProgress,
} from '../shared/model.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${b}, got ${a}`);
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * A fixed shop, not just a fixed seed.
 *
 * `Game.create` reads the saved world, so an ephemeral game still arrives
 * furnished with however many fixtures the live save owns and wherever the
 * player has hand-placed them. That makes this suite go red for the shape of
 * somebody's aisles rather than for a bug — section 8 needs two shelves side by
 * side, and a shop already packed by hand has nowhere to put the second. So the
 * hand-placements go and the ledger is pinned before anything is asserted.
 */
const SHOP = { shelf: 6, freezer: 1, checkout: 1, plot: 4 };

function fresh() {
  const g = Game.create({ seed: 'mech', ephemeral: true });
  g.placements = [];
  g.fixtures = { ...SHOP };
  g.grow = { w: 0, h: 0 };
  g.doorShift = 0;
  g.regenerateLayout();
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
  const cashBefore = g.cash;
  const picked = g.harvest('me', plot.id);
  check(picked.ok, 'harvesting works');

  // Picking puts the same crop straight back in rather than exhausting the bed.
  eq(picked.replanted, anyCrop.id, 'harvesting re-sows the crop it just picked');
  eq(plot.crop_id, anyCrop.id, 'the plot is planted again');
  eq(plot.soil, 'tilled', 'and the bed it was picked from stays turned');
  check(!plot.ready, 'the replanted crop starts from nothing');
  eq(round2(cashBefore - g.cash), round2(anyCrop.seed_cost), 'the replant seed is paid for');

  // The replant must not re-arm: a plot holding an unripe crop offers nothing,
  // which is what stops a held finger from cycling the bed.
  g.players.me.carry = null;
  eq(g.actionFor(g.players.me), null, 'a just-replanted plot arms no further action');
}

// ---------------------------------------------------------------------------
// 1c. The seed that goes back in is the one you have selected.
//
// Replanting the harvested crop regardless charges for a seed the player was
// about to replace, so every switch costs two. That is invisible in a single
// playthrough and was worth about a third of all profit over 60 simulated days.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const plot = g.layout.plots[0];
  const grown = cropFor(g);
  // A different crop that will also grow right now, or there is nothing to test.
  const other = c.crops.find((cr) => cr.id !== grown.id
    && (!cr.seasons.length || cr.seasons.includes(g.season)));

  stand(g, plot);
  g.till('me', plot.id);
  g.plant('me', plot.id, grown.id);
  plot.ready = true;
  g.players.me.carry = null;

  if (other) {
    g.players.me.selectedCrop = other.id;
    const cashBefore = g.cash;
    const picked = g.harvest('me', plot.id);

    eq(picked.item_id, grown.item_id, 'you still pick what was actually growing');
    eq(picked.replanted, other.id, 'but the bed takes the seed you have selected');
    eq(plot.crop_id, other.id, 'and that is what is now growing there');
    eq(round2(cashBefore - g.cash), round2(other.seed_cost),
      'charged once, for the selected seed — never for both');
  }

  // No seed selected falls back to what was picked, which is the common case:
  // staff and anything driven headlessly never set one.
  const g2 = fresh();
  const plot2 = g2.layout.plots[0];
  const crop2 = cropFor(g2);
  stand(g2, plot2);
  g2.till('me', plot2.id);
  g2.plant('me', plot2.id, crop2.id);
  plot2.ready = true;
  g2.players.me.carry = null;
  g2.players.me.selectedCrop = null;
  eq(g2.harvest('me', plot2.id).replanted, crop2.id,
    'with no seed selected, the crop just picked goes back in');
}

// ---------------------------------------------------------------------------
// 1a2. The bed knows its yield the moment it is sown.
//
// The renderer draws one plant per unit, so the number has to exist while the
// crop grows and still be the number harvesting hands over. Rolling it at
// harvest instead means the bed cannot show what is in it.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const crop = cropFor(g);

  for (const plot of g.layout.plots) {
    stand(g, plot);
    g.till('me', plot.id);
    check(g.plant('me', plot.id, crop.id).ok, `sowing ${plot.id} works`);
    check(plot.yield >= crop.yield_min && plot.yield <= crop.yield_max,
      `${plot.id} rolled a yield inside the crop's range`,
      `got ${plot.yield}, want ${crop.yield_min}..${crop.yield_max}`);
  }

  // It has to reach the client, or the renderer has nothing to count.
  const snap = g.snapshot();
  const shown = snap.plots.find((p) => p.crop_id === crop.id);
  eq(shown.yield, g.layout.plots.find((p) => p.id === shown.id).yield,
    'the snapshot carries the yield the bed is holding');

  // And picking hands over exactly what was on show — carry capacity allowing.
  const plot = g.layout.plots[0];
  const promised = plot.yield;
  plot.ready = true;
  stand(g, plot);
  g.players.me.carry = null;
  g.players.me.selectedCrop = null;
  const picked = g.harvest('me', plot.id);
  eq(picked.qty + picked.dropped, promised,
    'you get exactly what the bed was showing, no more and no less');
  check(plot.yield >= crop.yield_min && plot.yield <= crop.yield_max,
    'and the auto-replant rolls the next bed its own yield');

  // A bed with nothing in it must not claim a harvest.
  const bare = g.layout.plots[1];
  stand(g, bare);
  g.emptyFixture?.('me', bare.id);
  g.clearPlot(bare);
  eq(bare.yield, 0, 'clearing a plot takes its yield with it');
}

// ---------------------------------------------------------------------------
// 1b. ...and when it can't re-sow, the old exhaust rule still stands.
// ---------------------------------------------------------------------------
{
  // Too poor for another seed.
  const g = fresh();
  const plot = g.layout.plots[0];
  const crop = cropFor(g);
  stand(g, plot);
  g.till('me', plot.id);
  g.plant('me', plot.id, crop.id);
  plot.ready = true;
  g.players.me.carry = null;
  g.cash = crop.seed_cost / 2;

  const broke = g.harvest('me', plot.id);
  check(broke.ok, 'you can still pick a crop with no money for the next seed');
  eq(broke.replanted, null, 'but nothing is re-sown');
  eq(plot.crop_id, null, 'the bed is left empty');
  eq(plot.soil, 'untilled', 'and exhausted back to untilled');
  check(!!broke.why, 'and it says why, rather than the field just going quiet');
  check(g.cash >= 0, 'a failed replant never overdraws you');

  // The held-action list has to agree, or the ring never appears.
  const action = g.actionFor(g.players.me);
  eq(action?.kind, 'till', 'standing at the exhausted plot offers tilling');
  check((action?.time ?? 1) > 1, 'tilling takes longer than a flat second');
}

{
  // Out of season — a crop that can't grow now must not be forced back in.
  const g = fresh();
  const seasonal = c.crops.find((cr) => cr.seasons.length);
  if (seasonal) {
    const plot = g.layout.plots[0];
    stand(g, plot);
    g.season = seasonal.seasons[0];
    g.till('me', plot.id);
    check(g.plant('me', plot.id, seasonal.id).ok, 'planting in season works');
    plot.ready = true;
    g.players.me.carry = null;
    // Roll on to a season this crop does not grow in.
    g.season = ['spring', 'summer', 'autumn', 'winter'].find((s) => !seasonal.seasons.includes(s));

    const out = g.harvest('me', plot.id);
    check(out.ok, 'harvesting still works out of season');
    eq(out.replanted, null, 'an out-of-season crop is not re-sown');
    eq(plot.crop_id, null, 'the bed is left empty instead');
    check(!g.replantable(seasonal).ok, 'and replantable() agrees it could not grow');
  }
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
  // Specifically *unload*, not "nothing at all". This boots from the live save,
  // so whatever the shop currently has near its bay can legitimately arm
  // something else, and asserting silence made this fail whenever the other
  // half of the co-op happened to build near the loading pad.
  check(g.actionFor(g.players.me)?.kind !== 'unload',
    'and does not immediately offer to unload it again');
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
// 10. Staged models. One resolver, whatever the 0..1 means to the caller.
// ---------------------------------------------------------------------------
{
  const flat = { parts: [{ color: '#fff' }] };
  const staged = {
    stages: [
      { name: 'a', at: 0, parts: [{ color: '#100000' }] },
      { name: 'b', at: 0.5, parts: [{ color: '#200000' }] },
      { name: 'c', at: 0.9, parts: [{ color: '#300000' }] },
    ],
  };

  check(!isStaged(flat), 'a plain model is not staged');
  check(isStaged(staged), 'a staged one is');
  eq(partsAt(flat, 0)[0].color, '#fff', 'an unstaged model looks the same at 0');
  eq(partsAt(flat, 1)[0].color, '#fff', '...and at 1');

  eq(stageIndexAt(staged, 0), 0, 'brand new is the first stage');
  eq(stageIndexAt(staged, 0.49), 0, 'just short of the threshold is still the first');
  eq(stageIndexAt(staged, 0.5), 1, 'reaching it moves you up');
  eq(stageIndexAt(staged, 1), 2, 'all the way along is the last stage');
  eq(stageIndexAt(staged, 5), 2, 'and past the end is clamped, not undefined');
  eq(stageIndexAt(staged, -3), 0, 'as is before the start');
  eq(partsAt(staged, 0.6)[0].color, '#200000', 'the parts follow the stage');
  eq(partsAt(null, 1).length, 0, 'a missing model draws nothing rather than throwing');

  // Aiming reads the drawn height off the art, so this has to measure the top
  // of the tallest part, not the tallest part's position.
  eq(modelHeight([{ pos: [0, 0.3, 0], scale: [1, 0.4, 1] }]), 0.5, 'height is the top face, not the centre');
  eq(modelHeight([]), 0, 'nothing is zero tall');

  // A tier ladder maps onto the same 0..1 line.
  eq(tierProgress(1, 3), 0, 'tier 1 of 3 is the start of the run');
  eq(tierProgress(3, 3), 1, 'the top tier is the end of it');
  eq(tierProgress(1, 1), 0, 'a single-rung ladder is always the start');
}

// ---------------------------------------------------------------------------
// 10b. ...and the art that is actually in the database.
//
// A correct resolver is no help if what someone authored can never be seen.
// These sweep real content rather than a fixture, so they are the assertions
// that catch an authoring mistake rather than a coding one.
// ---------------------------------------------------------------------------
{
  const KINDS = [['crop', c.crops], ['fixture', c.fixtures], ['item', c.items]];

  for (const [kind, rows] of KINDS) {
    for (const row of rows ?? []) {
      if (!isStaged(row.model)) continue;
      row.model.stages.forEach((stage, i) => {
        // Two stages sharing an `at` validate fine — the schema only asks for
        // non-decreasing — but the resolver takes the LAST one that qualifies,
        // so the earlier is dead art nobody will ever see.
        eq(stageIndexAt(row.model, stage.at ?? 0), i,
          `${kind} ${row.id} stage ${i} ("${stage.name}") can actually be reached`);
        check(partsAt(row.model, stage.at ?? 0).length > 0,
          `${kind} ${row.id} stage ${i} ("${stage.name}") draws something`);
      });
    }
  }

  // A crop whose last stage looks like the one before it has no harvest cue.
  // `ready` flips exactly when growth hits 1, so if the art doesn't change
  // there, the only way to find a ripe plot is to walk up to every one of
  // them. Underground crops are what get this wrong: the leaves stop changing
  // long before the root is worth pulling.
  for (const crop of c.crops) {
    if (!isStaged(crop.model)) continue;
    const stages = crop.model.stages;
    const lastAt = stages[stages.length - 1].at ?? 1;
    const before = partsAt(crop.model, Math.max(0, lastAt - 1e-6));
    check(JSON.stringify(before) !== JSON.stringify(partsAt(crop.model, 1)),
      `crop ${crop.id} looks different once it is ready to pick`);
  }

  // Every rung of a fixture ladder has to stay aimable: `pickFixture`
  // intersects the top plane of the DRAWN art, so a tier resolving to nothing,
  // or to something lying flat on the floor, is a fixture you cannot click.
  for (const fx of c.fixtures ?? []) {
    const rungs = fx.tiers?.length || 1;
    for (let tier = 1; tier <= rungs; tier++) {
      const parts = partsAt(fx.model, tierProgress(tier, rungs));
      check(modelHeight(parts) > 0, `fixture ${fx.id} tier ${tier} has a face to aim at`);
    }
  }
}

// ---------------------------------------------------------------------------
// 11. Tiers. Upgrading in place: same tile, same stock, better numbers.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  g.setBuildMode('me', true);
  const shelf = g.layout.shelves.find((s) => s.kind !== 'freezer');
  const tiers = g.fixtureTiers('shelf');

  eq(g.fixtureTier(shelf), 1, 'a fixture starts on the bottom rung');
  if (tiers.length < 2) {
    check(false, 'shelf content defines a tier ladder to test');
  } else {
    const item = content().byId.items[anyItem.id];
    const capBefore = g.shelfCapacity(shelf, item);
    shelf.item_id = anyItem.id;
    shelf.qty = 4;
    const { x, z } = shelf;
    const next = g.nextTier(shelf);
    check(!!next, 'there is a rung above');
    eq(next.tier, 2, 'and it is the second one');

    const poor = fresh();
    poor.setBuildMode('me', true);
    poor.cash = 0;
    const broke = poor.upgradeFixture('me', poor.layout.shelves[0].id);
    check(!broke.ok, 'you cannot upgrade what you cannot afford');

    const cash0 = g.cash;
    const up = g.upgradeFixture('me', shelf.id);
    check(up.ok, 'upgrading works', up.error);
    eq(round2(cash0 - g.cash), round2(next.cost), 'and costs exactly what it said');

    const now = g.fixtureAt(x, z);
    check(!!now, 'it is still on the same tile');
    eq(g.fixtureTier(now), 2, 'one rung up');
    eq(now.qty, 4, 'with its stock still on it');
    check(g.shelfCapacity(now, item) >= capBefore, 'and it holds at least as much as before');

    // Moving and turning must never quietly demote it.
    check(g.rotateFixture('me', now.id).ok, 'a tiered fixture can still be turned');
    eq(g.fixtureTier(g.fixtureAt(x, z)), 2, 'and keeps its tier through the turn');

    const carried = g.fixtureAt(x, z);
    check(g.liftFixture('me', carried.id).ok, 'and lifted');
    eq(g.players.me.holding?.tier, 2, 'the tier travels in your hands');
    const dest = findFreeFloor(g, carried.id);
    const moved = g.dropFixture('me', dest);
    check(moved.ok, 'and set down again', moved.error);
    eq(g.fixtureTier(moved.moved), 2, 'still tier 2 on the other side of the shop');

    // Serialisation is what carries it across a restart.
    const restored = Game.restore(g.serialize());
    restored.regenerateLayout();
    eq(restored.fixtureTier(moved.moved), 2, 'and it survives a save/restore round trip');

    // The top of the ladder is the end of it.
    const top = fresh();
    top.setBuildMode('me', true);
    top.cash = 100000;
    let id = top.layout.shelves[0].id;
    for (let i = 1; i < tiers.length; i++) {
      const step = top.upgradeFixture('me', id);
      check(step.ok, `climbing to tier ${i + 1} works`, step.error);
      id = step.upgraded;
    }
    check(!top.upgradeFixture('me', id).ok, 'the top rung cannot be climbed past');
  }
}

// ---------------------------------------------------------------------------
// 12. Tier stats are real. A better shelf keeps things longer than a bare one.
// ---------------------------------------------------------------------------
{
  const probe = fresh();
  const kind = probe.layout.shelves[0].kind === 'freezer' ? 'freezer' : 'shelf';
  const ladder = probe.fixtureTiers(kind);
  const perishable = c.items.find((i) => (i.shelf_life_days ?? 0) > 0 && !i.tags?.includes('shelf-stable'));

  if (!perishable || ladder.length < 2) {
    check(true, 'no tiered spoilage to test on this content set');
  } else {
    /** Put five perishables on shelf 0 and pin it to a tier. */
    const stocked = (game, tier) => {
      const shelf = game.layout.shelves[0];
      game.placements = game.placements.filter((p) => p.id !== shelf.id);
      game.placements.push({
        id: shelf.id, kind, x: shelf.x, z: shelf.z, rot: shelf.rot, tier,
      });
      shelf.tier = tier;
      shelf.item_id = perishable.id;
      shelf.qty = 5;
      shelf.stockedDay = game.day;
      return shelf;
    };

    const days = Math.ceil(perishable.shelf_life_days) + 1;
    const cheap = fresh();
    const cheapShelf = stocked(cheap, 1);
    cheap.day += days;
    cheap.spoilStock();

    const better = fresh();
    const betterShelf = stocked(better, ladder.length);
    better.day += days;
    better.spoilStock();

    check(betterShelf.qty >= cheapShelf.qty,
      'a top-tier shelf never spoils sooner than a bottom-tier one');
    eq(better.fixtureStats(betterShelf).keeps_mult, ladder[ladder.length - 1].keeps_mult ?? 1,
      'and its stats come from the tier it is on');
  }
}

// ---------------------------------------------------------------------------
// 13. Variants. A shape is a look and nothing else: it costs the same, it is
//     free to change your mind about, and it survives everything that moves a
//     fixture around — the same journey a tier is put through above.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  g.setBuildMode('me', true);
  const shapes = content().byId.fixtures?.shelf?.variants ?? [];

  eq(g.fixtureVariant(g.layout.shelves[0]), '', 'a fixture starts as the standard shape');

  if (!shapes.length) {
    check(false, 'shelf content defines another shape to test');
  } else {
    const want = shapes[0].id;

    // Building one. A shape is not a product, so it is priced as the kind.
    const cash0 = g.cash;
    const plain = g.placeFixture('me', { kind: 'shelf', ...findFreeFloor(g) });
    check(plain.ok, 'a standard shelf goes down', plain.error);
    const paidPlain = round2(cash0 - g.cash);

    const cash1 = g.cash;
    const spot = findFreeFloor(g);
    const shaped = g.placeFixture('me', { kind: 'shelf', ...spot, variant: want });
    check(shaped.ok, 'and so does a shaped one', shaped.error);
    eq(round2(cash1 - g.cash), paidPlain, 'and it costs exactly what the plain one cost');
    eq(g.fixtureVariant(g.fixtureAt(spot.x, spot.z)), want, 'it really is that shape');

    // A shape nobody drew is not an error you can build: it falls back.
    const bogus = g.placeFixture('me', { kind: 'shelf', ...findFreeFloor(g), variant: 'no-such-shape' });
    check(bogus.ok, 'an unknown shape still builds', bogus.error);
    eq(g.fixtureVariant(bogus.placed), '', 'as the standard one');

    // Restyling in place: free, and it keeps what is on it.
    let here = g.fixtureAt(spot.x, spot.z);
    // Through the layout, not through `fixtureAt` — that one hands back a copy
    // with the live record on `.ref`, so stocking the copy stocks nothing.
    Object.assign(g.layout.shelves.find((s) => s.id === here.id), {
      item_id: anyItem.id, qty: 6,
    });
    const cash2 = g.cash;
    const styled = g.styleFixture('me', here.id, '');
    check(styled.ok, 'a placed fixture can be restyled', styled.error);
    eq(round2(g.cash), round2(cash2), 'and it is free');
    here = g.fixtureAt(spot.x, spot.z);
    eq(g.fixtureVariant(here), '', 'it changed shape');
    eq(here.qty, 6, 'and kept its stock');

    check(!g.styleFixture('me', here.id, 'no-such-shape').ok, 'you cannot restyle into a shape that does not exist');

    // The same journey section 11 puts a tier through.
    check(g.styleFixture('me', here.id, want).ok, 'restyled back');
    here = g.fixtureAt(spot.x, spot.z);
    check(g.rotateFixture('me', here.id).ok, 'a shaped fixture can be turned');
    eq(g.fixtureVariant(g.fixtureAt(spot.x, spot.z)), want, 'and keeps its shape through the turn');

    const carried = g.fixtureAt(spot.x, spot.z);
    check(g.liftFixture('me', carried.id).ok, 'and lifted');
    eq(g.players.me.holding?.variant, want, 'the shape travels in your hands');
    const moved = g.dropFixture('me', findFreeFloor(g, carried.id));
    check(moved.ok, 'and set down again', moved.error);
    eq(g.fixtureVariant(moved.moved), want, 'still that shape across the shop');

    if (g.fixtureTiers('shelf').length > 1) {
      const up = g.upgradeFixture('me', moved.moved);
      check(up.ok, 'and can still be upgraded', up.error);
      eq(g.fixtureVariant(up.upgraded), want, 'without losing its shape');
      eq(g.fixtureTier(up.upgraded), 2, 'while gaining the tier');
    }

    const restored = Game.restore(g.serialize());
    restored.regenerateLayout();
    const last = restored.layout.shelves.find((s) => restored.fixtureVariant(s) === want);
    check(!!last, 'and the shape survives a save/restore round trip');

    // Same gate as every other named verb.
    const outside = fresh();
    check(!outside.styleFixture('me', outside.layout.shelves[0].id, want).ok,
      'you cannot restyle outside build mode');
  }
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

/**
 * Somewhere this suite can put a fixture without side effects — so the strict
 * rule, not the player's one. A spot that merely *warns* is legal to build on
 * now, but it would leave the shop cut off and every later assertion arguing
 * with a shop nobody can walk through.
 */
function canPlaceHere(g, spec, ignoreId = null) {
  return canPlaceCleanly(g.layout, spec, { ignoreId }).ok;
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
