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
import { shelfFor } from '../server/sim/staff.js';
import { content } from '../server/content.js';
import { requiredFixture } from '../shared/tags.js';
import {
  canPlace, canPlaceCleanly, isGround, isSurface, faceAlong, behindTile,
  blockedAt, insideStore, tileAt,
} from '../shared/build.js';
import { SOLID, edgeBetween } from '../shared/edges.js';
import { kindOf } from '../shared/pieces.js';
import { LOT_KINDS, lotStacks, lotTotal, lotQty, lotHas } from '../shared/lot.js';
import { WALKABLE } from '../shared/tiles.js';
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
  // A world id nothing else uses, and one that need not exist: reading a save
  // never creates one, and an ephemeral game never writes. So this sweep can
  // name its own shop without leaving a save slot behind in somebody's menu.
  const g = Game.create({ worldId: 'verify', seed: 'mech', ephemeral: true });
  // Every piece of world state that `Game.create` reads off the save has to be
  // reset here, or this sweep silently measures whatever the live shop happens
  // to look like. `edits` cost a real debugging detour the day it was added:
  // a wall drawn in the running game partitioned the test shop, every candidate
  // tile came back as "that walls something off", and the sweep failed with
  // "there is nowhere to build" in a shop that was 125 legal spots empty.
  g.placements = [];
  g.grow = { w: 0, h: 0 };
  g.doorShift = 0;
  g.edits = [];
  // The stored shell goes too, and this one is the subtlest of the lot. With a
  // shell set, the building is the size it already is and the generator stops
  // growing one to fit — so pinning the ledger above and leaving the shell alone
  // asks a 10x9 shop to hold a 10x11 shop's worth of shelving, and `compose`
  // hands back a layout with no shelves in it at all. Clearing it puts this
  // sweep back on a shop generated for exactly the ledger it just pinned.
  g.shell = null;
  // `want` is how a shop of a stated shape is asked for since step 9 retired the
  // stored ledger. It used to be `g.fixtures = {...SHOP}` on the line above the
  // placements; the generator is handed either the base shop or whatever is
  // already standing, and a sweep's pinned six-and-a-freezer is neither.
  g.regenerateLayout(null, {}, { want: SHOP });
  // ...and re-stamp, so what the sweep drives is a stamped shop like any other.
  g.freezeShell();
  g.cash = 5000;
  g.addPlayer('me', 'Tester');
  // The tester holds the button down for the whole sweep.
  //
  // Since the ring stopped winding on its own, an action needs a press — see
  // `Game.stepActions`. A sweep that did not press would find that nothing in
  // the game does anything, which reads as every mechanic being broken rather
  // than as the harness having forgotten to be a player. This is the newest
  // entry in the `fresh()` trap at the top of CLAUDE.md: state that is not new
  // to the save, but newly matters to what fires.
  //
  // It is deliberately NOT the default on a player. A shop where the button is
  // down until somebody lifts it is the auto-fire this replaced.
  g.players.me.pressing = true;
  return g;
}
/**
 * Stand next to something (the bot in simulate.js does the same thing).
 *
 * The route and the keys go with you, and that is not tidiness: an action only
 * charges while you are stopped now (`moving` in `sim/index.js`), so a blink to
 * a shelf's working spot with the route it was planned by still hanging off the
 * player — or with a direction still held from a shuffle six lines up — is a
 * person the sim can see is mid-walk, and nothing arms for them. `take` plans a
 * route, so the pickup cases teleported into a state no player can be in and
 * then measured it. Standing means stopped.
 */
const stand = (g, at) => Object.assign(g.players.me, {
  x: at.x, z: at.z, path: null, input: { dx: 0, dz: 0 },
});
const totalOnFloor = (g, itemId) => g.deliveries
  .reduce((s, d) => s + (itemId ? lotQty(d, itemId) : lotTotal(d)), 0);

// ---- arranging and reading a unit's boards --------------------------------
//
// A unit holds one entry per KIND of thing, so every one of these used to be a
// bare field assignment and is now a board. Written as four helpers rather than
// inline, because a sweep that arranges its own state through the same shape
// the sim writes is a sweep that keeps testing the sim rather than the shape:
// when boards changed, exactly these four had to move and none of the
// assertions did.

/** Arrange: stand `qty` of an item on a board of this unit. */
const put = (shelf, item, qty, { price = 3, day = 0 } = {}) => {
  shelf.stacks = [
    ...(shelf.stacks ?? []).filter((k) => k.item_id !== item.id),
    { item_id: item.id, qty, price, stockedDay: day },
  ];
  return shelf;
};
/** What is on the first board, or null for a bare unit. */
const held = (shelf) => (shelf?.stacks ?? [])[0]?.item_id ?? null;
/** How much is on it — of one item, or of everything. */
const qtyOn = (shelf, itemId = null) => (shelf?.stacks ?? [])
  .filter((k) => !itemId || k.item_id === itemId)
  .reduce((n, k) => n + (k.qty ?? 0), 0);
/** What it is kept for, as one id — the sweep's shorthand for a one-item list. */
const keptFor = (shelf) => (shelf?.assigned ?? [])[0] ?? null;

const c = content();
const anyItem = c.items.find((i) => !c.recipes.some((r) => r.output_id === i.id));
/** Two things that live on a plain shelf, and one that has to be frozen. */
const warm = c.items.filter((i) => requiredFixture(i) !== 'freezer');
const plainItem = warm[0];
const otherItem = warm[1] ?? warm[0];
/**
 * ...and a third, which is the control for "nothing NEW may move onto a
 * reserved unit". Section 14 needs one thing that has a board on the unit and
 * one that has never had one, or "your hands may top up what is standing there"
 * cannot be told from "a reservation stopped binding your hands".
 */
const spareItem = warm[2] ?? warm[1] ?? warm[0];
/**
 * A pair of hands filled to the KINDS cap with things that are not `plainItem`.
 *
 * The sweep needs it because "hands full" stopped being one sentence. Hands
 * hold `LOT_KINDS` different things, so being out of UNITS and being out of
 * HANDS are two different refusals with two different fixes, and a test that
 * only ever filled the units would never reach the second one at all.
 */
const otherKinds = (n = LOT_KINDS) => ({
  stacks: warm.filter((i) => i.id !== plainItem.id).slice(0, n)
    .map((i) => ({ item_id: i.id, qty: 1 })),
});
const frozenItem = c.items.find((i) => requiredFixture(i) === 'freezer') ?? null;
/** Any crop. Every crop grows in every season now — see `CropSchema`. */
const cropFor = () => c.crops[0];

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
// 1c. A bed replants ITSELF, and switching it costs exactly one seed.
//
// The two halves are one claim and have to be tested together, because each on
// its own is a bug that has actually shipped.
//
// Replanting the globally selected seed converts a farm one bed at a time: `sow`
// sets that seed as a convenience, so turning ONE bed over from a coop to
// tomatoes made tomatoes the answer for every other bed, each converting days
// later at the moment it was picked, with nothing in the log but "Sowed Tomato
// Vine". Six varieties become six beds of whatever you last touched, and no
// amount of care with the hotbar avoids it.
//
// And replanting the bed's own crop with no way back charges for a seed you were
// about to replace — a switch buys two, which measured a third of all profit
// over 60 days and is precisely why the wrong rule was there. `sow` refunds what
// it pulls up scaled by how little it has grown, so the correction is free at
// growth 0 and the double charge cannot happen.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const plot = g.layout.plots[0];
  const grown = cropFor(g);
  // A different crop, or there is nothing to test.
  const other = c.crops.find((cr) => cr.id !== grown.id);

  stand(g, plot);
  g.till('me', plot.id);
  g.plant('me', plot.id, grown.id);
  plot.ready = true;
  g.players.me.carry = null;

  if (other) {
    // The hotbar says something else entirely, which is the whole test: it is
    // the state a player is in the moment after turning any ONE bed over.
    g.players.me.selectedCrop = other.id;
    const cashBefore = g.cash;
    const picked = g.harvest('me', plot.id);

    eq(picked.item_id, grown.item_id, 'you pick what was actually growing');
    eq(picked.replanted, grown.id, 'and the bed puts its OWN crop back');
    eq(plot.crop_id, grown.id, 'whatever seed the hotbar is holding');
    eq(round2(cashBefore - g.cash), round2(grown.seed_cost),
      'charged once, for the seed that went in');

    // ...and turning it over on the spot is the same price as if the bed had
    // replanted the other crop itself. Growth is 0 the tick a replant lands, so
    // the refund is whole — the correction is free, which is what makes a
    // per-bed decision affordable.
    const swap = g.sow('me', plot.id, other.id);
    check(swap.ok, 'the bed can be turned over straight after picking');
    eq(plot.crop_id, other.id, 'and it is the new crop growing there');
    eq(round2(swap.refund), round2(grown.seed_cost), 'the seed just sown comes back whole');
    // Measured from before the HARVEST, which is the only way to say it: the
    // replant and the switch are two charges and one refund, and what a player
    // cares about is what the whole gesture cost.
    eq(round2(cashBefore - g.cash), round2(other.seed_cost),
      'so picking and switching buys exactly one seed, never two');

    // The other end of the same rule: a crop that has actually grown is worth
    // something, and pulling it up throws that away. A flat refund here would
    // make ripping up an almost-ripe field free.
    const g3 = fresh();
    const bed = g3.layout.plots[0];
    stand(g3, bed);
    g3.till('me', bed.id);
    g3.plant('me', bed.id, grown.id);
    bed.plantedAt = g3.elapsed - grown.grow_minutes * 60 * 0.5;
    const half = g3.sow('me', bed.id, other.id);
    check(half.refund < grown.seed_cost * 0.9,
      'but a half-grown bed does not hand its seed back whole');
  }

  // Nothing selected changes nothing: the bed was always going to put back what
  // it grew, which is also what staff and anything headless get.
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
  eq(picked.qty + picked.spare, promised,
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
  // The farm is indoors, so the season is not a fact about the bed.
  //
  // This block used to assert the opposite, and what it was really pinning was
  // never `plant`'s refusal — it was that a bed whose crop had gone out of
  // season came back EMPTY. `harvest` falls through to `clearPlot` when
  // `replantable` says no, so one week of winter took the whole field out of
  // production and left it as turned soil, silently, with nothing logged. The
  // sweep is kept pointed the other way rather than deleted, because the value
  // in it was always the bed's state after the pick rather than the refusal:
  // every season, over every crop, the bed must still be planted afterwards.
  //
  // The season CLOCK is deliberately still turned underneath it. Seasons did
  // not go away — an item's `season` tag still swings its price 1.35/0.75 — so
  // a change that stopped the world having a season at all would pass a test
  // written as "sowing works" and would take demand seasonality with it.
  for (const season of ['spring', 'summer', 'autumn', 'winter']) {
    const g = fresh();
    const plot = g.layout.plots[0];
    const crop = c.crops[0];
    stand(g, plot);
    g.season = season;
    g.till('me', plot.id);
    check(g.plant('me', plot.id, crop.id).ok, `planting works in ${season}`);
    plot.ready = true;
    g.players.me.carry = null;

    const out = g.harvest('me', plot.id);
    check(out.ok, `harvesting works in ${season}`);
    eq(out.replanted, crop.id, `the bed re-sows itself in ${season}`);
    eq(plot.crop_id, crop.id, `and is planted rather than emptied in ${season}`);
    check(g.replantable(crop).ok, `replantable() agrees in ${season}`);
    eq(g.season, season, `and the world still knows it is ${season}`);
  }

  // Money is still a gate, which is the control: `replantable` losing its
  // season test must not have left it answering yes to everything, or the bed
  // replants on credit and the refusal it exists for has gone with the one that
  // was removed on purpose.
  {
    const g = fresh();
    const crop = c.crops.reduce((a, b) => (b.seed_cost > a.seed_cost ? b : a));
    if (crop.seed_cost > 0) {
      g.cash = crop.seed_cost / 2;
      check(!g.replantable(crop).ok, 'a bed you cannot afford the seed for is still refused');
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Clearing your hands — nothing is ever destroyed.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  g.players.me.carry = { item_id: anyItem.id, qty: 4 };

  const away = g.stow('me');
  check(!away.ok, 'you cannot put things down away from the yard');

  // The delivery bay is not the drop-off. Two pads is the whole point: an order
  // that arrived and an armful you parked are the same pallet, so the only way
  // to tell them apart is which pad they are standing on.
  stand(g, g.layout.bay);
  check(!g.stow('me').ok, 'and you cannot put them down on the delivery pad');

  stand(g, g.dropPad());
  check(g.stow('me').ok, 'stowing at the drop-off works');
  check(!g.players.me.carry, 'stowing empties your hands');
  eq(totalOnFloor(g, anyItem.id), 4, 'every unit survives as a crate');

  // Two loads of the same thing top up one crate rather than building a forest
  // of them — but only to the brim. A load that does not fit fills this one and
  // starts the next, and the pile is how much is there. Merging without a
  // ceiling was the other bug: sixteen carrots came out as one box wearing
  // "x16" that four trips could not empty.
  //
  // `cap` is asked of the game rather than assumed to be a pair of hands. It
  // was `carryCapacity` until crates could be carried whole, and the two had to
  // stop being the same number for hauling to be a decision at all — see
  // `crateCapacity`. Every arithmetic below is against `cap`, so this section
  // says what it meant to say at either value.
  const cap = g.crateCapacity();
  g.players.me.carry = { item_id: anyItem.id, qty: 3 };
  g.stow('me');
  eq(totalOnFloor(g, anyItem.id), 7, 'stowing twice keeps the total');
  eq(g.deliveries.length, 7 > cap ? 2 : 1, 'and tops up the crate rather than starting a forest');
  check(g.deliveries.every((d) => lotTotal(d) <= cap), 'no crate holds more than a crate');
  if (7 > cap) eq(lotTotal(g.deliveries[0]), cap, 'the first crate is filled to the brim before the next is opened');

  // An armful stows as one crate and comes back out in armfuls. It used to come
  // back in ONE armful, because a crate held exactly what hands held; a crate
  // is bigger than that now, so what this asserts is the invariant that
  // survived the change — an armful put down is an armful you can pick up, and
  // nothing is created or lost either way.
  {
    const one = fresh();
    stand(one, one.dropPad());
    const hands = one.carryCapacity();
    one.players.me.carry = { item_id: anyItem.id, qty: hands };
    one.stow('me');
    eq(one.deliveries.length, 1, 'an armful stows as exactly one crate');
    eq(totalOnFloor(one, anyItem.id), hands, 'holding exactly what was put in it');
    check(one.unload('me', one.deliveries[0].id).ok, 'which can be picked up again');
    eq(lotTotal(one.players.me.carry), hands, 'filling the same pair of hands');
    eq(one.deliveries.length, 0, 'and nothing is left standing there');
  }

  // ...and it can be picked straight back up.
  const back = g.unload('me', g.deliveries[0].id);
  check(back.ok, 'a stowed crate can be picked back up');
  check(lotTotal(g.players.me.carry) > 0, 'picking it back up fills your hands');

  // Putting down is named too now, and the drop-off is the one target in the
  // shop that has no id to name it by — it is painted ground rather than an
  // object. Tapping one of its cells IS the naming, and `walkTo` is where that
  // is read, which is why this half of the yard has no verb of its own.
  g.players.me.carry = { item_id: anyItem.id, qty: 2 };
  g.deliveries = [];
  stand(g, g.dropPad());
  eq(g.actionFor(g.players.me), null,
    'standing at the drop-off with full hands does nothing on its own');

  const pad = g.dropPad();
  check(g.walkTo('me', pad.x, pad.z).ok, 'tapping a cell of the pad is accepted');
  eq(g.actionFor(g.players.me)?.kind, 'stow', 'and tapping it is what arms the stow');
  g.stepActions(5);
  eq(g.players.me.carry, null, 'the ring puts it down');
  eq(g.players.me.errand, null, 'and spends the errand');
  eq(g.actionFor(g.players.me), null, 'so standing there does nothing again');

  // ...and picking up is the half that must never happen on its own. This used
  // to need a latch (`stowLock`): both halves re-armed the instant they
  // finished, so setting an armful down beside a crate of the same thing picked
  // it straight back up, for as long as you stood there. The latch is gone
  // because the loop is — nothing is picked up or put down that was not asked
  // for by name.
  g.players.me.carry = { item_id: anyItem.id, qty: 2 };
  g.dropGoods(anyItem.id, 5, g.dropPad());
  check(g.stow('me').ok, 'stowing beside a matching crate works');
  // Specifically *unload*, not "nothing at all". This boots from the live save,
  // so whatever the shop currently has near its yard can legitimately arm
  // something else, and asserting silence made this fail whenever the other
  // half of the co-op happened to build near the loading pad.
  check(g.actionFor(g.players.me)?.kind !== 'unload',
    'and standing on the crate does not offer to unload it');

  // Not after a shuffle, and not after leaving and coming back either — there
  // is no state that decays into a pickup, which is the whole claim.
  g.setInput('me', 1, 0);
  g.stepPlayers(0.1);
  stand(g, { x: 1, z: 1 });
  g.stepPlayers(0.1);
  stand(g, g.dropPad());
  check(g.actionFor(g.players.me)?.kind !== 'unload',
    'nor after walking out of reach of it and back');

  // Naming it is the only thing that arms it.
  const crate = g.deliveries.find((d) => lotHas(d, anyItem.id));
  const named = g.take('me', { palletId: crate.id });
  check(named.ok, `naming a crate sets off to get it (${named.error ?? ''})`);
  // "Sets off" is literal — `take` plans the walk — so the walk has to end
  // before the charge means anything. `stand` is how this sweep arrives.
  stand(g, crate);
  // Empty hands at a crate is a LIFT — the whole box — and full hands is the
  // armful it always was. One address, two jobs, chosen by the state you are in
  // rather than by a modifier. Both are asserted, because "the crate arms
  // something" would pass whichever of them it happened to be.
  eq(g.actionFor(g.players.me)?.kind, 'lift', 'and standing at it arms the pickup');

  // One errand, one action. Firing it spends it, or a crate you tapped once
  // would refill your hands every time you walked past for the rest of the day.
  g.stepActions(5);
  check(lotTotal(g.players.me.haul) > 0, 'the charge shoulders the whole crate');
  eq(g.players.me.carry, null, 'and leaves your hands empty, because a box is not stock');
  eq(g.players.me.errand, null, 'and the errand is spent');
  check(g.actionFor(g.players.me)?.kind !== 'lift', 'so it does not arm again');

  // Put it back down and do it again with an armful already held, which is the
  // other branch of the same address.
  check(g.dropCrate('me').ok, 'and it can be set straight back down');
  const again = g.deliveries.find((d) => lotHas(d, anyItem.id));
  g.players.me.carry = { item_id: anyItem.id, qty: 1 };
  check(g.take('me', { palletId: again.id }).ok, 'naming it again with a hand full is accepted');
  stand(g, again);
  eq(g.actionFor(g.players.me)?.kind, 'unload', 'which arms the armful instead');
  g.stepActions(5);
  check(lotTotal(g.players.me.carry) > 1, 'the charge fills your hands');
  eq(g.players.me.errand, null, 'and the errand is spent');
  check(g.actionFor(g.players.me)?.kind !== 'unload', 'so it does not arm again');
  // A crate parked at the drop-off is a crate you are stood *on*, so the pad
  // used to arm the instant your hands were full — and tapping the crate filled
  // your hands. That needed a latch (`tookFrom`) for exactly as long as putting
  // down was something the floor decided; both are gone.
  eq(g.actionFor(g.players.me), null,
    'nor does the pad you took it off put it straight back');
}

// ---------------------------------------------------------------------------
// 3. Clearing a fixture — stock lands on the floor rather than vanishing.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const shelf = g.layout.shelves.find((s) => s.kind !== 'freezer');
  put(shelf, anyItem, 9, { price: 3 });
  stand(g, shelf.browseAt);

  check(g.stripShelf('me', shelf.id).ok, 'stripping a shelf works');
  eq(qtyOn(shelf), 0, 'the shelf ends up empty');
  eq(held(shelf), null, 'and unlabelled, so anything can go on it next');
  eq(totalOnFloor(g, anyItem.id), 9, 'all nine units are on the floor beside it');

  // An unlabelled shelf must accept anything again — that's the whole point.
  g.players.me.carry = { item_id: anyItem.id, qty: 2 };
  check(g.stockShelf('me', shelf.id).ok, 'a stripped shelf takes new stock');

  // Emptying an appliance.
  const g2 = fresh();
  // An appliance exists because one is standing there, not because an upgrade
  // is owned and not because a ledger says so. Which means putting one in the
  // test shop means *building* one, exactly as a player does.
  g2.setBuildMode('me', true, 'shelf');
  g2.cash += 10000;
  for (const u of c.upgrades.filter((x) => x.kind === 'station')) {
    if (!u.payload?.station) continue;
    const at = findFreeFloor(g2);
    // How many machines the catalog sells is content, and the test shop is a
    // fixed size — so this loop is one authored appliance away from filling the
    // building at any time, and it did the day the stock pot was added. A full
    // shop is a fact about the shop rather than a failure: what is under test
    // below is `dumpStation`, which needs *an* appliance and not all of them.
    if (!at) break;
    g2.placeFixture('me', { kind: 'station', station: u.payload.station, x: at.x, z: at.z, rot: at.rot });
  }
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
// 3b. Taking one board back off a shelf.
//
// The other direction of `stockShelf`, and until it existed the only way to get
// goods off a shelf was to tip the whole unit on the floor. Two of these are
// invisible in play and are the reason this block is here: that an emptied
// board keeps its label — a stack at zero is what lets an empty shelf be
// relabelled, so clearing it hands a reserved board to the next van — and that
// nothing is created on the way, which a max-of-two-numbers is one typo from.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const shelf = g.layout.shelves.find((s) => s.kind !== 'freezer');
  put(shelf, plainItem, 9, { price: 3 });
  stand(g, shelf.browseAt);

  const took = g.unshelve('me', shelf.id, plainItem.id);
  check(took.ok, `taking off a board works (${took.error ?? ''})`);
  const inHand = lotTotal(g.players.me.carry);
  check(inHand > 0, 'and fills your hands');
  eq(qtyOn(shelf, plainItem.id) + inHand, 9, 'nothing is created or destroyed taking it');

  // An armful, not the board — a shelf holds more than a person does.
  eq(inHand, Math.min(9, g.carryCapacity()), 'as much as you can hold, no more');

  // Take the rest and the label survives, because a stack at zero IS the label.
  while (qtyOn(shelf, plainItem.id) > 0) {
    g.players.me.carry = null;
    g.unshelve('me', shelf.id, plainItem.id);
  }
  eq(held(shelf), plainItem.id, 'a board emptied by hand keeps its label');
  check(!g.unshelve('me', shelf.id, plainItem.id).ok, 'and a bare board gives nothing');

  // Hands full of something else USED to be a refusal, and is not one any more:
  // hands hold `LOT_KINDS` kinds, so an armful of tomatoes leaves a hand free
  // for the bread. What replaced it is out of HANDS rather than out of units —
  // a fourth kind has nowhere to go, and that refusal is the one this asserts,
  // because it is the one nothing else in the sweep would ever reach.
  put(shelf, plainItem, 5);
  g.players.me.carry = otherKinds();
  const clash = g.unshelve('me', shelf.id, plainItem.id);
  check(!clash.ok, 'a fourth kind has nowhere to go');
  eq(qtyOn(shelf, plainItem.id), 5, 'and the refused board keeps all of it');
  eq(lotStacks(g.players.me.carry).length, LOT_KINDS, 'and the refusal costs you no hands');

  // ...and one hand short of the cap it simply works, which is the whole point
  // of the change: an armful of one thing no longer strands you in front of a
  // board of another.
  g.players.me.carry = otherKinds(LOT_KINDS - 1);
  check(g.unshelve('me', shelf.id, plainItem.id).ok,
    'an armful of something else leaves a hand free');
  check(lotQty(g.players.me.carry, plainItem.id) > 0, 'and the board fills it');
  put(shelf, plainItem, 5);

  // Reach is real, and it is what the walk in `take` exists to satisfy — a menu
  // button that filled your arms from across the shop would make the floor
  // irrelevant the way ordering straight into your hands once did.
  g.players.me.carry = null;
  stand(g, { x: 1, z: 1 });
  check(!g.unshelve('me', shelf.id, plainItem.id).ok, 'and not from across the shop');

  // Naming the board sets off toward it rather than reaching for it.
  const named = g.take('me', { shelfId: shelf.id, itemId: plainItem.id });
  check(named.ok, `naming a board is accepted from anywhere (${named.error ?? ''})`);
  eq(g.players.me.carry, null, 'and takes nothing on its own');
  stand(g, shelf.browseAt);
  eq(g.actionFor(g.players.me)?.kind, 'take', 'arriving is what arms it');

  // ONE RING, THE WHOLE BOARD — into a CRATE on your shoulder, because a board
  // holds more than a pair of hands and "take it all" is the thing anybody
  // wants off a shelf. It was metered for four steps, one unit per turn of the
  // ring across a second, and the reason that went is the reason this asserts
  // the count rather than a duration: a hold whose length is computed from the
  // world is a hold that can finish inside `LONG_PRESS_MS`, and then an
  // ordinary tap comes away with a crate. Every other hold in the game is one
  // ring and then the thing happens.
  const onBoard = qtyOn(shelf, plainItem.id);
  g.stepActions(5);
  eq(lotTotal(g.players.me.haul), onBoard, 'one ring takes the whole board');
  eq(qtyOn(shelf, plainItem.id), 0, 'and leaves it bare');
  eq(g.players.me.carry, null, 'onto your shoulder, leaving your hands free');
  eq(lotTotal(g.players.me.haul) + qtyOn(shelf, plainItem.id), onBoard,
    'and nothing is created on the way off');
  eq(g.players.me.errand, null, 'and a pull that emptied the board spends its errand');

  // A board bigger than a crate leaves the rest standing rather than losing it.
  // The one place this could destroy goods, and the reason `crateBoard` bounds
  // the take by the crate's own room rather than by the board's count.
  Object.assign(g.players.me, { haul: null, carry: null, action: null, errand: null });
  put(shelf, plainItem, g.crateCapacity() + 8, { price: 3 });
  const over = qtyOn(shelf, plainItem.id);
  g.take('me', { shelfId: shelf.id, itemId: plainItem.id });
  stand(g, shelf.browseAt);
  g.stepActions(5);
  eq(lotTotal(g.players.me.haul), g.crateCapacity(), 'a crate takes what a crate holds');
  eq(qtyOn(shelf, plainItem.id), over - g.crateCapacity(), 'and the rest stays on the board');
  check(g.crateCapacity() > g.carryCapacity(),
    'which is more than a pair of hands, or the crate has bought nothing');

  // ...and it takes them off the SHELF rather than putting them back on it.
  // This used to need a latch (`tookFrom`): stocking armed on full hands beside
  // a shelf that would have them — exactly the state a pickup leaves you in —
  // so a board emptied by hand refilled itself on the very next tick.
  Object.assign(g.players.me, { haul: null, carry: null, action: null, errand: null });
  g.take('me', { shelfId: shelf.id, itemId: plainItem.id });
  stand(g, shelf.browseAt);
  eq(g.actionFor(g.players.me)?.kind, 'take',
    'the shelf you are pulling from does not offer to take it back');

  // A TAP is the fine end of the same grade — exactly one, into your HANDS. A
  // lone crate has drawn this line since it became rummageable: a tap is one, a
  // hold is the box.
  Object.assign(g.players.me, { haul: null, carry: null, action: null });
  put(shelf, plainItem, 5, { price: 3 });
  const before = qtyOn(shelf, plainItem.id);
  const tapped = g.tapBoard('me', shelf.id, plainItem.id);
  check(tapped.ok, `a tap takes one (${tapped.error ?? ''})`);
  eq(lotTotal(g.players.me.carry), 1, 'one unit, into your hands');
  eq(g.players.me.haul, null, 'and not into a crate');
  eq(qtyOn(shelf, plainItem.id), before - 1, 'one off the board, no more');
  eq(g.players.me.errand, null, 'and it spends whatever the press had armed');

  // HANDS AND A SHOULDER NO LONGER REFUSE EACH OTHER, which is a claim about
  // two verbs that each used to veto the other's state. One rule said twice —
  // goods may only be in one place at a time — and it predates there being two
  // buttons: a left press takes and a right press puts, so nothing about the
  // direction is in doubt, and picking one loaf up should never be what stops
  // you clearing the board it came off.
  Object.assign(g.players.me, { haul: null, carry: null, action: null, errand: null });
  put(shelf, plainItem, g.carryCapacity() + 4, { price: 3 });
  const bothStart = qtyOn(shelf, plainItem.id);
  g.unshelve('me', shelf.id, plainItem.id);
  const inArms = lotTotal(g.players.me.carry);
  check(inArms > 0, 'an armful first');
  const both = g.crateBoard('me', shelf.id, plainItem.id);
  check(both.ok, `and the board still crates with your hands full (${both.error ?? ''})`);
  eq(lotTotal(g.players.me.carry), inArms, 'the armful is untouched');
  check(lotTotal(g.players.me.haul) > 0, 'and the crate has the board');
  eq(lotTotal(g.players.me.carry) + lotTotal(g.players.me.haul) + qtyOn(shelf, plainItem.id),
    bothStart, 'with nothing created or destroyed between the two');

  // ...and the same the other way round: a box on your shoulder does not stop
  // your hands. This is the direction that actually bit — `unshelve` refused
  // outright, so a crate up meant no shelf in the shop would give you a single
  // unit of anything.
  put(shelf, plainItem, 6, { price: 3 });
  g.players.me.carry = null;
  const armful = g.unshelve('me', shelf.id, plainItem.id);
  check(armful.ok, `an armful comes off with a crate up (${armful.error ?? ''})`);
  check(lotTotal(g.players.me.carry) > 0, 'and fills your hands');

  Object.assign(g.players.me, { haul: null, carry: null, action: null, errand: null });
  put(shelf, plainItem, 6, { price: 3 });
  g.unshelve('me', shelf.id, plainItem.id);

  // Putting it back on the very same unit is one tap and needs no walk away
  // first, which is what makes this a rule rather than a pause: the latch had
  // to expire, whereas naming a target simply says which shelf you meant.
  check(g.walkToFixture('me', shelf.id).ok, 'pointing at that same shelf is accepted');
  eq(g.actionFor(g.players.me)?.kind, 'stock', 'and naming it puts the armful back');
}

// ---------------------------------------------------------------------------
// 3c. Deleting one board — the row on the menu, not the unit.
//
// `build-empty` with an itemId, which is the same verb at a finer address. Two
// claims here are invisible in play and one is invisible on purpose.
//
// It is the one thing in the game that clears the stock AND the label, and that
// is the opposite of the rule directly above it: a board emptied *by hand* keeps
// its label, because a stack at zero is what lets a shelf stay reserved while
// the van is out. Delete has to do the other thing, or the row you deleted comes
// straight back on the next delivery and the button reads as broken.
//
// And the unit is three boards at one id, so a delete that took the id and not
// the item would tip a shelf of three things out when you asked it about one —
// which looks exactly like a working button until you glance at the row above.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  g.setBuildMode('me', true, 'shelf');
  const shelf = g.layout.shelves.find((s) => s.kind !== 'freezer');
  const twoBoards = g.shelfBoards(shelf) >= 2 && otherItem.id !== plainItem.id;

  put(shelf, plainItem, 7, { price: 3 });
  if (twoBoards) put(shelf, otherItem, 4, { price: 2 });
  shelf.assigned = twoBoards ? [plainItem.id, otherItem.id] : [plainItem.id];
  stand(g, shelf.browseAt);

  const gone = g.emptyFixture('me', shelf.id, plainItem.id);
  check(gone.ok, `deleting a board works (${gone.error ?? ''})`);
  eq(qtyOn(shelf, plainItem.id), 0, 'the board is gone rather than left at zero');
  eq(totalOnFloor(g, plainItem.id), 7, 'and all seven are in a crate beside it');
  check(!(shelf.assigned ?? []).includes(plainItem.id),
    'the label goes with them, or the next van puts the row straight back');

  if (twoBoards) {
    eq(qtyOn(shelf, otherItem.id), 4, 'the other board is untouched');
    eq(totalOnFloor(g, otherItem.id), 0, 'and none of it reached the floor');
    check((shelf.assigned ?? []).includes(otherItem.id), 'and it is still kept for it');
  }

  // An empty board deletes too. This is the case the row exists for as often as
  // not — a thing that has sold out still holds a board, and refusing to remove
  // it would mean emptying the whole unit to be rid of one sold-out line.
  put(shelf, plainItem, 0);
  shelf.assigned = [...(shelf.assigned ?? []), plainItem.id];
  check(g.emptyFixture('me', shelf.id, plainItem.id).ok, 'a board at zero deletes as well');
  eq(qtyOn(shelf, plainItem.id), 0, 'and takes its board with it');
  check(!(shelf.assigned ?? []).includes(plainItem.id), 'and its label');

  // Asked about something that isn't there at all, it is a refusal rather than a
  // no-op, and specifically not a fall-through to tipping the unit out.
  const held0 = qtyOn(shelf);
  check(!g.emptyFixture('me', shelf.id, plainItem.id).ok, 'a board that is not there is refused');
  eq(qtyOn(shelf), held0, 'and nothing else moved');

  // Same gate as the verb it rides on — a delete out of build mode is refused.
  // Named at a board that is definitely there, or this passes on "no such board"
  // and says nothing at all about the gate.
  put(shelf, plainItem, 3);
  g.setBuildMode('me', false);
  check(!g.emptyFixture('me', shelf.id, plainItem.id).ok,
    'you cannot delete a board outside build mode');
  eq(qtyOn(shelf, plainItem.id), 3, 'and the board it refused keeps all of it');
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
  put(mine, anyItem, 7);
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
  eq(qtyOn(after), 7, 'its stock came with it');
  eq(held(after), anyItem.id, 'including what it was labelled as');
  check(after && after.x === dest.x && after.z === dest.z, 'it landed where it was put');

  // Selling it back tips its stock into crates itself, then refunds half. A
  // separate Empty press here is pure ceremony: Remove already names the shelf
  // and the game already has a lossless place for everything on it to go.
  stand(g, after);
  const cashBeforeSell = g.cash;
  const gone = g.removeFixture('me', after.id);
  check(gone.ok, 'removing a stocked shelf works', gone.error);
  eq(gone.emptied, 7, 'and reports how much it tipped out');
  eq(totalOnFloor(g, anyItem.id), 7, 'its stock is on the floor, not gone');
  eq(g.layout.shelves.length, before, 'the shop is back to where it started');
  eq(round2(g.cash - cashBeforeSell), round2(unit / 2), 'and refunded half the price');

  // An appliance is bought and sited exactly like a shelf. It used to be
  // upgrade ownership — one of each, forever, wherever the generator felt like
  // — so the whole round trip is worth asserting rather than just the price.
  const sold = c.upgrades.find((u) => u.kind === 'station' && u.payload?.station);
  if (sold) {
    const name = sold.payload.station;
    const key = `station:${name}`;
    const gs = fresh();
    gs.setBuildMode('me', true, 'station');
    gs.cash += sold.cost * 2;

    const had = gs.layout.stations.length;
    const owned = gs.fixtureCounts()[key] ?? 0;
    const cashWas = gs.cash;
    const spotS = findFreeFloor(gs);
    const built = gs.placeFixture('me', { kind: 'station', station: name, x: spotS.x, z: spotS.z, rot: spotS.rot });
    check(built.ok, 'buying a second appliance works', built.error);
    eq(gs.layout.stations.length, had + 1, 'the shop has one more appliance');
    eq(gs.fixtureCounts()[key], owned + 1, 'and it is counted under the machine it is');
    eq(round2(cashWas - gs.cash), round2(sold.cost), 'charged what the upgrade sells it for');
    const madeIt = gs.layout.stations.find((s) => s.id === built.placed);
    eq(madeIt?.station, name, 'and it is the appliance that was asked for');

    // A press on bare floor goes through the row gesture even when it lays one
    // unit. The gesture has to carry WHICH appliance through both the client
    // and `buildRun`; dropping it turns every legal tile into "nothing could go
    // there" because `placeFixture` quite correctly refuses an unnamed machine.
    const runAt = findFreeFloor(gs);
    const run = gs.buildRun('me', {
      kind: 'station', station: name, x: runAt.x, z: runAt.z, rot: runAt.rot,
    });
    check(run.ok, 'an appliance can be placed through the row gesture', run.error);
    const ran = gs.layout.stations.find((s) => s.id === run.placed);
    eq(ran?.station, name, 'and the row gesture keeps which appliance was armed');
    check(gs.removeFixture('me', run.placed).ok, 'the row-placed appliance can be cleaned up');

    // Which is the half that was impossible before: selling one back used to
    // un-own the upgrade, so you could never have two and never really lose one.
    const ownedUpgradeBefore = gs.ownedUpgrades.includes(sold.id);
    stand(gs, madeIt.useAt);
    const soldBack = gs.removeFixture('me', built.placed);
    check(soldBack.ok, 'selling an appliance back works', soldBack.error);
    eq(gs.fixtureCounts()[key] ?? 0, owned, 'and the count came back down');
    eq(gs.layout.stations.length, had, 'and the shop is back to where it started');
    eq(gs.ownedUpgrades.includes(sold.id), ownedUpgradeBefore,
      'and tearing one out did not un-buy the upgrade that sells them');
  } else {
    check(false, 'no appliance upgrade to test building with');
  }

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
  put(shelf, anyItem, 5);
  stand(g, shelf.browseAt);

  g.players.me.carry = { item_id: anyItem.id, qty: 2 };
  check(g.walkToFixture('me', shelf.id).ok, 'pointing at a shelf with full hands is accepted');
  eq(g.actionFor(g.players.me)?.kind, 'stock', 'outside build mode a named shelf gets stocked');

  // Outside build mode, none of the destructive verbs answer at all — no menu
  // can be open, so nothing should reach them.
  check(!g.liftFixture('me', shelf.id).ok, 'you cannot lift a fixture outside build mode');
  check(!g.emptyFixture('me', shelf.id).ok, 'you cannot empty one outside build mode');
  check(!g.removeFixture('me', shelf.id).ok, 'you cannot remove one outside build mode');
  check(!g.rotateFixture('me', shelf.id).ok, 'you cannot turn one outside build mode');
  eq(qtyOn(shelf), 5, 'and the shelf is untouched by any of it');

  // Inside build mode nothing is armed — not proximity, and not an errand you
  // named before you turned the mode on. In build mode a tap is a purchase, so
  // an errand surviving into it would fire under a gesture that meant something
  // else entirely.
  g.setBuildMode('me', true);
  eq(g.actionFor(g.players.me), null, 'build mode arms nothing at all, named or not');
  for (let i = 0; i < 60; i++) g.stepActions(0.1);
  eq(qtyOn(shelf), 5, 'and standing next to a shelf does nothing to it');
  eq(g.players.me.holding ?? null, null, 'nor picks anything up');

  // It is suspended rather than thrown away, which is what makes Empty and
  // Rotate safe to borrow the mode for: a job you named survives a trip through
  // the palette and is still yours when you come back out.
  g.setBuildMode('me', false);
  eq(g.actionFor(g.players.me)?.kind, 'stock', 'leaving build mode restores the named job');
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

  put(b, anyItem, 3);
  const lifted = g.liftFixture('me', b.id);
  check(lifted.ok, 'lifting the far one by id works', lifted.error);
  eq(g.players.me.holding?.id, b.id, 'and you are holding the far one, not the near one');
  eq(qtyOn(a), 0, 'the near shelf was never touched');

  // Distance is not a gate any more. You aimed at it; placing never required
  // you to walk over there either.
  g.players.me.x = 1;
  g.players.me.z = 1;
  const dest = findFreeFloor(g, b.id);
  check(!!dest, 'there is somewhere else to put it');
  const away = g.dropFixture('me', dest);
  check(away.ok, 'you can set it down from across the shop', away.error);
  const moved = g.layout.shelves.find((s) => s.id === away.moved);
  eq(qtyOn(moved), 3, 'and its stock came with it');
  eq(g.fixtureAt(a.x, a.z)?.id, a.id, 'the shelf you did not pick is still where it was');
}

// ---------------------------------------------------------------------------
// 9. Turning something on the spot. Same tile, same stock, new facing.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  g.setBuildMode('me', true);
  const shelf = g.layout.shelves.find((s) => s.kind !== 'freezer');
  put(shelf, anyItem, 6);
  const { x, z } = shelf;
  const rot0 = shelf.rot;
  const oldId = shelf.id;
  const browse0 = { ...shelf.browseAt };
  const stockBefore = g.layout.shelves.reduce((s, o) => s + qtyOn(o), 0);

  const turned = g.rotateFixture('me', shelf.id, 1);
  check(turned.ok, 'turning a shelf works', turned.error);

  const now = g.fixtureAt(x, z);
  check(!!now, 'it is still on the same tile');
  check(now.rot !== rot0, 'and it is facing somewhere else');
  eq(qtyOn(now), 6, 'its stock stayed on it');
  eq(held(now), anyItem.id, 'and so did its label');
  check(now.browseAt.x !== browse0.x || now.browseAt.z !== browse0.z,
    'shoppers now browse it from a different side');
  // `layout.shelves` holds freezers too, so count against both ledgers.
  eq(g.layout.shelves.length, g.fixtureCounts().shelf + (g.fixtureCounts().freezer ?? 0),
    'turning did not create or destroy a shelf');
  eq(g.layout.shelves.reduce((s, o) => s + qtyOn(o), 0), stockBefore,
    'and no stock migrated to another shelf on the way');

  // The id it had is now free, and the generator hands out `shelf-pN` by
  // position — so after a re-flow that name can belong to a different shelf
  // entirely. Anything holding onto an id across a re-flow (the fixture menu
  // did) has to key off the tile instead.
  const recycled = g.findFixture(oldId);
  check(!recycled || recycled.id !== now.id,
    'the old procedural id no longer means the fixture we turned');

  /**
   * A RACK HAS A FRONT, WHICH A BED DID NOT — the claim inverts, and it is
   * pinned rather than dropped for the reason all of these are.
   *
   * "A plot has no front, so there is nothing to turn" was true of a square of
   * earth you stood on and picked from wherever you were. A grow tent is worked
   * from one side, so which side that is has to be something you can choose, and
   * R is the press that chooses it.
   *
   * The half worth asserting is the SPOT rather than the angle: `rot` moving is
   * a number changing, and what a player actually needs is for the side they
   * pick from to have moved with it. That is `repositionFixture` rebuilding
   * `useAt`, and a rack whose anchor did not follow its facing is one you turn
   * and then cannot reach — with the turn visibly having worked.
   */
  const rack = g.layout.plots[0];
  const rackRot = rack.rot ?? 0;
  const rackSpot = { ...rack.useAt };
  const rackAt = { x: rack.x, z: rack.z };
  const spun = g.rotateFixture('me', rack.id, 1);
  check(spun.ok, 'a rack faces somewhere, so it can be turned', spun.error);
  const rackNow = g.fixtureAt(rackAt.x, rackAt.z);
  check(!!rackNow, 'and it is still on the same tile');
  check(rackNow.rot !== rackRot, 'and it is facing somewhere else');
  check(rackNow.useAt.x !== rackSpot.x || rackNow.useAt.z !== rackSpot.z,
    'and the side you pick it from moved with it');
  eq(g.layout.plots.length, g.fixtureCounts().plot, 'turning did not create or destroy a rack');
}

// ---------------------------------------------------------------------------
// 9b. Aim assist, and the difference between a facing nobody chose and one
//     somebody did.
//
// `faceAlong` is the reason building a row of shelving does not mean typing out
// a fact the shop already knows — stand something against a wall and it turns
// its back to the wall. It had no sweep, and every claim it makes is one you
// would only notice by watching a ghost spin: they are assertions about a
// preview, over a whole shop, from four starting angles, which is exactly the
// shape a person cannot check by eye.
//
// The one that earned this section is `keep`. Assist ran on a fixture you had
// PICKED UP, at full strength, so moving a unit two tiles down its own aisle
// re-derived its facing from the tile it landed on — and "re-derived" is only
// the same as "kept" when the new tile happens to agree. It reads as the move
// tool resetting your rotation, which is what it is: a search improving on a
// decision you had already made. A carried unit settles for a facing that WORKS
// now, and only turns when its own would leave nowhere to browse it from.
//
// "Workable" is asked of `canPlace` rather than re-derived here on purpose.
// `faceAlong`'s own predicate is the thing under test, and a sweep that spells
// it out a second time passes whatever the copy does — the edge test in
// particular (a wall is a line between tiles, not a tile) is exactly the part
// anybody re-writing it from memory leaves out.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const L = g.layout;
  const S = L.store;

  /** The warnings that mean "nobody could work or browse this facing". */
  const UNUSABLE = /nothing can use it|faces out of the shop|nowhere to stand behind it|working side is outside/;
  const workable = (kind, x, z, rot, ignoreId = null) => {
    const v = canPlace(L, { kind, x, z, rot }, { ignoreId });
    return v.ok && !UNUSABLE.test(v.warn ?? '');
  };
  /**
   * Is this facing's back against something?
   *
   * The one claim `canPlace` cannot be asked, because a shelf with its back to
   * a wall is the GOOD case and nothing warns about it. Built out of the shop's
   * own vocabulary rather than re-implemented — `tileAt`, `blockedAt`,
   * `insideStore` and `edgeBetween` are each the single spelling of the fact
   * they answer, and the third and fourth are the two a hand-rolled version
   * always leaves out: the far side of the shell wall is ordinary walkable
   * grass, and a wall you drew is a line between two tiles rather than a tile.
   * Leave either out and this sweep fails on shops that are perfectly correct.
   */
  const backed = (kind, x, z, rot, ignoreId = null) => {
    const b = behindTile(x, z, rot);
    const person = WALKABLE.has(tileAt(L, b.x, b.z))
      && !blockedAt(L, b.x, b.z, ignoreId)
      && insideStore(L, b.x, b.z)
      && !SOLID.has(edgeBetween(L, x, z, b.x, b.z));
    return !person;
  };

  const rots = [0, 1, 2, 3];
  let tiles = 0;
  let stuck = 0;       // tiles where nothing works, so nothing is claimed
  let turned = 0;      // times `keep` moved a carried unit at all
  for (let z = S.z; z < S.z + S.h; z++) {
    for (let x = S.x; x < S.x + S.w; x++) {
      if (!canPlace(L, { kind: 'shelf', x, z, rot: 0 }).ok) continue;
      tiles++;
      const anyWorks = rots.some((r) => workable('shelf', x, z, r));
      const anyBacked = rots.some((r) => workable('shelf', x, z, r) && backed('shelf', x, z, r));
      if (!anyWorks) { stuck++; continue; }

      for (const from of rots) {
        const aimed = faceAlong(L, { kind: 'shelf', x, z, rot: from });
        // 1. It never leaves you with a facing nobody can use when one exists.
        check(workable('shelf', x, z, aimed),
          'assist lands on a facing somebody can use', `${x},${z} ${from} -> ${aimed}`);
        // 2. It backs onto a wall whenever any facing could.
        if (anyBacked) {
          check(backed('shelf', x, z, aimed),
            'assist backs onto a wall when one is available', `${x},${z} ${from} -> ${aimed}`);
        }
        // 3. It never spins: its own answer is a fixed point, which is what
        //    makes sliding along a wall stable rather than oscillating.
        eq(faceAlong(L, { kind: 'shelf', x, z, rot: aimed }), aimed,
          'assist settles — its own answer is where it stops');

        // 4. THE claim. A facing that works is a facing you keep.
        const kept = faceAlong(L, { kind: 'shelf', x, z, rot: from }, { keep: true });
        if (workable('shelf', x, z, from)) {
          eq(kept, from, `carrying keeps a workable facing at ${x},${z}`);
        } else {
          turned++;
          // 5. ...and when it does turn, it turns to exactly what assist would
          //    have said. There is one search, not two.
          eq(kept, aimed, `carrying falls back to assist when its own facing is unusable at ${x},${z}`);
        }
      }
    }
  }
  check(tiles > 20, 'the test shop has a floor to sweep', `${tiles} tiles`);
  check(turned > 0,
    'and some facings genuinely had to turn — otherwise claim 4 is vacuous',
    `${turned} of ${tiles * 4}`);
  check(stuck < tiles, 'not every tile is a dead end', `${stuck}/${tiles}`);

  // A till is the exception `faceAlong` names: it is worked from behind, so the
  // bar it settles for is "room on BOTH sides" rather than "backed onto a wall".
  // `keep` has to hold a carried till to that same bar, or moving one against a
  // wall keeps a facing no hire can ever stand at — the one thing on a till that
  // costs you staff rather than shoppers.
  {
    const till = L.checkouts[0];
    check(!!till, 'the shop has a till to carry');
    for (const from of rots) {
      const kept = faceAlong(L, { kind: 'checkout', x: till.x, z: till.z, rot: from }, {
        ignoreId: till.id, keep: true,
      });
      check(workable('checkout', till.x, till.z, kept, till.id)
        || !rots.some((r) => workable('checkout', till.x, till.z, r, till.id)),
        'a carried till keeps only a facing somebody could work',
        `${from} -> ${kept}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 6. The ledger survives a save/restore round trip.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  g.setBuildMode('me', true, 'plot');
  const before = { ...g.fixtureCounts() };
  const spot = findFreeGrass(g);
  check(!!spot, 'there is somewhere to dig a plot');
  const res = g.placeFixture('me', { kind: 'plot', x: spot.x, z: spot.z, rot: 0 });
  check(res.ok, 'digging a new plot works', res.error);
  eq(g.fixtureCounts().plot, before.plot + 1, 'the shop counts one more plot');
  eq(g.layout.plots.length, g.fixtureCounts().plot, 'and the layout matches the count');

  const restored = Game.restore(g.serialize());
  eq(restored.fixtureCounts().plot, g.fixtureCounts().plot, 'the count survives serialisation');
  eq(restored.placements.length, g.placements.length, 'so do the placements');
  restored.regenerateLayout();
  eq(restored.layout.plots.length, g.fixtureCounts().plot, 'and regenerate still honours them');
}

// ---------------------------------------------------------------------------
// 7. Stand to act. Being in range is the whole input; the ring is the window
//    you have to change your mind, and leaving is how you take it.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const plot = g.layout.plots[0];
  stand(g, plot);

  const armed = g.actionFor(g.players.me);
  eq(armed?.kind, 'till', 'standing at a rough plot arms tilling');
  check(!!armed?.at, 'an armed action says where its target is');
  check(armed.at.x === plot.x && armed.at.z === plot.z, 'and points at the right tile');

  // The charge runs on its own, and still takes the full time.
  g.stepActions(0.5);
  eq(plot.soil, 'untilled', 'half way through, nothing has happened yet');
  check(g.players.me.action.elapsed > 0, 'but the charge is already running');

  for (let i = 0; i < 30; i++) g.stepActions(0.1);
  eq(plot.soil, 'tilled', 'standing there through the ring fires it');

  // Walking out of range drops it entirely, part-charged or not. Corner of the
  // map, because the farm is laid out in rows and "twelve tiles east" lands on
  // another plot.
  const rough = g.layout.plots.find((p) => p.soil !== 'tilled' && p !== plot);
  check(!!rough, 'there is a second rough plot to try this on');
  stand(g, rough);
  g.stepActions(0.5);
  check(g.players.me.action.elapsed > 0, 'the next plot starts charging too');
  g.players.me.x = 1;
  g.players.me.z = 1;
  g.stepActions(0.1);
  eq(g.players.me.action, null, 'walking away disarms it');
  eq(rough.soil, 'untilled', 'and the part-charge did nothing');

  // ...and none of it is banked: coming back starts from zero.
  stand(g, rough);
  g.stepActions(0.5);
  eq(rough.soil, 'untilled', 'two half-visits do not add up to one action');
}

// ---------------------------------------------------------------------------
// 7c. Standing on a bed never buys a seed. Everything else proximity fires
//     moves goods that are already yours; sowing is a purchase, and a purchase
//     nobody chose is one you keep making — a bed per bed, down the row.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const plot = g.layout.plots[0];
  const crop = cropFor(g);
  stand(g, plot);
  check(g.till('me', plot.id).ok, 'the bed is turned over');
  g.players.me.selectedCrop = crop.id;

  const cashBefore = g.cash;
  for (let i = 0; i < 60; i++) g.stepActions(0.1);
  eq(g.actionFor(g.players.me), null, 'a turned bed with a seed chosen arms nothing');
  eq(plot.crop_id, null, 'so standing on it plants nothing');
  eq(g.cash, cashBefore, 'and costs nothing');

  // The menu route is the one that sows, and it does the whole job.
  const g2 = fresh();
  const bed = g2.layout.plots[0];
  const seed = cropFor(g2);
  const before2 = g2.cash;
  check(g2.sow('me', bed.id, seed.id).ok, 'tapping the bed and picking a seed sows it');
  eq(bed.crop_id, seed.id, 'the crop you picked is what is growing');
  eq(round2(before2 - g2.cash), round2(seed.seed_cost), 'charged once, for that seed');
}

// ---------------------------------------------------------------------------
// 7d. Nothing goes into or out of your hands for standing there.
//
// The headline claim, and the one that is invisible in a screenshot of any one
// moment: what it looks like is a shop where nothing happened. An aisle is a row
// of shelves on a three-tile pitch, so stopping anywhere in one with an armful
// used to mean one of them took it, and which one was a question about where
// your feet happened to be — carrying stock across your own shop was not a
// thing you could do. The bed is the same objection pointing the other way: a
// harvest you did not ask for fills your hands, and full hands refuse you
// everything else.
//
// Both directions are asserted over six seconds, not one tick, because the ring
// is a second long and a one-tick check would pass against a shop that simply
// had not got round to it yet.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const shelf = g.layout.shelves.find((s) => s.kind !== 'freezer');
  const before = qtyOn(shelf, plainItem.id);
  g.players.me.carry = { item_id: plainItem.id, qty: 3 };
  stand(g, shelf.browseAt);
  for (let i = 0; i < 60; i++) g.stepActions(0.1);
  eq(lotTotal(g.players.me.carry), 3, 'six seconds beside a shelf with an armful shelves nothing');
  eq(qtyOn(shelf, plainItem.id), before, 'and the board is exactly as it was');

  // ...and naming that same shelf is what does it, from where you already are.
  check(g.walkToFixture('me', shelf.id).ok, 'pointing at it is accepted');
  eq(g.actionFor(g.players.me)?.kind, 'stock', 'and that arms the stock');
  g.stepActions(5);
  eq(g.players.me.carry, null, 'which puts the armful on the shelf');

  /**
   * THE BED WAS THE EXCEPTION AND THE RACK IS NOT, WHICH IS THE WHOLE OF THIS.
   *
   * Three claims used to live here and all three were about `auto`: standing on
   * a ripe bed picked it with the button UP, standing NEXT to it did not, and
   * walking over it did not. Every one of them rested on the same sentence —
   * *which bed has an exact answer no aisle of shelves has: the one under your
   * feet* — and the rack took that sentence away by standing up. A plot blocks
   * its cell now, so there is no bed to be standing on and `standingOn` answers
   * false for every rack in the shop for ever.
   *
   * So the claims INVERT, and they have to be asserted rather than deleted: a
   * gesture that quietly went back to firing on its own would strip a whole
   * grow room as you walked down the aisle, which looks exactly like a farm
   * working. What is pinned is that picking is a PRESS, and that pointing at a
   * rack is what arms it — the shelf's rule, said about the farm.
   */
  const plot = g.layout.plots[0];
  const crop = cropFor(g);
  const bedSpot = { x: plot.useAt.x, z: plot.useAt.z };
  stand(g, bedSpot);
  g.till('me', plot.id);
  check(g.plant('me', plot.id, crop.id).ok, 'a rack is sown to pick from');
  plot.ready = true;
  g.players.me.pressing = false;

  // You cannot stand on one at all, which is the premise the rest rests on.
  check(g.layout.blocked[plot.z * g.layout.w + plot.x] === 1,
    'a rack occupies its own cell, so there is nothing to stand on');

  // At the spot you pick from, stopped, nothing pressed — and nothing happens.
  // This is the exact state that used to harvest.
  for (let i = 0; i < 60; i++) g.stepActions(0.1);
  check(plot.ready, 'six seconds at a ripe rack picks nothing on its own');
  eq(g.players.me.carry, null, 'so your hands stay empty');

  // ...and naming it is what does it, from where you already are — which is
  // `walkToFixture` + `errandAction`, the same two calls the shelf above uses.
  check(g.walkToFixture('me', plot.id).ok, 'pointing at the rack is accepted');
  check(!!g.players.me.errand, 'which is an errand, not a walk');
  eq(g.actionFor(g.players.me)?.kind, 'harvest', 'and that arms the harvest');
  g.players.me.pressing = true;
  for (let i = 0; i < 60; i++) g.stepActions(0.1);
  check(!plot.ready, 'and holding the press picks it');
  // Onto the SHOULDER, not into your hands: a crate is `CRATE_UNITS` against
  // six, and a rack gives up to ten, so an armful was one rack and a walk. Empty
  // hands is the condition (you cannot shoulder a box holding loose goods) and
  // the claim is worth pinning because both are legal states to end a harvest
  // in — a change that quietly put it back in your hands would halve the trip
  // again with nothing failing.
  check(lotTotal(g.players.me.haul) > 0, 'straight onto your shoulder as a crate');
  eq(g.players.me.carry, null, 'with your hands still free');

  // And a bed picked with no room left still comes out of the ground: the
  // surplus is a crate at your feet, never nothing. Destroying it is what made
  // the farm a one-bed-per-trip job, and it is the one thing conservation was
  // never asserted about — a yield that vanishes leaves no record anywhere.
  const full = g.layout.plots[1];
  stand(g, full);
  g.till('me', full.id);
  check(g.plant('me', full.id, crop.id).ok, 'a second bed is sown');
  full.ready = true;
  full.yield = 4;
  g.players.me.carry = null;
  g.players.me.carry = { item_id: plainItem.id, qty: g.carryCapacity(g.players.me) };
  const held = lotTotal(g.players.me.carry);
  const inCrates = () => g.deliveries.reduce((n, d) => n + lotQty(d, crop.item_id), 0);
  const crated0 = inCrates();
  const out = g.harvest('me', full.id);
  check(out.ok, 'picking with full hands is not refused');
  eq(lotTotal(g.players.me.carry), held, 'your hands are exactly as they were');
  eq(inCrates() - crated0, 4, 'and all four are in a crate on the ground');

  // ...and a FULL SHOULDER spills the same way. The three destinations are
  // ordered — box, hands, ground — and each one has to hand over what it cannot
  // take, or the overflow is back to being destroyed one step further along.
  const over = g.layout.plots[3];
  stand(g, over);
  g.till('me', over.id);
  check(g.plant('me', over.id, crop.id).ok, 'a fourth bed is sown');
  over.ready = true;
  over.yield = 5;
  g.players.me.carry = null;
  g.players.me.haul = { stacks: [{ item_id: crop.item_id, qty: g.crateCapacity() }] };
  const box = lotTotal(g.players.me.haul);
  const before2 = inCrates();
  check(g.harvest('me', over.id).ok, 'picking with a full crate up is not refused either');
  eq(lotTotal(g.players.me.haul), box, 'the box on your shoulder is untouched');
  eq(lotTotal(g.players.me.carry), 5, 'and it falls through to your hands');
  eq(inCrates() - before2, 0, 'with nothing on the ground while there is a hand free');

  // ...and only when BOTH are full does it go down. Three destinations in order,
  // each handing on what it cannot take — the last one is the ground, and the
  // ground is what stops a yield ever being destroyed again.
  const last = over;                     // the shop has four beds; reuse one
  stand(g, last);
  last.ready = true;
  last.yield = 3;
  g.players.me.carry = { stacks: [{ item_id: plainItem.id, qty: g.carryCapacity(g.players.me) }] };
  const before3 = inCrates();
  check(g.harvest('me', last.id).ok, 'picking with both full is not refused');
  eq(inCrates() - before3, 3, 'and all three are on the ground beside you');
}

// ---------------------------------------------------------------------------
// 7b. Put an armful down in the yard and it stays down. Stowing and picking
//     back up used to re-arm the instant they finished, so with no button to
//     let go of this was a stow and a pickup on a loop until the goods were
//     worn out. Both halves are named now and neither re-arms, so the loop has
//     no way to start — but "no way to start" is exactly the kind of claim that
//     is true until somebody puts one of the halves back on proximity.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const me = g.players.me;
  me.carry = { item_id: anyItem.id, qty: 4 };
  stand(g, g.dropPad());

  const pad = g.dropPad();
  g.walkTo('me', pad.x, pad.z);
  eq(g.actionFor(me)?.kind, 'stow', 'tapping the drop-off with full hands stows');
  g.stepActions(5);
  eq(me.carry, null, 'the goods went down');

  for (let i = 0; i < 200; i++) {
    // A shuffle on the spot, going nowhere — standing on your own crate for
    // twenty seconds. The key is *released* between nudges, and it has to be:
    // an action only charges while you are stopped, and a hand left on a
    // direction is a player walking, which is a decline. Held down, this loop
    // would prove nothing except that steering suppresses actions.
    me.input = { dx: i % 2 ? 1 : -1, dz: 0 };
    g.stepPlayers(0.02);
    me.input = { dx: 0, dz: 0 };
    g.stepActions(0.1);
  }
  eq(me.carry, null, 'and stayed down — nothing filled your hands again');
  eq(g.deliveries.length, 1, 'as exactly one pallet');
  eq(lotTotal(g.deliveries[0]), 4, 'holding all of it');
}

// ---------------------------------------------------------------------------
// 7c. A tap is a walk, and holding something does not change that.
//
//     For four steps it did: with goods in hand, `walkTo` armed a setdown on
//     the tile it walked you to, on the guess that "over there" meant "put it
//     down over there". An errand outranks everything proximity offers — that
//     is the whole scheme — so the guess suppressed every job that fires on its
//     own for as long as your hands were full. What that reads as in play is a
//     till you cannot serve while carrying a crate: the shopper stands there,
//     the shop offers to set the box down, and you put it down first for no
//     reason anybody could name.
//
//     None of it is visible in a screenshot — an armed errand is a label — and
//     the two halves have to be asserted together, because "the tap arms
//     nothing" is only safe while the square still has its own gesture.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const me = g.players.me;
  const till = g.layout.checkouts[0];
  const spot = g.reachSpots(till)[0];

  // Somebody at the front of the queue, and nothing further: this only ever
  // asks what the shop OFFERS, never fires it, so a customer with a basket and
  // a state is the whole of what `actionFor` reads.
  g.customers.c1 = { id: 'c1', state: 'QUEUE', basket: [], mood: 1, till: till.id, x: till.x, z: till.z };
  till.queue = ['c1'];

  stand(g, spot);
  eq(g.actionFor(me)?.kind, 'serve', 'a shopper at the till is a serve');

  me.haul = { stacks: [{ item_id: anyItem.id, qty: 4 }] };
  g.walkTo('me', spot.x, spot.z);
  eq(me.errand, null, 'tapping an ordinary tile with a crate up arms nothing');
  stand(g, spot);
  eq(g.actionFor(me)?.kind, 'serve', '...so the shopper is still served, box and all');

  me.haul = null;
  me.carry = { stacks: [{ item_id: anyItem.id, qty: 4 }] };
  g.walkTo('me', spot.x, spot.z);
  eq(g.actionFor(me)?.kind, 'serve', 'and the same with an armful');

  // ...and build mode is the same claim said the other way. It suspends every
  // other job because every one of them is a question about the pointer, and a
  // shopper at the counter is not: leaving it out is a customer stood there
  // while you put up a wall, waiting for you to find the button that turns
  // building off. Nothing else comes back with it — a shelf in reach still
  // offers nothing, or the mode has stopped being a mode.
  me.carry = null;
  me.errand = null;
  me.build = { on: true, tool: 'shelf' };
  stand(g, spot);
  eq(g.actionFor(me)?.kind, 'serve', 'build mode still takes the payment');
  me.haul = { stacks: [{ item_id: anyItem.id, qty: 4 }] };
  eq(g.actionFor(me)?.kind, 'serve', '...crate and all');
  till.queue = [];
  eq(g.actionFor(me), null, 'and with nobody waiting it offers nothing at all');
  till.queue = ['c1'];
  me.build = { on: false, tool: null };
  me.haul = null;
  me.carry = { stacks: [{ item_id: anyItem.id, qty: 4 }] };

  // ...while the drop-off keeps the meaning it has to keep: it is painted
  // ground with no id, so the tap IS the naming, and there is no other way to
  // say it. Both hands and shoulder, because they answer with different verbs.
  const pad = g.dropPad();
  stand(g, pad);
  g.walkTo('me', pad.x, pad.z);
  eq(g.actionFor(me)?.kind, 'stow', 'tapping the drop-off with full hands still stows');
  me.carry = null;
  me.haul = { stacks: [{ item_id: anyItem.id, qty: 4 }] };
  g.walkTo('me', pad.x, pad.z);
  eq(g.actionFor(me)?.kind, 'setdown', '...and a crate is set down on it');

  // The other half of the tap losing its second meaning: the square is named by
  // a HOLD, which is what the green ghost is drawn on.
  const dropped = g.deliveries.length;
  stand(g, spot);
  check(g.placeAt('me', spot.x, spot.z).ok, 'a square in reach can still be named');
  eq(g.actionFor(me)?.kind, 'setdown', 'and naming it is what offers the setdown');
  g.stepActions(5);
  eq(me.haul, null, 'the crate went down');
  eq(g.deliveries.length - dropped, 1, 'as one pallet on that square');
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
  //
  // A hanging prop is the one exception, and it is not a loophole — it is the
  // same claim measured from the other end. Its origin IS the ceiling, so it is
  // authored downward, and `modelHeight` (which counts up from 0) honestly
  // returns nothing for one. What matters for a pendant is that it hangs *below*
  // the ceiling: art drawn upward from that origin would push through the roof
  // of a building that has no roof, and read as a lamp floating outside the shop.
  //
  // Measured here rather than by calling whatever the renderer calls, so this
  // stays an independent statement about the art rather than an echo of the
  // function under test.
  const lowestPoint = (parts) => Math.min(
    0, ...(parts ?? []).map((p) => (p.pos?.[1] ?? 0) - (p.scale?.[1] ?? 0) / 2),
  );

  for (const fx of c.fixtures ?? []) {
    // Ground is not aimable and must not be: it has no model, because it is not
    // a thing standing in a cell — it *is* the cell. `pickFixture` never returns
    // one and `pickTile` answers for the ground it paints, so "can you click it"
    // is a question about the tile rather than about the piece. Skipped by kind
    // rather than by "has no model", which would quietly excuse a shelf somebody
    // forgot to draw.
    //
    // Every ground kind, not just floor: the yard pads are painted the same way
    // and are just as unaimable, and a check that named floor would start
    // demanding geometry from a delivery bay the day one was authored.
    //
    // ...and paint is the same claim once more, which is why this asks
    // `isSurface` rather than naming the two: a finish is not a thing standing
    // in a cell either — it is half of a wall's own skin, aimed at through the
    // wall (`pickFace`) and never through the piece. A check written against
    // ground alone would start demanding geometry from a tin of emulsion.
    if (isSurface(kindOf(fx))) {
      check(fx.surface?.color != null, `${kindOf(fx)} ${fx.id} says what it is made of`);
      check(fx.model == null, `${kindOf(fx)} ${fx.id} carries no model to draw`);
      continue;
    }
    const rungs = fx.tiers?.length || 1;
    const hangs = kindOf(fx) === 'prop-ceiling';
    for (let tier = 1; tier <= rungs; tier++) {
      const parts = partsAt(fx.model, tierProgress(tier, rungs));
      check(hangs ? lowestPoint(parts) < 0 : modelHeight(parts) > 0,
        `fixture ${fx.id} tier ${tier} has a face to aim at`,
        hangs ? 'a hanging prop is drawn downward from the ceiling' : '');
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
    put(shelf, anyItem, 4);
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
    eq(qtyOn(now), 4, 'with its stock still on it');
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
      put(shelf, perishable, 5, { day: game.day });
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

    check(qtyOn(betterShelf) >= qtyOn(cheapShelf),
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
    put(g.layout.shelves.find((s) => s.id === here.id), anyItem, 6);
    const cash2 = g.cash;
    const styled = g.styleFixture('me', here.id, '');
    check(styled.ok, 'a placed fixture can be restyled', styled.error);
    eq(round2(g.cash), round2(cash2), 'and it is free');
    here = g.fixtureAt(spot.x, spot.z);
    eq(g.fixtureVariant(here), '', 'it changed shape');
    eq(qtyOn(here), 6, 'and kept its stock');

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
// 14. Keeping a shelf for something. A reservation is a decision, not a label.
//
// `item_id` is what happens to be on a shelf and is written by whoever last put
// something there; `assigned` is what somebody decided goes there. Two fields
// rather than one, because they stop agreeing the moment the last carton sells
// — and the entire value of the second is that it survives exactly the events
// that clear the first. Most of what follows is one of those events.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const shelf = g.layout.shelves.find((s) => s.kind !== 'freezer');
  const spare = g.layout.shelves.find((s) => s.kind !== 'freezer' && s.id !== shelf.id);
  const cash0 = g.cash;
  const floor0 = totalOnFloor(g);

  check(g.assignShelf('me', shelf.id, plainItem.id).ok, 'a shelf can be kept for an item');
  eq(keptFor(shelf), plainItem.id, 'and it remembers which');
  eq(qtyOn(shelf), 0, 'keeping it for something puts nothing on it');
  eq(held(shelf), null, 'and labels it with nothing');
  eq(totalOnFloor(g), floor0, 'no goods are conjured');
  eq(g.cash, cash0, 'and it is free');

  check(g.shelfAccepts(shelf, plainItem.id), 'the shelf takes what it is kept for');
  check(!g.shelfAccepts(shelf, otherItem.id), 'and refuses what it is not, while bare');
  // Bare is the case that matters. An *unkept* empty shelf takes anything — a
  // documented rule this one is deliberately the exception to, so both halves
  // have to be asserted or the exception could simply be the rule breaking.
  check(g.shelfAccepts(spare, otherItem.id), 'a shelf nobody kept still takes anything');

  // Your own hands are refused too, and the refusal has to say where to undo
  // it: a shelf that silently rejects you reads as broken rather than reserved.
  stand(g, shelf);
  g.players.me.carry = { item_id: otherItem.id, qty: 3 };
  const pushed = g.stockShelf('me', shelf.id);
  check(!pushed.ok, 'stocking it by hand with something else is refused');
  check(/menu/.test(pushed.error ?? ''), 'and says where to change it', pushed.error);
  eq(lotTotal(g.players.me.carry), 3, 'a refused stocking leaves your hands alone');

  g.players.me.carry = { item_id: plainItem.id, qty: 3 };
  check(g.stockShelf('me', shelf.id).ok, 'what it is kept for goes straight on');
  eq(qtyOn(shelf), 3, 'and lands on it');

  // Selling out. `item_id` was already documented as surviving this; the
  // reservation has to survive everything after it as well.
  shelf.stacks[0].qty = 0;
  check(g.shelfAccepts(shelf, plainItem.id), 'a sold-out shelf still wants the same thing');
  check(!g.shelfAccepts(shelf, otherItem.id), 'and still refuses everything else');

  // Emptying it by hand is the first half of restocking it, so it keeps the
  // reservation and loses only the label.
  put(shelf, plainItem, 4);
  check(g.stripShelf('me', shelf.id).ok, 'a kept shelf can still be emptied');
  eq(held(shelf), null, 'which takes the label off');
  eq(keptFor(shelf), plainItem.id, 'but never forgets what the shelf is for');

  // Handing it back is its own choice, in its own row.
  check(g.assignShelf('me', shelf.id, null).ok, 'it can be handed back to "anything"');
  eq(keptFor(shelf), null, 'and then it is kept for nothing');
  check(g.shelfAccepts(shelf, otherItem.id), 'so it takes anything again');
  check(!g.assignShelf('me', shelf.id, null).ok, 'handing back what nobody kept is refused');

  // A SECOND reservation, which is the whole point of boards. Stock on one
  // board is no longer a reason to refuse another thing — the old rule read
  // "anything is on it", and a shelf that holds three things has to read "every
  // board is taken" instead, or a unit could never be shared at all.
  put(shelf, plainItem, 4);
  const boards = g.shelfBoards(shelf);
  check(boards > 1, 'the shipped shelving has more than one board to share');
  check(g.assignShelf('me', shelf.id, otherItem.id).ok,
    'a spare board can be kept for something else while stock sits on the first');
  eq(qtyOn(shelf, plainItem.id), 4, 'and doing so leaves the first board alone');
  check(g.shelfAccepts(shelf, otherItem.id), 'the shop will now stock the second thing here');
  // The goods you did NOT tick stay where they are and go on selling; what
  // ticking decides is what gets refilled. That is the same thing a leftover
  // label always meant, said about a board.
  check(!g.shelfAccepts(shelf, plainItem.id),
    'while the board nobody ticked is left to sell down rather than topped up');
  stand(g, shelf);
  g.players.me.carry = { item_id: plainItem.id, qty: 2 };
  check(!g.stockShelf('me', shelf.id).ok, 'and your own hands are refused it too');
  eq(qtyOn(shelf, plainItem.id), 4, 'so the board it is selling down is left alone');

  // ...but a board with nothing left ON it is not "selling down", it is a name,
  // a price and a capacity for something the unit has just been told it is not
  // for — and the menu prints it as a board. A live freezer read
  // `Frozen Pizza 0/8` over `Fizzy Soda 0/24`, said 2 of 2 in use, and refused
  // frozen pizza while naming soda, which cannot be read as anything but the
  // shop being wrong about its own shelf. So the press that makes it a lie is
  // the press that takes it back. Both halves, or "empty only" could be the
  // rule quietly eating stock instead.
  const g4 = fresh();
  const kept4 = g4.layout.shelves.find((s) => s.kind !== 'freezer');
  put(kept4, plainItem, 3);
  put(kept4, otherItem, 0);
  eq(g4.shelfStacks(kept4).length, 2, 'a unit with one board selling and one bare');
  check(g4.assignShelf('me', kept4.id, spareItem.id).ok, 'setting it aside for a third thing');
  eq(qtyOn(kept4, plainItem.id), 3, 'leaves goods that are still selling exactly alone');
  eq(qtyOn(kept4, otherItem.id), 0, 'and hands the bare board back');
  check(!g4.shelfStack(kept4, otherItem.id),
    'so the menu stops printing a board the unit will not honour');
  check(g4.shelfHasRoomFor(kept4, anyItem.id), 'and the board it freed is a board again');

  // Capacity is a SHARE, so committing a unit to a second thing halves what
  // each gets rather than doubling what the unit carries. This is the balance
  // claim of the whole change and it is invisible from any screenshot: both
  // shelves look identical, and only the number the stocker fills to has moved.
  //
  // Two shares here, and it takes BOTH halves of the rule to get there: the
  // cheese is ticked and the milk merely standing on it. Counting either alone
  // would say one, and one is a unit that quietly holds twice what it should.
  const g3 = fresh();
  const solo = g3.layout.shelves.find((s) => s.kind !== 'freezer');
  eq(g.shelfShares(shelf), 2, 'a ticked thing and an untouched one are two shares');
  eq(g.shelfCapacity(shelf, plainItem),
    Math.max(1, Math.floor(g3.shelfCapacity(solo, plainItem) / 2)),
    'so each gets half of what a unit holding one thing got');

  // Relabelling with every board taken still refuses, which is the rule the
  // one-item version was really protecting: a reservation nothing can honour
  // until you empty the thing is a shelf that sits there never being filled.
  const third = warm[2] ?? null;
  if (third && boards >= 2) {
    const full = g.layout.shelves.find((s) => s.kind !== 'freezer' && s.id !== shelf.id
      && s.id !== spare.id);
    if (full) {
      for (let b = 0; b < boards; b++) {
        const it = warm[b % warm.length];
        put(full, it, 1);
      }
      eq(full.stacks.length, Math.min(boards, warm.length), 'every board on it is taken');
      const spill = warm.find((it) => !full.stacks.some((k) => k.item_id === it.id));
      if (spill) {
        check(!g.assignShelf('me', full.id, spill.id).ok,
          'you cannot keep a unit for something when every board is full');
      }
    }
  }
  check(g.assignShelf('me', shelf.id, plainItem.id).ok,
    'but you can name what is already on it');

  // The freezer rule is the *staff* rule, not the looser one hands get: a
  // reservation nobody can carry out just leaves the shelf empty for ever.
  if (frozenItem) {
    const freezer = g.layout.shelves.find((s) => s.kind === 'freezer');
    check(!g.assignShelf('me', spare.id, frozenItem.id).ok,
      'frozen goods cannot be kept on a warm shelf');
    check(g.assignShelf('me', freezer.id, frozenItem.id).ok,
      'but can be kept in a freezer');
    check(!g.assignShelf('me', freezer.id, plainItem.id).ok,
      'and a freezer is not kept for something that does not need freezing');
  }
}

// ---------------------------------------------------------------------------
// 14b. ...and the people you employ believe in it too.
//
// `shelfFor` in staff.js is a second implementation of "where may this go".
// Two rules that disagree are invisible from any screenshot: the shelf you set
// aside this morning is simply full of something else tonight, filled by
// somebody you pay.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const kept = g.layout.shelves.find((s) => s.kind !== 'freezer');
  g.assignShelf('me', kept.id, plainItem.id);

  check(shelfFor(g, otherItem.id, c)?.id !== kept.id,
    'a stocker never puts anything else on a kept shelf');
  eq(shelfFor(g, plainItem.id, c)?.id, kept.id,
    'and takes what it is kept for straight to it, ahead of every bare one');
}

// ---------------------------------------------------------------------------
// 14c. Which shelf the next van fills.
//
// Priority sorts before emptiness rather than adjusting it, so the assertions
// deliberately put the marked shelf on the wrong side of the emptiness test:
// "first" is the fullest shelf in the queue and "last" is the barest. Sorted by
// how empty they are, both would land at the opposite end.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const shelves = g.layout.shelves;
  for (const s of shelves) put(s, plainItem, 1);

  const first = shelves[shelves.length - 1];
  const last = shelves[0];
  put(first, plainItem, 2);
  put(last, plainItem, 0);
  check(g.setRestockPriority(first.id, 1).ok, 'a shelf can be marked to fill first');
  check(g.setRestockPriority(last.id, -1).ok, 'and another to fill last');

  const queue = g.restockQueue();
  eq(queue.length, shelves.length, 'every thin shelf is in the queue');
  eq(queue[0].id, first.id, 'the marked one is filled first, fuller than the rest');
  eq(queue[queue.length - 1].id, last.id, 'and the one marked last goes to the back, bare');

  // Three steps, whatever gets sent. A number nobody can type is a number
  // nothing has to defend against later.
  g.setRestockPriority(first.id, 7);
  eq(first.priority, 1, 'anything above the top step clamps to it');
  g.setRestockPriority(first.id, -12);
  eq(first.priority, -1, 'and anything below the bottom one clamps to that');
  g.setRestockPriority(first.id, 'nonsense');
  eq(first.priority, 0, 'and nonsense is the middle step, not a crash');

  // A shelf with plenty on it is not in the queue at all, marked or not.
  g.setRestockPriority(first.id, 1);
  put(first, plainItem, 99);
  check(!g.restockQueue().some((s) => s.id === first.id),
    'a full shelf is not queued however eagerly it is marked');

  // A board you ASKED for beats a bare shelf nobody mentioned.
  //
  // Both read as "empty", so sorting on emptiness alone made them tie — and a
  // tie goes to whatever order the shelves happen to sit in the layout. Measured
  // on the shipped six-shelf shop: a shelf kept for two things sat sixth in the
  // queue and waited 3,880 ticks and eight other vans before the shop bought it
  // anything. What you see in the game is ticking a box and nothing happening,
  // which reads as the box being broken rather than as a queue position.
  //
  // `shelfFor` has always known this rule — it decides where a case ALREADY in
  // the building goes. This is the same rule one step earlier, about what the
  // shop chooses to buy, and nothing was applying it there.
  {
    const g2 = fresh();
    const bare = g2.layout.shelves.filter((s) => s.kind !== 'freezer');
    const asked = bare[bare.length - 1];
    check(g2.assignShelf('me', asked.id, plainItem.id, true).ok, 'the last shelf is kept for something');
    const queue = g2.restockQueue();
    eq(queue[0]?.id, asked.id,
      'a shelf kept for something it has not got is bought for first');
    check(queue.length > 1, 'and the bare ones nobody asked for are still in the queue behind it');

    // …and it holds even when the unit is otherwise well stocked, or ticking a
    // third thing onto a full shelf would never be acted on at all.
    const busy = bare[0];
    put(busy, plainItem, 99);
    check(!g2.restockQueue().some((s) => s.id === busy.id), 'a full shelf is not in the queue');
    check(g2.assignShelf('me', busy.id, otherItem.id, true).ok, 'until you ask it for something else');
    check(g2.restockQueue().some((s) => s.id === busy.id),
      'and then it is, however full its other boards are');
  }

  // The client draws this menu off the snapshot, so both fields have to be in
  // it — reading them off the layout would show a shelf you set aside ten
  // seconds ago as still taking anything.
  const snap = g.snapshot().shelves.find((s) => s.id === last.id);
  eq(snap.priority, -1, 'the snapshot carries where a shelf sits in the queue');
  g.assignShelf('me', last.id, plainItem.id);
  eq(keptFor(g.snapshot().shelves.find((s) => s.id === last.id)), plainItem.id,
    'and what it is kept for');
}

// ---------------------------------------------------------------------------
// 14d. Both survive everything that rebuilds the shop under them.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const kept = g.layout.shelves.find((s) => s.kind !== 'freezer');
  const { x, z } = kept;
  g.assignShelf('me', kept.id, plainItem.id);
  g.setRestockPriority(kept.id, 1);

  g.regenerateLayout();
  const after = g.layout.shelves.find((s) => s.x === x && s.z === z);
  eq(keptFor(after), plainItem.id, 'a re-flow carries what a shelf is kept for');
  eq(after?.priority, 1, 'and where it sits in the queue');

  const restored = Game.restore(g.serialize());
  restored.regenerateLayout();
  const back = restored.layout.shelves.find((s) => s.x === x && s.z === z);
  eq(keptFor(back), plainItem.id, 'and so does a save/restore round trip');
  eq(back?.priority, 1, 'with the queue position intact');

  // The cold path is a different one: a server restart rebuilds the shelves
  // from nothing and pours the saved contents back in. A bare shelf carries no
  // stock rows, which is exactly why a reservation on one has to be saved.
  const cold = fresh();
  const target = cold.layout.shelves.find((s) => s.kind !== 'freezer');
  cold.restoreContents([{
    id: target.id, item_id: null, qty: 0, price: 0, stockedDay: 0,
    assigned: plainItem.id, priority: -1,
  }], []);
  eq(keptFor(target), plainItem.id, 'a cold restart puts the reservation back');
  eq(target.priority, -1, 'and the queue position with it');

  // A re-flow can land a shelf's contents on a different unit. A reservation
  // that ends up on the wrong kind of one is dropped — but dropping it must
  // never cost the goods, which is why it is a sweep afterwards rather than
  // another clause in the compatibility test that skips the whole row.
  if (frozenItem) {
    const g2 = fresh();
    const warm = g2.layout.shelves.find((s) => s.kind !== 'freezer');
    const at = { x: warm.x, z: warm.z };
    warm.assigned = [frozenItem.id];
    put(warm, plainItem, 3);
    g2.regenerateLayout();
    const now = g2.layout.shelves.find((s) => s.x === at.x && s.z === at.z);
    eq(keptFor(now), null, 'a reservation on the wrong kind of unit is dropped');
    eq(qtyOn(now), 3, 'and dropping it never takes the goods with it');
  }
}

// ---------------------------------------------------------------------------
// A thing you were WARNED about still exists a tick later.
//
// This is a regression, and it was a nasty one because the money came back:
// `canPlace` says `ok: true` with a `warn` for every consequence you are
// allowed to cause, `placeFixture` honours that and charges you — and then the
// generator re-judged the same placement with the strict variant, which reads a
// warning as a refusal, and dropped it on the very next re-flow. Full refund,
// no error, and a shelf that vanished as you turned it.
//
// So the assertion is not "can you place it" — that always passed. It is that
// the thing is still standing in the shop AFTER the re-flow the placement
// itself triggers. Rotation gets its own case because `rotateFixture` settles
// for a warned facing when all three are warned, which is exactly what a unit
// in a corner has, and that is how this was found.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  g.setBuildMode('me', true, 'shelf');
  const L = g.layout;

  // A corner of the shop, facing the wall: legal, useless, and warned about.
  const spec = { kind: 'shelf', x: L.store.x, z: L.store.z, rot: 2 };
  const verdict = canPlace(g.layout, spec);
  check(verdict.ok && !!verdict.warn,
    'a shelf facing out of the shop is allowed, with a warning',
    JSON.stringify(verdict));

  const placed = g.placeFixture('me', spec);
  check(placed.ok, 'and it can be built', placed.error ?? '');
  check(!!placed.warn, 'and the warning comes back with it');
  eq((g.layout.droppedPlacements ?? []).length, 0,
    'and the re-flow it triggers drops nothing');
  check(!!g.layout.shelves.find((s) => s.id === placed.placed),
    'and it is still standing there afterwards — this is the regression');

  // The same claim across a turn, which is the shape the bug was reported in.
  const turned = g.rotateFixture('me', placed.placed, 1);
  check(turned.ok, 'a warned shelf can be rotated', turned.error ?? '');
  check(!!g.layout.shelves.find((s) => s.id === turned.rotated),
    'and survives the turn rather than disappearing');
  eq(g.layout.shelves.length, L.shelves.length + 1,
    'with the shop one shelf up on where it started, not back where it was');

  // ...and the strict variant still refuses it, because the generator and the
  // balance bot do have to. Two answers, and this is what keeps them two.
  check(!canPlaceCleanly(g.layout, spec).ok,
    'while the strict variant still says no — that is the caller that cannot accept a warning');
}

// ---------------------------------------------------------------------------
// Rotate reaches all four angles, including in a corner.
//
// The second half of the same bug, and the one you actually feel. `rotate` used
// to skip ahead to the first facing that drew no warning, which was sane while
// a warned facing was fatal — and meant that in a corner, where nearly every
// facing is warned, it found the same one or two clean angles and cycled
// between them forever. Measured before the fix: six presses gave 1, 0, 1, 0,
// 1, 0. Half the angles were unreachable, and from the outside that reads as a
// shelf refusing to turn the way you are asking rather than as a rule.
//
// Asserted as the SEQUENCE rather than as a set, because "can it reach rot 2"
// would pass on a tool that jumps straight there — and one quarter turn per
// press is the thing being claimed.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  g.setBuildMode('me', true, 'shelf');
  const L = g.layout;
  // A corner: the browsing spot is against a wall on most facings, so most
  // facings warn. That is what made this reachable-in-theory only.
  let id = g.placeFixture('me', { kind: 'shelf', x: L.store.x, z: L.store.z, rot: 0 }).placed;
  check(!!id, 'a shelf goes in the corner');

  const forward = [];
  for (let i = 0; i < 5; i++) {
    const r = g.rotateFixture('me', id, 1);
    if (!r.ok) { forward.push(`ERR ${r.error}`); break; }
    id = r.rotated;
    forward.push(r.rot);
  }
  eq(forward.join(','), '1,2,3,0,1', 'rotating turns one quarter at a time, all the way round');

  const back = [];
  for (let i = 0; i < 4; i++) {
    const r = g.rotateFixture('me', id, -1);
    if (!r.ok) { back.push(`ERR ${r.error}`); break; }
    id = r.rotated;
    back.push(r.rot);
  }
  eq(back.join(','), '0,3,2,1', 'and the other way is the same four angles in reverse');

  check(!!g.layout.shelves.find((s) => s.id === id),
    'and the shelf is still standing after nine turns');
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

// ---------------------------------------------------------------------------
// Back of house: the same unit, hidden from shoppers.
//
// Every claim here is a negative, which is why it needs a sweep. Two shelves of
// one design differ only by this flag, nothing about the model shows it, and
// the failure mode — customers browsing your kitchen, or a pantry quietly
// rejoining the shop floor when you turn it — looks exactly like working
// software until you notice the stock going somewhere you did not put it.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  // Every build verb gates on build mode — the menu press carries it in, and a
  // sweep driving the verbs directly has to say so too.
  g.players.me.build = { on: true };
  const shelf = g.layout.shelves.find((s) => s.kind === 'shelf');
  const total = g.layout.shelves.length;
  eq(shelf.boh, false, 'shelving starts on the shop floor');

  const on = g.setBackOfHouse('me', shelf.id, true);
  check(on.ok, 'a shelf can be moved to the back', on.error ?? '');
  const back = g.layout.shelves.find((s) => s.id === shelf.id);
  eq(back.boh, true, 'and reads back as back-of-house');
  eq(g.layout.shelves.length, total, 'without adding or losing a unit');
  check(!!back.browseAt, 'it is still a shelf with a working spot — staff use it');

  // The one thing it is FOR. Filtered in `chooseShelf`, which is the single
  // gate every shopping decision passes through: filter anywhere else and a
  // customer can want something they are unable to walk to.
  eq(g.layout.shelves.filter((s) => !s.boh).length, total - 1,
    'and shoppers are offered one fewer shelf');

  // Turning it must not put it back out front. Rotation mints a NEW id, which
  // is exactly how a carried flag gets dropped.
  const rot = g.rotateFixture('me', shelf.id, 1);
  const turned = g.layout.shelves.find((s) => s.id === (rot.rotated ?? shelf.id));
  eq(turned?.boh, true, 'turning it leaves it in the back');

  // ...and back again, or one misplaced tap costs you the unit.
  const off = g.setBackOfHouse('me', turned.id, false);
  check(off.ok, 'and it comes back out front', off.error ?? '');
  eq(g.layout.shelves.find((s) => s.id === turned.id)?.boh, false, 'onto the shop floor');

  // It means one thing only, so it is refused where that thing is meaningless.
  const till = g.setBackOfHouse('me', g.layout.checkouts[0].id, true);
  check(!till.ok, 'a till cannot be back of house — it has no shoppers to hide from');
}

// ---------------------------------------------------------------------------
// N. Leaving — the last way goods could be destroyed.
//
// Every other case here is somebody choosing to put something down. This one
// is nobody choosing anything: identity is `client.sessionId`, minted per
// *connection*, so `removePlayer` deleted the whole person and `carry` went
// with them. A devMode restart, a closed tab or four seconds of bad wifi
// destroyed an armful of paid-for stock, silently — and it is invisible in
// development for the obvious reason that nobody's localhost drops.
//
// Asserted as conservation rather than as "the crate exists", because that is
// the claim: the shop holds the same number of units before and after, and the
// difference is standing on the floor. See docs/shipping.md, step 2.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const before = totalOnFloor(g, anyItem.id);

  Object.assign(g.players.me, { x: 9, z: 6, carry: { item_id: anyItem.id, qty: 5 } });
  g.removePlayer('me');
  eq(totalOnFloor(g, anyItem.id), before + 5, 'leaving puts your armful on the floor rather than deleting it');
  check(g.deliveries.some((d) => Math.round(d.x) === 9 && Math.round(d.z) === 6),
    'and it lands where you were standing, not at the bay');
  check(!g.players.me, 'and you are gone');

  // The other half, which a `dropGoods` with no guard gets wrong by conjuring a
  // crate of nothing: most people leave with their hands empty.
  const empty = fresh();
  const floor0 = empty.deliveries.length;
  empty.removePlayer('me');
  eq(empty.deliveries.length, floor0, 'leaving empty-handed conjures nothing');
}

// ---------------------------------------------------------------------------
// Carrying a whole crate — haulage, and the conservation hole it opens.
//
// A crate stopped being an armful the day you could pick one up: `crateCapacity`
// is its own number now, and it has to be, or hauling moves exactly what your
// hands move and there is no decision on either side of it.
//
// Everything here is a conservation claim wearing a different hat. `haul` is a
// SECOND place goods can be, beside `carry`, and every route that used to
// account for hands had to learn about shoulders — leaving, being fired, being
// saved. Each of those is a place stock could silently stop existing, and none
// of them is visible in play: you would notice a shop was poorer some time
// later and have no way at all to connect it to a reload.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const cap = g.crateCapacity();
  const hands = g.carryCapacity();

  check(cap > hands, 'a crate holds more than a pair of hands, or hauling is ceremony',
    `crate ${cap}, hands ${hands}`);

  g.deliveries = [];
  g.dropGoods(anyItem.id, cap, g.dropPad());
  const crate = g.deliveries[0];
  eq(lotTotal(crate), cap, 'a full crate is standing at the drop-off');

  // Lifting takes the crate OUT of the world and puts it on a person. Both
  // halves matter: a lift that left the crate behind would duplicate the stock,
  // which is the more expensive direction of the same bug.
  stand(g, crate);
  check(g.liftCrate('me', crate.id).ok, 'the whole crate can be picked up');
  eq(lotTotal(g.players.me.haul), cap, 'and all of it is on your shoulder');
  eq(g.players.me.carry, null, 'with your hands still empty');
  eq(totalOnFloor(g, anyItem.id), 0, 'and nothing left standing where it was');

  // Hands are the price. Everything that needs them refuses while you have a
  // box, and that is a rule rather than a coincidence — `liftCrate` and every
  // reader of `carry` stay disjoint on purpose.
  check(!g.liftCrate('me', crate.id).ok, 'you cannot pick up a second crate');
  const sh = g.layout.shelves.find((x) => x.kind !== 'freezer');
  stand(g, sh.browseAt);
  check(!g.stockShelf('me', sh.id).ok, 'and you cannot stock a shelf off your shoulder');
  eq(lotTotal(g.players.me.haul), cap, 'the refusal costs you nothing');

  // Setting down is the same object arriving on the floor, at the tile you are
  // standing on — anywhere walkable, not the drop-off. A crate is already a
  // thing that stands on the ground, so making the pad the only legal answer
  // would mean hauling could only ever move a crate between two pads.
  const put = g.dropCrate('me');
  check(put.ok, 'and it can be set down anywhere you can stand', put.error ?? '');
  eq(g.players.me.haul, null, 'which clears your shoulder');
  eq(totalOnFloor(g, anyItem.id), cap, 'and every unit is back on the floor');
  check(g.deliveries.some((d) => Math.round(d.x) === Math.round(g.players.me.x)
    && Math.round(d.z) === Math.round(g.players.me.z)),
    'where you were standing, rather than back at the yard');

  // Conservation across a disconnect. `removePlayer` learned about `carry` the
  // hard way — a closed tab used to bin an armful — and a crate is twice the
  // stock, through a field that did not exist when that was fixed.
  const gone = fresh();
  gone.deliveries = [];
  Object.assign(gone.players.me, { x: 9, z: 6, haul: { item_id: anyItem.id, qty: cap } });
  gone.removePlayer('me');
  eq(totalOnFloor(gone, anyItem.id), cap, 'leaving with a crate puts it on the floor, not into nothing');
  check(!gone.players.me, 'and you are gone');

  // ...and across a restart, for a hire. `saveState` is exactly what `persist`
  // writes and what a cold start reads, so going through it is the whole trip —
  // and this is the half nobody would ever catch by playing, because what you
  // would see is a shop that is quietly poorer than it was last night.
  const kind = c.workers[0];
  if (kind) {
    const saved = fresh();
    saved.cash = 50000;
    check(saved.hire(kind.id).ok, 'a hire can be taken on');
    saved.step(0.1);
    const body = Object.values(saved.players).find((p) => p.staff);
    check(!!body, 'and has a body');
    if (body) {
      body.haul = { item_id: anyItem.id, qty: cap };
      const row = (saved.saveState().staffAt ?? []).find((r) => r.id === body.id);
      eq(lotTotal(row?.haul), cap, 'the save carries the crate on their shoulder');

      const back = fresh();
      back.cash = 50000;
      back.hire(kind.id);
      back.step(0.1);
      const there = Object.values(back.players).find((p) => p.staff);
      back.restoreStaff([{ ...row, id: there?.id }]);
      eq(lotTotal(there?.haul), cap, 'and a shop read back off it is still carrying it');
    }
  }
}

// ---------------------------------------------------------------------------
// Nothing happens until you press. The consent the ring never actually asked for.
//
// `moving` stopped a walk-PAST firing an action, and could never stop a walk
// *to*: every route this game plans ends stopped at the working spot, so
// arriving anywhere was arriving armed and a second later the thing happened.
// Standing at a ripe bed picked it; standing at a rough bed turned it over.
//
// Both halves, because "it does not fire" passes on a game where nothing works
// at all — which is exactly what a sweep that forgot to press would report.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const plot = g.layout.plots[0];
  check(!!plot, 'the shop has a bed');
  plot.crop_id = null;
  plot.soil = 'turf';
  stand(g, plot);

  // The button up. This is the exact situation that used to till the bed.
  g.players.me.pressing = false;
  const soil0 = plot.soil;
  g.stepActions(5);
  eq(plot.soil, soil0, 'standing at a rough bed with the button up turns nothing over');
  eq(g.players.me.action?.elapsed ?? 0, 0, 'and the ring never leaves zero');
  // It is still ARMED, though, and that distinction is the whole design: the
  // prompt has to say what a press would do, or the shop stops telling you what
  // is possible and you are back to guessing.
  eq(g.players.me.action?.kind, 'till', 'while still naming what a press would do');

  // ...and the same second with it down.
  g.players.me.pressing = true;
  g.stepActions(5);
  eq(plot.soil, 'tilled', 'and pressing turns it over');

  // Letting go resets rather than banks — otherwise a rapid tap-tap-tap is the
  // auto-fire this replaced, wearing a faster hat.
  const g2 = fresh();
  const bed = g2.layout.plots[0];
  bed.crop_id = null;
  bed.soil = 'turf';
  stand(g2, bed);
  for (let i = 0; i < 20; i++) {
    g2.players.me.pressing = true;
    g2.stepActions(0.4);            // most of a charge, never all of it
    g2.players.me.pressing = false;
    g2.stepActions(0.1);
  }
  eq(bed.soil, 'turf', 'twenty part-presses add up to nothing');
}

// ---------------------------------------------------------------------------
// Rummaging: one unit out, one unit back, and the direction is said not guessed.
//
// The hole the haul opened. Once empty hands always meant "lift the whole
// crate", there was no gesture left that could START an armful — you could move
// a crate around the shop and never get anything out of it. A tap is the unit,
// a hold is the box, and the pile menu is the armful in between.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  g.deliveries = [];
  g.dropGoods(anyItem.id, 5, g.dropPad());
  const crate = g.deliveries[0];
  stand(g, crate);

  check(g.tapCrate('me', crate.id).ok, 'a tap takes one out');
  eq(lotTotal(g.players.me.carry), 1, 'exactly one, not an armful');
  eq(lotTotal(crate), 4, 'and the crate is one lighter');

  check(g.tapCrate('me', crate.id).ok, 'tapping again takes another');
  eq(lotTotal(g.players.me.carry), 2, 'onto the same pile in your hands');

  // Direction is SAID. Inferring it from your hands makes the same press mean
  // opposite things depending on state you are not looking at — so rummaging
  // through a crate of what you are already carrying would quietly unload you
  // into it, which is the bug this signature exists to make impossible.
  check(g.tapCrate('me', crate.id, true).ok, 'right puts one back');
  eq(lotTotal(g.players.me.carry), 1, 'out of your hands');
  eq(lotTotal(crate), 4, 'and into the crate');

  // Conservation over the whole exchange, which is the claim under all of it.
  eq(totalOnFloor(g, anyItem.id) + (lotTotal(g.players.me.carry)), 5,
    'nothing is created or lost rummaging');

  // The refusals, and they moved. A crate used to hold one kind, so anything
  // else bounced; a crate holds `LOT_KINDS` now, so the wrong thing goes IN —
  // which is the feature — and what bounces is the (kinds + 1)th. Asserting
  // the old rule here would have passed for as long as nobody authored a
  // second kind into a box, which is exactly the trap `verify:catalog` was
  // written about for pieces.
  const other = warm.find((i) => i.id !== anyItem.id);
  if (other) {
    g.players.me.carry = { item_id: other.id, qty: 2 };
    check(g.tapCrate('me', crate.id, true).ok, 'a second kind goes into the box');
    eq(lotStacks(crate).length, 2, 'and the box is holding both');
    eq(lotQty(g.players.me.carry, other.id), 1, 'one unit out of your hands');

    // ...and the cap is real. Fill the box to its kinds and the next one has
    // nowhere to go — without this, one crate absorbs the whole yard and how
    // big you painted the pad stops meaning anything.
    const spare = warm.filter((i) => i.id !== anyItem.id && i.id !== other.id);
    for (const it of spare.slice(0, LOT_KINDS)) {
      g.players.me.carry = { item_id: it.id, qty: 1 };
      g.tapCrate('me', crate.id, true);
    }
    eq(lotStacks(crate).length, Math.min(LOT_KINDS, 2 + spare.length),
      'a crate never holds more kinds than it has room for');

    // A kind the full box has never seen bounces, and bounces without costing
    // you what you are holding. That last half is the one worth asserting: a
    // refusal that took the unit anyway is a conservation hole, and it looks
    // exactly like a refusal that worked.
    const late = warm.find((i) => !lotHas(crate, i.id));
    if (late) {
      g.players.me.carry = { item_id: late.id, qty: 2 };
      check(!g.tapCrate('me', crate.id, true).ok, 'a kind too many bounces');
      eq(lotQty(g.players.me.carry, late.id), 2, 'and a refusal costs you nothing');
    }
  }

  // A tap SPENDS the lift the press armed on the way down. Without this, the
  // errand sits there and the next thing you hold near this crate shoulders it
  // instead — the press and the tap are one gesture on the client, so the
  // server has to treat the second as replacing the first.
  {
    const g3 = fresh();
    g3.deliveries = [];
    g3.dropGoods(anyItem.id, 5, g3.dropPad());
    const box = g3.deliveries[0];
    stand(g3, box);
    check(g3.take('me', { palletId: box.id }).ok, 'a press names the crate');
    eq(g3.actionFor(g3.players.me)?.kind, 'lift', 'which arms the lift');
    check(g3.tapCrate('me', box.id).ok, 'and a quick tap rummages instead');
    eq(g3.players.me.errand, null, 'spending the errand');
    eq(g3.actionFor(g3.players.me), null, 'so nothing is left armed to shoulder it');

    // ...and a press on a box you could already touch does not MOVE you, which
    // is the half that cannot be seen in a still frame: a hire shuffled one tile
    // and a hire stood still are the same picture a second later, and the box is
    // in your hands either way.
    //
    // The diagonal is the case, and it is the common one — `beside` answers with
    // the four sides, so from a corner you are well inside `UNLOAD_REACH` and
    // every tile on that list is a step away. Its pair is a crate whose sides are
    // all taken, where the only tile left on the list is the crate's OWN, so the
    // walk parked you on top of the thing you came to pick up.
    Object.assign(g3.players.me, { carry: null, haul: null, errand: null });
    stand(g3, { x: box.x - 1, z: box.z - 1 });
    const from = { x: g3.players.me.x, z: g3.players.me.z };
    check(g3.take('me', { palletId: box.id }).ok, 'a press from the diagonal is accepted');
    eq(g3.players.me.path, null, 'and plans no walk at all');
    eq(g3.players.me.x, from.x, 'leaving you where you stood (x)');
    eq(g3.players.me.z, from.z, '...and z');
    eq(g3.actionFor(g3.players.me)?.kind, 'lift', 'with the lift armed from there');

    // Out of reach is still a walk, or the fix above is "a crate can be lifted
    // from across the shop" wearing a turn.
    Object.assign(g3.players.me, { errand: null });
    stand(g3, { x: box.x + 4, z: box.z });
    check(g3.take('me', { palletId: box.id }).ok, 'a press from across the shop is accepted');
    check(g3.players.me.path?.length > 0, 'and that one sets off to get it');
  }

  // A crate you are holding is not a crate you can rummage in.
  g.players.me.carry = null;
  check(g.liftCrate('me', crate.id).ok, 'the crate can be lifted');
  check(!g.tapCrate('me', crate.id).ok, 'and cannot be rummaged while you are carrying it');
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
