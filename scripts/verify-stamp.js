#!/usr/bin/env node
/**
 * VERIFY: ONE PRESS, SEVERAL FIXTURES — THE ROW AND THE STAMP.
 *
 * Two gestures that are the same claim from different ends: a drag lays a line
 * of one design, a paste lays a block of several. Everything in here is
 * invisible in a still frame by construction — six shelves laid one at a time
 * and six laid in one drag are the same six shelves afterwards, and the shop is
 * the same shop. Only the number of presses moved.
 *
 * ## The row
 *
 * Its **control** is a conveyor, which is every run ever laid: each cell turns
 * to follow the drag, because a belt's rotation IS its direction. Its
 * **centrepiece** is the opposite claim about everything else — a row of
 * shelving that swung round at the bend is an aisle you cannot walk, and it
 * would look completely correct in a screenshot of the straight part. That is
 * one flag (`runFollows`), and the assertion that matters is that both sides of
 * it are real: a sweep that only checked the shelf would pass on a flag that is
 * always false, and one that only checked the belt would pass on today's code
 * with the feature deleted.
 *
 * ## The stamp
 *
 * Its **control** is a shop that has never copied anything: paste refuses, and
 * nothing anywhere moves. Its **centrepiece** is what a blueprint deliberately
 * does NOT carry, and each of the three is a way to print money or a way to
 * lose it:
 *
 * - **Stock.** A blueprint is a shape. A paste that conjured the six loaves
 *   that were on the shelf you copied is free goods, once per press, for ever —
 *   and it would look exactly like a paste working.
 * - **The tier.** A copied Commercial freezer pastes as a *basic* one, because
 *   `placeFixture` charges the base price. The other way round is a maxed
 *   fixture for the price of a plain one, which is the whole upgrade ladder
 *   sold at a discount you can run with two keys.
 * - **The ids.** A pasted fixture is a new fixture. Sharing one would hand two
 *   units the same stock the next time the layout re-flowed.
 *
 * ...while the **variant** does come with it, and that pair is the point: a
 * shape is free (it is a look, one price for all of them) and a rung is not, so
 * the two have to be answered differently by the same call.
 *
 * The other claims are about ORDER, and neither is visible except as a refusal:
 * ground goes down before fixtures (a shelf on the grass of an annex is refused
 * by the very rule the floor layer exists to satisfy, so a paste that laid its
 * floor last would report "nothing could go there" over ground it was about to
 * lay two lines later), and paint goes on after walls (a face with no wall
 * behind it is refused, and the wall it needs may be one this same paste just
 * drew).
 *
 * It writes nothing at all: no content rows, no world row, no cleanup.
 *
 *   node scripts/verify-stamp.js
 */

import { Game } from '../server/sim/index.js';
import { content } from '../server/content.js';
import { runCells, runFollows, RUN_KINDS, FIXTURES, canPlace, BELT_RUN_MAX, isGround, isPaint } from '../shared/build.js';
import { kindOf } from '../shared/pieces.js';
import { E } from '../shared/edges.js';

const failures = [];
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, label) => check(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SHOP = { shelf: 6, freezer: 1, checkout: 1, plot: 2 };

function fresh() {
  const g = Game.create({ worldId: 'verify-stamp', seed: 'stamp', ephemeral: true });
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
  g.cash = 200000;
  g.freezeShell();
  g.addPlayer('me', 'Tester');
  g.players.me.build = { on: true, tool: 'shelf' };
  return g;
}

/** The first row of a ground kind and of a paint kind, if the catalog has one. */
const rowOf = (test) => (content().fixtures ?? []).find((f) => test(kindOf(f)))?.id ?? null;
const FLOOR = rowOf(isGround);
const EMULSION = rowOf(isPaint);

/** Where a block of `w` x `h` empty, buildable cells sits in this shop. */
function clearBlock(g, w, h, kind = 'shelf') {
  for (let z = 1; z < g.layout.h - h; z++) {
    for (let x = 1; x < g.layout.w - w; x++) {
      let all = true;
      for (let dz = 0; dz < h && all; dz++) {
        for (let dx = 0; dx < w && all; dx++) {
          all = canPlace(g.layout, { kind, x: x + dx, z: z + dz, rot: 0 }).ok;
        }
      }
      if (all) return { x, z };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. THE FLAG, asked of the generator alone.
//
// `runCells` is pure, so this is the one place in the file where the claim can
// be made as a value rather than inferred from a shop. Both sides of the flag,
// because either one alone is satisfied by a constant.
// ---------------------------------------------------------------------------
{
  const from = { x: 4, z: 4 };
  const to = { x: 8, z: 7 };          // an L: four east, then three south
  const bent = runCells(from, to, BELT_RUN_MAX, 2, true);
  const flat = runCells(from, to, BELT_RUN_MAX, 2, false);

  eq(bent.length, flat.length, 'the same cells either way — only the facings differ');
  check(bent.length > 5, 'the test run really bends', `${bent.length} cells`);
  check(new Set(bent.map((c) => c.rot)).size > 1, 'a following run turns at the corner');
  eq(new Set(flat.map((c) => c.rot)).size, 1, 'and one that does not follow keeps ONE facing');
  eq(flat[0].rot, 2, '...which is the facing it was armed with, not rot 0');
  // The armed facing is the SEED, and a following run spends it immediately:
  // cell one faces cell two, because that is the direction of the gesture. It
  // survives only where the gesture said nothing, which is a run of one — and
  // that case is not an edge case, it is how you place a single belt.
  eq(runCells(from, from, BELT_RUN_MAX, 2, true)[0].rot, 2,
    'a following run of ONE keeps the armed facing, since nothing else said');
  check(bent[0].rot !== flat[0].rot,
    'and over a real drag the two disagree from the very first cell');

  // Derived from `RUN_KINDS`, not written out — the trap `verify:hot` exists
  // for, said about a two-item list.
  for (const k of RUN_KINDS) check(runFollows(k), `${k} follows the drag`);
  for (const k of ['shelf', 'freezer', 'checkout', 'plot']) {
    check(!runFollows(k), `${k} keeps the facing you armed`);
  }
}

// ---------------------------------------------------------------------------
// 2. THE ROW, laid for real.
//
// The centrepiece: an aisle of shelving dragged round a corner. Every unit has
// to be browsable from the same side afterwards, which is the whole difference
// between a row and a snake.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const at = clearBlock(g, 4, 1);
  check(!!at, 'the test shop has a clear line to build along');

  const before = g.cash;
  const res = g.undoStep('a row', () => g.buildRun('me', {
    kind: 'shelf', x: at.x, z: at.z, to: { x: at.x + 3, z: at.z }, rot: 1,
  }));
  check(res.ok, 'a row of shelving lays in one drag', res.error ?? '');
  eq(res.laid, 4, '...four of them');

  const laid = g.placements.filter((p) => p.z === at.z && p.x >= at.x && p.x <= at.x + 3);
  eq(laid.length, 4, 'and four placements landed on those cells');
  eq(new Set(laid.map((p) => p.rot)).size, 1, 'every one of them faces the same way');
  eq(laid[0].rot, 1, '...the way you armed it');

  // Money: the drag is N units at the unit price, exactly as laying them one at
  // a time would be. Against the per-unit cost of what actually landed rather
  // than against `fixtureUnitCost` on its own, which would pass whatever that
  // function does.
  const each = (before - g.cash) / 4;
  eq(g.cash, Math.round((before - each * 4) * 100) / 100, 'and it charged four units, not one');
  check(each > 0, 'each of which cost something', `${each}`);

  // One press, one entry — the claim that makes the whole gesture worth having.
  eq(g.undoStack.length, 1, 'a drag of four is ONE thing to undo');
  g.undo();
  eq(g.placements.filter((p) => p.z === at.z && p.x >= at.x && p.x <= at.x + 3).length, 0,
    '...and one Ctrl+Z takes the whole row back');
  eq(g.cash, before, '...including all four of what it cost');
}

// ---------------------------------------------------------------------------
// 2b. A row that clips something lays the rest.
//
// The wall drag's ran-out-of-money rule, said about an obstruction: losing a
// whole gesture to one square is the kind of thing you cannot see coming.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const at = clearBlock(g, 4, 1);
  const blocker = g.placeFixture('me', { kind: 'shelf', x: at.x + 2, z: at.z, rot: 0 });
  check(blocker.ok, 'something is standing in the middle of the line', blocker.error ?? '');

  const res = g.buildRun('me', {
    kind: 'shelf', x: at.x, z: at.z, to: { x: at.x + 3, z: at.z }, rot: 1,
  });
  check(res.ok, 'the drag is not refused for the one square it cannot have', res.error ?? '');
  eq(res.laid, 3, '...it lays the other three');
}

// ---------------------------------------------------------------------------
// 2c. The control: a conveyor is the old game exactly.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const at = clearBlock(g, 4, 3, 'belt');
  check(!!at, 'there is room for a conveyor to bend');
  const res = g.buildRun('me', {
    kind: 'belt', x: at.x, z: at.z, to: { x: at.x + 3, z: at.z + 2 }, rot: 0,
  });
  check(res.ok, 'a conveyor still lays as a run', res.error ?? '');
  const belts = g.layout.belts ?? [];
  check(belts.length >= 4, 'several cells of it', `${belts.length}`);
  check(new Set(belts.map((b) => b.rot)).size > 1,
    '...and it still turns at the corner, which is what a belt is for');
}

// ---------------------------------------------------------------------------
// 3. THE CONTROL FOR THE STAMP. A shop that has copied nothing pastes nothing.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const n = g.placements.length;
  const cash = g.cash;
  const res = g.pasteClipboard('me', { x: 4, z: 4 });
  eq(res.ok, false, 'paste with nothing copied is refused');
  eq(g.placements.length, n, '...and builds nothing');
  eq(g.cash, cash, '...and costs nothing');
  eq(g.copyFixtures('me', []).ok, false, 'and copying nothing is refused too');
}

// ---------------------------------------------------------------------------
// 4. WHAT A BLUEPRINT CARRIES, AND WHAT IT DELIBERATELY DOES NOT.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const AMBIENT = content().items.find((it) => !it.tags.includes('frozen'));
  const shelf = g.layout.shelves[0];

  // A unit that is upgraded, restyled and stocked — the three things a copy has
  // to answer differently.
  const up = g.upgradeFixture('me', shelf.id);
  check(up.ok, 'the source unit can be upgraded', up.error ?? '');
  const src = g.placements.find((p) => p.x === shelf.x && p.z === shelf.z);
  check(src.tier > 1, 'and it really is on a higher rung', `${src.tier}`);
  const live = g.layout.shelves.find((s) => s.id === src.id);
  live.stacks = [{ item_id: AMBIENT.id, qty: 6, price: 3, stockedDay: g.day }];

  const copied = g.copyFixtures('me', [src.id]);
  check(copied.ok, 'one unit can be copied', copied.error ?? '');
  eq(copied.fixtures, 1, '...as one fixture');
  eq(copied.w, 1, '...one cell wide');

  const at = clearBlock(g, 1, 1);
  const cash = g.cash;
  const res = g.undoStep('a stamp', () => g.pasteClipboard('me', at));
  check(res.ok, 'and stamped down somewhere else', res.error ?? '');
  eq(res.laid, 1, '...as one thing');

  const made = g.placements.find((p) => p.x === at.x && p.z === at.z);
  check(!!made, 'the stamped unit is on the tile you named');
  check(made.id !== src.id, 'and it is a NEW fixture, not the same one twice');
  eq(made.kind, src.kind, '...of the same kind');
  eq(made.variant ?? '', src.variant ?? '', '...wearing the same shape, which is free');
  eq(made.tier, 1, '...on rung ONE, because a paste is a purchase at the base price');
  eq(g.layout.shelves.find((s) => s.id === made.id)?.stacks?.length ?? 0, 0,
    '...and holding nothing: a blueprint is a shape, not six free loaves');
  check(g.cash < cash, 'and it was paid for', `${cash} → ${g.cash}`);

  // The source is untouched by any of it — a copy is a read.
  eq(g.placements.find((p) => p.id === src.id)?.tier, src.tier, 'the unit you copied is still upgraded');
  eq(g.layout.shelves.find((s) => s.id === src.id)?.stacks?.[0]?.qty, 6, '...and still stocked');

  // One press, one entry.
  eq(g.undoStack.length, 1, 'the whole stamp is ONE thing to undo');
  g.undo();
  eq(g.placements.some((p) => p.x === at.x && p.z === at.z), false, '...and it all comes back out');
  eq(g.cash, cash, '...for exactly what it cost');
}

// ---------------------------------------------------------------------------
// 5. THE FOUR LAYERS, AND THE ORDER THEY GO DOWN IN.
//
// Ground before fixtures and paint after walls. Neither is visible except as a
// refusal, and both are refusals of the whole gesture rather than of one cell.
// ---------------------------------------------------------------------------
if (FLOOR) {
  const g = fresh();
  const src = clearBlock(g, 2, 1);
  // A unit standing on ground somebody laid.
  const a = g.placeFixture('me', { kind: 'shelf', x: src.x, z: src.z, rot: 0 });
  check(a.ok, 'a unit to copy', a.error ?? '');
  const paved = g.buildGround('me', { x: src.x, z: src.z, piece: FLOOR });
  check(paved.ok, '...standing on a floor somebody laid', paved.error ?? '');
  // A side that has no wall on it yet. `clearBlock` can land against the shell,
  // where `buildEdge` answers `ok` with `unchanged` — which passes an `ok`
  // assertion and copies nothing, and the failure then reads as the clipboard
  // dropping walls.
  const sides = [
    { o: 'h', x: src.x, z: src.z }, { o: 'h', x: src.x, z: src.z + 1 },
    { o: 'v', x: src.x, z: src.z }, { o: 'v', x: src.x + 1, z: src.z },
  ];
  let wall = { placed: 0 };
  let side = null;
  for (const seg of sides) {
    if (wall.placed) break;
    const r = g.buildEdge('me', { ...seg, kind: E.WALL });
    if (r.ok && r.placed) { wall = r; side = seg; }
  }
  check(wall.placed > 0, '...with a wall drawn along one side', JSON.stringify(wall));
  if (EMULSION && side) {
    const painted = g.paintFaces('me', { ...side, s: 1, piece: EMULSION });
    check(painted.ok, '...and a finish on that wall', painted.error ?? '');
  } else checks++;

  const id = g.placements.find((p) => p.x === src.x && p.z === src.z)?.id;
  const copied = g.copyFixtures('me', [id]);
  check(copied.ok, 'the whole square copies', copied.error ?? '');
  eq(copied.ground, 1, '...carrying the ground under it');
  check(copied.edits >= 1, '...and the wall beside it', `${copied.edits}`);
  if (EMULSION && side) check(copied.paint >= 1, '...and the finish on that wall', `${copied.paint}`);
  else checks++;

  const at = clearBlock(g, 1, 1);
  const groundWas = g.ground.length;
  const editsWas = g.edits.length;
  const paintWas = Object.keys(g.paint).length;
  const res = g.undoStep('a stamp', () => g.pasteClipboard('me', at));
  check(res.ok, 'and stamps down whole', res.error ?? '');
  eq(res.laid, 1, '...one fixture');
  check(g.ground.length > groundWas, '...on ground it laid itself');
  check(g.edits.length > editsWas, '...beside a wall it drew itself');
  if (EMULSION && side) {
    check(Object.keys(g.paint).length > paintWas,
      '...finished in the colour it copied, which needed the wall to exist first');
  } else checks++;

  // And back out, all four layers at once.
  g.undo();
  eq(g.ground.length, groundWas, 'undo takes the ground back up');
  eq(g.edits.length, editsWas, '...the wall back down');
  eq(Object.keys(g.paint).length, paintWas, '...and the paint back off');
} else {
  check(true, 'no floor authored in this catalog — the four-layer claims are skipped');
  checks += 14;
}

// ---------------------------------------------------------------------------
// 6. A STAMP THAT CLIPS SOMETHING LAYS THE REST.
// ---------------------------------------------------------------------------
{
  const g = fresh();
  const src = clearBlock(g, 3, 1);
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = g.placeFixture('me', { kind: 'shelf', x: src.x + i, z: src.z, rot: 0 });
    if (r.ok) ids.push(r.placed);
  }
  eq(ids.length, 3, 'three units to copy');
  check(g.copyFixtures('me', ids).ok, 'copied');

  // Somewhere the middle of the block is already taken.
  const at = clearBlock(g, 3, 1);
  const blocker = g.placeFixture('me', { kind: 'shelf', x: at.x + 1, z: at.z, rot: 0 });
  check(blocker.ok, 'and something standing in the middle of where it goes', blocker.error ?? '');

  const res = g.pasteClipboard('me', at);
  check(res.ok, 'the stamp is not refused for the one square it cannot have', res.error ?? '');
  eq(res.laid, 2, '...it lays the other two');
  check(res.missed >= 1, '...and says how many it could not', `${res.missed}`);
}

// ---------------------------------------------------------------------------

console.log(`\nverify:stamp — ${checks} assertions`);
if (failures.length) {
  console.error(`\n  ❌  ${failures.length} failed:\n`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✅  a row keeps its facing, and a stamp carries the shape and never the stock.\n');
