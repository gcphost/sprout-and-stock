#!/usr/bin/env node
/**
 * VERIFY: A CAR DRIVES TO ITS SPACE, AND EVERYBODY PREFERS THE WAY YOU LAID.
 *
 * The car park has been paintable since step 4 of docs/deliveries.md, and until
 * step 5 a car simply *was* where its driver parked it — put down on the cell at
 * spawn, deleted with them at despawn. This sweep exists because a car that
 * arrives and a car that was placed are the same still frame, and because
 * teaching a customer to exist before they are in the shop reaches four loops
 * that have always meant "the people in my shop".
 *
 * - **A shop with no car park is the shop that was here before.** The whole
 *   promise of the pad, and the half that rots silently: everything below is
 *   reached by having painted one, so a shop that never did must draw the same
 *   random numbers and get the same shoppers it always did.
 *
 * - **One lane per space, and it ends on the cell.** The van stops one short of
 *   the bay because goods land there; a car stops *in* its space, or the car
 *   park does not work. Both come out of `laneFinder`, and only one of them can
 *   be checked by looking at a picture of a lorry.
 *
 * - **A space with no lane is still a space.** The lane is an animation and the
 *   space is the mechanic. Dropping a lane-less cell from `parkSpaces` would
 *   make `parkReach` — and therefore `catchment`, and therefore every number in
 *   a balance run — depend on whether the shop is pretty.
 *
 * - **Patience is not spent on the drive.** The one that costs money. `patience`
 *   is a budget the shop draws on, `stepMood` drains it for everyone in
 *   `this.customers`, and from step 5 that object holds people who are still on
 *   the approach road. Ungarded, the further away somebody parked the crosser
 *   they would arrive — and it presents as shoppers storming out of a shop that
 *   has done nothing to them.
 *
 * - **The space is held from the first tick to the last.** Through the drive in,
 *   the shop, the walk back and the drive out. Freeing it early puts the next
 *   arrival down on top of a car that is still reversing off it.
 *
 * - **A re-flow parks a car; it does not restart it.** Building re-flows on
 *   every wall segment, and a car that started its approach again each time is a
 *   customer who never arrives — in a shop being extended precisely because it
 *   is busy.
 *
 * - **A road is a preference and never a permission.** Every outdoor cell was
 *   already drivable, so painting one may only ever change which legal lane is
 *   *chosen*. Take the tarmac up and the van must still come.
 *
 * - **...and so is a pavement, which is the same claim about feet.** `findPath`
 *   charges every outdoor step now, so a mistake there is not "nobody uses the
 *   path", it is every route in the game moving. Given two equally short ways
 *   the paved one is taken; paving nowhere near you changes nothing; and no
 *   route ever gets longer, because a preference that could is a shopper
 *   walking the length of the shop to use a path.
 *
 * - **A crossing is a design, not a kind.** `T.PATH` has been in `DRIVABLE`
 *   since the van first drove, so pavement painted over a lane is drivable and
 *   preferred by feet at once — which is exactly what a crossing is.
 *
 * - **A van backs onto the pad, and stops short of it by however long a van it
 *   is.** "One cell short" was the whole of that promise while a lorry was 1.56
 *   tiles long; at vehicle scale the same lane parks it three quarters of the
 *   way across the crates it has just set down — nose-first, which is the shop
 *   taking delivery out of the bonnet, since a model is authored nose-east and
 *   the load bed is its `-x` end. Both are measured off the art, so this is the
 *   one claim in here that a bigger model must not be able to break — and the
 *   lane underneath it still has to end on a whole tile, because a re-flow
 *   compares that cell to ask whether the lane has moved.
 *
 * Writes five ground rows into whatever content database it is pointed at —
 * usually the live shared one — and removes them on exit, exactly the way
 * verify:yard, verify:break, verify:catalog, verify:economy and verify:floor do.
 *
 *   node scripts/verify-park.js
 */

import { Game } from '../server/sim/index.js';
import { writeContent, content } from '../server/content.js';
import { remove } from '../server/db.js';
import { padCells, isPad, isGround, GROUND_KINDS } from '../shared/build.js';
import { findPath } from '../server/sim/pathing.js';
import { T } from '../shared/tiles.js';
import { modelExtent } from '../shared/model.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/**
 * One till so a shopper has somewhere to pay, four shelves so they have
 * something to want, and no beds — everything below is about a journey to and
 * from a cell, and a farm is a second thing for the clock to be spent on.
 */
const SHOP = { shelf: 4, freezer: 0, checkout: 1, plot: 0 };

/**
 * Its own rows, so this cannot start passing because somebody restyled the
 * shipped car park — and TWO road designs, because one of the claims is that
 * the difference between them is nothing a vehicle can read.
 */
const TEST_GROUND = [
  {
    id: 'verify-park-pad', kind: 'park', name: 'Test Car Park',
    surface: { color: '#79808c', pattern: 'plain' }, tiers: [{ name: 'Flat', cost: 0 }], cost: 3,
  },
  {
    id: 'verify-park-road-a', kind: 'road', name: 'Test Road A',
    surface: { color: '#5f646d', pattern: 'plain' }, tiers: [{ name: 'Flat', cost: 0 }], cost: 2,
  },
  {
    id: 'verify-park-road-b', kind: 'road', name: 'Test Road B',
    surface: { color: '#d94f2a', accent: '#101010', pattern: 'checker' },
    tiers: [{ name: 'Flat', cost: 0 }], cost: 40,
  },
  {
    id: 'verify-park-paving', kind: 'path', name: 'Test Pavement',
    surface: { color: '#d9cbb0', pattern: 'plain' }, tiers: [{ name: 'Flat', cost: 0 }], cost: 2,
  },
  {
    id: 'verify-park-crossing', kind: 'path', name: 'Test Crossing',
    surface: { color: '#f2efe6', accent: '#5f646d', pattern: 'stripes' },
    tiers: [{ name: 'Flat', cost: 0 }], cost: 5,
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
 * The same reset every other sweep makes. `ground` matters most here: a live
 * save that has painted its own car park would hand this sweep spaces it did
 * not lay, and `roster` matters for the crowd assertions — a hire is not a
 * customer, but a shop the save happens to staff is a shop doing other things.
 */
function fresh() {
  const g = Game.create({ worldId: 'verify-park', seed: 'park', ephemeral: true });
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
  g.cash = 100000;
  g.addPlayer('me', 'Tester');
  g.players.me.build = { on: true };
  // Mid-morning and the shutters up, or `lastOrders` turns every shopper below
  // round at the door and every assertion here measures a closed shop.
  g.open = true;
  g.time = 12 / 24;
  /**
   * ...and nobody arrives except the shoppers this file puts there.
   *
   * Every claim below is about one round trip, and the sections that follow one
   * to the end run several minutes of shop clock — which an open shop fills with
   * ordinary footfall. Two of them would then be measuring the wrong body: "the
   * departing driver is not drawn" reads a count that a walker who turned up
   * meanwhile also lands in, and "the space comes back" can be beaten to it by
   * the next arrival inside the same tick, because `stepCustomers` despawns
   * before `stepSpawning` rolls. `verify:hand` shuts the shop for the same
   * reason; this cannot, because a shut shop turns its drivers round at the door.
   */
  g.stepSpawning = () => {};
  return g;
}

/** Wind the clock on until `done`, or give up. Returns how long it took. */
function until(g, done, limit = 2000) {
  for (let i = 0; i < limit; i++) {
    g.step(0.1);
    if (done()) return (i + 1) * 0.1;
  }
  return null;
}

/**
 * Paint a run of car park, west to east along one row.
 *
 * Out the FRONT and clear of the footpath. `x + 3` puts it beside the strip the
 * generator lays south from the door rather than on it — paving over that is
 * legal now (see section 10) and would make every space here a space on the
 * path, which is a sweep quietly measuring something else.
 */
function paintPark(g, len = 2, dz = 3, piece = 'verify-park-pad') {
  const x = g.layout.door.x + 3;
  const z = g.layout.door.z + dz;
  const res = g.buildGround('me', { x, z, piece, to: { x: x + len - 1, z } });
  check(res.ok, `a ${len}-cell car park goes down at ${x},${z}`, res.error ?? '');
  return res;
}

/** Off the tile grid entirely — where a lane starts and where it ends. */
const offMap = (L, p) => p.x < 0 || p.z < 0 || p.x >= L.w || p.z >= L.h;

/** Is this cell free to park in right now? */
const freeAt = (g, c) => {
  const f = g.freeSpace();
  return f != null && f.x === c.x && f.z === c.z;
};

// ---------------------------------------------------------------------------
// 1. A shop with no car park is the shop that was here before.
//
// Everything else in this file is reached by having painted one. This is the
// claim that says the feature is opt-in, and it is the one that would rot in
// silence, because a shop that never paints a pad prints nothing either way.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  eq(padCells(g.layout, 'park').length, 0, 'a shop opens with no car park');
  eq(g.parkSpaces().length, 0, 'and no spaces');
  eq(g.freeSpace(), null, 'and nowhere free to park');
  eq(g.parkReach(), 0, 'and parking widens the catchment by nothing');

  const res = g.spawnCustomer();
  check(res.ok, 'a shopper still arrives', res.error ?? '');
  eq(res.drove, false, 'and they did not drive');
  const cu = g.customers[res.id];
  eq(cu.drive, null, 'they have no car');
  eq(cu.parkedAt, null, 'and no claim on any cell');
  eq(cu.state, 'ENTER', 'they are walking in, the way they always did');
  eq(g.snapshot().cars.length, 0, 'and nothing is drawn in a car park that is not there');
  eq(g.snapshot().customers.length, 1, 'while the shopper themselves is');
}

// ---------------------------------------------------------------------------
// 2. One lane per space, and it ends ON the cell.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  paintPark(g, 6);
  const spaces = g.parkSpaces();
  // A BAY IS TWO CELLS. A car is 2.05 tiles long and 1.21 wide — bigger than
  // the shopper who gets out of it — so one cell is a car parked across three
  // of them. Six cells of tarmac is three bays, and an odd cell is not a bay.
  eq(spaces.length, 3, 'six cells of tarmac is three bays');

  for (const s of spaces) {
    check(s.lane != null, `the space at ${s.x},${s.z} has a lane`);
    if (!s.lane) continue;
    check(offMap(g.layout, s.lane.in[0]), 'which starts off the edge of the map');
    const last = s.lane.in[s.lane.in.length - 1];
    check(last.x === s.x && last.z === s.z, 'and ends on the space itself, not one short of it');
    eq(s.lane.dock.x, s.x, 'the dock is the space (x)');
    eq(s.lane.dock.z, s.z, 'the dock is the space (z)');
    const home = s.lane.out[s.lane.out.length - 1];
    check(offMap(g.layout, home), 'and the way out leads off the map again');
    check(s.lane.out[0].x === s.x && s.lane.out[0].z === s.z,
      'starting from the space it is standing in');
  }

  // Every leg is a straight line. That is what makes it a lane rather than a
  // path — see `laneFinder`. Nothing here is checked by watching a car.
  const lane = spaces[0].lane;
  for (let i = 1; i < lane.in.length; i++) {
    const a = lane.in[i - 1];
    const b = lane.in[i];
    check(a.x === b.x || a.z === b.z, `leg ${i} is a straight line`, JSON.stringify([a, b]));
  }
}

// ---------------------------------------------------------------------------
// 3. The drive: in the car, then in the shop — and the patience budget is
//    untouched by the first half.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  paintPark(g, 2);
  const space = g.freeSpace();
  check(space != null, 'the bay is free before anybody comes');

  const res = g.spawnCustomer(null, space);
  eq(res.drove, true, 'a shopper drives in');
  const cu = g.customers[res.id];
  // What they arrived in the world with, for the claim at the end of this case.
  const setOff = cu.mood;
  eq(cu.state, 'DRIVE', 'and starts at the wheel');
  eq(cu.drive.phase, 'in', 'on the way in');
  check(offMap(g.layout, cu.drive), 'from off the edge of the map');
  check(cu.x === cu.drive.x && cu.z === cu.drive.z, 'with the body riding in the car');

  // Nobody draws a person inside a car, and nothing counts one as being in the
  // shop. Both are the same predicate and both are invisible until they are
  // wrong: the first as a shopper skating up the road, the second as a crush.
  const mid = g.snapshot();
  eq(mid.cars.length, 1, 'the car is drawn');
  eq(mid.customers.length, 0, 'and the shopper inside it is not');
  eq(g.measureOccupancy(), 0, 'a car on the road is nobody in the shop');

  const drove = until(g, () => cu.state !== 'DRIVE', 600);
  check(drove != null, 'the car reaches its space', 'still driving after 60s');
  check(drove > 0.5, 'and the drive took time', `${drove}s`);
  eq(cu.state, 'ENTER', 'then the driver gets out and walks in');
  eq(cu.drive.phase, 'parked', 'the car is parked');
  eq(cu.drive.x, space.mid.x, 'exactly in the middle of its bay (x)');
  eq(cu.drive.z, space.mid.z, 'exactly in the middle of its bay (z)');
  eq(cu.drive.facing, cu.parkedFacing, 'nose towards the shop, not along the road');

  // THE claim. `patience` is a budget the shop draws on; the road is not the
  // shop. A driver who arrives already annoyed is a shop punished for being
  // reachable.
  //
  // Against what they set off with rather than against 1: since `MOOD_BASE` the
  // walk-in mood is a fact about how nice the shop is to stand in, and this
  // claim was never about the value — it is that the DRIVE changed nothing.
  // Asserting the literal made it two claims, and the one it was not about is
  // the one that broke.
  eq(cu.mood, setOff, 'and their patience is untouched by the journey');

  // ...and the control, or the assertion above passes on a mood nothing drains.
  const g2 = fresh();
  const walker = g2.customers[g2.spawnCustomer().id];
  until(g2, () => walker.state === 'BROWSE', 600);
  const before = walker.mood;
  for (let i = 0; i < Math.max(1, Math.round(drove / 0.1)); i++) g2.step(0.1);
  check(walker.mood < before, 'while the same seconds spent in the shop do cost patience',
    `${before} -> ${walker.mood}`);
}

// ---------------------------------------------------------------------------
// 4. The space is held for the whole trip, and handed back exactly once.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  paintPark(g, 2);
  const space = { ...g.freeSpace() };
  const cu = g.customers[g.spawnCustomer(null, g.freeSpace()).id];

  eq(g.freeSpace(), null, 'the bay is taken from the tick they set off');
  until(g, () => cu.state === 'ENTER', 600);
  eq(g.freeSpace(), null, '...while they are walking in');
  until(g, () => cu.state === 'BROWSE', 600);
  eq(g.freeSpace(), null, '...while they are shopping');

  g.leaveShop(cu);
  eq(cu.state, 'LEAVE', 'they head back to the car');
  eq(g.freeSpace(), null, '...while they walk back to it');

  const left = until(g, () => cu.state === 'DEPART', 900);
  check(left != null, 'they get in and drive off', 'never reached the car');
  eq(cu.drive.phase, 'out', 'the car is on its way out');
  eq(g.freeSpace(), null, '...and the space is STILL theirs while it reverses off');
  eq(g.snapshot().customers.length, 0, 'nobody is drawn walking beside it');
  eq(g.snapshot().cars.length, 1, 'the car is');

  const gone = until(g, () => g.customers[cu.id] == null, 900);
  check(gone != null, 'and then they are gone', 'never left');
  eq(g.snapshot().cars.length, 0, 'the car with them');
  check(freeAt(g, space), 'and the space comes back');
}

// ---------------------------------------------------------------------------
// 5. A space with no lane is still a space.
//
// The claim that keeps an animation out of the balance. An indoor cell is the
// cleanest way to author one: `laneFinder` will not drive through a building,
// so a car park painted in the stockroom is parking with no way to be seen
// arriving at — which is exactly the case a walled-in yard is for the van.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const spot = { x: g.layout.store.x + 1, z: g.layout.store.z + 1 };
  const paint = g.buildGround('me', { ...spot, piece: 'verify-park-pad', to: { x: spot.x, z: spot.z + 1 } });
  check(paint.ok, 'a car park can be painted indoors', paint.error ?? '');
  eq(g.layout.tiles[spot.z * g.layout.w + spot.x], T.PARK, 'and the cells are car park now');

  const spaces = g.parkSpaces();
  eq(spaces.length, 1, 'two cells is one bay');
  eq(spaces[0].lane, null, 'with no lane to it');
  check(g.parkReach() > 0, 'and it widens the catchment exactly as a lane-less bay should');

  const bay = g.freeSpace();
  const cu = g.customers[g.spawnCustomer(null, bay).id];
  eq(cu.state, 'ENTER', 'somebody who parks there is simply already there');
  eq(cu.drive.phase, 'parked', 'with the car standing in it');
  eq(cu.drive.x, bay.mid.x, 'in the middle of the bay (x)');
  eq(cu.drive.z, bay.mid.z, 'in the middle of the bay (z)');
  eq(g.snapshot().cars.length, 1, 'and it is drawn');
  eq(g.snapshot().customers.length, 1, 'beside a shopper who is walking, not driving');

  // ...and they still leave, which is the half a missing lane could break: the
  // way out is the way in reversed, and there is no way in.
  g.leaveShop(cu);
  const gone = until(g, () => g.customers[cu.id] == null, 900);
  check(gone != null, 'and they get home without one', 'stuck at the car');
}

// ---------------------------------------------------------------------------
// 6. A re-flow parks a car. It does not send it back to the map edge.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  paintPark(g, 2);
  const space = { ...g.freeSpace() };
  const cu = g.customers[g.spawnCustomer(null, g.freeSpace()).id];
  const setOff = cu.mood;

  // On the map but not yet arrived — the state a re-flow has to have an answer
  // for. Off the map it is a walker on the approach, and those are dropped.
  const on = until(g, () => cu.state === 'DRIVE'
    && cu.x >= 0 && cu.z >= 0 && cu.x < g.layout.w && cu.z < g.layout.h, 600);
  check(on != null, 'the car gets onto the map', 'never did');

  g.regenerateLayout();
  check(g.customers[cu.id] != null, 'a re-flow does not delete a car halfway down the lane');
  eq(cu.state, 'ENTER', 'it parks on the spot and the driver walks in');
  eq(cu.drive.phase, 'parked', 'the car is standing');
  eq(cu.drive.x, space.mid.x, 'in the bay it claimed (x)');
  eq(cu.drive.z, space.mid.z, 'in the bay it claimed (z)');
  // Against what they set off with, for the reason case 4 is — the claim is
  // that the re-flow cost them nothing, not what the number happens to be.
  eq(cu.mood, setOff, 'and being rebuilt around cost them no patience either');

  const shopped = until(g, () => cu.state === 'BROWSE', 900);
  check(shopped != null, 'and they go on to shop', `stuck in ${cu.state}`);
}

// ---------------------------------------------------------------------------
// 7. The road is a preference, and the border ring is not yours to paint.
// ---------------------------------------------------------------------------
{
  const g = fresh();

  check(isGround('road'), 'road is ground');
  check(!isPad('road'), 'and not a pad — it carries no job, only a look');
  check(GROUND_KINDS.includes('road'), 'and it is in the ground vocabulary');

  const before = JSON.stringify(g.layout.vanRoute);
  check(g.layout.vanRoute != null, 'a shop with no road still has a lane for the van', before);

  // The ring itself is the world's. Every build tool refuses row 0, which means
  // the leg ALONG the border can never be tarmac — what you paint is the drive
  // from that road to your yard. See docs/deliveries.md step 6.
  const ring = g.buildGround('me', { x: 4, z: 0, piece: 'verify-park-road-a', to: { x: 6, z: 0 } });
  check(!ring.ok, 'the border ring cannot be painted', ring.error ?? 'it was');

  // A drive out of the west side of the bay. Longer in tiles than the lane the
  // van already takes and cheaper in road, which is the whole mechanic.
  //
  // Both ends are read off the bay rather than written down. The seed used to
  // lay the pad against the west corner of the building, so "x 1 to 7" was
  // touching it; it lays a block behind the back door now, and a run that stops
  // five tiles short is a road to a field — the van docks on the grass beside
  // it, which fails as "the cell it stops on is not road" and reads as the
  // preference being broken rather than as the drive not reaching.
  //
  // The row nearest the building, not `cells[0]`. A road stroke is `ROAD_THICK`
  // cells thick whichever way you drag it, so a drive laid along the OUTER row
  // of a two-row pad tarmacs the row behind it as well — and the erase below is
  // a one-cell brush, which then leaves half a road down and the lane on it.
  // That is the asymmetry between painting a road and rubbing one out, and it
  // is not what this section is about.
  const bayRow = Math.max(...g.layout.bay.cells.map((c) => c.z));
  const bayWest = Math.min(...g.layout.bay.cells.map((c) => c.x));
  const driveEnd = bayWest - 1;
  const drive = g.buildGround('me', { x: 1, z: bayRow, piece: 'verify-park-road-a', to: { x: driveEnd, z: bayRow } });
  check(drive.ok, 'a drive can be laid from the border to the bay', drive.error ?? '');
  eq(g.layout.tiles[bayRow * g.layout.w + 4], T.ROAD, 'and the cells are road');

  const after = g.layout.vanRoute;
  check(JSON.stringify(after) !== before, 'the van comes in a different way now', JSON.stringify(after));
  eq(after.dock.z, bayRow, 'docking off the drive that was laid for it (z)');
  eq(g.layout.tiles[after.dock.z * g.layout.w + after.dock.x], T.ROAD,
    'and the cell it stops on is the road');

  // A LOOK, not a lane: repaint the identical run in a garish, dearer design and
  // nothing with wheels may notice. Same claim `verify:floor` makes about floor.
  const lane = JSON.stringify(g.layout.vanRoute);
  const repaint = g.buildGround('me', { x: 1, z: bayRow, piece: 'verify-park-road-b', to: { x: driveEnd, z: bayRow } });
  check(repaint.ok, 'it can be repainted in another design', repaint.error ?? '');
  eq(JSON.stringify(g.layout.vanRoute), lane, 'and the lane is byte-identical');

  // ...and never a requirement. Take it all up and the van still comes — the
  // failure this guards against is a brush that breaks every shop in the world
  // on the re-flow after it ships.
  const up = g.buildGround('me', { x: 1, z: bayRow, piece: '', to: { x: driveEnd, z: bayRow } });
  check(up.ok, 'and taken up again', up.error ?? '');
  check(g.layout.vanRoute != null, 'a shop with the road torn out still gets its deliveries');
  eq(JSON.stringify(g.layout.vanRoute), before, 'by exactly the lane it used before there was one');
}

// ---------------------------------------------------------------------------
// 8. A road is ground, so it is walkable, and it stops nothing.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const z = g.layout.door.z + 4;
  const x = g.layout.door.x + 3;
  const res = g.buildGround('me', { x, z, piece: 'verify-park-road-a', to: { x: x + 2, z } });
  check(res.ok, 'a road goes down out the front', res.error ?? '');
  eq(g.layout.tiles[z * g.layout.w + x], T.ROAD, 'the cell is road');
  eq(g.walk[z * g.layout.w + x], 1, 'and anybody can walk across it');
  check(!g.placeFixture('me', { kind: 'shelf', x, z, rot: 0 }).ok,
    'but no shelf can stand on it — it is neither floor nor grass');

  // A shopper crossing it must still get in. A road that took walkable ground
  // away would let you wall your own shop off with a brush that says nothing.
  const cu = g.customers[g.spawnCustomer().id];
  const shopped = until(g, () => cu.state === 'BROWSE', 900);
  check(shopped != null, 'and a shopper still walks in past it', `stuck in ${cu.state}`);
}

// ---------------------------------------------------------------------------
// 9. The pavement: feet prefer it, and it is never required.
//
// The road's claim said about people, and it has the same two halves. The
// second is the one that would rot: `findPath` charges every outdoor step now,
// so a mistake there is not "the pavement is ignored", it is every route in the
// game changing — including the ones inside the shop, which is the hot loop.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const L = g.layout;

  // An open corner of grass out front, well clear of the building and the strip
  // the generator lays. Read off the layout rather than written down, because a
  // sweep whose coordinates drift into a shelf fails for a reason that is not
  // its subject.
  const z0 = L.door.z + 2;
  const x0 = L.store.x + L.store.w + 2;
  const A = { x: x0, z: z0 };
  const B = { x: x0 + 4, z: z0 + 4 };
  const legs = [];
  for (let x = A.x + 1; x <= B.x; x++) legs.push({ x, z: A.z });
  for (let z = A.z + 1; z <= B.z; z++) legs.push({ x: B.x, z });
  for (const c of [A, ...legs]) {
    check(g.walk[c.z * L.w + c.x] === 1, `the test ground at ${c.x},${c.z} is open`);
  }

  const bare = findPath(g.walk, L, A, B);
  check(bare != null, 'there is a way across the grass');
  eq(bare.length, legs.length, 'and it is the shortest one');

  // Now pave exactly ONE of the several equally short ways. Nothing gets
  // shorter — there is no shorter — so the only thing that can change is which
  // of them is chosen, which is precisely what a preference is.
  const paved = g.buildGround('me', { x: A.x + 1, z: A.z, piece: 'verify-park-paving', to: { x: B.x, z: A.z } });
  check(paved.ok, 'a pavement can be laid over open grass', paved.error ?? '');
  const down = g.buildGround('me', { x: B.x, z: A.z + 1, piece: 'verify-park-paving', to: { x: B.x, z: B.z } });
  check(down.ok, 'and turned the corner', down.error ?? '');
  eq(g.layout.tiles[A.z * L.w + A.x + 1], T.PATH, 'the cells are pavement');

  const walked = findPath(g.walk, g.layout, A, B);
  check(walked != null, 'the way across is still there');
  eq(walked.length, legs.length, 'and no longer than it was — a preference, not a detour');
  const onPaving = walked.every((c) => g.layout.tiles[c.z * g.layout.w + c.x] === T.PATH);
  check(onPaving, 'and every step of it is on the pavement',
    JSON.stringify(walked.filter((c) => g.layout.tiles[c.z * g.layout.w + c.x] !== T.PATH)));

  // ...and it does not drag anybody towards paving that is out of their way.
  // A preference that could is a shopper walking the length of the shop to use
  // a path, which reads as broken rather than as tidy.
  const g2 = fresh();
  const far = { x: 1, z: g2.layout.h - 2 };
  const before = findPath(g2.walk, g2.layout, A, B).length;
  g2.buildGround('me', { ...far, piece: 'verify-park-paving', to: { x: far.x + 3, z: far.z } });
  eq(findPath(g2.walk, g2.layout, A, B).length, before,
    'pavement nowhere near you changes nothing about your route');
}

// ---------------------------------------------------------------------------
// 10. Pavement is a KIND now, and a crossing is a design of it.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  check(isGround('path'), 'pavement is ground');
  check(!isPad('path'), 'and not a pad — a look, like the road and the floor');

  // The strip the generator lays from the door is ground you could have
  // painted, so it is ground you may paint over. It refused before this kind
  // existed, with a message naming it — see `groundIsBusy`.
  const strip = { x: g.layout.door.x, z: g.layout.door.z + 1 };
  eq(g.layout.tiles[strip.z * g.layout.w + strip.x], T.PATH, 'the generated path is pavement');
  const over = g.buildGround('me', { ...strip, piece: 'verify-park-road-a' });
  check(over.ok, 'and the path out to the fields can be paved over now', over.error ?? '');
  eq(g.layout.tiles[strip.z * g.layout.w + strip.x], T.ROAD, 'with whatever you like');

  // A CROSSING is the whole argument for pavement not being a second road: the
  // tile is `T.PATH`, which has been in `DRIVABLE` since the van first drove, so
  // one painted across a lane is drivable AND the thing feet prefer. Nothing
  // needed a kind of its own to say that.
  const g2 = fresh();
  const bayRow = g2.layout.bay.cells[0].z;
  g2.buildGround('me', { x: 1, z: bayRow, piece: 'verify-park-road-a', to: { x: 7, z: bayRow } });
  const laneBefore = g2.layout.vanRoute;
  check(laneBefore != null && laneBefore.dock.z === bayRow, 'the van comes down the new drive');

  const cross = g2.buildGround('me', { x: 4, z: bayRow, piece: 'verify-park-crossing' });
  check(cross.ok, 'a crossing can be painted across it', cross.error ?? '');
  eq(g2.layout.tiles[bayRow * g2.layout.w + 4], T.PATH, 'and the cell is pavement');
  const laneAfter = g2.layout.vanRoute;
  check(laneAfter != null, 'the van still has a lane');
  eq(laneAfter.dock.z, bayRow, 'and still comes down that drive — a crossing is drivable');
  eq(laneAfter.dock.x, laneBefore.dock.x, 'stopping exactly where it did');
}

// ---------------------------------------------------------------------------
// 10. A van stops short of the pad by however long a van it is.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const row = g.deliveryVan();
  const lane = g.layout.vanRoute;
  check(row != null, 'there is a delivery vehicle authored');
  check(lane != null, 'and a lane for it');

  if (row && lane) {
    const pad = g.layout.bay;
    const stop = g.vanStop(lane, row, pad);
    const prev = lane.in[lane.in.length - 2];
    // Which way the last leg runs, and where the pad begins. Every leg is
    // axis-aligned, so one of these two is always zero and `along` reduces
    // whichever axis is live to a single signed distance.
    const dx = Math.sign(lane.dock.x - prev.x);
    const dz = Math.sign(lane.dock.z - prev.z);
    const edge = { x: lane.dock.x + dx * 0.5, z: lane.dock.z + dz * 0.5 };
    const along = (p) => (dx !== 0 ? (p.x - edge.x) * dx : (p.z - edge.z) * dz);
    const box = modelExtent(row.model);

    /**
     * A vehicle is authored nose-east, so the load bed is its `-x` end — which
     * is why a lorry that drives in forwards unloads out of its bonnet. It
     * reverses, and the two claims that come out of that are the whole section.
     */
    eq(stop.back, Math.atan2(-dx, -dz), 'it holds the last leg facing away from the pad');

    // The bed ends AT the edge of the pad, never on it. Arithmetic on the art
    // rather than on a constant, over every stage — so a van that arrives full
    // and leaves empty stops in the same place, and a longer one somebody draws
    // next week backs off further rather than parking on the crates.
    const bed = { x: stop.x - dx * box.minX, z: stop.z - dz * box.minX };
    check(along(bed) <= 1e-9, 'the bed ends at the edge of the pad, never on it',
      `over by ${along(bed).toFixed(3)} tiles`);

    // ...and it may not stop somewhere else either. A setback that overshot
    // would be a lorry unloading from the far side of the yard, which reads as
    // a broken lane rather than as a number being too big.
    const back = -along(stop) - 0.5;
    check(back >= 0, 'and it never creeps PAST the cell the lane ends on', `${back}`);
    check(back < 1.5, 'nor halts a lorry-and-a-half back from the yard', `${back}`);

    // The cab is at the other end, which is the half a screenshot would show
    // and the reason any of this was worth doing.
    const nose = { x: stop.x - dx * box.maxX, z: stop.z - dz * box.maxX };
    check(along(nose) < along(bed), 'with the cab further from the pad than the bed is');

    // A vehicle small enough not to need it is the shop that was here before —
    // the same promise section 1 makes about a shop with no car park, said
    // about a lorry nobody has re-drawn.
    const stubby = { ...row, model: { parts: [{ shape: 'box', pos: [0, 0.2, 0], scale: [0.6, 0.4, 0.5] }] } };
    const same = g.vanStop(lane, stubby, pad);
    eq(same.x, lane.dock.x, 'a short van stops exactly on the dock (x)');
    eq(same.z, lane.dock.z, 'a short van stops exactly on the dock (z)');

    // And the lane itself is untouched by any of it. The setback belongs to the
    // vehicle; whole tiles belong to the shop, and `regenerateLayout` compares
    // `van.dock` against this cell to ask whether the lane it set out on is
    // still the lane.
    eq(lane.dock.x, Math.round(lane.dock.x), 'the lane still ends on a whole tile (x)');
    eq(lane.dock.z, Math.round(lane.dock.z), 'the lane still ends on a whole tile (z)');

    // End to end: send a real run and let it drive. The van that arrives has to
    // be standing where `vanStop` said and pointing the way it said, or both are
    // functions nothing calls.
    g.orders.pending.push({
      id: 'verify-park-run', item_id: content().items[0]?.id, qty: 1, arrivesAt: 0, cost: 0,
    });
    g.loadVan();
    check(g.van != null, 'a van is sent out');
    if (g.van) {
      const parked = until(g, () => g.van == null || g.van.phase !== 'in', 2000);
      check(parked != null && g.van, 'it reaches the dock', 'never arrived');
      if (g.van) {
        eq(g.van.x, stop.x, 'and halts where its own art says it must (x)');
        eq(g.van.z, stop.z, 'and halts where its own art says it must (z)');
        eq(g.van.facing, stop.back, 'backed in, rather than pointing the way it drove');
        // The way home starts where it is standing. Left as the lane's own
        // dock, pulling away would begin with the lorry lurching FORWARD over
        // the crates it has just set down.
        eq(g.van.out[0].x, stop.x, 'and pulls away from there rather than from the pad (x)');
        eq(g.van.out[0].z, stop.z, 'and pulls away from there rather than from the pad (z)');
      }

      // ...and it leaves nose-first, which is what makes reversing in free: the
      // heading it is already holding IS the way out, so there is no turn on the
      // spot at either end of the stop.
      const away = until(g, () => g.van == null || g.van.phase === 'out', 4000);
      check(away != null, 'it pulls away', 'never did');
      if (g.van) eq(g.van.facing, stop.back, 'without turning round to do it');
    }
  }
}

// ---------------------------------------------------------------------------

console.log(`\nverify:park — ${checks} assertions`);
if (failures.length) {
  console.error(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✅  a car drives to its space, and everybody prefers the way you laid.\n');
