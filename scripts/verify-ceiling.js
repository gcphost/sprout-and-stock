#!/usr/bin/env node
/**
 * VERIFY: THE SECOND STOREY.
 *
 * A conveyor that hangs from the roof, so a run can cross the shop without
 * spending the shop floor on it — docs/belts.md step 8. `deck` is a field on
 * the placement rather than four new kinds, a ceiling cell stamps no tile and
 * occupies no walk grid, and a `lift` is the one cell that spans both storeys.
 *
 * EVERYTHING HERE IS INVISIBLE TWICE OVER, which is why it exists. A crate that
 * rode a duct and one a hire carried are the same box on the same shelf, and the
 * shop afterwards is the same shop; only the aisle it did not cross moved. And a
 * duct four metres up is drawn against a floor the camera can see straight
 * through, so a box on the WRONG storey and a box on the right one are, from a
 * chair, the same box — which is how the feature's worst bug shipped: a junction
 * overhead handed its crates to whatever floor run happened to be under it, and
 * they arrived on the correct shelf.
 *
 * What it guards:
 *
 * - **The control, doubled.** A shop that never laid an overhead cell and a
 *   shop that never built a lift are both the old game — no tile moved, no walk
 *   grid moved, and a floor run's flow, lines and lengths are what they always
 *   were. Every save in existence is one of those, so a control that is wrong
 *   has quietly changed all of them.
 * - **Two storeys do not merge.** A duct laid directly over a run is the case
 *   this whole feature is bought for, and the one line that makes it work is
 *   that a neighbour must match deck. Without it a box changes storey at every
 *   crossing, which draws as a conveyor that teleports — and looks, from above,
 *   exactly like a conveyor that works.
 * - **A ceiling cell gives the square back**, which is the entire pitch: no
 *   tile stamp, nothing blocked, still walkable, and a belt may still be laid
 *   on the floor underneath it. And because there IS no tile stamp up there, the
 *   only thing refusing a second overhead run on one square is the explicit
 *   branch in `canPlace` — the same trap `verify:catalog` asserts about every
 *   walk-over kind, one storey up.
 * - **A lift's direction is DERIVED**, never stored, because `rot` is the field
 *   the R key clears. Its centrepiece is the bug the handoff could not fix: a
 *   shaft fed only by a LOADER. The direction used to be resolved in the flow
 *   map's own seeding loop, where the only feeder safe to ask was one that knew
 *   its own mind — so a lift at the end of a duct with a loader on it fell
 *   through to "up off the floor" and a crate sat on it for ever. Not a crash
 *   and nothing logged: a box that will not come down.
 * - **A crate rides the shaft**, which is the one claim here a player could
 *   actually watch and the one that shipped half-right. Sampled every tick: a
 *   box part way between storeys must be on the lift's own square. Going UP it
 *   always was; coming DOWN it stepped off the end of the duct into thin air,
 *   descended beside the shaft and slid along the floor to it. Half of it looked
 *   perfect, which is why it lasted.
 * - **…and the two numbers measuring that ride agree.** A crate's whole state
 *   is one distance and the polyline is what turns it into somewhere in the
 *   shop, so `dist[i]` has to be the arc length of `pts` up to cell `i`. They
 *   were built by two pieces of code and disagreed: the riser was charged and
 *   never drawn, so the box was handed two tiles of travel to spend on a leg
 *   1.41 long and flew the diagonal anyway.
 * - **A T overhead.** The user's report, and it is two claims. That a junction
 *   in a duct hands its boxes on at all — every way out of it, over enough of
 *   them — and that NOT ONE of them arrives downstairs. The second is the one a
 *   shop with bare floor under it can never show you.
 * - **An overhead loader serves the one cell BENEATH it**, and not the four
 *   beside it. That is what keeps a ceiling run from being a floor run that
 *   costs no floor, and it is a claim about shelves that were NOT stocked.
 * - **A re-flow keeps the storey.** Build mode re-flows on every wall segment
 *   of a drag, and `repositionFixture` names every field it keeps — so a deck
 *   left out of either does not fail to copy, it RESETS, and one cell of your
 *   duct drops to the floor through a shelf.
 * - **Conservation**, at every hop, because a new place goods move between has
 *   been a hole every single time in this game.
 *
 * ...and since step 9, when the same square became a way OUT rather than only a
 * place to be:
 *
 * - **The rise is CHOSEN**, which is the sharpest control in this file. Up is a
 *   fifth exit, and the moment it exists the two networks section 3 keeps apart
 *   can touch by default — laying a duct across the shop would silently join it
 *   to every run it crossed. So a plain belt never looks up, a loader with a run
 *   in front of it never looks up, and the only two that do are a junction and a
 *   loader that has run out of aisle. The three are asserted in one shop that
 *   differs by nothing else.
 * - **The endcap, three ways.** A loader at the end of a line with a duct over
 *   it sends its box UP; with no duct it comes off onto the ground exactly as it
 *   did before; and with a shelf in front of it the shelf is stocked and nothing
 *   rises at all. That ordering is not decoration — the rise sits between the
 *   units and the ground drop in `armSwing`'s ladder, and below the ground drop
 *   it would be dead code in every shop, because every loader in every shop has
 *   walkable floor beside it.
 * - **A junction sorts up, and a keen line still wins.** The pair, because
 *   either half alone is satisfied by the bug: a rise that could outrank a line
 *   which will take the goods is the `homeFull` spread bug wearing a storey, and
 *   every box that DID arrive would arrive correctly.
 * - **No column, and it comes down again.** Two cells over one square are the
 *   most that can exist and the one thing they must not be is a run — left
 *   unguarded the floor cell hands up, the ceiling cell hands down, for ever,
 *   which does not error and does not spill. Paired with a ring that changes
 *   storey twice, because a return leg that only goes up is a way of losing
 *   stock on the roof.
 *
 * Runs on ephemeral Games. It writes one item row and four fixture rows into
 * the content database — usually the live shared one — and removes them on exit.
 *
 *   node scripts/verify-ceiling.js
 */

import { Game } from '../server/sim/index.js';
import { writeContent, refresh } from '../server/content.js';
import { remove } from '../server/db.js';
import { MILESTONES } from '../server/sim/goals.js';
import {
  canPlace, anchorTile, isWalkableTile, edgeAt, conveyorAt, conveyorNext, conveyorLines,
  conveyorMeets, conveyorsOf, conveyorBranches, armReach, deckOf, CEILING,
} from '../shared/build.js';
import { lotTotal } from '../shared/lot.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const near = (a, b, label, eps = 1e-6) => check(Math.abs(a - b) <= eps, label,
  `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SHOP = { shelf: 4, freezer: 0, warmer: 0, checkout: 1, plot: 0, stations: [] };

/** Shelf-stable, so nothing in here turns on spoilage by accident. */
const GOODS = {
  id: 'zz-ceil-good', name: 'Test Crackers', category: 'ambient',
  tags: ['shelf-stable', 'cheap'], base_cost: 1, base_price: 3, shelf_life_days: 300,
};
/**
 * Its own pieces rather than the shipped ones, for `verify:belts`' reason: a
 * sweep measured against whatever somebody authored this afternoon is a sweep
 * whose numbers move when the art does.
 */
const BELT = {
  id: 'zz-ceil-belt', kind: 'belt', name: 'Test Belt', cost: 10,
  model: { parts: [{ shape: 'box', color: '#3b3f46', pos: [0, 0.06, 0], scale: [1, 0.03, 0.26] }] },
  tiers: [{ name: 'Standard', cost: 0 }],
};
const ARM = {
  id: 'zz-ceil-arm', kind: 'arm', name: 'Test Loader', cost: 50,
  model: { parts: [{ shape: 'box', color: '#6b7280', pos: [0, 0.4, 0], scale: [0.4, 0.8, 0.4] }] },
  tiers: [{ name: 'Standard', cost: 0 }],
};
const SORTER = {
  id: 'zz-ceil-sorter', kind: 'sorter', name: 'Test Junction', cost: 70,
  model: { parts: [{ shape: 'box', color: '#6b7280', pos: [0, 0.2, 0], scale: [1, 0.4, 1] }] },
  tiers: [{ name: 'Standard', cost: 0 }],
};
const LIFT = {
  id: 'zz-ceil-lift', kind: 'lift', name: 'Test Lift', cost: 90,
  model: { parts: [{ shape: 'box', color: '#4e5866', pos: [0, 0.9, 0], scale: [0.8, 1.8, 0.8] }] },
  tiers: [{ name: 'Standard', cost: 0 }],
};

for (const row of [BELT, ARM, SORTER, LIFT]) writeContent('fixture', row, 'verify');
writeContent('item', GOODS, 'verify');
refresh();
const cleanup = () => {
  for (const row of [BELT, ARM, SORTER, LIFT]) remove('fixtures', row.id);
  remove('items', GOODS.id);
};
process.on('exit', cleanup);

const PIECE = {
  belt: BELT.id, arm: ARM.id, sorter: SORTER.id, lift: LIFT.id,
};

function fresh() {
  const g = Game.create({ worldId: 'verify-ceiling', seed: 'ceiling', ephemeral: true });
  g.placements = [];
  g.grow = { w: 0, h: 0 };
  g.doorShift = 0;
  g.edits = [];
  g.ground = [];
  g.yardStamped = false;
  // `shell` and `ownedUpgrades` for the reason CLAUDE.md gives about `fresh()`.
  g.shell = null;
  g.ownedUpgrades = [];
  g.roster = [];
  g.regenerateLayout(null, {}, { want: SHOP });
  g.freezeShell();
  g.freezeYard();
  for (const m of MILESTONES) g.milestones.done.push(m.id);
  g.orders.auto = false;
  g.orders.assign = false;
  g.orders.items = {};
  g.orders.dropped = {};
  g.orders.pending = [];
  g.deliveries = [];
  g.cash = 500000;
  g.open = false;
  for (const sh of g.layout.shelves ?? []) sh.stacks = [];
  g.addPlayer('me', 'Tester');
  g.players.me.build = { on: true };
  return g;
}

const run = (g, ticks) => { for (let i = 0; i < ticks; i++) g.step(0.1); };
/** Every unit of stock anywhere, for conservation. */
const units = (g) => g.deliveries.reduce((n, d) => n + lotTotal(d), 0)
  + (g.layout.shelves ?? []).reduce((n, s) => n
    + (s.stacks ?? []).reduce((m, st) => m + (st.qty ?? 0), 0), 0);

/**
 * Put a piece down through the real build verb.
 *
 * Never by writing `layout.belts` — a helper that did would pass while every
 * real press was refused, which is the trap `verify:ferry` names about
 * `setBackOfHouse` and the reason this sweep can say anything about `canPlace`
 * at all.
 */
function put(g, spec) {
  const res = g.placeFixture('me', { piece: PIECE[spec.kind], ...spec });
  check(res.ok, `a ${spec.kind} goes ${spec.deck ? 'overhead' : 'down'} at ${spec.x},${spec.z}`, res.error ?? '');
  return g.beltAt(spec.x, spec.z, spec.deck === CEILING ? CEILING : 0);
}

/**
 * A straight east-west row of `n` cells where a floor run, a ceiling run AND a
 * lift are all legal.
 *
 * Searched rather than written down: which part of the shop is indoors is a
 * fact about the generated shell, and a duct needs a roof over it.
 */
function roofRow(g, n) {
  for (let z = 1; z < g.layout.h - 1; z++) {
    for (let x = 1; x + n < g.layout.w - 1; x++) {
      const cells = [];
      for (let i = 0; i < n; i++) cells.push({ x: x + i, z });
      const ok = cells.every((c) => canPlace(g.layout, { kind: 'belt', x: c.x, z: c.z, rot: 0 }).ok
        && canPlace(g.layout, { kind: 'lift', x: c.x, z: c.z, rot: 0 }).ok
        && canPlace(g.layout, { kind: 'belt', x: c.x, z: c.z, rot: 0, deck: CEILING }).ok);
      if (ok) return cells;
    }
  }
  return null;
}

/** A crate of `qty` standing on a conveyor cell, put there the way a loader would. */
function crateOn(g, cell, qty = 4) {
  const crate = g.dropGoods(GOODS.id, qty, { x: cell.x, z: cell.z }, { exact: true });
  check(!!crate, 'the test crate exists');
  check(g.loadBelt(cell, crate), 'and it goes onto the run');
  return crate;
}

/** Where a crate is, as the three numbers the whole subsystem turns on. */
const spot = (d) => ({ x: d.x, z: d.z, deck: d.deck ?? 0 });

// ---------------------------------------------------------------------------
// 1. THE CONTROL, HALF ONE: a shop that never laid an overhead cell.
//
// Every save in existence is this shop. If the two new fields cost it anything
// at all, the whole step has quietly rebalanced the game rather than added to
// it — which is the assertion, and it is the reason it goes first.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  eq((g.layout.lifts ?? []).length, 0, 'a fresh shop owns no lifts');
  const row = roofRow(g, 4);
  check(!!row, 'there is somewhere under the roof to lay a run');

  const before = JSON.stringify({ t: g.layout.tiles, b: g.layout.blocked, i: g.layout.indoor });
  const cells = row.map((c) => put(g, { kind: 'belt', x: c.x, z: c.z, rot: 0 }));
  eq(cells.every((c) => deckOf(c) === 0), true, 'and every cell of it is on the floor');

  // The flow map and the lines are what the whole subsystem is derived from, so
  // "unchanged" is said about those rather than about a picture.
  for (let i = 0; i < cells.length - 1; i++) {
    const to = conveyorNext(g.layout, cells[i]);
    eq(`${to?.x},${to?.z},${deckOf(to)}`, `${cells[i + 1].x},${cells[i + 1].z},0`,
      'a floor run still hands along the floor');
  }
  const net = conveyorLines(g.layout);
  eq(net.lines.length, 1, 'and a straight run is still one line');
  eq(net.lines[0].len, cells.length - 1, 'of exactly its own length in tiles');
  eq(net.lines[0].pts.length, cells.length, 'with one point per cell and no riser in it');

  // A loader on the floor still reaches all four sides — the other half of the
  // control, and the one `armReach` could have got wrong for every shop at once.
  const arm = put(g, { kind: 'arm', x: row[1].x, z: row[1].z, rot: 0 });
  eq(armReach(arm).length, 4, 'a floor loader still reaches four sides');

  const after = JSON.stringify({ t: g.layout.tiles, b: g.layout.blocked, i: g.layout.indoor });
  check(before !== after, 'a floor run does change the ground (it stamps T.BELT)');
}

// ---------------------------------------------------------------------------
// 2. THE CONTROL, HALF TWO: a ceiling cell gives the square back.
//
// The pitch of the whole storey, said as a comparison rather than as a value:
// laying a duct over a square must move NOTHING about that square. Not the
// tile, not the walk grid, not whether you can still build on it.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const row = roofRow(g, 4);
  const at = row[1];

  const before = JSON.stringify({ t: g.layout.tiles, b: g.layout.blocked, i: g.layout.indoor });
  const duct = put(g, { kind: 'belt', x: at.x, z: at.z, rot: 0, deck: CEILING });
  eq(deckOf(duct), CEILING, 'the cell knows which storey it is on');
  const after = JSON.stringify({ t: g.layout.tiles, b: g.layout.blocked, i: g.layout.indoor });
  eq(after, before, 'and the ground under it is byte-identical');
  eq(isWalkableTile(g.layout, at.x, at.z), true, 'you can still walk under your own duct');

  // ...and still build on it. A run that cost you the floor it crosses is a run
  // with no reason to be up there.
  eq(canPlace(g.layout, { kind: 'belt', x: at.x, z: at.z, rot: 0 }).ok, true,
    'and lay a belt on the floor beneath it');
  eq(canPlace(g.layout, { kind: 'shelf', x: at.x, z: at.z, rot: 0 }).ok, true,
    'and stand a shelf under it');

  // WHICH IS WHY THE SECOND ONE HAS TO BE REFUSED EXPLICITLY. There is no tile
  // stamp overhead and a belt blocks nobody, so nothing else in `canPlace` is
  // standing between a duct and an unlimited stack of them on one square.
  const twice = canPlace(g.layout, { kind: 'belt', x: at.x, z: at.z, rot: 0, deck: CEILING });
  eq(twice.ok, false, 'a second run on the same overhead square is refused');
  eq((g.layout.belts ?? []).filter((b) => b.x === at.x && b.z === at.z && deckOf(b) === CEILING).length,
    1, 'and there is exactly one up there');

  // The two rules that DO apply overhead, and nothing else does.
  eq(canPlace(g.layout, { kind: 'shelf', x: row[2].x, z: row[2].z, rot: 0, deck: CEILING }).ok, false,
    'only a conveyor may hang from the roof');
  let outside = null;
  for (let x = 1; x < g.layout.w - 1 && !outside; x++) {
    for (let z = 1; z < g.layout.h - 1; z++) {
      if (canPlace(g.layout, { kind: 'belt', x, z, rot: 0, deck: CEILING }).ok) continue;
      if (canPlace(g.layout, { kind: 'belt', x, z, rot: 0 }).reason) continue;
      outside = { x, z };
      break;
    }
  }
  if (outside) {
    eq(canPlace(g.layout, { kind: 'belt', ...outside, rot: 0, deck: CEILING }).ok, false,
      'and a duct needs a roof over it');
  }
}

// ---------------------------------------------------------------------------
// 3. TWO STOREYS DO NOT MERGE, which is the one line a second storey IS.
//
// A duct laid directly over a run is the build the whole feature is bought for.
// Leave the deck out of one neighbour test and the two networks silently become
// one: boxes change storey at every crossing, which draws as a conveyor that
// teleports and reads, from a chair, as a conveyor that works.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const row = roofRow(g, 5);
  // The floor run goes EAST and the duct over it goes WEST, so a leak in either
  // direction is a crate travelling the wrong way rather than a subtle one.
  const floor = row.map((c) => put(g, { kind: 'belt', x: c.x, z: c.z, rot: 0 }));
  const roof = row.map((c) => put(g, { kind: 'belt', x: c.x, z: c.z, rot: 2, deck: CEILING }));

  for (const c of floor) {
    eq(deckOf(conveyorNext(g.layout, c)), 0, 'a floor cell hands along the floor');
  }
  for (const c of roof) {
    eq(deckOf(conveyorNext(g.layout, c)), CEILING, 'and a duct cell hands along the duct');
  }
  const net = conveyorLines(g.layout);
  eq(net.lines.length, 2, 'two runs over one another are two lines');
  for (const line of net.lines) {
    eq(new Set(line.cells.map(deckOf)).size, 1, 'and no line straddles the two');
  }

  // ...and the boxes. One per storey, travelling opposite ways, sampled every
  // tick: neither may ever be found on the other's deck.
  const east = crateOn(g, floor[0]);
  const west = crateOn(g, roof[roof.length - 1]);
  let leaked = 0;
  for (let i = 0; i < 200; i++) {
    g.step(0.1);
    if ((east.deck ?? 0) !== 0) leaked++;
    if ((west.deck ?? 0) !== CEILING) leaked++;
  }
  eq(leaked, 0, 'and neither box ever changes storey');
  check(east.x > floor[0].x, 'the floor box went east', `at ${east.x}`);
  check(west.x < roof[roof.length - 1].x, 'the duct box went west', `at ${west.x}`);
}

// ---------------------------------------------------------------------------
// 4. THE LIFT'S DIRECTION IS DERIVED, and the loader case is the centrepiece.
//
// A shaft has no `rot` and wants none: up and down are not quarter turns, and a
// stored direction is a field the R key clears. So it runs whichever way the
// goods already are — and until now it could only read a feeder that knew its
// own mind, because asking a loader from inside the flow map's seeding loop is
// unbounded recursion. A lift at the end of a duct with a LOADER on it
// therefore always guessed "up", and what that reads as is a box that will not
// come down.
// ---------------------------------------------------------------------------
for (const feeder of ['belt', 'arm']) {
  // Up: floor run → lift → duct.
  {
    const g = fresh();
    const row = roofRow(g, 6);
    const z = row[0].z;
    const x0 = row[0].x;
    put(g, { kind: 'belt', x: x0, z, rot: 0 });
    const feed = put(g, { kind: feeder, x: x0 + 1, z, rot: 0 });
    if (feeder === 'arm') g.setArmMode('me', feed.id, 'load');
    const lift = put(g, { kind: 'lift', x: x0 + 2, z, rot: 0 });
    put(g, { kind: 'belt', x: x0 + 3, z, rot: 0, deck: CEILING });

    const to = conveyorNext(g.layout, lift);
    eq(deckOf(to), CEILING, `a shaft fed by a floor ${feeder} carries UP`);
    eq(`${to?.x},${to?.z}`, `${x0 + 3},${z}`, 'to the duct cell beside it');
  }
  // Down: duct → lift → floor run. The half that was broken.
  {
    const g = fresh();
    const row = roofRow(g, 6);
    const z = row[0].z;
    const x0 = row[0].x;
    put(g, { kind: 'belt', x: x0, z, rot: 0, deck: CEILING });
    const feed = put(g, { kind: feeder, x: x0 + 1, z, rot: 0, deck: CEILING });
    if (feeder === 'arm') g.setArmMode('me', feed.id, 'load');
    const lift = put(g, { kind: 'lift', x: x0 + 2, z, rot: 0 });
    put(g, { kind: 'belt', x: x0 + 3, z, rot: 0 });

    const to = conveyorNext(g.layout, lift);
    eq(deckOf(to), 0, `a shaft fed by an overhead ${feeder} carries DOWN`);
    eq(`${to?.x},${to?.z}`, `${x0 + 3},${z}`, 'to the floor cell beside it');
  }
}

// ---------------------------------------------------------------------------
// 4b. …AND THE ONE CASE THE DERIVATION CANNOT GET RIGHT: fed from BOTH.
//
// A floor run and a duct arriving on the same square is how the two levels of
// one loop rejoin, and there is no answer to derive there — `liftTo` takes the
// floor's arbitrarily, so half the shops that build it get a shaft lifting
// crates away from the run they were trying to merge into. Nothing is wrong on
// screen: the lift is aimed correctly, because a lift is not aimed at all.
//
// So `way` is a setting on the placement, and it is NOT `rot`: up and down are
// not quarter turns, and `rot` is the field R clears. Its control is the third
// state — `null`, which is every shaft ever built and derives exactly as it did.
//
// The PASS-THROUGH is the half that costs nothing and is asserted here rather
// than argued: a shaft told DOWN hands to a floor cell beside it, so a crate
// that arrived along the floor carries straight on into that cell while one
// that arrived overhead descends into the same one.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const row = roofRow(g, 5);
  const z = row[0].z;
  const x0 = row[0].x;
  // Two runs east into one shaft, and one run east out of it on the floor.
  const lowIn = put(g, { kind: 'belt', x: x0, z, rot: 0 });
  const highIn = put(g, { kind: 'belt', x: x0, z, rot: 0, deck: CEILING });
  put(g, { kind: 'belt', x: x0 + 1, z, rot: 0 });
  put(g, { kind: 'belt', x: x0 + 1, z, rot: 0, deck: CEILING });
  const lift = put(g, { kind: 'lift', x: x0 + 2, z, rot: 0 });
  const outLow = put(g, { kind: 'belt', x: x0 + 3, z, rot: 0 });
  put(g, { kind: 'belt', x: x0 + 3, z, rot: 0, deck: CEILING });

  eq((g.layout.lifts ?? [])[0]?.way ?? null, null, 'a new shaft is told nothing');
  // The control. Fed from both, the derivation answers — whichever way it
  // answers — and the assertion is that setting it CHANGES that, not that the
  // default is any particular thing.
  const derived = conveyorNext(g.layout, lift);
  check(!!derived, 'and it still works something out');

  const said = g.setLiftWay('me', lift.id, 'down');
  check(said.ok, 'a shaft can be told to carry down', said.error ?? '');
  const down = conveyorNext(g.layout, (g.layout.lifts ?? [])[0]);
  eq(deckOf(down), 0, 'and it does');
  eq(`${down?.x},${down?.z}`, `${outLow.x},${outLow.z}`, 'onto the floor run beside it');

  // R IS STILL A DEAD KEY, and this is the trap the setting had to dodge:
  // `repositionFixture` names every field it keeps, so a `way` left out of that
  // list does not fail to copy — it RESETS, on the one press that is meant to
  // do nothing to a shaft at all.
  g.rotateFixture('me', (g.layout.lifts ?? [])[0].id);
  eq((g.layout.lifts ?? [])[0]?.way ?? null, 'down', 'and turning it does not forget');
  // ...nor does an ordinary re-flow, which fires on every wall segment of a drag.
  g.regenerateLayout();
  eq((g.layout.lifts ?? [])[0]?.way ?? null, 'down', 'nor does a re-flow');

  // THE MERGE. One box down each run; both must come off on the floor, and
  // neither may end up on the duct.
  const held = units(g);
  const fromLow = crateOn(g, lowIn, 2);
  const fromHigh = crateOn(g, highIn, 3);
  let strayed = 0;
  for (let i = 0; i < 400; i++) {
    g.step(0.1);
    if ((fromLow.deck ?? 0) > 1e-6) strayed++;
  }
  eq(strayed, 0, 'a crate already on the floor never goes up through the shaft');
  eq(spot(fromLow).deck, 0, 'it passes straight through onto the far run');
  check(fromLow.x > lift.x, 'and out the other side', `at ${fromLow.x}`);
  eq(spot(fromHigh).deck, 0, 'and the one off the duct comes down to join it');
  check(fromHigh.x > lift.x, 'on the same run', `at ${fromHigh.x}`);
  eq(units(g), held + 5, 'with nothing created or destroyed on either journey');

  // ...and the other way, on its own shop, or "it obeys" is satisfied by a
  // setting that happens to name what the derivation already said.
  const g2 = fresh();
  const row2 = roofRow(g2, 5);
  const z2 = row2[0].z;
  const x2 = row2[0].x;
  put(g2, { kind: 'belt', x: x2, z: z2, rot: 0 });
  put(g2, { kind: 'belt', x: x2, z: z2, rot: 0, deck: CEILING });
  put(g2, { kind: 'belt', x: x2 + 1, z: z2, rot: 0 });
  put(g2, { kind: 'belt', x: x2 + 1, z: z2, rot: 0, deck: CEILING });
  const lift2 = put(g2, { kind: 'lift', x: x2 + 2, z: z2, rot: 0 });
  put(g2, { kind: 'belt', x: x2 + 3, z: z2, rot: 0 });
  const outHigh = put(g2, { kind: 'belt', x: x2 + 3, z: z2, rot: 0, deck: CEILING });
  check(g2.setLiftWay('me', lift2.id, 'up').ok, 'a shaft can be told to carry up');
  const up = conveyorNext(g2.layout, (g2.layout.lifts ?? [])[0]);
  eq(`${up?.x},${up?.z},${deckOf(up)}`, `${outHigh.x},${outHigh.z},${CEILING}`,
    'and it carries up whatever is feeding it');

  // ...and handing the decision back puts it where it was.
  check(g2.setLiftWay('me', (g2.layout.lifts ?? [])[0].id, null).ok, 'and it can be un-told');
  eq((g2.layout.lifts ?? [])[0]?.way ?? null, null, 'which is the state every shaft starts in');
}

// ---------------------------------------------------------------------------
// 5. …and the three ways a shaft is allowed to answer NOTHING.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const row = roofRow(g, 6);
  const z = row[0].z;
  const x0 = row[0].x;
  put(g, { kind: 'belt', x: x0, z, rot: 0 });
  const lone = put(g, { kind: 'lift', x: x0 + 1, z, rot: 0 });
  // A shaft with nothing on the far deck is a TERMINUS. Its own square up there
  // is the lift again — it answers `conveyorAt` on both storeys — so an answer
  // of "straight up" would be a cell whose next is its own id: nothing errors,
  // the box arrives where it already is, and every walk over the run walks that
  // one cell until the tick loop stops.
  eq(conveyorNext(g.layout, lone), null, 'a half-built shaft hands to nobody');
  eq(conveyorAt(g.layout, lone.x, lone.z, CEILING)?.id, lone.id,
    'even though it answers for its own square on both storeys');

  // ...and it never picks itself once there IS something up there.
  const up = put(g, { kind: 'belt', x: x0 + 2, z, rot: 0, deck: CEILING });
  const to = conveyorNext(g.layout, lone);
  check(to && !(to.x === lone.x && to.z === lone.z), 'and never hands to its own square',
    JSON.stringify(to));
  eq(`${to?.x},${to?.z},${deckOf(to)}`, `${up.x},${up.z},${CEILING}`, 'but to the duct beside it');

  // R IS A DEAD KEY ON A SHAFT, which is why the direction is derived. Turning
  // one must not change which way it carries, and must not drop it downstairs.
  const was = JSON.stringify(conveyorNext(g.layout, lone));
  const spun = g.rotateFixture('me', lone.id);
  check(spun.ok || !!spun.error, 'a lift answers the R key one way or the other');
  const still = (g.layout.lifts ?? []).find((f) => f.x === lone.x && f.z === lone.z);
  check(!!still, 'and it is still standing there afterwards');
  eq(JSON.stringify(conveyorNext(g.layout, still)), was, 'carrying exactly the way it did');
}

// ---------------------------------------------------------------------------
// 6. THE RIDE. The one claim here anybody can watch, and the one that shipped
//    right in one direction and wrong in the other.
//
// A lift hands to a cell BESIDE it on the other storey, so the leg from one to
// the other changes x, z and deck at once — and a polyline interpolates a leg.
// Left as one, the box flies the diagonal: up and over, through the wall of its
// own shaft. So a riser goes in, over the SHAFT'S square, and which of the pair
// that is depends on which way the goods are going. Put on the near cell
// always, a box going up rises correctly and a box coming down steps off the
// end of the duct into thin air.
// ---------------------------------------------------------------------------
for (const dir of ['up', 'down']) {
  const g = fresh();
  const row = roofRow(g, 6);
  const z = row[0].z;
  const x0 = row[0].x;
  const from = dir === 'up' ? 0 : CEILING;
  const far = dir === 'up' ? CEILING : 0;
  for (let i = 0; i < 3; i++) put(g, { kind: 'belt', x: x0 + i, z, rot: 0, deck: from });
  const lift = put(g, { kind: 'lift', x: x0 + 3, z, rot: 0 });
  for (let i = 4; i < 6; i++) put(g, { kind: 'belt', x: x0 + i, z, rot: 0, deck: far });

  // The two numbers first. A crate's whole state is one distance, `pts` is what
  // turns it into somewhere in the shop, and `dist[i]` is what every reader
  // treats as the arc length up to cell `i`. They were built by two pieces of
  // code and disagreed by exactly the riser.
  for (const line of conveyorLines(g.layout).lines) {
    let walked = 0;
    let at = 0;
    for (let i = 1; i < line.pts.length; i++) {
      const a = line.pts[i - 1];
      const b = line.pts[i];
      walked += Math.hypot(b.x - a.x, b.z - a.z, deckOf(b) - deckOf(a));
      // Whenever the polyline reaches a cell's own square, that is the cell the
      // distance table is about.
      const cell = line.cells[at + 1];
      if (cell && b.x === cell.x && b.z === cell.z && deckOf(b) === deckOf(cell)) {
        at += 1;
        near(walked, line.dist[at], `${dir}: dist and pts measure the same journey`);
      }
    }
    eq(at, line.cells.length - 1, `${dir}: and the polyline visits every cell`);
  }

  const start = g.beltAt(x0, z, from);
  const crate = crateOn(g, start);
  const held = units(g);
  let offShaft = 0;
  let backwards = 0;
  let jumped = 0;
  let rode = 0;
  let last = spot(crate);
  for (let i = 0; i < 200; i++) {
    g.step(0.1);
    const now = spot(crate);
    /**
     * THE CENTREPIECE. Part way between two storeys, a box is in the shaft —
     * and the shaft is one square. Anywhere else is a crate hanging in the
     * middle of the aisle, which is the only thing in this whole file a
     * screenshot could have caught and the reason it is checked every tick
     * rather than at the ends.
     */
    if (now.deck > 1e-6 && now.deck < 1 - 1e-6) {
      rode++;
      if (Math.abs(now.x - lift.x) > 1e-6 || Math.abs(now.z - lift.z) > 1e-6) offShaft++;
    }
    // ...and continuity, deck included. Nothing goes backwards along the run and
    // nothing steps further than a tick of travel — the claim `verify:belts`
    // makes about a straight, said about the one hop that changes storey.
    if (now.x - last.x < -1e-6) backwards++;
    const step = Math.hypot(now.x - last.x, now.z - last.z, now.deck - last.deck);
    if (step > 0.35) jumped++;
    last = now;
  }
  check(rode > 0, `${dir}: the box is caught part way between storeys`, `${rode} ticks`);
  eq(offShaft, 0, `${dir}: and every one of those is over the shaft's own square`);
  eq(backwards, 0, `${dir}: it never goes back the way it came`);
  eq(jumped, 0, `${dir}: and never skips`);
  eq(spot(crate).deck, far, `${dir}: it ends up on the far storey`);
  check(crate.x > x0 + 3, `${dir}: past the shaft`, `at ${crate.x}`);
  eq(units(g), held, `${dir}: and nothing is created or destroyed on the way`);
}

// ---------------------------------------------------------------------------
// 7. A T OVERHEAD, which is the report this sweep was written for.
//
// Two claims, and the second is the one a shop with bare floor under the duct
// can never show you. Every way out of a junction is a hand-off between two
// LINES — a sorter is a line of its own by construction — and a hand-off is
// resolved by looking the destination cell up. Looked up without a storey, that
// read the FLOOR: with nothing underneath, the box parked on the last cell for
// the rest of the save, and with a run underneath it dropped four metres onto
// it and carried on being a perfectly ordinary crate on a perfectly ordinary
// belt. Nothing logs a word either way.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  // A cross of roof with a run laid on the floor straight through the middle of
  // it, which is what makes the second claim provable rather than vacuous.
  let mid = null;
  for (let z = 2; z < g.layout.h - 2 && !mid; z++) {
    for (let x = 2; x < g.layout.w - 2; x++) {
      const arms = [{ x: x - 1, z }, { x, z }, { x: x + 1, z }, { x, z: z + 1 }];
      // ...and the two floor runs the exits hang over, which reach one cell
      // further than the duct does — see the decoy below.
      const under = [{ x: x + 1, z }, { x: x + 2, z }, { x, z: z + 1 }, { x, z: z + 2 }];
      const ok = arms.every((c) => canPlace(g.layout, { kind: 'belt', x: c.x, z: c.z, rot: 0, deck: CEILING }).ok)
        && under.every((c) => canPlace(g.layout, { kind: 'belt', x: c.x, z: c.z, rot: 0 }).ok);
      if (ok) { mid = { x, z }; break; }
    }
  }
  check(!!mid, 'there is a cross of roof to build a junction under');

  /**
   * The floor decoy, first — and WHERE it goes changed with step 9.
   *
   * It used to run straight through the junction's own square, which was the
   * sharpest possible version of this claim while a duct and the aisle under it
   * were two networks that could not touch. Step 9 makes the square below a
   * junction its fifth way out, so a floor belt there is no longer a decoy: it
   * is a connection, and a deliberate one. Section 10 is that build asserted as
   * a feature.
   *
   * What this section is actually about survives intact, because the bug it was
   * written for is a LOOKUP: every way out of a junction is a hand-off between
   * two lines, resolved by turning a way out back into a cell, and read without
   * a storey that answered the floor. So the decoy goes under the two EXITS —
   * the squares those lookups name — and not under the hub. Both branches still
   * have a floor cell waiting to catch a hand-off that forgot which deck it was
   * on, and the junction itself has nothing below it to be joined to.
   */
  const decoy = [
    put(g, { kind: 'belt', x: mid.x + 1, z: mid.z, rot: 0 }),
    put(g, { kind: 'belt', x: mid.x + 2, z: mid.z, rot: 0 }),
    put(g, { kind: 'belt', x: mid.x, z: mid.z + 1, rot: 1 }),
    put(g, { kind: 'belt', x: mid.x, z: mid.z + 2, rot: 1 }),
  ];
  eq(conveyorAt(g.layout, mid.x, mid.z, 0), null, 'and nothing on the floor under the hub');

  const feed = put(g, { kind: 'belt', x: mid.x - 1, z: mid.z, rot: 0, deck: CEILING });
  const tee = put(g, { kind: 'sorter', x: mid.x, z: mid.z, rot: 1, deck: CEILING });
  const east = put(g, { kind: 'belt', x: mid.x + 1, z: mid.z, rot: 0, deck: CEILING });
  const south = put(g, { kind: 'belt', x: mid.x, z: mid.z + 1, rot: 1, deck: CEILING });

  eq(deckOf(conveyorNext(g.layout, feed)), CEILING, 'the duct feeds the junction overhead');
  const ways = conveyorLines(g.layout).byCell.get(tee.id)?.line.outs ?? [];
  eq(ways.length, 2, 'and the junction has two ways out');
  eq(ways.every((w) => deckOf(w) === CEILING), true, 'both of them upstairs');

  // Enough boxes that the alternation has to have used both branches, and one
  // at a time so nothing here is about backpressure.
  const held0 = units(g);
  const arrived = new Set();
  let downstairs = 0;
  for (let n = 0; n < 6; n++) {
    const crate = crateOn(g, feed, 2);
    for (let i = 0; i < 120; i++) {
      g.step(0.1);
      // THE CLAIM. Not one box may ever be filed on a floor cell, and not one
      // may be drawn on the floor.
      if (decoy.some((c) => c.id === crate.belt)) downstairs++;
      if ((crate.deck ?? 0) !== CEILING) downstairs++;
      if (crate.belt === east.id || crate.belt === south.id) break;
    }
    if (crate.belt === east.id) arrived.add('east');
    if (crate.belt === south.id) arrived.add('south');
    // Off the run again, so the next one has a clear line rather than a queue.
    g.deliveries = g.deliveries.filter((d) => d.id !== crate.id);
  }
  eq(downstairs, 0, 'no box a ceiling junction sends ever arrives downstairs');
  eq(arrived.size, 2, 'and both branches of the T get one', [...arrived].join('+'));
  eq(units(g), held0, 'and the shop is neither richer nor poorer for it');
}

// ---------------------------------------------------------------------------
// 8. AN OVERHEAD LOADER SERVES THE ONE CELL BENEATH IT.
//
// Which is what stops a ceiling run being a floor run that costs no floor: a
// run down an aisle serves the units either side of every cell, a duct over the
// same aisle serves whatever it is directly above. One machine per unit against
// one per pair. The claim is mostly about the shelves that were NOT stocked,
// which is why it has a control standing beside it.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  // A shelf, a duct cell over it, and two more shelves either side of that.
  let site = null;
  for (let z = 2; z < g.layout.h - 2 && !site; z++) {
    for (let x = 2; x < g.layout.w - 2; x++) {
      const under = { x, z };
      const flank = [{ x, z: z - 1 }, { x, z: z + 1 }];
      const feedAt = { x: x - 1, z };
      const ok = [under, ...flank].every((c) => canPlace(g.layout, { kind: 'shelf', x: c.x, z: c.z, rot: 0 }).ok)
        && canPlace(g.layout, { kind: 'arm', x: under.x, z: under.z, rot: 0, deck: CEILING }).ok
        && canPlace(g.layout, { kind: 'belt', x: feedAt.x, z: feedAt.z, rot: 0, deck: CEILING }).ok;
      if (ok) { site = { under, flank, feedAt }; break; }
    }
  }
  check(!!site, 'there is a shelf-under-a-duct to build');

  const below = g.placeFixture('me', { kind: 'shelf', x: site.under.x, z: site.under.z, rot: 0 });
  check(below.ok, 'a shelf goes under the duct', below.error ?? '');
  for (const c of site.flank) {
    const res = g.placeFixture('me', { kind: 'shelf', x: c.x, z: c.z, rot: 0 });
    check(res.ok, 'and one either side of it', res.error ?? '');
  }

  const feed = put(g, { kind: 'belt', x: site.feedAt.x, z: site.feedAt.z, rot: 0, deck: CEILING });
  const arm = put(g, { kind: 'arm', x: site.under.x, z: site.under.z, rot: 0, deck: CEILING });
  // Looked up AFTER the last press rather than held from before it: every
  // placement re-flows, and a re-flow rebuilds `layout.shelves` — so a record
  // captured earlier is a copy of a unit nothing is stocking, and what it
  // reports for ever is zero.
  const at = (c) => (g.layout.shelves ?? []).find((s) => s.x === c.x && s.z === c.z);
  const under = at(site.under);
  const sides = site.flank.map(at);
  check(!!under && sides.every(Boolean), 'and all three are still standing');
  eq(armReach(arm).length, 1, 'an overhead loader reaches exactly one cell');
  eq(`${armReach(arm)[0].x},${armReach(arm)[0].z}`, `${arm.x},${arm.z}`, 'and it is the one beneath it');

  // ...and the run knows it. `conveyorMeets` is what every judgement downstream
  // is built on — a junction's keen test, the skip guard on a loader's lift —
  // and read four-ways it would report the flanks as served.
  const met = conveyorMeets(g.layout, feed);
  eq(met.shelves.length, 1, 'the run reports one unit served');
  eq(met.shelves[0]?.id, under.id, 'and it is the one under the loader');

  const crate = crateOn(g, feed, 6);
  const held = units(g);
  run(g, 400);
  const on = (u) => (u.stacks ?? []).reduce((n, st) => n + (st.qty ?? 0), 0);
  check(on(under) > 0, 'the shelf beneath it is stocked', `${on(under)} units`);
  eq(sides.reduce((n, u) => n + on(u), 0), 0, 'and the shelves either side are untouched');
  eq(units(g), held, 'with nothing created or destroyed');
}

// ---------------------------------------------------------------------------
// 9. A RE-FLOW KEEPS THE STOREY, both ways it can be triggered.
//
// Build mode re-flows on every wall segment of a drag, and `repositionFixture`
// builds a fresh placement naming every field it keeps — so a deck left out of
// either does not fail to copy, it RESETS. What that does is drop one cell of
// your duct to the floor, through whatever is standing there, and the press
// that does it is R.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const row = roofRow(g, 4);
  const cells = row.map((c) => put(g, { kind: 'belt', x: c.x, z: c.z, rot: 0, deck: CEILING }));
  const arm = put(g, { kind: 'arm', x: row[1].x, z: row[1].z, rot: 0, deck: CEILING });
  eq(deckOf(arm), CEILING, 'a loader hangs where it was put');

  g.regenerateLayout();
  const after = (g.layout.belts ?? []).filter((b) => deckOf(b) === CEILING);
  eq(after.length, cells.length - 1, 'a re-flow keeps every overhead belt overhead');
  eq((g.layout.arms ?? []).filter((a) => deckOf(a) === CEILING).length, 1,
    'and the loader with them');

  // ...and R, which is the press.
  const spun = g.rotateFixture('me', (g.layout.arms ?? [])[0].id);
  check(spun.ok, 'the loader turns', spun.error ?? '');
  eq((g.layout.arms ?? []).every((a) => deckOf(a) === CEILING), true,
    'and turning it does not drop it downstairs');

  // ...and a crate mid-ride is PARKED rather than restarted, which is
  // `verify:belts`' claim about a demolished belt said about a re-flow that
  // happens while a box is in the air.
  const g2 = fresh();
  const row2 = roofRow(g2, 6);
  const z2 = row2[0].z;
  const x2 = row2[0].x;
  for (let i = 0; i < 3; i++) put(g2, { kind: 'belt', x: x2 + i, z: z2, rot: 0 });
  put(g2, { kind: 'lift', x: x2 + 3, z: z2, rot: 0 });
  for (let i = 4; i < 6; i++) put(g2, { kind: 'belt', x: x2 + i, z: z2, rot: 0, deck: CEILING });
  const crate = crateOn(g2, g2.beltAt(x2, z2));
  const held = units(g2);
  for (let i = 0; i < 200; i++) {
    g2.step(0.1);
    if (i % 7 === 0) g2.regenerateLayout();
  }
  eq(spot(crate).deck, CEILING, 'a box re-flowed at every step still gets to the top');
  eq(units(g2), held, 'and nothing is lost doing it');
  eq(g2.deliveries.filter((d) => d.id === crate.id).length, 1, 'and it is still one box');
}

// ---------------------------------------------------------------------------
// 9b. KNOCKING A HOLE IN AN OUTSIDE WALL DOES NOT ERASE YOUR CEILING.
//
// `canKeep`'s own bug, one storey up, and it shipped with step 8 because both
// rules that survive the ceiling branch's skip read as facts about the duct. A
// roof is not one: it is a fact about the WALLS, and enclosure in this game is
// shop-wide and all-or-nothing — take enough of a wall out and `computeIndoor`
// answers zero indoor cells rather than fewer. So one accidental hole failed
// "there is no roof there" for every overhead cell in the building at once, and
// `compose` sheds what it cannot keep.
//
// The refund is why it does not read as theft, and it is also why it is
// invisible: no money is missing, nothing is logged, and what you get is your
// whole ceiling gone for a gesture the game called a warning. Reported from a
// chair, which is the only place it could have been found.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const row = roofRow(g, 4);
  const cells = row.map((c) => put(g, { kind: 'belt', x: c.x, z: c.z, rot: 0, deck: CEILING }));
  put(g, { kind: 'arm', x: row[1].x, z: row[1].z, rot: 0, deck: CEILING });
  const overhead = () => conveyorsOf(g.layout).filter((c) => deckOf(c) === CEILING).length;
  const had = overhead();
  eq(had, cells.length, 'the duct is up');

  // Take the outside wall out — a long enough stretch that enclosure collapses
  // entirely, which is the state the whole trap turns on and is one press away
  // in build mode.
  let knocked = 0;
  for (let z = 0; z <= g.layout.h; z++) {
    for (let x = 0; x <= g.layout.w; x++) {
      for (const o of ['h', 'v']) {
        if (edgeAt(g.layout, { o, x, z }) === 0) continue;
        if (g.buildEdge('me', { o, x, z, kind: 0 })?.ok) knocked++;
      }
    }
  }
  check(knocked > 0, 'a wall can be knocked through', `${knocked} segments`);
  eq((g.layout.indoor ?? []).reduce((n, v) => n + (v ? 1 : 0), 0), 0,
    'and the shop has no indoor cells left at all');

  // THE CLAIM. Not "most of it" and not "it came back with a refund".
  g.regenerateLayout();
  eq(overhead(), had, 'the duct is still there with the walls down');

  // ...and the rule is not deleted, only narrowed: you still cannot LAY one
  // where there is no roof, which is the control that says this is a keeping
  // rule rather than a rule that stopped existing.
  eq(canPlace(g.layout, { kind: 'belt', x: row[0].x, z: row[0].z + 2, rot: 0, deck: CEILING }).ok,
    false, 'but you still cannot lay a new one under open sky');
}

// ---------------------------------------------------------------------------
// 10. THE RISE IS CHOSEN, and this is the sharpest control in step 9.
//
// Up is a fifth way out — the same square one storey along — and the moment it
// exists the two networks a duct and the aisle under it were carefully kept
// apart can touch by default. Which is the merge section 3 exists to refuse,
// arriving by the front door: laying a duct across your shop would silently
// join it to every run it crossed, and a box changing storey at a crossing is
// drawn as a conveyor that teleports and read, from a chair, as one that works.
//
// So two things choose it and nothing else does. A JUNCTION, which is the piece
// whose whole job is choosing between ways out. And a LOADER WITH NOWHERE ELSE,
// which is the endcap this step exists for. A plain belt never looks up, and a
// loader that can carry on across its own deck never looks up either.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const row = roofRow(g, 5);
  const z = row[0].z;
  const x0 = row[0].x;

  // A run of four on the floor: belt, loader, belt, loader. The last one is the
  // endcap — nothing in front of it and nothing beyond it.
  const head = put(g, { kind: 'belt', x: x0, z, rot: 0 });
  const mid = put(g, { kind: 'arm', x: x0 + 1, z, rot: 1 });
  const on = put(g, { kind: 'belt', x: x0 + 2, z, rot: 0 });
  const end = put(g, { kind: 'arm', x: x0 + 3, z, rot: 0 });
  // ...and a duct over the middle loader AND over the end one, so the two
  // answers below differ by nothing except whether the machine had anywhere
  // else to hand on.
  const overMid = put(g, { kind: 'belt', x: x0 + 1, z, rot: 0, deck: CEILING });
  const overEnd = put(g, { kind: 'belt', x: x0 + 3, z, rot: 0, deck: CEILING });

  // A PLAIN BELT NEVER LOOKS UP. Its own `rot` is its answer and always was,
  // which is what makes every run ever laid unchanged by this — but it is also
  // the one claim that would fail if the vertical had been added to the four-way
  // neighbour loop instead of asked for by name.
  const overHead = put(g, { kind: 'belt', x: x0, z, rot: 0, deck: CEILING });
  const way = conveyorNext(g.layout, head);
  eq(deckOf(way), 0, 'a plain belt under a duct still hands along the floor');
  eq(`${way?.x},${way?.z}`, `${x0 + 1},${z}`, 'to the cell it points at and nothing else');
  eq(conveyorBranches(g.layout, head).length, 0, 'and a belt has no branches at all');
  eq(deckOf(conveyorNext(g.layout, overHead)), CEILING, 'and the duct over it stays upstairs');

  // A LOADER MID-RUN NEVER LOOKS UP EITHER. It has somewhere to go on its own
  // storey, so the duct crossing over it is scenery — which is what keeps this
  // from being a change to every aisle anybody automates from now on.
  const along = conveyorNext(g.layout, mid);
  eq(deckOf(along), 0, 'a loader with a run in front of it carries straight on');
  eq(`${along?.x},${along?.z}`, `${x0 + 2},${z}`, 'along the floor');
  eq(deckOf(conveyorNext(g.layout, overMid)), CEILING, 'and the duct over it is a run of its own');

  // ...AND THE ENDCAP DOES. Same machine, same duct, one difference: there is
  // no more aisle. This is the complaint step 9 was written for — a run down an
  // aisle used to stop dead here, because the only way back is a shaft and a
  // shaft wants the square the endcap is standing on.
  const up = conveyorNext(g.layout, end);
  eq(deckOf(up), CEILING, 'a loader at the end of the line hands UP');
  eq(`${up?.x},${up?.z}`, `${overEnd.x},${overEnd.z}`, 'onto its own square, one storey along');
  check(!!on, 'the run behind it is still there');
}

// ---------------------------------------------------------------------------
// 10b. …AND AN AISLE MADE ENTIRELY OF LOADERS, which is what people build.
//
// "Belts on the corners, loaders down the straights" is the advice; a row of
// units stocked one machine each is the shape, and such a row has no plain belt
// in it at all. That row never reaches `conveyorFlow`'s forward walk — nobody
// has a feeder, so every cell of it lands in the leftovers — and down there a
// loader aimed at a shelf was declared a TERMINUS one line before anything
// asked about the rise.
//
// So the same build worked or did not depending on whether there happened to be
// a belt somewhere upstream, and nothing on screen could say which: an endcap
// resolved through `choose` took the duct, an endcap resolved as a leftover did
// not, and both are a loader with a duct over it and a box that has stopped.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const row = roofRow(g, 5);
  const z = row[0].z;
  const x0 = row[0].x;

  // Three loaders in a line and NOT ONE BELT, each aimed at a shelf of its own.
  const shelves = [];
  for (let i = 0; i < 3; i++) {
    const res = g.placeFixture('me', { kind: 'shelf', x: x0 + i, z: z + 1, rot: 0 });
    check(res.ok, 'a shelf goes beside the aisle', res.error ?? '');
    shelves.push({ x: x0 + i, z: z + 1 });
  }
  const arms = [0, 1, 2].map((i) => put(g, { kind: 'arm', x: x0 + i, z, rot: 1 }));
  eq((g.layout.belts ?? []).length, 0, 'and the run has no plain belt anywhere in it');
  const overEnd = put(g, { kind: 'belt', x: x0 + 2, z, rot: 0, deck: CEILING });

  const up = conveyorNext(g.layout, arms[2]);
  eq(`${up?.x},${up?.z},${deckOf(up)}`, `${overEnd.x},${overEnd.z},${CEILING}`,
    'the endcap of a beltless row hands up all the same');
  // ...and the two with no duct over them are UNTOUCHED, which is the control
  // and the only thing that says the leftover rule was narrowed rather than
  // deleted. A loader aimed at a shelf with nothing overhead is still a
  // terminus, exactly as it was: `null`, not a guessed neighbour.
  for (let i = 0; i < 2; i++) {
    eq(conveyorNext(g.layout, arms[i]), null,
      'while a loader with no duct over it is still a terminus');
  }
  check(shelves.length === 3, 'and its three shelves are standing');
}

// ---------------------------------------------------------------------------
// 11. THE ENDCAP, END TO END — and the ladder the rise sits on.
//
// `armSwing` is a ladder of preferences: shelving first, because that is what
// the machine is for, then somewhere to set the box down. Step 9 puts the rise
// between them, and that ordering is the difference between a feature and dead
// code — a loader with bare floor beside it is every loader in every shop, so a
// rise below the ground drop would never once be reached.
//
// Three runs of the same shop, differing by one press each. None of them can be
// told apart in a still frame: a box on a duct, a box on the floor and a box on
// a shelf are all a box that arrived somewhere.
// ---------------------------------------------------------------------------
for (const build of ['duct', 'bare', 'shelf']) {
  const g = fresh();
  const row = roofRow(g, 5);
  const z = row[0].z;
  const x0 = row[0].x;
  const face = { x: x0 + 3, z };

  put(g, { kind: 'belt', x: x0, z, rot: 0 });
  put(g, { kind: 'belt', x: x0 + 1, z, rot: 0 });
  const arm = put(g, { kind: 'arm', x: x0 + 2, z, rot: 0 });
  if (build !== 'bare') put(g, { kind: 'belt', x: x0 + 2, z, rot: 0, deck: CEILING });
  if (build === 'duct') put(g, { kind: 'belt', x: x0 + 3, z, rot: 0, deck: CEILING });
  if (build === 'shelf') {
    const res = g.placeFixture('me', { kind: 'shelf', x: face.x, z: face.z, rot: 2 });
    check(res.ok, 'a shelf goes in front of the endcap loader', res.error ?? '');
  } else {
    eq(isWalkableTile(g.layout, face.x, face.z), true,
      `${build}: the tile it faces is bare walkable floor`);
  }

  const crate = crateOn(g, g.beltAt(x0, z), 4);
  const held = units(g);
  run(g, 400);

  const shelf = (g.layout.shelves ?? []).find((s) => s.x === face.x && s.z === face.z);
  const onShelf = (shelf?.stacks ?? []).reduce((n, st) => n + (st.qty ?? 0), 0);
  /**
   * ON THE RUN or ON THE GROUND, and never by the box's id.
   *
   * `armDrop` goes through `dropLot`, which merges into whatever pile is
   * already standing there and retires the crate that arrived — so a test that
   * followed the id would report "no box on the floor" for the one build where
   * the box is definitely on the floor.
   *
   * And by "the ground" rather than by the faced tile, which is what the first
   * draft of this asserted and got wrong in an instructive direction: pads come
   * before the faced tile on the ladder, and the row this sweep happens to find
   * is next to the drop-off. So the control is a stronger claim than intended —
   * the rise outranks the PAD as well, which is the rung above the one trap 6 is
   * written about.
   */
  const grounded = g.deliveries.filter((d) => !d.belt && lotTotal(d) > 0);
  const riding = g.deliveries.filter((d) => d.belt && lotTotal(d) > 0);

  if (build === 'duct') {
    // THE CLAIM, and it is a pair. The box is on the duct AND it is not on the
    // floor — the second half being the one that matters, since a loader that
    // off-ramped first would look exactly like a loader doing its job.
    eq(riding.length, 1, 'the endcap sends its box on rather than off the run');
    eq(deckOf(riding[0] ?? {}) === CEILING || (riding[0]?.deck ?? 0) > 0.99, true,
      'and it is upstairs', JSON.stringify(spot(riding[0] ?? {})));
    eq(grounded.length, 0, 'with nothing set down anywhere');
  }
  if (build === 'bare') {
    // The control, and it is the whole of what says this is opt-in: take the
    // duct away and the same shop does exactly what it did before step 9.
    eq(grounded.length, 1, 'with no duct over it the box comes off onto the ground');
    eq(riding.length, 0, 'and nothing is left on the run');
  }
  if (build === 'shelf') {
    // ...and the rise is BELOW the units on the ladder. A machine that sent its
    // goods up rather than into the shelf it is bolted to is a loader that has
    // stopped being a loader, and the duct would be busy the whole time.
    check(onShelf > 0, 'a shelf in front of it is stocked before anything rises', `${onShelf} units`);
    eq(riding.length + grounded.length, 0, 'and nothing goes up while the shelf will have it');
  }
  eq(units(g), held, `${build}: and nothing is created or destroyed`);
  check(!!crate && !!arm, `${build}: the run was built`);
}

// ---------------------------------------------------------------------------
// 12. A JUNCTION SORTS UP, and a keen line still wins.
//
// The other half of the return leg: goods this aisle has no home for go
// overhead and away, with no floor tile spent on a shaft. A sorter gets the
// fifth side for the same reason it gets the other four — you do not aim a
// branch, you build a conveyor next to a junction and it becomes one.
//
// Its pair is the assertion that keeps it from being the `homeFull` spread bug
// wearing a storey: a line that WILL take the goods outranks the rise, every
// time, and a duct that serves nothing is never keen.
// ---------------------------------------------------------------------------
for (const keen of [false, true]) {
  const g = fresh();
  const row = roofRow(g, 6);
  const z = row[0].z;
  const x0 = row[0].x;

  const feed = put(g, { kind: 'belt', x: x0, z, rot: 0 });
  // Aimed at the side with nothing on it, so the duct above has to arrive as a
  // BRANCH rather than as the straight-on. Pointed along the run instead, the
  // junction's `rot` side would be its named branch and `choose` would hand the
  // rise the straight-on — the same two ways out with the labels swapped, which
  // would pass this section while saying nothing about `conveyorBranches`.
  const tee = put(g, { kind: 'sorter', x: x0 + 1, z, rot: 3 });
  put(g, { kind: 'belt', x: x0 + 2, z, rot: 0 });
  const roof = put(g, { kind: 'belt', x: x0 + 1, z, rot: 0, deck: CEILING });
  // ...and a home down the FLOOR branch, or not. That one shelf is the entire
  // difference between the two runs.
  if (keen) {
    const shelfAt = { x: x0 + 3, z: z + 1 };
    const res = g.placeFixture('me', { kind: 'shelf', x: shelfAt.x, z: shelfAt.z, rot: 0 });
    check(res.ok, 'a shelf goes down the floor branch', res.error ?? '');
    put(g, { kind: 'arm', x: x0 + 3, z, rot: 1 });
  }

  const branches = conveyorBranches(g.layout, tee);
  const isRise = (w) => w.x === tee.x && w.z === tee.z && deckOf(w) === CEILING;
  eq(branches.filter(isRise).length, 1, 'a junction under a duct has the duct as a branch');
  const straight = conveyorNext(g.layout, tee);
  eq(`${straight?.x},${straight?.z},${deckOf(straight)}`, `${x0 + 2},${z},0`,
    'and its straight-on is still the aisle');

  // Six boxes, one at a time, so nothing here is about backpressure.
  let went = 0;
  // Conservation, kept as a running total rather than a snapshot: the goods a
  // keen junction sends down the floor branch END UP ON THE SHELF, so a shop
  // measured before and after would honestly be richer by everything that got
  // put away. What is being asserted is that no hop invented or ate anything.
  let owed = units(g);
  for (let n = 0; n < 6; n++) {
    const crate = crateOn(g, feed, 2);
    owed += 2;
    let rose = false;
    for (let i = 0; i < 160; i++) {
      g.step(0.1);
      if ((crate.deck ?? 0) > 0) rose = true;
      if (!g.deliveries.includes(crate)) break;
      if (crate.belt === roof.id && !(crate.off > 0)) break;
    }
    if (rose) went++;
    owed -= lotTotal(crate);
    g.deliveries = g.deliveries.filter((d) => d.id !== crate.id);
  }
  if (keen) {
    // THE PAIR. A rise that could outrank a line which will take the goods is a
    // leak, and it would be invisible: every box that DID arrive arrived
    // correctly, which is the "sorter that does not sort" report exactly.
    eq(went, 0, 'nothing goes up while a floor line can put the goods away', `${went} of 6`);
  } else {
    check(went > 0, 'a junction with nowhere on its own storey sends goods up', `${went} of 6`);
    check(went < 6, 'and still splits with the line beside it', `${went} of 6`);
  }
  eq(units(g), owed, `${keen ? 'keen' : 'split'}: and no hop invented or ate a unit`);
}

// ---------------------------------------------------------------------------
// 13. NO COLUMN, AND IT COMES DOWN AGAIN.
//
// Two cells over one square are the most that can exist, and the one thing they
// must not be is a run. Left unguarded the floor cell hands up, the ceiling cell
// hands down, both on the same square, for ever — the loader ping-pong
// `conveyorFlow` already warns about, stood on its end. It does not error and it
// does not spill; the box simply oscillates over one tile while the shop looks
// like it is working.
//
// And the other half, which is what makes a return leg a return leg rather than
// a way of losing stock on the roof: a box that went up has to come down.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const row = roofRow(g, 4);
  const z = row[0].z;
  const x0 = row[0].x;
  const low = put(g, { kind: 'arm', x: x0, z, rot: 1 });
  const high = put(g, { kind: 'arm', x: x0, z, rot: 1, deck: CEILING });
  const a = conveyorNext(g.layout, low);
  const b = conveyorNext(g.layout, high);
  const points = (from, to) => !!from && from.x === to.x && from.z === to.z
    && deckOf(from) === deckOf(to);
  check(!(points(a, high) && points(b, low)), 'two machines over one square are not a loop',
    `${JSON.stringify(a)} / ${JSON.stringify(b)}`);
}

{
  // A ring that changes storey twice: along the floor, up at the endcap, back
  // west overhead, and down again at the head of the run.
  const g = fresh();
  const row = roofRow(g, 4);
  const z = row[0].z;
  const x0 = row[0].x;
  const start = put(g, { kind: 'belt', x: x0, z, rot: 0 });
  put(g, { kind: 'belt', x: x0 + 1, z, rot: 0 });
  const rise = put(g, { kind: 'arm', x: x0 + 2, z, rot: 0 });
  put(g, { kind: 'belt', x: x0 + 2, z, rot: 2, deck: CEILING });
  put(g, { kind: 'belt', x: x0 + 1, z, rot: 2, deck: CEILING });
  const drop = put(g, { kind: 'arm', x: x0, z, rot: 1, deck: CEILING });

  eq(deckOf(conveyorNext(g.layout, rise)), CEILING, 'the endcap loader lifts the box');
  const back = conveyorNext(g.layout, drop);
  eq(deckOf(back), 0, 'and the loader at the far end of the duct sets it down again');
  eq(`${back?.x},${back?.z}`, `${x0},${z}`, 'on the run it came off');

  const crate = crateOn(g, start, 3);
  const held = units(g);
  let wasUp = false;
  let cameBack = false;
  let offSquare = 0;
  let rode = 0;
  for (let i = 0; i < 600; i++) {
    g.step(0.1);
    const now = spot(crate);
    /**
     * THE RIDE, which is section 6's claim about a shaft said about a rise —
     * and it is the one thing here a player could actually watch. A box part way
     * between storeys is over the square it left, because there is nothing else
     * for it to be over: the two cells ARE one square. Anywhere else is a crate
     * hanging in the middle of the aisle.
     */
    if (now.deck > 1e-6 && now.deck < 1 - 1e-6) {
      rode++;
      // One of the two squares a storey change happens on, and exactly on it.
      // Which of the pair is not worth deciding here — the ring goes round more
      // than once, so a test that remembered "we have been up already" would be
      // measuring the previous lap.
      const over = (Math.abs(now.x - x0) < 1e-6 || Math.abs(now.x - (x0 + 2)) < 1e-6)
        && Math.abs(now.z - z) < 1e-6;
      if (!over) offSquare++;
    }
    if (now.deck > 0.99) wasUp = true;
    if (wasUp && now.deck < 1e-6) cameBack = true;
  }
  check(rode > 0, 'the box is caught part way between storeys', `${rode} ticks`);
  eq(offSquare, 0, 'and every one of those is over the square it left');
  check(wasUp, 'a box put on a floor run reaches the duct');
  check(cameBack, 'and comes back down again rather than staying on the roof');
  eq(units(g), held, 'with nothing created or destroyed going round');
  eq(g.deliveries.filter((d) => d.id === crate.id).length, 1, 'and it is still one box');
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.log(`\n${checks} assertions\n`);
  console.log(`  ❌  ${failures.length} failures:\n`);
  for (const f of failures) console.log(`      ${f}`);
  console.log('');
  process.exitCode = 1;
} else {
  console.log(`\n${checks} assertions\n`);
  console.log('  ✅  a run can hang from the roof, a shaft carries the way the goods go,');
  console.log('      and nothing it does happens on the wrong storey.\n');
}
