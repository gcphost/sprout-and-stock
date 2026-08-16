#!/usr/bin/env node
/**
 * VERIFY: THE BREAK AREA IS GROUND, AND HAVING NONE IS STILL A SHOP.
 *
 * A break used to happen wherever the pastime said — the back of the yard, the
 * front step, propped against a till. Those are a pastime saying where it looks
 * right, chosen when the shop had nowhere of its own to send anybody. The break
 * area is the shop's own answer, painted with the same brush the yard is, and it
 * outranks all of them.
 *
 * Nothing here is visible in a screenshot, and two of the four are invisible
 * even in a playthrough — you would have to notice that a hire came back from a
 * break slightly fresher, or that the fifth one did not go in:
 *
 * - **No break area is the old game, exactly.** This is the whole promise of the
 *   feature and the one that would rot silently: the override is in the same
 *   function the authored spot is read in, so a mistake there changes what every
 *   existing shop does and nothing says so. A shop with no room must still take
 *   breaks, at the spot the pastime named.
 *
 * - **One cell seats one person.** The size of the room is the decision, the
 *   same way the size of the bay is, and a decision that changes no number is a
 *   button that takes money and does nothing. Two hires in a one-cell room means
 *   one of them is elsewhere — not queueing, and not standing inside the other.
 *
 * - **A seat with no route is not a seat.** The override is total, so a room
 *   walled off from the shop would otherwise be a hire who walks at a cell they
 *   can never reach and never rests again, pinned at `TIRED_PACE` forever. That
 *   is a worse shop than one with no break area at all.
 *
 * - **The room is worth building.** A break taken in it restores more than the
 *   same break taken leaning on a shelf, because walking there costs the shop
 *   time that it otherwise would not have spent.
 *
 * Writes two ground rows into whatever content database it is pointed at —
 * usually the live shared one — and removes them on exit, exactly the way
 * verify:yard, verify:catalog, verify:economy and verify:floor do.
 *
 *   node scripts/verify-break.js
 */

import { Game } from '../server/sim/index.js';
import { content, writeContent } from '../server/content.js';
import { remove } from '../server/db.js';
import { padCells } from '../shared/build.js';
import { T } from '../shared/tiles.js';
import { E } from '../shared/edges.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const near = (a, b, tol, label) => check(Math.abs(a - b) <= tol, label,
  `expected ${b} ± ${tol}, got ${a}`);

/**
 * No till and no beds, deliberately. Every assertion below is about where a
 * worker went and how much of the tank they came back with, so anything they
 * could usefully *do* is noise: a hire who takes a job walks somewhere else and
 * spends `DRAIN` doing it, which is an energy assertion off by exactly one job.
 */
const SHOP = { shelf: 4, freezer: 0, checkout: 0, plot: 0 };

/**
 * Its own rows, so a sweep cannot start passing because somebody restyled the
 * shipped break area — and its own pastime, because the assertions below are
 * arithmetic on `restores` and `seconds`, and a seeded pastime is content
 * anybody may retune.
 */
const TEST_GROUND = [
  {
    id: 'verify-break-room', kind: 'break', name: 'Test Break Area',
    surface: { color: '#b59ab8', pattern: 'plain' }, tiers: [{ name: 'Flat', cost: 0 }], cost: 5,
  },
  {
    id: 'verify-break-floor', kind: 'floor', name: 'Test Floor',
    surface: { color: '#b8a894', pattern: 'plain' }, tiers: [{ name: 'Flat', cost: 0 }], cost: 5,
  },
];

/**
 * A pastime of this sweep's own — short, so nothing here waits thirty seconds
 * for a mug of tea, and it buys nothing, so no assertion is measuring a shelf.
 *
 * It is NOT the only one on offer, and that is worth stating because assuming
 * otherwise is what the first draft of this file did. `choosePastime` weights
 * across everything authored and an untagged pastime is offered to anybody, so
 * there is no way to author your way to a fixed draw. Every assertion below
 * therefore reads the row the worker actually drew — `restores` off that row,
 * and where it says the break happens — rather than the row written here.
 */
const TEST_PASTIME = {
  id: 'verify-break-sit', name: 'Test Sit', doing: 'sitting',
  spot: 'outside', seconds: 6, restores: 0.4, weight: 3, tags: [], buys: [],
};

process.on('exit', () => {
  for (const r of TEST_GROUND) { try { remove('fixtures', r.id); } catch { /* best effort */ } }
  try { remove('pastimes', TEST_PASTIME.id); } catch { /* best effort */ }
});
for (const r of TEST_GROUND) {
  const res = writeContent('fixture', r, 'verify');
  check(res.ok, `the catalog accepts a ${r.kind} row called ${r.id}`, res.error ?? '');
}
{
  const res = writeContent('pastime', TEST_PASTIME, 'verify');
  check(res.ok, 'the catalog accepts the test pastime', res.error ?? '');
}

/**
 * A worker kind of this sweep's own, tagged to nothing, so it is offered every
 * untagged pastime and no others. One job, and one that can never fire — a
 * schema needs at least one, and `serve` in a shop with no till is the only
 * entry in `JOBS` that is a guaranteed no-op. Fast, because every assertion here
 * waits for somebody to finish walking.
 */
const TEST_WORKER = {
  id: 'verify-break-hand', name: 'Test Hand', color: '#7a9e4b',
  jobs: [{ job: 'serve', weight: 1 }], cost: 0, wage: 0, speed: 20, pace: 0.05,
  tiers: [{ name: 'Standard', cost: 0 }],
};
process.on('exit', () => { try { remove('workers', TEST_WORKER.id); } catch { /* best effort */ } });
{
  const res = writeContent('worker', TEST_WORKER, 'verify');
  check(res.ok, 'the catalog accepts the test worker', res.error ?? '');
}

/**
 * The same reset every other sweep makes. `roster` matters more here than
 * anywhere: these assertions count who is on a break, so a hire the live save
 * happens to own is a body standing in the room taking a seat.
 */
function fresh() {
  const g = Game.create({ worldId: 'verify-break', seed: 'break', ephemeral: true });
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
  g.cash = 50000;
  g.addPlayer('me', 'Tester');
  g.players.me.build = { on: true };
  return g;
}

/** Take somebody on, and hand them straight to the sweep as a body. */
function hire(g, n = 1) {
  for (let i = 0; i < n; i++) {
    const res = g.hire(TEST_WORKER.id);
    check(res.ok, `hire ${i + 1} joins`, res.error ?? '');
  }
  // `hire` only writes the roster; `syncStaff` puts the bodies in on the tick.
  g.step(0.1);
  return g.roster.map((e) => g.players[`staff-${e.id}`]);
}

/** Wind the clock on until `done`, or give up. Returns how long it took. */
function until(g, done, limit = 400) {
  for (let i = 0; i < limit; i++) {
    g.step(0.1);
    if (done()) return (i + 1) * 0.1;
  }
  return null;
}

/** Paint a run of break area, west to east along one row. */
function paintBreak(g, x, z, len, piece = 'verify-break-room') {
  const res = g.buildGround('me', { x, z, piece, to: { x: x + len - 1, z } });
  check(res.ok, `a ${len}-cell break area goes down at ${x},${z}`, res.error ?? '');
  return res;
}

/**
 * Where a break area fits: the OUTER row of yard, not the one behind the wall.
 * `defaultPads` seeds the bay and the drop-off along `store.z - 1`, and painting
 * over those would be a sweep about breaks that quietly measures a shop with
 * nowhere to take a delivery.
 */
const yardRow = (g) => g.layout.store.z - 2;

/** Put a hire on the floor of the tank, which is what a shift of work does. */
const DRAINED = 0.1;
const drain = (s) => { s.energy = DRAINED; };

/**
 * Where the pastime itself says this break happens, or null for "wherever they
 * finished".
 *
 * A second spelling of `authoredSpot` (server/sim/staff.js) on purpose, rather
 * than an import. This is the behaviour a shop with no break area has to KEEP,
 * and a sweep that read it off the same function it is guarding would pass
 * whatever that function happened to do.
 */
function authored(g, pastimeId) {
  const p = content().byId.pastimes[pastimeId];
  const L = g.layout;
  if (p?.spot === 'bay') return L.bay;
  if (p?.spot === 'outside') return { x: L.door.x, z: L.door.z + 2 };
  if (p?.spot === 'till') {
    const till = L.checkouts[0];
    return till ? { x: till.x, z: till.z - 1 } : null;
  }
  return null;
}

/** Standing at a spot, to the same tolerance `goTo` settles for. */
const atSpot = (s, spot) => spot != null && Math.hypot(s.x - spot.x, s.z - spot.z) <= 1.3;

/** What one break restores, off the row they actually drew. */
const restoresOf = (id) => content().byId.pastimes[id]?.restores ?? 0.5;

// ---------------------------------------------------------------------------
// 1. A shop with no break area is the shop that was here before.
//
// The claim that has to hold for every save in existence, and the one that
// would rot in silence: the override lives in the same function the authored
// spot is read in.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  check(g.layout.break === null, 'a shop opens with no break area');
  check(padCells(g.layout, 'break').length === 0, 'and no break tiles anywhere in it');

  const [s] = hire(g);
  drain(s);
  const took = until(g, () => s.pastime != null);
  check(took != null, 'a spent hire still takes a break with nowhere to take it');
  eq(s.breakAt, null, 'and it is not a break in a room, because there is no room');

  // Wherever the pastime they drew says. A `here` pastime says nowhere, which
  // is not a weaker claim — it is the same one, and there is nothing to stand at.
  const drew = s.pastime;
  const spot = authored(g, drew);
  check(spot == null || atSpot(s, spot), 'they took it at the spot the pastime authored',
    `${drew} at ${s.x.toFixed(1)},${s.z.toFixed(1)}`);

  // ...and it restores exactly what that pastime says, un-multiplied.
  const back = until(g, () => s.pastime == null);
  check(back != null, 'and they come back off it');
  near(s.energy, DRAINED + restoresOf(drew), 0.02,
    'having restored exactly what the pastime authored');
}

// ---------------------------------------------------------------------------
// 2. Paint one, and that is where they go — whatever the pastime said.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const z = yardRow(g);
  const x = g.layout.store.x + 2;
  paintBreak(g, x, z, 2);
  check(g.layout.break !== null, 'the shop has a break area');
  eq(g.layout.break.cells.length, 2, 'of two cells');
  eq(g.layout.tiles[z * g.layout.w + x], T.BREAK, 'and the ground is break area now');

  const [s] = hire(g);
  drain(s);
  const took = until(g, () => s.pastime != null);
  check(took != null, 'a spent hire takes their break');
  check(s.breakAt != null, 'in the room');
  // Guarded rather than assumed: with the override gone this is null, and a
  // sweep that throws on the first thing it is meant to catch reports one
  // failure as a stack trace and never reaches the other sixty.
  const seat = s.breakAt ?? { x: NaN, z: NaN };
  check(g.layout.break.cells.some((c) => c.x === seat.x && c.z === seat.z),
    'on a cell of it', JSON.stringify(s.breakAt));
  near(Math.hypot(s.x - seat.x, s.z - seat.z), 0, 1.3, 'and standing on that cell');

  // Whatever the pastime authored was overridden. Stated as its own assertion
  // because it IS the feature — a break area that only caught the pastimes with
  // no spot of their own would look like it worked.
  const spot = authored(g, s.pastime);
  check(spot == null || !atSpot(s, spot), 'rather than at the spot the pastime authored',
    `${s.pastime} at ${s.x.toFixed(1)},${s.z.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
// 3. A break in the room is worth more than the same break out of it.
//
// The number that makes it worth painting. Without it the room is ground you
// pay for that only ever costs you the walk.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  paintBreak(g, g.layout.store.x + 2, yardRow(g), 2);
  const [s] = hire(g);
  drain(s);
  check(until(g, () => s.pastime != null) != null, 'a hire takes a break in the room');
  const drew = s.pastime;
  check(s.breakAt != null, 'in it');
  check(until(g, () => s.pastime == null) != null, 'and comes back off it');
  near(s.energy, DRAINED + restoresOf(drew) * 1.5, 0.02,
    'having restored half again what that same break restores outside it');
  eq(s.breakAt, null, 'and gives the seat back on standing up');
}

// ---------------------------------------------------------------------------
// 4. One cell seats one. How big you paint it is how many it holds.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  paintBreak(g, g.layout.store.x + 2, yardRow(g), 1);
  eq(g.layout.break.cells.length, 1, 'a one-cell break area');

  const staff = hire(g, 2);
  for (const s of staff) drain(s);
  check(until(g, () => staff.every((s) => s.pastime != null)) != null,
    'both hires take a break');

  const seated = staff.filter((s) => s.breakAt != null);
  eq(seated.length, 1, 'exactly one of them is in the room');
  // Guarded, like everything else that reads a seat: the assertion above is the
  // one that fails when both got in, and it should say so rather than throw.
  const out = staff.find((s) => s.breakAt == null);
  const spot = out ? authored(g, out.pastime) : null;
  check(!out || spot == null || atSpot(out, spot),
    'and the other took theirs where the pastime says — not queueing for a seat',
    out ? `${out.pastime} at ${out.x.toFixed(1)},${out.z.toFixed(1)}` : 'both were seated');
  check(Math.hypot(staff[0].x - staff[1].x, staff[0].z - staff[1].z) > 1,
    'so the two of them are not standing inside each other');

  // ...and painting it bigger seats them both. The size is the decision.
  //
  // Both breaks are allowed to FINISH first rather than being cleared by hand:
  // giving the seat back is the production path this half depends on, and a
  // sweep that reset the fields itself would pass with that line deleted.
  const cell = g.layout.break.cells[0];
  paintBreak(g, cell.x + 1, cell.z, 1);
  eq(g.layout.break.cells.length, 2, 'the room is two cells now');
  check(until(g, () => staff.every((s) => s.pastime == null)) != null,
    'both breaks end');
  for (const s of staff) drain(s);
  check(until(g, () => staff.every((s) => s.pastime != null)) != null,
    'both take another break');
  eq(staff.filter((s) => s.breakAt != null).length, 2, 'and this time both are in the room');
  const where = staff.map((s) => (s.breakAt ? `${s.breakAt.x},${s.breakAt.z}` : `nowhere-${s.id}`));
  check(where[0] !== where[1], 'on a seat each', where.join(' / '));
}

// ---------------------------------------------------------------------------
// 5. A room they cannot reach is not a room.
//
// The failure the override makes possible, and the worst one available: a shop
// whose staff never rest again, dragging at TIRED_PACE, for a reason the player
// cannot see. Sealing it must degrade to what a shop with no room does.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  // A cell of yard, walled off on all four sides. Out the back rather than in
  // the shop, so the walls enclose nothing anybody needs.
  const z = yardRow(g);
  const x = g.layout.store.x + 2;
  paintBreak(g, x, z, 1);
  const wall = (o, wx, wz) => {
    const res = g.buildEdge('me', { o, x: wx, z: wz, kind: E.WALL, to: o === 'h' ? wx : wz });
    check(res.ok, `a wall goes up ${o} at ${wx},${wz}`, res.error ?? '');
  };
  wall('h', x, z);          // north of it
  wall('h', x, z + 1);      // south of it
  wall('v', x, z);          // west of it
  wall('v', x + 1, z);      // east of it

  const [s] = hire(g);
  s.x = g.layout.spawn.x;
  s.z = g.layout.spawn.z;
  drain(s);
  const took = until(g, () => s.pastime != null);
  check(took != null, 'a spent hire still gets their break with the room sealed off');
  eq(s.breakAt, null, 'not in the room, because there is no way into it');
  const spot = authored(g, s.pastime);
  check(spot == null || atSpot(s, spot), 'they fell back to the spot the pastime authored',
    `${s.pastime} at ${s.x.toFixed(1)},${s.z.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
// 6. It is ground like the rest: walkable, never buildable, and it survives a
//    purchase.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const spot = { x: g.layout.store.x + 2, z: g.layout.store.z + 2 };
  eq(g.layout.tiles[spot.z * g.layout.w + spot.x], T.FLOOR, 'there is shop floor to work on');

  const paint = g.buildGround('me', { ...spot, piece: 'verify-break-room' });
  check(paint.ok, 'a break area can be laid indoors', paint.error ?? '');
  check(/nothing can be built or dug on/.test(paint.warn ?? ''),
    'and says what it costs you', paint.warn ?? 'none');
  eq(g.layout.tiles[spot.z * g.layout.w + spot.x], T.BREAK, 'the cell is break area now');
  check(!g.placeFixture('me', { kind: 'shelf', x: spot.x, z: spot.z, rot: 0 }).ok,
    'which is a cell no shelf can stand on');
  check(g.walk[spot.z * g.layout.w + spot.x] === 1, 'but one anybody can walk across');

  // A re-flow must leave it alone — the trap the yard pads were built out of.
  g.placeFixture('me', { kind: 'shelf', x: g.layout.store.x + 4, z: g.layout.store.z + 1, rot: 0 });
  eq(g.layout.tiles[spot.z * g.layout.w + spot.x], T.BREAK, 'and buying a shelf leaves it alone');

  // Losing the last of it is a consequence you are told about, never a refusal:
  // a shop with no break area is a shop, which is the whole fallback.
  const back = g.buildGround('me', { ...spot, piece: 'verify-break-floor' });
  check(back.ok, 'and it can be taken back up', back.error ?? '');
  check(/last break tile/.test(back.warn ?? ''), 'with a warning that it was the last of it',
    back.warn ?? 'none');
  check(g.layout.break === null, 'leaving the shop with no break area');
}

// ---------------------------------------------------------------------------

console.log(`\nverify:break — ${checks} assertions`);
if (failures.length) {
  console.error(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✅  staff go to the break area, and a shop without one plays exactly as it did.\n');
