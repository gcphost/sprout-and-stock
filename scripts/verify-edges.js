/**
 * VERIFY: THE WALLS AGREE WITH THE BUILDING.
 *
 * Two halves, because they fail in different ways.
 *
 * The **rule cases** are hand-built shapes that pin down what an edge means: a
 * doorway is still enclosure, a gap is not, a fence never makes a room however
 * tightly you draw it. These exist because mutation testing found the sweep
 * alone couldn't see the fence rule at all — inverting it left everything
 * green, since the sweep only ever looks at shop walls.
 *
 * The **sweep** generates real layouts across seeds, fixture counts and bought
 * floor area, floods the enclosure through the edges the generator actually
 * emitted, and asserts the cells it calls enclosed are exactly the cells of the
 * store *rectangle* — cell for cell, both directions. Against the rect and not
 * against `insideStore`, because `insideStore` reads the mask now, and asking
 * whether the mask matches the mask is a test that can never fail. Then it
 * walks the real edge rules from the shopper spawn and insists on reaching the
 * shop floor, which is the one assertion a sealed building fails and every
 * other assertion here would happily pass.
 *
 * The **annex case** is the payoff: a lean-to hung off the east wall by editing
 * edges has to become shop floor you can build on, which is the shape the store
 * rect could never describe.
 *
 * If this stops holding, everything built on the mask is reasoning about a
 * different building to the one the player is looking at.
 *
 *   node scripts/verify-edges.js
 */

import { generateLayout } from '../server/layout.js';
import { insideStore, canPlace, canPlaceEdges, edgeRun } from '../shared/build.js';
import {
  deriveEdges, computeIndoor, canStep, reachable, withEdge, E, eviOf, ehiOf,
} from '../shared/edges.js';
import { T, WALKABLE } from '../shared/tiles.js';

let checks = 0;
let failures = 0;

function fail(msg) {
  failures++;
  if (failures <= 12) console.log('  FAIL ' + msg);
  else if (failures === 13) console.log('  … further failures suppressed');
}

function check(ok, msg) {
  checks++;
  if (!ok) fail(msg);
}

// ---------------------------------------------------------------------------
// The rules themselves, on hand-built shapes.
//
// The sweep below proves the new representation agrees with the old one. It
// cannot prove the *rules*, because it only ever derives edges from the store
// interior — so no fence edge is ever produced and "a fence must not enclose"
// goes untested. Mutation testing found exactly that hole: inverting the fence
// rule left the whole sweep green.
// ---------------------------------------------------------------------------

function pad(w, h) {
  return {
    w, h,
    tiles: new Uint8Array(w * h).fill(T.FLOOR),
    edgesV: new Uint8Array((w + 1) * h),
    edgesH: new Uint8Array(w * (h + 1)),
  };
}

/** Ring `kind` around the cell range x0..x1, z0..z1 inclusive. */
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

const enclosedCount = (L) => computeIndoor(L).reduce((n, v) => n + v, 0);

const countEdges = (L, kind) =>
  [...(L.edgesV ?? []), ...(L.edgesH ?? [])].filter((e) => e === kind).length;

/** Every cell reachable on foot from here, obeying the real edge rules. */
function walkFrom(L, sx, sz) {
  const seen = new Set();
  const start = [Math.round(sx), Math.round(sz)];
  const stack = [start];
  seen.add(`${start[0]},${start[1]}`);
  while (stack.length) {
    const [x, z] = stack.pop();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const nz = z + dz;
      const k = `${nx},${nz}`;
      if (seen.has(k)) continue;
      if (!canStep(L, x, z, nx, nz)) continue;
      seen.add(k);
      stack.push([nx, nz]);
    }
  }
  return seen;
}

{
  // 1. A walled box encloses exactly its own cells.
  let L = pad(12, 12);
  ring(L, 2, 2, 4, 4, E.WALL);
  check(enclosedCount(L) === 9, `walled 3x3 enclosed ${enclosedCount(L)}, want 9`);

  // 2. A doorway is still enclosure — you can walk in, it is still a room.
  L = pad(12, 12);
  ring(L, 2, 2, 4, 4, E.WALL);
  L.edgesH[ehiOf(L.w, 3, 5)] = E.DOOR;
  check(enclosedCount(L) === 9, `box with a door enclosed ${enclosedCount(L)}, want 9`);

  // 3. A hole is not. This is the patio rule: unenclosed floor is outdoors.
  L = pad(12, 12);
  ring(L, 2, 2, 4, 4, E.WALL);
  L.edgesH[ehiOf(L.w, 3, 5)] = E.NONE;
  check(enclosedCount(L) === 0, `box with a gap enclosed ${enclosedCount(L)}, want 0`);

  // 4. A fence never makes a room, however tightly you draw it.
  L = pad(12, 12);
  ring(L, 2, 2, 6, 6, E.FENCE);
  check(enclosedCount(L) === 0, `fenced field enclosed ${enclosedCount(L)}, want 0`);

  // 5. Glass is a wall you can see through.
  L = pad(12, 12);
  ring(L, 2, 2, 4, 4, E.WINDOW);
  check(enclosedCount(L) === 9, `glasshouse enclosed ${enclosedCount(L)}, want 9`);

  // 6. Two separate buildings are both indoors. "Indoor" is not one rect.
  L = pad(16, 16);
  ring(L, 2, 2, 4, 4, E.WALL);
  ring(L, 9, 9, 10, 10, E.WALL);
  check(enclosedCount(L) === 13, `two buildings enclosed ${enclosedCount(L)}, want 13`);

  // 7. An L-shape, derived the way the real migration derives one. This is the
  //    shape the store rect could never express.
  const cells = new Set();
  for (let z = 2; z <= 8; z++) for (let x = 2; x <= 5; x++) cells.add(`${x},${z}`);
  for (let z = 6; z <= 8; z++) for (let x = 6; x <= 10; x++) cells.add(`${x},${z}`);
  L = pad(16, 16);
  const inL = (x, z) => cells.has(`${x},${z}`);
  Object.assign(L, deriveEdges(L, inL));
  const mask = computeIndoor(L);
  let wrong = 0;
  for (let z = 0; z < L.h; z++) {
    for (let x = 0; x < L.w; x++) {
      if ((mask[z * L.w + x] === 1) !== inL(x, z)) wrong++;
    }
  }
  check(wrong === 0, `L-shaped building: ${wrong} cells disagree`);
}

// ---------------------------------------------------------------------------
// The point of the whole exercise: a shop that isn't a rectangle.
//
// Hang a lean-to off the east wall — floor, three walls, and the shared wall
// opened so the two spaces are one room — and the annex has to become shop
// floor you can build on. Nothing here special-cases an L; it is the same
// flood answering a different set of walls.
// ---------------------------------------------------------------------------
{
  const res = generateLayout({
    seed: 'annex', shelves: 6, freezers: 1, checkouts: 2, plots: 4, stations: [],
  });
  const L = res.layout ?? res;
  const s = L.store;
  const ax0 = s.x + s.w;
  const ax1 = Math.min(ax0 + 2, L.w - 3);
  const az0 = s.z + 1;
  const az1 = az0 + 3;
  const spot = { kind: 'shelf', x: ax0 + 1, z: az0 + 1, rot: 0 };

  const before = canPlace(L, spot);
  check(!before.ok, `a shelf in open grass was allowed: ${JSON.stringify(before)}`);

  for (let z = az0; z <= az1; z++) {
    for (let x = ax0; x <= ax1; x++) L.tiles[z * L.w + x] = T.FLOOR;
  }
  for (let z = az0; z <= az1; z++) {
    L.edgesV[eviOf(L.w, ax1 + 1, z)] = E.WALL;
    L.edgesV[eviOf(L.w, ax0, z)] = E.NONE;   // knock through
  }
  for (let x = ax0; x <= ax1; x++) {
    L.edgesH[ehiOf(L.w, x, az0)] = E.WALL;
    L.edgesH[ehiOf(L.w, x, az1 + 1)] = E.WALL;
  }
  L.indoor = Array.from(computeIndoor(L));

  check(insideStore(L, ax0 + 1, az0 + 1), 'the annex did not come out indoors');
  check(!insideStore(L, ax1 + 2, az0 + 1), 'the grass beyond the annex came out indoors');
  const after = canPlace(L, spot);
  check(after.ok, `a shelf in the annex was refused: ${after.reason}`);

  // And the shop is still one connected space, walked through the real rules.
  const walked = walkFrom(L, L.door.x, L.door.z);
  check(walked.has(`${ax0 + 1},${az0 + 1}`),
    'the annex is enclosed but unreachable — the knock-through did not take');
}

// ---------------------------------------------------------------------------
// A wall you drew must never resize the building.
//
// The generator grows the shop until everything it owns fits, and it now runs
// with the player's edits applied — so a partition that makes some shelf spot
// unusable could plausibly push it a column wider. It doesn't, and it must not:
// the shell is keyed to absolute coordinates, so a shop that re-sized itself
// would leave every hand-drawn wall in the wrong place relative to it.
// ---------------------------------------------------------------------------
for (const seed of ['a', 'b', 'c', 'd']) {
  for (const shelves of [4, 12, 22]) {
    const base = { seed, shelves, freezers: 1, checkouts: 2, plots: 6, stations: [] };
    const plain = generateLayout(base);
    const s = plain.store;
    const midZ = s.z + Math.floor(s.h / 2);
    const edits = [];
    for (let x = s.x; x < s.x + s.w; x++) edits.push({ o: 'h', x, z: midZ, k: E.WALL });

    const walled = generateLayout({ ...base, edits });
    check(walled.store.w === s.w && walled.store.h === s.h,
      `${seed} sh=${shelves}: a partition resized the shop `
      + `${s.w}x${s.h} -> ${walled.store.w}x${walled.store.h}`);

    // And the wall actually survived into the finished layout.
    const built = edits.filter((e) => walled.edgesH[e.z * walled.w + e.x] === E.WALL).length;
    check(built === edits.length,
      `${seed} sh=${shelves}: ${edits.length - built} of ${edits.length} drawn segments went missing`);
  }
}

// ---------------------------------------------------------------------------
// Wall runs. A drag sends its two ends and the server expands them, so the
// expansion is the only place a long wall can go wrong.
// ---------------------------------------------------------------------------
{
  const h = edgeRun({ o: 'h', x: 4, z: 7 }, 9);
  check(h.length === 6, `h run 4..9 gave ${h.length} segments, want 6`);
  check(h.every((s) => s.o === 'h' && s.z === 7), 'a horizontal run must stay on its own line');
  check(h.map((s) => s.x).join() === '4,5,6,7,8,9', `h run walked ${h.map((s) => s.x).join()}`);

  const v = edgeRun({ o: 'v', x: 3, z: 2 }, 5);
  check(v.every((s) => s.o === 'v' && s.x === 3), 'a vertical run must stay on its own line');
  check(v.map((s) => s.z).join() === '2,3,4,5', `v run walked ${v.map((s) => s.z).join()}`);

  // Dragging backwards is the same wall.
  const back = edgeRun({ o: 'h', x: 9, z: 7 }, 4);
  check(back.length === 6, `a backwards drag gave ${back.length}, want 6`);

  // A click with no drag is a run of one, which is what makes the two paths one path.
  check(edgeRun({ o: 'h', x: 4, z: 7 }, null).length === 1, 'a click should lay one segment');

  // And a wild drag can't spend the whole shop.
  check(edgeRun({ o: 'h', x: 1, z: 7 }, 900, 40).length === 40, 'run cap not applied');
}

{
  // A partition warns as a *run* even though no single segment of it would.
  const res = generateLayout({
    seed: 'runwarn', shelves: 10, freezers: 1, checkouts: 2, plots: 4, stations: [],
  });
  const L = res.layout ?? res;
  const s = L.store;
  const midZ = s.z + Math.floor(s.h / 2);
  const segs = edgeRun({ o: 'h', x: s.x, z: midZ }, s.x + s.w - 1);

  const whole = canPlaceEdges(L, segs, E.WALL);
  check(whole.ok, 'a partition should be allowed — blocking your own shop is a move');
  check(!!whole.warn, 'a partition across the shop should warn about what it cuts off');

  // ...and it has to warn *while the far side is still walkable*. The yard's
  // service door means the outside joins both ends of any interior wall, so a
  // flood that only asks "can anybody get there" says yes and the warning goes
  // silent on the one wall most worth warning about. The rule is the shop
  // floor joining up to the door, not the world being connected.
  {
    let probe = L;
    for (const seg of segs) probe = withEdge(probe, seg, E.WALL);
    const far = { x: L.store.x + 1, z: L.store.z + 1 };
    check(reachable(probe, L.spawn.x, L.spawn.z).has(`${far.x},${far.z}`),
      'the far side of the partition should still be walkable — round the back');
  }

  const single = canPlaceEdges(L, [segs[0]], E.WALL);
  check(!single.warn,
    'one segment of that same wall must NOT warn — that is why the run is checked whole');
}

const SEEDS = 40;
const SHAPES = [
  { shelves: 4, freezers: 0, checkouts: 1, plots: 2, stations: [] },
  { shelves: 9, freezers: 1, checkouts: 2, plots: 6, stations: ['coffee'] },
  { shelves: 17, freezers: 3, checkouts: 3, plots: 12, stations: ['coffee', 'blender'] },
];
const GROWS = [{ w: 0, h: 0 }, { w: 3, h: 2 }, { w: 6, h: 5 }];

let layouts = 0;
let cells = 0;

for (let s = 0; s < SEEDS; s++) {
  for (const shape of SHAPES) {
    for (const grow of GROWS) {
      const res = generateLayout({
        seed: `edge-${s}`,
        ...shape,
        placements: [],
        grow,
        doorShift: (s % 5) - 2,
      });
      const L = res.layout ?? res;
      layouts++;

      // ---- flood the generator's OWN edges --------------------------------
      // This used to derive edges from `insideStore` and check they agreed with
      // `insideStore`, which was a fair test while walls were still tiles and a
      // near-tautology the moment the generator started emitting edges itself.
      // What matters now is that the walls actually built agree with the rect.
      const probe = L;
      const indoor = computeIndoor(probe);
      check(L.edgesV?.length === (L.w + 1) * L.h && L.edgesH?.length === L.w * (L.h + 1),
        `seed ${s}: layout came back without edge arrays`);

      // ---- the claim: identical, cell for cell ----------------------------
      // Against the store *rectangle*, deliberately, and not against
      // `insideStore` — that reads the mask now, so comparing the two would be
      // asking whether a number equals itself. While the generator only builds
      // rectangles the walls it emits must enclose exactly the rect it planned.
      const inRect = (x, z) => x >= L.store.x && x < L.store.x + L.store.w
        && z >= L.store.z && z < L.store.z + L.store.h;

      let mismatch = 0;
      for (let z = 0; z < L.h; z++) {
        for (let x = 0; x < L.w; x++) {
          cells++;
          if (inRect(x, z) !== (indoor[z * L.w + x] === 1)) mismatch++;
        }
      }
      check(mismatch === 0,
        `seed ${s} shelves ${shape.shelves} grow ${grow.w}x${grow.h}: `
        + `${mismatch} cells enclosed differently to the store rect`);

      // And the mask the layout ships is the one it computed — the client
      // validates the build ghost against this, not against a fresh flood.
      check(L.indoor?.length === L.w * L.h,
        `seed ${s}: layout shipped without an indoor mask`);
      let carried = 0;
      for (let i = 0; i < L.w * L.h; i++) {
        if ((L.indoor?.[i] === 1) !== (indoor[i] === 1)) carried++;
      }
      check(carried === 0, `seed ${s}: ${carried} cells differ between shipped mask and a fresh flood`);

      // ---- the enclosure is actually closed -------------------------------
      // Every interior cell must be enclosed, and the tile just outside the
      // door must not be — otherwise the fill leaked and everything is "inside".
      const anyIndoor = indoor.some((v) => v === 1);
      check(anyIndoor, `seed ${s}: nothing at all came out enclosed`);

      const outsideDoor = { x: L.door.x, z: L.door.z + 1 };
      if (outsideDoor.z < L.h) {
        check(indoor[outsideDoor.z * L.w + outsideDoor.x] !== 1,
          `seed ${s}: the tile outside the front door reported as enclosed — the fill leaked`);
      }

      // ---- you can actually get in ----------------------------------------
      // The sharpest test in the file, and the one a sealed shop fails: walk
      // the real edge rules from where shoppers arrive and insist on reaching
      // the shop floor. Every other assertion here would pass on a building
      // with no way through its wall.
      //
      // (An earlier version asked whether one specific edge was passable. When
      // the doorway stopped being a tile that check quietly started reading a
      // NONE edge between two interior cells and asserted nothing at all —
      // visible only as the assertion count dropping by exactly one per layout.)
      const reached = walkFrom(probe, L.spawn.x, L.spawn.z);
      check(reached.has(`${L.door.x},${L.door.z}`),
        `seed ${s}: cannot walk from the spawn to the shop floor — the shop is sealed`);

      const doorways = countEdges(L, E.DOOR);
      check(doorways >= 1, `seed ${s}: no doorway edge anywhere in the shell`);

      // ---- edges never contradict the old walk grid -----------------------
      // Slice 2 swaps pathing onto canStep. Before that is safe, stepping
      // across an edge must never be *more* permissive than the tiles were.
      let looser = 0;
      for (let z = 1; z < L.h - 1 && looser === 0; z++) {
        for (let x = 1; x < L.w - 1; x++) {
          if (!WALKABLE.has(L.tiles[z * L.w + x])) continue;
          for (const [dx, dz] of [[1, 0], [0, 1]]) {
            const nx = x + dx;
            const nz = z + dz;
            const tilesSay = WALKABLE.has(L.tiles[nz * L.w + nx]);
            const edgesSay = canStep(probe, x, z, nx, nz);
            // Edges may be stricter (a wall the tiles never had), never looser.
            if (edgesSay && !tilesSay) { looser++; break; }
          }
        }
      }
      check(looser === 0,
        `seed ${s}: ${looser} step(s) allowed by edges that the tile grid forbade`);
    }
  }
}

console.log(`\nverify:edges — ${layouts} layouts, ${cells.toLocaleString()} cells, ${checks} assertions`);
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
