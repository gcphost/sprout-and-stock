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

import { Game } from '../server/sim/index.js';
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
process.on('exit', () => {
  for (const r of TEST_GROUND) { try { remove('fixtures', r.id); } catch { /* best effort */ } }
});
for (const r of TEST_GROUND) {
  const res = writeContent('fixture', r, 'verify');
  check(res.ok, `the catalog accepts a ${r.kind} row called ${r.id}`, res.error ?? '');
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

console.log(`\nverify:yard — ${checks} assertions`);
if (failures.length) {
  console.error(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✅  the yard is ground somebody owns, and how big you paint it is how much it holds.\n');
