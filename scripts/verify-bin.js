#!/usr/bin/env node
/**
 * VERIFY: THE SHOP HAS A WAY OUT.
 *
 * Stock had exactly two exits — somebody bought it, or it rotted at midnight —
 * and neither is one you can take. There was no way to be rid of anything on
 * purpose, which bites hardest at the two moments the shop is already going
 * wrong: a line nobody wants, and a harvest of the crop you had just stopped
 * growing. `dropGoods` was the only answer the game had, and a crate in the yard
 * is not getting rid of something, it is moving it.
 *
 * The skip is that exit, and it does two jobs that look like one:
 *
 *   - **You** may throw away what you are carrying. Free, irreversible, and
 *     yours alone.
 *   - **Your crew** carry out what has already rotted, so spoilage stops being
 *     a line in the log at midnight and becomes somebody walking a box across
 *     the shop.
 *
 * The line between those two is the whole design and it is not ours:
 * docs/workers.md draws it about the shop hand — *"what something is worth is
 * the player's question, and a worker answering it is a worker spending your
 * money"* — which is why Clear walks a dead board to the drop-off rather than
 * to a skip. A hire may carry out what is already worthless. A hire may never
 * decide six loaves are not worth keeping. Section 4 is that claim and it is
 * the one worth keeping if the rest is ever rewritten.
 *
 * Almost nothing here is visible. A shop with no skip and a shop with an empty
 * one are the same screen; a crate of rot and a crate of stock are the same box
 * in a different wood; and the claim that a hire *did not* take your bread to
 * the tip is a claim about something not happening.
 *
 * The trap that governs the whole feature is the one CLAUDE.md records for
 * `inACar`: **a container whose membership used to imply a fact stops implying
 * it the moment something can be in it that is not that fact.** Ten loops walk
 * `deliveries` meaning "stock", and every one of them is a different kind of
 * wrong about a crate of rubbish. Section 3 sweeps them.
 *
 * Authors one item and one fixture piece, and removes both on exit.
 *
 *   node scripts/verify-bin.js
 */

import { Game } from '../server/sim/index.js';
import { content, writeContent, refresh } from '../server/content.js';
import { remove } from '../server/db.js';
import { canPlace, FIXTURE_KINDS } from '../shared/build.js';
import { lotTotal, lotQty, lotStacks } from '../shared/lot.js';
import { MILESTONES } from '../server/sim/goals.js';
import { JOBS } from '../shared/schemas.js';
import { findPath } from '../server/sim/pathing.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SHOP = { shelf: 6, freezer: 0, checkout: 1, plot: 0 };

/**
 * Something that rots fast, and something that never does.
 *
 * Its own rows rather than the shipped ones, because what keeps how long is
 * content somebody edits on a Tuesday — and half of what is asserted below is
 * about the difference between the two. `verify:yard` makes the same argument
 * about seasons.
 */
const ROTS = {
  id: 'zz-bin-rots', name: 'Test Rot', tags: ['produce', 'perishable'],
  base_cost: 1, base_price: 3, stack: 20, shelf_life_days: 1,
  model: { parts: [{ shape: 'box', color: '#7a8b4a', pos: [0, 0.1, 0], scale: [0.2, 0.2, 0.2] }] },
};
const KEEPS = {
  ...ROTS, id: 'zz-bin-keeps', name: 'Test Keeper', tags: ['pantry', 'shelf-stable'],
  shelf_life_days: 365,
};
const SKIP = {
  id: 'zz-bin-piece', kind: 'bin', name: 'Test Skip', cost: 40,
  model: { parts: [{ shape: 'box', color: '#4a6a52', pos: [0, 0.3, 0], scale: [0.8, 0.5, 0.6] }] },
  tiers: [{ name: 'Standard', cost: 0 }],
};
const HAND = {
  id: 'zz-bin-hand', name: 'Test Binman', color: '#6d6a58',
  jobs: [{ job: 'tidy', weight: 1 }], cost: 0, wage: 0, speed: 20, pace: 0.05,
  tiers: [{ name: 'Standard', cost: 0 }],
};

process.on('exit', () => {
  for (const [t, id] of [['items', ROTS.id], ['items', KEEPS.id],
    ['fixtures', SKIP.id], ['workers', HAND.id]]) {
    try { remove(t, id); } catch { /* best effort */ }
  }
});
for (const [kind, row] of [['item', ROTS], ['item', KEEPS], ['fixture', SKIP], ['worker', HAND]]) {
  const res = writeContent(kind, row, 'verify');
  check(res.ok, `the catalog accepts the test ${kind} ${row.id}`, res.error ?? '');
}
refresh();

function fresh({ jobs = null } = {}) {
  const g = Game.create({ worldId: 'verify-bin', seed: 'bin', ephemeral: true });
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
  g.addPlayer('me', 'Tester');
  g.players.me.build = { on: true };
  if (jobs) {
    const res = g.hire(HAND.id);
    check(res.ok, 'the binman joins', res.error ?? '');
    g.roster[g.roster.length - 1].jobs = jobs;
    g.step(0.1);
  }
  return g;
}

const hand = (g) => g.players[`staff-${g.roster[g.roster.length - 1]?.id}`];
const run = (g, ticks) => { for (let i = 0; i < ticks; i++) g.step(0.1); };
const until = (g, done, limit = 1500) => {
  for (let i = 0; i < limit; i++) { if (done()) return i; g.step(0.1); }
  return done() ? limit : null;
};
const wasteCrates = (g) => g.deliveries.filter((d) => d.waste);
const board = (g, shelf, item, qty, ago = 0) => {
  shelf.stacks = [...(shelf.stacks ?? []),
    { item_id: item.id, qty, price: 3, stockedDay: g.day - ago }];
};

/** Somewhere a skip may legally stand. */
function binSpot(g) {
  for (let z = 1; z < g.layout.h - 1; z++) {
    for (let x = 1; x < g.layout.w - 1; x++) {
      if (canPlace(g.layout, { kind: 'bin', x, z, rot: 2 }).ok) return { x, z };
    }
  }
  return null;
}
function withBin(g) {
  const at = binSpot(g);
  check(!!at, 'there is somewhere to stand a skip');
  const res = g.placeFixture('me', { kind: 'bin', piece: SKIP.id, x: at.x, z: at.z, rot: 2 });
  check(res.ok, 'the skip goes down', res.error ?? '');
  return g.anyBin();
}

// ---------------------------------------------------------------------------
// 1. A shop with no skip still MAKES rubbish — it just cannot shift it.
//
// This was the reverse claim, and it is worth recording why it flipped. Rot
// becoming a box was gated on owning a skip, so the whole feature was opt-in
// and a shop without one was the old game to the unit. What that meant in play
// is that most shops went on making rot VANISH at midnight while the log said
// it had been "binned" — into a bin that does not exist. The money gone, the
// floor clean, and the only trace a sentence describing something that never
// happened.
//
// So rubbish is not the thing you opt into; SHIFTING it is. A shop with no skip
// fills up, which is ugly and costs patience through `mess` and is exactly the
// pressure that makes a skip worth buying. What must still hold either way is
// the money — see section 2.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  check(!g.anyBin(), 'a shop opens without one');
  const shelf = g.layout.shelves[0];
  board(g, shelf, ROTS, 9, 99);

  g.spoilStock();
  eq(g.shelfStack(shelf, ROTS.id), null, 'it still rots');
  eq(g.stats.spoiled, 9, 'and is still counted as spoiled');
  check(g.stats.spoiledValue > 0, 'and still priced into the P&L');
  const rubbish = wasteCrates(g);
  eq(rubbish.length, 1, '…and it is standing there as a box, skip or no skip');
  eq(lotTotal(rubbish[0]), 9, 'holding every unit of it');
}

// ---------------------------------------------------------------------------
// 2. With one, the same rot becomes a box you can see — and the MONEY does not
//    move.
//
// The second half is the one that could quietly rebalance the game. Rot is
// already in the P&L at the moment it rots; counting it again when somebody
// gets round to carrying it out, or not counting it until then, would each make
// the skip worth something it is not meant to be worth.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  withBin(g);
  const shelf = g.layout.shelves[0];
  board(g, shelf, ROTS, 9, 99);

  g.spoilStock();
  const rubbish = wasteCrates(g);
  eq(rubbish.length, 1, 'the rot is standing there as one box');
  eq(lotTotal(rubbish[0]), 9, 'holding every unit of it');
  eq(g.stats.spoiled, 9, 'counted as spoiled exactly once');

  // Same shop, same rot, no skip: the numbers have to match to the cent or the
  // skip is a balance change wearing a prop.
  const g2 = fresh();
  const sh2 = g2.layout.shelves[0];
  board(g2, sh2, ROTS, 9, 99);
  g2.spoilStock();
  eq(g.stats.spoiled, g2.stats.spoiled, 'the same units either way');
  eq(g.stats.spoiledValue, g2.stats.spoiledValue, 'and the same money, to the cent');

  // Rubbish goes down where the food was, NOT on a pad. `padRoom` is what the
  // farm and the kitchen are gated on, so rot that landed on the drop-off would
  // stop your beds being picked — days later, with nothing to connect the two.
  eq(g.padRoom(), g2.padRoom(), 'and the production buffer is untouched');
}

// ---------------------------------------------------------------------------
// 3. Rubbish is not stock, in all ten places that walk `deliveries`.
//
// The `inACar` trap. Every one of these loops was written when the only thing
// in that list was goods, and not one of them looks wrong afterwards: the shop
// declining to reorder the thing that just went off, a stocker shelving rot, a
// chef cooking with it, a bay reporting itself full of rubbish it is not
// standing on.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  withBin(g);
  const shelf = g.layout.shelves[0];
  board(g, shelf, ROTS, 9, 99);
  const bayRoom = g.bayRoom();
  g.spoilStock();

  eq(g.stockCrates().length, 0, 'no crate of stock exists');
  eq(g.deliveries.length, 1, 'though a crate does');
  eq(g.homeSupply(ROTS.id), 0,
    'the shop does not count rot as supply, or it never reorders what went off');
  eq(g.bayRoom(), bayRoom, 'and rubbish takes no room at the bay');

  // ...but rubbish standing ON a pad takes its room, and the pair is the point.
  //
  // Every other loop in section 3 is "rot is not stock". These two are "rot is
  // not supply, and rot IS an obstruction" — which reads as a contradiction and
  // is the same distinction said twice: `homeSupply` asks what the shop HAS,
  // `padRoom` asks where anything can GO. A box of rot answers zero to the first
  // and its full weight to the second.
  //
  // Measured, not assumed: a live shop had all four drop-off cells under boxes
  // of rot while `padRoom` reported 45 units free, so the farm and the kitchen
  // were gated on a buffer that did not exist. Nothing about that is visible —
  // a pad of rubbish and a pad of stock are boxes on the same ground.
  const padWas = g.padRoom();
  const cell = g.dropPad().cells[0];
  g.dropWaste(ROTS.id, 6, { x: cell.x, z: cell.z });
  check(g.padRoom() < padWas,
    'rot standing on the drop-off takes the drop-off room', `${padWas} -> ${g.padRoom()}`);
  eq(g.homeSupply(ROTS.id), 0, 'while still counting as no supply whatever');

  const bayWas = g.bayRoom();
  const bcell = g.layout.bay.cells[0];
  g.dropWaste(ROTS.id, 6, { x: bcell.x, z: bcell.z });
  check(g.bayRoom() < bayWas, 'and rot on the bay takes the bay room', `${bayWas} -> ${g.bayRoom()}`);

  // ...and the one thing that must still see it: your own hands. Rubbish you
  // can neither pick up nor throw away is worse than rubbish that vanishes.
  const p = g.players.me;
  const crate = wasteCrates(g)[0];
  p.x = crate.x;
  p.z = crate.z;
  const lift = g.liftCrate('me', crate.id);
  check(lift.ok, 'you can pick a box of it up', lift.error ?? '');
  check(!!p.haul, 'and it is on your shoulder');
}

// ---------------------------------------------------------------------------
// 4. THE claim: a hire takes out rubbish and never takes out stock.
//
// docs/workers.md, said about a job loop nobody is watching. The failure is
// invisible and expensive: a crate of perfectly good bread walked to the tip
// looks exactly like a crate of rot walked to the tip.
// ---------------------------------------------------------------------------
{
  const g = fresh({ jobs: [{ job: 'tidy', weight: 1 }] });
  withBin(g);
  const shelf = g.layout.shelves[0];
  board(g, shelf, ROTS, 9, 99);
  g.spoilStock();
  eq(wasteCrates(g).length, 1, 'there is rubbish to take out');

  // ...and a crate of good stock standing right beside it, which is the whole
  // test. A guard written as "carry the nearest crate to the skip" passes every
  // assertion about the rot and destroys this.
  g.dropGoods(KEEPS.id, 6, { x: wasteCrates(g)[0].x, z: wasteCrates(g)[0].z + 1 });
  const goodsNow = () => g.stockCrates().reduce((n, d) => n + lotQty(d, KEEPS.id), 0);
  eq(goodsNow(), 6, 'and six units of good stock beside it');

  // ...and waiting for the LIST to empty is not waiting for the job to finish:
  // the crate leaves `deliveries` the moment it goes up on a shoulder, so a
  // sweep that stopped there would be asserting about a hire mid-walk.
  const done = until(g, () => wasteCrates(g).length === 0 && !hand(g)?.haul);
  check(done !== null, 'the rubbish goes out', 'it was still there after 150s');
  eq(goodsNow(), 6, 'and every unit of the good stock is still there');

  // Nothing left holding it either — a hire that ended the run with rubbish
  // welded to their shoulder is the `TIRED_PACE` pin all over again.
  check(!hand(g)?.haul, 'and nobody is still carrying it');
}

// ---------------------------------------------------------------------------
// 5. ...and a hire with the job and no skip does nothing at all.
//
// The failure this guards is a hire who stands over a box of rot forever, or
// worse, one who picks it up and cannot put it down.
// ---------------------------------------------------------------------------
{
  const g = fresh({ jobs: [{ job: 'tidy', weight: 1 }] });
  check(!g.anyBin(), 'no skip');
  // Rot cannot be MADE without a skip (section 1), so it is placed by hand —
  // which is also the state a shop is in the moment it sells its only bin.
  g.dropWaste(ROTS.id, 6, { x: g.layout.bay.cells[0].x, z: g.layout.bay.cells[0].z });
  eq(wasteCrates(g).length, 1, 'but there is rubbish');

  run(g, 900);
  eq(wasteCrates(g).length, 1, 'it stays where it is');
  check(!hand(g)?.haul, 'and nobody is stuck holding it');
  eq(lotTotal(wasteCrates(g)[0]), 6, 'with nothing lost out of it');
}

// ---------------------------------------------------------------------------
// 6. You may throw anything away, and that is yours alone.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const bin = withBin(g);
  const p = g.players.me;
  p.carry = { stacks: [{ item_id: KEEPS.id, qty: 4 }] };
  p.haul = { stacks: [{ item_id: ROTS.id, qty: 7 }] };

  const far = g.binGoods('me', bin.id);
  check(!far.ok, 'not from across the shop', 'it worked from anywhere');

  p.x = (bin.useAt ?? bin).x;
  p.z = (bin.useAt ?? bin).z;
  const res = g.binGoods('me', bin.id);
  check(res.ok, 'standing at it, in it goes', res.error ?? '');
  eq(res.binned, 11, 'both hands at once — an armful and the box on your shoulder');
  check(!p.carry && !p.haul, 'and you are empty-handed');

  // No money either way. Charging is the trap `stow` already documents — it
  // punishes the moment somebody is experimenting — and refunding would make
  // the skip a second, worse till.
  const cash = g.cash;
  p.carry = { stacks: [{ item_id: KEEPS.id, qty: 4 }] };
  g.binGoods('me', bin.id);
  eq(g.cash, cash, 'it neither charges nor pays');
}

// ---------------------------------------------------------------------------
// 7. It is a fixture like any other, which is four things nothing else checks.
//
// Every one of these is a place a new kind dies quietly, and CLAUDE.md records
// the hot counter dying in two of them: an enumeration with a sensible-looking
// fallback. `compose`'s is `makeShelf`, so a bin with no branch is not refused
// — it is silently BUILT AS SHELVING.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const bin = withBin(g);
  eq(bin.kind, 'bin', 'it knows what it is');
  check(FIXTURE_KINDS.includes('bin'), 'and the kind is in the closed set');

  const id = bin.id;
  g.placeFixture('me', {
    kind: 'shelf', x: g.layout.store.x + 1, z: g.layout.store.z + 1, rot: 0,
  });
  const after = (g.layout.bins ?? []).find((b) => b.id === id);
  check(!!after, 'it survives a re-flow', 'buying a shelf dropped it');
  check(!g.layout.shelves.some((s) => s.id === id), 'and did not come back as shelving');

  // It resolves to its own catalog row, which is what `verify:till` sweeps for:
  // a record with no `kind` matches nothing and `fixtureStats` answers 1/1/1.
  eq(g.fixtureContent(after)?.id, SKIP.id, 'and to its own piece');

  // Findable, pointable, sellable — the three things build mode does to
  // everything else.
  check(!!g.findFixture(id), 'build mode can find it');
  const sold = g.removeFixture('me', id);
  check(sold.ok, 'and sell it back', sold.error ?? '');
  check(!g.anyBin(), 'leaving the shop without one again');
}

// ---------------------------------------------------------------------------
// 8. Indoors or out, which no other fixture is.
//
// `canPlace` had two branches — indoor, and the PLOT rule wearing a general
// name — so `where: 'any'` fell into the second and was told it could only be
// dug into bare grass. What that reads as is a palette offering a thing the
// shop then refuses.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  let inside = null;
  for (let z = g.layout.store.z + 1; z < g.layout.store.z + g.layout.store.h - 1 && !inside; z++) {
    for (let x = g.layout.store.x + 1; x < g.layout.store.x + g.layout.store.w - 1 && !inside; x++) {
      if (canPlace(g.layout, { kind: 'shelf', x, z, rot: 0 }).ok) inside = { x, z };
    }
  }
  check(!!inside, 'the shop has a free indoor tile to test with');
  const out = { x: 1, z: 1 };
  check(canPlace(g.layout, { kind: 'bin', ...inside, rot: 2 }).ok,
    'a skip may stand on the shop floor',
    canPlace(g.layout, { kind: 'bin', ...inside, rot: 2 }).error ?? '');
  check(canPlace(g.layout, { kind: 'bin', ...out, rot: 2 }).ok,
    'and out on the grass',
    canPlace(g.layout, { kind: 'bin', ...out, rot: 2 }).error ?? '');
  // ...and still not on top of something.
  const shelf = g.layout.shelves[0];
  check(!canPlace(g.layout, { kind: 'bin', x: shelf.x, z: shelf.z, rot: 2 }).ok,
    'but not through a shelf');
}

// ---------------------------------------------------------------------------
// 9. Rubbish gathers rather than scattering, and never merges with goods.
//
// `dropGoods` tops up any box within a couple of tiles before opening a new
// one, which is right for stock and catastrophic here: the box it would top up
// is full of things somebody is going to sell. One rotten pile merged into a
// crate of good bread makes the whole crate rubbish or makes the rubbish stock,
// and there is no third answer.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  withBin(g);
  const at = { x: g.layout.store.x + 3, z: g.layout.store.z + 3 };
  g.dropGoods(KEEPS.id, 5, at);
  const stock = g.stockCrates()[0];

  g.dropWaste(ROTS.id, 4, at);
  eq(lotQty(stock, ROTS.id), 0, 'rot never lands in a crate of goods');
  eq(wasteCrates(g).length, 1, 'it opens its own box');

  // ...and a second day of it joins the first rather than making a forest of
  // one-unit crates.
  g.dropWaste(ROTS.id, 3, at);
  g.dropWaste(KEEPS.id, 2, at);
  eq(wasteCrates(g).length, 1, 'more rot joins the box already there');
  eq(lotTotal(wasteCrates(g)[0]), 9, 'holding all of it');
  eq(lotStacks(wasteCrates(g)[0]).length, 2, 'as its own piles, the way a mixed crate is');
  eq(lotQty(stock, KEEPS.id), 5, 'and the goods beside it never moved');
}

// ---------------------------------------------------------------------------
// 10. Taking the rubbish out is TIDYING, and tidying is still tidying.
//
// It shipped as a job of its own (`binning`) and that was a record to say a
// thing the shop already had a word for. What the extra name cost is the
// failure that found it: all five authored worker kinds carry `tidy` and none
// of them carried `binning`, so a live shop stood 305 units of rot beside a
// skip it had paid for, with seven hires who were all — in their own terms —
// cleaning up. Nothing was broken. The mechanic was complete, swept and
// passing, and simply unreachable, which from inside the shop looks identical.
//
// So this is a claim about the JOB NAME rather than about the routine, and it
// has to be a pair. Folding a second routine into a job is exactly how the
// first one quietly stops running: `tidy` was two lines, and an armful with
// nowhere to go is what it has always been for.
// ---------------------------------------------------------------------------
{
  // `JOBS` is the vocabulary, and a name nobody can author is worse than no
  // name: the enum is what validates, so this is what stops it coming back.
  check(!JOBS.includes('binning'), 'there is no separate rubbish job to forget to assign');
  check(JOBS.includes('tidy'), 'and cleaning up is still a job you can assign');

  // Half one: the rubbish goes out for a hire who was only ever told to tidy.
  const g = fresh({ jobs: [{ job: 'tidy', weight: 1 }] });
  withBin(g);
  const shelf = g.layout.shelves[0];
  board(g, shelf, ROTS, 7, 99);
  g.spoilStock();
  eq(wasteCrates(g).length, 1, 'a shelf of rot becomes a box');
  check(until(g, () => wasteCrates(g).length === 0 && !hand(g)?.haul) !== null,
    'and somebody with only `tidy` takes it out');

  // Half two: the job it already had still works. A hire holding an armful the
  // shop has nowhere for must still crate it at the drop-off — and the rubbish
  // branch must not be what answers, or the fold ate the original.
  const s = hand(g);
  check(!!s, 'the hire is still on the roster');
  s.carry = { item_id: KEEPS.id, qty: 4 };
  const before = g.stockCrates().reduce((n, d) => n + lotQty(d, KEEPS.id), 0);
  check(until(g, () => !hand(g)?.carry) !== null, 'an armful with nowhere to go is still crated');
  eq(g.stockCrates().reduce((n, d) => n + lotQty(d, KEEPS.id), 0), before + 4,
    'all four units of it, as stock rather than as rubbish');
  eq(wasteCrates(g).length, 0, 'and none of it went to the tip');
}

// ---------------------------------------------------------------------------
// 11. A box on the floor is in the way, and a tip is a worse shop to be in.
//
// Crates were ghosts: shoppers walked through them, they took no floor room,
// and they cost the shop's mood exactly nothing. So thirty boxes of rot in an
// aisle was a picture and nothing else — the one state in the game where what
// you can plainly see is wrong is free.
//
// Nothing here is visible in a screenshot, which is the usual reason, but this
// one is worse than usual: the *picture is identical either way*. A shop full of
// boxes looks like a shop full of boxes whether or not anybody minds.
//
// The pair that matters is who pays. A shopper walks round; a hire walks over —
// because a rule that kept staff out would make the mess permanent at exactly
// the moment it started to matter, which is `verify:break`'s pin said about
// customers.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const { w, h, indoor, blocked } = g.layout;
  const floor = [];
  for (let i = 0; i < w * h; i++) if (indoor[i] && !blocked?.[i]) floor.push(i);
  check(floor.length > 12, 'the shop has a floor to clutter', `${floor.length} tiles`);

  eq(g.measureMess(), 0, 'an empty shop is not a tip');

  // ...and the yard is not one either, which is the clause that keeps this from
  // being a constant. Crates on a pad are crates doing their job.
  const bay = g.layout.bay.cells[0];
  g.dropGoods(KEEPS.id, 6, { x: bay.x, z: bay.z });
  eq(g.measureMess(), 0, 'and neither is a full delivery bay');

  // On the shop floor it counts, by TILE rather than by unit: a hundred loaves
  // in one box is one thing to look at.
  const at = (i) => ({ x: i % w, z: (i - (i % w)) / w });
  g.dropGoods(KEEPS.id, 6, at(floor[0]));
  const one = g.measureMess();
  check(one > 0, 'a box on the shop floor does', `${one}`);
  g.dropGoods(KEEPS.id, 6, at(floor[0]));
  eq(g.measureMess(), one, 'and a second box on the same tile is still one untidy tile');

  // Rubbish counts double, which is the only thing that makes a skip worth
  // anything to a shopper rather than to your conscience.
  const g2 = fresh();
  g2.dropGoods(KEEPS.id, 6, at(floor[1]));
  const stockMess = g2.measureMess();
  const g3 = fresh();
  g3.dropWaste(ROTS.id, 6, at(floor[1]));
  check(g3.measureMess() > stockMess,
    'a box of rot is a worse mess than a box of stock', `${g3.measureMess()} vs ${stockMess}`);

  // ...and it costs mood. Same shop, same shopper, same seconds — the only
  // difference is the floor. Driven through the real `stepMood`, because the
  // constants are not the claim: that clutter is ON the bill is.
  const shopper = (game) => {
    const cust = { id: 'c1', archetype_id: 'x', state: 'BROWSE', mood: 1, patience: 20 };
    game.customers = { c1: cust };
    return cust;
  };
  const tidy = fresh();
  const tidyCust = shopper(tidy);
  tidy.mess = tidy.measureMess();
  for (let i = 0; i < 100; i++) tidy.stepMood(tidyCust, 0.1);

  const messy = fresh();
  for (let n = 0; n < Math.min(20, floor.length); n++) messy.dropWaste(ROTS.id, 6, at(floor[n]));
  const messyCust = shopper(messy);
  messy.mess = messy.measureMess();
  for (let i = 0; i < 100; i++) messy.stepMood(messyCust, 0.1);

  check(messyCust.mood < tidyCust.mood,
    'ten seconds in a tip costs more patience than ten in a tidy shop',
    `tip ${messyCust.mood.toFixed(3)} vs tidy ${tidyCust.mood.toFixed(3)}`);

  // And the routing pair. A crate mid-route turns a shopper aside and does not
  // touch anybody who works here.
  const r = fresh();
  const a0 = at(floor[0]);
  const b0 = at(floor[floor.length - 1]);
  const plain = findPath(r.walk, r.layout, a0, b0, { shopper: true });
  check(!!plain?.length, 'there is a route across the shop');
  const midway = plain[Math.floor(plain.length / 2)];
  const box = new Set([midway.z * w + midway.x]);
  const on = (path) => (path ?? []).some((p) => p.x === midway.x && p.z === midway.z);
  check(!on(findPath(r.walk, r.layout, a0, b0, { shopper: true, clutter: box })),
    'a shopper goes round a crate in the way');
  check(on(findPath(r.walk, r.layout, a0, b0, { shopper: false, clutter: box })),
    'and a hire walks straight over it, or the mess could never be cleared');

  // The degenerate case degrades rather than breaking: boxed in, a shopper
  // climbs over unhappily instead of the shop ceasing to work. This is why the
  // clutter is a PRICE and not a wall.
  const sealed = new Set(plain.map((p) => p.z * w + p.x));
  const forced = findPath(r.walk, r.layout, a0, b0, { shopper: true, clutter: sealed });
  check(!!forced?.length, 'and a shopper walled in by boxes still finds a way out');
}

// ---------------------------------------------------------------------------

console.log(`\nverify:bin — ${checks} assertions`);
if (failures.length) {
  console.error(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✅  the shop has a way out, your crew take the rubbish and never your stock.\n');
