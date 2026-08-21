#!/usr/bin/env node
/**
 * VERIFY: THE GROUND IS A LAYER, AND LAYING IT IS THE OTHER HALF OF A WALL.
 *
 * A floor is the first thing in this game that is *content deciding what a cell
 * is made of*, and that is a sentence worth being nervous about. Every other
 * catalog row decides how something looks; this one decides whether a shelf
 * fits. So the assertions split in two, and both halves matter:
 *
 * - **A floor is a look, never a permission.** Painting can write FLOOR or
 *   GRASS and nothing else, so every rule that already reads the ground reads
 *   the new ground unchanged. A design with a different colour must not move a
 *   single tile, and re-tiling a shop you already own must not make one more or
 *   one fewer thing buildable. That claim is invisible by eye — you would have
 *   to notice that a cell you were not looking at started accepting shelves.
 *
 * - **Walls plus floor is what "make my shop bigger" means.** Enclosure has
 *   worked since step 3, which meant you could already wall off an annex and it
 *   counted as indoors — and then refused every shelf, because the ground was
 *   grass. That refusal is the bug this whole feature is the fix for, so it is
 *   asserted directly: wall it, fail; floor it, succeed.
 *
 * Three ways this could rot, all guarded:
 *
 * - **It could pass because nothing happened.** Every paint asserts what it
 *   laid, and the shop is fingerprinted either side.
 * - **It could pass because the floor never survived a re-flow.** Paint is an
 *   overlay for the same reason walls are, and the failure mode is that buying
 *   a shelf repaints the shop. So it builds *after* painting and re-checks.
 * - **It could pass on arithmetic that agrees with itself.** Every expected
 *   figure below is arithmetic on a deliberately odd authored price, never on
 *   `floorUnitCost` — asserting a charge against the function that computes it
 *   passes whatever that function does.
 *
 * Writes two floor rows into whatever content database it is pointed at —
 * usually the live shared one — and removes them on exit, exactly the way
 * verify:catalog and verify:economy do.
 *
 *   node scripts/verify-floor.js
 */

import { Game } from '../server/sim/index.js';
import { writeContent } from '../server/content.js';
import { remove } from '../server/db.js';
import {
  canPaintGround, groundStroke, groundIndex, GROUND_STROKE_MAX, fixturesOf,
} from '../shared/build.js';
import { surfaceOf } from '../shared/pieces.js';
import { T } from '../shared/tiles.js';
import { E } from '../shared/edges.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SHOP = { shelf: 6, freezer: 1, checkout: 1, plot: 4 };

/**
 * Deliberately odd prices, and deliberately different from each other.
 *
 * 7.31 and 13.19 rather than 10 and 20 for the reason verify:economy gives:
 * round numbers are the ones that come out right by accident. Different from
 * each other so that swapping one floor for another is a charge nobody could
 * mistake for a no-op.
 */
const CHEAP = 7.31;
const DEAR = 13.19;

const TEST_FLOORS = [
  {
    id: 'verify-floor-cheap',
    kind: 'floor',
    name: 'Verify Concrete',
    cost: CHEAP,
    surface: { color: '#8d8d88', pattern: 'plain' },
    tiers: [{ name: 'Standard', cost: 0 }],
  },
  {
    id: 'verify-floor-dear',
    kind: 'floor',
    name: 'Verify Parquet',
    cost: DEAR,
    surface: { color: '#8a5f36', accent: '#6d4a2a', pattern: 'checker' },
    tiers: [{ name: 'Standard', cost: 0 }],
  },
];

process.on('exit', () => {
  for (const f of TEST_FLOORS) {
    try { remove('fixtures', f.id); } catch { /* the DB is already gone */ }
  }
});

for (const f of TEST_FLOORS) {
  const res = writeContent('fixture', f, 'verify');
  check(res.ok, `the catalog accepts a floor called ${f.id}`, res.error ?? '');
}

/**
 * `fresh()` has to clear everything `Game.create` reads off the save, and the
 * list grew again — by `ground`, and then by `yardStamped` beside it. A run
 * that did not clear the first would measure a shop somebody else had already
 * tiled and call the leftover paint a bug; one that cleared it without the
 * second would open a shop whose yard had been stamped into ground that is no
 * longer there, and get no delivery bay at all.
 * Ask what a save could now leak into your assertions, not just what you added.
 */
function fresh() {
  const g = Game.create({ worldId: 'verify-floor', seed: 'floor', ephemeral: true });
  g.placements = [];
  g.grow = { w: 0, h: 0 };
  g.doorShift = 0;
  g.edits = [];
  g.ground = [];
  g.yardStamped = false;
  g.shell = null;
  g.ownedUpgrades = [];
  g.regenerateLayout(null, {}, { want: SHOP });
  g.freezeShell();
  g.freezeYard();
  g.cash = 50000;
  g.addPlayer('me', 'Tester');
  g.players.me.build = { on: true, tool: 'shelf' };
  return g;
}

const groundAt = (g, x, z) => g.layout.tiles[z * g.layout.w + x];
const shape = (g) => fixturesOf(g.layout)
  .map((f) => `${f.id}:${f.kind}@${f.x},${f.z}`).sort().join('|');

/** A patch of open grass south-east of the building, clear of path and pads. */
function grassPatch(g, w = 2, h = 2) {
  const L = g.layout;
  // From the top of the building down, not from the forecourt. This used to
  // start below the shop, because the front was open lawn and the only things
  // out there were the beds — and a new world seeds a street across it now, so
  // the two rows this could reach are pavement and road. The GRASS test below
  // is the real filter and always was; starting higher just lets it see the
  // flank beside the building, which is where the open grass moved to.
  for (let z = L.store.z; z < L.h - 2; z++) {
    for (let x = 1; x < L.w - 1 - w; x++) {
      let all = true;
      for (let dz = 0; dz < h && all; dz++) {
        for (let dx = 0; dx < w && all; dx++) {
          if (groundAt(g, x + dx, z + dz) !== T.GRASS) all = false;
          if (L.blocked[(z + dz) * L.w + (x + dx)]) all = false;
        }
      }
      if (all) return { x, z };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. A stroke is a rectangle, anchored on where the drag began.
//
// The clamp is the whole of it. `edgeRun` clamps by the lower end, which for a
// line is invisible; for a rectangle dragged up and to the left it would trim
// the corner your finger is actually on and walk the selection away from you.
// ---------------------------------------------------------------------------
{
  eq(groundStroke({ x: 4, z: 4 }, { x: 6, z: 5 }).length, 6, 'a 3x2 drag is six cells');
  eq(groundStroke({ x: 4, z: 4 }, null).length, 1, 'a drag that never moved is one cell');
  eq(groundStroke({ x: 4, z: 4 }, { x: 4, z: 4 }).length, 1, 'and so is one that came back');

  // Clamped around the start in both directions, which is the fix.
  const right = groundStroke({ x: 2, z: 2 }, { x: 99, z: 2 }, 5);
  eq(right.length, 5, 'an oversized drag right is trimmed to the cap');
  check(right.some((c) => c.x === 2), 'and keeps the corner it started on');
  eq(Math.max(...right.map((c) => c.x)), 6, 'trimming the far end, not the near one');

  const left = groundStroke({ x: 20, z: 2 }, { x: 0, z: 2 }, 5);
  eq(left.length, 5, 'an oversized drag left is trimmed to the same cap');
  check(left.some((c) => c.x === 20), 'and still keeps the corner it started on');
  eq(Math.min(...left.map((c) => c.x)), 16, 'trimming the far end again — this is the half edgeRun gets wrong');

  const big = groundStroke({ x: 2, z: 2 }, { x: 99, z: 99 });
  eq(big.length, GROUND_STROKE_MAX * GROUND_STROKE_MAX, 'the cap is per side, so a full stroke is a square of it');
}

// ---------------------------------------------------------------------------
// 2. Laying floor changes the ground, and only the ground.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const spot = grassPatch(g, 2, 2);
  check(!!spot, 'the test world has open grass to lay floor on');

  const before = shape(g);
  const cash = g.cash;
  eq(groundAt(g, spot.x, spot.z), T.GRASS, 'it starts as grass');

  const res = g.buildGround('me', {
    x: spot.x, z: spot.z, piece: 'verify-floor-cheap', to: { x: spot.x + 1, z: spot.z + 1 },
  });
  check(res.ok, 'a 2x2 patch of floor can be laid on grass', res.error ?? '');
  eq(res.laid, 4, 'and it lays exactly four tiles');

  // Priced per cell, on the authored number rather than on the function that
  // reads it. 4 x 7.31, with nothing underneath to refund.
  eq(res.cost, 29.24, 'four tiles at the authored price, per tile');
  eq(Math.round((cash - g.cash) * 100) / 100, 29.24, 'and that is what left the till');

  for (let dz = 0; dz < 2; dz++) {
    for (let dx = 0; dx < 2; dx++) {
      eq(groundAt(g, spot.x + dx, spot.z + dz), T.FLOOR, `(${dx},${dz}) is floor now`);
    }
  }
  eq(shape(g), before, 'and nothing standing in the shop moved');
}

// ---------------------------------------------------------------------------
// 3. A design is a look and never a permission.
//
// The claim the whole layering rests on. Two floors with different colours and
// different prices must produce byte-identical ground — if a `surface` can ever
// move a tile, then what a shop is made of has become a rendering decision.
// ---------------------------------------------------------------------------
{
  const a = fresh();
  const b = fresh();
  const spot = grassPatch(a, 3, 2);
  const stroke = { x: spot.x, z: spot.z, to: { x: spot.x + 2, z: spot.z + 1 } };

  check(a.buildGround('me', { ...stroke, piece: 'verify-floor-cheap' }).ok, 'one shop lays concrete');
  check(b.buildGround('me', { ...stroke, piece: 'verify-floor-dear' }).ok, 'the other lays parquet');

  eq(JSON.stringify(a.layout.tiles), JSON.stringify(b.layout.tiles),
    'two different floors leave exactly the same ground');
  eq(JSON.stringify(a.layout.blocked), JSON.stringify(b.layout.blocked),
    'and exactly the same cells occupied');
  eq(JSON.stringify(a.layout.indoor), JSON.stringify(b.layout.indoor),
    'and exactly the same cells indoors — paint cannot roof anything');
  check(JSON.stringify(a.layout.ground) !== JSON.stringify(b.layout.ground),
    'while the layer that carries the look does differ, or this proves nothing');

  // ...and the two are told apart where it counts: on the way to the renderer.
  const look = (g) => surfaceOf(
    [...TEST_FLOORS], groundIndex(g.layout).get(`${spot.x},${spot.z}`), '#000000',
  );
  eq(look(a).color, '#8d8d88', 'the concrete shop resolves to concrete');
  eq(look(b).color, '#8a5f36', 'and the parquet shop to parquet');
  eq(look(b).pattern, 'checker', 'carrying its pattern with it');
}

// ---------------------------------------------------------------------------
// 4. Walls make a room; floor makes it a shop. This is the bug being fixed.
//
// Before floors existed, this sequence stopped at the first `canPlace`: the
// annex was indoors and refused every shelf, because `BUILDABLE_INDOOR` is
// floor and the ground was grass. The refusal even said "something is already
// there", which is why it read as a bug in the wrong place entirely.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const L = g.layout;
  // Wall off a 2x2 annex hanging off the east wall of the shop, on the row just
  // inside it, so the shell's own east wall is one side of the new room.
  const ax = L.store.x + L.store.w;
  const az = L.store.z + 1;
  check(ax + 2 < L.w - 1, 'there is room east of the building for an annex');

  for (let z = az; z < az + 2; z++) g.buildEdge('me', { o: 'v', x: ax + 2, z, kind: E.WALL });
  g.buildEdge('me', { o: 'h', x: ax, z: az, kind: E.WALL, to: ax + 1 });
  g.buildEdge('me', { o: 'h', x: ax, z: az + 2, kind: E.WALL, to: ax + 1 });
  // ...and a doorway through the shop's own east wall, so the annex joins on.
  g.buildEdge('me', { o: 'v', x: ax, z: az, kind: E.DOOR });

  check(g.layout.indoor[az * g.layout.w + ax] === 1,
    'the annex counts as indoors the moment the walls close it in');
  eq(groundAt(g, ax, az), T.GRASS, 'but the ground inside it is still grass');

  // Against the back wall of the annex, browsed from the entrance side. Not in
  // the doorway cell (ax, az) — that is the only way in, so a shelf standing
  // there blocks the route to its own browsing spot, and the builder says so.
  // Which is the reachability rules working *through* a room somebody drew by
  // hand, and worth knowing they do.
  const bay = { kind: 'shelf', x: ax + 1, z: az, rot: 2 };

  const beforeFloor = g.placeFixture('me', bay);
  check(!beforeFloor.ok, 'so a shelf cannot go in it yet — this is the whole bug');

  const laid = g.buildGround('me', {
    x: ax, z: az, piece: 'verify-floor-cheap', to: { x: ax + 1, z: az + 1 },
  });
  check(laid.ok, 'the annex can be floored', laid.error ?? '');
  eq(groundAt(g, ax, az), T.FLOOR, 'and its ground is shop floor now');

  const afterFloor = g.placeFixture('me', bay);
  check(afterFloor.ok, 'and now a shelf goes in it', afterFloor.error ?? '');
  check(g.layout.shelves.some((s) => s.x === bay.x && s.z === bay.z),
    'and is really standing there — not accepted and then dropped by the re-flow');
  eq((g.layout.droppedPlacements ?? []).length, 0, 'with nothing displaced to make room');
}

// ---------------------------------------------------------------------------
// 5. Paint survives a re-flow, which is the reason it is an overlay.
//
// The failure this guards is precise: the generator restamps the shell's whole
// footprint as bare floor on every re-flow, so ground that was not re-applied
// on top would mean buying a shelf silently repaints the shop.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const L = g.layout;
  const cell = { x: L.store.x + 1, z: L.store.z + 1 };
  check(g.buildGround('me', { ...cell, piece: 'verify-floor-dear' }).ok, 'a tile inside the shop is re-tiled');
  eq(groundIndex(g.layout).get(`${cell.x},${cell.z}`), 'verify-floor-dear', 'and reads back as that design');

  // Three re-flows deep, the way verify:catalog checks a second shelf design —
  // one is not enough to catch a list that is rebuilt from the wrong source.
  for (let i = 0; i < 3; i++) g.regenerateLayout();
  eq(groundIndex(g.layout).get(`${cell.x},${cell.z}`), 'verify-floor-dear',
    'and is still that design three re-flows later');

  // ...and specifically across the action that used to be the culprit.
  const spot = grassPatch(g, 1, 1);
  g.buildGround('me', { ...spot, piece: 'verify-floor-cheap' });
  const bought = g.placeFixture('me', { kind: 'plot', x: spot.x + 1, z: spot.z, rot: 0 });
  check(bought.ok, 'a plot can be bought next to it', bought.error ?? '');
  eq(groundIndex(g.layout).get(`${spot.x},${spot.z}`), 'verify-floor-cheap',
    'and buying something did not repaint the floor');
}

// ---------------------------------------------------------------------------
// 6. Taking it up, and the hole the eraser can no longer make indoors.
//
// Bare ground under a shelf is not a consequence you are allowed to cause, and
// that is a deliberate exception to "impossible refuses, inadvisable warns".
// The generator would not leave the shelf standing on grass — it would DROP the
// placement on the next re-flow and refund it. A brush that quietly sells your
// shelving and its stock back is a bulldozer wearing a paintbrush.
//
// The way that is enforced changed, and the claim got STRONGER rather than
// weaker: taking ground up now leaves floor indoors and grass only outside, so
// there is no longer any such thing as a hole in a shop for the eraser to make.
// Which means the refusal is not the interesting assertion any more — the
// interesting one is that the tile is still floor and the shelf is still
// standing on it afterwards. A refusal proves the gesture was stopped; this
// proves there was nothing to stop.
//
// The refusal is still under test, on the case that can still strand something:
// a cell whose TILE would change under a fixture. Indoors that is a pad being
// taken up, not plain floor.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const shelf = g.layout.shelves[0];
  const under = canPaintGround(g.layout, [{ x: shelf.x, z: shelf.z }], null, null);
  check(under.ok && under.unchanged, 'the floor under a shelf is nothing the eraser can take up',
    under.reason ?? '');

  const wipe = g.buildGround('me', { x: shelf.x, z: shelf.z, piece: '' });
  check(wipe.ok, 'and the press is answered rather than refused', wipe.error ?? '');
  eq(groundAt(g, shelf.x, shelf.z), T.FLOOR, 'the tile is still shop floor');
  check(g.layout.shelves.some((s) => s.x === shelf.x && s.z === shelf.z),
    'and the shelf is still standing on it');

  // A stroke is judged whole, so one bad cell refuses the gesture rather than
  // laying up to it and then billing for the part that worked. A bay indoors is
  // the cell that can still be a bad one: erasing it takes the tile from bay to
  // floor, which is a change, and something standing on it would be stranded.
  const bay = g.layout.bay?.cells?.[0];
  if (bay) {
    const onBay = g.placeFixture('me', { kind: 'shelf', x: bay.x, z: bay.z, rot: 0 });
    if (onBay.ok) {
      const scrape = canPaintGround(g.layout, [bay], null, null);
      check(!scrape.ok, 'ground that WOULD change under a fixture is still refused');
      eq(scrape.reason, 'something is standing on it', 'and says why');
    }
  }

  // A bed is off limits, and says which job it is you would be taking away.
  const L = g.layout;
  const plot = g.layout.plots[0];
  const bed = canPaintGround(L, [{ x: plot.x, z: plot.z }], 'floor', 'verify-floor-cheap');
  check(!bed.ok, 'a bed cannot be paved over');
  eq(bed.reason, 'there is a bed there — clear it first', 'and says so');

  // The delivery bay is NOT, and that reversal is the whole yard feature: it
  // used to answer 'that is the delivery bay' and refuse, because the pads were
  // procedural and paving one would have left the shop with a bay the generator
  // put straight back. They are ground somebody owns now, so this is a
  // consequence you are told about and allowed to cause — the same answer
  // walling in your own shelf gets.
  const oneCell = canPaintGround(L, [L.bay.cells[0]], 'floor', 'verify-floor-cheap');
  check(oneCell.ok, 'a corner of the delivery bay can be paved over');
  check(!oneCell.warn, 'and says nothing, because the bay still has three cells left');

  const allOfIt = canPaintGround(L, L.bay.cells, 'floor', 'verify-floor-cheap');
  check(allOfIt.ok, 'and so can the whole thing');
  check(/last delivery bay/.test(allOfIt.warn ?? ''),
    'but that one warns, because an order would have nowhere to land', allOfIt.warn ?? 'none');

  // Empty floor indoors comes up as FLOOR, which is the whole of this change.
  //
  // It used to come up as grass and warn you that it had left a cell nothing
  // could ever use. That is a truthful warning about a thing nobody wants: the
  // ordinary reason to scrape a cell indoors is to undo a floor design you have
  // just laid, and the answer to that was a hole, priced, with a caution
  // attached. Grass is what the world is made of before anyone builds; it is
  // not what is under a shop.
  //
  // So the assertion is the pair — no warning, because nothing was bared, and a
  // shelf still stands there afterwards, because the cell is still floor.
  const open = { x: L.store.x + 1, z: L.store.z + 1 };
  eq(groundAt(g, open.x, open.z), T.FLOOR, 'there is empty shop floor to test on');
  const up = canPaintGround(L, [open], null, null);
  check(up.ok, 'empty floor can be taken up');
  check(!/nothing can be built or dug on/.test(up.warn ?? ''),
    'and warns about no hole, because indoors it leaves none', up.warn ?? 'none');

  const res = g.buildGround('me', { ...open, piece: '' });
  check(res.ok, 'and the action goes through', res.error ?? '');
  eq(groundAt(g, open.x, open.z), T.FLOOR, 'leaving shop floor where the floor was');
  const onBare = g.placeFixture('me', { kind: 'shelf', x: open.x, z: open.z, rot: 0 });
  check(onBare.ok, 'which is still a cell a shelf can stand on', onBare.error ?? '');

  // ...and OUTSIDE it is grass exactly as it always was, which is the control
  // that keeps this from being "the eraser stopped working".
  const out = grassPatch(g, 2, 2);
  g.buildGround('me', { ...out, piece: 'verify-floor-cheap' });
  eq(groundAt(g, out.x, out.z), T.FLOOR, 'a paved patch outdoors is floor');
  const scraped = g.buildGround('me', { ...out, piece: '' });
  check(scraped.ok, 'and it comes up', scraped.error ?? '');
  eq(groundAt(g, out.x, out.z), T.GRASS, 'back to grass, because it is not in the shop');
}

// ---------------------------------------------------------------------------
// 7. Re-tiling costs the difference, and a stroke that changes nothing is free.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const spot = grassPatch(g, 1, 1);

  const first = g.buildGround('me', { ...spot, piece: 'verify-floor-cheap' });
  eq(first.cost, CHEAP, 'laying on bare grass costs the full tile price');

  const same = g.buildGround('me', { ...spot, piece: 'verify-floor-cheap' });
  check(same.ok, 'laying the same floor again is allowed');
  eq(same.laid, 0, 'and lays nothing');
  eq(same.unchanged, true, 'reporting that it changed nothing rather than charging for it');

  const cash = g.cash;
  const swap = g.buildGround('me', { ...spot, piece: 'verify-floor-dear' });
  check(swap.ok, 'and it can be re-tiled', swap.error ?? '');
  eq(swap.laid, 1, 'one tile');
  // 13.19 - (7.31 x 0.5). Arithmetic on the authored numbers, never on the
  // function under test.
  eq(swap.cost, 9.54, 'charging the difference, with half the old floor back');
  eq(Math.round((cash - g.cash) * 100) / 100, 9.54, 'and that is what left the till');

  // A tile the shell came with was never bought, so it refunds nothing. This is
  // the same claim `buildEdge` makes about a wall you did not draw — except the
  // other way round, and it is worth pinning both directions.
  const g2 = fresh();
  const inside = { x: g2.layout.store.x + 1, z: g2.layout.store.z + 1 };
  const over = g2.buildGround('me', { ...inside, piece: 'verify-floor-dear' });
  eq(over.cost, DEAR, 'tiling over floor the building came with costs full price');
}

// ---------------------------------------------------------------------------
// 8. Running out halfway lays what you could afford.
//
// Same rule a wall run follows, and for the same reason: a drag is a gesture,
// and losing all of it to the last cell being a dollar short is the kind of
// thing you cannot see coming.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const spot = grassPatch(g, 4, 1);
  check(!!spot, 'there is a four-wide run of grass');
  g.cash = CHEAP * 2.5;                       // enough for two tiles, not three

  const res = g.buildGround('me', { x: spot.x, z: spot.z, piece: 'verify-floor-cheap', to: { x: spot.x + 3, z: spot.z } });
  check(res.ok, 'the stroke goes through', res.error ?? '');
  eq(res.laid, 2, 'laying what could be afforded');
  eq(res.short, true, 'and saying it ran out');
  eq(res.cost, round2(CHEAP * 2), 'charged for exactly what was laid');
  check(g.cash >= 0, 'and never overdrawn', String(g.cash));
}

function round2(n) { return Math.round(n * 100) / 100; }

// ---------------------------------------------------------------------------

console.log(`\nverify:floor — ${checks} assertions`);
if (failures.length) {
  console.error(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✅  a floor is a look, and laying it is what makes a walled room a shop.\n');
