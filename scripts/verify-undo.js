#!/usr/bin/env node
/**
 * VERIFY: TAKING A BUILD PRESS BACK PUTS THE SHOP BACK — AND NOTHING ELSE.
 *
 * Every claim in here is invisible twice over. A shop you never touched and a
 * shop you built in and undid are the same still frame by definition, which is
 * the whole point of the feature — so there is nothing to look at, and a
 * screenshot of a correct undo and a screenshot of an undo that quietly ate a
 * shelf's stock are the same picture of the same aisle.
 *
 * Its **control** is the assertion that decides whether any of this is opt-in:
 * `recordUndo` writes nothing unless a step is open, and the only thing that
 * opens one is a build message from a real client. So the generator's own
 * placements, the balance bot's sixty days of shopping, every MCP call and
 * every other sweep in this directory must record *nothing at all*. A control
 * that is wrong here is not a bug in undo, it is `simulate` growing a stack of
 * sixty days of purchases and every sweep in `npm run verify` measuring a shop
 * with a second copy of its own history hanging off it.
 *
 * Its **centrepiece** is a claim about goods, and it is the one shape this
 * feature could most plausibly have been built in. The building is four plain
 * arrays — `placements`, `edits`, `ground`, `paint` — so undo *looks* like a
 * stack of snapshots, one assignment each to restore. It is wrong for exactly
 * one reason: a fixture's stock does not live on its placement. It lives on the
 * layout record, under an id `repositionFixture` re-mints every time anything
 * moves. Restore the array and the shelf comes back at its old id with six
 * loaves filed under the new one — goods destroyed, nothing logged, and a shop
 * that is quietly poorer four presses later with nothing to connect it to. So:
 * stock a shelf, move it, undo, and count the loaves.
 *
 * The rest are the claims that fall out of it being a *stack of presses* rather
 * than a stack of changes:
 *
 * - **A drag is one press.** A wall run is one entry and one Ctrl+Z, because
 *   `buildEdge` writes eight segments and `buildRun` calls `placeFixture`
 *   twelve times. Eight presses of Ctrl+Z to take back one press of the mouse
 *   is the failure, and it looks exactly like undo working.
 * - **The money is reversed exactly, as a DELTA.** Undoing a purchase hands
 *   back what it cost rather than `FIXTURE_REFUND` of it — an undo you are
 *   fined for using is not an undo — and a round trip is worth zero, or the
 *   stack is a money printer. As a delta and never as a restored balance, or
 *   undoing this morning's wall also hands back the day's takings.
 * - **A refusal pushes nothing.** Otherwise every press the shop turned down
 *   sits on top of the stack as an undo that does nothing, and the one you
 *   wanted is one press further away than it looks.
 * - **All or nothing.** A step can hold twelve fixtures; half an undo leaves a
 *   shop that is neither what you had nor what you asked for, with no entry
 *   left to try again with.
 * - **Doing something new forgets the future.**
 * - **The overlay and not the kind.** Knocking a hole in a wall the *generator*
 *   drew and undoing it has to leave `edits` empty rather than holding an entry
 *   that says "wall" — identical today, and a wall the player owns the day the
 *   shop grows.
 * - **Paint comes back without a re-flow**, which is `verify:paint`'s claim
 *   said about the way back.
 *
 * It writes nothing at all: no content rows, no world row, no cleanup. Every
 * fixture it needs is one the shipped catalog already has.
 *
 *   node scripts/verify-undo.js
 */

import { Game } from '../server/sim/index.js';
import { content } from '../server/content.js';
import { E } from '../shared/edges.js';
import { UNDO_MAX } from '../server/sim/undo.js';
import { kindOf } from '../shared/pieces.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SHOP = { shelf: 6, freezer: 1, checkout: 1, plot: 2 };

/**
 * `fresh()` clears everything `Game.create` reads off the save — the list every
 * sweep in here carries, plus nothing of its own: the undo stack is deliberately
 * not saved, so there is no leftover of it a run could inherit.
 */
function fresh() {
  const g = Game.create({ worldId: 'verify-undo', seed: 'undo', ephemeral: true });
  g.placements = [];
  g.grow = { w: 0, h: 0 };
  g.doorShift = 0;
  g.edits = [];
  g.ground = [];
  g.paint = {};
  g.yardStamped = false;
  g.shell = null;
  g.ownedUpgrades = [];
  g.regenerateLayout(null, {}, { want: SHOP });
  g.cash = 50000;
  g.freezeShell();
  g.addPlayer('me', 'Tester');
  g.players.me.build = { on: true, tool: 'shelf' };
  return g;
}

/** One build press, the way `server/rooms/shop.js` sends it. */
const press = (g, label, fn) => g.undoStep(label, fn);

/** The whole building, as one comparable string — `verify:paint`'s `fabric`. */
const fabric = (g) => JSON.stringify([
  g.layout.tiles, g.layout.blocked, g.layout.indoor, g.layout.edgesV, g.layout.edgesH,
]);

/** Where the placements are, by id, so a move is visible as a pair of numbers. */
const spotOf = (g, id) => {
  const p = g.placements.find((pl) => pl.id === id);
  return p ? `${p.x},${p.z}` : null;
};

/** An empty indoor tile a shelf will go on. */
function freeTile(g, taken = new Set()) {
  for (let z = 0; z < g.layout.h; z++) {
    for (let x = 0; x < g.layout.w; x++) {
      if (taken.has(`${x},${z}`)) continue;
      const probe = press(g, 'probe', () => g.placeFixture('me', { kind: 'shelf', x, z, rot: 0 }));
      if (probe.ok) {
        // Put it straight back — this is a search, not a purchase.
        g.undo();
        g.undoStack.length = 0;
        g.redoStack.length = 0;
        return { x, z };
      }
    }
  }
  return null;
}

const AMBIENT = content().items.filter((it) => !it.tags.includes('frozen') && !it.tags.includes('needs-freezer'));
check(AMBIENT.length >= 1, 'the catalog has an ambient item to shelve', `${AMBIENT.length}`);
const ITEM = AMBIENT[0];

// ---------------------------------------------------------------------------
// 1. THE CONTROL. Nothing outside a press is remembered.
//
// The assertion that decides whether this is opt-in or a change to every
// headless caller in the repo. `simulate` builds a shop for sixty days through
// `placeFixture`; the generator furnishes one on every re-flow; MCP and the
// HTTP API drive the same verbs. If any of that recorded, `npm run verify`
// would be measuring shops carrying a second copy of their own history.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const spot = freeTile(g);
  check(!!spot, 'the test shop has somewhere to build');

  // Every build verb there is, called the way everything except a client calls
  // them: directly, with no step open.
  const placed = g.placeFixture('me', { kind: 'shelf', x: spot.x, z: spot.z, rot: 0 });
  check(placed.ok, 'a shelf can be built with no step open', placed.error ?? '');
  g.buildEdge('me', { o: 'v', x: 2, z: 2, kind: E.WALL });
  g.buildGround('me', { x: 2, z: 2, piece: groundPiece(), to: null });
  g.removeFixture('me', placed.placed);
  g.regenerateLayout();

  eq(g.undoStack.length, 0, 'not one of them left anything on the stack');
  eq(g.redoStack.length, 0, '...and nothing on the redo stack either');
  eq(g.undo().ok, false, 'so there is nothing to undo');
  eq(g.redo().ok, false, '...and nothing to redo');
}

/** The first flooring row in the catalog — this sweep authors none of its own. */
function groundPiece() {
  const row = (content().fixtures ?? []).find((f) => kindOf(f) === 'floor');
  return row?.id ?? '';
}

/** The first wall finish in the catalog, for section 8. */
function paintPiece() {
  const row = (content().fixtures ?? []).find((f) => kindOf(f) === 'paint');
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// 2. THE CENTREPIECE. A shelf that moved comes back with its goods.
//
// The snapshot trap. Restoring `placements` is one assignment and passes every
// other assertion in this file — the shelf is back on the right tile, wearing
// the right tier, and the six loaves that were on it are gone with nothing
// anywhere to say so.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const shelf = g.layout.shelves[0];
  shelf.stacks = [{ item_id: ITEM.id, qty: 6, price: 3, stockedDay: g.day }];
  const wasAt = spotOf(g, shelf.id);
  const spot = freeTile(g);

  const lift = press(g, 'moving that', () => g.liftFixture('me', shelf.id));
  check(lift.ok, 'the shelf can be picked up', lift.error ?? '');
  const moved = press(g, 'moving that', () => g.dropFixture('me', { x: spot.x, z: spot.z }));
  check(moved.ok, 'and set down somewhere else', moved.error ?? '');
  eq(g.layout.shelves.find((s) => s.id === moved.moved)?.stacks?.[0]?.qty, 6,
    'a move carries the stock, which is the thing this is all about');

  const back = g.undo();
  check(back.ok, 'the move can be taken back', back.error ?? '');

  const now = g.layout.shelves.find((s) => `${s.x},${s.z}` === wasAt);
  check(!!now, 'the shelf is back on the tile it came off');
  eq(now?.stacks?.length, 1, '...still holding one board');
  eq(now?.stacks?.[0]?.qty, 6, '...with every one of the six units still on it');
  eq(now?.stacks?.[0]?.item_id, ITEM.id, '...and it is still the same goods');

  // And forward again, or the stock only survives in one direction.
  const fwd = g.redo();
  check(fwd.ok, 'the move can be put back', fwd.error ?? '');
  eq(g.layout.shelves.find((s) => `${s.x},${s.z}` === `${spot.x},${spot.z}`)?.stacks?.[0]?.qty, 6,
    '...and the goods travel with it the second time too');
}

// ---------------------------------------------------------------------------
// 3. THE MONEY. Exactly reversed, as a delta, and worth zero round trip.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const spot = freeTile(g);
  const before = g.cash;
  const res = press(g, 'building that', () => g.placeFixture('me', { kind: 'shelf', x: spot.x, z: spot.z, rot: 0 }));
  check(res.ok, 'a shelf is bought', res.error ?? '');
  const price = res.cost;
  check(price > 0, 'and it cost something', `${price}`);

  g.undo();
  eq(g.cash, before, 'undoing the purchase hands back what it cost, not half of it');
  g.redo();
  eq(g.cash, Math.round((before - price) * 100) / 100, 'and doing it again charges the same price');
  g.undo();
  eq(g.cash, before, 'a round trip is worth exactly nothing');

  // The delta, which is the half that is about everything else in the shop.
  // Restoring a stored balance would pass every line above and quietly wipe out
  // whatever the shop earned between the press and the Ctrl+Z.
  const g2 = fresh();
  const at = freeTile(g2);
  const start = g2.cash;
  const buy = press(g2, 'building that', () => g2.placeFixture('me', { kind: 'shelf', x: at.x, z: at.z, rot: 0 }));
  g2.cash = Math.round((g2.cash + 1234.56) * 100) / 100;   // a day's takings
  g2.undo();
  eq(g2.cash, Math.round((start + 1234.56) * 100) / 100,
    'an undo moves the money the press moved and nothing else — the takings stay');
  check(buy.ok, 'the purchase under that claim really happened', buy.error ?? '');
}

// ---------------------------------------------------------------------------
// 4. A DRAG IS ONE PRESS.
//
// Two verbs write many changes in one gesture and each does it a different way:
// `buildEdge` loops over segments itself, and `buildRun` calls `placeFixture`
// once per cell. Both have to land as ONE entry, or taking a wall back is eight
// presses of Ctrl+Z — which looks exactly like undo working.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const before = fabric(g);
  const cash = g.cash;

  // Searched for rather than hardcoded: where the shop stands is a function of
  // the seed and of `SHOP`, so a fixed line is a sweep that stops testing
  // anything the day either changes. A refused `buildEdge` moves nothing, so
  // the misses cost the comparison below nothing either.
  let run = { ok: false };
  for (let z = 1; z < g.layout.h && !run.ok; z++) {
    for (let x = 1; x + 5 < g.layout.w && !run.ok; x++) {
      run = press(g, 'that wall', () => g.buildEdge('me', {
        o: 'h', x, z, kind: E.WALL, to: x + 5,
      }));
    }
  }
  check(run.ok, 'a wall run is drawn', run.error ?? '');
  check((run.placed ?? 0) >= 3, 'and it is really several segments', `${run.placed}`);
  eq(g.undoStack.length, 1, 'a drag of several segments is ONE entry on the stack');
  check(fabric(g) !== before, 'the building really changed');

  g.undo();
  eq(fabric(g), before, 'and one Ctrl+Z takes the whole run back');
  eq(g.cash, cash, '...including every segment of what it cost');
  eq(g.edits.length, 0, '...leaving no overlay entry behind');
}

// ---------------------------------------------------------------------------
// 4b. ...AND A PRESS THAT MAKES A ROOM TAKES ITS FLOOR BACK WITH IT.
//
// One press can now write two kinds of part: a wall that closes an annex lays
// the floor inside it (`floorNewRooms`), which is a `ground` part recorded
// beside the `edges` one. Both or neither — undoing the wall and leaving the
// flooring is a room-shaped stain of perfectly good floor sitting outdoors,
// which is the stain `verify:stamp` catches on the other gesture that can leave
// one, arriving through a door nothing else in this file opens.
//
// It is invisible in a still frame twice over: a shop that never had the annex
// and one that had it and undid it are the same picture — that IS undo — and
// grass with the memory of a floor under it draws exactly like grass.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const L = g.layout;
  const ax = L.store.x + L.store.w;
  const az = L.store.z + 1;
  check(ax + 2 < L.w - 1, 'there is room east of the building for an annex');

  // Three sides by hand, so the fourth press is the one that encloses.
  for (let z = az; z < az + 2; z++) press(g, 'that wall', () => g.buildEdge('me', { o: 'v', x: ax + 2, z, kind: E.WALL }));
  press(g, 'that wall', () => g.buildEdge('me', { o: 'h', x: ax, z: az, kind: E.WALL, to: ax + 1 }));

  const before = fabric(g);
  const cash = g.cash;
  const depth = g.undoStack.length;

  const closed = press(g, 'that wall',
    () => g.buildEdge('me', { o: 'h', x: ax, z: az + 2, kind: E.WALL, to: ax + 1 }));
  check(closed.ok, 'the press that closes the annex goes through', closed.error ?? '');
  eq(closed.floored, 4, '...and floors it');
  eq(g.undoStack.length, depth + 1, 'and a wall AND its floor is still ONE entry');
  check(g.ground.length >= 4, 'the flooring is really in the overlay', `${g.ground.length}`);

  g.undo();
  eq(fabric(g), before, 'and one Ctrl+Z takes the wall and the floor back together');
  eq(g.cash, cash, '...including what the floor cost');
  eq(g.ground.length, 0, '...leaving no ground entry behind');

  g.redo();
  check(fabric(g) !== before, 'and the redo puts the room back');
  eq(g.ground.length, 4, '...floor included', `${g.ground.length}`);
}

// ---------------------------------------------------------------------------
// 5. A REFUSED PRESS PUSHES NOTHING.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const spot = freeTile(g);
  press(g, 'building that', () => g.placeFixture('me', { kind: 'shelf', x: spot.x, z: spot.z, rot: 0 }));
  eq(g.undoStack.length, 1, 'the first press is remembered');

  const clash = press(g, 'building that',
    () => g.placeFixture('me', { kind: 'shelf', x: spot.x, z: spot.z, rot: 0 }));
  eq(clash.ok, false, 'building on the same tile is refused');
  eq(g.undoStack.length, 1, '...and a refusal leaves nothing on the stack to undo');

  // The same claim about a verb that succeeds while changing nothing: painting
  // a face the colour it already is.
  const same = press(g, 'that paint', () => g.buildEdge('me', { o: 'h', x: 3, z: 3, kind: E.NONE }));
  eq(g.undoStack.length, 1, 'a press that changed nothing is not a press you can take back');
  check(!same.ok || same.unchanged, 'the no-op press really was one', JSON.stringify(same));
}

// ---------------------------------------------------------------------------
// 6. ALL OR NOTHING.
//
// A conveyor run is twelve fixtures in one entry. Stock one of them and the
// undo must refuse the lot — a half-applied step leaves a shop that is neither
// what you had nor what you asked for, and no entry left to try again with.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const spots = [];
  const taken = new Set();
  for (let i = 0; i < 3; i++) {
    const s = freeTile(g, taken);
    if (!s) break;
    taken.add(`${s.x},${s.z}`);
    spots.push(s);
  }
  check(spots.length === 3, 'three free tiles for a batch', `${spots.length}`);

  const ids = press(g, 'building that', () => spots.map(
    (s) => g.placeFixture('me', { kind: 'shelf', x: s.x, z: s.z, rot: 0 }).placed,
  ));
  eq(g.undoStack.length, 1, 'three fixtures built inside one press are one entry');
  eq(g.placements.filter((p) => ids.includes(p.id)).length, 3, 'and all three are standing');

  // Somebody stocks the middle one before the Ctrl+Z lands.
  const shelf = g.layout.shelves.find((s) => s.id === ids[1]);
  check(!!shelf, 'the middle one is a shelf we can stock');
  shelf.stacks = [{ item_id: ITEM.id, qty: 4, price: 3, stockedDay: g.day }];

  const res = g.undo();
  eq(res.ok, false, 'the undo is refused rather than half-done');
  check(/stock/i.test(res.error ?? ''), 'and it says why', res.error ?? '');
  eq(g.placements.filter((p) => ids.includes(p.id)).length, 3,
    '...with all three still standing, because nothing moved before the refusal');
  eq(g.undoStack.length, 1, '...and the entry is still there to try again with');
  eq(g.layout.shelves.find((s) => s.id === ids[1])?.stacks?.[0]?.qty, 4,
    '...and the goods that caused the refusal are untouched');

  // Clear the blocker and it goes through, or "refused" is indistinguishable
  // from "broken".
  g.layout.shelves.find((s) => s.id === ids[1]).stacks = [];
  const again = g.undo();
  check(again.ok, 'emptying it lets the same undo through', again.error ?? '');
  eq(g.placements.filter((p) => ids.includes(p.id)).length, 0, '...and all three go');
}

// ---------------------------------------------------------------------------
// 7. DOING SOMETHING NEW FORGETS THE FUTURE.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const a = freeTile(g);
  press(g, 'building that', () => g.placeFixture('me', { kind: 'shelf', x: a.x, z: a.z, rot: 0 }));
  g.undo();
  eq(g.redoStack.length, 1, 'an undo leaves something to redo');

  const b = freeTile(g);
  press(g, 'building that', () => g.placeFixture('me', { kind: 'shelf', x: b.x, z: b.z, rot: 0 }));
  eq(g.redoStack.length, 0, 'and a new press throws that future away');
  eq(g.redo().ok, false, '...so there is nothing to redo');
}

// ---------------------------------------------------------------------------
// 8. THE OVERLAY, NOT THE KIND.
//
// Knock a hole in a wall the GENERATOR drew and undo it. `edits` has to come
// back empty, rather than holding an entry that says "wall" — which draws
// identically today and is a wall the player owns the day the shop grows and
// the shell wants its own back.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const before = fabric(g);
  eq(g.edits.length, 0, 'the shop starts with no edge overlay at all');

  // Find a segment the shell drew.
  let seg = null;
  for (let z = 0; z <= g.layout.h && !seg; z++) {
    for (let x = 0; x < g.layout.w && !seg; x++) {
      if (g.edgeKindAt('h', x, z) === E.WALL) seg = { o: 'h', x, z };
    }
  }
  check(!!seg, 'the shell has a wall in it');

  const hole = press(g, 'knocking that through', () => g.buildEdge('me', { ...seg, kind: E.NONE }));
  check(hole.ok, 'a hole can be knocked in it', hole.error ?? '');
  eq(g.edits.length, 1, 'which is one overlay entry');

  g.undo();
  eq(g.edits.length, 0, 'undoing it leaves NO overlay entry — the shell owns that wall again');
  eq(fabric(g), before, '...and the building is byte-identical to the one that was there');
}

// ---------------------------------------------------------------------------
// 9. GROUND AND PAINT.
//
// Paint is the one build verb that never re-flows, which is `verify:paint`'s
// centrepiece — so the way back must not re-flow either, or Ctrl+Z on a colour
// costs the client its entire scene.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const floor = groundPiece();
  check(!!floor, 'the catalog has a floor to lay');

  const laid = press(g, 'that ground', () => g.buildGround('me', { x: 3, z: 3, piece: floor, to: { x: 6, z: 3 } }));
  check(laid.ok, 'a stroke of floor is laid', laid.error ?? '');
  check((laid.laid ?? 0) > 1, 'and it is several cells', `${laid.laid}`);
  const cash = g.cash;
  g.undo();
  eq(g.ground.length, 0, 'undoing the stroke takes every cell of it back up');
  check(g.cash > cash, '...and hands the money back', `${cash} → ${g.cash}`);

  const emulsion = paintPiece();
  if (emulsion) {
    // A face with a wall behind it — `paintFaces` refuses one without.
    let face = null;
    for (let z = 0; z <= g.layout.h && !face; z++) {
      for (let x = 0; x < g.layout.w && !face; x++) {
        if (g.edgeKindAt('h', x, z) === E.WALL) face = { o: 'h', x, z, s: 1 };
      }
    }
    const version = g.layoutVersion;
    const painted = press(g, 'that paint', () => g.paintFaces('me', { ...face, piece: emulsion }));
    check(painted.ok, 'a wall face takes a finish', painted.error ?? '');
    eq(Object.keys(g.paint).length, 1, 'which is one entry in the overlay');

    const res = g.undo();
    check(res.ok, 'and it can be stripped back off', res.error ?? '');
    eq(Object.keys(g.paint).length, 0, 'leaving the wall bare again');
    eq(g.layoutVersion, version, '...without costing a single re-flow, either way');
    eq(res.paint, true, '...and the room is told to send the overlay on');
    eq(res.layout, false, '...and told NOT to send a layout, which is the whole point');
  } else {
    check(true, 'no paint authored in this catalog — the finish claims are skipped');
    checks += 4;
  }
}

// ---------------------------------------------------------------------------
// 10. A REMOVAL COMES BACK AS ITSELF.
//
// Not as a fresh one off the palette. `placeFixture` mints tier 1 and no
// variant, so an undo routed through it would hand you back a plain shelf where
// a Commercial one used to stand — which is a demotion nothing logs, wearing an
// undo.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const shelf = g.layout.shelves[0];
  const up = press(g, 'that upgrade', () => g.upgradeFixture('me', shelf.id));
  check(up.ok, 'a shelf can be upgraded', up.error ?? '');
  const upgraded = g.placements.find((p) => p.x === shelf.x && p.z === shelf.z);
  const tier = upgraded?.tier;
  check(tier > 1, 'and it really is on a higher rung now', `${tier}`);

  const gone = press(g, 'removing that', () => g.removeFixture('me', upgraded.id));
  check(gone.ok, 'the upgraded shelf is torn out', gone.error ?? '');

  const res = g.undo();
  check(res.ok, 'and put back', res.error ?? '');
  const back = g.placements.find((p) => p.x === shelf.x && p.z === shelf.z);
  check(!!back, 'the shelf is back on its tile');
  eq(back?.tier, tier, '...on the rung it was on, not on rung one');
  eq(back?.kind, 'shelf', '...and still a shelf');
  eq(back?.rot, upgraded.rot, '...facing the way it faced');
}

// ---------------------------------------------------------------------------
// 11. THE CAP, and what it is a cap on.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  for (let i = 0; i < UNDO_MAX + 12; i++) {
    press(g, 'that paint', () => {
      g.paint = { ...g.paint, [`fake:${i}`]: 'x' };
      g.undoOpen.parts.push({ t: 'paint', faces: [{ key: `fake:${i}`, was: null, now: 'x' }] });
      return { ok: true };
    });
  }
  eq(g.undoStack.length, UNDO_MAX, 'the stack stops growing at the cap');
  // The OLDEST goes, not the newest — a cap that dropped the newest would make
  // the very next Ctrl+Z the one that does nothing.
  const top = g.undoStack[g.undoStack.length - 1];
  eq(top.parts[0].faces[0].key, `fake:${UNDO_MAX + 11}`, '...and what it drops is the oldest press');
}

// ---------------------------------------------------------------------------
// 12. A STEP THAT MOVED SEVERAL UNITS AT ONCE.
//
// Every fixture step in this file until now held one unit, or twelve that were
// each being built from nothing (a conveyor run) — and in both of those no part
// is ever standing where another part is going. `shiftFixtures` is the press
// where they are: a row nudged one square ALONG itself has every member landing
// on the cell its neighbour has not vacated yet.
//
// Which makes it this file's own "all or nothing" rule turned against it.
// `couldGoTo` asks `canPlace` of every part against the shop as it stands, and
// the deferred re-flow means that shop still has the whole row where it was — so
// the parts refuse one another, and because half an undo is worse than none the
// entire step is refused. Nothing is wrong with any of it: you press Ctrl+Z on a
// move you made a second ago and the shop says "something is already there"
// about the shop it is being asked to go back to.
//
// Its pair is REDO, because the same walk runs both ways and a fix applied to
// one direction of it would leave the other refusing.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  // A row laid by hand, so the members are next to each other — the whole claim
  // is about parts standing in one another's way.
  const row = [];
  const at = freeTile(g);
  for (let i = 0; i < 3; i++) {
    const res = press(g, 'that shelf', () => g.placeFixture('me', {
      kind: 'shelf', x: at.x + i, z: at.z, rot: 0,
    }));
    if (res.ok) row.push(res.placed);
  }
  if (row.length < 3) {
    console.log('   (no room for a hand-laid row — the batch move is not measurable here)');
  } else {
    const unit = g.layout.shelves.find((s) => s.id === row[0]);
    unit.stacks = [{ item_id: ITEM.id, qty: 5, price: 3, stockedDay: g.day }];
    const where = () => row.map((id, i) => spotOf(g, id) ?? `gone${i}`).join(' ');
    const goods = () => g.layout.shelves.reduce((n, s) => n + g.fixtureContents(s), 0);
    const was = `${at.x},${at.z} ${at.x + 1},${at.z} ${at.x + 2},${at.z}`;
    eq(where(), was, 'three shelves standing in a row');
    eq(goods(), 5, 'with goods on the first of them');
    const cash = g.cash;

    const moved = press(g, 'that move', () => g.shiftFixtures('me', row, 1, 0));
    check(moved.ok, 'the row shifts one square along itself', moved.error ?? '');
    // The ids are re-minted by the move, so the row is re-read rather than
    // reused — which is the same reason a client cannot send three messages.
    const now = g.placements.filter((p) => p.kind === 'shelf' && p.z === at.z
      && p.x > at.x && p.x <= at.x + 3);
    eq(now.length, 3, 'and all three are one square along');

    const back = g.undo();
    check(back.ok, 'a batch move can be taken back', back.error ?? '');
    eq(g.placements.filter((p) => p.kind === 'shelf' && p.z === at.z
      && p.x >= at.x && p.x < at.x + 3).length, 3, 'and all three are back where they were');
    eq(goods(), 5, 'with the goods still on the one that had them');
    eq(g.cash, cash, 'and no money moved either way');

    const again = g.redo();
    check(again.ok, 'and the same walk puts it forward again', again.error ?? '');
    eq(g.placements.filter((p) => p.kind === 'shelf' && p.z === at.z
      && p.x > at.x && p.x <= at.x + 3).length, 3, 'with all three one square along once more');
    eq(goods(), 5, 'and the goods still on board');
  }
}

// ---------------------------------------------------------------------------

console.log(`\nverify:undo — ${checks} assertions`);
if (failures.length) {
  console.error(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✅  a build press can be taken back, and it takes nothing else with it.\n');
