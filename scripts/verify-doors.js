#!/usr/bin/env node
/**
 * VERIFY: A WAY THROUGH KNOWS WHO IT IS FOR, AND A WINDOW IS ONLY A LOOK.
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
 * And the other family on the same machinery, the glazings, whose claims are
 * cheaper but include the worst bug in this file if it ever breaks:
 *
 * - **A glazing missing from `SOLID` is a window you can walk through**, in a shop
 *   that looks completely normal. You would have to try to walk into your own
 *   shopfront to find it, which is why every one of those kinds is derived from
 *   one table and asserted against it rather than listed.
 *
 * - **Four glazings are the same wall.** Same enclosure to the byte, same price,
 *   and swapping between them free — because a look must never move a number, or
 *   choosing a shopfront is a balance change. A re-flow leaves it alone too, or
 *   buying a shelf reglazes your shop.
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
  E, SOLID, ENCLOSING, RULED, WAYS, WAY_RULES, WAY_LOOKS, GLAZING, GLAZING_LOOKS,
  computeIndoor, edgeBetween, eviOf, ehiOf, canStep, shopperCanCross,
  wayBase, wayRule, wayLook, wayKind,
  wayDefault, glazingKind, glazingLook, edgeFamily,
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
    // Against the row's own `roofs` and not against `base === 'door'`, which is
    // what this line said until there was a third family. That version was not
    // merely narrow — it was the assertion and the implementation being the same
    // sentence twice, so it could only ever have caught a typo. A curtain roofs
    // and a gate does not, and no word in either name says so.
    eq(ENCLOSING.has(kind), !!w.roofs,
      `a ${w.base} with rule "${w.rule}" encloses iff its row says it roofs`);
    eq(RULED.has(kind), w.rule !== 'all', `"${w.rule}" is ruled iff it is not "all"`);
    // Both axes, or the round trip stops being an identity the moment a base
    // has two looks: `wayKind` walks the table in order, so asked for the rule
    // alone it would answer the FIRST row matching it and every shopfront door
    // would resolve back as a fanlight. Which is the bug this line exists to
    // catch, so it has to be asked with everything the row carries.
    eq(wayKind(w.base, w.rule, w.look ?? null), kind,
      `${w.base}/${w.rule}${w.look ? `/${w.look}` : ''} resolves back to itself`);
  }
  // ...and the second axis in its own right — every look of every base is
  // reachable, and no two of them are the same kind. A look that resolved to
  // its neighbour is a palette button that lays the wrong piece, which is
  // invisible until you look closely at a wall you have just built.
  for (const [base, looks] of Object.entries(WAY_LOOKS)) {
    const seen = new Set();
    for (const look of looks) {
      for (const rule of WAY_RULES[base] ?? []) {
        const kind = wayKind(base, rule, look);
        check(kind !== null, `${base}/${rule}/${look} exists`);
        check(!seen.has(kind), `${base}/${rule}/${look} is its own kind`);
        seen.add(kind);
        eq(wayLook(kind), look, `...and it knows which look it is`);
        eq(wayRule(kind), rule, `...and which rule`);
      }
    }
    eq(seen.size, looks.length * (WAY_RULES[base] ?? []).length,
      `${base} has one kind per rule per look and no two share`);
  }
  // No one-way gate, and that is a decision rather than an omission: "in" is read
  // off the enclosure, a fence never encloses, so a one-way gate would be a
  // button that takes a press and changes no number.
  eq(wayKind('gate', 'in'), null, 'there is no one-way gate');
  eq(wayKind('curtain', 'in'), null, 'and no one-way curtain either');
  eq(wayBase(E.WALL), null, 'a wall is not a way through');
  eq(wayRule(E.DOOR), 'all', 'and a plain doorway is for everybody');

  // Which kind the palette lays, and it is the one thing in this table that is
  // an ORDER rather than a membership — `WAY_RULES` is a menu order everywhere
  // else, and its head is what the tool builds. A doorway is for everybody until
  // you say otherwise, so staff-only is something you find; a curtain is bought
  // *because* shoppers cannot use it, so one that arrived open would be a tool
  // that does the opposite of its own label until you tapped every segment of
  // the run you had just dragged. Both halves asserted, because "the head of the
  // list" is only a decision if the two families disagree about it.
  eq(wayDefault('curtain'), E.CURTAIN_STAFF, 'the curtain tool lays the signed one');
  eq(wayDefault('door'), E.DOOR, '...where the doorway tool lays the open one');
  eq(wayDefault('gate'), E.GATE, '...and so does the gate');
  // The curtain's argument pointed the other way, and it is a decision for the
  // same reason: a roller door is the front of a workshop as often as it is the
  // back of a stockroom, so it arrives open and you sign it after it is up.
  eq(wayDefault('shutter'), E.SHUTTER, '...and so does the roller door');
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

  // A curtain is the one opening that goes in an INTERIOR wall by design — you
  // hang it across an aisle to cut the back off the shop — and that is precisely
  // where getting `roofs` wrong hides. Enclosure is all-or-nothing, so a curtain
  // that did not roof would not make a slightly smaller shop, it would take the
  // roof off the whole building: every shelf refused, the refusal reading
  // "something is already there", and the cause four rooms away from the symptom.
  // Byte-for-byte against the wall it replaced, not merely "still has an inside".
  const curtained = pad(12, 12);
  ring(curtained, 2, 2, 4, 4, E.WALL);
  curtained.edgesH[ehiOf(curtained.w, 3, 5)] = E.DOOR;
  const walled = enclosure(curtained);
  curtained.edgesV[eviOf(curtained.w, 4, 3)] = E.CURTAIN_STAFF;
  eq(enclosure(curtained), walled, 'a curtain across the middle of a room roofs it exactly as the wall did');

  const front = pad(12, 12);
  ring(front, 2, 2, 4, 4, E.WALL);
  front.edgesH[ehiOf(front.w, 3, 5)] = E.CURTAIN_STAFF;
  eq(enclosure(front), walled, '...and so does one hung where the doorway was');
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

  // The same two answers out of a curtain, and the reason it is asked again
  // rather than inherited from the loop in section 0 is that a curtain is the
  // first opening whose default is the signed kind: the sweep that matters is
  // the one a player gets by dragging the tool, and for every other family that
  // is the permissive row. Asked on an INTERIOR line, which is where curtains
  // go and which is also the case a one-way rule falls through — so this is
  // `rule === 'staff'` answering rather than the enclosure answering for it.
  const inner = settle((() => {
    const p = pad(12, 12);
    ring(p, 2, 2, 6, 6, E.WALL);
    p.edgesH[ehiOf(p.w, 3, 7)] = E.DOOR;
    p.edgesV[eviOf(p.w, 5, 4)] = wayDefault('curtain');
    return p;
  })());
  eq(inner.indoor[4 * inner.w + 4], 1, 'both sides of the curtain are indoors');
  eq(inner.indoor[4 * inner.w + 5], 1, '...which is what makes it a partition rather than a door');
  check(!SOLID.has(edgeBetween(inner, 4, 4, 5, 4)), 'a curtain is not a wall');
  check(canStep(inner, 4, 4, 5, 4), 'so a hire pushes through it');
  check(canStep(inner, 5, 4, 4, 4), '...and back');
  check(!shopperCanCross(inner, 4, 4, 5, 4), 'and a shopper does not');
  check(!shopperCanCross(inner, 5, 4, 4, 4), '...from either side, one way being no answer here');

  const openCurtain = settle((() => {
    const p = pad(12, 12);
    ring(p, 2, 2, 6, 6, E.WALL);
    p.edgesH[ehiOf(p.w, 3, 7)] = E.DOOR;
    p.edgesV[eviOf(p.w, 5, 4)] = E.CURTAIN;
    return p;
  })());
  check(shopperCanCross(openCurtain, 4, 4, 5, 4), 'where one you opened up lets them through');
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
// 9. A window is a LOOK, and four of them are the same wall.
//
// `GLAZING`'s claims are cheaper than the openings' and one of them is the worst
// bug in this whole file if it ever breaks: a glazing missing from `SOLID` is a
// window you can walk through, in a shop that looks completely normal. It cannot
// be caught by eye — you would have to try to walk into your own shopfront — and
// every one of these kinds is derived from one table for exactly that reason.
// ---------------------------------------------------------------------------
{
  for (const [kind, g] of GLAZING) {
    check(SOLID.has(kind), `a ${g.look} window is a wall you cannot walk through`);
    check(ENCLOSING.has(kind), `and it encloses, so a room glazed with it is a room`);
    eq(edgeFamily(kind), 'window', `${g.look} is in the window family`);
    eq(glazingKind(g.look), kind, `${g.look} resolves back to itself`);
  }
  eq(glazingLook(E.WINDOW), 'standard', 'the window that was always here is the plain one');
  eq(GLAZING_LOOKS.length, GLAZING.size, 'every glazing is offered by the menu');

  // Every glazing encloses identically — the claim a shopfront has to keep, since
  // a wall of glass along the front of the shop is still the front of the shop.
  const glazed = (kind) => {
    const p = pad(12, 12);
    ring(p, 2, 2, 4, 4, E.WALL);
    p.edgesH[ehiOf(p.w, 3, 5)] = kind;
    return enclosure(p);
  };
  const plain = glazed(E.WINDOW);
  for (const [kind, g] of GLAZING) {
    eq(glazed(kind), plain, `a ${g.look} window encloses exactly as the plain one does`);
  }

  // ...and nobody walks through any of them, shopper or staff.
  const L = settle((() => {
    const p = pad(12, 12);
    ring(p, 2, 2, 4, 4, E.WALL);
    p.edgesH[ehiOf(p.w, 3, 5)] = E.WINDOW_FULL;
    return p;
  })());
  check(!shopperCanCross(L, 3, 5, 3, 4), 'a shopper does not walk in through a shopfront');
  check(SOLID.has(edgeBetween(L, 3, 5, 3, 4)), 'and neither does anybody else');
}

// ---------------------------------------------------------------------------
// 10. Reglazing is a refit: it charges nothing, either way, and you keep the wall.
//
// The same claim the sign makes, and it matters more here, because this is the
// one the player will do repeatedly — trying the four looks along a frontage is
// how you choose one. Priced as a swap it would cost half a window a press.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const L = g.layout;
  const at = { o: 'h', x: L.store.x + 2, z: L.store.z };
  const built = g.buildEdge('me', { ...at, kind: E.WINDOW });
  check(built.ok, 'a window goes into the back wall', built.error ?? '');
  const start = g.cash;

  for (const look of GLAZING_LOOKS) {
    const kind = glazingKind(look);
    const res = g.buildEdge('me', { ...at, kind });
    check(res.ok, `it can be reglazed as ${look}`, res.error ?? '');
    eq(kindAt(g.layout, at), kind, `and the line really is ${look} now`);
    eq(g.cash, start, `which costs nothing — ${look} is a look, not a purchase`);
  }

  // Round the four and back to where it started: still the same money, and still
  // a window rather than a hole.
  g.buildEdge('me', { ...at, kind: E.WINDOW });
  eq(g.cash, start, 'a full circuit of the glazings is free');
  eq(kindAt(g.layout, at), E.WINDOW, 'and leaves the window it began as');

  // A re-flow must leave it alone, or buying a shelf reglazes your shop — the trap
  // the yard pads were built out of.
  g.buildEdge('me', { ...at, kind: E.WINDOW_BAY });
  g.placeFixture('me', { kind: 'shelf', x: L.store.x + 4, z: L.store.z + 2, rot: 0 });
  eq(kindAt(g.layout, at), E.WINDOW_BAY, 'and buying a shelf does not reglaze it');
}

// ---------------------------------------------------------------------------
// 11. THE GLAZED DOORWAY, which is the first edge in the game with a rule AND a
// look — and the whole of what that costs is that the two axes must not touch
// each other.
//
// Everything else here is derived and provable by reading a table. This is not:
// pressing Shopfront on a staff entrance has to leave a staff entrance, and
// there is nothing on screen that would say it had not. A glazed door thrown
// open to the town looks exactly like a glazed door — the sign is a stripe on a
// threshold read edge-on — so the failure arrives days later as shoppers in the
// stockroom, pointing at the pathing.
//
// The money is the other half, and it is docs/building.md §21's test made real
// rather than asserted against a constant: a look inside the family is free
// (else trying both along a frontage costs half a door a press), and the family
// itself is a purchase (else a doorway grows glass for nothing).
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const L = g.layout;
  const at = { o: 'h', x: L.store.x + 3, z: L.store.z };
  const built = g.buildEdge('me', { ...at, kind: E.DOOR_TRANSOM_STAFF });
  check(built.ok, 'a glazed staff doorway goes into the back wall', built.error ?? '');
  const start = g.cash;

  // The look moves and the rule does not.
  const swap = g.buildEdge('me', { ...at, kind: wayKind('glazed', 'staff', 'shopfront') });
  check(swap.ok, 'it can be restyled as a shopfront door', swap.error ?? '');
  eq(wayLook(kindAt(g.layout, at)), 'shopfront', 'and it really is one now');
  eq(wayRule(kindAt(g.layout, at)), 'staff', 'and it is STILL staff-only');
  eq(g.cash, start, 'which costs nothing — a look is a look');

  // ...and the rule moves and the look does not, which is the same claim the
  // other way round and fails independently: one function reads both axes off
  // the kind in front of it, and it can drop either one.
  const sign = g.buildEdge('me', { ...at, kind: wayKind('glazed', 'all', 'shopfront') });
  check(sign.ok, 'it can be thrown open to everybody', sign.error ?? '');
  eq(wayRule(kindAt(g.layout, at)), 'all', 'and the sign really has gone');
  eq(wayLook(kindAt(g.layout, at)), 'shopfront', 'and it is STILL a shopfront door');
  eq(g.cash, start, 'and signing one is free, exactly as a doorway is');

  // A plain doorway is a different family, so this one is a purchase — which is
  // the line that keeps the look axis honest. Fold the two families together
  // and glass over your door becomes free.
  check(edgeFamily(E.DOOR) !== edgeFamily(E.DOOR_TRANSOM),
    'a doorway and a glazed one are different families');
  const plain = g.buildEdge('me', { ...at, kind: E.DOOR });
  check(plain.ok, 'and it can be swapped for a plain doorway', plain.error ?? '');
  check(g.cash !== start, 'but that is a swap, not a refit — money moves');

  // It encloses like the doorway it is. Left out of `ENCLOSING` this would take
  // the roof off whatever room it stands in, every shelf inside would be
  // refused, and the refusal reads "something is already there".
  g.buildEdge('me', { ...at, kind: E.DOOR_SHOPFRONT });
  const indoor = computeIndoor(g.layout);
  check(indoor[(L.store.z + 1) * L.w + (L.store.x + 3)] === 1,
    'and a shop with one in its wall is still a shop');
}

// ---------------------------------------------------------------------------

console.log(`\nverify:doors — ${checks} assertions`);
if (failures.length) {
  console.error(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✅  a signed way through is the same wall, four glazings are the same window,'
  + '\n      and only shoppers can read the sign.\n');
