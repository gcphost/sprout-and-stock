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
  conveyorMeets, conveyorsOf, conveyorBranches, armReach, deckOf, CEILING, BASEMENT,
  tunnelExit,
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
  tiers: [
    { name: 'Standard', cost: 0, speed_mult: 1 },
    { name: 'Quick', cost: 0, speed_mult: 2 },
    { name: 'Express', cost: 0, speed_mult: 3 },
  ],
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
// 2b. "A CONVEYOR" IS THREE OF THE FIVE.
//
// The roof takes the three kinds a run is MADE of and neither of the two that
// are about the floor. A LIFT is what joins the storeys — it answers
// `conveyorAt` on both decks off one square, so a second one laid overhead is
// the same shaft said twice. A TUNNEL gives back the SQUARE, which is the one
// thing a ceiling has not got to give, and its far mouth is found by a scan
// that matches on x,z alone — so an overhead mouth pairs with a floor mouth in
// the same column and hands its crate down a storey, which is section 7's own
// bug arriving through the one piece whose pairing is not a neighbour.
//
// It was `def.flow`, which reads as "is this a conveyor" and is true of both.
// NOT ONE ASSERTION ANYWHERE FAILED FOR IT, and that is why this is written
// down: an overhead lift is refused by nothing, builds, draws, and joins two
// storeys that were already joined. What it was reported as is the thing you
// CAN see — the Floor/Overhead switch coming up for the two tools that cannot
// use one, which is the green-ghost rule said about a control.
//
// Both halves, and the second is the one a value alone would miss: the field
// must not ride on the placement either, or the refusal is the only thing
// standing between a lift and a storey and every other caller writes one.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const row = roofRow(g, 4);

  for (const kind of ['belt', 'arm', 'sorter']) {
    eq(canPlace(g.layout, {
      kind, x: row[0].x, z: row[0].z, rot: 0, deck: CEILING,
    }).ok, true, `a ${kind} may hang from the roof`);
  }
  for (const kind of ['lift', 'under']) {
    const spec = { kind, x: row[2].x, z: row[2].z, rot: 0, deck: CEILING };
    eq(canPlace(g.layout, spec).ok, false, `a ${kind} may not`);
    // ...and on the floor, which is the control that keeps this from being
    // "the tool is broken" rather than "the tool is a floor tool".
    eq(canPlace(g.layout, { ...spec, deck: 0 }).ok, true, `while a ${kind} on the floor is fine`);

    // Through the STORE, because the refusal and the field are two different
    // pieces of code and only one of them is obvious: `placeFixture` normalises
    // the storey itself, so a press that asked for the ceiling has to come back
    // as an ordinary floor piece rather than as a refusal or as a ceiling one.
    const res = g.placeFixture('me', { piece: PIECE[kind], ...spec });
    check(res.ok, `and the press lands a ${kind} anyway`, res.error ?? '');
    const made = (kind === 'lift' ? g.layout.lifts : g.layout.unders) ?? [];
    const cell = made.find((c) => c.id === res.placed);
    check(!!cell, `the ${kind} is in the layout`);
    eq(deckOf(cell), 0, 'and it is on the floor');
    // The PLACEMENT rather than the layout record, which is the half that
    // survives a re-flow: `compose` rebuilds the cell from this, so a storey
    // stored here is one every reload hands back.
    eq(g.placements.find((p) => p.id === res.placed)?.deck, undefined,
      'with no storey on the placement at all');
    g.removeFixture('me', res.placed);
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

// A saved queue may already contain more than one crate part-way through a
// down shaft. It still carries the address of the ceiling feeder until the
// hand-off completes, and "front" is the LOWEST deck on this journey. This is
// the exact recovery shape found in demo-world at 13,21.
{
  const g = fresh();
  const row = roofRow(g, 5);
  const z = row[0].z;
  const x0 = row[0].x;
  put(g, { kind: 'belt', x: x0, z, rot: 0 });
  const highFirst = put(g, { kind: 'belt', x: x0, z, rot: 0, deck: CEILING });
  put(g, { kind: 'belt', x: x0 + 1, z, rot: 0 });
  const highLast = put(g, { kind: 'belt', x: x0 + 1, z, rot: 0, deck: CEILING });
  const lift = put(g, { kind: 'lift', x: x0 + 2, z, rot: 0 });
  const out = put(g, { kind: 'belt', x: x0 + 3, z, rot: 0 });

  check(g.setLiftWay('me', lift.id, 'down').ok,
    'the recovered two-level junction is explicitly directed down');
  const directed = conveyorNext(g.layout, (g.layout.lifts ?? [])[0]);
  eq(deckOf(directed), 0, 'that down trip lands on the floor storey');
  eq(`${directed?.x},${directed?.z}`, `${out.x},${out.z}`,
    'and hands onto its floor run');

  const rear = crateOn(g, highLast, 1);
  const front = crateOn(g, highFirst, 1);
  Object.assign(rear, {
    belt: highLast.id, off: 1.33, x: lift.x, z: lift.z, deck: 0.67,
  });
  Object.assign(front, {
    belt: highLast.id, off: 1.83, x: lift.x, z: lift.z, deck: 0.17,
  });
  g.stepBelts(0.01);
  eq(g.shaftCarry.get(lift.id), front.id,
    'a recovered down shaft gives its piston to the lowest, front-most crate');
  check(front.deck < 0.17 || front.belt !== highLast.id,
    'that front crate advances out instead of being frozen by the rear crate');
  near(rear.deck, 0.67, 'and the rear crate waits for the physical piston', 0.011);
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
// 4c. WHICH SIDE IT LANDS ON, which is the other half of a shaft nobody could
//     say anything to.
//
// `way` answers which STOREY. It says nothing about the square, and a shaft has
// up to four ways out on the deck it arrives at — so `liftOut` took the first
// one in enum order, and which cell a descending crate carried on into was
// decided by the numbering of `[0, 1, 2, 3]`. On the save this came off, a lift
// landing beside a belt to its east and a tunnel mouth to its north always
// chose the belt, and the north leg could not be built at all: the only way to
// route round it was to demolish the neighbour that kept winning.
//
// Nothing about it is visible. A shaft that chose the wrong exit and one whose
// other leg has not been built yet are the same still frame — every box that
// arrives arrives correctly, down a leg that works, and the run you meant
// simply never carries anything.
//
// Its control is the assertion that decides whether any of this is opt-in: a
// shaft's `rot` defaults to 0, which is the side the scan already tried first,
// so every lift in every save answers exactly as it did. And its pair is that
// the aim is a PREFERENCE — a shaft aimed at a wall falls back to the scan
// rather than becoming a terminus, or one press turns a working loop off.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  // The row search above only promises the row. This needs a SPUR off it too,
  // so it looks for one — where the shop is indoors is a fact about the shell.
  const tee = (() => {
    for (let z = 2; z < g.layout.h - 1; z++) {
      for (let x = 1; x + 4 < g.layout.w - 1; x++) {
        const cells = [{ x, z }, { x: x + 1, z }, { x: x + 2, z }, { x: x + 1, z: z - 1 }];
        const ok = cells.every((c) => canPlace(g.layout, { kind: 'belt', x: c.x, z: c.z, rot: 0 }).ok
          && canPlace(g.layout, { kind: 'lift', x: c.x, z: c.z, rot: 0 }).ok
          && canPlace(g.layout, { kind: 'belt', x: c.x, z: c.z, rot: 0, deck: CEILING }).ok);
        if (ok) return { x, z };
      }
    }
    return null;
  })();
  check(!!tee, 'there is somewhere under the roof for a run with a spur off it');
  const z = tee.z;
  const x0 = tee.x;
  // A duct running east into a shaft, and TWO ways on from where it lands: east
  // along the floor, and north off it.
  put(g, { kind: 'belt', x: x0, z, rot: 0, deck: CEILING });
  const lift = put(g, { kind: 'lift', x: x0 + 1, z, rot: 0 });
  const east = put(g, { kind: 'belt', x: x0 + 2, z, rot: 0 });
  const north = put(g, { kind: 'belt', x: x0 + 1, z: z - 1, rot: 3 });
  check(!!east && !!north, 'a shaft can land with two ways on from it');

  const cell = () => (g.layout.lifts ?? []).find((f) => f.x === lift.x && f.z === lift.z);
  const out = () => conveyorNext(g.layout, cell());

  // THE CONTROL. Untouched, it answers what it always answered.
  eq(cell()?.rot ?? 0, 0, 'a shaft is laid facing rot 0 like everything else');
  eq(`${out()?.x},${out()?.z}`, `${east.x},${east.z}`,
    'and an unturned one carries on the way it always did');

  // ...and R moves it, which is the whole feature.
  let turns = 0;
  while ((cell()?.rot ?? 0) !== 3 && turns < 8) {
    check(g.rotateFixture('me', cell().id).ok, 'a shaft turns');
    turns++;
  }
  eq(cell()?.rot ?? 0, 3, 'R walks it round to face north');
  eq(`${out()?.x},${out()?.z}`, `${north.x},${north.z}`,
    'and it lands on the leg you aimed at instead of the one enum order picked');
  eq(deckOf(out()), 0, 'still on the storey `way` chose, which the aim does not touch');

  // The box actually goes that way, because a lookup and a journey are two
  // different pieces of code and only one of them is obvious.
  const held = units(g);
  const box = crateOn(g, conveyorAt(g.layout, x0, z, CEILING), 2);
  let onNorth = false;
  for (let i = 0; i < 400 && !onNorth; i++) {
    g.step(0.1);
    onNorth = box.belt === north.id;
  }
  check(onNorth, 'and a crate off the duct comes down and takes it');
  eq(units(g), held + 2, 'with nothing created or destroyed on the way');

  // THE PAIR. Aimed at bare floor — a side with no conveyor on it at all — a
  // shaft is not stranded. It falls back to the scan, or one press of R on a
  // working loop is a shop that quietly stops moving goods.
  const g2 = fresh();
  const row2 = roofRow(g2, 4);
  const z2 = row2[0].z;
  const x2 = row2[0].x;
  put(g2, { kind: 'belt', x: x2, z: z2, rot: 0, deck: CEILING });
  const lift2 = put(g2, { kind: 'lift', x: x2 + 1, z: z2, rot: 0 });
  const only = put(g2, { kind: 'belt', x: x2 + 2, z: z2, rot: 0 });
  const cell2 = () => (g2.layout.lifts ?? []).find((f) => f.x === lift2.x && f.z === lift2.z);
  let spins = 0;
  while ((cell2()?.rot ?? 0) !== 2 && spins < 8) {
    check(g2.rotateFixture('me', cell2().id).ok, 'the second shaft turns');
    spins++;
  }
  eq(cell2()?.rot ?? 0, 2, 'aimed back the way it came, at nothing');
  const still2 = conveyorNext(g2.layout, cell2());
  eq(`${still2?.x},${still2?.z}`, `${only.x},${only.z}`,
    'it still finds the one run it has, rather than becoming a terminus');
}

// ---------------------------------------------------------------------------
// 4d. A SHAFT UNDER A DUCT TAKES THE DUCT'S CELL, because it IS that cell.
//
// `conveyorAt` gives a lift's square to the lift on BOTH storeys — that is what
// lets a run on either one hand to it — so a duct cell left standing on that
// square is not a second run. It is a cell nothing in the game can address
// again: no feeder can reach it, its own hand-off is never travelled, and it
// sits there for the rest of the save.
//
// The order that produces it is the obvious one, which is why this is here at
// all: lay the ceiling run, then drop a shaft under it to bring the goods down.
// The crate rides the lift and the picture is perfect — the orphan is a
// one-cell line off to the side of a network that works. Two of them were found
// on a real save by the flow overlay's dead-line colour, and nothing else in
// the game had a word to say about either.
//
// The rule it joins is `conveyorSwap`'s and it is SYMMETRIC: two conveyors may
// not share a square, and the later press wins, warned. That already held on
// the floor (a belt over a loader swaps) and overhead (a duct over a duct), and
// a lift's second storey was the one square in the game where it did not — the
// press was allowed and nothing was taken out. So the pair here is the other
// order, and it is asserted as the same sentence rather than as a refusal.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const row = roofRow(g, 4);
  const z = row[0].z;
  const x0 = row[0].x;
  // A duct straight across, laid FIRST.
  const duct = [0, 1, 2].map((i) => put(g, { kind: 'belt', x: x0 + i, z, rot: 0, deck: CEILING }));
  eq(duct.filter(Boolean).length, 3, 'a three-cell duct goes up');
  const mid = { x: x0 + 1, z };

  // ...and the ghost says what it will cost you before the press does.
  const warn = canPlace(g.layout, { kind: 'lift', x: mid.x, z: mid.z, rot: 0 });
  check(warn.ok, 'a shaft may go under it', warn.reason ?? '');
  check(!!warn.warn, 'and the ghost says it replaces what is up there', warn.warn ?? 'silent');

  const before = (g.layout.belts ?? []).length;
  const lift = put(g, { kind: 'lift', x: mid.x, z: mid.z, rot: 0 });
  check(!!lift, 'the shaft goes down under the duct');
  eq((g.layout.belts ?? []).length, before - 1, 'and the duct cell it stands on is gone');
  eq((g.layout.belts ?? []).filter((b) => b.x === mid.x && b.z === mid.z).length, 0,
    'no orphan left standing on the shaft square');

  // THE RUN IS STILL A RUN. The cell upstream addresses that square and gets
  // the shaft, which is the whole reason swallowing it is safe.
  const up = conveyorAt(g.layout, x0, z, CEILING);
  const on = conveyorNext(g.layout, up);
  eq(`${on?.x},${on?.z}`, `${mid.x},${mid.z}`, 'the duct still hands onto that square');
  eq(conveyorAt(g.layout, mid.x, mid.z, CEILING)?.id, lift.id, '...and the square is the shaft');

  // THE PAIR: the other order says the same sentence. A duct cell laid ON a
  // standing shaft swaps the shaft out, warned — never two cells on one square.
  const g2 = fresh();
  const row2 = roofRow(g2, 4);
  const z2 = row2[0].z;
  const x2 = row2[0].x;
  const lift2 = put(g2, { kind: 'lift', x: x2 + 1, z: z2, rot: 0 });
  check(!!lift2, 'a shaft stands on its own');
  const over = canPlace(g2.layout, { kind: 'belt', x: x2 + 1, z: z2, rot: 0, deck: CEILING });
  check(over.ok, 'a duct cell may be laid on it', over.reason ?? '');
  check(!!over.warn, '...and the ghost says it replaces the shaft', over.warn ?? 'silent');
  put(g2, { kind: 'belt', x: x2 + 1, z: z2, rot: 0, deck: CEILING });
  eq((g2.layout.lifts ?? []).length, 0, 'and the shaft is gone rather than buried');
  eq((g2.layout.belts ?? []).filter((b) => b.x === x2 + 1 && b.z === z2).length, 1,
    'with exactly one cell left on that square');

  // ...and the ones a save is ALREADY carrying, which is the half a placement
  // rule can never reach. Both guards above stop a new orphan being made; a
  // shop built before them has one standing, it cannot be pointed at (the
  // renderer strips a belt sharing a lift's roof) and so it cannot be deleted.
  // So it is a KEEPING rule too — re-answered every re-flow, `canKeep`'s own
  // argument, because "nothing can address this" is a fact about what is next
  // to the cell rather than about the cell.
  const g3 = fresh();
  const row3 = roofRow(g3, 4);
  const z3 = row3[0].z;
  const x3 = row3[0].x;
  // Written straight onto the placements, which is the only way to get one now
  // — and is exactly the shape the save that reported this is in.
  g3.placements.push(
    { id: 'fx-orphan', kind: 'belt', piece: PIECE.belt, x: x3 + 1, z: z3, rot: 0, deck: CEILING, tier: 1, variant: '' },
    { id: 'fx-shaft', kind: 'lift', piece: PIECE.lift, x: x3 + 1, z: z3, rot: 0, tier: 1, variant: '' },
  );
  g3.regenerateLayout();
  eq((g3.layout.belts ?? []).filter((b) => b.x === x3 + 1 && b.z === z3).length, 0,
    'a re-flow sheds an orphan already standing on a shaft square');
  eq((g3.layout.lifts ?? []).filter((l) => l.x === x3 + 1 && l.z === z3).length, 1,
    '...and keeps the shaft, which is the half that must not be shed');
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

  // R AIMS A SHAFT, and with ONE candidate up there it can change nothing —
  // which is the half of 4c that keeps the aim a preference. Turning this one
  // must not strand it, must not drop it downstairs, and must not stop it
  // handing to the only duct it can see.
  const was = JSON.stringify(conveyorNext(g.layout, lone));
  const spun = g.rotateFixture('me', lone.id);
  check(spun.ok, 'a shaft turns', spun.error ?? '');
  const still = (g.layout.lifts ?? []).find((f) => f.x === lone.x && f.z === lone.z);
  check(!!still, 'and it is still standing there afterwards');
  eq(JSON.stringify(conveyorNext(g.layout, still)), was,
    'carrying exactly the way it did, because there is nowhere else to carry to');
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
  let sawPickup = false;
  let pickupDroppedCrate = false;
  let pickupEnteredBasket = false;
  let pickupBadAt = '';
  let sawOwnedStroke = false;
  let streamedTransform = false;
  let ownerLeftShaft = false;
  let ownerLeftAt = '';
  let sawReturn = false;
  const shaftPhases = new Set();
  let last = spot(crate);
  for (let i = 0; i < 200; i++) {
    g.step(0.1);
    const now = spot(crate);
    const wire = g.snapshot().lifts.find((f) => f.id === lift.id);
    if (wire?.shaftPhase) shaftPhases.add(wire.shaftPhase);
    if (wire?.shaftPhase === 'pickup') {
      sawPickup = true;
      if (now.deck < 1 - 1e-6) pickupDroppedCrate = true;
      if (Math.hypot(now.x - lift.x, now.z - lift.z) < Game.SHAFT_WAIT_OFFSET - 0.011) {
        pickupEnteredBasket = true;
      }
      if (pickupDroppedCrate || pickupEnteredBasket) {
        pickupBadAt = `${crate.id} at ${now.x},${now.z}/${now.deck}; owner ${wire.shaftOwner}`;
      }
    }
    if (wire?.shaftPhase === 'carry' && wire.shaftOwner === crate.id) {
      sawOwnedStroke = true;
      if (wire.shaftPos !== undefined || wire.shaftVel !== undefined) streamedTransform = true;
      if (Math.abs(now.x - lift.x) > 1e-6 || Math.abs(now.z - lift.z) > 1e-6) {
        ownerLeftShaft = true;
        ownerLeftAt = `${now.x},${now.z}/${now.deck} in ${wire.shaftPhase}`;
      }
    }
    if (wire?.shaftPhase === 'return') sawReturn = true;
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
  check(sawOwnedStroke, `${dir}: the wire names the crate as the piston owner`);
  eq(streamedTransform, false, `${dir}: the server sends state, never a per-frame piston transform`);
  check(!ownerLeftShaft, `${dir}: the piston never claims the crate before it reaches the shaft`, ownerLeftAt);
  if (dir === 'down') {
    check(sawPickup, 'down: the empty piston reaches the ceiling before accepting the crate');
    check(!pickupDroppedCrate, 'down: the crate cannot fall during that pickup stroke', pickupBadAt);
    check(!pickupEnteredBasket, 'down: it waits outside the basket during pickup', pickupBadAt);
  } else {
    check(sawReturn, 'up: the server reports the empty piston returning after release',
      `saw ${[...shaftPhases].join(',') || 'no shaft phase'}`);
  }
  eq(spot(crate).deck, far, `${dir}: it ends up on the far storey`);
  check(crate.x > x0 + 3, `${dir}: past the shaft`, `at ${crate.x}`);
  eq(units(g), held, `${dir}: and nothing is created or destroyed on the way`);
}

// ---------------------------------------------------------------------------
// 6b. THE RIDE NOBODY TAKES, which is the third thing a shaft does and the one
//     that had no geometry of its own.
//
// A lift told `up` hands to a cell BESIDE it on the ceiling, so a duct arriving
// overhead simply carries on across its square. `setLiftWay`'s own note calls
// that the pass-through and says it costs nothing — and it cost the crate two
// tiles and a trip to the floor, because `deck` on a lift is a fact about the
// PLACEMENT and reads 0 whichever end of the shaft you mean. Everything that
// asked the cell got the floor, so the path dived four metres and climbed
// straight back. What that reads as is a lift snatching a box off the rail,
// taking it down to a storey with nothing on it, and throwing it back up: the
// shape of a routing bug, and the routing was right the whole time.
//
// It is invisible in every direction but this one. The two real rides have the
// box on the floor at one end anyway, so `deckOf` is telling the truth about
// half of each and the riser covers the other half — which is why this survived
// the sweep above, twice over, in both directions.
//
// Its control is that shop, unchanged: an ascent, a descent and a shaft with no
// exit at all still measure exactly what they measured, which is what keeps
// this off the queueing a real ride is choreographed by. And its pair is the
// PLATFORM, which is the half a distance cannot say: the piston still rises, so
// that the box has something to cross ON, and the stroke back down was the
// rise's own — a rise this crate never makes. Left to the fall-through the
// carrier reported itself home in one frame, which is the one moving part of an
// overhead run anybody is watching.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const row = roofRow(g, 6);
  const z = row[0].z;
  const x0 = row[0].x;
  // A duct straight across, with a shaft standing in the middle of it and
  // NOTHING on the floor beside that shaft — which is the shop this was
  // reported from, and the reason the lift has to be told.
  for (let i = 0; i < 6; i++) {
    if (i === 3) continue;
    put(g, { kind: 'belt', x: x0 + i, z, rot: 0, deck: CEILING });
  }
  const lift = put(g, { kind: 'lift', x: x0 + 3, z, rot: 0 });
  check(g.setLiftWay('me', lift.id, 'up').ok, 'the shaft is told to carry up');

  const cell = () => (g.layout.lifts ?? []).find((f) => f.id === lift.id) ?? lift;
  const out = conveyorNext(g.layout, cell());
  eq(deckOf(out), CEILING, 'so a duct arriving overhead is handed straight on along it');

  // THE GEOMETRY. A crossing is flat, so the path over the shaft costs what the
  // two cells either side of it cost and not a tile more — the arithmetic that
  // the dive was, said as a number.
  const net = conveyorLines(g.layout);
  const loc = net.byCell.get(cell().id);
  check(!!loc, 'the shaft is on a line');
  eq(loc.line.decks[loc.i], CEILING, 'and the line has it on the storey it was handed the box on');
  near(loc.line.dist[loc.i] - loc.line.dist[loc.i - 1], 1,
    'a crossing is one cell of travel, not a cell plus a storey');
  for (const p of loc.line.pts) {
    eq(deckOf(p), CEILING, 'and no point of the drawn path is on the floor');
  }

  const crate = crateOn(g, g.beltAt(x0, z, CEILING));
  const held = units(g);
  let dipped = 0;
  let sawReturn = false;
  let sawPickup = false;
  let home = null;
  for (let i = 0; i < 300; i++) {
    g.step(0.1);
    // THE CENTREPIECE, and it is checked every tick for the reason the ride
    // above is: a box that spends one frame at deck 0.4 in the middle of an
    // aisle is the whole report.
    if ((crate.deck ?? 0) < 1 - 1e-6) dipped++;
    const wire = g.snapshot().lifts.find((f) => f.id === lift.id);
    if (wire?.shaftPhase === 'pickup') sawPickup = true;
    if (wire?.shaftPhase === 'return') sawReturn = true;
    if (wire?.shaftPhase === 'idle' && home === null && crate.x > x0 + 3) home = i;
  }
  eq(dipped, 0, 'a box crossing a shaft never leaves the ceiling');
  check(crate.x > x0 + 4, 'and it carries on past it', `at ${crate.x}`);
  eq(units(g), held, 'with nothing created or destroyed on the way');

  // ...AND THE PLATFORM. It goes up to be crossed, and it comes DOWN as a
  // stroke — a lift that arrives home in one frame is the only moving part of a
  // duct there is anything to watch, reporting itself teleported.
  check(sawPickup, 'the piston rises to give the box something to cross on');
  check(sawReturn, 'and eases back down afterwards rather than snapping home');
}

// A loaded save can already contain two candidates on the final ceiling cell:
// the older crate behind and the newer one standing over the shaft. Reservation
// order must be physical queue order, not delivery-array insertion order, or the
// front box blocks the chosen box while the choice blocks the front box forever.
{
  const g = fresh();
  const row = roofRow(g, 6);
  const z = row[0].z;
  const x0 = row[0].x;
  put(g, { kind: 'belt', x: x0, z, rot: 0, deck: CEILING });
  const feeder = put(g, { kind: 'belt', x: x0 + 1, z, rot: 0, deck: CEILING });
  const spare = put(g, { kind: 'belt', x: x0 + 2, z, rot: 0, deck: CEILING });
  let lift = put(g, { kind: 'lift', x: x0 + 3, z, rot: 0 });
  put(g, { kind: 'belt', x: x0 + 4, z, rot: 0 });
  put(g, { kind: 'belt', x: x0 + 5, z, rot: 0 });
  check(g.setLiftWay('me', lift.id, 'down').ok, 'the loaded-save shaft is directed down');
  for (let rung = 2; rung <= 3; rung++) {
    check(g.upgradeFixture('me', lift.id).ok, `that shaft reaches speed rung ${rung}`);
    lift = g.beltAt(lift.x, lift.z);
  }

  const behind = crateOn(g, feeder, 1);
  const front = crateOn(g, spare, 1);
  behind.belt = spare.id;
  behind.off = 0;
  behind.x = spare.x;
  behind.z = spare.z;
  behind.deck = CEILING;
  front.belt = spare.id;
  front.off = 1;
  front.x = lift.x;
  front.z = lift.z;
  front.deck = CEILING;

  g.step(0.05);
  const wire = g.snapshot().lifts.find((f) => f.id === lift.id);
  eq(wire?.shaftOwner, front.id,
    'a down lift grants the piston to the crate nearest its mouth, not the oldest candidate');
  eq(wire?.shaftPhase, 'carry',
    'a loaded-save crate already over the shaft resumes as boarded, not above an empty pickup');
  near(wire?.shaftFrom, front.deck,
    'that recovered carrier and its crate report the same position', 0.011);
  check(wire?.shaftDuration > 0 && wire.shaftDuration <= g.beltSeconds(lift) + 0.011,
    'the recovered loaded stroke uses the upgraded lift clock', wire?.shaftDuration);
  let frontDescended = false;
  let behindApproach = behind.x;
  let behindOverran = false;
  let released = false;
  let overlappingGrant = false;
  /**
   * THE WINDOW IS "UNTIL THE SHAFT IS OFFERED TO YOU", AND IT USED TO BE
   * "WHILE THE BOX IN FRONT IS VISIBLY MID-DESCENT". That is the same window
   * only while the descent is slow, and four lines above this sweep asserts
   * that it is NOT — `shaftDuration` is the *upgraded* clock, and this shaft
   * has been walked up to rung 3 deliberately.
   *
   * Which is what it caught, backwards. A descending crate used to ride at the
   * FEEDER's rung while the piston animated at the lift's, so an express shaft
   * spent three times as long visibly between storeys as it had any right to,
   * and the follower closed its whole 0.43 of a tile inside that. Fixing the
   * ride — the box comes down at the shaft's own speed now — left this
   * assertion demanding the queue cross 0.43 tiles in the 0.15s an express
   * descent lasts, which is 2.87 tiles/sec on a belt that runs at 1.67. It
   * failed on arithmetic rather than on anything the queue did.
   *
   * So the claim is said against the thing it is actually about. A follower is
   * held off the mouth for as long as the shaft has not been offered to it —
   * through the descent, through the empty platform coming back, through the
   * pickup — and `shaftGrant` naming it is the tick that stops being true.
   * Both halves are measured over that window rather than one of them: the max
   * must REACH the stop line (or the queue never closed up at all, which is
   * the reading that would survive a `near` on a number that only ever fell
   * short), and no tick in it may pass the line (or "stays outside" is a claim
   * about an average).
   */
  for (let i = 0; i < 80; i++) {
    g.step(0.05);
    const carry = g.shaftCarry?.get(lift.id);
    const grant = g.shaftGrant?.get(lift.id);
    if (carry && grant && carry !== grant) overlappingGrant = true;
    if ((front.deck ?? 0) < 1 - 1e-6) frontDescended = true;
    // A LATCH rather than a live test, because `shaftGrant` is cleared again
    // the moment the follower boards — read tick by tick it reopens the window
    // behind the box, halfway down the floor run, where staying off a mouth it
    // has already been through is not a rule about anything.
    if (grant === behind.id || carry === behind.id) released = true;
    if (!released) {
      behindApproach = Math.max(behindApproach, behind.x);
      if (behind.x > lift.x - Game.SHAFT_WAIT_OFFSET + 0.011) behindOverran = true;
    }
  }
  check(frontDescended, 'that front crate descends instead of deadlocking the queue');
  eq(overlappingGrant, false,
    'a following crate is never granted while the preceding carry still owns the lift');
  near(behindApproach, lift.x - Game.SHAFT_WAIT_OFFSET,
    'the queue closes up to the basket edge while the shaft is somebody else\'s', 0.011);
  eq(behindOverran, false,
    'and never once crosses it before the piston is offered to it');
  check(front.x > lift.x, 'and clears the shaft so the crate behind can follow', `at ${front.x}`);
}

// A dense queue must not turn the capacity-one shaft into an ordinary length
// of line. Exercise several consecutive cycles at half-cell spacing: during an
// empty pickup every crate remains outside the basket, and at most one crate is
// ever between storeys.
{
  const g = fresh();
  const row = roofRow(g, 6);
  const z = row[0].z;
  const x0 = row[0].x;
  for (let i = 0; i < 3; i++) put(g, { kind: 'belt', x: x0 + i, z, rot: 0, deck: CEILING });
  const feeder = g.beltAt(x0 + 2, z, CEILING);
  const lift = put(g, { kind: 'lift', x: x0 + 3, z, rot: 0 });
  put(g, { kind: 'belt', x: x0 + 4, z, rot: 0 });
  put(g, { kind: 'belt', x: x0 + 5, z, rot: 0 });
  check(g.setLiftWay('me', lift.id, 'down').ok, 'the dense-queue lift is directed down');
  const floorCrate = crateOn(g, lift, 1);
  const queued = [];
  for (let i = 0; i < 4; i++) {
    const crate = g.dropGoods(GOODS.id, 1, { x: feeder.x, z: feeder.z + i + 1 }, { exact: true });
    check(!!crate, 'the dense-queue crate exists');
    crate.belt = feeder.id;
    crate.off = -i * Game.CRATE_PITCH;
    crate.x = feeder.x - i * Game.CRATE_PITCH;
    crate.z = feeder.z;
    crate.deck = CEILING;
    queued.push(crate);
  }
  let doubleOccupied = false;
  let pickupCrossed = false;
  let followerCrossed = false;
  let pickupDuringFloorOccupancy = false;
  for (let i = 0; i < 500; i++) {
    g.step(0.05);
    const wire = g.snapshot().lifts.find((f) => f.id === lift.id);
    if (floorCrate.belt === lift.id && wire?.shaftPhase === 'pickup') {
      pickupDuringFloorOccupancy = true;
    }
    const vertical = queued.filter((crate) => (crate.deck ?? 0) > 1e-6
      && (crate.deck ?? 0) < 1 - 1e-6
      && Math.abs(crate.x - lift.x) <= 1e-6
      && Math.abs(crate.z - lift.z) <= 1e-6);
    if (vertical.length > 1) doubleOccupied = true;
    if (wire?.shaftPhase === 'pickup') {
      const owner = queued.find((crate) => crate.id === wire.shaftOwner);
      if (owner && owner.x > lift.x - Game.SHAFT_WAIT_OFFSET + 0.011) pickupCrossed = true;
    }
    if (wire?.shaftOwner) {
      const crossed = queued.some((crate) => crate.id !== wire.shaftOwner
        && Math.abs((crate.deck ?? 0) - CEILING) <= 1e-6
        && crate.x > lift.x - Game.SHAFT_WAIT_OFFSET + 0.011);
      if (crossed) followerCrossed = true;
    }
  }
  eq(doubleOccupied, false, 'a dense queue never puts two crates in one lift shaft');
  eq(pickupCrossed, false, 'a dense queue remains outside the basket until pickup reaches the top');
  eq(followerCrossed, false,
    'a dense follower cannot replace the lift gate with spacing behind its owner');
  eq(pickupDuringFloorOccupancy, false,
    'a ceiling pickup cannot begin while a floor crate still occupies the lift node');
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
// An overhead run frees the aisle square without changing what a loader means:
// it still serves the floor units on both sides. The difference is the trip —
// out from the duct and then down — rather than a smaller reach nobody can see
// from above. The shelf directly beneath is the control: it is not one of the
// loader's sides and must remain untouched.
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
  const reach = armReach(arm);
  eq(reach.length, 4, 'an overhead loader reaches the same four sides as one on the floor');
  check(site.flank.every((f) => reach.some((r) => r.x === f.x && r.z === f.z)),
    'including both floor units across the aisle');
  check(!reach.some((r) => r.x === arm.x && r.z === arm.z),
    'and not the square directly beneath it');

  // ...and the run knows it. `conveyorMeets` is what every judgement downstream
  // is built on — a junction's keen test, the skip guard on a loader's lift —
  // and read four-ways it would report the flanks as served.
  const met = conveyorMeets(g.layout, feed);
  eq(met.shelves.length, 2, 'the run reports both side units served');
  check(sides.every((u) => met.shelves.some((sh) => sh.id === u.id)),
    'and names the same two fixtures the loader can reach');

  const probe = { id: 'overhead-side-probe', stacks: [{ item_id: GOODS.id, qty: 1 }] };
  check(site.flank.every((f) => g.armTakes(arm, f, probe)),
    'either side will accept a crate from the overhead loader');

  const crate = crateOn(g, feed, 6);
  const held = units(g);
  let sideTrip = null;
  for (let i = 0; i < 200 && !sideTrip; i++) {
    g.step(0.1);
    if (crate.spur) sideTrip = { ...crate.spur };
  }
  check(!!sideTrip && !!(sideTrip.dx || sideTrip.dz) && sideTrip.dd === -1,
    'the crate travels sideways out of the duct and then down');
  run(g, 400);
  const on = (u) => (u.stacks ?? []).reduce((n, st) => n + (st.qty ?? 0), 0);
  eq(on(under), 0, 'the shelf beneath it is untouched');
  check(sides.reduce((n, u) => n + on(u), 0) > 0,
    'and a shelf beside it is stocked', `${sides.map(on).join('/')} units`);
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
// 10c. …AND A DUCT OVER EVERY CELL OF THAT AISLE IS STILL ONE RISER.
//
// The shape the return leg actually gets built in: a run down an aisle, a
// loader per shelf, and the duct laid over the whole length of it on the way
// home. Reported from a chair as "all my loaders have got an elevator now" —
// seven of them, where there should be one at the end.
//
// The cause was ORDER. `conveyorFlow`'s leftover loop resolves loaders the
// forward walk never reached, and the rise was asked there BEFORE `choose` got
// its go — so any loader in that loop with a duct over it posted its box
// straight up rather than carrying along the aisle. `choose` already rises as
// its last resort, which is what makes the end of a chain work; what the
// leftover loop is for is the loader `choose` would never be asked about.
//
// So this is a claim about SIX cells that must NOT rise, which is the shape of
// every regression worth writing down.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const row = roofRow(g, 6);
  const z = row[0].z;
  const x0 = row[0].x;
  // A belt at the head so the walk reaches the aisle, then five loaders, each
  // aimed at its own shelf, with a duct over every single cell.
  put(g, { kind: 'belt', x: x0, z, rot: 0 });
  const aisle = [];
  for (let i = 1; i <= 5; i++) {
    const res = g.placeFixture('me', { kind: 'shelf', x: x0 + i, z: z + 1, rot: 0 });
    check(res.ok, 'a shelf goes beside the aisle', res.error ?? '');
    aisle.push(put(g, { kind: 'arm', x: x0 + i, z, rot: 1 }));
  }
  for (let i = 0; i <= 5; i++) put(g, { kind: 'belt', x: x0 + i, z, rot: 0, deck: CEILING });

  const rises = aisle.filter((a) => {
    const to = conveyorNext(g.layout, a);
    return to && to.x === a.x && to.z === a.z && deckOf(to) !== deckOf(a);
  });
  eq(rises.length, 1, 'a duct over the whole aisle is one riser, not one per loader');
  eq(`${rises[0]?.x},${rises[0]?.z}`, `${x0 + 5},${z}`, 'and it is the loader at the end');
  for (let i = 0; i < aisle.length - 1; i++) {
    const to = conveyorNext(g.layout, aisle[i]);
    eq(`${to?.x},${to?.z},${deckOf(to)}`, `${x0 + i + 2},${z},0`,
      'every loader before it carries along the aisle');
  }
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

  const isRise = (w) => w.x === tee.x && w.z === tee.z && deckOf(w) === CEILING;
  /**
   * THE CONTROL, and it is the one a live shop had to teach us.
   *
   * Every other branch a junction has is automatic, because a belt beside one
   * was laid AT it. A duct over one is a route across the shop that happens to
   * pass over that square — and a return leg passes over everything, which is
   * the whole reason to build one. Shipped automatic, and the shop that found
   * it had a junction feeding fifteen shelves with the return duct crossing its
   * square on the way home: the keen test held while a shelf could take the
   * goods, and the moment the aisle filled a third of everything went up the
   * return leg to park at the end of it.
   */
  eq(conveyorBranches(g.layout, tee).filter(isRise).length, 0,
    'a duct over a junction is NOT a way out until it is asked for');
  check(g.setSorterRiser('me', tee.id, true).ok, 'and a junction can be told to use it');

  const branches = conveyorBranches(g.layout, (g.layout.sorters ?? [])[0]);
  eq(branches.filter(isRise).length, 1, 'after which the duct is a branch');
  // ...and R must not clear it, which is `repositionFixture`'s standing trap.
  // Four presses, so the junction comes back to the facing the rest of this
  // section is about — one press is also a change to where its named branch is,
  // and this claim is not about that.
  for (let i = 0; i < 4; i++) g.rotateFixture('me', (g.layout.sorters ?? [])[0].id);
  eq((g.layout.sorters ?? [])[0]?.riser, true, 'and turning the junction does not forget');
  eq((g.layout.sorters ?? [])[0]?.rot, 3, 'and it is back where it started');
  g.regenerateLayout();
  eq((g.layout.sorters ?? [])[0]?.riser, true, 'nor does a re-flow');
  // The LIVE record: R re-mints the placement's id, so the one captured at
  // build time answers for a junction that no longer exists — `conveyorNext`
  // reads the flow map by id and comes back null, which reads as the junction
  // having lost its straight-on.
  const straight = conveyorNext(g.layout, (g.layout.sorters ?? [])[0]);
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
  const queued = put(g, { kind: 'belt', x: x0 + 1, z, rot: 0 });
  const rise = put(g, { kind: 'arm', x: x0 + 2, z, rot: 0 });
  put(g, { kind: 'belt', x: x0 + 2, z, rot: 2, deck: CEILING });
  put(g, { kind: 'belt', x: x0 + 1, z, rot: 2, deck: CEILING });
  const drop = put(g, { kind: 'arm', x: x0, z, rot: 1, deck: CEILING });

  eq(deckOf(conveyorNext(g.layout, rise)), CEILING, 'the endcap loader lifts the box');
  const back = conveyorNext(g.layout, drop);
  eq(deckOf(back), 0, 'and the loader at the far end of the duct sets it down again');
  eq(`${back?.x},${back?.z}`, `${x0},${z}`, 'on the run it came off');

  const crate = crateOn(g, start, 3);
  const crate2 = crateOn(g, queued, 2);
  const held = units(g);
  let wasUp = false;
  let cameBack = false;
  let offSquare = 0;
  let rode = 0;
  let maxOnRise = 0;
  let secondWasUp = false;
  for (let i = 0; i < 600; i++) {
    g.step(0.1);
    const now = spot(crate);
    const onRise = g.deliveries.filter((d) => Math.abs(d.x - rise.x) < 1e-6
      && Math.abs(d.z - rise.z) < 1e-6
      && (d.deck ?? 0) > 1e-6 && (d.deck ?? 0) < 1 - 1e-6);
    maxOnRise = Math.max(maxOnRise, onRise.length);
    if ((crate2.deck ?? 0) > 0.99) secondWasUp = true;
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
  check(secondWasUp, 'a second queued crate also reaches the duct');
  check(maxOnRise <= 1, 'but two crates never occupy the same physical piston',
    `saw ${maxOnRise}`);
  eq(units(g), held, 'with nothing created or destroyed going round');
  eq(g.deliveries.filter((d) => d.id === crate.id).length, 1, 'and it is still one box');
}

// ---------------------------------------------------------------------------
// 12. THE TUNNEL IS A SHAFT NOW, and its far end may come up on either storey.
//
// A span used to be its own physics — two clocks on the crate, an owner map, a
// carrier record per box on the wire — and every one of those was a second
// spelling of `deck`, which the lift already had. So the claims here are the
// ones that say the two are ONE mechanism, and the first is the control that
// decides whether any of it is opt-in: a mouth nobody has touched hands on to
// the cell it faces, on the floor, exactly as every tunnel ever laid does.
//
// Its sharpest claim is the GUARD. A riser with nothing over it must fall back
// to the floor rather than becoming a terminus — the toggle turning a working
// tunnel into a dead end is the one failure that reads as the tunnel having
// broken, and the shop it happens in is the shop where you flipped the switch
// before laying the duct, which is the order anybody would do it in.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const row = roofRow(g, 6);
  check(!!row, 'there is somewhere under the roof for a tunnel with a duct over it');
  if (row) {
    const IN = 1;
    const OUT = 4;
    const feed = put(g, { kind: 'belt', x: row[0].x, z: row[0].z, rot: 0 });
    const entry = put(g, { kind: 'under', x: row[IN].x, z: row[IN].z, rot: 0 });
    const exit = put(g, { kind: 'under', x: row[OUT].x, z: row[OUT].z, rot: 0 });
    const ahead = put(g, { kind: 'belt', x: row[OUT + 1].x, z: row[OUT + 1].z, rot: 0 });

    eq(tunnelExit(g.layout, entry)?.id, exit.id, 'the two mouths pair into a tunnel');

    // -- the control ---------------------------------------------------------
    const floorOut = conveyorNext(g.layout, exit);
    eq(deckOf(floorOut), 0, 'an untouched mouth comes up onto the floor');
    eq(floorOut.x, ahead.x, 'and hands on to the line it faces');
    eq(exit.riser, false, 'with the switch off, which is every tunnel ever laid');

    // -- the span is a DIP, which is what makes it the lift's mechanism -------
    const line = conveyorLines(g.layout).byCell.get(entry.id)?.line;
    check(!!line, 'the tunnel is part of a line');
    const sunk = (line?.pts ?? []).filter((p) => p.deck === BASEMENT);
    eq(sunk.length, 2, 'whose path dips to the storey below and comes back', `${sunk.length}`);
    eq(sunk[0]?.x, entry.x, 'going down over the entry mouth');
    eq(sunk[1]?.x, exit.x, '...and up at the far one');

    // -- and a box rides it on its own `deck` --------------------------------
    const crate = crateOn(g, feed);
    const held = units(g);
    let deepest = 0;
    let sawDescent = false;
    for (let i = 0; i < 200; i++) {
      g.step(0.1);
      const at = crate.deck ?? 0;
      deepest = Math.min(deepest, at);
      if (at < -1e-6 && at > BASEMENT + 1e-6) sawDescent = true;
      if (crate.belt === ahead.id) break;
    }
    check(sawDescent, 'a crate is caught part way down the shaft');
    near(deepest, BASEMENT, 'and reaches the span itself', 0.011);
    eq(crate.belt, ahead.id, 'then comes up and carries on along the floor');
    eq(crate.deck ?? 0, 0, 'at floor level');
    eq(units(g), held, 'with nothing created or destroyed in the span');
  }
}

{
  const g = fresh();
  const row = roofRow(g, 6);
  if (row) {
    const IN = 1;
    const OUT = 4;
    const feed = put(g, { kind: 'belt', x: row[0].x, z: row[0].z, rot: 0 });
    const entry = put(g, { kind: 'under', x: row[IN].x, z: row[IN].z, rot: 0 });
    const exit = put(g, { kind: 'under', x: row[OUT].x, z: row[OUT].z, rot: 0 });
    put(g, { kind: 'belt', x: row[OUT + 1].x, z: row[OUT + 1].z, rot: 0 });

    // -- THE GUARD: switched on over bare roof, it still uses the floor ------
    check(g.setSorterRiser('me', exit.id, true).ok, 'a mouth takes the other-storey switch');
    const live = g.layout.unders.find((u) => u.id === exit.id);
    eq(live.riser, true, 'and the setting lands on the piece');
    eq(deckOf(conveyorNext(g.layout, live)), 0,
      'with nothing overhead it still comes up onto the floor');

    // -- with a duct there, it goes up --------------------------------------
    const duct = put(g, { kind: 'belt', x: row[OUT].x, z: row[OUT].z, rot: 0, deck: CEILING });
    const away = put(g, {
      kind: 'belt', x: row[OUT + 1].x, z: row[OUT + 1].z, rot: 0, deck: CEILING,
    });
    const up = conveyorNext(g.layout, g.layout.unders.find((u) => u.id === exit.id));
    eq(deckOf(up), CEILING, 'and with a run overhead the span comes up to it');
    eq(up.x, duct.x, 'on its own square');

    // A box goes in on the floor and comes out on the roof, which is the whole
    // sentence — and the two claims it is made of fail as each other, so both.
    const crate = crateOn(g, feed);
    const held = units(g);
    let roof = false;
    for (let i = 0; i < 300 && !roof; i++) {
      g.step(0.1);
      roof = crate.belt === duct.id || crate.belt === away.id;
    }
    check(roof, 'a crate posted on the floor arrives on the duct');
    near(crate.deck ?? 0, CEILING, 'at ceiling height', 0.011);
    eq(units(g), held, 'and nothing is lost on the way up');

    // -- it survives a re-flow and an R press -------------------------------
    g.regenerateLayout();
    eq(g.layout.unders.find((u) => u.id === exit.id)?.riser, true,
      'the switch survives a re-flow, which build mode fires on every wall segment');
    const turned = g.rotateFixture('me', exit.id);
    check(turned.ok, 'the mouth turns', turned.error ?? '');
    const after = g.layout.unders.find((u) => u.x === exit.x && u.z === exit.z);
    eq(after?.riser, true,
      '...and R keeps it, which is the press most likely to follow laying one');
  }
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
