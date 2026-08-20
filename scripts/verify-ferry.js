#!/usr/bin/env node
/**
 * VERIFY: THE RUNNER, AND THE ROOM THAT IS NOT ONLY THE KITCHEN'S.
 *
 * Every case of everything in this shop comes off one dock. In a small building
 * that is free; in a big one the trip from the bay to the far aisle is paid once
 * per ARMFUL, and what you watch is the whole crew strung out across the floor
 * in single file carrying six things each — which reads as bad pathing and is
 * bad logistics. A `boh` unit was the kitchen's larder and nothing else, so the
 * obvious answer (put a reserve near the aisle) was not a thing the shop could
 * express.
 *
 * Nothing in here can be looked at. A hire walking to a stockroom and a hire
 * walking to a shelf are the same still frame, and a crate that reached the
 * right place and one that reached the wrong place are both a crate that got put
 * away — the shop looks tidy either way. What it costs is a walk, and the
 * evidence for a walk not taken is nowhere on screen.
 *
 * What it guards:
 *
 * - **The control: a shop with no back room is the old game exactly**, and so is
 *   a hire with no `ferry` in their list. This is the assertion that decides
 *   whether any of it is opt-in — every worker kind in the game predates the
 *   directive, so not one of them may start using rooms.
 * - **Leg A** — a crate on the dock reaches the ROOM, not the floor.
 * - **…and the centrepiece: `ferryTo` survives the haul branch.** `stepStaff`
 *   hands ANY shouldered crate to `unload`, which scores a floor board perfectly
 *   legal — so without the errand the runner does the long walk to the bay,
 *   lifts the box, and carries it to the front of the shop. The job reads as
 *   working, and the rooms simply stay empty. It is the whole feature failing
 *   with nothing anywhere to say so.
 * - **The range is by NEAREST**, mirroring `larderRanges`: a room takes what the
 *   shelves it serves are stocked or ticked for, and refuses what none of them
 *   wants — or a stockroom is just a second yard with a roof.
 * - **Leg B** — stock in a room reaches the floor board that is short of it,
 *   which is what stops leg A being a pile-builder.
 * - **The larder is not raided.** An ingredient sat in the room for the fryer
 *   must stay there: move it and the runner and the chef undo each other all
 *   afternoon, both of them correct, and what you watch is two hires working.
 * - **Conservation**, because a new place goods can move between is a new place
 *   goods can go missing, and every one of those in this game has been a hole.
 * - **Relief** — a room marked back to shop floor mid-carry must not weld the
 *   crate to a shoulder. That is the guarantee `stepStaff`'s haul branch exists
 *   to give, and the new errand sits inside it.
 *
 * Runs on ephemeral Games. It writes two worker rows into the content database —
 * usually the live shared one — and removes them on exit.
 *
 *   node scripts/verify-ferry.js
 */

import { Game } from '../server/sim/index.js';
import { content, writeContent } from '../server/content.js';
import { remove } from '../server/db.js';
import { lotQty } from '../shared/lot.js';
import { MILESTONES } from '../server/sim/goals.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/** Enough shelving that "nearest room" is a question with more than one answer. */
const SHOP = { shelf: 8, freezer: 0, checkout: 1, plot: 0 };

/**
 * Two hands, identical but for the directive — so the control is a comparison
 * rather than a value. Fast and impatient, because this file asserts where a
 * crate ENDED and a slow hire spends the run walking.
 */
const PLAIN = {
  id: 'zz-ferry-plain', name: 'Test Hand', color: '#6b8fb5',
  jobs: [{ job: 'unload', weight: 10 }, { job: 'shelve', weight: 10 }],
  cost: 0, wage: 0, speed: 20, pace: 0.05, carry: 6,
  tiers: [{ name: 'Standard', cost: 0 }],
};
const RUNNER = {
  ...PLAIN,
  id: 'zz-ferry-runner', name: 'Test Runner',
  jobs: [{ job: 'ferry', weight: 10 }],
};
const KINDS = [PLAIN, RUNNER];
process.on('exit', () => {
  for (const w of KINDS) {
    try { remove('workers', w.id); } catch { /* best effort */ }
  }
});
for (const w of KINDS) {
  const res = writeContent('worker', w, 'verify');
  check(res.ok, `the catalog accepts ${w.name}`, res.error ?? '');
}

const c = content();
const AMBIENT = c.items.filter((it) => !it.tags.includes('frozen') && !it.tags.includes('needs-freezer'));
check(AMBIENT.length >= 2, 'the catalog has two ambient items', `${AMBIENT.length}`);
const [ITEM_A, ITEM_B] = AMBIENT;

/** The same reset every other sweep makes — see `verify-hand` on each field. */
function fresh({ kind = RUNNER.id } = {}) {
  const g = Game.create({ worldId: 'verify-ferry', seed: 'ferry', ephemeral: true });
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
  g.freezeYard();
  for (const m of MILESTONES) g.milestones.done.push(m.id);
  g.orders.auto = false;
  g.orders.assign = false;
  g.orders.items = {};
  g.orders.dropped = {};
  g.orders.pending = [];
  g.deliveries = [];
  g.cash = 50000;
  g.open = false;
  for (const sh of g.layout.shelves) sh.stacks = [];
  g.addPlayer('me', 'Tester');
  const res = g.hire(kind);
  check(res.ok, 'the hire joins', res.error ?? '');
  g.step(0.1);
  return g;
}

const hire = (g) => g.players[`staff-${g.roster[g.roster.length - 1]?.id}`];
const run = (g, ticks) => { for (let i = 0; i < ticks; i++) g.step(0.1); };
function until(g, done, limit = 1200) {
  for (let i = 0; i < limit; i++) { g.step(0.1); if (done()) return true; }
  return false;
}

/**
 * Mark a unit as back-of-house the way the menu does — through the verb, not by
 * writing the flag.
 *
 * Build mode is the permission `setBackOfHouse` gates on, and the menu borrows
 * it around the one press (`withBuildMode` on the client). A sweep that set
 * `sh.boh = true` directly would pass while the real press was refused, which is
 * the whole class of bug a sweep driving `Game` exists to catch. It also has to
 * re-find the unit afterwards: marking one re-flows, and a re-flow re-mints ids.
 */
function makeRoom(g, sh) {
  g.setBuildMode('me', true, 'shelf');
  const res = g.setBackOfHouse('me', sh.id, true);
  g.setBuildMode('me', false);
  check(res.ok, 'the unit is marked back-of-house', res.error ?? '');
  return g.layout.shelves.find((o) => o.id === sh.id) ?? sh;
}

/** Everything anywhere: boards, crates, hands, shoulder. */
function everywhere(g, itemId) {
  let n = 0;
  for (const sh of g.layout.shelves) n += g.shelfStack(sh, itemId)?.qty ?? 0;
  for (const d of g.deliveries) n += lotQty(d, itemId);
  for (const p of Object.values(g.players)) n += lotQty(p.carry, itemId) + lotQty(p.haul, itemId);
  return n;
}

/** A crate of one thing on the bay, `exact` so it never merges into another. */
function atBay(g, item, qty, i = 0) {
  const cells = g.layout.bay?.cells ?? [];
  check(cells.length > i, 'the bay has a cell for the test crate', `${cells.length}`);
  return g.dropGoods(item.id, qty, { x: cells[i].x, z: cells[i].z }, { exact: true });
}

/** Which shelf holds this, and is it back-of-house? */
const holders = (g, itemId) => g.layout.shelves
  .filter((sh) => (g.shelfStack(sh, itemId)?.qty ?? 0) > 0);

// ---------------------------------------------------------------------------
// 1. The control.
//
// Two of them, and both matter. A shop with no room marked is every shop that
// exists; a hire with no `ferry` is every worker kind that has ever been
// authored. If either started using stockrooms, this would not be a feature
// somebody opted into, it would be a change to every save in the game.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  atBay(g, ITEM_A, 6);
  const before = everywhere(g, ITEM_A.id);
  eq(g.stockroomRanges(), null, 'a shop with no back room has no stockroom ranges');
  run(g, 400);
  eq(everywhere(g, ITEM_A.id), before, 'and a runner in it creates and destroys nothing');
  check(!g.layout.shelves.some((sh) => sh.boh), 'no unit marked itself');

  // …and the directive itself. Same shop, a room, but a hand who was never told
  // to run it.
  const g2 = fresh({ kind: PLAIN.id });
  let room = g2.layout.shelves[0];
  room = makeRoom(g2, room);
  atBay(g2, ITEM_A, 6);
  run(g2, 600);
  eq(g2.shelfStack(g2.layout.shelves.find((sh) => sh.id === room.id), ITEM_A.id)?.qty ?? 0, 0,
    'a hire with no `ferry` never stocks a back room off the dock');
}

// ---------------------------------------------------------------------------
// 2. The range is by NEAREST, and it refuses what nothing near it wants.
//
// Asked of the function rather than through a run, because it is a pure
// question about geometry and asking it through a worker would be asserting
// two things at once.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const shelves = g.layout.shelves;
  const room = shelves[0];
  makeRoom(g, room);
  const floors = g.layout.shelves.filter((sh) => !sh.boh);
  check(floors.length >= 2, 'the shop still has floor shelves', `${floors.length}`);

  // Nothing on any floor board yet, so the room's range is empty — a reserve
  // for a shop that sells nothing is nothing.
  eq(g.stockroomRanges()?.get(room.id)?.size ?? -1, 0, 'a room serving bare shelves takes nothing');

  // Tick one floor board for A and stand B on another: both are things the
  // floor is stocked for, so both are things the room may hold.
  floors[0].assigned = [ITEM_A.id];
  floors[1].stacks = [{ item_id: ITEM_B.id, qty: 3, price: 3, stockedDay: g.day, soldDay: g.day }];
  const set = g.stockroomRanges()?.get(room.id);
  check(set?.has(ITEM_A.id) === true, 'a room takes what a shelf it serves is RESERVED for');
  check(set?.has(ITEM_B.id) === true, '…and what one of them is holding');

  // `backRoomTakes` is the one question every caller asks, so it has to agree.
  check(g.backRoomTakes(room, ITEM_A.id), 'and `backRoomTakes` says the same');
  const other = c.items.find((it) => it.id !== ITEM_A.id && it.id !== ITEM_B.id);
  check(!g.backRoomTakes(room, other.id),
    '…while something no shelf near it wants is refused', other?.id);
}

// ---------------------------------------------------------------------------
// 3. Leg A, and the centrepiece.
//
// The crate must reach the ROOM. `stepStaff` hands any shouldered crate to
// `unload`, which would happily score a floor board — so this passes only if
// `ferryTo` survived that branch, and the failure is invisible: the box gets put
// away either way and the shop looks perfectly tidy with its rooms empty.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  let room = g.layout.shelves[0];
  room = makeRoom(g, room);
  // A floor board ticked for it, which is what puts it in the room's range AND
  // gives leg B somewhere to take it afterwards.
  const floor = g.layout.shelves.find((sh) => !sh.boh);
  floor.assigned = [ITEM_A.id];

  const crate = atBay(g, ITEM_A, 8);
  const before = everywhere(g, ITEM_A.id);
  check(!!crate, 'the crate is standing on the bay');

  const landed = until(g, () => (g.shelfStack(room, ITEM_A.id)?.qty ?? 0) > 0);
  check(landed, 'the crate reaches the stockroom rather than the shop floor');
  eq(everywhere(g, ITEM_A.id), before, 'and nothing was created or destroyed on the way');
}

// ---------------------------------------------------------------------------
// 4. Leg B: the room feeds the floor.
//
// Without this leg A is a pile-builder — the trap CLAUDE.md records about the
// shop hand, where a job that puts something down is not finished until nothing
// picks it back up. Here the failure is the mirror: nothing picking it up at
// all, and a stockroom quietly becoming a second yard.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  let room = g.layout.shelves[0];
  room = makeRoom(g, room);
  const floor = g.layout.shelves.find((sh) => !sh.boh);
  floor.assigned = [ITEM_A.id];
  // Stock sitting in the room already, nothing at the bay at all — so the only
  // thing that can move it is leg B.
  room.stacks = [{ item_id: ITEM_A.id, qty: 8, price: 3, stockedDay: g.day, soldDay: g.day }];
  const before = everywhere(g, ITEM_A.id);

  const fed = until(g, () => (g.shelfStack(floor, ITEM_A.id)?.qty ?? 0) > 0);
  check(fed, 'stock in a room reaches the floor board that is short of it');
  eq(everywhere(g, ITEM_A.id), before, 'and the goods are conserved doing it');
  check(holders(g, ITEM_A.id).length > 0, 'the stock is somewhere');
}

// ---------------------------------------------------------------------------
// 5. The larder is not raided.
//
// The claim about two hires undoing each other. An ingredient a machine wants,
// sat in the room, with no floor board asking for it, must stay put — otherwise
// the runner walks it out to the shop and `craft` fetches it back, all
// afternoon, both of them doing their jobs correctly.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  let room = g.layout.shelves[0];
  room = makeRoom(g, room);
  const larder = g.larderRanges()?.get(room.id);
  const ingredient = larder && [...larder].map((id) => c.byId.items[id]).find(Boolean);
  if (!ingredient) {
    check(true, 'no appliance in this shop, so there is no larder to raid (skipped)');
  } else {
    // In the room, and NOT ticked or stocked anywhere on the floor.
    room.stacks = [{ item_id: ingredient.id, qty: 6, price: 3, stockedDay: g.day, soldDay: g.day }];
    for (const sh of g.layout.shelves) if (!sh.boh) { sh.assigned = []; sh.stacks = []; }
    run(g, 800);
    eq(g.shelfStack(room, ingredient.id)?.qty ?? 0, 6,
      'an ingredient nothing on the floor wants stays in the larder', ingredient.id);
  }
}

// ---------------------------------------------------------------------------
// 6. Relief: a room that stops being one does not weld the crate on.
//
// The guarantee `stepStaff`'s haul branch exists to give, and the new errand
// sits inside it. A hire pinned holding a box is the `TIRED_PACE` failure
// `verify:break` was written for, arriving through a different door.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  let room = g.layout.shelves[0];
  room = makeRoom(g, room);
  const floor = g.layout.shelves.find((sh) => !sh.boh);
  floor.assigned = [ITEM_A.id];
  atBay(g, ITEM_A, 8);
  const before = everywhere(g, ITEM_A.id);

  // Wait until the box is actually on a shoulder, then take the room away.
  const lifted = until(g, () => !!hire(g)?.haul);
  check(lifted, 'the runner gets the box onto a shoulder');
  g.setBackOfHouse('me', room.id, false);

  const freed = until(g, () => !hire(g)?.haul);
  check(freed, 'and a room that stops being one never welds the crate on');
  eq(everywhere(g, ITEM_A.id), before, 'with the goods still all there');
}

// ---------------------------------------------------------------------------
// 7. A reserve sitting still is a reserve doing its job.
//
// The nastiest interaction in the whole step, and it is between two features
// that are each correct. `soldDay` is stamped by one thing — a customer buying —
// and `chooseShelf` filters `boh` out, so a stockroom board can NEVER be sold
// from: its clock never advances, `days` grows without bound, and every reserve
// in the shop goes stale on a timer whatever is happening around it.
//
// What that costs is not a cleared board. `giveUpBoard` marks the ITEM,
// shop-wide, so the shop stops shelving AND (since the ordering half was told
// about the mark) stops BUYING a line whose only crime was being held in
// reserve. Filling a stockroom would be how you delete something from your own
// range, four days later, with nothing to connect the two.
//
// Invisible twice: a full room and a doomed room are the same picture, and the
// symptom lands days later on the shop floor.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  let room = g.layout.shelves[0];
  room = makeRoom(g, room);
  const floor = g.layout.shelves.find((sh) => !sh.boh);

  // A fortnight untouched, which is what a reserve DOES. The same board on the
  // shop floor is the control, and it has to come back stale — or this section
  // passes because `staleBoards` stopped working rather than because a room is
  // exempt from it.
  const old = { qty: 20, price: 3, stockedDay: g.day - 14, soldDay: g.day - 14 };
  room.stacks = [{ item_id: ITEM_A.id, ...old }];
  floor.stacks = [{ item_id: ITEM_B.id, ...old }];

  const stale = g.staleBoards();
  check(stale.some(({ shelf }) => shelf.id === floor.id),
    'a shop-floor board nothing has sold off in a fortnight is still stale');
  check(!stale.some(({ shelf }) => shelf.id === room.id),
    '…but a stockroom board is never judged by a clock only a SALE winds on',
    stale.map((b) => b.shelf.id).join(' '));

  // …and end to end, which is the claim that actually matters: the item does not
  // get struck off the shop's range for having been held in reserve.
  run(g, 600);
  check(!g.droppedItem(ITEM_A.id), 'so the shop never gives up on what is in its own stockroom');
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
console.log(`verify:ferry — ${checks} checks`);
if (failures.length) {
  console.error(`\n${failures.length} FAILED:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('all good ✓');
