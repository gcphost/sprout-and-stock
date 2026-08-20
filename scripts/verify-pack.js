#!/usr/bin/env node
/**
 * VERIFY: A RUNG THAT PACKS ONE CRATE OUT OF SEVERAL.
 *
 * A bay of part-crates is the one shape the yard could never get out of in one
 * trip. Four lettuce, four eggs and four bread standing in three boxes is three
 * separate walks of the shop: no single box is worth shouldering (`fit` scores
 * each at four against an armful of six), and `fillHands` deliberately only
 * ever tops up a kind already in the arms, so the hire takes four and comes
 * back twice. `packs` on a tier is the way out — lift one box, fill it from the
 * others with whatever the shelves are short of, walk one full crate.
 *
 * Nothing in here can be looked at, and that is not a figure of speech: a hire
 * carrying a packed crate and a hire carrying the crate they found are the same
 * still frame, with the same box on the same shoulder. The claims:
 *
 * - **A shop with no packing rung authored is the old game exactly.** This is
 *   the control, and it is the assertion that decides whether the feature is
 *   opt-in or a silent change to every save in existence. `packs` defaults to
 *   0, `packFill` returns 0, and both size tests are the arithmetic they were.
 * - **Three part-crates become one trip.** The positive claim, and the only one
 *   anybody would think to write.
 * - **…and nothing is created or destroyed on the way.** Conservation, the same
 *   claim `verify:build` and `verify:hand` make: crate-to-crate is a new place
 *   goods move between, and every one of those in this game has been a hole.
 * - **The kinds cap is the RUNG's, not the crate's.** A `packs: 2` hire leaves
 *   the third kind standing. Without this the number is a boolean wearing an
 *   integer, which is the "tier that changes no number" trap inverted — every
 *   rung above 1 would do the same thing.
 * - **The older spoilage stamp wins the merge, and a new kind keeps its own.**
 *   Two dodges in one line of `lotAdd`: it merges by item id, keeping the
 *   DESTINATION's stamp, and pushes a bare `{item_id, qty}` for a kind the box
 *   has not got — which `spoilYard` reads as fresh for ever. Either one makes
 *   packing the way to beat spoilage, which is the exact dodge `stampPile`
 *   exists to close, and neither is visible: a crate of laundered flour looks
 *   like a crate of flour.
 * - **A packer never packs what the shelves have no room for.** Otherwise the
 *   full box walks to one board and carries the rest home, which is more
 *   journeys than not packing at all — the feature working backwards.
 * - **Rubbish never packs, either way round.** `verify:bin`'s claim said about
 *   the new verb: rot poured into a box of bread is rot back in the supply.
 * - **Only out of the yard.** `wholeCrate`'s termination argument said about
 *   the SECOND box. A packer drawing from a stray in an aisle takes goods
 *   somebody already carried out there and carries them back, and two hires
 *   could pass one pile between two boxes for the rest of the save.
 *
 * Runs on ephemeral Games, so it never touches the live shop. It writes two
 * worker rows into the content database — usually the live shared one — and
 * removes them on exit, the way `verify-hand` and `verify-catalog` do.
 *
 *   node scripts/verify-pack.js
 */

import { Game } from '../server/sim/index.js';
import { content, writeContent } from '../server/content.js';
import { remove } from '../server/db.js';
import { lotStacks, lotTotal, lotQty, LOT_KINDS } from '../shared/lot.js';
import { MILESTONES } from '../server/sim/goals.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SHOP = { shelf: 4, freezer: 0, checkout: 1, plot: 0 };

/**
 * Two hires, identical but for the rung, which is what makes every assertion
 * here a comparison rather than a value.
 *
 * `carry` is 6 — the shipped armful — deliberately, and it is the one number in
 * this file that must not be turned up. The whole feature is about a box that
 * is not worth shouldering against ONE PAIR OF HANDS, so a sweep with big hands
 * would find that every part-crate fits in the arms and never reach the branch
 * under test. It is `verify-hand`'s `carry: 60` argued the opposite way, and for
 * the same reason: the armful is what decides which assertions are reachable.
 *
 * Fast and tireless otherwise, so a run is ticks rather than minutes and no
 * assertion is quietly measuring `tiredness`.
 */
const PLAIN = {
  id: 'zz-pack-plain', name: 'Test Stocker', color: '#7a9e4b',
  jobs: [{ job: 'unload', weight: 1 }], cost: 0, wage: 0,
  speed: 20, pace: 0.05, carry: 6,
  tiers: [{ name: 'Standard', cost: 0 }],
};
/**
 * The packer's ladder is three rungs so the KINDS claim has somewhere to stand:
 * rung 2 packs two kinds and rung 3 packs three, off one authored row, so the
 * difference between the two assertions is a single integer on the roster.
 */
const PACKER = {
  ...PLAIN,
  id: 'zz-pack-packer', name: 'Test Packer',
  tiers: [
    { name: 'Standard', cost: 0 },
    { name: 'Packs a pair', cost: 0, packs: 2 },
    { name: 'Packs a box', cost: 0, packs: LOT_KINDS },
  ],
};
process.on('exit', () => {
  for (const w of [PLAIN, PACKER]) {
    try { remove('workers', w.id); } catch { /* best effort */ }
  }
});
for (const w of [PLAIN, PACKER]) {
  const res = writeContent('worker', w, 'verify');
  check(res.ok, `the catalog accepts ${w.name}`, res.error ?? '');
}

/**
 * Three ordinary ambient items, and they have to be three DIFFERENT ones.
 *
 * The kinds cap is what most of this file is about, so a sweep that reached for
 * the same row twice would be asserting about units while believing it was
 * asserting about kinds — and it would pass.
 */
const c = content();
const AMBIENT = c.items.filter((it) => !it.tags.includes('frozen') && !it.tags.includes('needs-freezer'));
check(AMBIENT.length >= 3, 'the catalog has three ambient items to pack', `${AMBIENT.length}`);
const [ITEM_A, ITEM_B, ITEM_C] = AMBIENT;

/**
 * …and two that KEEP, for the spoilage section, which cannot use the three
 * above.
 *
 * `spoilYard` does not wait for the day roll, so a pile stamped a fortnight ago
 * is binned out of the yard within a tick or two of the run starting — and what
 * that leaves is one crate of four on the pad, which is not worth shouldering,
 * so the hire takes an armful and the section's every assertion reads
 * `undefined`. It presents as the packing having failed. Picked by span rather
 * than by id for `verify-hand`'s reason: what rots is content somebody edits on
 * a Tuesday.
 */
const bySpan = AMBIENT.slice().sort((a, b) => (b.shelf_life_days ?? 0) - (a.shelf_life_days ?? 0));
const [KEEP_A, KEEP_B] = bySpan;
check((KEEP_B?.shelf_life_days ?? 0) > 20,
  'the catalog has two things that outlive a fortnight in the yard',
  `${KEEP_A?.id}:${KEEP_A?.shelf_life_days} ${KEEP_B?.id}:${KEEP_B?.shelf_life_days}`);

/** The same reset every other sweep makes — see `verify-hand` on each field. */
function fresh({ tier = 1, kind = PLAIN.id } = {}) {
  const g = Game.create({ worldId: 'verify-pack', seed: 'pack', ephemeral: true });
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
  // `orders.auto` off, or `restock` buys against every board this file leaves
  // deliberately thin and a van lands in the middle of a run.
  g.orders.auto = false;
  g.orders.assign = false;
  g.orders.items = {};
  g.orders.dropped = {};
  g.orders.pending = [];
  g.deliveries = [];
  g.cash = 50000;
  g.open = false;                    // nobody buying stock out from under us
  g.addPlayer('me', 'Tester');
  const res = g.hire(kind);
  check(res.ok, 'the hire joins', res.error ?? '');
  g.roster[g.roster.length - 1].tier = tier;
  g.step(0.1);                       // `hire` writes the roster; `syncStaff` puts the body in
  return g;
}

/** The hired body, by whatever id the roster minted for it. */
const hire = (g) => g.players[`staff-${g.roster[g.roster.length - 1]?.id}`];

const run = (g, ticks) => { for (let i = 0; i < ticks; i++) g.step(0.1); };

/** Wind on until `done`, or give up. */
function until(g, done, limit = 900) {
  for (let i = 0; i < limit; i++) {
    g.step(0.1);
    if (done()) return (i + 1) * 0.1;
  }
  return null;
}

/** Every unit of an item anywhere in the shop: boards, crates, hands, shoulder. */
function everywhere(g, itemId) {
  let n = 0;
  for (const sh of g.layout.shelves) n += g.shelfStack(sh, itemId)?.qty ?? 0;
  for (const d of g.deliveries) n += lotQty(d, itemId);
  for (const p of Object.values(g.players)) n += lotQty(p.carry, itemId) + lotQty(p.haul, itemId);
  return n;
}

/**
 * Three part-crates on three separate cells of the bay.
 *
 * `exact` matters more here than anywhere: `dropGoods` merges within a couple of
 * tiles by design, so the honest setup for "three boxes" would quietly become
 * one box of twelve — which is a crate every hire has always shouldered, and
 * every assertion below would pass without the feature existing at all.
 */
function bay(g, piles) {
  const cells = g.layout.bay?.cells ?? [];
  check(cells.length >= piles.length, 'the bay has a cell per test crate', `${cells.length}`);
  return piles.map(([item, qty], i) => {
    const at = cells[i];
    return g.dropGoods(item.id, qty, { x: at.x, z: at.z }, { exact: true });
  });
}

/** Room on the shelves for everything, so nothing here is measuring a full shop. */
function roomForAll(g) {
  for (const sh of g.layout.shelves) sh.stacks = [];
}

// ---------------------------------------------------------------------------
// 1. The control: a rung with no `packs` on it is the game as it was.
//
// First, and load-bearing. Every other section asserts that something new
// happens; this one asserts that it does NOT happen to anybody who has not paid
// for it — which is the difference between an opt-in rung and a silent change
// to every save in existence. It is also the only assertion here that would
// still fail if `packFill` returned something non-zero by accident.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  roomForAll(g);
  bay(g, [[ITEM_A, 4], [ITEM_B, 4], [ITEM_C, 4]]);
  const s = hire(g);

  const took = until(g, () => lotTotal(s.carry) > 0 || s.haul, 400);
  check(took !== null, 'the plain hire gets to the bay', `${took}`);
  check(!s.haul, 'a rung with no `packs` never shoulders a part-crate');
  check(lotTotal(s.carry) > 0, '…it takes an armful, exactly as before');
  eq(lotStacks(s.carry).length, 1,
    '…and `fillHands` tops up only the kind it is already holding, so one kind');
  // Not "three boxes are still standing" — an armful of four empties the box it
  // came out of, and that is the old behaviour rather than a leak. What has to
  // be untouched is the two they did NOT reach into.
  eq(g.deliveries.length, 2, 'the box they emptied is gone and the others are not');
  check(g.deliveries.every((d) => lotTotal(d) === 4),
    '…and nothing was swept out of either of them',
    JSON.stringify(g.deliveries.map((d) => lotTotal(d))));
}

// ---------------------------------------------------------------------------
// 2. The trip: three part-crates, one walk.
//
// The positive claim and the conservation claim together, because they are each
// other's failure mode — a packer that "worked" by dropping the third pile on
// the floor would pass either one alone.
// ---------------------------------------------------------------------------
{
  const g = fresh({ kind: PACKER.id, tier: 3 });
  roomForAll(g);
  bay(g, [[ITEM_A, 4], [ITEM_B, 4], [ITEM_C, 4]]);
  const before = [ITEM_A, ITEM_B, ITEM_C].map((it) => everywhere(g, it.id));
  eq(before.join(','), '4,4,4', 'the yard starts with four of each');
  const s = hire(g);

  const took = until(g, () => !!s.haul, 400);
  check(took !== null, 'the packer shoulders a box a plain hire would not', `${took}`);
  eq(lotTotal(s.haul), 12, '…and it is a FULL crate, not the four they lifted');
  eq(lotStacks(s.haul).length, 3, '…across all three kinds');
  eq(g.deliveries.length, 0, 'the other two boxes are gone off the pad, not left half-emptied');

  const after = [ITEM_A, ITEM_B, ITEM_C].map((it) => everywhere(g, it.id));
  eq(after.join(','), before.join(','), 'nothing was created or destroyed packing it');
}

// ---------------------------------------------------------------------------
// 3. The cap is the RUNG's number, not the crate's.
//
// Same bay, same box, one integer different on the roster. Without this the
// field is a boolean that happens to be stored as an integer, and every rung
// above 1 would pack the same box — which is a ladder with one rung on it.
// ---------------------------------------------------------------------------
{
  const g = fresh({ kind: PACKER.id, tier: 2 });
  roomForAll(g);
  bay(g, [[ITEM_A, 4], [ITEM_B, 4], [ITEM_C, 4]]);
  const s = hire(g);

  const took = until(g, () => !!s.haul, 400);
  check(took !== null, 'a two-kind packer still shoulders a box', `${took}`);
  eq(lotStacks(s.haul).length, 2, '…and packs two kinds, not three');
  eq(lotTotal(s.haul), 8, '…so eight units, not a full crate');
  eq(g.deliveries.length, 1, 'the third box is still standing on the pad');
}

// ---------------------------------------------------------------------------
// 4. Spoilage does not launder.
//
// Two dodges, both in `lotAdd`, both invisible. A pile merged into a kind the
// box already holds keeps the DESTINATION's stamp — so a fortnight-old pallet
// tipped into this morning's box comes out dated this morning. And a kind the
// box has NOT got is pushed as a bare `{item_id, qty}` with no stamp at all,
// which `spoilYard` reads as fresh for ever.
//
// Asserted on the lot rather than through a ten-day roll on purpose: the roll
// would be measuring `spoilYard`'s arithmetic, and what is under test is
// whether the number the roll reads is the right one.
// ---------------------------------------------------------------------------
{
  const g = fresh({ kind: PACKER.id, tier: 3 });
  roomForAll(g);
  g.day = 20;
  const [box, old, other] = bay(g, [[KEEP_A, 4], [KEEP_A, 4], [KEEP_B, 4]]);
  check(!!box && !!old && !!other, 'the three test crates were made');
  // The box they will lift is fresh; the one beside it is a fortnight old, and
  // so is the second kind — one of each dodge.
  //
  // Through `.stacks` rather than through `lotStacks`, which hands back copies
  // — the same trap `Game.packCrate`'s own stamping note is about. A setup
  // written the other way sets the clock on a value nobody keeps, and then the
  // assertions below pass or fail for a reason that has nothing to do with the
  // code under test.
  for (const p of box.stacks) p.day = g.day;
  for (const p of old.stacks) p.day = g.day - 14;
  for (const p of other.stacks) p.day = g.day - 14;

  const s = hire(g);
  const took = until(g, () => !!s.haul, 400);
  check(took !== null, 'the packer lifts and packs', `${took}`);

  const a = lotStacks(s.haul).find((p) => p.item_id === KEEP_A.id);
  const b = lotStacks(s.haul).find((p) => p.item_id === KEEP_B.id);
  eq(a?.qty, 8, 'the two piles of the same kind merged');
  eq(a?.day, g.day - 14, '…and the OLDER stamp won, so a merge is not a way to reset the clock');
  eq(b?.qty, 4, 'the second kind came across');
  eq(b?.day, g.day - 14,
    '…carrying its own stamp, rather than arriving unstamped and never rotting');
}

// ---------------------------------------------------------------------------
// 5. A packer packs what the shop can put away, and nothing else.
//
// The failure this closes is the feature working backwards: a box filled with
// goods no board will take is a full crate walked to one shelf and carried home
// again, which is MORE journeys than never packing it. Every other section here
// runs against a shop with room for everything, so this claim has to be made
// against a shop that has not.
// ---------------------------------------------------------------------------
{
  const g = fresh({ kind: PACKER.id, tier: 3 });
  roomForAll(g);
  bay(g, [[ITEM_A, 4], [ITEM_B, 4], [ITEM_C, 4]]);
  // Every board in the shop reserved for the two kinds that ARE wanted, so
  // there is nowhere in the building `ITEM_C` may legally go.
  for (const sh of g.layout.shelves) sh.assigned = [ITEM_A.id, ITEM_B.id];
  const s = hire(g);

  const took = until(g, () => !!s.haul, 400);
  check(took !== null, 'the packer still makes the trip that is worth making', `${took}`);
  eq(lotStacks(s.haul).length, 2, 'it packs the two kinds the shelves will take');
  check(!lotStacks(s.haul).some((p) => p.item_id === ITEM_C.id),
    '…and leaves the one nothing in the shop has room for');
  eq(g.deliveries.length, 1, 'which is still on the pad');
}

// ---------------------------------------------------------------------------
// 6. Rubbish, both directions.
//
// `verify:bin`'s claim said about the new verb. `stockCrates` already filters
// the job loop, so this is asked of `Game.packCrate` directly — the sweep has to
// go under the caller, because a filter one level up is exactly the kind of
// guard a later refactor moves.
// ---------------------------------------------------------------------------
{
  const g = fresh({ kind: PACKER.id, tier: 3 });
  roomForAll(g);
  const [stock] = bay(g, [[ITEM_A, 4]]);
  const rot = g.dropGoods(ITEM_B.id, 4, { x: g.layout.bay.cells[1].x, z: g.layout.bay.cells[1].z },
    { exact: true });
  check(!!rot, 'the rubbish crate was made');
  rot.waste = true;

  const p = g.players.me;
  p.x = stock.x; p.z = stock.z;
  eq(g.liftCrate('me', stock.id).ok, true, 'the tester shoulders the stock crate');
  const into = g.packCrate('me', rot.id, Infinity, ITEM_B.id);
  eq(into.ok, false, 'rubbish never packs INTO a box of stock');
  eq(lotTotal(p.haul), 4, '…and nothing moved');

  g.dropCrate('me');
  p.haul = { stacks: [{ item_id: ITEM_B.id, qty: 4 }], waste: true };
  const out = g.packCrate('me', g.deliveries.find((d) => !d.waste)?.id, Infinity, ITEM_A.id);
  eq(out.ok, false, '…and a box of rubbish packs nothing into itself either');
}

// ---------------------------------------------------------------------------
// 7. Out of the yard only.
//
// `wholeCrate`'s termination argument, said about the second box. A stray in an
// aisle is a box somebody already carried out of the yard, so drawing from it
// is goods travelling backwards — and with two hires it is a pile passed
// between two boxes for the rest of the save. Neither is visible: a shop where
// that is happening looks like a shop with people working in it.
// ---------------------------------------------------------------------------
//
// Asked of the verb rather than through the job loop, and that is forced rather
// than convenient: a stray in an aisle carries a 1e6 bonus in `unload`'s own
// scoring — "work half done beats a bigger trip in the yard" — so a hire put in
// a shop with one services it FIRST, by armful, and by the time any box reaches
// a shoulder there is no stray left to have packed from. A loop-level assertion
// there would pass with the rule deleted.
{
  const g = fresh({ kind: PACKER.id, tier: 3 });
  roomForAll(g);
  const [box] = bay(g, [[ITEM_A, 4]]);
  // A second box of a different kind, on a cell that is off the pad AND still
  // inside `UNLOAD_REACH` (1.8) of where the tester stands.
  //
  // Both halves are searched for rather than guessed at, and the reach half is
  // what keeps this section honest: "one tile over" is still the bay on a 2x2,
  // and two tiles over is out of reach — so the obvious setup gets a refusal
  // either way and the section passes with the pad rule deleted. Which is why
  // the error is asserted by name below rather than just `ok: false`.
  const off = [[-1, 0], [0, -1], [1, 0], [0, 1]].map(([dx, dz]) => ({ x: box.x + dx, z: box.z + dz }))
    .find((at) => !g.onAPad(at));
  check(!!off, 'there is a cell off the pad and next to the bay', JSON.stringify(off ?? null));
  const stray = g.dropGoods(ITEM_B.id, 4, off, { exact: true });
  check(!!stray, 'the stray crate was made');
  check(!g.onAPad(stray), 'and it is standing off the pad', `${stray.x},${stray.z}`);
  check(g.onAPad(box), '…while the bay crate is on it');

  const p = g.players.me;
  p.x = box.x; p.z = box.z;
  eq(g.liftCrate('me', box.id).ok, true, 'the tester shoulders the bay crate');
  const res = g.packCrate('me', stray.id, Infinity, ITEM_B.id);
  eq(res.ok, false, 'a crate in an aisle is never a source — goods do not travel backwards');
  check(/yard/.test(res.error ?? ''),
    '…and it is refused for being out of the yard, not for being out of reach',
    res.error ?? '');
  eq(lotTotal(p.haul), 4, '…and nothing moved');
  eq(lotQty(stray, ITEM_B.id), 4, '…out of the stray either');
}

// ---------------------------------------------------------------------------
// 8. …and the packed crate still empties onto the shelves.
//
// The last claim, and the one that decides whether any of the above was worth
// doing: a box that gets packed and then cannot be put away is a job loop that
// moves stock around the yard. `stockFromCrate` pours every pile a unit has a
// board for and the remainder rides on, so one packed crate is one walk and
// then however many boards it takes.
// ---------------------------------------------------------------------------
{
  const g = fresh({ kind: PACKER.id, tier: 3 });
  roomForAll(g);
  bay(g, [[ITEM_A, 4], [ITEM_B, 4], [ITEM_C, 4]]);
  const s = hire(g);

  check(until(g, () => !!s.haul, 400) !== null, 'the packer packs a box');
  const landed = until(g, () => !s.haul && lotTotal(s.carry) === 0, 3000);
  check(landed !== null, 'and gets the whole of it away', `${landed}`);

  const shelved = [ITEM_A, ITEM_B, ITEM_C].map((it) => g.layout.shelves
    .reduce((n, sh) => n + (g.shelfStack(sh, it.id)?.qty ?? 0), 0));
  eq(shelved.join(','), '4,4,4', 'all twelve units are on boards');
  eq(g.deliveries.length, 0, 'and nothing was left standing in the yard');
  run(g, 40);
  eq(g.deliveries.length, 0, '…and it does not come straight back off again');
}

// ---------------------------------------------------------------------------
// 9. Big hands do not switch packing off.
//
// The trap the `bar` note in `unload` is about, and the reason it is a section
// rather than a line: `carry_mult` on a rung can take hands up to a whole
// crate, and the shipped stocker's second rung already does — twelve-unit
// hands against a twelve-unit crate is `12 > 12`, false, so the one hire you
// would promote TO pack crates could never shoulder one. A rung that takes
// money and moves no number, and invisible: the hire goes on working, by
// armful, exactly as they did before you paid.
//
// Worse than neutral, which is the half this asserts second. Big hands do not
// help with a bay of part-crates at all — `Game.unload` sweeps one box and
// `fillHands` tops up only kinds already held — so the control here is a
// twelve-unit NON-packer walking away with four out of a bay holding twelve.
// ---------------------------------------------------------------------------
{
  // Two hands-of-twelve hires, one of each rung, so the only difference between
  // the runs is `packs`. Authored here rather than up top because this is the
  // one section that is about `carry_mult` at all.
  const BIG = {
    ...PLAIN,
    id: 'zz-pack-big', name: 'Test Big Hands',
    tiers: [
      { name: 'Standard', cost: 0, carry_mult: 2 },
      { name: 'Standard, packing', cost: 0, carry_mult: 2, packs: LOT_KINDS },
    ],
  };
  process.on('exit', () => { try { remove('workers', BIG.id); } catch { /* best effort */ } });
  const wrote = writeContent('worker', BIG, 'verify');
  check(wrote.ok, 'the catalog accepts the big-handed hire', wrote.error ?? '');

  const control = fresh({ kind: BIG.id, tier: 1 });
  roomForAll(control);
  bay(control, [[ITEM_A, 4], [ITEM_B, 4], [ITEM_C, 4]]);
  const a = hire(control);
  check(until(control, () => lotTotal(a.carry) > 0 || a.haul, 400) !== null,
    'the big-handed control gets to the bay');
  check(!a.haul, 'twelve-unit hands never shoulder a twelve-unit crate — the old test says 12 > 12');
  eq(lotTotal(a.carry), 4,
    '…and they leave with FOUR out of a bay holding twelve, because `fillHands` is same-kind-only');

  const g = fresh({ kind: BIG.id, tier: 2 });
  roomForAll(g);
  bay(g, [[ITEM_A, 4], [ITEM_B, 4], [ITEM_C, 4]]);
  const s = hire(g);
  check(until(g, () => !!s.haul, 400) !== null,
    'the same hire on the packing rung shoulders the box anyway');
  eq(lotTotal(s.haul), 12, '…and takes all twelve in one trip');
  eq(g.deliveries.length, 0, 'with the bay cleared');
}

// ---------------------------------------------------------------------------

console.log(`\nverify:pack — ${checks} assertions\n`);
if (failures.length) {
  for (const f of failures) console.log(`  ❌  ${f}`);
  console.log(`\n${failures.length} failed.\n`);
  process.exit(1);
}
console.log('  ✅  a rung packs one crate out of several, and nothing leaks doing it.\n');
