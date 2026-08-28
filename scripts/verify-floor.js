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
import { remove, deleteWorldRow } from '../server/db.js';
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
/**
 * A THIRD price, on a row that is a *job* rather than a look.
 *
 * Section 9 is about what happens where the two meet, and every figure in it is
 * arithmetic across the two kinds — so a pad that cost the same as a floor would
 * let a refund of the wrong layer come out right by accident, which is exactly
 * the mistake being guarded against.
 */
const PAD = 3.53;

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
  /**
   * A design of STORAGE, which is the other side of section 9.
   *
   * Authored here rather than in verify:yard because what it is under test for is
   * the floor brush: a pad is the thing a look now goes underneath, and a sweep
   * about layering needs one of each with a price you can tell apart.
   */
  {
    id: 'verify-floor-drop',
    kind: 'drop',
    name: 'Verify Storage',
    cost: PAD,
    surface: { color: '#9a8f74', pattern: 'plain' },
    tiers: [{ name: 'Standard', cost: 0 }],
  },
];

/** The one world this sweep writes for real — see the round trip in section 9c. */
const ROUND_TRIP = 'verify-floor-roundtrip';

process.on('exit', () => {
  for (const f of TEST_FLOORS) {
    try { remove('fixtures', f.id); } catch { /* the DB is already gone */ }
  }
  try { deleteWorldRow(ROUND_TRIP); } catch { /* already gone */ }
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

/** A bare indoor floor cell with nothing standing on it — somewhere to buy a shelf. */
function freeFloor(g) {
  const L = g.layout;
  for (let z = L.store.z + 1; z < L.store.z + L.store.h - 1; z++) {
    for (let x = L.store.x + 1; x < L.store.x + L.store.w - 1; x++) {
      if (groundAt(g, x, z) !== T.FLOOR) continue;
      if (L.blocked[z * L.w + x]) continue;
      return { x, z };
    }
  }
  return null;
}

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
  check(!oneCell.warn, 'and says nothing, because the bay is still a bay');

  // ...and the WHOLE bay says nothing either, which is section 9's claim
  // arriving in the one place it would otherwise have gone unnoticed. A floor
  // does not take a pad away any more — it goes under it — so the warning that
  // used to fire here is a warning about something that no longer happens, and a
  // warning that goes off whatever you do is one nobody reads.
  const allOfIt = canPaintGround(L, L.bay.cells, 'floor', 'verify-floor-cheap');
  check(allOfIt.ok, 'and so can the whole thing');
  check(!allOfIt.warn,
    'and flooring the lot of it warns about nothing, because the bay is still there',
    allOfIt.warn ?? 'none');

  // Paired with the two gestures that really do take it away, or the assertion
  // above is satisfied by the warning having been deleted. A pad over a pad is
  // the one that would actually happen — moving your bay onto your storage.
  const overPad = canPaintGround(L, L.bay.cells, 'drop', 'verify-floor-drop');
  check(overPad.ok, 'a pad may be painted over a pad');
  check(/last delivery bay/.test(overPad.warn ?? ''),
    'and THAT warns, because an order would have nowhere to land', overPad.warn ?? 'none');

  const takenUp = canPaintGround(L, L.bay.cells, null, null);
  check(takenUp.ok, 'and so may it be scraped off');
  check(/last delivery bay/.test(takenUp.warn ?? ''),
    'which warns for the same reason', takenUp.warn ?? 'none');

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

// ---------------------------------------------------------------------------
// 9. A LOOK GOES UNDER A JOB, and everything in here is invisible twice over.
//
// A stockroom with a floor under it and a stockroom without one are the same
// cell in the same colour with the same crates on it — the pad draws on top
// either way, which is the point — and the shop afterwards is the same shop.
// Only what you own moved.
//
// The bug it is the fix for was invisible in the other direction and worse for
// it: dragging a floor across your own stockroom took the storage away, silently,
// because painting over a pad is exactly how you MOVE one and the stroke could
// not tell "put the bay over there" from "lay a nice floor through here". Nothing
// refused, nothing warned once the last cell went — the warning fired and then
// the thing it warned about happened — and what you noticed, days later, was that
// deliveries had stopped arriving.
//
// Its control is the assertion that decides whether any of this is opt-in: a
// stroke that never crosses a pad must write no second layer at all, in a shop
// where every cell of ground already has an entry. Every save in existence is
// one of those.
//
// Its centrepiece is the pair that is worthless split in half — the pad is still
// a pad, AND the floor is remembered — because either half alone is satisfied by
// the stroke having done nothing whatsoever.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const L = g.layout;
  const bay = L.bay.cells;
  check(bay.length >= 2, 'the seeded shop has a delivery bay to paint over');

  // A shop nobody has layered: every cell of ground has a `k`, and not one of
  // them has anything under it.
  const under = (game) => new Map(game.ground.filter((f) => f.u).map((f) => [`${f.x},${f.z}`, f.u]));
  eq(under(g).size, 0, 'a shop that has never painted under a pad has no second layer');

  const before = {
    tiles: g.layout.tiles.join(','),
    blocked: g.layout.blocked.join(','),
    indoor: g.layout.indoor.join(','),
    bays: bay.length,
  };

  const cash = g.cash;
  const laid = g.buildGround('me', {
    x: bay[0].x, z: bay[0].z, piece: 'verify-floor-dear',
    to: { x: bay[bay.length - 1].x, z: bay[bay.length - 1].z },
  });
  check(laid.ok, 'a floor may be dragged across the delivery bay', laid.error ?? '');

  // THE PAIR. Neither half means anything without the other.
  eq(g.layout.bay?.cells?.length, before.bays, 'and the bay still has every cell it had');
  for (const c of bay) eq(groundAt(g, c.x, c.z), T.BAY, `and ${c.x},${c.z} is still bay`);
  const u = under(g);
  eq(u.get(`${bay[0].x},${bay[0].z}`)?.p, 'verify-floor-dear', 'with the floor remembered underneath');
  eq(u.get(`${bay[0].x},${bay[0].z}`)?.k, 'floor', 'as a look rather than as a job');

  // A LOOK UNDER A JOB IS NEVER A PERMISSION, which is section 2's claim asked
  // of the second layer. It cannot move a tile, because the tile is the job's.
  eq(g.layout.tiles.join(','), before.tiles, 'not one tile moved');
  eq(g.layout.blocked.join(','), before.blocked, 'nothing became blocked or unblocked');
  eq(g.layout.indoor.join(','), before.indoor, 'and the shop encloses exactly what it did');

  // Charged in full, because nothing changed hands: the bay is still yours and
  // still where it was, so there is nothing to hand back half of. Arithmetic on
  // the authored price, never on `groundUnitCost`.
  eq(laid.cost, round2(DEAR * bay.length), 'charged for the floor and refunded nothing for the pad');
  eq(round2(cash - g.cash), round2(DEAR * bay.length), 'and that is what left the till');

  // A second identical stroke is the no-op every other layer in here already
  // guards. Without it the underlay is a cell you can be billed for for ever by
  // holding the mouse still.
  const again = g.buildGround('me', { x: bay[0].x, z: bay[0].z, piece: 'verify-floor-dear' });
  eq(again.laid, 0, 'laying the same floor under the same pad again lays nothing');
  eq(again.unchanged, true, 'and reports that it changed nothing');

  // A RE-FLOW, because build mode re-flows on every wall segment of a drag and a
  // layer that did not survive one could never live long enough to be revealed.
  const free = freeFloor(g);
  check(!!free, 'there is a bare floor cell to buy a shelf on');
  const shelf = g.placeFixture('me', { kind: 'shelf', ...free, rot: 0 });
  check(shelf.ok, 'a shelf can still be bought', shelf.error ?? '');
  eq(under(g).get(`${bay[0].x},${bay[0].z}`)?.p, 'verify-floor-dear',
    'and the layer survives the re-flow that purchase caused');
  eq(g.layout.ground.find((f) => f.x === bay[0].x && f.z === bay[0].z)?.u?.p, 'verify-floor-dear',
    'and is carried out to the layout, because the ghost reads it');
  check(g.saveState().ground.some((f) => f.u?.p === 'verify-floor-dear'),
    'and the save carries it — the way home is section 9c');

  // THE REVEAL. What makes this a layer rather than a way of throwing money away.
  const peel = g.buildGround('me', { x: bay[0].x, z: bay[0].z, piece: '' });
  check(peel.ok, 'the pad can be taken up', peel.error ?? '');
  eq(groundAt(g, bay[0].x, bay[0].z), T.FLOOR, 'and the floor underneath is what is left');
  eq(g.ground.find((f) => f.x === bay[0].x && f.z === bay[0].z)?.p, 'verify-floor-dear',
    'the design and all');
  eq(under(g).get(`${bay[0].x},${bay[0].z}`) ?? null, null, 'with nothing left under it');

  // ...paired with the control, or "it reveals" is satisfied by an eraser that
  // has quietly stopped erasing. The drop-off is the pad this stroke never
  // touched, so it has nothing under it and scrapes to bare ground exactly as it
  // always did — outdoors, so grass.
  const plain = g.layout.drop.cells[0];
  const bare = g.buildGround('me', { x: plain.x, z: plain.z, piece: '' });
  check(bare.ok, 'a pad with nothing under it still comes up', bare.error ?? '');
  eq(groundAt(g, plain.x, plain.z), T.GRASS, 'and leaves bare ground rather than a floor');
}

// ---------------------------------------------------------------------------
// 9b. The other direction, the money, and the one door that clears both.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const spot = grassPatch(g, 2, 1);
  check(!!spot, 'there is a patch of grass to work on');
  const a = { x: spot.x, z: spot.z };

  // A JOB OVER A LOOK: the floor you already paid for goes down rather than
  // away. Nothing is handed back for it — you still own it — and the proof is
  // that scraping the pad gives it back rather than half its price.
  const floor = g.buildGround('me', { ...a, piece: 'verify-floor-cheap' });
  eq(floor.cost, CHEAP, 'a floor on bare grass costs the floor');
  const pad = g.buildGround('me', { ...a, piece: 'verify-floor-drop' });
  check(pad.ok, 'and storage may be painted over it', pad.error ?? '');
  eq(pad.cost, PAD, 'charged for the pad, with nothing back for the floor it went over');
  eq(groundAt(g, a.x, a.z), T.DROP, 'the cell is storage');
  eq(g.ground.find((f) => f.x === a.x && f.z === a.z)?.u?.p, 'verify-floor-cheap',
    'and the floor is underneath it');

  // Swapping the underlay is the ordinary re-tile arithmetic, said one layer
  // down: the dear floor, with half the cheap one back.
  const swap = g.buildGround('me', { ...a, piece: 'verify-floor-dear' });
  eq(swap.laid, 1, 'the underlay can be re-tiled');
  eq(swap.cost, round2(DEAR - CHEAP * 0.5), 'charging the difference on the layer it lands on');
  eq(groundAt(g, a.x, a.z), T.DROP, 'and the cell is still storage');

  // THE CIRCUIT. A layer is a place two prices meet, and every one of those in
  // this game has been a place money could be printed.
  const start = g.cash;
  g.buildGround('me', { ...a, piece: '' });                 // peel the pad
  g.buildGround('me', { ...a, piece: 'verify-floor-drop' }); // put it back
  check(g.cash < start, 'a circuit up and back always loses money', `${start} -> ${g.cash}`);

  // AND THE ONE DOOR THAT CLEARS BOTH. A region being deleted is not a layer
  // being peeled: a reveal here leaves a room-shaped stain of perfectly good
  // flooring behind the stockroom it just deleted.
  //
  // The corners are what a box round that one cell lands on, named directly the
  // way verify:stamp names them rather than through a camera this has not got.
  const region = [
    { x: a.x - 0.4, z: a.z - 0.4 }, { x: a.x + 0.4, z: a.z - 0.4 },
    { x: a.x + 0.4, z: a.z + 0.4 }, { x: a.x - 0.4, z: a.z + 0.4 },
  ];
  const wipe = g.removeSelection('me', [], region);
  check(wipe.ok, 'a region with a layered cell in it can be removed', wipe.error ?? '');
  eq(g.ground.filter((f) => f.x === a.x && f.z === a.z && (f.k || f.p)).length, 0,
    'and takes the look with the job, leaving nothing behind');
  eq(groundAt(g, a.x, a.z), T.GRASS, 'the cell is back to bare ground');
}

// ---------------------------------------------------------------------------
// 9c. ...AND IT COMES BACK, WHICH IS A DIFFERENT CLAIM FROM GOING OUT.
//
// verify:paint's section 6, said about the second ground layer, and it is here
// for the reason that one exists: `paint` shipped with only the outward leg for
// five steps, `Game.create` names every field it hands the constructor, and the
// `??` fallback wrote an empty object back over what was stored — so a restart
// did not fail to restore the layer, it DELETED it, while the save looked
// perfectly correct in between.
//
// `ground` rides in wholesale rather than field by field, so this passes by
// construction today. It is written down because the next person to tidy that
// payload into a named list is the person this catches.
//
// It needs a real world row, because `Game.create` reads the store rather than
// anything it is handed — hence a non-ephemeral game and the cleanup at the top.
// ---------------------------------------------------------------------------
{
  // Nothing is reset here, deliberately: `Game.create` stamps the shell and the
  // yard itself, so a sweep that cleared `ground` and re-stamped would be
  // comparing two differently-shaped shops and the failure would read as the
  // layer having moved.
  const g = Game.create({ worldId: ROUND_TRIP, seed: 'floor', ephemeral: false });
  g.cash = 50000;
  g.addPlayer('me', 'Tester');
  g.players.me.build = { on: true, tool: 'shelf' };

  const cell = g.layout.bay.cells[0];
  const res = g.buildGround('me', { ...cell, piece: 'verify-floor-dear' });
  check(res.ok, 'a floor goes under the bay in a world that persists', res.error ?? '');
  g.persist();
  const layered = JSON.parse(JSON.stringify(g.ground));

  const back = Game.create({ worldId: ROUND_TRIP, seed: 'floor', ephemeral: true });
  eq(JSON.stringify(back.ground), JSON.stringify(layered),
    'the layer is still there when the world is loaded again');
  eq(back.layout.tiles[cell.z * back.layout.w + cell.x], T.BAY,
    '...and the cell it is under is still a delivery bay');

  // The second half of the deletion, and the reason "is it there" is not enough:
  // what did the damage was the default being written back, so the STORED save
  // has to still have it after a reloaded game has saved once.
  back.persist();
  const after = Game.create({ worldId: ROUND_TRIP, seed: 'floor', ephemeral: true });
  eq(JSON.stringify(after.ground), JSON.stringify(layered),
    '...and a reloaded shop that saves does not wipe it');
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
