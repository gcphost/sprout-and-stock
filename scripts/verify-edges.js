/**
 * VERIFY: EDGES SAY THE SAME THING THE WALL RING DID.
 *
 * Step 1 of docs/building.md adds a second way to describe the building —
 * walls between cells rather than on them — and changes no behaviour. This is
 * what makes that claim checkable rather than hopeful.
 *
 * For a spread of seeds and fixture counts it generates a real layout, derives
 * the edge loop from its wall ring, floods the enclosure, and asserts the
 * cells `computeIndoor` calls enclosed are *exactly* the cells `insideStore`
 * calls inside. Not "roughly" — cell for cell, both directions.
 *
 * If that ever stops holding, everything built on top of the mask is standing
 * on a different building to the one the player is looking at.
 *
 *   node scripts/verify-edges.js
 */

import { generateLayout } from '../server/layout.js';
import { insideStore } from '../shared/build.js';
import {
  deriveEdges, computeIndoor, canStep, E, edgeBetween, SOLID, eviOf, ehiOf,
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

      // ---- derive, then flood --------------------------------------------
      const { edgesV, edgesH } = deriveEdges(L, (x, z) => insideStore(L, x, z));
      const probe = { ...L, edgesV, edgesH };
      const indoor = computeIndoor(probe);

      // ---- the claim: identical, cell for cell ----------------------------
      let mismatch = 0;
      for (let z = 0; z < L.h; z++) {
        for (let x = 0; x < L.w; x++) {
          cells++;
          const was = insideStore(L, x, z);
          const now = indoor[z * L.w + x] === 1;
          if (was !== now) mismatch++;
        }
      }
      check(mismatch === 0,
        `seed ${s} shelves ${shape.shelves} grow ${grow.w}x${grow.h}: `
        + `${mismatch} cells disagree between insideStore and computeIndoor`);

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

      // ---- a doorway is passable, a wall is not ---------------------------
      // Same edge loop, two different questions. If DOOR were solid nobody
      // could ever get in; if it weren't enclosing the mask above would leak.
      const d = { x: L.door.x, z: L.door.z };
      const through = edgeBetween(probe, d.x, d.z, d.x, d.z - 1);
      if (through !== E.NONE) {
        check(!SOLID.has(through),
          `seed ${s}: the doorway edge is solid — nobody can enter the shop`);
      }

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
