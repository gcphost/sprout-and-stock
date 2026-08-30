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
import {
  canPlace, canPlaceCleanly, insideStore, footprint, paddockOf, canPaintGround,
} from '../shared/build.js';
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
const NOART = 'zz-pen-noart';
const VAT = 'zz-pen-vat';
const GRASS = 'zz-pen-grazing';

/**
 * Restated rather than imported from `server/sim/index.js`, and it is the same
 * call `verify:grace` makes about `GRACE_DAYS` and `verify:routes` about its
 * thresholds: an assertion that reads the constant it is checking passes
 * whatever that constant becomes, which is not a test of anything.
 */
const PER_HEAD = 4;

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
/**
 * How many head rung 1 of the test pen will keep.
 *
 * Well above every head count section 11 paints for, and that is the point: the
 * assertions about the LAND have to be measuring the land, so a ceiling low
 * enough to bind would make half of them pass for the wrong reason. The one
 * section that is about the ceiling paints past it deliberately.
 */
const MOB = 8;

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
  // The animal. One part, because nothing in section 11 is about what it looks
  // like — only about how many of them there are and where they are standing.
  body: { parts: [{ shape: 'sphere', color: '#f4f0e4', pos: [0, 0.12, 0], scale: [0.3, 0.24, 0.3] }] },
  // `heads` is deliberately generous on rung 1 and RAISED on rung 2, so the
  // sections about the paddock can measure the land without the ceiling binding
  // and the section about the ceiling can measure it on purpose.
  tiers: [
    { name: 'Basic', cost: 0, heads: MOB },
    { name: 'Better', cost: 0, capacity_mult: ROOM, speed_mult: FAST, heads: MOB * 2 },
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

/**
 * ...and a working pen nobody has drawn an animal for.
 *
 * A THIRD control, and it has to be its own row rather than another job for
 * `TEST_BARE`: that one is the control for `produces` being opt-in and, since
 * the ceiling, for `heads` defaulting to 1 as well. Asking it to also stand for
 * "the art is a look" would be three claims on one row, and a failure in any of
 * them would read as a failure in the other two.
 *
 * What this one isolates is that heads come off the PAINT and the rung, never
 * off whether somebody has drawn the animal — the same split `work` and
 * `variants` make. A piece with no `body` runs exactly as many head as one with.
 */
const TEST_NOART = {
  id: NOART, kind: 'pen', name: 'Verify Undrawn Pen', cost: 0,
  produces: { item_id: ITEM, qty: BATCH, every: EVERY },
  model: { parts: [box] },
  tiers: [{ name: 'Basic', cost: 0, heads: MOB }],
};

/**
 * ...and the farm indoors: a pen whose field holds TRAYS and one drone.
 *
 * The two off-diagonal entries, which are the two the old single `body` could
 * not express: a thing that stands still and is counted (the rack — one per
 * line, which is the job the pigs were doing) and a thing that walks and is
 * NOT counted (the tender — one per machine). Authored on its own row rather
 * than by giving `TEST_PEN` a second body, because every other section in this
 * file measures that pen's herd and a second population standing in the same
 * field would fail those on a count nobody changed.
 *
 * The rack is drawn in STAGES so section 12 can ask what drives them. Two, and
 * the second at 1 exactly: what is being asserted is which stage a full pen
 * picks, and an `at` anywhere below the top would make that assertion true of a
 * pen that was merely nearly full — which is the reading `penFill` gives and the
 * one this is here to rule out.
 */
const TRAY = {
  model: {
    stages: [
      { name: 'Empty', at: 0, parts: [{ shape: 'box', color: '#8fa3b8', pos: [0, 0.05, 0], scale: [0.3, 0.1, 0.3] }] },
      { name: 'Full', at: 1, parts: [{ shape: 'box', color: '#c8e6a0', pos: [0, 0.1, 0], scale: [0.3, 0.2, 0.3] }] },
    ],
  },
  roams: false,
  per: 'head',
};
const DRONE = {
  model: { parts: [{ shape: 'sphere', color: '#d8dee6', pos: [0, 0.16, 0], scale: [0.22, 0.22, 0.22] }] },
  roams: true,
  per: 'pen',
};
const TEST_VAT = {
  id: VAT, kind: 'pen', name: 'Verify Vat', cost: 0,
  produces: { item_id: ITEM, qty: BATCH, every: EVERY },
  model: { parts: [box] },
  bodies: [TRAY, DRONE],
  tiers: [{ name: 'Basic', cost: 0, heads: MOB }],
};

/**
 * A paddock design of this sweep's own, priced at nothing.
 *
 * Free deliberately: section 11 paints fields of several sizes to count heads,
 * and a per-cell price would mean the big ones are also a test of whether the
 * shop could afford them — which is a different assertion that would fail for
 * an unrelated reason.
 */
const TEST_GRASS = {
  id: GRASS, kind: 'paddock', name: 'Verify Grazing', cost: 0,
  surface: { color: '#9ab069', pattern: 'plain' }, tiers: [{ name: 'Flat', cost: 0 }],
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
  for (const [table, id] of [['fixtures', PIECE], ['fixtures', BARE], ['fixtures', NOART], ['fixtures', VAT], ['fixtures', GRASS], ['items', ITEM], ['workers', HAND.id]]) {
    try { remove(table, id); } catch { /* the DB is already gone */ }
  }
  try { deleteWorldRow(WORLD); } catch { /* the DB is already gone */ }
});

for (const [kind, row] of [['item', TEST_ITEM], ['fixture', TEST_PEN], ['fixture', TEST_BARE], ['fixture', TEST_NOART], ['fixture', TEST_VAT], ['fixture', TEST_GRASS], ['worker', HAND]]) {
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

/**
 * Somewhere a pen will go. `where: 'any'` since docs/vats.md step 1, like a bed
 * — so this walks the map rather than the yard, and section 2 asserts the
 * indoor half separately.
 */
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
 * They are not interchangeable and the difference is the point: section 8's
 * claim is about what `stepPens` does to `filledAt` on every tick under a roof
 * (which since docs/vats.md step 1 is *nothing*), so a section that skipped
 * `elapsed` past it would never run the code it is asserting about.
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

  // INDOORS IS ALLOWED, and this assertion is the reverse of the one that stood
  // here. `pen` was `where: 'outdoor'` and this section asserted that no indoor
  // cell would take one; docs/vats.md step 1 made it `where: 'any'`, so the
  // claim is now the opposite claim and the old one had to go rather than be
  // relaxed.
  //
  // Asserted POSITIVELY — "some indoor cell takes a pen" — and never as the
  // absence of the old refusal, because "no cell refused it" is also what a
  // sweep whose shop has no indoors looks like, and what a sweep that stopped
  // calling `canPlace` at all looks like. Hence the paired claim above it that
  // the test shop has an indoors in the first place.
  //
  // `.some` and not `.every`: `where: 'any'` still needs BUILDABLE ground, so
  // an indoor cell with shelving already on it is refused for the ordinary
  // reason and always was.
  const inside = [];
  for (let z = 0; z < g.layout.h; z++) {
    for (let x = 0; x < g.layout.w; x++) if (insideStore(g.layout, x, z)) inside.push({ x, z });
  }
  check(inside.length > 0, 'the test shop has an indoors');
  check(inside.some((c) => [0, 1, 2, 3].some((rot) => canPlace(g.layout, { kind: 'pen', ...c, rot }).ok)),
    'and a pen may be built in it — the farm came indoors');
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
// 8. A ROOF IS NOT A THING ANY MORE, and this section is the guard that it does
//    not come back.
//
// It used to assert the opposite: `stepPens` held a roofed pen's `filledAt`
// along by the world delta, so an enclosed pen produced nothing and kept its
// progress for when the roof came off. docs/vats.md step 1 retired the whole
// rule — `where: 'any'` makes a pen indoors a thing you deliberately build, and
// a hold left behind would take your money for a machine that then never
// produces.
//
// That failure is why this section still exists rather than being deleted with
// the rule. It is invisible twice over: a vat that is part way through a batch
// and one whose clock is frozen are the same still frame and the same bar, and
// the shop is the same shop — only the clock moved, and the clock is the thing
// that stopped. No refusal, no log, nothing on screen. What it reads as is the
// farm being broken.
//
// Still the section that TICKS rather than skips, because the thing being
// asserted absent was `stepPens` pushing a stamp on every tick — skipped, there
// is no hold to fail to find.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const { pen } = build(g);
  runMinutes(g, EVERY * 0.6);
  const under = g.penFill(pen);
  check(under > 0.4 && under < 1, 'a pen part way through a batch', `fill ${under}`);

  // Roof it by lying about the mask, which is what a building grown round it
  // amounts to as far as `stepPens` is concerned — and is also exactly what
  // standing one on a shop floor looks like from in here.
  const i = pen.z * g.layout.w + pen.x;
  g.layout.indoor[i] = 1;

  // The clock goes on running under the roof. Asserted before the batch lands,
  // or the only claim is about the total and a hold that merely stuttered would
  // pass.
  runMinutes(g, EVERY * 0.2);
  check(g.penFill(pen) > under, 'a pen under a roof goes on filling', `fill ${g.penFill(pen)}`);

  runMinutes(g, EVERY * 0.3);
  eq(pen.qty, BATCH, 'and lands its batch indoors, at the same pace it would outside');
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
// 11. THE PADDOCK, and the herd standing in it.
//
// Everything here is invisible for the reason the whole file is: a pen filling
// four times as fast and a pen filling once are the same still frame, and the
// shop is the same shop afterwards. What is NEW is that some of it is invisible
// in the other direction too — there are bodies on the grass now, and a herd
// that quietly grazes the wrong field, teleports home whenever you draw a wall,
// or wanders onto the shop floor all look like art rather than like a rule.
//
// Its control is the assertion that decides whether any of the step is opt-in:
// a pen with NO paddock is one head, which is section 3's arithmetic to the
// digit. Every shop in existence has never painted one.
// ---------------------------------------------------------------------------

/**
 * Paint `want` cells of grazing outward from a pen, four-connected.
 *
 * Gathered against the layout as it stands and painted afterwards, which is not
 * tidiness: `buildGround` re-flows, so `g.layout` is a different object by the
 * second cell and a walk that re-read it each time would be following a map it
 * was redrawing. Every cell chosen is grass, and painting grass cannot make a
 * neighbour unpaintable, so the set stays legal for the whole run.
 *
 * Painted one cell at a time on purpose. A drag would be one call and would
 * also be a test of `groundStroke`, which is `verify:floor`'s claim rather than
 * this file's — and a run clipped by something in the way would leave a paddock
 * of a size no assertion here had asked for.
 */
function graze(g, pens, want, piece = GRASS) {
  const L = g.layout;
  const seen = new Set();
  const out = [];
  // Seeded from every shelter that is meant to share the field, so the run this
  // grows touches all of them. Painting outward from one and hoping the second
  // ends up beside it is how the first draft of this failed.
  const queue = [pens].flat().flatMap((p) => footprint('pen', p.x, p.z));
  for (const c of queue) seen.add(`${c.x},${c.z}`);
  while (queue.length && out.length < want) {
    const c = queue.shift();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (out.length >= want) break;
      const x = c.x + dx;
      const z = c.z + dz;
      const key = `${x},${z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Never the border ring, which is the public road every lorry leaves the
      // map along. It is paintable — you may put a paddock across it and the
      // brush warns you — but a field is not what anybody would put there, and
      // this helper is building a field. It used to be excluded by
      // `canPaintGround` refusing the ring outright, so this line is that
      // refusal moving from the rule into the sweep that was relying on it.
      //
      // It matters because a field has to be ONE region: these shelters land at
      // (1,1) and (3,1), so a run allowed round the corner leaves two cells
      // stranded past the second one, `paddockOf` floods a different number from
      // each pen, and the even split this section is about stops being even.
      if (x === 0 || z === 0 || x === L.w - 1 || z === L.h - 1) continue;
      if (!canPaintGround(L, [{ x, z }], 'paddock', piece).ok) continue;
      out.push({ x, z });
      queue.push({ x, z });
    }
  }
  eq(out.length, want, `there is room for ${want} cells of grazing beside the pen`);
  for (const c of out) {
    const res = g.buildGround('me', { x: c.x, z: c.z, piece });
    check(res.ok, `grazing goes down at ${c.x},${c.z}`, res.error ?? '');
  }
  return out;
}

// The control, and the pair that makes it mean something: no paint is one head
// and today's clock, and paint is more heads and a faster one.
{
  const g = fresh();
  const { pen } = build(g);
  eq(g.penHeads(pen), 1, 'a pen with no paddock is ONE head — every shop that exists');
  eq(paddockOf(g.layout, pen).length, 0, 'and the flood finds nothing to graze');

  const cap = g.penCap(pen);
  graze(g, pen, PER_HEAD * 4);
  const live = only(g);
  eq(g.penHeads(live), 4, `${PER_HEAD * 4} cells of grazing is four head`);
  eq(g.penCap(live), cap, 'and the STOCKPILE is untouched — heads are a pace, not a bigger pen');
}

// The divisor. Four hens lay four times as often, which is the whole of what a
// head is worth — asserted as a batch that HAS landed at a quarter of the wait
// and one that has NOT landed just short of it, or "faster" is satisfied by any
// number bigger than one.
{
  const g = fresh();
  const { pen } = build(g);
  graze(g, pen, PER_HEAD * 4);
  const live = only(g);
  eq(g.penHeads(live), 4, 'four head');

  skipMinutes(g, EVERY / 4.4);
  g.step(0.1);
  eq(live.qty, 0, 'just short of a quarter of the wait, nothing has been laid');
  skipMinutes(g, EVERY / 4);
  g.step(0.1);
  eq(live.qty, BATCH, 'and a quarter of the wait in, a whole batch has');
}

// A part-painted head is worth nothing. `Math.floor`, which is the honest
// reading of a field too small to keep another animal in — and the thing that
// stops one cell of the brush being a fraction of an animal nobody can see.
{
  const g = fresh();
  const { pen } = build(g);
  graze(g, pen, PER_HEAD * 3 - 1);
  eq(g.penHeads(only(g)), 2, 'one cell short of three head is two head');
}

// The land supports what it supports. Without the division, one big paddock and
// six shelters standing in it is six pens each dividing by the whole acreage —
// a money printer built from one brush stroke and a repeated purchase, and one
// that reads as working perfectly the whole time.
{
  const g = fresh();
  const { pen } = build(g);
  // BOTH shelters go down before any paint, or the second has nowhere to stand:
  // a pen needs bare grass (`BUILDABLE_OUTDOOR`), and the field painted for the
  // first one is exactly the grass the second would have used.
  //
  // The NEAREST legal spot rather than a guessed offset, because how close two
  // pens can stand is a fact about the generated farm rather than about this
  // sweep — and a field has to be able to reach both.
  let second = null;
  let best = Infinity;
  for (let z = 1; z < g.layout.h - 1; z++) {
    for (let x = 1; x < g.layout.w - 1; x++) {
      const away = Math.abs(x - pen.x) + Math.abs(z - pen.z);
      if (away >= best) continue;
      for (const rot of [0, 1, 2, 3]) {
        if (!canPlaceCleanly(g.layout, { kind: 'pen', x, z, rot }).ok) continue;
        second = { x, z, rot };
        best = away;
        break;
      }
    }
  }
  check(!!second, 'there is room for a second shelter near the first');
  if (second) {
    const { pen: other } = build(g, PIECE, second);
    const both = g.layout.pens ?? [];
    eq(both.length, 2, 'two shelters');
    graze(g, [pen, other], PER_HEAD * 4);
    const live = g.layout.pens ?? [];
    for (const p of live) eq(g.penHeads(p), 2, 'and one field of four head is split between them');
  }
}

// A paddock is the region a shelter TOUCHES and never every paddock cell on the
// map. This is `dropGoods`' bug said about grazing — a pad is one named region
// in as many pieces as you painted it — and it would be worse here than a wrong
// shelf: a field at the top of the farm would fatten a coop at the bottom of it,
// so the paint and the animals would be two unrelated facts on one save.
{
  const g = fresh();
  const { pen } = build(g);
  graze(g, pen, PER_HEAD * 3);
  const mine = only(g);
  eq(g.penHeads(mine), 3, 'three head on the field it stands in');

  // A second field somewhere else entirely, with nothing standing in it.
  const L = g.layout;
  const far = [];
  for (let z = L.h - 2; z > 1 && far.length < PER_HEAD * 5; z--) {
    for (let x = L.w - 2; x > 1 && far.length < PER_HEAD * 5; x--) {
      if (!canPaintGround(L, [{ x, z }], 'paddock', GRASS).ok) continue;
      // Nowhere near the pen, or the two floods meet and this proves nothing.
      if (Math.abs(x - pen.x) + Math.abs(z - pen.z) < 6) continue;
      far.push({ x, z });
    }
  }
  check(far.length > 0, 'there is somewhere else to paint');
  for (const c of far) g.buildGround('me', { x: c.x, z: c.z, piece: GRASS });
  eq(g.penHeads(only(g)), 3, 'and a field on the other side of the farm changes nothing');
}

// The bodies. Heads come off the PAINT and the animal is a look, which is the
// same split `work` and `variants` make — so a piece nobody has drawn an animal
// for runs exactly as many head as one somebody has, and draws none of them.
{
  const g = fresh();
  const { pen } = build(g);
  graze(g, pen, PER_HEAD * 3);
  g.step(0.1);
  eq(g.animals.size, 3, 'three head is three bodies');
  eq(new Set([...g.animals.values()].map((a) => a.piece)).size, 1, 'all off the one piece');

  const undrawn = fresh();
  const { pen: hutch } = build(undrawn, NOART);
  graze(undrawn, hutch, PER_HEAD * 3);
  undrawn.step(0.1);
  eq(undrawn.penHeads(only(undrawn)), 3, 'a piece with no animal drawn still runs three head');
  eq(undrawn.animals.size, 0, 'and draws none of them');
}

// The one claim in this file a screenshot could check, which is why it is here:
// an animal that wandered onto the shop floor, into the road or across the car
// park is the failure. There is no pathing and no edge test in any of it — the
// legal cells ARE the answer — so this is a claim that the set is never left.
{
  const g = fresh();
  const { pen } = build(g);
  const painted = graze(g, pen, PER_HEAD * 4);
  const field = new Set(painted.map((c) => `${c.x},${c.z}`));
  g.step(0.1);
  eq(g.animals.size, 4, 'four bodies');

  let strayed = 0;
  let moved = 0;
  const at0 = new Map([...g.animals.values()].map((a) => [a.id, `${a.x},${a.z}`]));
  for (let i = 0; i < 4000; i++) {
    g.step(0.1);
    for (const a of g.animals.values()) {
      // Between cells for most of a leg, so the test is the cell it is nearest
      // rather than a whole number — a body walking the line between two
      // painted squares is inside the field.
      if (!field.has(`${Math.round(a.x)},${Math.round(a.z)}`)) strayed++;
      if (at0.get(a.id) !== `${a.x},${a.z}`) moved++;
    }
  }
  eq(strayed, 0, 'and over four hundred seconds not one of them leaves the paddock');
  check(moved > 0, 'while at least one of them did move — or the claim above is about statues');
}

// A re-flow PARKS the herd rather than restarting it, which is `parkNow`'s bug
// said about livestock: build mode re-flows on every wall segment of a drag, so
// a herd that snapped back to the shelter each time is one you could only watch
// by putting the tools down. This is also why the bodies live on the Game and
// not on the layout record, which a re-flow rebuilds.
{
  const g = fresh();
  const { pen } = build(g);
  graze(g, pen, PER_HEAD * 3);
  for (let i = 0; i < 200; i++) g.step(0.1);
  const before = [...g.animals.values()].map((a) => `${a.id}@${a.x},${a.z}`).sort();
  check(before.length === 3, 'three bodies out in the field');

  g.regenerateLayout();
  g.regenerateLayout();
  const after = [...g.animals.values()].map((a) => `${a.id}@${a.x},${a.z}`).sort();
  eq(after.join('|'), before.join('|'), 'and two re-flows move none of them');
  eq(g.penHeads(only(g)), 3, 'and the field is still the same field');
}

// Nothing about a body is on the save, and that is a decision rather than an
// omission — an animal is not a thing you own, the shelter and the paint are,
// and both of those are already stored. It also means there is no `elapsed`
// stamp in here to get wrong, which is the trap section 7 exists for.
{
  const g = fresh();
  const { pen } = build(g);
  graze(g, pen, PER_HEAD * 3);
  g.step(0.1);
  eq(g.animals.size, 3, 'three bodies');
  const saved = JSON.stringify(g.saveState());
  check(!saved.includes('"animals"'), 'and the save says nothing about any of them');
  const live = only(g);
  check(live.bodies === undefined, 'nor does the layout record the re-flow rebuilds');
}

// THE CEILING. The paddock is the supply and the rung is the most this shelter
// will keep — and both halves have to bite, or one of them is a knob that takes
// money and moves no number.
//
// The control that decides whether the ceiling is opt-in is `TEST_BARE`, whose
// rungs say nothing about heads: `heads` defaults to 1, so a pen row authored
// before any of this existed keeps exactly the one animal it always did, and a
// paddock painted round it does nothing. That is the honest answer rather than
// a convenience, and it is why all seven shipped pieces set the field.
{
  const g = fresh();
  const { pen } = build(g);
  eq(g.fixtureStats(pen).heads, MOB, 'rung 1 of the test pen keeps a mob');

  // Grazing for twice what the shelter will hold.
  graze(g, pen, PER_HEAD * MOB * 2);
  const live = only(g);
  eq(g.penHeads(live), MOB, 'and all the grazing in the world does not beat the rung');
  g.step(0.1);
  eq(g.animals.size, MOB, 'so there are exactly that many bodies out there');

  // ...and the rung is what lifts it, against a field that has not moved.
  const up = g.upgradeFixture('me', live.id);
  check(up.ok, 'the pen steps up a rung', up.error ?? '');
  const better = only(g);
  eq(g.fixtureStats(better).heads, MOB * 2, 'the better shelter keeps twice as many');
  eq(g.penHeads(better), MOB * 2, 'and the same field now runs twice the herd');
}

// The other half of the pair, and the reason the menu names which is short: a
// pen out of LAND and a pen out of SHELTER are the same count on the same line.
{
  const g = fresh();
  const { pen } = build(g);
  graze(g, pen, PER_HEAD * 2);
  const live = only(g);
  eq(g.penHeads(live), 2, 'two head, because that is all the grazing there is');
  eq(g.penField(live).ceiling, MOB, 'while the shelter would hold four times that');
  const up = g.upgradeFixture('me', live.id);
  check(up.ok, 'the pen steps up a rung', up.error ?? '');
  eq(g.penHeads(only(g)), 2, 'and buying more shelter over a small field changes nothing');
}

// A pen row that has never heard of heads is step 1's pen exactly — one animal,
// whatever you paint round it. This is the assertion that decides whether the
// ceiling is opt-in, and every pen row ever authored before now is one of these.
{
  const g = fresh();
  const { pen } = build(g, BARE);
  eq(g.fixtureStats(pen).heads, 1, 'a rung with no `heads` keeps one');
  graze(g, pen, PER_HEAD * 6);
  eq(g.penHeads(only(g)), 1, 'and six head of grazing round it is still one animal');
}

// Taking the paint up takes the herd with it, which is the control said
// backwards: the field is the only thing deciding, so scrubbing it is a shop
// that has never painted one.
{
  const g = fresh();
  const { pen } = build(g);
  const painted = graze(g, pen, PER_HEAD * 3);
  g.step(0.1);
  eq(g.animals.size, 3, 'three bodies');

  for (const c of painted) g.buildGround('me', { x: c.x, z: c.z, piece: '' });
  g.step(0.1);
  eq(g.penHeads(only(g)), 1, 'the grazing is gone and the pen is back to one head');
  eq(g.animals.size, 1, 'and one body');
}

// ---------------------------------------------------------------------------
// 12. THE TRAYS. What stands in the field stopped being one thing.
//
// The paddock was legible because six pigs meant six head — you read the number
// off the grass without opening a menu. Indoors there is nothing to graze, so
// the deck is paint with nothing on it and the count is a number nobody can
// see: the `charm` trap, where a working system with no content in it cannot be
// told from a broken one. A rack of trays is that number put back, and a tender
// drone is the life the herd was also providing.
//
// Everything here is invisible twice over, again. A vat running six lines and a
// vat running five are the same machine; a tray that is standing still because
// it is a tray and one standing still because the walk is broken are the same
// still frame; and two trays drawn on one square are simply five trays, which
// reads as the arithmetic being wrong when it is the placement.
//
// The control is the shape every pen row in the game is authored in — a bare
// `body`, read as a one-entry roaming herd — and it is the assertion that
// decides whether any of this is opt-in.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const { pen } = build(g);
  graze(g, pen, PER_HEAD * 3);
  g.step(0.1);
  const herd = [...g.animals.values()];
  eq(herd.length, 3, 'the old spelling is a herd of three, exactly as it was');
  eq(new Set(herd.map((a) => a.b)).size, 1, 'all off the one body');
  eq(herd[0].b, 0, 'which is the first and only entry in the list it is read as');
}

// ...and the other control, which is the shape every vat in the shop is in the
// day it is built: no deck painted round it. A pen with no paddock falls back to
// the two-by-two the machine itself stands on — right for a roamer, which is
// where the hen with no field mills about, and fatal for a tray, which would be
// dealt one of those squares and drawn INSIDE the vat. Invisible, on every vat,
// until somebody happened to paint a deck: trays that read as not working, which
// is the exact trap the trays exist to close arriving through the default.
{
  const g = fresh();
  build(g, VAT);
  g.step(0.1);
  eq(g.penHeads(only(g)), 1, 'a vat with no deck painted round it runs one line');
  eq([...g.animals.values()].filter((a) => a.b === 0).length, 0, 'and racks no trays inside itself');
  eq([...g.animals.values()].filter((a) => a.b === 1).length, 1, 'while the tender is still there — or the pair is a vat with nothing on it');

  // ...and the one press that changes it, which is what makes the brush legible.
  graze(g, only(g), PER_HEAD * 2);
  g.step(0.1);
  eq([...g.animals.values()].filter((a) => a.b === 0).length, 2, 'paint a deck and two trays are standing on it');
}

// Two populations out of one piece, and they are counted differently. Fold the
// two and one of them is gone: a tender per line is six drones fussing round one
// machine, and a rack per machine is a readout that says "vat" rather than how
// many lines are running.
{
  const g = fresh();
  const { pen } = build(g, VAT);
  graze(g, pen, PER_HEAD * 3);
  g.step(0.1);
  const trays = [...g.animals.values()].filter((a) => a.b === 0);
  const drones = [...g.animals.values()].filter((a) => a.b === 1);
  eq(g.penHeads(only(g)), 3, 'three lines');
  eq(trays.length, 3, 'and a tray for each of them');
  eq(drones.length, 1, 'and ONE tender, however many lines are running');

  // ...and the paint moves one of those numbers and not the other.
  graze(g, only(g), PER_HEAD * 5);
  g.step(0.1);
  eq(g.penHeads(only(g)), 5, 'paint more deck and it runs five');
  eq([...g.animals.values()].filter((a) => a.b === 0).length, 5, 'and there are five trays');
  eq([...g.animals.values()].filter((a) => a.b === 1).length, 1, 'and still the one tender');
}

// The centrepiece, and it is a PAIR: the trays stand still and the drone does
// not, in the same shop, over the same four hundred seconds. Either half alone
// is worthless — "nothing moved" is satisfied by a vat that drew nothing at all,
// and "something moved" is satisfied by a rack of trays wandering off across the
// shop floor, which is what a stander handed to `stepAnimal` would do.
{
  const g = fresh();
  const { pen } = build(g, VAT);
  const painted = graze(g, pen, PER_HEAD * 4);
  const field = new Set(painted.map((c) => `${c.x},${c.z}`));
  g.step(0.1);
  eq([...g.animals.values()].filter((a) => a.b === 0).length, 4, 'four trays');

  const at0 = new Map([...g.animals.values()].map((a) => [a.id, `${a.x},${a.z}`]));
  let trayMoved = 0;
  let droneMoved = 0;
  let strayed = 0;
  for (let i = 0; i < 4000; i++) {
    g.step(0.1);
    for (const a of g.animals.values()) {
      if (at0.get(a.id) !== `${a.x},${a.z}`) (a.b === 0 ? trayMoved++ : droneMoved++);
      if (!field.has(`${Math.round(a.x)},${Math.round(a.z)}`)) strayed++;
    }
  }
  eq(trayMoved, 0, 'and over four hundred seconds not one tray moves a pixel');
  check(droneMoved > 0, 'while the tender walking between them does — or the pair is about statues');
  eq(strayed, 0, 'and neither of them ever leaves the deck');
}

// No two trays on one square, which is the whole of what makes them countable. A
// pen deals its standing bodies rather than hashing each a cell, because a hash
// collides: two trays drawn on one cell is a vat running six lines you can count
// five of, and nothing anywhere says a word.
{
  const g = fresh();
  const { pen } = build(g, VAT);
  graze(g, pen, PER_HEAD * MOB);
  g.step(0.1);
  const cells = [...g.animals.values()].filter((a) => a.b === 0).map((a) => `${a.x},${a.z}`);
  eq(cells.length, MOB, 'a deck painted for eight runs eight lines');
  eq(new Set(cells).size, MOB, 'and every one of their trays is on a square of its own');
}

// ...and the same claim across the fence, which is the half a per-pen hash could
// never make. Two vats sharing one deck deal from the same list of cells, so a
// start hashed off the pen is *probably* disjoint and provably nothing — and
// what "probably" looks like is one vat, once, drawn a tray short.
{
  const g = fresh();
  const { pen } = build(g, VAT);
  let second = null;
  let best = Infinity;
  for (let z = 1; z < g.layout.h - 1; z++) {
    for (let x = 1; x < g.layout.w - 1; x++) {
      const away = Math.abs(x - pen.x) + Math.abs(z - pen.z);
      if (away >= best) continue;
      for (const rot of [0, 1, 2, 3]) {
        if (!canPlaceCleanly(g.layout, { kind: 'pen', x, z, rot }).ok) continue;
        second = { x, z, rot };
        best = away;
        break;
      }
    }
  }
  check(!!second, 'there is room for a second vat beside the first');
  if (second) {
    const { pen: other } = build(g, VAT, second);
    graze(g, [pen, other], PER_HEAD * 4);
    g.step(0.1);
    const live = g.layout.pens ?? [];
    eq(live.length, 2, 'two vats');
    for (const p of live) eq(g.penHeads(p), 2, 'sharing one deck two lines each');
    const trays = [...g.animals.values()].filter((a) => a.b === 0).map((a) => `${a.x},${a.z}`);
    eq(trays.length, 4, 'four trays between them');
    eq(new Set(trays).size, 4, 'and not one of them is standing on another vat\'s square');
  }
}

// What drives a tray is how much is STANDING READY, and never `penFill`. That
// function is how far through the batch now brewing, and it answers 0 when the
// pen is full — deliberately, because a progress bar sitting at the end over a
// pen that has stopped is the one readout that would lie. A tray staged on it
// empties itself at the exact moment the vat is fullest, which is art running
// backwards on the one machine you are being told to go and empty.
//
// Asserted through `snapshot` rather than off the record, which is this file's
// own named-field trap: what the sim writes and what reaches the client are two
// pieces of code, and only one of them is obvious.
{
  const g = fresh();
  const { pen } = build(g, VAT);
  graze(g, pen, PER_HEAD * 2);
  g.step(0.1);
  const wire = () => (g.snapshot().animals ?? []).filter((a) => a.b === 0);
  for (const a of wire()) eq(a.t, 0, 'an empty vat draws its trays empty');

  skipMinutes(g, EVERY * 40);
  g.step(0.1);
  const live = only(g);
  eq(live.qty, g.penCap(live), 'wind it on and the vat is standing full');
  eq(g.penFill(live), 0, 'so the batch bar is back at nothing');
  const full = wire();
  eq(full.length, 2, 'two trays');
  for (const a of full) eq(a.t, 1, 'and both of them full — the stockpile, not the batch');
}

// A re-flow parks the trays the way it parks the herd, which matters more here
// rather than less: build mode re-flows on every wall segment of a drag, and a
// rack that was re-dealt each time would shuffle itself across the deck while
// you drew a wall. Nothing about any of it is on the save, and the layout record
// a re-flow rebuilds says nothing about it either.
{
  const g = fresh();
  const { pen } = build(g, VAT);
  graze(g, pen, PER_HEAD * 3);
  for (let i = 0; i < 200; i++) g.step(0.1);
  const before = [...g.animals.values()].map((a) => `${a.id}@${a.x},${a.z}`).sort();
  eq(before.length, 4, 'three trays and a tender');

  g.regenerateLayout();
  g.regenerateLayout();
  eq([...g.animals.values()].map((a) => `${a.id}@${a.x},${a.z}`).sort().join('|'), before.join('|'),
    'and two re-flows move none of them');

  const saved = JSON.stringify(g.saveState());
  check(!saved.includes('"animals"'), 'the save says nothing about any of them');
  check(!saved.includes('"bodies"'), 'nor about what stands in the field, which is the piece\'s business');
  check(only(g).bodies === undefined, 'nor does the layout record the re-flow rebuilds');
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\nverify:pens — ${failures.length} of ${checks} assertions FAILED\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\nverify:pens — ${checks} assertions\n`);
console.log('  ✅  an animal is a building, it fills up, and it stops.\n');
