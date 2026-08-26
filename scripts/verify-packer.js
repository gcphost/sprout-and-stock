#!/usr/bin/env node
/**
 * VERIFY: THE BOX THAT STANDS STILL.
 *
 * Everything else on a run moves a box from where it is to where it should be.
 * A packer is the only piece that changes what is IN one, and every claim in
 * here is invisible twice over: a crate that was packed and a crate that arrived
 * that way are the same box on the same shelf, and the shop is the same shop
 * afterwards either way — only the number of journeys moved. So it ships WITH
 * the feature, the way `verify:doors`, `verify:park`, `verify:price`,
 * `verify:routes` and `verify:pens` did, and for the reason `verify:ceiling` is
 * the counter-example this repo keeps: the sweep ships with the feature, a smoke
 * test is not one.
 *
 * The trip it exists for is the trip nothing downstream of a delivery can make.
 * Four eggs in one box, four bread in another, four lettuce in a third is three
 * journeys down the same line to three different aisles — a hire cannot fold
 * them (`wholeCrate` refuses a box not worth more than an armful, `fit` scores
 * each at four) and until now a belt could not either, because every loader down
 * the run is asked one question and it is about the box in front of it.
 *
 * What it guards:
 *
 * - **The control: a shop with no packer is the old game.** Empty list, no pass,
 *   no clock, no field on any crate. This is the assertion that decides whether
 *   any of this is opt-in, and every save in existence is one of these.
 * - **It is a belt by its stamp and a machine by its footprint**, which is the
 *   loader's pair — and because a non-blocking cell is invisible to `blocked`,
 *   the `T.BELT` stamp is what refuses the second piece on the square.
 * - **…and it is still a packer after a re-flow.** The trap CLAUDE.md records
 *   the hot counter dying in twice: `compose`'s `else` is `makeShelf`, so a kind
 *   with no branch is not refused — it is silently BUILT AS SHELVING, keeps its
 *   id and its price, and takes bread.
 * - **A box goes past and comes out lighter.** The centrepiece of the taking
 *   half: what it wants comes out, and — the paired half that is worthless
 *   alone — THE REMAINDER RIDES ON. A packer that held the arrival until it was
 *   empty is a plug that stops a run dead the first time you send it a crate of
 *   something it was never asked for, and what that reads as is the conveyor
 *   being broken rather than the machine being full.
 * - **It lets go**, and the three ways it may. Full, satisfied, and STALE —
 *   which is the one that will feel wrong and is doing all the work. A box
 *   waiting on a kind that is not coming waits for the rest of the save, holding
 *   goods nothing can reach with every light on the machine saying it is
 *   working. That is the given-up-board bug with a roof on it.
 * - **`LOT_KINDS` is three and a shopping list is not.** The cap is asserted as
 *   a refusal you can read, because a packer told to build four kinds can never
 *   be satisfied at all — the failure is not a wrong box, it is a permanent one.
 * - **Conservation**, over the whole circuit. A packer is a new place goods move
 *   between and every one of those in this game has been a hole.
 * - **The spoilage stamp rides across, and the OLDER one wins.** Two dodges in
 *   one line of `lotAdd`: a merge keeps the destination's stamp, and a kind the
 *   box has not got arrives as a bare pair with no stamp at all, which
 *   `spoilYard` reads as fresh for ever. Either one makes packing the way to
 *   beat rot, and a crate of laundered flour looks exactly like a crate of
 *   flour. It is `verify:pack`'s own centrepiece said about a machine.
 * - **Rubbish is not folded in**, either way round, which is the same claim with
 *   the consequence turned up: rot merged into a box of bread comes out wearing
 *   the bread's date.
 * - **The crew do not empty it.** The `inACar` trap in its third form —
 *   `floorCrates` was a complete description of "a box anybody may lift" until a
 *   machine could hold one still, and `unload` scores a stray at `stray * 1e6`,
 *   so unguarded every stocker in the shop queues at the machine bought to
 *   replace their walk, while visibly doing their job.
 * - **A re-flow does not eat the box, and R does not clear the list.**
 *   `repositionFixture` names every field it keeps, and the press that follows
 *   laying one is R.
 *
 * It authors two items, two fixture rows and a worker, and removes them on exit.
 *
 *   node scripts/verify-packer.js
 */

import { Game } from '../server/sim/index.js';
import { writeContent, refresh, content } from '../server/content.js';
import { remove } from '../server/db.js';
import { MILESTONES } from '../server/sim/goals.js';
import { canPlace, anchorTile, isWalkableTile, conveyorNext } from '../shared/build.js';
import { T } from '../shared/tiles.js';
import { LOT_KINDS, lotQty, lotTotal, lotStacks } from '../shared/lot.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SHOP = { shelf: 4, freezer: 0, warmer: 0, checkout: 1, plot: 0, stations: [] };

/**
 * Two items, both shelf-stable and both ordinary.
 *
 * Deliberately the same in every respect that matters, because nearly every way
 * of getting a packer wrong moves too much rather than too little: the second is
 * the control that says a box was folded rather than emptied.
 */
const A = {
  id: 'zz-pack-a', name: 'Test Rusks', category: 'ambient',
  tags: ['shelf-stable', 'cheap'], base_cost: 1, base_price: 3, shelf_life_days: 300,
};
const B = {
  id: 'zz-pack-b', name: 'Test Wafers', category: 'ambient',
  tags: ['shelf-stable', 'cheap'], base_cost: 1, base_price: 3, shelf_life_days: 300,
};
const BELT = {
  id: 'zz-pack-belt', kind: 'belt', name: 'Test Belt', cost: 10,
  model: { parts: [{ shape: 'box', color: '#3b3f46', pos: [0, 0.06, 0], scale: [0.9, 0.12, 0.9] }] },
  tiers: [{ name: 'Standard', cost: 0 }],
};
const PACKER = {
  id: 'zz-pack-piece', kind: 'packer', name: 'Test Packer', cost: 40,
  model: { parts: [{ shape: 'box', color: '#4a7c8c', pos: [0, 0.4, 0], scale: [0.9, 0.8, 0.9] }] },
  tiers: [{ name: 'Standard', cost: 0 }],
};
/** An ordinary stocker, for the one claim a sweep over the Game cannot make. */
const STOCKER = {
  id: 'zz-pack-stocker', name: 'Test Stocker', color: '#6b8fb5',
  jobs: [{ job: 'unload', weight: 10 }, { job: 'shelve', weight: 10 }],
  cost: 0, wage: 0, speed: 20, pace: 0.05, carry: 6,
  tiers: [{ name: 'Standard', cost: 0 }],
};

process.on('exit', () => {
  for (const [t, id] of [['items', A.id], ['items', B.id],
    ['fixtures', BELT.id], ['fixtures', PACKER.id], ['workers', STOCKER.id]]) {
    try { remove(t, id); } catch { /* best effort */ }
  }
});
for (const [kind, row] of [['item', A], ['item', B], ['fixture', BELT],
  ['fixture', PACKER], ['worker', STOCKER]]) {
  const res = writeContent(kind, row, 'verify');
  check(res.ok, `the catalog accepts the test ${kind} ${row.id}`, res.error ?? '');
}
refresh();

function fresh({ crew = null } = {}) {
  const g = Game.create({ worldId: 'verify-packer', seed: 'pack', ephemeral: true });
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
  for (const sh of g.layout.shelves ?? []) sh.stacks = [];
  g.addPlayer('me', 'Tester');
  g.players.me.build = { on: true };
  if (crew) {
    const res = g.hire(crew);
    check(res.ok, 'the hire joins', res.error ?? '');
    g.step(0.1);
  }
  return g;
}

const run = (g, ticks) => { for (let i = 0; i < ticks; i++) g.step(0.1); };
function until(g, done, limit = 2000) {
  for (let i = 0; i < limit; i++) { g.step(0.1); if (done()) return true; }
  return false;
}
/** Every unit of stock in the shop, wherever it is. The conservation figure. */
const units = (g) => g.deliveries.reduce((n, d) => n + lotTotal(d), 0)
  + (g.layout.shelves ?? []).reduce((n, s) => n
    + (s.stacks ?? []).reduce((m, st) => m + (st.qty ?? 0), 0), 0)
  + Object.values(g.players).reduce((n, p) => n + lotTotal(p.carry) + lotTotal(p.haul), 0);

/**
 * A straight east-west row of cells a conveyor may legally stand on.
 *
 * Asked of `canPlace` rather than of the tiles, for `verify:belts`' reason: a
 * helper that wrote `layout.belts` by hand would pass while every real press was
 * refused.
 */
function row(g, len) {
  const L = g.layout;
  for (let z = 1; z < L.h - 1; z++) {
    for (let x = 1; x + len < L.w - 1; x++) {
      const cells = Array.from({ length: len }, (_, i) => ({ x: x + i, z }));
      if (cells.every((c) => canPlace(L, { kind: 'belt', x: c.x, z: c.z, rot: 0 }).ok)) return cells;
    }
  }
  return null;
}

/** Lay a run of belts east, with a packer at `packAt` along it. */
function lay(g, cells, packAt) {
  const ids = [];
  cells.forEach((c, i) => {
    const kind = i === packAt ? 'packer' : 'belt';
    const piece = i === packAt ? PACKER.id : BELT.id;
    const res = g.placeFixture('me', { kind, piece, x: c.x, z: c.z, rot: 0 });
    check(res.ok, `cell ${i} of the run goes down`, res.error ?? '');
    ids.push(res.placed ?? null);
  });
  return ids;
}

/** Put a crate of named piles down on a cell of the run. */
function feed(g, cell, piles) {
  const del = {
    id: `del-t${g.nextDeliveryId++}`,
    stacks: piles.map((p) => ({ item_id: p.id, qty: p.qty, ...(p.day != null ? { day: p.day } : {}) })),
    x: cell.x,
    z: cell.z,
  };
  g.deliveries.push(del);
  return del;
}

const packerOf = (g) => (g.layout.packers ?? [])[0] ?? null;
const boxOf = (g) => g.deliveries.find((d) => d.packer) ?? null;
const riding = (g) => g.deliveries.filter((d) => d.belt);

// ---------------------------------------------------------------------------
// 1. THE CONTROL. A shop that never built one is the old game.
// ---------------------------------------------------------------------------
//
// The assertion that decides whether any of this is opt-in. Every save in
// existence has no `packers` list at all, so an empty pass, an untouched crate
// and an unchanged snapshot are the whole claim — and if this is wrong, the
// feature has quietly changed every shop that has ever been played.
{
  const g = fresh();
  eq((g.layout.packers ?? []).length, 0, 'a shop that never built one has no packers');
  const cells = row(g, 4);
  check(!!cells, 'there is somewhere to lay a run');
  cells.forEach((c) => g.placeFixture('me', { kind: 'belt', piece: BELT.id, x: c.x, z: c.z, rot: 0 }));
  const del = feed(g, cells[0], [{ id: A.id, qty: 4 }]);
  const before = units(g);
  run(g, 200);
  eq(units(g), before, 'nothing is created or destroyed by the new pass');
  check(!g.deliveries.some((d) => d.packer != null),
    'no crate anywhere grows a packer field');
  eq(g.snapshot().packers.length, 0, '...and the wire carries an empty list');
  // The box still went somewhere, or the control is a shop where nothing moved
  // for a reason unconnected to packers.
  check(del.belt != null, 'the run still carries the box exactly as it did');
}

// ---------------------------------------------------------------------------
// 2. IT IS A BELT BY ITS STAMP AND A MACHINE BY ITS FOOTPRINT.
// ---------------------------------------------------------------------------
//
// The loader's pair, and the second half is what refuses a second piece on the
// square: a blocking fixture is refused by `blocked`, and the tile stamp is what
// refuses a walk-over one. A packer is both, so both must say no.
{
  const g = fresh();
  const cells = row(g, 3);
  const at = cells[1];
  const res = g.placeFixture('me', { kind: 'packer', piece: PACKER.id, x: at.x, z: at.z, rot: 0 });
  check(res.ok, 'a packer goes down', res.error ?? '');
  const k = packerOf(g);
  check(!!k, 'and it is standing there as a packer');
  eq(g.layout.tiles[at.z * g.layout.w + at.x], T.BELT, 'it stamps the conveyor tile');
  check(!isWalkableTile(g.layout, at.x, at.z) || g.layout.blocked[at.z * g.layout.w + at.x] === 1,
    'it occupies the square, like the loader whose housing it wears');
  // The conveyor swap rule, and a packer has to land INSIDE it rather than
  // beside it: a DIFFERENT kind on the square is a purchase that warns about
  // what it replaces, and the SAME kind is refused outright, because a belt over
  // a belt is a press that takes money and changes nothing. Both directions, or
  // the assertion is satisfied by a piece nothing can ever be built over.
  const swap = canPlace(g.layout, { kind: 'belt', x: at.x, z: at.z, rot: 0 });
  check(swap.ok && !!swap.warn, 'a belt over it is a swap rather than a refusal', swap.reason ?? '');
  check(!canPlace(g.layout, { kind: 'packer', x: at.x, z: at.z, rot: 0 }).ok,
    '...and a second packer on the square is refused outright');

  /**
   * ...and it resolved to the PIECE it asked for.
   *
   * `verify:pens`' assertion, and it earned its place there for a reason that
   * applies to every sweep that authors a fixture row: a refused content write
   * leaves the row absent, `pieceFor` falls through to `defaultPiece`, and every
   * number in this file is then measured against a shipped packer that does not
   * exist — which fails in a dozen places, none of them saying why.
   */
  eq(k?.piece, PACKER.id, 'the packer resolves to the piece it was built from');

  // ...and it is STILL a packer afterwards, which is the hot counter's bug.
  // `compose`'s `else` is `makeShelf`, so a kind with no branch is not refused —
  // it is silently built as shelving, keeps its id and its price, and takes
  // bread. A re-flow is what a purchase causes, so this is one press away.
  g.regenerateLayout();
  const after = (g.layout.packers ?? []).find((p) => p.id === k.id);
  check(!!after, 'a packer you built is still a packer after a re-flow');
  eq(after?.kind, 'packer', '...and still says so');
  check(!(g.layout.shelves ?? []).some((sh) => sh.id === k.id),
    '...and has not been quietly built as shelving');
}

// ---------------------------------------------------------------------------
// 3. THE CENTREPIECE. A box goes past and comes out lighter — and CARRIES ON.
// ---------------------------------------------------------------------------
//
// Both halves or neither. "It takes what it wants" is satisfied by a machine
// that swallows the crate whole, which is a plug: the first box holding anything
// it was not asked for stops the run for the rest of the save, and what that
// reads as is the conveyor being broken rather than the machine being full.
{
  const g = fresh();
  const cells = row(g, 5);
  lay(g, cells, 2);
  const k = packerOf(g);
  check(!!k, 'the packer is in the middle of the run');
  // Told to build A, so B is the control: it must ride straight through.
  const set = g.setPackerItems('me', k.id, [A.id]);
  check(set.ok, 'the packer takes a list', set.error ?? '');

  feed(g, cells[0], [{ id: A.id, qty: 3 }, { id: B.id, qty: 3 }]);
  const before = units(g);
  const moved = until(g, () => {
    const box = boxOf(g);
    return box && lotQty(box, A.id) >= 3;
  });
  check(moved, 'the packer takes the pile it was asked for');
  const box = boxOf(g);
  eq(lotQty(box, A.id), 3, '...all of it');
  eq(lotQty(box, B.id), 0, '...and none of what it was not asked for');
  // The paired half. The remainder is still a box, still on the line, and still
  // going the way it was going.
  const rest = g.deliveries.find((d) => d.belt && lotQty(d, B.id) > 0);
  check(!!rest, 'the remainder rides on rather than being swallowed');
  const wasAt = rest ? rest.belt : null;
  run(g, 60);
  check(rest && rest.belt !== wasAt, '...and it is still moving');
  eq(units(g), before, 'nothing is created or destroyed on the way');
}

// ---------------------------------------------------------------------------
// 3b. …AND A BOX IT EMPTIED GOES AWAY.
// ---------------------------------------------------------------------------
//
// `armTip`'s own ending. A crate riding on with nothing in it is a box that
// occupies a cell, draws as a box, and can never be got rid of.
{
  const g = fresh();
  const cells = row(g, 5);
  lay(g, cells, 2);
  const k = packerOf(g);
  g.setPackerItems('me', k.id, [A.id]);
  const del = feed(g, cells[0], [{ id: A.id, qty: 3 }]);
  const took = until(g, () => (boxOf(g)?.stacks ?? []).length > 0);
  check(took, 'the packer empties a box of exactly what it wanted');
  check(!g.deliveries.some((d) => d.id === del.id), '...and the empty box is gone');
}

// ---------------------------------------------------------------------------
// 4. IT LETS GO. Full, satisfied, and STALE.
// ---------------------------------------------------------------------------
{
  // 4a. FULL. A crate's worth is a trip by definition.
  const g = fresh();
  const cells = row(g, 6);
  lay(g, cells, 2);
  const k = packerOf(g);
  const cap = g.crateLot().cap;
  g.setPackerItems('me', k.id, [A.id, B.id]);
  // Fed as part-crates, or there is nothing to fold: a box that already beats an
  // armful rides through this machine untouched, so a single full crate would
  // satisfy the assertion below by simply going past.
  const bit = Math.max(1, Math.floor(g.carryCapacity() / 2));
  let outAt = false;
  for (let i = 0; i < 3000 && !outAt; i++) {
    if (i % 25 === 0 && i / 25 < Math.ceil(cap / bit) + 1) {
      feed(g, cells[0], [{ id: A.id, qty: bit }]);
    }
    g.step(0.1);
    outAt = g.deliveries.some((d) => d.belt && !d.packer && lotTotal(d) >= cap);
  }
  check(outAt, 'a box filled to the brim is put on the line');
  check(!boxOf(g) || lotTotal(boxOf(g)) < cap, '...and the machine is not still holding it');
}
{
  // 4b. SATISFIED, which is the whole pitch — and it is a PAIR, because the
  // half that was missing on the first build turns the entire piece off.
  //
  // "Every ticked kind is present" is satisfied by the first unit that lands, so
  // a list of one kind released a box holding a single loaf and started another:
  // a packer that emits exactly what it was fed, one pile at a time, which is a
  // length of belt that cost forty pounds. Nothing about it looks wrong — the
  // boxes go past, the shelves fill, and the trip you bought the machine to fold
  // is still being made three times. So the box has to BEAT AN ARMFUL as well,
  // which is `wholeCrate`'s own sentence for "worth a journey".
  //
  // The trickle is asserted first and is the one that would have caught it.
  const g = fresh();
  const cells = row(g, 6);
  lay(g, cells, 2);
  const k = packerOf(g);
  const arms = g.carryCapacity();
  g.setPackerItems('me', k.id, [A.id]);
  feed(g, cells[0], [{ id: A.id, qty: 1 }]);
  check(until(g, () => !!boxOf(g)), 'a box is started on the one unit that arrived');
  run(g, Math.round((Game.PACK_QUIET_SECONDS * 0.5) / 0.1));
  const trickle = boxOf(g);
  check(!!trickle && lotTotal(trickle) === 1,
    'a satisfied box that does not beat an armful is HELD, not sent',
    trickle ? String(lotTotal(trickle)) : 'gone');

  // ...and it goes as soon as it beats one, which on a line with nothing behind
  // it is the quiet clock rather than the long one.
  feed(g, cells[0], [{ id: A.id, qty: arms }]);
  const out = until(g, () => g.deliveries.some((d) => d.belt && !d.packer
    && lotQty(d, A.id) > 1));
  check(out, '...and goes out as soon as it beats one');
}
{
  // ...and the same claim over two kinds, which is the sentence the pitch made:
  // wait for the set, then send the set.
  const g = fresh();
  const cells = row(g, 6);
  lay(g, cells, 2);
  const k = packerOf(g);
  const arms = g.carryCapacity();
  g.setPackerItems('me', k.id, [A.id, B.id]);
  feed(g, cells[0], [{ id: A.id, qty: arms }]);
  check(until(g, () => lotQty(boxOf(g), A.id) >= arms), 'the first kind goes in');
  // Over an armful already, and still held — because the SET is not complete.
  // This is the assertion that says the list means something at all.
  check(!!boxOf(g), '...and a big pile of one kind is still not the set it was asked for');
  feed(g, cells[0], [{ id: B.id, qty: 2 }]);
  const out = until(g, () => g.deliveries.some((d) => d.belt && !d.packer
    && lotQty(d, A.id) >= arms && lotQty(d, B.id) === 2));
  check(out, 'the box goes out as one crate the moment the set is complete');
}
{
  // 4c. STALE, which is the safety catch and the claim that keeps this from
  // being a hole in the shop. A box waiting on a kind that is not coming waits
  // for the rest of the save — holding goods nothing can reach, with every light
  // saying it is working.
  //
  // It is asserted as a PAIR: that it does not go early (or "stale" is just a
  // slow version of "release everything", and the satisfied case above is
  // decorative), and that it does go in the end.
  const g = fresh();
  const cells = row(g, 6);
  lay(g, cells, 2);
  const k = packerOf(g);
  g.setPackerItems('me', k.id, [A.id, B.id]);
  feed(g, cells[0], [{ id: A.id, qty: 2 }]);
  const held = until(g, () => !!boxOf(g));
  check(held, 'it starts a box on the one kind that turned up');
  run(g, Math.round((Game.PACK_QUIET_SECONDS * 0.5) / 0.1));
  check(!!boxOf(g), '...and is still holding it half way through the wait');
  const went = until(g, () => !boxOf(g), Math.round((Game.PACK_STALE_SECONDS * 2) / 0.1));
  check(went, '...and sends it out when the other kind never comes');
}
{
  /*
   * 4d. …AND IT WAITS LONGER WHEN SOMETHING IS COMING.
   *
   * The pair that makes the lookahead worth having, and neither half means
   * anything alone: 4c says a box on an empty line goes out promptly, and this
   * says the same box holds while a crate it wants is still on its way. Written
   * as a comparison against `PACK_QUIET_SECONDS`, because a value would be
   * satisfied by a machine that simply always waits the long time — which is
   * what it did before it could see up the line.
   *
   * The crates go on the far end of a LONG run, so they are genuinely in transit
   * for the whole window rather than arriving and ending the test.
   */
  const g = fresh();
  const cells = row(g, 10);
  lay(g, cells, 9);
  const k = packerOf(g);
  g.setPackerItems('me', k.id, [A.id, B.id]);
  feed(g, cells[8], [{ id: A.id, qty: 2 }]);
  check(until(g, () => !!boxOf(g)), 'it starts a box');
  // A second crate right at the top of the run — inbound, and slow to arrive.
  // Stepped before it is asked about, because a crate set down on a conveyor
  // cell is not ON the run until `clearRails` has lifted it: `packerInbound`
  // reads `d.belt`, so asking on the tick it is fed is asking about a box that
  // is technically still on the floor.
  feed(g, cells[0], [{ id: A.id, qty: 2 }]);
  run(g, 20);
  check(g.packerInbound(k), 'the packer can see a crate coming that it wants');
  // KEPT inbound for the whole window, by topping the run up as it drains. One
  // crate is not enough: ten cells at track speed is a few seconds, so it
  // arrives, is folded in, and the line goes quiet — at which point the box
  // going out is the feature working rather than the claim failing. What is
  // being asserted is that the machine holds *while* something is coming, so
  // something has to be coming for the length of the assertion.
  let held = true;
  for (let i = 0; i < Math.round((Game.PACK_QUIET_SECONDS * 2) / 0.1); i++) {
    if (i % 30 === 0) feed(g, cells[0], [{ id: A.id, qty: 1 }]);
    g.step(0.1);
    if (!boxOf(g)) { held = false; break; }
  }
  check(held, '...so it is still holding well past the quiet wait');
  check(lotTotal(boxOf(g)) > 2, '...and has been folding the arrivals into it',
    String(lotTotal(boxOf(g) ?? null)));
}

// ---------------------------------------------------------------------------
// 5. `LOT_KINDS` IS THREE, AND A SHOPPING LIST IS NOT.
// ---------------------------------------------------------------------------
//
// The refusal is the point rather than tidiness. A crate holds three kinds, so a
// packer told to build four can never be satisfied at ALL — the failure is not a
// wrong box, it is a permanent one, and a cap you can read beats a stale timer
// you cannot.
{
  const g = fresh();
  const cells = row(g, 4);
  lay(g, cells, 1);
  const k = packerOf(g);
  const many = Array.from({ length: LOT_KINDS + 1 }, (_, i) => (i % 2 ? A.id : B.id));
  // Deduped first, so this is genuinely a list of distinct kinds one over the
  // cap rather than the same two items repeated.
  const distinct = [A.id, B.id, ...Array.from({ length: LOT_KINDS - 1 },
    (_, i) => `zz-pack-ghost-${i}`)];
  const over = g.setPackerItems('me', k.id, distinct);
  // Ghost ids are not in the catalog, so they are dropped before the cap is
  // measured — which is the OTHER half of the same guard and is asserted here
  // rather than separately: content is edited live, so a list naming a row
  // somebody deleted is the same permanent wait wearing a typo.
  check(over.ok, 'ids that name nothing are dropped rather than refused', over.error ?? '');
  eq((packerOf(g).assigned ?? []).length, 2, '...leaving only the two real ones');
  eq(g.setPackerItems('me', k.id, many).ok, true, 'a list with repeats is deduped');
  eq((packerOf(g).assigned ?? []).length, 2, '...to the kinds it actually names');
}

// ---------------------------------------------------------------------------
// 6. THE STAMP RIDES ACROSS, AND THE OLDER ONE WINS.
// ---------------------------------------------------------------------------
//
// Two dodges in one line of `lotAdd` and either one makes a packer the way to
// beat rot. A merge keeps the DESTINATION's stamp, so a fortnight-old pile
// folded into this morning's box comes out with this morning's date; and a kind
// the box has not got arrives as a bare `{item_id, qty}` with no stamp at all,
// which `spoilYard` reads as fresh for ever. A crate of laundered flour looks
// exactly like a crate of flour.
{
  const g = fresh();
  const cells = row(g, 6);
  lay(g, cells, 2);
  const k = packerOf(g);
  g.setPackerItems('me', k.id, [A.id]);
  g.day = 40;
  // The fresh pile first, so the old one arrives as a MERGE into a stack that
  // already has a date on it — which is the half that keeps the destination's
  // stamp and is therefore the half that launders.
  feed(g, cells[0], [{ id: A.id, qty: 2, day: 40 }]);
  check(until(g, () => lotQty(boxOf(g), A.id) >= 2), 'the fresh pile goes in');
  feed(g, cells[0], [{ id: A.id, qty: 2, day: 5 }]);
  check(until(g, () => lotQty(boxOf(g), A.id) >= 4), '...and the old one after it');
  const pile = lotStacks(boxOf(g)).find((s) => s.item_id === A.id);
  eq(pile?.day, 5, 'the box carries the OLDER stamp, not the one it already had');
}
{
  // ...and the other half: a kind the box has not got must not arrive bare.
  const g = fresh();
  const cells = row(g, 6);
  lay(g, cells, 2);
  const k = packerOf(g);
  g.setPackerItems('me', k.id, [A.id, B.id]);
  g.day = 40;
  feed(g, cells[0], [{ id: A.id, qty: 2, day: 40 }]);
  check(until(g, () => lotQty(boxOf(g), A.id) >= 2), 'the first kind goes in');
  feed(g, cells[0], [{ id: B.id, qty: 2, day: 7 }]);
  check(until(g, () => lotQty(boxOf(g), B.id) >= 2), '...and a second kind after it');
  const pile = lotStacks(boxOf(g)).find((s) => s.item_id === B.id);
  eq(pile?.day, 7, 'a NEW kind keeps its own stamp rather than arriving undated');
}

// ---------------------------------------------------------------------------
// 7. RUBBISH IS NOT FOLDED IN.
// ---------------------------------------------------------------------------
//
// Section 6 with the consequence turned up: rot merged into a box of bread comes
// out wearing the bread's date, which is the same laundering with nothing left
// to notice it by. `stockCrates` filters waste out everywhere in the game for
// exactly this reason, and the only thing on a run that may end one is a skip.
{
  const g = fresh();
  const cells = row(g, 6);
  lay(g, cells, 2);
  const k = packerOf(g);
  g.setPackerItems('me', k.id, [A.id]);
  const bin = feed(g, cells[0], [{ id: A.id, qty: 4 }]);
  bin.waste = true;
  run(g, 300);
  check(!boxOf(g), 'a packer takes nothing at all out of a waste crate');
  eq(lotQty(bin, A.id), 4, '...and the rubbish keeps every unit of it');
}

// ---------------------------------------------------------------------------
// 8. THE CREW DO NOT EMPTY IT.
// ---------------------------------------------------------------------------
//
// The `inACar` trap in its third form, and the one claim here that needs a hire.
// `floorCrates` is `!d.waste && !d.belt`, which was a complete description of "a
// box anybody may walk up to and lift" until a machine could hold one still — a
// packer's box is off the line and on the floor, so it answers. `unload` scores
// a stray at `stray * 1e6`, so unguarded every stocker in the shop abandons the
// bay and queues at the machine bought to replace their walk, while visibly
// doing their job.
{
  const g = fresh({ crew: STOCKER.id });
  const cells = row(g, 6);
  lay(g, cells, 2);
  const k = packerOf(g);
  g.setPackerItems('me', k.id, [A.id, B.id]);
  feed(g, cells[0], [{ id: A.id, qty: 2 }]);
  check(until(g, () => !!boxOf(g)), 'the packer starts a box');
  const box = boxOf(g);
  check(!g.floorCrates().some((d) => d.id === box.id),
    'the box it is building is not a crate the crew may lift');
  const held = lotTotal(box);
  run(g, 600);
  const still = g.deliveries.find((d) => d.id === box.id);
  // Either it is still in the machine holding what it held, or it went out on
  // the stale clock and is on the line — never in a hire's arms and never on a
  // shelf by way of one.
  check(!still || still.packer === k.id || still.belt != null,
    'a whole minute of crew time later, nobody has carried it off',
    still ? JSON.stringify({ packer: still.packer, belt: still.belt }) : 'gone');
  check(!still || lotTotal(still) >= held, '...and nothing has been taken out of it by hand');
}

// ---------------------------------------------------------------------------
// 9. A RE-FLOW DOES NOT EAT THE BOX, AND R DOES NOT CLEAR THE LIST.
// ---------------------------------------------------------------------------
//
// `repositionFixture` NAMES every field it keeps, so a setting left out is reset
// rather than merely not copied — and the press most likely to follow laying a
// piece is R. `sorter.auto` had exactly this bug from the day it shipped and no
// sweep caught it, because every sweep tested a re-flow and a re-flow is not a
// reposition. Both are asserted here for that reason.
{
  const g = fresh();
  const cells = row(g, 6);
  lay(g, cells, 2);
  const k = packerOf(g);
  g.setPackerItems('me', k.id, [A.id, B.id]);
  feed(g, cells[0], [{ id: A.id, qty: 2 }]);
  check(until(g, () => !!boxOf(g)), 'the packer starts a box');
  const before = units(g);

  g.regenerateLayout();
  const box = boxOf(g);
  check(!!box, 'the box survives a re-flow');
  eq(lotQty(box, A.id), 2, '...with what was in it');
  eq(units(g), before, '...and nothing is created or destroyed by the re-flow');
  eq((packerOf(g).assigned ?? []).join(), [A.id, B.id].join(),
    'the list survives a re-flow');

  const turned = g.rotateFixture('me', packerOf(g).id);
  check(turned.ok, 'R turns it', turned.error ?? '');
  eq((packerOf(g).assigned ?? []).join(), [A.id, B.id].join(),
    '...and the list survives the turn');
  eq(units(g), before, '...and so does every unit of stock');
}

// ---------------------------------------------------------------------------
// 10. WITH NO LIST IT READS THE SHOP.
// ---------------------------------------------------------------------------
//
// The other half of the control in section 1, and what makes the tick list an
// override rather than a setup step: a packer you have said nothing to is useful
// the moment you lay it. The evidence is the run's own — `conveyorServes` plus
// `shelfAccepts`, which is what a sorter routes on — so a packer with nothing
// downstream that wants the goods must take nothing at all.
{
  const g = fresh();
  const cells = row(g, 5);
  lay(g, cells, 2);
  const k = packerOf(g);
  eq((k.assigned ?? []).length, 0, 'a packer is laid with no list');
  feed(g, cells[0], [{ id: A.id, qty: 3 }]);
  run(g, 300);
  // No loader on this run, so nothing downstream serves anything: the box must
  // ride straight past. A packer that hoovered up regardless is a bin with a lid.
  check(!boxOf(g), 'a packer with nothing downstream that wants the goods takes none');
}

// ---------------------------------------------------------------------------
// 11. END TO END. Dock -> packer -> loader -> shelf.
// ---------------------------------------------------------------------------
//
// The shape the whole piece was proposed in, and the only section here that
// asserts the machine is USEFUL rather than merely correct. Three part-crates go
// on the run, one box comes off it, and the goods reach the shelf.
//
// It is also the only section that exercises the derived list — no tick, so the
// packer is reading `conveyorServes` down its own run — which is what makes it
// the pair to section 10: that one says a packer with nothing downstream takes
// nothing, this says the same packer with a loader and a shelf downstream takes
// everything. Either alone is satisfied by a machine that is simply off.
{
  const g = fresh();
  /**
   * A run AND somewhere to stand the shelf it feeds, found together.
   *
   * The two searched separately is how this section silently skipped itself on
   * its first run — the belt row landed somewhere with no shelf-legal neighbour,
   * the `if` never fired, and the report was green with 143 claims where it
   * should have had 150. A sweep that can quietly not run is worse than one that
   * fails, which is why the count is checked below rather than trusted.
   */
  const found = (() => {
    const L = g.layout;
    for (let z = 1; z < L.h - 1; z++) {
      for (let x = 1; x + 6 < L.w - 1; x++) {
        const line = Array.from({ length: 6 }, (_, i) => ({ x: x + i, z }));
        if (!line.every((c) => canPlace(L, { kind: 'belt', x: c.x, z: c.z, rot: 0 }).ok)) continue;
        const end = line[line.length - 1];
        const spot = [{ x: end.x, z: end.z - 1 }, { x: end.x, z: end.z + 1 },
          { x: end.x + 1, z: end.z }]
          .find((c) => canPlace(L, { kind: 'shelf', x: c.x, z: c.z, rot: 0 }).ok);
        if (spot) return { line, spot };
      }
    }
    return null;
  })();
  check(!!found, 'there is somewhere to lay a run that ends at a shelf');
  const cells = found?.line ?? [];
  const arm = cells[cells.length - 1];
  const spot = found?.spot;
  // The shelf is BUILT rather than borrowed from the generated shop, through the
  // ordinary press.
  const built = spot && g.placeFixture('me', { kind: 'shelf', x: spot.x, z: spot.z, rot: 0 });
  check(!!built?.ok, 'the shelf goes down', built?.error ?? '');
  const shelf = (g.layout.shelves ?? []).find((sh) => sh.x === spot?.x && sh.z === spot?.z);
  check(!!shelf, 'and it is standing there');
  if (shelf) {
    cells.slice(0, -1).forEach((c, i) => {
      const kind = i === 1 ? 'packer' : 'belt';
      const piece = i === 1 ? PACKER.id : BELT.id;
      const res = g.placeFixture('me', { kind, piece, x: c.x, z: c.z, rot: 0 });
      check(res.ok, `cell ${i} goes down`, res.error ?? '');
    });
    // Aimed at the shelf: `rot` on a loader is which side it unloads into.
    const face = shelf.x > arm.x ? 0 : shelf.x < arm.x ? 2 : shelf.z > arm.z ? 1 : 3;
    const put = g.placeFixture('me', { kind: 'arm', piece: null, x: arm.x, z: arm.z, rot: face });
    check(put.ok, 'the loader goes down at the end of the run', put.error ?? '');
    // Looked up AGAIN, after the last thing that re-flows. Every placement
    // rebuilds every record, so the shelf captured above is a dead object and a
    // sweep reading its `stacks` watches an empty list for ever — which fails as
    // "the goods never arrived", the bug this section is testing for.
    const board = () => (g.layout.shelves ?? []).find((sh) => sh.x === spot.x && sh.z === spot.z);

    const k = packerOf(g);
    eq((k?.assigned ?? []).length, 0, 'the packer is told nothing at all');
    // Three part-crates, exactly the bay `verify:pack` is about: no one of them
    // is worth a journey, and `fit` would score each of them the same.
    //
    // SPACED, and measured from the first tick. `beltBusy` files one crate per
    // cell, so three boxes set down on the same square at once are one that
    // rides and two that `clearRails` shoves OFF the run — a green-looking shop
    // where two of the three deliveries never reach the machine at all. And the
    // watch below has to be running while they are sent, or the fold happens
    // before anybody is counting and the high-water mark is whatever is left.
    const before = units(g) + 12;
    // The fold is watched as it happens, because by the time the goods are on
    // the shelf there is nothing left to count: the box that carried them has
    // been emptied by the loader and thrown away. `high` is the most that was
    // ever in one crate, which is the whole claim.
    let high = 0;
    let landed = false;
    for (let i = 0; i < 4000 && !landed; i++) {
      if (i === 0 || i === 20 || i === 40) feed(g, cells[0], [{ id: A.id, qty: 4 }]);
      g.step(0.1);
      for (const d of g.deliveries) high = Math.max(high, lotTotal(d));
      landed = (board()?.stacks ?? []).some((st) => st.item_id === A.id && st.qty > 0);
    }
    check(landed, 'the goods reach the shelf with nobody walking');
    eq(units(g), before, '...and nothing is created or destroyed on the way');
    // The point of the exercise. Three fours went on and something bigger than a
    // four came off, which is a trip that did not have to happen — the claim the
    // whole piece exists to make, and the one thing here a screenshot could not
    // tell from three separate deliveries arriving correctly.
    check(high > 4, 'they crossed the shop folded rather than as three fours',
      `most in one box: ${high}`);
  }
}

// ---------------------------------------------------------------------------
// 12. A PACKER IS A SOURCE OF FLOW, NOT A LEFTOVER.
// ---------------------------------------------------------------------------
//
// Its `rot` is its direction — that is the one place it parts company with the
// loader and the sorter, whose `rot` is spoken for — so `conveyorFlow` must SEED
// the forward walk from it, exactly as it seeds from a belt.
//
// Left out of that loop it is still in `cells`, so it still gets an answer: the
// leftovers pass at the bottom resolves it, AFTER every derived cell around it.
// A sorter downstream is then asked which way it carries on before anything
// knows which way the box was travelling, and it guesses. On the save this was
// found on it guessed its own FEEDER — the packer handed west into the junction
// and the junction's straight-on pointed back east into the packer.
//
// Nothing about that jams, which is why it needed an eye on a screenshot rather
// than any assertion already in this file: `conveyorBranches` refuses a
// neighbour that feeds you, so the junction's real legs were all still branches
// and boxes still went down them. The run worked. What you could see was the
// junction occasionally handing one back the way it came.
//
// So the claim is a COMPARISON and not a value: the cell downstream of a packer
// must resolve exactly as it does downstream of a belt. Written as a value it
// would pass on any straight-on that happens not to be the packer.
{
  const g = fresh();
  const cells = row(g, 5);
  // Belt, belt, PACKER, sorter, belt — and the same five with a belt in the
  // middle instead. The junction's answer must be the same either way.
  const build = (game, middle) => {
    cells.forEach((c, i) => {
      const kind = i === 2 ? middle : i === 3 ? 'sorter' : 'belt';
      const piece = i === 2 && middle === 'packer' ? PACKER.id : (kind === 'belt' ? BELT.id : null);
      const res = game.placeFixture('me', { kind, piece, x: c.x, z: c.z, rot: 0 });
      check(res.ok, `${middle} run cell ${i} goes down`, res.error ?? '');
    });
    const j = (game.layout.sorters ?? []).find((x) => x.x === cells[3].x && x.z === cells[3].z);
    const n = j && conveyorNext(game.layout, j);
    return n ? `${n.x},${n.z}` : 'none';
  };
  const withPacker = build(g, 'packer');
  const withBelt = build(fresh(), 'belt');
  eq(withPacker, withBelt,
    'the junction downstream of a packer carries on exactly where a belt would');
  // ...and the sharp half, said as a value because it is the actual failure:
  // never BACK at the thing that fed it.
  check(withPacker !== `${cells[2].x},${cells[2].z}`,
    'a junction fed by a packer never hands the box back to it');
}

// ---------------------------------------------------------------------------
// 13. IT DOES NOT EAT ITS OWN OUTPUT.
// ---------------------------------------------------------------------------
//
// `packerRelease` puts the built box ON THIS CELL — that is what a hand-off onto
// a run is — so for every tick it stands there waiting for the line ahead,
// `packerFeed` answers with the box the machine just sent. Unguarded it takes
// the piles straight back out into a fresh crate and sends that, for ever.
//
// Nothing jams and nothing is lost, which is why this needed an eye on a screen
// rather than any assertion already in this file — and the throughput figure is
// inflated by exactly the churn, so a sweep counting boxes sent would have
// called it a win. On a live save: 24 of 55 fills were the packer re-packing its
// own output, and the shop reported 299 boxes where the honest number is 28.
//
// The tell is the box's ID, which is what the assertion below is written on: a
// crate that flashes in and out is a NEW box each time, where a machine working
// normally holds one box and fills it.
//
// A dead end, deliberately: the released box has nowhere to go, so it sits on
// the packer's own cell, which is the state the bug lives in. A run with room
// hides it most of the time.
{
  const g = fresh();
  const cells = row(g, 4);
  // Belt, belt, packer — and nothing after it. The box it sends has nowhere.
  lay(g, cells.slice(0, 3), 2);
  const k = packerOf(g);
  const arms = g.carryCapacity();
  g.setPackerItems('me', k.id, [A.id]);
  // TWO part-crates, because one full one is no longer anything to fold — a box
  // that already beats an armful passes through untouched. See `packerSwing`.
  feed(g, cells[0], [{ id: A.id, qty: arms - 2 }]);
  check(until(g, () => !!boxOf(g)), 'the packer starts a box');
  feed(g, cells[0], [{ id: A.id, qty: arms - 2 }]);

  // Every box id it ever holds, over a long run at a blocked exit. One box
  // filling is one id; a machine eating its own output is a new id a second.
  const ids = new Set();
  for (let i = 0; i < 900; i++) {
    g.step(0.1);
    const box = boxOf(g);
    if (box) ids.add(box.id);
  }
  check(ids.size <= 2, 'it holds ONE box at a blocked exit rather than churning',
    `${ids.size} distinct boxes in 90s`);
  eq(units(g), (arms - 2) * 2, '...and nothing is created or destroyed while it waits');
}

// ---------------------------------------------------------------------------
// 14. A BOX ALREADY WORTH A JOURNEY RIDES THROUGH UNTOUCHED.
// ---------------------------------------------------------------------------
//
// The machine exists to fold PART-crates. A box that already beats an armful is
// already a trip, so taking it apart and reassembling it moves the same goods to
// the same shelf down the same run — the only thing that changed is that it
// stopped on the way.
//
// It is the only fault in this piece a screen could show you, and it showed:
// a full crate off a van went up onto the tray and came straight back down a
// second later, every time. Not a stutter and not a loss — the goods arrive
// correctly — but a machine visibly doing nothing, which cannot be told from one
// that is broken.
//
// A PAIR, and the second half is what stops the fix being "the packer is off":
// the same machine, same run, same item, still folds a box that is under the
// bar. Written as a comparison of the two, because a value would be satisfied by
// a packer that had simply stopped working.
{
  const g = fresh();
  const cells = row(g, 6);
  lay(g, cells, 2);
  const k = packerOf(g);
  const arms = g.carryCapacity();
  g.setPackerItems('me', k.id, [A.id]);

  // Over the bar: nothing may come out of it.
  const big = feed(g, cells[0], [{ id: A.id, qty: arms + 1 }]);
  run(g, 200);
  check(!boxOf(g), 'a crate already worth a journey is not taken apart');
  eq(lotQty(big, A.id), arms + 1, '...and rides on with every unit it arrived with');
  check(big.belt != null, '...still on the line');

  // Under it: the same machine folds, so the rule above is a threshold rather
  // than the machine being switched off.
  const small = feed(g, cells[0], [{ id: A.id, qty: arms - 1 }]);
  const took = until(g, () => !!boxOf(g), 600);
  check(took, 'a part-crate on the same run IS folded');
  eq(lotTotal(boxOf(g)), arms - 1, '...all of it');
  check(!g.deliveries.some((d) => d.id === small.id), '...and the empty box is gone');
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (failures.length) {
  console.error(`\nverify:packer — ${failures.length} of ${checks} claims failed:\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`verify:packer — ${checks} claims, all green.`);
