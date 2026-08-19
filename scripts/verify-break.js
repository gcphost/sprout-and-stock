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
  // TWO rungs, and the second one moves nothing. Sections 1-6 are all about a
  // hire on rung 1, so a rung above them has to be provably free — every
  // multiplier defaults to 1, so this is the ladder existing and nothing else.
  // It exists for section 7, where being above the bottom rung is the whole
  // condition.
  tiers: [{ name: 'Standard', cost: 0 }, { name: 'Promoted', cost: 0 }],
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
/** ...and the other authored number, for the claim about how LONG a break is. */
const secondsOf = (id) => Math.max(1, content().byId.pastimes[id]?.seconds ?? 20);

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
// 3. A break in the room is worth more than the same break out of it, and it is
//    over sooner.
//
// The numbers that make it worth painting. Without them the room is ground you
// pay for that only ever costs you the walk.
//
// Two of them rather than one, and they are different currencies: restoring
// more means FEWER breaks, finishing sooner means SHORTER ones. Both are
// asserted because either alone would leave the other free to be quietly
// dropped — and neither is visible in play, since what you would have to notice
// is a break that did NOT happen, or one that ended a few seconds earlier than
// the same break somewhere else.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  paintBreak(g, g.layout.store.x + 2, yardRow(g), 2);
  const [s] = hire(g);
  drain(s);
  check(until(g, () => s.pastime != null) != null, 'a hire takes a break in the room');
  const drew = s.pastime;
  check(s.breakAt != null, 'in it');
  // Read off the deadline the moment it is set rather than timed with a wall
  // clock: the span IS the claim, and watching for the end measures the walk
  // back as well.
  const span = g.elapsed != null ? s.breakUntil - s.breakFrom : 0;
  near(span, secondsOf(drew) * 0.7, 0.05,
    'and their break is the shorter for it', `${span.toFixed(2)}s`);
  check(until(g, () => s.pastime == null) != null, 'and comes back off it');
  near(s.energy, DRAINED + restoresOf(drew) * 1.5, 0.02,
    'having restored half again what that same break restores outside it');
  eq(s.breakAt, null, 'and gives the seat back on standing up');

  // …and the same break with no room to take it in is the authored length, or
  // the multiplier above is being asserted against itself.
  const g2 = fresh();
  const [s2] = hire(g2);
  drain(s2);
  check(until(g2, () => s2.pastime != null) != null, 'a hire in a shop with no room takes one too');
  eq(s2.breakAt, null, 'standing up somewhere');
  near(s2.breakUntil - s2.breakFrom, secondsOf(s2.pastime), 0.05,
    'and it runs for exactly as long as the pastime says');
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
// 7. A promoted unit takes ITSELF off to charge, and puts itself back.
//
// Everything in here is invisible twice over. A bot in the break room because
// it is worn out and a bot in the break room because there is nothing on are
// the same still frame — and the two claims that matter most are about somebody
// who did NOT go, and about a charge that ENDED. What it would read as if any
// of it broke is a promotion you paid for that made a unit lazy.
//
// `energy` is set by hand throughout rather than worked for. Every other route
// to a part-empty tank is a hire doing jobs, and a hire doing jobs is a hire who
// is not idle, which is the one state this whole section is about.
// ---------------------------------------------------------------------------

/**
 * Below full and comfortably above `SPENT`, so nothing in here is a tired break
 * — and low enough that a whole seated charge still lands short of the clamp at
 * 1, or every energy assertion below would be measuring `clamp01` rather than
 * what a charge is worth.
 */
const TOPPABLE = 0.32;

/** Long enough to clear `BORED_SECONDS` (15s) and walk across a small shop. */
const BORED_ENOUGH = 26;

{
  // 7a. The bottom rung never does it, which is every shop that exists today.
  const g = fresh();
  paintBreak(g, g.layout.store.x + 1, yardRow(g), 2);
  const [s] = hire(g);
  s.energy = TOPPABLE;
  until(g, () => false, BORED_ENOUGH * 10);
  eq(s.pastime, null, 'a hire on the bottom rung stands about rather than charging');
  eq(s.breakAt, null, 'and takes no seat in the room');
  near(s.energy, TOPPABLE, 1e-9, 'and gains nothing, because nothing happened');
}

{
  // 7b. A rung up, and the same shop sends them to the room on their own.
  const g = fresh();
  paintBreak(g, g.layout.store.x + 1, yardRow(g), 2);
  const [s] = hire(g);
  const res = g.promote(g.roster[0].id);
  check(res.ok, 'the hire can be promoted', res.error ?? '');
  s.energy = TOPPABLE;

  // Nothing for the first twelve seconds, so this cannot pass on a hire who
  // simply goes the moment they are idle — which is a unit that never works.
  eq(until(g, () => s.pastime != null, 12 * 10), null,
    'a short lull is not boredom — nothing happens for the first 12s');

  check(until(g, () => s.pastime != null, BORED_ENOUGH * 10) != null,
    'a promoted hire with nothing to do takes itself off to charge');
  const drew = s.pastime;
  check(s.breakAt != null, 'and it is a SEAT in the room, never a spot on the floor');
  check(s.idleCharge === true, 'flagged as a charge rather than a break, or nothing tells them apart');

  // Sat all the way out, it is an ordinary break in every way but why it began.
  // Both halves of what the room is worth, read off what they DREW —
  // `choosePastime` weights across everything authored, so asserting against
  // this sweep's own row would be asserting against a coin toss.
  //
  // The span is the sharp one: unlike the energy below it can never be clamped,
  // so a charge that quietly stopped being a *seated* break would show up here
  // whatever the tank happened to be.
  near(s.breakUntil - s.breakFrom, secondsOf(drew) * 0.7, 0.05,
    'running for the shorter seated span', `${(s.breakUntil - s.breakFrom).toFixed(2)}s`);
  check(until(g, () => s.pastime == null, 60 * 10) != null, 'the charge finishes on its own');
  near(s.energy, Math.min(1, TOPPABLE + restoresOf(drew) * 1.5), 0.02,
    'and pays the seated rate, the same as any other break in the room');
  eq(s.breakAt, null, 'giving the seat back on standing up');
}

{
  // 7c. No room, no charge. The half that keeps every existing shop unchanged —
  // a bored unit must not start leaning on shelves in the middle of the floor,
  // which is what it would do if this reached for `spotFor` like a break does.
  const g = fresh();
  const [s] = hire(g);
  g.promote(g.roster[0].id);
  s.energy = TOPPABLE;
  until(g, () => false, BORED_ENOUGH * 10);
  eq(g.layout.break, null, 'the shop never painted a break area');
  eq(s.pastime, null, 'so a bored unit does not charge at all');
}

{
  // 7d. A full tank is nothing to gain, so the walk is not worth making.
  const g = fresh();
  paintBreak(g, g.layout.store.x + 1, yardRow(g), 2);
  const [s] = hire(g);
  g.promote(g.roster[0].id);
  s.energy = 1;
  until(g, () => false, BORED_ENOUGH * 10);
  eq(s.pastime, null, 'a unit on a full tank stays put rather than charging for nothing');
}

{
  // 7e. THE CENTREPIECE: anything at all outranks it.
  //
  // This is the whole difference between a charge and a break, and it is a claim
  // about a thing that did NOT happen — a job that did not wait. A break holds
  // the tick against the job list by design; if a charge did the same, promoting
  // your clerk would buy you a till nobody is on for twenty seconds at a time,
  // and the tell would be a shop that got slower when you spent money on it.
  //
  // Judged against their OWN deadline rather than against a stopwatch. Timed
  // instead, this passes on a charge that simply ran out — which is the same
  // picture and the exact bug being guarded.
  const g = fresh();
  paintBreak(g, g.layout.store.x + 1, yardRow(g), 2);
  const [s] = hire(g);
  g.promote(g.roster[0].id);
  // A job a pallet can wake, unlike `serve` in a shop with no till.
  const jobs = g.assignJobs(g.roster[0].id, [{ job: 'unload', weight: 1 }]);
  check(jobs.ok, 'the hire is given a job that a delivery can wake', jobs.error ?? '');
  s.energy = TOPPABLE;

  check(until(g, () => s.pastime != null, BORED_ENOUGH * 10) != null,
    'they settle into a charge with the bay empty');
  const drew = s.pastime;
  const from = s.breakFrom;
  const deadline = s.breakUntil;
  const banked = s.energy;
  check(s.breakAt != null, 'in a real seat');

  // A quarter of the way in, the shop takes a delivery. A QUARTER rather than a
  // flat second, because the pastime they drew could be any authored length, and
  // what the assertion below needs is that the share they sat is worth more than
  // the drain of the one job that woke them — which a fixed slice of a
  // forty-second charge would not be.
  const sit = (deadline - from) * 0.25;
  while (g.elapsed < from + sit) g.step(0.1);
  const item = content().items
    .find((it) => !it.tags.includes('frozen') && !it.tags.includes('needs-freezer'));
  check(!!item, 'the catalog has an ambient item to deliver');
  g.dropGoods(item.id, 4, g.layout.bay);

  check(until(g, () => s.pastime == null, 60 * 10) != null, 'and they get up');
  check(g.elapsed < deadline, 'BEFORE their own charge was due to end, which is the whole claim',
    `${g.elapsed.toFixed(1)}s against a deadline of ${deadline.toFixed(1)}s`);
  eq(s.idleCharge, false, 'the charge is over rather than merely paused');
  eq(s.breakAt, null, 'and the seat is handed back for somebody else');

  // Pro-rata, which is neither of the two easy wrong answers: crediting nothing
  // makes one delivery arriving strictly worse for the shop than none, and
  // crediting the whole `restores` makes being interrupted the best thing that
  // can happen to a hire.
  //
  // The ceiling is exact; the floor is where they sat down, and is deliberately
  // loose by one job. The tick they stand up is also the tick they TAKE the job
  // that woke them, so `spend` draws `DRAIN` off the same number a few lines
  // before `endCharge` adds to it — and naming `DRAIN` here would mean a balance
  // retune failing a sweep about breaks. Both wrong answers are still excluded:
  // crediting nothing leaves them below where they sat down, and crediting the
  // lot puts them over the ceiling.
  const full = restoresOf(drew) * 1.5;
  const share = Math.max(0, Math.min(1, (g.elapsed - from) / (deadline - from)));
  check(share > 0 && share < 1, 'having sat part of it', share.toFixed(3));
  check(s.energy > banked, 'they are better off than when they sat down',
    `${banked.toFixed(4)} -> ${s.energy.toFixed(4)}`);
  check(s.energy <= banked + full * share + 1e-9,
    'by no more than the share of the charge they actually took',
    `${s.energy.toFixed(4)} against a ceiling of ${(banked + full * share).toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// 8. A SHELF with no route is not a shelf, which is section 3 said about the
//    other thing a hire can walk at and never reach.
//
// The pin this whole file exists to catch has a second door into it, and it is
// wider than the break area's: a seat is one cell in one room, and a shelf is
// every unit in the building. `shelve` answers true for "on my way" as well as
// for "doing it", so a home the hire can never arrive at is a job that claims
// the tick for ever — `idleFrom` cleared every tick, `STUCK_SECONDS` never
// filling, `putDown` never reached, and the break under it never offered.
// Energy sits at zero and `tiredness` pins them at `TIRED_PACE` for the rest of
// the save.
//
// Nothing about it can be looked at. A robot walking to a shelf and a robot that
// can never reach one are the same still frame, and the goods are in its arms in
// both — found on a live shop as a chef stood outside the east wall holding six
// toasties, four days after a second hot counter went down on the first one's
// only working side.
//
// So the shop it builds is that shop: two units side by side, the second
// standing on the tile the first is used from. That is a placement the game
// WARNS about and allows, which is the point — `canPlace` gives two kinds of no
// and this is the kind that is a consequence rather than a refusal, so it is a
// state a player can reach and therefore one the crew has to survive.
//
// The control is the half that keeps this from passing for the wrong reason: a
// sweep that only asserts "the hire stopped shelving" is passed perfectly by a
// `shelve` that never works at all.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  // Nothing may buy, sell or deliver into the middle of this: every assertion
  // below is about one armful and where it ends up.
  g.open = false;
  g.orders.auto = false;
  g.orders.assign = false;
  g.orders.items = {};
  g.deliveries = [];

  const item = content().items.find((it) => !it.tags.includes('frozen')
    && !it.tags.includes('needs-freezer') && !it.tags.includes('needs-warmer'));
  check(!!item, 'the catalog has an ordinary ambient item to strand');

  // The unit whose working side we are about to build on. Its `browseAt` is
  // read off the placed record rather than re-derived, for `workSpotOf`'s own
  // reason: a facing the generator refused must not be drawn as though it had
  // been honoured.
  const home = g.layout.shelves.find((sh) => sh.browseAt);
  check(!!home, 'the generated shop has a shelf with a working side');

  // THREE units rather than the one the live shop had, and the difference is
  // the whole reason this sweep is deterministic where the bug was not.
  //
  // `findPath` retargets a blocked goal to the FIRST walkable neighbour in
  // `NEIGHBOURS` order, and whether that lands inside `REACH` of the anchor is
  // an accident of which way round that table happens to be: the two tiles
  // beside the working spot are 1.41 from the unit and inside it, the one
  // beyond is 2 and outside. A sweep that blocked only the working spot would
  // therefore pass or fail on the ordering of a constant in another file — and
  // would have passed, on this seed, against the unfixed code.
  //
  // So both of the near ways in are taken as well, which is a row of shelving
  // built along a wall and nothing more exotic. What is left is one approach,
  // out of reach, exactly as the shop that found this had.
  const at = home.browseAt;
  const walls = [at, { x: at.x, z: at.z - 1 }, { x: at.x, z: at.z + 1 }];
  for (const w of walls) {
    const put = g.placeFixture('me', { kind: 'shelf', x: w.x, z: w.z, rot: 0 });
    check(put.ok, `a unit goes down at ${w.x},${w.z}, boxing the first one in`, put.error ?? '');
  }

  // Ticked, so this is the item's ONE home — `homeShelves` filters every other
  // unit out, which is exactly what routed six toasties at a counter nobody
  // could stand at. Re-read after the re-flow a purchase causes, because
  // `styleFixture` and friends re-mint what they touch.
  const homeId = home.id;
  const tick = g.assignShelf('me', homeId, item.id, true);
  check(tick.ok, 'and the stranded unit is the item\'s only home', tick.error ?? '');

  const [hand] = hire(g);
  g.roster[0].jobs = [{ job: 'shelve', weight: 1 }];
  hand.carry = { stacks: [{ item_id: item.id, qty: 3 }] };
  drain(hand);

  // Long enough to walk the shop, wait out `STUCK_SECONDS` and take a break —
  // and it is a limit rather than a deadline: what is asserted below is the end
  // state, never how many ticks it took to get there.
  until(g, () => !hand.carry && (hand.energy ?? 0) > DRAINED, 900);

  // THE SETUP ITSELF, asserted. Everything below is vacuously true of a hire who
  // simply walked up and shelved it, and whether they could is a question about
  // one constant in `pathing.js` and one in `build.js` — so the state the whole
  // section is about has to be checked rather than assumed.
  check(Math.hypot(hand.x - home.x, hand.z - home.z) > 1.6,
    'the hire really is stranded out of reach of the only home there is',
    `${Math.hypot(hand.x - home.x, hand.z - home.z).toFixed(2)} tiles away`);

  check(!hand.carry, 'an armful whose only home cannot be reached is put down',
    hand.carry ? JSON.stringify(hand.carry) : '');
  // The goods themselves, which is the claim `putDown` exists to make: three
  // units are three units, on the pad rather than deleted out of a pair of hands.
  const onFloor = g.deliveries.reduce((n, d) => n
    + (d.stacks ?? []).reduce((m, k) => m + (k.item_id === item.id ? k.qty : 0), 0), 0);
  eq(onFloor, 3, 'and all three of them are on the floor where somebody can see them');
  check((hand.energy ?? 0) > DRAINED, 'and the hire is no longer pinned at empty',
    `${(hand.energy ?? 0).toFixed(3)}`);

  // THE CONTROL. Everything above is passed by a `shelve` that has stopped
  // working, so the same shop with the same hire and a home it can actually walk
  // to has to still fill the board.
  {
    const g2 = fresh();
    g2.open = false;
    g2.orders.auto = false;
    g2.orders.assign = false;
    g2.orders.items = {};
    g2.deliveries = [];
    const reachable = g2.layout.shelves.find((sh) => sh.browseAt);
    const ok = g2.assignShelf('me', reachable.id, item.id, true);
    check(ok.ok, 'the control shop ticks a reachable board for it', ok.error ?? '');
    const [worker] = hire(g2);
    g2.roster[0].jobs = [{ job: 'shelve', weight: 1 }];
    worker.carry = { stacks: [{ item_id: item.id, qty: 3 }] };
    until(g2, () => !worker.carry, 900);
    const board = g2.layout.shelves.find((sh) => sh.id === reachable.id);
    const shelved = (board?.stacks ?? []).reduce((n, k) => n + (k.item_id === item.id ? k.qty : 0), 0);
    eq(shelved, 3, 'and a reachable home is still stocked, by the same hire with the same job');
    eq(g2.deliveries.length, 0, 'with nothing put down on the way');
  }
}

// ---------------------------------------------------------------------------

console.log(`\nverify:break — ${checks} assertions`);
if (failures.length) {
  console.error(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✅  staff go to the break area, and a shop without one plays exactly as it did.\n');
