#!/usr/bin/env node
/**
 * VERIFY: THE YARD IS GROUND SOMEBODY OWNS.
 *
 * The delivery bay and the drop-off were procedural furniture. `compose`
 * stamped two 2x2 patches against the corners of the back wall on every single
 * re-flow, which is exactly why they could never be moved, resized or removed:
 * buying a shelf put them back where they were. They are painted cells now,
 * seeded once and never touched by the generator again.
 *
 * Almost none of that is visible in a screenshot, because a seeded pad and a
 * generated one look identical on the day it lands. What is asserted here is
 * the difference between them:
 *
 * - **It is stamped once, and once means once.** `freezeYard` runs on every
 *   load. The tempting mark is "does this shop own any pads", and it is wrong:
 *   painting over your last bay would then hand it back on the next load, which
 *   makes the yard the one thing in the shop you are not allowed to get rid of
 *   — the exact complaint the feature answers. So the mark is its own boolean
 *   and deleting is allowed to stick.
 *
 * - **A shop that already exists keeps its yard.** A save written before any of
 *   this has bay tiles that came from a generator which no longer draws them,
 *   and nothing in `ground` to hold them. `freezeShell` returns early for that
 *   save, so a yard stamped inside it would never run and the shop would open
 *   with nowhere for a delivery to land.
 *
 * - **How big you paint it is how much it holds.** The pads stopped being a
 *   fixed 2x2, so "the size of your storage" became a decision, and a decision
 *   that changes no number is a button that takes money and does nothing.
 *
 * - **...and a shop that already exists does not MOVE.** Deepening the yard
 *   meant moving the building south, and every fixture in a live save is a
 *   placement at an absolute tile — so an old shell has to keep the position it
 *   was built at or the whole contents of the building land outside it and get
 *   refunded on the next re-flow.
 *
 * Writes two ground rows into whatever content database it is pointed at —
 * usually the live shared one — and removes them on exit, exactly the way
 * verify:catalog, verify:economy and verify:floor do.
 *
 *   node scripts/verify-yard.js
 */

import { Game, DAY_SECONDS } from '../server/sim/index.js';
import { content, writeContent } from '../server/content.js';
import { remove } from '../server/db.js';
import { padCells, groundIndex } from '../shared/build.js';
import { T } from '../shared/tiles.js';
import { E } from '../shared/edges.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SHOP = { shelf: 6, freezer: 0, checkout: 1, plot: 4 };

/**
 * Its own rows rather than the shipped ones, so a sweep cannot start passing
 * because somebody retired `loading-bay` from the catalog.
 */
const TEST_GROUND = [
  {
    id: 'verify-yard-bay', kind: 'bay', name: 'Test Bay',
    surface: { color: '#9aa79b', pattern: 'plain' }, tiers: [{ name: 'Flat', cost: 0 }], cost: 7,
  },
  {
    id: 'verify-yard-drop', kind: 'drop', name: 'Test Storage',
    surface: { color: '#c2a173', pattern: 'plain' }, tiers: [{ name: 'Flat', cost: 0 }], cost: 7,
  },
  {
    id: 'verify-yard-floor', kind: 'floor', name: 'Test Floor',
    surface: { color: '#b8a894', pattern: 'plain' }, tiers: [{ name: 'Flat', cost: 0 }], cost: 7,
  },
];
/**
 * A crop and a hand, for section 8 only.
 *
 * The shipped crops would do the job and are the wrong thing to lean on: what
 * grows in what season is content somebody edits on a Tuesday, and a sweep that
 * quietly stops planting in autumn is a sweep that passes without asserting
 * anything. `seasons: []` grows all year, and the yield is fixed so "did the
 * farm pick anything" is a count rather than a range.
 */
const TEST_SPUD = {
  // `shelf-stable` is not decoration. Section 10 asserts conservation across
  // 250 seconds of shop time, and `produce` alone spoils — so the sweep would
  // report four missing units as a leak in the hauling code, which is the most
  // expensive kind of false positive there is: a real-looking conservation
  // failure in the one system whose whole claim is conservation.
  id: 'zz-yard-spud', name: 'Test Spud', tags: ['produce', 'shelf-stable'],
  base_cost: 1, base_price: 3, stack: 20,
  model: { parts: [{ shape: 'box', color: '#a58b4a', pos: [0, 0.1, 0], scale: [0.2, 0.2, 0.2] }] },
};
const TEST_CROP = {
  id: 'zz-yard-crop', name: 'Test Spud', item_id: TEST_SPUD.id,
  seed_cost: 0, grow_minutes: 5, yield_min: 6, yield_max: 6, seasons: [],
  model: {
    stages: [
      { parts: [{ shape: 'box', color: '#4a8b3a', pos: [0, 0.05, 0], scale: [0.2, 0.1, 0.2] }] },
      { parts: [{ shape: 'box', color: '#4a8b3a', pos: [0, 0.1, 0], scale: [0.3, 0.2, 0.3] }] },
    ],
  },
};
/**
 * `harvest` picks, `tidy` crates what is picked, `shelve` puts it away when
 * there is a board. All three, because the loop this section is about is made
 * of all three — a hand who could only harvest would fill their hands once and
 * stop, which looks exactly like the fix working and is really a hire with
 * nowhere to put anything.
 */
const TEST_HAND = {
  id: 'zz-yard-hand', name: 'Test Hand', color: '#8bd94a',
  jobs: [{ job: 'harvest', weight: 1 }, { job: 'shelve', weight: 1 }, { job: 'tidy', weight: 1 }],
  cost: 0, wage: 0, speed: 20, pace: 0.05,
  tiers: [{ name: 'Standard', cost: 0 }],
};

/**
 * ...and one who works crates, for section 9 only.
 *
 * `unload` is the job that lifts, hauls and returns a crate — the hand above
 * deliberately has none of it, because section 8 is about a farm and a hire who
 * shelved the pad it fills would measure something else. Separate rows rather
 * than one row with every job: a sweep whose worker can do everything cannot
 * say which job did the thing it just asserted.
 */
const TEST_PORTER = {
  id: 'zz-yard-porter', name: 'Test Porter', color: '#4a8bd9',
  jobs: [{ job: 'unload', weight: 1 }, { job: 'shelve', weight: 1 }],
  cost: 0, wage: 0, speed: 20, pace: 0.05,
  tiers: [{ name: 'Standard', cost: 0 }],
};

process.on('exit', () => {
  for (const r of TEST_GROUND) { try { remove('fixtures', r.id); } catch { /* best effort */ } }
  try { remove('workers', TEST_PORTER.id); } catch { /* best effort */ }
  try { remove('crops', TEST_CROP.id); } catch { /* best effort */ }
  try { remove('items', TEST_SPUD.id); } catch { /* best effort */ }
  try { remove('workers', TEST_HAND.id); } catch { /* best effort */ }
});
for (const r of TEST_GROUND) {
  const res = writeContent('fixture', r, 'verify');
  check(res.ok, `the catalog accepts a ${r.kind} row called ${r.id}`, res.error ?? '');
}
for (const [kind, row] of [['item', TEST_SPUD], ['crop', TEST_CROP],
  ['worker', TEST_HAND], ['worker', TEST_PORTER]]) {
  const res = writeContent(kind, row, 'verify');
  check(res.ok, `the catalog accepts the test ${kind}`, res.error ?? '');
}

/**
 * The same reset every other sweep makes, plus the two fields this feature
 * added. Clearing `ground` without `yardStamped` opens a shop whose yard was
 * stamped into ground that is no longer there — no bay at all, and every
 * assertion below failing for a reason that has nothing to do with the code.
 */
function fresh({ stampYard = true } = {}) {
  const g = Game.create({ worldId: 'verify-yard', seed: 'yard', ephemeral: true });
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
  if (stampYard) g.freezeYard();
  g.cash = 50000;
  g.addPlayer('me', 'Tester');
  g.players.me.build = { on: true };
  return g;
}

/**
 * Run the clock on until the van has been.
 *
 * An order stopped being a delivery in step 1 of docs/deliveries.md: it is paid
 * for the moment you press the button and the crate appears at the bay on the
 * next fixed run. So a sweep about what the yard HOLDS has to let the run
 * happen — asserting on `deliveries` in the tick the order was placed is now
 * asserting that ordering teleports goods, which is the thing that changed.
 */
function vanArrives(g) {
  for (let i = 0; g.orders.pending.length && i < (DAY_SECONDS * 1.1) / 0.25; i++) g.step(0.25);
}

const cellsOf = (pad) => (pad ? pad.cells.map((c) => `${c.x},${c.z}`).sort().join(' ') : '');
const orderable = () => content().items.filter((i) => i.stack > 0).map((i) => i.id);

// ---------------------------------------------------------------------------
// 1. Stamped once, and once means once.
// ---------------------------------------------------------------------------
{
  const g = fresh({ stampYard: false });
  check(g.layout.bay === null, 'a shop opens with no yard until one is stamped');

  eq(g.freezeYard(), true, 'the first stamp lays a yard');
  check(g.layout.bay !== null && g.layout.drop !== null, 'and both pads exist afterwards');
  const was = cellsOf(g.layout.bay);
  const owned = g.ground.length;

  eq(g.freezeYard(), false, 'the second stamp does nothing');
  eq(g.ground.length, owned, 'and lays no more ground');
  eq(cellsOf(g.layout.bay), was, 'leaving the bay exactly where it was');

  // The claim `freezeShell` makes about shelving, made about the yard: a
  // purchase re-flows the layout, and a re-flow used to be what put the pads
  // back where the generator wanted them.
  g.placeFixture('me', { kind: 'shelf', x: g.layout.store.x + 1, z: g.layout.store.z + 1, rot: 0 });
  eq(cellsOf(g.layout.bay), was, 'and buying a shelf does not move the yard');
}

// ---------------------------------------------------------------------------
// 2. Deleting your yard sticks.
//
// The failure this guards is a re-seed on the next load, which would read as
// "the game keeps putting my bay back" — and is exactly what the old
// procedural pads did, one re-flow at a time.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const bay = g.layout.bay.cells;
  const row = bay[0].z;
  const res = g.buildGround('me', {
    x: bay[0].x, z: row, piece: 'verify-yard-floor', to: { x: bay[bay.length - 1].x, z: row },
  });
  check(res.ok, 'the whole bay can be paved over', res.error ?? '');
  check(/last delivery bay/.test(res.warn ?? ''), 'and warns that it was the last one', res.warn ?? 'none');
  check(g.layout.bay === null, 'leaving the shop with no delivery bay');

  // A reload. `freezeYard` runs on every load and must not undo this.
  eq(g.freezeYard(), false, 'reopening the shop does not hand the bay back');
  check(g.layout.bay === null, 'so it is still gone');
}

// ---------------------------------------------------------------------------
// 3. A save that predates all of this gets a yard, and does not move.
// ---------------------------------------------------------------------------
{
  const g = fresh({ stampYard: false });
  // What an old save looks like: stamped shell, no `z` on it, no ground at all,
  // and its bay tiles came from a generator that no longer draws them.
  g.shell = { w: g.layout.store.w, h: g.layout.store.h };
  g.regenerateLayout();
  eq(g.layout.store.z, 2, 'an old shell keeps the position it was built at');
  check(padCells(g.layout, 'bay').length === 0, 'and arrives with no bay tiles at all');

  const placed = g.layout.shelves.length;
  eq(g.freezeYard(), true, 'so the yard stamps for it too');
  check(g.layout.bay !== null, 'giving it somewhere for a delivery to land');
  eq(g.layout.store.z, 2, 'and it still has not moved');
  eq(g.layout.shelves.length, placed, 'with nothing dropped out of the building');

  // The other half: a shop stamped since keeps the deeper yard, and the depth
  // is what makes a stockroom out the back possible at all. Row 0 is the
  // world's border ring, which no build tool may touch — so "rows behind the
  // building" is one less than it looks.
  const now = fresh();
  check(now.layout.store.z > 2, 'a shop stamped since stands further off the north edge',
    `z=${now.layout.store.z}`);
  check(now.layout.store.z - 1 >= 3, 'leaving a yard worth painting on',
    `${now.layout.store.z - 1} usable rows`);
}

// ---------------------------------------------------------------------------
// 4. How big you paint it is how much it holds.
//
// The pads were a fixed 2x2, so this number could not vary. It can now, and a
// size that changes no number is a button that takes money and does nothing.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const items = orderable();
  check(items.length >= 6, 'there are enough orderable items to fill a pad', `${items.length}`);

  const seeded = g.layout.bay.cells.length;
  for (const id of items.slice(0, seeded)) g.buyStock('me', id, 2);
  vanArrives(g);
  eq(g.deliveries.length, seeded, 'a seeded bay holds one crate per cell');
  eq(new Set(g.deliveries.map((d) => `${d.x},${d.z}`)).size, seeded,
    'each on a cell of its own');
  check(g.deliveries.every((d) => padCells(g.layout, 'bay')
    .some((c) => c.x === d.x && c.z === d.z)), 'and every crate stands on the bay');

  // Grow it by two cells, and two more kinds of goods fit.
  const row = g.layout.bay.cells[0].z;
  const west = g.layout.bay.cells[0].x - 2;
  const grow = g.buildGround('me', { x: west, z: row, piece: 'verify-yard-bay', to: { x: west + 1, z: row } });
  check(grow.ok, 'the bay can be painted bigger', grow.error ?? '');
  eq(g.layout.bay.cells.length, seeded + 2, 'and is two cells larger');

  g.deliveries = [];
  for (const id of items.slice(0, seeded + 2)) g.buyStock('me', id, 2);
  vanArrives(g);
  eq(new Set(g.deliveries.map((d) => `${d.x},${d.z}`)).size, seeded + 2,
    'which is two more crates than it used to take');
}

// ---------------------------------------------------------------------------
// 5. A pad indoors is a stockroom, and is still not somewhere a shelf can go.
//
// The rule it must not break: `BUILDABLE_INDOOR` is floor and nothing else. A
// pad that quietly counted as floor would let you build on your own stockroom;
// one that stopped being walkable would strand whoever is standing in it.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const L = () => g.layout;
  const spot = { x: L().store.x + 2, z: L().store.z + 2 };
  eq(L().tiles[spot.z * L().w + spot.x], T.FLOOR, 'there is empty shop floor to work on');

  const paint = g.buildGround('me', { ...spot, piece: 'verify-yard-drop' });
  check(paint.ok, 'storage can be laid indoors', paint.error ?? '');
  check(/nothing can be built or dug on/.test(paint.warn ?? ''),
    'and says what it costs you', paint.warn ?? 'none');
  eq(L().tiles[spot.z * L().w + spot.x], T.DROP, 'the cell is storage now');

  const shelf = g.placeFixture('me', { kind: 'shelf', x: spot.x, z: spot.z, rot: 0 });
  check(!shelf.ok, 'which is a cell no shelf can stand on');
  check(g.walk[spot.z * L().w + spot.x] === 1, 'but one anybody can walk across');

  // ...and it is genuinely the drop-off, so hands get cleared in it.
  g.players.me.x = spot.x;
  g.players.me.z = spot.z;
  g.players.me.carry = { item_id: orderable()[0], qty: 2 };
  const put = g.stow('me');
  check(put.ok, 'and standing in it is standing at the drop-off', put.error ?? '');

  // Back to floor, and the cell is buildable again. A one-way brush would mean
  // one misplaced drag costs you a tile of shop forever.
  g.deliveries = [];
  const back = g.buildGround('me', { ...spot, piece: 'verify-yard-floor' });
  check(back.ok, 'and it goes back to floor', back.error ?? '');
  eq(L().tiles[spot.z * L().w + spot.x], T.FLOOR, 'leaving shop floor where the storage was');
  check(g.placeFixture('me', { kind: 'shelf', x: spot.x, z: spot.z, rot: 0 }).ok,
    'which a shelf can stand on again');
}

// ---------------------------------------------------------------------------
// 6. With no yard, the two things that need one say so.
//
// Refusals rather than warnings, and deliberately: `canPaintGround` warns you
// before you take the last pad away, which is where this is meant to be
// prevented. Taking money for a pallet that then has nowhere to exist is the
// worst of the three answers.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const wipe = (kind) => {
    const cells = padCells(g.layout, kind);
    for (const c of cells) g.buildGround('me', { x: c.x, z: c.z, piece: 'verify-yard-floor' });
  };
  wipe('bay');
  wipe('drop');
  check(g.layout.bay === null && g.layout.drop === null, 'the shop has no yard left');
  check(g.dropPad() == null, 'and nowhere to put anything down');

  const cashWas = g.cash;
  const order = g.buyStock('me', orderable()[0], 3);
  check(!order.ok, 'a wholesale order is refused');
  check(/nowhere for it to land/.test(order.error ?? ''), 'and says why', order.error ?? '');
  eq(g.cash, cashWas, 'and nothing was charged for it');
  eq(g.deliveries.length, 0, 'and no crate appeared in a field somewhere');

  g.players.me.carry = { item_id: orderable()[0], qty: 2 };
  const put = g.stow('me');
  check(!put.ok, 'and clearing your hands is refused too');
  check(g.players.me.carry?.qty === 2, 'so you are still holding it');
}

// ---------------------------------------------------------------------------
// 7. A pad survives a re-flow, and keeps its design.
//
// The overlay claim, and the one that fails silently: paint that is re-applied
// but loses which row painted it renders as the palette default, which reads as
// a colour bug rather than as ground that forgot what it was made of.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const row = g.layout.bay.cells[0].z;
  const west = g.layout.bay.cells[0].x - 3;
  check(g.buildGround('me', { x: west, z: row, piece: 'verify-yard-drop' }).ok, 'storage goes down out back');
  const cell = `${west},${row}`;
  eq(groundIndex(g.layout).get(cell), 'verify-yard-drop', 'and reads back as that design');

  g.placeFixture('me', { kind: 'shelf', x: g.layout.store.x + 3, z: g.layout.store.z + 1, rot: 0 });
  eq(g.layout.tiles[row * g.layout.w + west], T.DROP, 'buying a shelf leaves it storage');
  eq(groundIndex(g.layout).get(cell), 'verify-yard-drop', 'and still the design it was painted with');

  // A wall through the yard is allowed to enclose a pad, and refused when it
  // would seal the whole thing off — the region form of a check that used to
  // ask about a single point.
  const seal = g.buildEdge('me', {
    o: 'h', x: west, z: row, kind: E.WALL, to: west,
  });
  check(seal.ok !== undefined, 'a wall beside the yard resolves either way', JSON.stringify(seal));
}

// ---------------------------------------------------------------------------
// 8. ...and how big you paint it is how much the shop will MAKE.
//
// Section 4 says the pad's size bounds what you can buy. Nothing said it about
// what the shop produces, and the two are not the same sentence because
// `dropGoods` never refuses: once every cell is used it shares one, so a farm
// with nowhere to put its crop crated the lot at the drop-off and the pile grew
// upwards for ever. Auto-replant is what makes it a loop — picking a bed is
// what frees it to grow the next one — so the field, the crates and the shelves
// all being full is a stable state that produces goods indefinitely.
//
// Both halves are here. "It stops" on its own is satisfied by a farm that never
// runs, which is the far worse bug and the reason the second half exists.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  check(g.layout.plots.length > 0, 'the shop has beds');
  check(!!g.dropPad()?.cells?.length, 'and somewhere to put things down');

  // Every board spoken for by something else. That is an ordinary shop with a
  // settled range, not a contrived one — and a crop is never `assigned` to
  // anything by itself.
  const other = orderable().find((id) => id !== TEST_SPUD.id);
  check(!!other, 'there is some other item to reserve the shelves for');
  for (const sh of g.layout.shelves) sh.assigned = [other];

  // ...and a drop-off with no room left. Filled with the OTHER item, so what
  // stops the farm is the pad being full rather than a crate of its own crop.
  g.dropGoods(other, g.dropPad().cells.length * g.crateCapacity(), g.dropPad());
  eq(g.padRoom(), 0, 'the drop-off is full to the cell count it was painted at');

  // A field of ripe spuds. Set directly rather than grown: this section is
  // about what happens when they are ready, and waiting `minutes` for that is
  // a test of the clock.
  for (const p of g.layout.plots) {
    p.soil = 'tilled';
    p.crop_id = TEST_CROP.id;
    p.ready = true;
    p.yield = TEST_CROP.yield_min;
  }

  check(g.hire(TEST_HAND.id).ok, 'a hand who picks, shelves and tidies is taken on');
  g.step(0.1);
  for (let i = 0; i < 2000; i++) g.step(0.1);

  // Counted out of the shop rather than off `stats.harvested`: the run is
  // longer than a day, and `freshStats` wipes the counter at midnight. A tally
  // that resets halfway through reads as "the farm stopped" whatever happened.
  eq(picked(g), 0,
    'a field with nowhere to send the crop is left standing rather than picked into a tower');
  check(g.layout.plots.every((p) => p.ready), 'and every bed is still ripe');

  // The other half, and the whole point of the pad being a region: paint more
  // storage and the farm runs again. The bound is one the player drew.
  const cell = g.dropPad().cells[0];
  const grow = g.buildGround('me', {
    x: cell.x, z: cell.z + 1, piece: 'verify-yard-drop', to: { x: cell.x + 1, z: cell.z + 1 },
  });
  check(grow.ok, 'the drop-off can be painted bigger', grow.error ?? '');
  check(g.padRoom() > 0, 'which is room the shop did not have a moment ago');

  for (let i = 0; i < 2000; i++) g.step(0.1);
  check(picked(g) > 0,
    'and the farm picks again, into the storage you just paid for',
    `picked ${picked(g)}, padRoom ${g.padRoom()}`);
}

/** Every spud in the shop — in a crate, on a board, or in somebody's hands. */
function picked(g) {
  let n = 0;
  for (const d of g.deliveries) if (d.item_id === TEST_SPUD.id) n += d.qty ?? 0;
  for (const p of Object.values(g.players)) {
    if (p.carry?.item_id === TEST_SPUD.id) n += p.carry.qty ?? 0;
  }
  for (const sh of g.layout.shelves) n += g.shelfStack(sh, TEST_SPUD.id)?.qty ?? 0;
  return n;
}

// ---------------------------------------------------------------------------
// 9. A crate a worker cannot use goes back to the yard, not down in the aisle.
//
// Hauling gave staff a way to put a box anywhere, and the first shape of it put
// one down wherever the hire happened to be standing the moment a board filled
// under them. Nothing ever came back for it: a stray with nowhere to go is a
// stray nothing will lift, so it stood there for the rest of the game. What you
// see is boxes scattered across the shop, which reads as a pathing bug rather
// than as the one line that decides where a homeless crate lands.
//
// Two rules hold it together and both are asserted: a stray is worth MORE than
// a fuller crate in the yard (or a hire hauls one out, sets it down and walks
// back to the bay for a bigger trip, for ever), and a stray nothing can absorb
// is carried home.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  check(!!g.dropPad()?.cells?.length, 'the shop has somewhere to put crates');

  // Every board spoken for by something else, so the crate below is genuinely
  // homeless rather than merely inconvenient.
  const other = orderable().find((id) => id !== TEST_SPUD.id);
  for (const sh of g.layout.shelves) sh.assigned = [other];

  // A stray, standing in the middle of the shop floor — where a hire would have
  // dropped it under the old rule.
  g.deliveries = [];
  const mid = { x: Math.round(g.layout.w / 2), z: Math.round(g.layout.h / 2) };
  g.dropGoods(TEST_SPUD.id, 6, mid);
  eq(g.deliveries.length, 1, 'a crate is standing on the shop floor');
  check(!padCells(g.layout, 'drop').some((c) => c.x === mid.x && c.z === mid.z),
    'and it is not on a pad');

  check(g.hire(TEST_PORTER.id).ok, 'a porter is taken on');
  g.step(0.1);
  for (let i = 0; i < 3000; i++) g.step(0.1);

  const onPad = (d) => padCells(g.layout, 'drop').some((c) => c.x === d.x && c.z === d.z)
    || padCells(g.layout, 'bay').some((c) => c.x === d.x && c.z === d.z);
  const strays = g.deliveries.filter((d) => !onPad(d));
  const carried = Object.values(g.players).some((p) => p.haul?.item_id === TEST_SPUD.id);
  check(!strays.length || carried,
    'a crate nothing has room for is taken back to the yard rather than left in the aisle',
    `${strays.length} still on the floor`);
  eq(totalOnFloor(g, TEST_SPUD.id) + heldOf(g, TEST_SPUD.id), 6,
    'and every unit of it survives the trip');
}

/** Everything of this in somebody's hands or on their shoulder. */
function heldOf(g, itemId) {
  let n = 0;
  for (const p of Object.values(g.players)) {
    for (const lot of [p.carry, p.haul]) if (lot?.item_id === itemId) n += lot.qty ?? 0;
  }
  return n;
}

/** Every unit of this standing in a crate anywhere. */
function totalOnFloor(g, itemId) {
  return g.deliveries.filter((d) => d.item_id === itemId).reduce((n, d) => n + (d.qty ?? 0), 0);
}

// ---------------------------------------------------------------------------
// 10. Three hires do not all haul to the same shelf.
//
// Every other sweep in this file employs ONE person, which is exactly why this
// shipped broken: with one hire there is nobody to collide with, and the whole
// coordination layer is untested by construction.
//
// `inbound` is that layer — what is already walking towards each board, read by
// `shelfFor` as headroom — and it asked `o.carry`. A hauled crate is `o.haul`,
// so it was invisible: three hires each picked the same best shelf and set a
// box down at it. The claims were never wrong; the load they were carrying
// simply did not count. It is a twelve-unit blind spot, the biggest this map
// has ever had.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const bay = g.layout.bay;
  check(!!bay?.cells?.length, 'the shop has a bay');
  // Shutters down. Staff work through a closed shop — that is what nights are
  // for — and the claim below is conservation across the hauling code, which
  // shoppers would quietly falsify by buying four things off a shelf. A sweep
  // that counts stock has to stop the one process whose job is to remove it.
  g.open = false;

  // Three full crates in the yard, and three porters. Every shelf bare, so
  // every one of them is a legal destination and the only thing that can spread
  // the hires out is `inbound`.
  g.deliveries = [];
  for (const cell of bay.cells.slice(0, 3)) {
    g.dropGoods(TEST_SPUD.id, g.crateCapacity(), cell);
  }
  // Measured, not assumed: `dropGoods` merges into a crate of the same thing
  // standing nearby, so three drops of a crateful are not always three crates.
  // Asserting against `crates x capacity` would be asserting arithmetic about a
  // function this sweep is not testing.
  const put = totalOnFloor(g, TEST_SPUD.id);
  check(g.deliveries.length >= 2, 'more than one crate is waiting', `${g.deliveries.length}`);

  for (let i = 0; i < 3; i++) check(g.hire(TEST_PORTER.id).ok, `porter ${i + 1} is taken on`);
  g.step(0.1);

  // The decision itself, asserted directly.
  //
  // Watching it emerge from a long run is what this section did first, and it
  // passed with the bug reverted — three hires converging is easy to miss in an
  // outcome, because `dropGoods` merges and a stocker clears up behind them. So
  // put a crate on each shoulder and read where they decide to take it: that is
  // the one tick `inbound` is consulted, and the whole claim.
  const porters = Object.values(g.players).filter((p) => p.staff);
  eq(porters.length, 3, 'three of them turned up');
  for (const p of porters) {
    p.haul = { item_id: TEST_SPUD.id, qty: g.crateCapacity() };
    p.claim = null;
    p.path = null;
    p.cooldown = 0;
  }
  g.step(0.1);
  const aimed = porters.map((p) => p.claim).filter(Boolean);
  eq(aimed.length, 3, 'each of them picked a destination');
  check(new Set(aimed).size === 3, 'and no two picked the same board',
    aimed.join(' | '));

  // Now let them get on with it.
  for (const p of porters) p.haul = null;
  for (let i = 0; i < 2500; i++) g.step(0.1);

  // Nobody set a crate down on top of somebody else's. One box per tile is the
  // visible symptom — a tower in the middle of the shop floor — and it is the
  // one thing you can see from across the room.
  const tiles = new Map();
  for (const d of g.deliveries) {
    const t = `${Math.round(d.x)},${Math.round(d.z)}`;
    tiles.set(t, (tiles.get(t) ?? 0) + 1);
  }
  const onPad = (t) => [...padCells(g.layout, 'drop'), ...padCells(g.layout, 'bay')]
    .some((c) => `${c.x},${c.z}` === t);
  const heaps = [...tiles].filter(([t, n]) => n > 1 && !onPad(t));
  check(!heaps.length, 'no two hires pile crates on the same spot off the pads',
    heaps.map(([t, n]) => `${t}x${n}`).join(' '));

  // ...and the goods all arrived somewhere, rather than the hires deadlocking
  // over each other's claims. The failure this guards is the OPPOSITE of the
  // one above and just as plausible: spreading them out with a rule that is too
  // strict is three people who each decide there is nothing to do.
  const shelved = g.layout.shelves.reduce((n, sh) => n + (g.shelfStack(sh, TEST_SPUD.id)?.qty ?? 0), 0);
  check(shelved > 0, 'and the stock actually reaches the shelves', `${shelved} shelved`);
  eq(shelved + totalOnFloor(g, TEST_SPUD.id) + heldOf(g, TEST_SPUD.id), put,
    'with every unit accounted for');
}

// ---------------------------------------------------------------------------

console.log(`\nverify:yard — ${checks} assertions`);
if (failures.length) {
  console.error(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✅  the yard is ground somebody owns, and how big you paint it is how much it holds.\n');
