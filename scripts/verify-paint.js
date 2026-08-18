#!/usr/bin/env node
/**
 * VERIFY: A COLOUR CAN NEVER MOVE A WALL.
 *
 * `verify:floor` guards the claim the floor layer rests on — that a floor is a
 * *look* and never a permission. Paint is the same claim about the other
 * surface in the building, and it has to be made again rather than inherited,
 * because paint goes somewhere nothing has ever gone before: on ONE SIDE of the
 * line between two cells. Everything in the game that reads a wall reads it as
 * a number in `edgesV`/`edgesH` — enclosure, pathing, the queue, whether a
 * shopper may cross — so a finish that touched either array would not be a
 * rendering bug, it would be a shop that changes shape when you decorate it.
 *
 * The centrepiece is therefore a comparison rather than a value: every wall in
 * a furnished shop painted, and `tiles`, `blocked`, `indoor`, `edgesV` and
 * `edgesH` byte-identical afterwards. That is invisible by eye twice over — you
 * would have to notice that a cell you were not looking at stopped accepting
 * shelves, or that a shopper who used to reach the back of the shop no longer
 * does.
 *
 * The rest are the claims a *side* brings with it, and each is a real way to
 * get this wrong:
 *
 * - **Two faces are two decisions.** A key that dropped the side would paint
 *   both at once and look completely correct from the camera, which only ever
 *   sees one of them — you would find out from inside the room.
 * - **It survives a re-flow.** Ground has to be re-applied on every re-flow or
 *   buying a shelf repaints the shop; paint is hung on the layout afterwards
 *   instead, so this asserts the same promise through a different mechanism.
 * - **…and does not CAUSE one.** `layoutVersion` must not move: a re-flow is
 *   the client disposing its whole scene, and paint moves nothing, so paying
 *   that for a colour is the cost the message exists to avoid. The exact
 *   opposite of `verify:pick`'s centrepiece, and both are the same argument.
 * - **The money.** Per face, half of what was there back when you paint over
 *   it, a round trip that always loses — the shop's one sell-back rate, said
 *   about emulsion. Every figure below is arithmetic on a deliberately odd
 *   authored price, never on `paintUnitCost`.
 * - **A face with no wall.** Painting one is refused; a drag ALONG a wall with
 *   a gap in it paints what is there and skips the gap, which is the opposite
 *   rule and right for the opposite reason — you are following a wall, not
 *   building one.
 *
 * Writes two paint rows into whatever content database it is pointed at —
 * usually the live shared one — and removes them on exit, the same way
 * verify:catalog, verify:floor and verify:economy do.
 *
 *   node scripts/verify-paint.js
 */

import { Game } from '../server/sim/index.js';
import { writeContent } from '../server/content.js';
import { remove } from '../server/db.js';
import { faceKey, faceRun, canPaintFaces, edgeAt, FIXTURE_REFUND } from '../shared/build.js';
import { E } from '../shared/edges.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const round2 = (v) => Math.round(v * 100) / 100;

const SHOP = { shelf: 6, freezer: 1, checkout: 1, plot: 4 };

/**
 * Deliberately odd, and deliberately different from each other — verify:floor's
 * argument, and it matters more here because a repaint is priced as a
 * DIFFERENCE. Two prices that happened to be equal would make "half of the old
 * one back" and "nothing back" the same number.
 */
// Both halve exactly to the cent, and that is deliberate rather than lazy: the
// shop prices a repaint as a DIFFERENCE (`unit - old * FIXTURE_REFUND`) and
// `round2` on a negative number rounds toward zero, so a price whose half is a
// half-cent refunds a cent light. That is `buildGround`'s arithmetic exactly —
// the two verbs are meant to be readable as one — so it is a question about
// rounding money everywhere, not about paint, and a sweep that made it a paint
// assertion would be the place somebody later "fixes" one of the two and leaves
// the other.
const CHEAP = 3.18;
const DEAR = 11.42;

const TEST_PAINTS = [
  {
    id: 'verify-paint-cheap',
    kind: 'paint',
    name: 'Verify Whitewash',
    cost: CHEAP,
    surface: { color: '#eae6dd', pattern: 'plain' },
    tiers: [{ name: 'Standard', cost: 0 }],
  },
  {
    id: 'verify-paint-dear',
    kind: 'paint',
    name: 'Verify Lacquer',
    cost: DEAR,
    surface: { color: '#2e5f74', accent: '#1d3c4a', pattern: 'checker' },
    tiers: [{ name: 'Standard', cost: 0 }],
  },
];

process.on('exit', () => {
  for (const f of TEST_PAINTS) {
    try { remove('fixtures', f.id); } catch { /* the DB is already gone */ }
  }
});

for (const f of TEST_PAINTS) {
  const res = writeContent('fixture', f, 'verify');
  check(res.ok, `the catalog accepts a paint called ${f.id}`, res.error ?? '');
}

/**
 * `fresh()` clears everything `Game.create` reads off the save, and the list
 * grew by `paint` — a run that did not clear it would measure a shop somebody
 * else had already decorated and read the leftover finish as a bug.
 */
function fresh() {
  const g = Game.create({ worldId: 'verify-paint', seed: 'paint', ephemeral: true });
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
  g.cash = 20000;
  g.freezeShell();
  g.addPlayer('me', 'Tester');
  g.players.me.build = { on: true, tool: 'shelf' };
  return g;
}

/** Every wall in the shop, as faces — both sides of each. */
function allFaces(g) {
  const L = g.layout;
  const out = [];
  for (let z = 0; z < L.h; z++) {
    for (let x = 0; x <= L.w; x++) {
      if (edgeAt(L, { o: 'v', x, z }) !== E.NONE) out.push({ o: 'v', x, z, s: -1 }, { o: 'v', x, z, s: 1 });
    }
  }
  for (let z = 0; z <= L.h; z++) {
    for (let x = 0; x < L.w; x++) {
      if (edgeAt(L, { o: 'h', x, z }) !== E.NONE) out.push({ o: 'h', x, z, s: -1 }, { o: 'h', x, z, s: 1 });
    }
  }
  return out;
}

/**
 * The whole building, as one comparable string.
 *
 * Every array anything but the renderer reads. If a colour can move ONE of
 * these, the game has stopped being a game where decorating is free.
 */
const fabric = (g) => JSON.stringify([
  g.layout.tiles, g.layout.blocked, g.layout.indoor, g.layout.edgesV, g.layout.edgesH,
]);

// ---------------------------------------------------------------------------
// 1. Paint every wall in the shop. Nothing about the building moves.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const faces = allFaces(g);
  check(faces.length >= 20, 'the test shop is actually walled', `${faces.length} faces`);

  const before = fabric(g);
  const version = g.layoutVersion;
  let painted = 0;
  for (const f of faces) {
    const res = g.paintFaces('me', { ...f, piece: 'verify-paint-cheap' });
    if (res.ok) painted += res.painted ?? 0;
  }
  eq(painted, faces.length, 'every face took the finish');
  eq(fabric(g), before, 'and not one tile, wall, block or indoor cell moved');

  // The other half of the same promise, and the one that is about cost rather
  // than correctness: a colour must not make the client throw the shop away.
  eq(g.layoutVersion, version, 'and painting the whole shop re-flowed nothing');

  // Both sides really are stored, rather than one answer wearing two keys.
  eq(Object.keys(g.paint).length, faces.length, 'each face is its own entry');
}

// ---------------------------------------------------------------------------
// 2. Two sides are two decisions.
//
// The claim a `side` brings with it, and the one that would look perfectly
// correct from a camera that can only ever see one face of a wall.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const wall = allFaces(g).find((f) => f.s === -1);
  const res = g.paintFaces('me', { ...wall, piece: 'verify-paint-dear' });
  check(res.ok, 'one face takes paint', res.error ?? '');
  eq(res.painted, 1, 'exactly one face');

  eq(g.paint[faceKey(wall)], 'verify-paint-dear', 'the side you named is finished');
  eq(g.paint[faceKey({ ...wall, s: 1 })], undefined, 'and the other side of that same wall is bare');
  eq(Object.keys(g.paint).length, 1, 'one press, one face');

  // ...and the far side is reachable on its own, which is the whole gesture.
  const back = g.paintFaces('me', { ...wall, s: 1, piece: 'verify-paint-cheap' });
  check(back.ok, 'the far side takes its own finish');
  eq(g.paint[faceKey(wall)], 'verify-paint-dear', 'without disturbing the near one');
  eq(g.paint[faceKey({ ...wall, s: 1 })], 'verify-paint-cheap', 'and it is the one you asked for');
}

// ---------------------------------------------------------------------------
// 3. The money: per face, half back on a repaint, and a round trip loses.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const wall = allFaces(g).find((f) => f.s === -1);

  const start = g.cash;
  g.paintFaces('me', { ...wall, piece: 'verify-paint-cheap' });
  eq(round2(start - g.cash), CHEAP, 'a bare face costs the price on the row');

  // Over the top of it: the new price less half of what is under it. Written
  // out as arithmetic on the authored figures rather than asked of
  // `paintUnitCost`, which would pass whatever that function does.
  const mid = g.cash;
  g.paintFaces('me', { ...wall, piece: 'verify-paint-dear' });
  eq(round2(mid - g.cash), round2(DEAR - CHEAP * FIXTURE_REFUND),
    'painting over pays the difference, less half of what was there');

  // Stripping it hands back half and leaves nothing behind — the key goes,
  // rather than being stored as null, or "what is this wall painted" would have
  // two spellings of no.
  const before = g.cash;
  const off = g.paintFaces('me', { ...wall, piece: '' });
  check(off.ok, 'a finish can be stripped back off');
  eq(round2(g.cash - before), round2(DEAR * FIXTURE_REFUND), 'and half the dear coat comes back');
  eq(faceKey(wall) in g.paint, false, 'with no entry left behind');

  check(g.cash < start, 'a paint-and-strip round trip always loses money',
    `${start} -> ${g.cash}`);

  // Painting what is already painted is free and changes nothing — the same
  // `unchanged` shrug `buildGround` gives.
  g.paintFaces('me', { ...wall, piece: 'verify-paint-cheap' });
  const held = g.cash;
  const again = g.paintFaces('me', { ...wall, piece: 'verify-paint-cheap' });
  check(again.ok, 'painting a face the colour it already is is accepted');
  eq(g.cash, held, 'and costs nothing');
}

// ---------------------------------------------------------------------------
// 4. A face with no wall, and a run with a gap in it.
//
// Opposite rules on purpose: pointing at nothing is a refusal, and a drag that
// runs past a doorway paints the wall either side of it. You are following a
// wall, not building one.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const L = g.layout;
  // Somewhere with no wall on it at all — the middle of the shop floor.
  let bare = null;
  for (let z = 2; z < L.h - 2 && !bare; z++) {
    for (let x = 2; x < L.w - 2 && !bare; x++) {
      if (edgeAt(L, { o: 'v', x, z }) === E.NONE) bare = { o: 'v', x, z, s: 1 };
    }
  }
  check(!!bare, 'the shop has a lattice line with no wall on it');
  eq(canPaintFaces(L, [bare]).ok, false, 'a face with no wall behind it cannot be painted');
  const res = g.paintFaces('me', { ...bare, piece: 'verify-paint-cheap' });
  check(!res.ok, 'and the shop refuses it', JSON.stringify(res));
  eq(Object.keys(g.paint).length, 0, 'with nothing painted');
  eq(g.cash, 20000, 'and nothing charged');

  // A run down a whole side of the building, which crosses whatever is in that
  // wall. `faceRun` drops the gaps rather than refusing the gesture.
  const anyWall = allFaces(g).find((f) => f.o === 'v' && f.s === 1);
  const run = faceRun(L, anyWall, anyWall.z + 40);
  check(run.length >= 2, 'a drag along a wall covers several faces', `${run.length}`);
  check(run.every((f) => edgeAt(L, f) !== E.NONE), 'and every face in it has a wall behind it');
  check(run.every((f) => f.s === anyWall.s),
    'and every face in it is the side the drag STARTED on');
}

// ---------------------------------------------------------------------------
// 5. It survives a re-flow, and a save.
//
// Ground has to be re-applied on every re-flow or buying a shelf repaints the
// shop. Paint is hung on the layout after the generator has run, which is a
// different mechanism making the same promise — so it is asserted, not assumed.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const wall = allFaces(g).find((f) => f.s === -1);
  g.paintFaces('me', { ...wall, piece: 'verify-paint-dear' });
  const painted = { ...g.paint };

  // The thing a player actually does next: buy something. Every purchase
  // re-flows, which is exactly when a layer that is not re-applied disappears.
  const L = g.layout;
  let built = false;
  for (let z = L.store.z; z < L.store.z + L.store.h && !built; z++) {
    for (let x = L.store.x; x < L.store.x + L.store.w && !built; x++) {
      if (g.fixtureAt(x, z)) continue;
      built = g.placeFixture('me', { kind: 'shelf', x, z, rot: 0 }).ok;
    }
  }
  check(built, 'a shelf can be built in the painted shop');
  eq(JSON.stringify(g.paint), JSON.stringify(painted), 'and the paint survives the re-flow');
  eq(g.layout.paint[faceKey(wall)], 'verify-paint-dear',
    '...and the layout the client is sent still carries it');

  // And the save, which is the other way a layer quietly goes away.
  const saved = JSON.parse(JSON.stringify(g.saveState()));
  eq(JSON.stringify(saved.paint), JSON.stringify(painted), 'the save carries it too');
}

// ---------------------------------------------------------------------------

console.log(`\nverify:paint — ${checks} assertions`);
if (failures.length) {
  console.error(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✅  a wall can be finished on either side, and a colour moves nothing.\n');
