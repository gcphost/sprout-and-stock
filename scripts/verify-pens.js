#!/usr/bin/env node
/**
 * VERIFY: AN ANIMAL IS A BUILDING, AND IT FILLS UP AND STOPS.
 *
 * Every claim in this file is invisible twice over. A pen that is filling and a
 * pen that stalled hours ago are the same still frame; a pen you collected and
 * a pen that quietly reset itself are the same empty gateway; and the shop is
 * the same shop afterwards either way. Only the clock moved.
 *
 * Its control is the one assertion that decides whether any of this is opt-in:
 * a shop that has never bought a pen must be the old game to the digit — an
 * empty list, no tick, no save row — because every shop in existence is one of
 * those. Its second control is a piece with no `produces`, which is what every
 * fixture row ever authored looks like, and which must never fill.
 *
 * The centrepiece is that filling **stops**. An animal that banked batches all
 * night would make `capacity_mult` worth nothing and the collecting trip worth
 * nothing with it — you would come back in the morning to whatever the maths
 * said and never have to think about a pen again. The pair to it is that a full
 * pen is not secretly running: collect at noon after a pen has stood full since
 * dawn, and the next batch is a whole batch away, not due that second.
 *
 * Then the four traps CLAUDE.md already names, each aimed at this feature:
 *
 * - **R.** `repositionFixture` NAMES every field it keeps, and a pen's contents
 *   are not among them — they live on the layout record and ride a re-flow
 *   through `carryOver`, the way a bed's crop does. Turn a pen and the eggs must
 *   still be there, or the press reads as broken.
 * - **A re-flow.** Build mode re-flows on every wall segment of a drag.
 * - **`elapsed` restarts at zero on every load**, so a clock saved raw puts the
 *   batch in the future and the farm never produces again.
 * - **Out and back are two different pieces of code.** `saveState` writing a
 *   field is half of it; `Game.create` naming it is the half that shipped
 *   missing for five steps when `paint` did it.
 *
 * Plus conservation, because collecting is a new place goods move between and
 * every one of those in this game has been a hole.
 *
 * Runs on ephemeral Games, so it never touches the live shop. It writes two
 * pieces and one item into the content database — usually the live shared one —
 * and removes them on exit, the way `verify:till` and `verify:catalog` do.
 *
 *   node scripts/verify-pens.js
 */

import { Game } from '../server/sim/index.js';
import { silenceMilestones } from '../server/sim/goals.js';
import { content, writeContent } from '../server/content.js';
import { remove, insertWorldRow, worldRow, deleteWorldRow } from '../server/db.js';
import { canPlace, canPlaceCleanly, insideStore } from '../shared/build.js';
import { WALKABLE } from '../shared/tiles.js';
import { lotQty, lotTotal } from '../shared/lot.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const near = (a, b, label, tol = 0.02) => check(Math.abs(a - b) <= tol, label, `expected ~${b}, got ${a}`);

// ---------------------------------------------------------------------------
// The content this sweep owns
// ---------------------------------------------------------------------------

const ITEM = 'zz-pen-egg';
const PIECE = 'zz-pen-coop';
const BARE = 'zz-pen-bare';

/**
 * Deliberately odd numbers, for `verify:economy`'s reason: 5 a batch every 3
 * minutes against a x2 rung is arithmetic you can assert, where the shipped
 * rows are a balance decision this file has no opinion about and must not start
 * failing over.
 */
const BATCH = 5;
// ONE in-game minute, which is the floor the schema puts on `every` and is 60
// of `elapsed`. Small enough that the two sections which have to tick the clock
// for real — the roof and the crew — can afford to, and every other section
// skips it outright.
const EVERY = 1;
const FAST = 2;
const ROOM = 3;

const TEST_ITEM = {
  id: ITEM,
  name: 'Verify Egg',
  base_price: 2,
  base_cost: 1,
  // No behaviour tags at all. A pen's goods have to be shelvable somewhere for
  // the staff section below, and `needs-freezer` would make that a question
  // about what this shop happens to own.
  tags: ['pantry', 'cheap'],
  model: { parts: [{ shape: 'sphere', color: '#f6efdc', pos: [0, 0.05, 0], scale: [0.1, 0.12, 0.1] }] },
};

const box = { shape: 'box', color: '#a85a3a', pos: [0, 0.3, 0], scale: [0.6, 0.6, 0.6] };

const TEST_PEN = {
  id: PIECE,
  kind: 'pen',
  name: 'Verify Coop',
  cost: 0,
  produces: { item_id: ITEM, qty: BATCH, every: EVERY },
  model: { parts: [box] },
  tiers: [
    { name: 'Basic', cost: 0 },
    { name: 'Better', cost: 0, capacity_mult: ROOM, speed_mult: FAST },
  ],
};

/**
 * ...and a pen with nothing in it, which is what every fixture row in the game
 * looks like today.
 *
 * The control that decides whether `produces` is opt-in. Without it "a pen
 * fills" is satisfied by a `stepPens` that fills anything it is handed, and the
 * day somebody authors a shelf the shop starts printing whatever the `??`
 * happened to default to.
 */
const TEST_BARE = {
  id: BARE, kind: 'pen', name: 'Verify Empty Pen', cost: 0, model: { parts: [box] },
};

/** A farmhand who does nothing else, so section 10 measures the one job. */
const HAND = {
  id: 'zz-pen-hand', name: 'Verify Farmhand', color: '#7a9e4b',
  jobs: [{ job: 'farm', weight: 1 }], cost: 0, wage: 0,
  speed: 20, pace: 0.05, carry: 60,
  tiers: [{ name: 'Standard', cost: 0 }],
};

/**
 * A world of this sweep's own, because section 7 is about the SAVE.
 *
 * Everything else here runs ephemeral, which disables `persist()` — and a
 * reload test that never went through the store would be testing a Game built
 * by hand rather than the payload `Game.create` names field by field, which is
 * exactly the half that shipped missing when `paint` did it.
 */
const WORLD = 'zz-verify-pens';

process.on('exit', () => {
  for (const [table, id] of [['fixtures', PIECE], ['fixtures', BARE], ['items', ITEM], ['workers', HAND.id]]) {
    try { remove(table, id); } catch { /* the DB is already gone */ }
  }
  try { deleteWorldRow(WORLD); } catch { /* the DB is already gone */ }
});

for (const [kind, row] of [['item', TEST_ITEM], ['fixture', TEST_PEN], ['fixture', TEST_BARE], ['worker', HAND]]) {
  const res = writeContent(kind, row, 'verify');
  check(res.ok, `the catalog accepts ${row.id}`, res.error ?? '');
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

const SHOP = { shelf: 4, freezer: 0, checkout: 1, plot: 2 };

function fresh() {
  const g = Game.create({ worldId: 'verify-pens', seed: 'pens', ephemeral: true });
  g.placements = [];
  g.grow = { w: 0, h: 0 };
  g.doorShift = 0;
  g.edits = [];
  g.ground = [];
  g.yardStamped = false;
  g.shell = null;
  g.ownedUpgrades = [];
  g.roster = [];
  silenceMilestones(g);
  g.regenerateLayout(null, {}, { want: SHOP });
  g.freezeShell();
  g.freezeYard();
  g.cash = 10000;
  // Every build verb is a player's, so the sweep needs hands even for the
  // sections that only care where things end up.
  const me = g.addPlayer('me', 'Tester');
  // Build mode is the consent every fixture verb is gated on, and it is a mode
  // rather than a flag on the call — see `withBuildMode`.
  me.build = { ...(me.build ?? {}), on: true };
  return g;
}

/** Somewhere outdoors a pen will go. A pen is `where: 'outdoor'`, like a bed. */
function spotFor(g, kind = 'pen') {
  const L = g.layout;
  for (let z = 1; z < L.h - 1; z++) {
    for (let x = 1; x < L.w - 1; x++) {
      if (!WALKABLE.has(L.tiles[z * L.w + x])) continue;
      for (const rot of [0, 1, 2, 3]) {
        // Cleanly, or the first cell in the sweep is the corner of the map and
        // every pen in this file is built somewhere nobody can reach.
        if (canPlaceCleanly(L, { kind, x, z, rot }).ok) return { x, z, rot };
      }
    }
  }
  return null;
}

/** Build one and hand back the layout record the sim ticks. */
function build(g, piece = PIECE, at = null) {
  const spot = at ?? spotFor(g);
  const res = g.placeFixture('me', { kind: 'pen', piece, x: spot.x, z: spot.z, rot: spot.rot });
  const pen = (g.layout.pens ?? []).find((p) => p.id === res.placed) ?? null;
  // The piece it actually resolved to, asserted rather than assumed. A content
  // write that is refused leaves the row absent, `pieceFor` falls through to
  // `defaultPiece`, and every number in this file is then measured against a
  // SHIPPED pen — which fails in twenty places, none of them saying why.
  if (pen) eq(g.fixtureContent(pen)?.id, piece, `it is built from ${piece} and not a shipped pen`);
  return { res, spot, pen };
}

/** Wind the clock on with nobody touching anything. */
const run = (g, seconds) => { for (let i = 0; i < seconds * 10; i++) g.step(0.1); };

/**
 * ...and wind it on in IN-GAME MINUTES, which is what `every` is measured in.
 *
 * `elapsed` is what `penFill` reads and it runs on the world's scaled clock, so
 * a sweep counting real seconds would measure a pen three times over through the
 * small hours — the `fresh()` trap in the form `verify:break` found it in.
 * Written straight onto `elapsed` for that reason: this is a claim about the
 * arithmetic, and `step` is measured on its own in section 3.
 */
const skipMinutes = (g, mins) => { g.elapsed += mins * 60; };

/**
 * ...and the same span TICKED rather than skipped, for the two sections that
 * are about what `step` does rather than about what the arithmetic says.
 *
 * They are not interchangeable and the difference is the point: a roofed pen
 * holds its clock by having `filledAt` pushed along BY `stepPens`, so a section
 * that skipped `elapsed` past it would be measuring a hold that never ran.
 */
const runMinutes = (g, mins) => run(g, mins * 60);

/** Build one at a chosen rung, through the placement path rather than by hand. */
function atTier(g, tier) {
  for (const p of g.placements) if (p.kind === 'pen') p.tier = tier;
  g.regenerateLayout();
  return only(g);
}

/**
 * Wind on by a fraction of THIS pen's batch, whatever rung it is on.
 *
 * `EVERY` is the piece's number and `speed_mult` divides it, so half a batch on
 * a tier-2 pen is a quarter of `EVERY` — and a section that skipped a flat
 * `EVERY / 2` at tier 2 would land a whole batch and then measure a clock that
 * had just been reset. Which is a real answer to a question nobody asked.
 */
const skipBatch = (g, pen, frac) => skipMinutes(g, (EVERY * frac) / g.fixtureStats(pen).speed_mult);

/** Fill a pen right up, one batch per pass, the way the clock actually does it. */
function fillUp(g, pen) {
  for (let i = 0; i < 20 && pen.qty < g.penCap(pen); i++) {
    skipBatch(g, pen, 1.1);
    g.step(0.1);
  }
  return pen.qty;
}

const only = (g) => (g.layout.pens ?? [])[0];

// ---------------------------------------------------------------------------
// 1. THE CONTROL. A shop with no pen is the old game.
//
// Every save in existence is one of these, so a control that is wrong has
// quietly changed all of them. Both halves: no list, and no row in the save.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  eq((g.layout.pens ?? []).length, 0, 'a shop that has never bought one has no pens');
  run(g, 30);
  eq((g.layout.pens ?? []).length, 0, 'and a day of ticking does not conjure one');
  eq((g.saveState().pens ?? []).length, 0, 'and the save carries no pen rows');

  // ...and the second control: a pen with no `produces` is inert for ever. This
  // is what `produces` being opt-in MEANS, and without it every fixture in the
  // game is a candidate for filling itself up.
  const { pen } = build(g, BARE);
  check(!!pen, 'a pen with nothing authored in it still builds');
  skipMinutes(g, 60);
  run(g, 1);
  eq(pen.qty, 0, 'and after an in-game hour it holds nothing at all');
  eq(g.penCap(pen), 0, 'and its capacity is zero rather than a guess');
  eq(g.penFill(pen), 0, 'and it is not 99% of the way to anything');
  eq(g.actionAt(g.players.me, { ...pen, kind: 'pen' }), null, 'and it offers no job');
}

// ---------------------------------------------------------------------------
// 2. It is a FIXTURE and not a bed.
//
// A plot is the ground — `blocks: false`, `ground: T.PLOT` — and the pen
// deliberately is not. `verify:catalog` asserts every fixture either occupies
// its cell or IS what the cell is made of; a walk-over pen with no ground stamp
// would satisfy neither, and you could stack an unlimited number on one square.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const { res, spot, pen } = build(g);
  check(res.ok, 'a pen can be built outdoors', res.error ?? '');
  check(!!pen, 'and it lands in `layout.pens` rather than somewhere else');
  eq(pen.kind, 'pen', 'the record the sim ticks knows what it is');
  check(!!pen.useAt, 'and it has a gate to collect from');

  const i = spot.z * g.layout.w + spot.x;
  check(!!g.layout.blocked[i], 'it occupies its cell');
  eq(g.walk[i], 0, 'so nobody walks through it');
  // The tile is untouched — a pen stands ON the ground rather than being it,
  // which is the whole difference from the bed it replaces.
  const bare = fresh();
  eq(g.layout.tiles[i], bare.layout.tiles[i], 'and the ground under it is the ground it was');

  // A second one on the same square is refused, which for a blocking kind is
  // `blocked` doing it rather than a tile stamp.
  check(!canPlace(g.layout, { kind: 'pen', ...spot }).ok, 'and nothing else fits on the square');

  // Indoors is refused outright, so `stepPens`' roofed clause below is only ever
  // about a building that grew around one.
  const inside = [];
  for (let z = 0; z < g.layout.h; z++) {
    for (let x = 0; x < g.layout.w; x++) if (insideStore(g.layout, x, z)) inside.push({ x, z });
  }
  check(inside.length > 0, 'the test shop has an indoors');
  check(inside.every((c) => !canPlace(g.layout, { kind: 'pen', ...c, rot: 0 }).ok),
    'and a pen may not be built in any of it');
}

// ---------------------------------------------------------------------------
// 3. The clock, and what each rung of the ladder actually moves.
//
// `every` is in-game minutes and the batch is the PIECE's number — a rung that
// buys room must not quietly buy a bigger batch as well, or `capacity_mult` and
// `produces.qty` are one knob with two names.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const { pen } = build(g);
  eq(g.penCap(pen), BATCH, 'tier 1 holds exactly one batch');

  skipMinutes(g, EVERY * 0.5);
  run(g, 0.5);
  eq(pen.qty, 0, 'half way through a batch it holds nothing yet');
  near(g.penFill(pen), 0.5, 'and it is half full', 0.06);

  skipMinutes(g, EVERY * 0.6);
  run(g, 0.5);
  eq(pen.qty, BATCH, 'and a batch later it holds one batch');

  // The rung. Same piece, one tier up: three batches of room and twice the pace.
  const up = fresh();
  const built = build(up);
  for (const p of up.placements) if (p.kind === 'pen') p.tier = 2;
  up.regenerateLayout();
  const fast = only(up);
  eq(up.penCap(fast), BATCH * ROOM, 'the rung buys ROOM for three batches');
  skipMinutes(up, EVERY / FAST + 0.05);
  run(up, 0.5);
  eq(fast.qty, BATCH, 'and it fills in half the time');
  eq(built.res.ok, true, 'the pen it was built from went down cleanly');

  // ...and the batch is still the batch. A rung with 3x the room that also
  // handed over 3x the goods would be one knob wearing two names.
  skipMinutes(up, EVERY / FAST + 0.05);
  run(up, 0.5);
  eq(fast.qty, BATCH * 2, 'a second batch is a batch, not a capacity');
}

// ---------------------------------------------------------------------------
// 4. THE CENTREPIECE. A full pen STOPS, and it is not secretly running.
//
// Uncapped, a pen is a machine that prints goods all night and `capacity_mult`
// is worth nothing — and neither is the trip out to collect, which is the one
// thing owning an animal is supposed to cost you. Both halves have to be
// asserted: that it stops, and that leaving it full does not bank the batches
// it would have made.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const { pen } = build(g);
  skipMinutes(g, EVERY + 0.05);
  run(g, 0.5);
  eq(pen.qty, BATCH, 'the pen fills');

  // A whole night at capacity.
  skipMinutes(g, EVERY * 20);
  run(g, 1);
  eq(pen.qty, BATCH, 'and standing full for twenty batches adds nothing');
  eq(g.penFill(pen), 0, 'and a stalled pen reads as 0, not as almost-ready');

  // ...and it has not been banking them. Collect, and the next batch is a whole
  // batch away — the difference between an animal and a hopper.
  const me = g.players.me;
  Object.assign(me, { x: pen.useAt.x, z: pen.useAt.z, path: null });
  const got = g.collectPen('me', pen.id);
  check(got.ok, 'it can be collected', got.error ?? '');
  eq(pen.qty, 0, 'and it is empty afterwards');
  eq(g.penFill(pen), 0, 'with the next batch starting from nothing');

  skipMinutes(g, EVERY * 0.5);
  run(g, 0.5);
  eq(pen.qty, 0, 'half a batch after collecting it is still empty');
  skipMinutes(g, EVERY * 0.6);
  run(g, 0.5);
  eq(pen.qty, BATCH, 'and a full batch later it has exactly one');
}

// ---------------------------------------------------------------------------
// 5. CONSERVATION. Collecting is a new place goods move between.
//
// Every one of those in this game has been a hole. The shoulder first, then the
// hands, then the ground — and with hands already full the surplus has to land
// in a crate rather than ceasing to exist, which is the bug `harvest` had for
// most of the life of the farm.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  build(g);
  const big = atTier(g, 2);
  eq(fillUp(g, big), BATCH * ROOM, 'a better pen fills to three batches');

  const me = g.players.me;
  Object.assign(me, { x: big.useAt.x, z: big.useAt.z, path: null });

  const held = () => lotQty(me.carry, ITEM) + lotQty(me.haul, ITEM)
    + g.stockCrates().reduce((n, d) => n + lotQty(d, ITEM), 0);
  const before = held();
  const took = big.qty;
  const res = g.collectPen('me', big.id);
  check(res.ok, 'a full pen hands over what is in it', res.error ?? '');
  eq(big.qty, 0, 'the pen is empty');
  eq(held() - before, took, 'and every unit is somewhere — hands, shoulder or floor');

  // Now with a person who is already carrying as much as they can: it must
  // still all exist. This is the assertion `harvest` failed for most of the
  // life of the farm, said about the other way goods enter the world.
  eq(fillUp(g, big), BATCH * ROOM, 'it fills again');
  const second = big.qty;
  const was = held();
  const full = g.collectPen('me', big.id);
  check(full.ok, 'and collecting with full hands is not refused', full.error ?? '');
  eq(held() - was, second, 'and nothing is destroyed for want of somewhere to put it');
  check(lotTotal(me.carry) <= g.carryCapacity(me), 'hands are not over-filled');
}

// ---------------------------------------------------------------------------
// 6. R, AND THE RE-FLOW. Turning a pen must not empty it.
//
// `repositionFixture` builds a FRESH placement and names every field it keeps,
// so anything stored there is reset by the re-flow the same call triggers. A
// pen's contents deliberately live on the layout record instead and ride across
// through `carryOver`, the way a bed's crop and clock do — this is the assertion
// that says so. The press is R, and it would look exactly like the button not
// working, because the turn you asked for DID happen.
//
// At tier 2, deliberately: at tier 1 a full pen has stalled and its clock reads
// 0, so "the clock survived" would be satisfied by a clock that was reset.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  build(g);
  const pen = atTier(g, 2);
  skipBatch(g, pen, 1.1);
  g.step(0.1);
  eq(pen.qty, BATCH, 'the pen has one batch in it');

  const turned = g.rotateFixture('me', pen.id);
  check(turned.ok, 'it can be turned', turned.error ?? '');
  eq(only(g).qty, BATCH, 'and it still holds what it held');
  check(!!only(g).useAt, 'with a gate on whichever side it now faces');

  // Half way into the NEXT batch, then a re-flow — which build mode fires on
  // every wall segment of a drag, so a clock that reset here would mean a pen
  // that never fills while anybody is building.
  skipBatch(g, only(g), 0.5);
  g.step(0.1);
  const mid = g.penFill(only(g));
  check(mid > 0.3 && mid < 1, 'and it is part way through the next one', `fill ${mid}`);
  g.regenerateLayout();
  near(g.penFill(only(g)), mid, 'which a re-flow leaves exactly where it was', 0.03);
  eq(only(g).qty, BATCH, 'along with what was already in it');

  // ...and a purchase, which is the re-flow a player actually causes.
  const at = spotFor(g, 'shelf');
  if (at) g.placeFixture('me', { kind: 'shelf', x: at.x, z: at.z, rot: at.rot });
  eq(only(g).qty, BATCH, 'and buying a shelf does not empty the pens');
}

// ---------------------------------------------------------------------------
// 7. OUT AND BACK. The save is two different pieces of code.
//
// `saveState` writing a field is the obvious half; `Game.create` naming it on
// the way in is the half that shipped missing for five steps when `paint` did
// it — and the failure is worse than not restoring, because the next `persist()`
// writes the default back over what was stored.
//
// And the clock has to be stored as how long it HAS filled: `elapsed` restarts
// at zero on every load, so a stamp saved raw sits in the future and the pen
// never produces again. Through the STORE rather than by handing a Game an
// object, because the payload is the thing being tested.
// ---------------------------------------------------------------------------
{
  if (!worldRow(WORLD)) insertWorldRow({ id: WORLD, name: 'verify:pens', seed: 'pens' });
  const g = fresh();
  build(g);
  const pen = atTier(g, 2);
  skipBatch(g, pen, 1.1);
  g.step(0.1);
  skipBatch(g, pen, 0.4);
  g.step(0.1);
  const qtyWas = pen.qty;
  const fillWas = g.penFill(pen);
  check(qtyWas === BATCH && fillWas > 0.2 && fillWas < 1,
    'a pen with stock in it and a batch under way', `${qtyWas} held, fill ${fillWas}`);

  const saved = g.saveState();
  const row = (saved.pens ?? []).find((r) => r.id === pen.id);
  check(!!row, 'the save carries a row for it');
  check(row && row.filled > 0 && row.filled < 1e6,
    'and the clock is stored as how long it HAS filled', `got ${row?.filled}`);

  g.worldId = WORLD;
  g.ephemeral = false;
  g.persist();
  const back = Game.create({ worldId: WORLD });
  back.ephemeral = true;
  silenceMilestones(back);
  const reloaded = (back.layout.pens ?? []).find((p) => p.id === pen.id);
  check(!!reloaded, 'and the pen comes back');
  if (reloaded) {
    eq(reloaded.qty, qtyWas, 'holding what it held');
    near(back.penFill(reloaded), fillWas, 'and at the same point in its batch', 0.05);
    // Not stuck in the future, which is the bug the write-around exists for: on
    // a fresh Game `elapsed` starts at zero, so a raw stamp reads as negative
    // progress and the pen never produces again.
    check(back.penFill(reloaded) >= 0, 'and its clock is not stuck in the future');
    skipBatch(back, reloaded, 1.1);
    back.step(0.1);
    check(back.layout.pens[0].qty > qtyWas, 'and it goes on filling after a reload');
  }
}

// ---------------------------------------------------------------------------
// 8. A ROOF holds the clock rather than resetting it.
//
// `stepCrops`' rule said about livestock, and it has to be HELD rather than
// reset for the reason given there: a wall drawn near the farm must not destroy
// the batch that was nearly ready. This is the one section that has to TICK the
// clock rather than skip it, because the hold is `stepPens` pushing `filledAt`
// along by exactly the world delta — skipped, there is no hold to measure.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const { pen } = build(g);
  runMinutes(g, EVERY * 0.6);
  const under = g.penFill(pen);
  check(under > 0.4 && under < 1, 'a pen part way through a batch', `fill ${under}`);

  // Roof it by lying about the mask, which is what a building grown round it
  // amounts to as far as `stepPens` is concerned.
  const i = pen.z * g.layout.w + pen.x;
  g.layout.indoor[i] = 1;
  runMinutes(g, EVERY * 2);
  eq(pen.qty, 0, 'a roofed pen produces nothing');
  near(g.penFill(pen), under, 'and holds its clock rather than losing it', 0.05);

  g.layout.indoor[i] = 0;
  runMinutes(g, EVERY * 0.5);
  eq(pen.qty, BATCH, 'and takes up where it left off when the roof comes off');
}

// ---------------------------------------------------------------------------
// 9. Content is edited live, so the item can go while the goods are standing.
//
// FORGIVEN rather than refused, and that is the doctrine rather than an
// omission: every loop in the sim that touches stock rides an unknown item
// along and `binOrphans` collects it at the day roll (`verify:orphans`). Goods
// standing in a pen are the same case as goods standing in a crate, and
// refusing here would strand them in a place nothing sweeps.
//
// What IS refused is a pen with nothing authored in it at all — the piece
// re-authored without its `produces`, which is the row that says what the job
// even is. That is `harvest`'s split exactly: it refuses on a missing crop and
// forgives a missing item.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const { pen } = build(g);
  skipMinutes(g, EVERY * 1.1);
  g.step(0.1);
  eq(pen.qty, BATCH, 'the pen is full');

  remove('items', ITEM);
  content(true);
  const me = g.players.me;
  Object.assign(me, { x: pen.useAt.x, z: pen.useAt.z, path: null, carry: null, haul: null });
  const res = g.collectPen('me', pen.id);
  check(res.ok, 'a pen whose item has been deleted still hands its goods over', res.error ?? '');
  eq(pen.qty, 0, 'and empties');
  const stranded = lotQty(me.carry, ITEM) + lotQty(me.haul, ITEM)
    + g.stockCrates().reduce((n, d) => n + lotQty(d, ITEM), 0);
  eq(stranded, BATCH, 'with every unit somewhere `binOrphans` will find it');

  writeContent('item', TEST_ITEM, 'verify');
  content(true);

  // ...and the other half: a pen with no `produces` refuses rather than handing
  // over `undefined`.
  const bare = build(g, BARE).pen;
  check(!!bare, 'a pen with nothing authored in it builds');
  bare.qty = 3;
  const nope = g.collectPen('me', bare.id);
  check(!nope.ok, 'and collecting it is refused rather than answered with nothing');
}

// ---------------------------------------------------------------------------
// 10. The crew. A pen is a farm job, and it is the FIRST one.
//
// Above picking in the fold, because a full pen has STOPPED where a ripe bed
// merely sits there — so collecting is the one farm job that puts something
// back into production. Gated by `hasSomewhere` rather than `hasHome`, for
// `harvest`'s measured reason: the drop-off is the buffer and the pen is the
// overflow behind it.
//
// Nothing here is visible: a hire walking to a pen and a hire walking to a bed
// are the same still frame, and the shop is the same shop either way.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  g.open = false;                     // nobody buying things out from under us
  const { pen } = build(g);
  skipMinutes(g, EVERY * 1.1);
  g.step(0.1);
  eq(pen.qty, BATCH, 'the pen is full');

  const hired = g.hire(HAND.id);
  check(hired.ok, 'a farmhand joins', hired.error ?? '');
  g.step(0.1);                        // `hire` writes the roster; `syncStaff` puts the body in
  const hand = g.players[`staff-${g.roster[g.roster.length - 1]?.id}`];
  check(!!hand, 'and turns up on the floor');

  const live = only(g);
  for (let i = 0; i < 1200 && live.qty > 0; i++) g.step(0.1);
  eq(live.qty, 0, 'and walks out and empties it');
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\nverify:pens — ${failures.length} of ${checks} assertions FAILED\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\nverify:pens — ${checks} assertions\n`);
console.log('  ✅  an animal is a building, it fills up, and it stops.\n');
