#!/usr/bin/env node
/**
 * VERIFY: A WAY THROUGH KNOWS WHO IT IS FOR.
 *
 * Step 15 of docs/building.md, and the first rule in this game whose answer
 * depends on who is standing at it. A staff doorway and a doorway are the same
 * hole in the same wall — same enclosure, same price, same geometry, one painted
 * threshold apart — so *everything* here is invisible in a screenshot, and most
 * of it is invisible in play too: the whole feature is about somebody who did
 * not walk somewhere.
 *
 * What it pins:
 *
 * - **A sign is not a kind of wall.** A staff doorway encloses exactly as a
 *   doorway does, and a staff gate encloses exactly as a gate does. Leave a
 *   signed doorway out of `ENCLOSING` and your stockroom is a patio: every shelf
 *   in it is refused, and the refusal reads "something is already there", which
 *   sends you looking in the wrong file. Put a signed *gate* into it and fencing
 *   a field roofs it.
 *
 * - **One edge, two answers.** The same crossing, refused to a shopper and taken
 *   by a hire — and by you, because `canWalk` is the player's own test and stays
 *   `SOLID`. This is the claim the feature IS.
 *
 * - **A one-way door is a wall in one direction only**, and has nothing to say
 *   where there is no in and no out. Which way is "in" is read off the enclosure
 *   rather than stored, so an interior door and a gate in a fence must let
 *   everybody through — otherwise a rule you cannot see would be applying to a
 *   direction nobody chose.
 *
 * - **A break room behind a staff door is still a break room.** The seat search
 *   asks `findPath`, so a route staff cannot walk is the `TIRED_PACE` pin
 *   `verify:break` exists to catch, arriving through a door instead of a wall.
 *
 * - **Signing your own front door warns rather than refuses** — and this is the
 *   trap. `canPlaceEdges` floods from the spawn with `SOLID`; unchanged, you can
 *   make your entrance exit-only and the game says nothing at all while no
 *   customer can ever come in again. A shop that looks completely normal and
 *   takes no money.
 *
 * - **...and the flood underneath it must NOT change.** A shelf in a stockroom is
 *   cut off from the door on purpose. If that one went shopper-solid too, every
 *   wall you drew afterwards would warn about it, for ever.
 *
 * - **A shopper finds the other way in.** Nothing routes shoppers to a named
 *   door — A* finds one — so signing the front door of a shop with a service
 *   entrance is a longer walk rather than a closed shop.
 *
 * - **The queue never grows through one.** A lane is grown outward from the till
 *   and walked toward it, so a one-way door would be crossable in whichever
 *   direction the loop happened to ask about.
 *
 * - **Fitting the sign is free, and so is changing your mind.** Priced as a swap
 *   it costs half a doorway each way, and a switch that bills you $17 for
 *   changing your mind is not a switch.
 *
 * Writes one floor row into whatever content database it is pointed at — usually
 * the live shared one — and removes it on exit, the way verify:floor does.
 *
 *   node scripts/verify-doors.js
 */

import { Game } from '../server/sim/index.js';
import { writeContent } from '../server/content.js';
import { remove } from '../server/db.js';
import { findPath } from '../server/sim/pathing.js';
import { queueLane, canPlaceEdge, canPlaceEdges } from '../shared/build.js';
import {
  E, SOLID, ENCLOSING, RULED, WAYS, computeIndoor, edgeBetween, eviOf, ehiOf,
  shopperCanCross, wayBase, wayRule, wayKind,
} from '../shared/edges.js';
import { T } from '../shared/tiles.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SHOP = { shelf: 4, freezer: 0, checkout: 1, plot: 0 };

/**
 * Its own floor row, so nothing here starts passing because somebody restyled or
 * repriced the shipped flooring. Free, because no assertion in this file is
 * about money except the refit one, and that one counts doorways.
 */
const TEST_FLOOR = {
  id: 'verify-doors-floor', kind: 'floor', name: 'Test Floor',
  surface: { color: '#b8a894', pattern: 'plain' }, tiers: [{ name: 'Flat', cost: 0 }], cost: 1,
};
process.on('exit', () => { try { remove('fixtures', TEST_FLOOR.id); } catch { /* best effort */ } });
{
  const res = writeContent('fixture', TEST_FLOOR, 'verify');
  check(res.ok, 'the catalog accepts the test floor', res.error ?? '');
}

/**
 * The same reset every other sweep makes — `shell` and `edits` above all, since
 * every assertion here is about an edge somebody drew.
 */
function fresh() {
  const g = Game.create({ worldId: 'verify-doors', seed: 'doors', ephemeral: true });
  g.placements = [];
  g.grow = { w: 0, h: 0 };
  g.doorShift = 0;
  g.edits = [];
  g.ground = [];
  g.yardStamped = false;
  g.awningStamped = true; // Nothing here points at anything; the canopy is noise.
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

/** A bare grid of shop floor, the way verify:edges makes one. */
function pad(w, h) {
  return {
    w, h,
    tiles: new Uint8Array(w * h).fill(T.FLOOR),
    edgesV: new Uint8Array((w + 1) * h),
    edgesH: new Uint8Array(w * (h + 1)),
  };
}

function ring(L, x0, z0, x1, z1, kind) {
  for (let z = z0; z <= z1; z++) {
    L.edgesV[eviOf(L.w, x0, z)] = kind;
    L.edgesV[eviOf(L.w, x1 + 1, z)] = kind;
  }
  for (let x = x0; x <= x1; x++) {
    L.edgesH[ehiOf(L.w, x, z0)] = kind;
    L.edgesH[ehiOf(L.w, x, z1 + 1)] = kind;
  }
}

const settle = (L) => { L.indoor = computeIndoor(L); return L; };

/** Every cell the walls close in, as a comparable string. */
const enclosure = (L) => computeIndoor(L).join('');

/** The two edges the front door is made of — it is two cells wide. */
const frontDoor = (g) => [
  { o: 'h', x: g.layout.door.x, z: g.layout.door.z + 1 },
  { o: 'h', x: g.layout.door.x + 1, z: g.layout.door.z + 1 },
];

/** ...and the service door in the back wall, which the generator also lays. */
const backDoor = (g) => [
  { o: 'h', x: g.layout.door.x, z: g.layout.store.z },
  { o: 'h', x: g.layout.door.x + 1, z: g.layout.store.z },
];

const kindAt = (L, at) => (at.o === 'v'
  ? L.edgesV[eviOf(L.w, at.x, at.z)]
  : L.edgesH[ehiOf(L.w, at.x, at.z)]);

/** A body with no archetype is staff or you; one with an archetype is a shopper. */
const walker = (x, z) => ({ x, z });
const shopper = (x, z) => ({ x, z, archetype_id: 'anybody' });

const routes = (g, ent, goal) => g.pathTo(ent, goal);

// ---------------------------------------------------------------------------
// 0. The vocabulary itself. Cheap, and it is the half that would rot in silence:
//    every set below is derived from one table, so a row added to `WAYS` with the
//    wrong `base` is a doorway that stops being a room or a gate that starts
//    being one, and nothing in the game says a word about it.
// ---------------------------------------------------------------------------
{
  for (const [kind, w] of WAYS) {
    check(!SOLID.has(kind), `a ${w.base} with rule "${w.rule}" is never solid`);
    eq(ENCLOSING.has(kind), w.base === 'door',
      `a ${w.base} with rule "${w.rule}" encloses iff it is a doorway`);
    eq(RULED.has(kind), w.rule !== 'all', `"${w.rule}" is ruled iff it is not "all"`);
    eq(wayKind(w.base, w.rule), kind, `${w.base}/${w.rule} resolves back to itself`);
  }
  // No one-way gate, and that is a decision rather than an omission: "in" is read
  // off the enclosure, a fence never encloses, so a one-way gate would be a
  // button that takes a press and changes no number.
  eq(wayKind('gate', 'in'), null, 'there is no one-way gate');
  eq(wayBase(E.WALL), null, 'a wall is not a way through');
  eq(wayRule(E.DOOR), 'all', 'and a plain doorway is for everybody');
}

// ---------------------------------------------------------------------------
// 1. A sign changes nothing about what the walls close in.
// ---------------------------------------------------------------------------
{
  const plain = pad(12, 12);
  ring(plain, 2, 2, 4, 4, E.WALL);
  plain.edgesH[ehiOf(plain.w, 3, 5)] = E.DOOR;

  const signed = pad(12, 12);
  ring(signed, 2, 2, 4, 4, E.WALL);
  signed.edgesH[ehiOf(signed.w, 3, 5)] = E.DOOR_STAFF;

  eq(enclosure(signed), enclosure(plain), 'a staff doorway encloses exactly as a doorway does');

  const oneWay = pad(12, 12);
  ring(oneWay, 2, 2, 4, 4, E.WALL);
  oneWay.edgesH[ehiOf(oneWay.w, 3, 5)] = E.DOOR_IN;
  eq(enclosure(oneWay), enclosure(plain), 'and so does an entrance-only one');

  const fenced = pad(12, 12);
  ring(fenced, 2, 2, 6, 6, E.FENCE);
  fenced.edgesH[ehiOf(fenced.w, 4, 7)] = E.GATE;
  const fencedStaff = pad(12, 12);
  ring(fencedStaff, 2, 2, 6, 6, E.FENCE);
  fencedStaff.edgesH[ehiOf(fencedStaff.w, 4, 7)] = E.GATE_STAFF;
  eq(enclosure(fencedStaff), enclosure(fenced), 'a staff gate encloses exactly as a gate does');
  check(!enclosure(fencedStaff).includes('1'), 'which is to say: not at all');
}

// ---------------------------------------------------------------------------
// 2. One edge, two answers. The claim the whole feature is.
// ---------------------------------------------------------------------------
{
  const L = settle((() => {
    const p = pad(12, 12);
    ring(p, 2, 2, 4, 4, E.WALL);
    p.edgesH[ehiOf(p.w, 3, 5)] = E.DOOR_STAFF;
    return p;
  })());
  // (3,4) is the inside cell at the doorway; (3,5) is the step outside it.
  check(!SOLID.has(edgeBetween(L, 3, 5, 3, 4)), 'a staff doorway is not a wall');
  check(!shopperCanCross(L, 3, 5, 3, 4), 'and a shopper may not come in through it');
  check(!shopperCanCross(L, 3, 4, 3, 5), 'nor go out through it');

  const open = settle((() => {
    const p = pad(12, 12);
    ring(p, 2, 2, 4, 4, E.WALL);
    p.edgesH[ehiOf(p.w, 3, 5)] = E.DOOR;
    return p;
  })());
  check(shopperCanCross(open, 3, 5, 3, 4), 'where a plain one lets them in');
}

// ---------------------------------------------------------------------------
// 3. A one-way door, and the direction it reads off the enclosure.
// ---------------------------------------------------------------------------
{
  const build = (kind) => settle((() => {
    const p = pad(12, 12);
    ring(p, 2, 2, 4, 4, E.WALL);
    p.edgesH[ehiOf(p.w, 3, 5)] = kind;
    return p;
  })());

  const entrance = build(E.DOOR_IN);
  check(shopperCanCross(entrance, 3, 5, 3, 4), 'an entrance lets a shopper in');
  check(!shopperCanCross(entrance, 3, 4, 3, 5), 'and never out');

  const exit = build(E.DOOR_OUT);
  check(!shopperCanCross(exit, 3, 5, 3, 4), 'an exit refuses a shopper coming in');
  check(shopperCanCross(exit, 3, 4, 3, 5), 'and lets them out');

  // Both sides indoors: no in, no out, nothing to be one-way about. Two rooms
  // side by side, joined by an entrance-only door — which the menu will not offer
  // and the sim must not invent a direction for.
  const inner = pad(14, 10);
  ring(inner, 2, 2, 10, 6, E.WALL);
  for (let z = 2; z <= 6; z++) inner.edgesV[eviOf(inner.w, 7, z)] = E.WALL;
  inner.edgesV[eviOf(inner.w, 7, 4)] = E.DOOR_IN;
  settle(inner);
  eq(inner.indoor[4 * inner.w + 6], 1, 'the west room is indoors');
  eq(inner.indoor[4 * inner.w + 7], 1, 'and so is the east one');
  check(shopperCanCross(inner, 6, 4, 7, 4), 'a one-way rule between two rooms lets them through');
  check(shopperCanCross(inner, 7, 4, 6, 4), 'in both directions');

  // Take the shell out and there is no inside anywhere — the all-or-nothing state
  // `growLane` was caught by. A rule that applied *nowhere* is right here: refusing
  // instead would seal every signed door in the world the day a wall came down.
  const roofless = settle((() => {
    const p = pad(12, 12);
    p.edgesH[ehiOf(p.w, 3, 5)] = E.DOOR_OUT;
    return p;
  })());
  check(!roofless.indoor.includes(1), 'a shop with no walls has no inside');
  check(shopperCanCross(roofless, 3, 5, 3, 4), 'so a one-way door there stops nobody');
  check(shopperCanCross(roofless, 3, 4, 3, 5), 'in either direction');
}

// ---------------------------------------------------------------------------
// 4. A queue never grows through a way with a rule on it.
//
// Two rooms, both indoors, joined by one interior door. A lane from a till
// beside that door grows *east through it* while it is plain, and must never put
// a place beyond it once it is signed — it should curl inside the room it is in
// instead, which is what a queue does when it meets a wall.
// ---------------------------------------------------------------------------
{
  const twoRooms = (kind) => {
    const p = pad(14, 10);
    ring(p, 2, 2, 10, 6, E.WALL);
    for (let z = 2; z <= 6; z++) p.edgesV[eviOf(p.w, 7, z)] = E.WALL;
    p.edgesV[eviOf(p.w, 7, 4)] = kind;
    return settle(p);
  };
  const beyond = (tiles) => tiles.filter((t) => t.x >= 7).length;

  const openLane = queueLane(twoRooms(E.DOOR), { x: 6, z: 4 }, { x: 1, z: 0 });
  check(beyond(openLane) > 0, 'a line will file through a plain interior door',
    `${beyond(openLane)} places past it`);

  for (const kind of [E.DOOR_STAFF, E.DOOR_IN, E.DOOR_OUT]) {
    const lane = queueLane(twoRooms(kind), { x: 6, z: 4 }, { x: 1, z: 0 });
    eq(beyond(lane), 0, `no place in the line is beyond a ${wayRule(kind)} door`);
    check(lane.length > 1, 'and the line still forms — it bends rather than stopping',
      `${lane.length} places`);
  }
}

// ---------------------------------------------------------------------------
// 5. The real shop: staff walk through, shoppers go round.
//
// The generated shell has a service door in the back wall as well as the front
// one, which is what makes this measurable: sign the front, and a shopper's route
// in should get *longer* rather than disappear.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const L = g.layout;
  const inside = { x: L.door.x, z: L.door.z - 1 };
  const from = L.spawn;

  const before = findPath(g.walk, L, from, inside, { shopper: true });
  check(before !== null, 'a shopper can walk in through the front door');

  for (const at of frontDoor(g)) {
    const res = g.buildEdge('me', { ...at, kind: E.DOOR_STAFF });
    check(res.ok, 'the front door can be made staff-only', res.error ?? '');
  }
  for (const at of frontDoor(g)) {
    eq(kindAt(g.layout, at), E.DOOR_STAFF, 'and it stays that way through the re-flow');
  }

  const staffWay = findPath(g.walk, g.layout, from, inside, { shopper: false });
  check(staffWay !== null, 'staff still come in that way');
  eq(staffWay.length, before.length, 'by exactly the route they always took');

  const round = findPath(g.walk, g.layout, from, inside, { shopper: true });
  check(round !== null, 'a shopper still gets in — round the back, through the service door');
  check(round.length > before.length, 'the long way, which is the whole point',
    `${round?.length} steps against ${before.length}`);

  // ...and you are not a shopper in your own shop. `canWalk` is the player's own
  // test and stays `SOLID`, which is what stops a signed door locking you out of
  // the room you signed it on.
  const d = frontDoor(g)[0];
  check(g.canWalk(d.x, d.z, d.x, d.z - 1), 'and you walk through it like anybody who works here');

  // Sign the back one too and there is no way in at all — which is a warning
  // rather than a refusal, exactly as bricking it up would be.
  const sealing = canPlaceEdges(g.layout, backDoor(g), E.DOOR_STAFF);
  check(sealing.ok, 'signing the last way in is allowed');
  check(/seals the shop/.test(sealing.warn ?? ''), 'and says what it costs you',
    sealing.warn ?? 'nothing');

  // The same claim about the direction, which is the one the old flood could not
  // see at all: an entrance-only front door with the back one shut is a shop
  // nobody can leave, and an exit-only one is a shop nobody can enter.
  const g2 = fresh();
  for (const at of backDoor(g2)) g2.buildEdge('me', { ...at, kind: E.WALL });
  const outOnly = canPlaceEdges(g2.layout, frontDoor(g2), E.DOOR_OUT);
  check(outOnly.ok, 'making your only door exit-only is allowed');
  check(/seals the shop/.test(outOnly.warn ?? ''), 'and warns that nobody can get in',
    outOnly.warn ?? 'nothing');
  const inOnly = canPlaceEdges(g2.layout, frontDoor(g2), E.DOOR_IN);
  check(inOnly.ok, 'entrance-only is allowed too');
  check(!/seals the shop/.test(inOnly.warn ?? ''), 'and does not warn — they can still come in',
    inOnly.warn ?? 'nothing');
}

// ---------------------------------------------------------------------------
// 6. A stockroom is a room you MEANT to cut off, and the second flood must not
//    start reporting it. This is the trap in the warnings, and it fires on a
//    wall drawn somewhere else entirely.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const L = g.layout;
  const ax = L.store.x + L.store.w;
  const az = L.store.z + 1;
  check(ax + 2 < L.w - 1, 'there is room east of the building for a stockroom');

  for (let z = az; z < az + 2; z++) g.buildEdge('me', { o: 'v', x: ax + 2, z, kind: E.WALL });
  g.buildEdge('me', { o: 'h', x: ax, z: az, kind: E.WALL, to: ax + 1 });
  g.buildEdge('me', { o: 'h', x: ax, z: az + 2, kind: E.WALL, to: ax + 1 });
  g.buildEdge('me', { o: 'v', x: ax, z: az, kind: E.DOOR });
  const laid = g.buildGround('me', {
    x: ax, z: az, piece: TEST_FLOOR.id, to: { x: ax + 1, z: az + 1 },
  });
  check(laid.ok, 'the stockroom can be floored', laid.error ?? '');
  const shelf = g.placeFixture('me', { kind: 'shelf', x: ax + 1, z: az, rot: 2 });
  check(shelf.ok, 'and a shelf goes in it', shelf.error ?? '');

  // The claim is a NEGATIVE and it is a comparison: the fixture flood must give
  // the same answer either side of the sign. Asserted against the plain doorway's
  // own verdict rather than against "no warning", because what that flood says
  // about a small annex is its own business — a two-cell room's shelf has ends
  // out in the weather, and this sweep is not the place to relitigate that. What
  // matters is that signing the door does not MOVE it.
  const doorLine = { o: 'v', x: ax, z: az };
  const asPlain = canPlaceEdges(g.layout, [doorLine], E.DOOR);
  const asStaff = canPlaceEdges(g.layout, [doorLine], E.DOOR_STAFF);
  eq(asStaff.warn ?? null, asPlain.warn ?? null,
    'signing a stockroom door warns exactly what re-drawing it plainly would');

  const sign = g.buildEdge('me', { ...doorLine, kind: E.DOOR_STAFF });
  check(sign.ok, 'its door can be made staff-only', sign.error ?? '');

  // The shelf is now genuinely unreachable by any shopper, on purpose. Every wall
  // drawn from here on has to say the same thing it said before — a warning that
  // fires because of something you did last week is one nobody reads.
  const elsewhere = { o: 'h', x: L.store.x + 1, z: L.store.z + 2, kind: E.WALL };
  const after = canPlaceEdge(g.layout, elsewhere);
  g.buildEdge('me', { ...doorLine, kind: E.DOOR });
  const beforeSign = canPlaceEdge(g.layout, elsewhere);
  eq(after.warn ?? null, beforeSign.warn ?? null,
    'and a wall drawn afterwards warns the same with the sign up as with it down');
  g.buildEdge('me', { ...doorLine, kind: E.DOOR_STAFF });

  // A hire can still get in, which is the break-room claim in its general form.
  const staff = walker(L.door.x, L.door.z - 1);
  check(routes(g, staff, { x: ax + 1, z: az + 1 }), 'staff walk into the stockroom');
  check(!routes(g, shopper(L.door.x, L.door.z - 1), { x: ax + 1, z: az + 1 }),
    'and a shopper standing in the same spot cannot');
}

// ---------------------------------------------------------------------------
// 7. A break room behind a staff door is still a break room.
//
// `seatIn` asks `findPath`, so this is the `TIRED_PACE` pin verify:break exists
// to catch, arriving through a door rather than through a wall.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const L = g.layout;
  const ax = L.store.x + L.store.w;
  const az = L.store.z + 1;
  for (let z = az; z < az + 2; z++) g.buildEdge('me', { o: 'v', x: ax + 2, z, kind: E.WALL });
  g.buildEdge('me', { o: 'h', x: ax, z: az, kind: E.WALL, to: ax + 1 });
  g.buildEdge('me', { o: 'h', x: ax, z: az + 2, kind: E.WALL, to: ax + 1 });
  g.buildEdge('me', { o: 'v', x: ax, z: az, kind: E.DOOR_STAFF });

  const seat = { x: ax + 1, z: az + 1 };
  check(routes(g, walker(L.door.x, L.door.z - 1), seat),
    'a hire can reach a room behind a staff door');
  check(g.layout.indoor[seat.z * g.layout.w + seat.x] === 1,
    'and it is a room — the staff doorway closed it in');
}

// ---------------------------------------------------------------------------
// 8. Fitting the sign is free, and so is changing your mind.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const at = frontDoor(g)[0];
  const start = g.cash;

  const on = g.buildEdge('me', { ...at, kind: E.DOOR_STAFF });
  check(on.ok, 'a doorway takes a sign', on.error ?? '');
  eq(g.cash, start, 'and it costs nothing — you already own the door');

  const back = g.buildEdge('me', { ...at, kind: E.DOOR });
  check(back.ok, 'the sign comes off again', back.error ?? '');
  eq(g.cash, start, 'and changing your mind costs nothing either');
  eq(kindAt(g.layout, at), E.DOOR, 'leaving an ordinary doorway');

  // A refit is within a family and nowhere else. Bricking a doorway up is still
  // a swap: the wall is charged for and half the doorway comes back, which on
  // these prices happens to leave you a few dollars up — the point is that money
  // MOVES, where a refit is the one edit that never charges and never pays.
  const wall = g.buildEdge('me', { ...at, kind: E.WALL });
  check(wall.ok, 'a doorway can still be bricked up', wall.error ?? '');
  check(g.cash !== start, 'and that is a swap, not a refit — money moves',
    `${g.cash} vs ${start}`);
  eq(g.buildEdge('me', { ...at, kind: E.WALL }).unchanged, true,
    'while drawing what is already there does nothing at all');
}

// ---------------------------------------------------------------------------

console.log(`\nverify:doors — ${checks} assertions`);
if (failures.length) {
  console.error(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✅  a signed way through is the same wall, and only shoppers can read the sign.\n');
