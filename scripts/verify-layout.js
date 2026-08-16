#!/usr/bin/env node
/**
 * LAYOUT INVARIANTS.
 *
 * `generateLayout` must place exactly what it was asked for, and everything it
 * places must be reachable. Both have been broken before in ways nobody noticed
 * for days: an off-by-one in the shelf loop meant a shelf upgrade sometimes gave
 * you nothing, and a queue once trailed through a wall so shoppers waited out on
 * the grass where the till could never reach them.
 *
 * Neither shows up in a screenshot of one seed. Both show up here instantly.
 *
 *   node scripts/verify-layout.js            # the standard sweep
 *   node scripts/verify-layout.js --seeds 60 # wider
 *   node scripts/verify-layout.js -v         # print every failure, not a sample
 */

import { generateLayout, defaultPads, buildWalkGrid, T } from '../server/layout.js';
import { insideStore, queueLanes } from '../shared/build.js';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : Number(argv[i + 1]);
};
const VERBOSE = argv.includes('-v') || argv.includes('--verbose');
const SEEDS = flag('--seeds', 24);

const failures = [];
let checks = 0;

function check(ok, label, detail) {
  checks++;
  if (!ok) failures.push({ label, detail });
}

/** Every case worth sweeping: counts that span "brand new shop" to "empire". */
function* cases() {
  const shelfCounts = [1, 2, 6, 7, 8, 12, 15, 20, 25];
  const freezerCounts = [0, 1, 2, 4];
  const checkoutCounts = [1, 2, 3, 4];
  const plotCounts = [1, 4, 5, 8, 9, 16, 17, 24, 32];
  const stationSets = [[], ['blender'], ['blender', 'toaster'], ['blender', 'toaster', 'oven']];

  for (let s = 0; s < SEEDS; s++) {
    const seed = `verify-${s}`;
    // Sweep each axis independently against a sensible baseline, rather than a
    // full cross product — that's 30k layouts and adds nothing.
    for (const shelves of shelfCounts) yield { seed, shelves, freezers: 0, checkouts: 1, plots: 4, stations: [] };
    for (const freezers of freezerCounts) yield { seed, shelves: 6, freezers, checkouts: 1, plots: 4, stations: [] };
    for (const checkouts of checkoutCounts) yield { seed, shelves: 6, freezers: 0, checkouts, plots: 4, stations: [] };
    for (const plots of plotCounts) yield { seed, shelves: 6, freezers: 0, checkouts: 1, plots, stations: [] };
    for (const stations of stationSets) yield { seed, shelves: 6, freezers: 0, checkouts: 1, plots: 4, stations };
    // A couple of "everything at once" shapes, where interactions bite.
    yield { seed, shelves: 18, freezers: 4, checkouts: 3, plots: 20, stations: ['blender', 'toaster'] };
    yield { seed, shelves: 2, freezers: 1, checkouts: 2, plots: 2, stations: ['blender'] };
  }
}

for (const opts of cases()) {
  const L = generateLayout(opts);
  const grid = buildWalkGrid(L);
  const at = (x, z) => (x < 0 || z < 0 || x >= L.w || z >= L.h ? -1 : L.tiles[z * L.w + x]);
  // "Is something standing here" is its own array now that a tile only says what
  // the floor is made of. Read straight off the layout rather than through
  // `blockedAt`, so this stays a statement about the generator's output rather
  // than an echo of the function the build rules use to read it.
  const taken = (x, z) => x >= 0 && z >= 0 && x < L.w && z < L.h && L.blocked[z * L.w + x] === 1;
  const walkable = (x, z) => x >= 0 && z >= 0 && x < L.w && z < L.h && grid[z * L.w + x] === 1;
  const where = `${opts.seed} sh=${opts.shelves} fz=${opts.freezers} co=${opts.checkouts} pl=${opts.plots} st=${opts.stations.length}`;

  // ---- 1. requested === placed -------------------------------------------
  check(L.shelves.length === opts.shelves + opts.freezers,
    'shelf units placed !== requested',
    `${where}: asked ${opts.shelves + opts.freezers}, got ${L.shelves.length}`);
  check(L.shelves.filter((s) => s.kind === 'freezer').length === opts.freezers,
    'freezers placed !== requested',
    `${where}: asked ${opts.freezers}, got ${L.shelves.filter((s) => s.kind === 'freezer').length}`);
  check(L.checkouts.length === opts.checkouts,
    'checkouts placed !== requested',
    `${where}: asked ${opts.checkouts}, got ${L.checkouts.length}`);
  check(L.plots.length === opts.plots,
    'plots placed !== requested',
    `${where}: asked ${opts.plots}, got ${L.plots.length}`);
  check((L.stations ?? []).length === opts.stations.length,
    'stations placed !== requested',
    `${where}: asked ${opts.stations.length}, got ${(L.stations ?? []).length}`);

  // ---- 2. nothing shares a tile -------------------------------------------
  const occupied = new Map();
  const claim = (x, z, what) => {
    const k = `${x},${z}`;
    if (occupied.has(k)) {
      check(false, 'two fixtures on one tile', `${where}: ${occupied.get(k)} and ${what} both at ${k}`);
    }
    occupied.set(k, what);
  };
  for (const s of L.shelves) claim(s.x, s.z, s.id);
  for (const c of L.checkouts) claim(c.x, c.z, c.id);
  for (const s of L.stations ?? []) claim(s.x, s.z, s.id);
  for (const p of L.plots) claim(p.x, p.z, p.id);

  // ---- 3. every fixture has a reachable working spot ----------------------
  for (const s of L.shelves) {
    check(taken(s.x, s.z),
      'shelf cell not occupied', `${where}: ${s.id} at ${s.x},${s.z}`);
    check(!walkable(s.x, s.z),
      'you can walk through a shelf', `${where}: ${s.id} at ${s.x},${s.z}`);
    check(walkable(s.browseAt.x, s.browseAt.z),
      'shelf browseAt not walkable', `${where}: ${s.id} browseAt ${s.browseAt.x},${s.browseAt.z}`);
    check(onShopFloor(L, s.browseAt.x, s.browseAt.z),
      'shelf browseAt outside the shop', `${where}: ${s.id} browseAt ${s.browseAt.x},${s.browseAt.z}`);
  }
  for (const st of L.stations ?? []) {
    check(walkable(st.useAt.x, st.useAt.z),
      'station useAt not walkable', `${where}: ${st.id} useAt ${st.useAt.x},${st.useAt.z}`);
    check(onShopFloor(L, st.useAt.x, st.useAt.z),
      'station useAt outside the shop', `${where}: ${st.id} useAt ${st.useAt.x},${st.useAt.z}`);
  }
  for (const p of L.plots) {
    // A plot is the one fixture that IS ground rather than standing on it, so it
    // digs its tile and blocks nobody — you walk over a bed to work it.
    check(at(p.x, p.z) === T.PLOT, 'plot tile not dug', `${where}: ${p.id} at ${p.x},${p.z}`);
    check(!taken(p.x, p.z), 'a plot should not block its own cell', `${where}: ${p.id}`);
    const reachable = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .some(([dx, dz]) => walkable(p.x + dx, p.z + dz));
    check(reachable, 'plot has no walkable neighbour', `${where}: ${p.id} at ${p.x},${p.z}`);
  }

  // ---- 4. queues stay indoors, and no two people stand in one place -------
  // The one that bit hardest: a queue slot on grass is a shopper the till can
  // never serve, and it looks fine in a screenshot.
  //
  // The lane turns corners now rather than running straight and then giving
  // every extra shopper the last slot, so "the slots are distinct" has to be
  // asserted rather than assumed — that used to be true by construction of the
  // straight run, and it is the exact claim the pile-up broke. Walking the real
  // lane also means each of these is checked around the bend, where a straight
  // run was never looking.
  const lanes = queueLanes(L);
  const standing = new Map();
  for (const t of L.checkouts) {
    check(taken(t.x, t.z), 'checkout cell not occupied', `${where}: ${t.id} at ${t.x},${t.z}`);
    check(walkable(t.serveAt.x, t.serveAt.z) && onShopFloor(L, t.serveAt.x, t.serveAt.z),
      'till serveAt not on the shop floor', `${where}: ${t.id} serveAt ${t.serveAt.x},${t.serveAt.z}`);

    const lane = lanes.get(t.id) ?? [];
    check(lane.length - 1 >= 1, 'till has nowhere to queue', `${where}: ${t.id} lane ${lane.length - 1}`);
    check(lane[0]?.x === t.serveAt.x && lane[0]?.z === t.serveAt.z,
      'a lane must start at the serving spot', `${where}: ${t.id}`);
    check(lane.length - 1 === t.queueMax, 'queueMax disagrees with the lane it was measured from',
      `${where}: ${t.id} queueMax ${t.queueMax} lane ${lane.length - 1}`);

    lane.forEach((c, i) => {
      check(walkable(c.x, c.z) && onShopFloor(L, c.x, c.z),
        'queue slot outside the shop floor', `${where}: ${t.id} slot ${i} at ${c.x},${c.z} (tile ${at(c.x, c.z)})`);
      // A line is a line: every place in it is one step from the one in front.
      // Without this a lane could jump a wall and still pass every other check.
      if (i > 0) {
        const p = lane[i - 1];
        check(Math.abs(c.x - p.x) + Math.abs(c.z - p.z) === 1,
          'queue slots are not adjacent', `${where}: ${t.id} slot ${i} at ${c.x},${c.z} after ${p.x},${p.z}`);
      }
      // The pile-up itself, stated: nobody shares a tile with anybody, in this
      // line or in the one at the next till.
      const key = `${c.x},${c.z}`;
      check(!standing.has(key), 'two shoppers stand on one tile',
        `${where}: ${t.id} slot ${i} at ${key}, already ${standing.get(key)}`);
      standing.set(key, `${t.id} slot ${i}`);
    });

    // Two tills must not try to serve the same shopper.
    const clash = L.checkouts.filter((o) => o !== t
      && o.serveAt.x === t.serveAt.x && o.serveAt.z === t.serveAt.z);
    check(clash.length === 0, 'two tills share a serving spot', `${where}: ${t.id} and ${clash[0]?.id}`);
  }

  // ---- 5. the whole shop is one connected space ---------------------------
  // Every working spot must be reachable on foot from the spawn, or someone
  // will path to it forever.
  const reach = flood(L, grid, L.spawn.x, L.spawn.z);
  const seen = (p) => reach.has(`${p.x},${p.z}`);
  check(seen(L.door), 'door unreachable from spawn', where);
  for (const s of L.shelves) {
    check(seen(s.browseAt), 'shelf unreachable from spawn', `${where}: ${s.id}`);
  }
  for (const t of L.checkouts) check(seen(t.serveAt), 'till unreachable from spawn', `${where}: ${t.id}`);
  for (const st of L.stations ?? []) check(seen(st.useAt), 'station unreachable from spawn', `${where}: ${st.id}`);
  for (const p of L.plots) {
    const ok = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => reach.has(`${p.x + dx},${p.z + dz}`));
    check(ok, 'plot unreachable from spawn', `${where}: ${p.id}`);
  }
  check(!L.bay || reach.has(`${Math.round(L.bay.x)},${Math.round(L.bay.z)}`),
    'delivery bay unreachable', where);
  check(!L.bay || at(Math.round(L.bay.x), Math.round(L.bay.z)) === T.BAY,
    'delivery bay is not a bay tile', `${where}: ${L.bay?.x},${L.bay?.z}`);
  // The other half of the yard. Same two claims, and one more: the pads must
  // not be the same place. They hold the same pallets, so a generator that let
  // them overlap would read as "the split didn't work" in exactly the way
  // nobody would think to check.
  check(!L.drop || reach.has(`${Math.round(L.drop.x)},${Math.round(L.drop.z)}`),
    'drop-off unreachable', where);
  check(!L.drop || at(Math.round(L.drop.x), Math.round(L.drop.z)) === T.DROP,
    'drop-off is not a drop tile', `${where}: ${L.drop?.x},${L.drop?.z}`);
  check(!L.drop || Math.hypot(L.drop.x - L.bay.x, L.drop.z - L.bay.z) >= 3,
    'the two yard pads are on top of each other',
    `${where}: bay ${L.bay?.x},${L.bay?.z} drop ${L.drop?.x},${L.drop?.z}`);

  // ---- 6. soil starts untilled -------------------------------------------
  for (const p of L.plots) {
    check(p.soil === undefined || p.soil === 'untilled',
      'plot did not start untilled', `${where}: ${p.id} soil=${p.soil}`);
  }
}

// ---------------------------------------------------------------------------
// Phase 2: hand-placed fixtures.
//
// A placement the generator honours must land on the exact tile asked for, and
// must not cost the shop a fixture — the procedural fill is supposed to make up
// the difference, not double up or come out short.
// ---------------------------------------------------------------------------

for (let s = 0; s < Math.min(SEEDS, 12); s++) {
  const seed = `place-${s}`;
  const base = { seed, shelves: 8, freezers: 2, checkouts: 2, plots: 8, stations: ['blender'] };
  const L0 = generateLayout(base);

  // Take real fixtures out of a generated layout and re-request them as explicit
  // placements — a round trip that must be a no-op.
  const placements = [
    ...L0.shelves.slice(0, 3).map((f, i) => ({
      id: `fx-s${i}`, kind: f.kind, x: f.x, z: f.z, rot: f.rot,
    })),
    ...L0.plots.slice(0, 2).map((f, i) => ({ id: `fx-p${i}`, kind: 'plot', x: f.x, z: f.z, rot: 0 })),
    ...L0.stations.slice(0, 1).map((f, i) => ({
      id: `fx-a${i}`, kind: 'station', station: f.station, x: f.x, z: f.z, rot: f.rot,
    })),
  ];

  const L = generateLayout({ ...base, placements });
  const grid = buildWalkGrid(L);
  const walkable = (x, z) => x >= 0 && z >= 0 && x < L.w && z < L.h && grid[z * L.w + x] === 1;
  const where = `${seed} with ${placements.length} placements`;

  check(L.shelves.length === base.shelves + base.freezers,
    'placements changed the shelf total',
    `${where}: expected ${base.shelves + base.freezers}, got ${L.shelves.length}`);
  check(L.plots.length === base.plots,
    'placements changed the plot total', `${where}: got ${L.plots.length}`);
  check(L.stations.length === base.stations.length,
    'placements changed the appliance total', `${where}: got ${L.stations.length}`);
  check((L.droppedPlacements ?? []).length === 0,
    'a valid placement was dropped', `${where}: ${(L.droppedPlacements ?? []).join(', ')}`);

  for (const p of placements) {
    const landed = [...L.shelves, ...L.plots, ...L.stations, ...L.checkouts].find((f) => f.id === p.id);
    check(!!landed, 'placement missing from the layout', `${where}: ${p.id}`);
    if (!landed) continue;
    check(landed.x === p.x && landed.z === p.z,
      'placement moved', `${where}: ${p.id} asked ${p.x},${p.z} got ${landed.x},${landed.z}`);
    const anchor = landed.browseAt ?? landed.serveAt ?? landed.useAt;
    if (anchor) {
      check(walkable(anchor.x, anchor.z),
        'placed fixture has no reachable working spot', `${where}: ${p.id}`);
    }
  }

  // Ids must never collide with the ones the generator mints for itself.
  const ids = [...L.shelves, ...L.plots, ...L.stations, ...L.checkouts].map((f) => f.id);
  check(new Set(ids).size === ids.length, 'duplicate fixture ids', `${where}`);

  // And a placement somewhere impossible must be rejected, not honoured.
  const bad = generateLayout({
    ...base,
    placements: [{ id: 'fx-bad', kind: 'shelf', x: 0, z: 0, rot: 0 }],
  });
  check(bad.droppedPlacements.includes('fx-bad'),
    'an impossible placement was accepted', `${seed}: shelf at 0,0`);
  check(bad.shelves.length === base.shelves + base.freezers,
    'a rejected placement cost the shop a fixture', `${seed}: got ${bad.shelves.length}`);
}

// ---------------------------------------------------------------------------
// Phase 3: bought floor area and a moved door.
//
// An extension has to actually add floor. The obvious implementation — treat it
// as a minimum size — gives back almost nothing, because the shop has usually
// already grown past the minimum to fit its own shelving.
// ---------------------------------------------------------------------------

for (let s = 0; s < Math.min(SEEDS, 8); s++) {
  const seed = `grow-${s}`;
  const base = { seed, shelves: 8, freezers: 2, checkouts: 2, plots: 8, stations: ['blender'] };
  const L0 = generateLayout(base);

  for (const [gw, gh] of [[3, 0], [0, 3], [3, 3], [6, 2]]) {
    const L = generateLayout({ ...base, grow: { w: gw, h: gh } });
    check(L.store.w === L0.store.w + gw,
      'bought width did not all arrive',
      `${seed}: +${gw} gave ${L0.store.w} -> ${L.store.w}`);
    check(L.store.h === L0.store.h + gh,
      'bought depth did not all arrive',
      `${seed}: +${gh} gave ${L0.store.h} -> ${L.store.h}`);
    check(L.shelves.length === base.shelves + base.freezers,
      'expanding changed the shelf count', `${seed}: got ${L.shelves.length}`);
    check(L.plots.length === base.plots,
      'expanding changed the plot count', `${seed}: got ${L.plots.length}`);
    check(L.checkouts.length === base.checkouts,
      'expanding changed the till count', `${seed}: got ${L.checkouts.length}`);
  }

  // The door slides along the south wall. The yard behind is anchored to the
  // *building* rather than to the door, on purpose — the pads sit at the two
  // ends of the back wall, so the service door lands between them however far
  // it has been dragged. What must hold is that both pads stay behind the
  // shop, stay apart, and stay walkable from the street.
  //
  // Through `withYard`, because the generator does not draw a pad any more: the
  // yard is ground somebody owns, seeded once by `defaultPads`. Asserting this
  // against a bare `generateLayout` would be asserting it against a shop that
  // legitimately has no yard at all.
  for (const shift of [-4, -2, 0, 2, 4]) {
    const L = withYard({ ...base, doorShift: shift });
    const grid = buildWalkGrid(L);
    check(L.door.x >= L.store.x && L.door.x + 1 < L.store.x + L.store.w,
      'moved door left the wall', `${seed}: shift ${shift} -> door ${L.door.x}`);
    check(L.bay.z < L.store.z && L.drop.z < L.store.z,
      'a yard pad is not behind the building', `${seed}: shift ${shift}`);
    check(Math.hypot(L.drop.x - L.bay.x, L.drop.z - L.bay.z) >= 3,
      'the yard pads collided after moving the door', `${seed}: shift ${shift}`);
    check(L.shelves.length === base.shelves + base.freezers,
      'moving the door changed the shelf count', `${seed}: shift ${shift}`);
    check(L.checkouts.length === base.checkouts,
      'moving the door changed the till count', `${seed}: shift ${shift}`);
    // And you can still get from the street round to both pads and back inside.
    const reach = flood(L, grid, L.spawn.x, L.spawn.z);
    check(reach.has(`${Math.round(L.bay.x)},${Math.round(L.bay.z)}`),
      'bay unreachable after moving the door', `${seed}: shift ${shift}`);
    check(reach.has(`${Math.round(L.drop.x)},${Math.round(L.drop.z)}`),
      'drop-off unreachable after moving the door', `${seed}: shift ${shift}`);
    check(reach.has(`${L.door.x},${L.door.z}`),
      'door unreachable after moving it', `${seed}: shift ${shift}`);
  }
}

// Deliberately the real validator rather than a copy of it. This used to be a
// second definition of "inside the shop", and when walls moved onto the edges
// the copy kept the old wall-ring geometry and reported 1200 phantom failures.
function onShopFloor(L, x, z) {
  return insideStore(L, x, z);
}

function flood(L, grid, sx, sz) {
  const seen = new Set();
  const start = `${Math.round(sx)},${Math.round(sz)}`;
  const stack = [[Math.round(sx), Math.round(sz)]];
  seen.add(start);
  while (stack.length) {
    const [x, z] = stack.pop();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const nz = z + dz;
      const k = `${nx},${nz}`;
      if (seen.has(k)) continue;
      if (nx < 0 || nz < 0 || nx >= L.w || nz >= L.h) continue;
      if (grid[nz * L.w + nx] !== 1) continue;
      seen.add(k);
      stack.push([nx, nz]);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Phase 4: the yard is ground somebody owns.
//
// The delivery bay and the drop-off used to be stamped by `compose` on every
// re-flow, which is exactly why they could never be moved: buying a shelf put
// them back. They are painted cells now, seeded once into the ground overlay by
// `defaultPads` and never touched by the generator again.
//
// That claim has two halves and both are invisible in a screenshot, because a
// seeded pad and a generated one look identical on day one:
//
//   - the generator, asked for a shop and given no ground, draws NO pad. If it
//     ever draws one again the two mechanisms are both live, and the one that
//     runs second wins on a re-flow — which is the bug this replaced, wearing
//     different clothes.
//   - a pad laid as ground comes back as a pad: right tiles, right count, and
//     reachable from the street, which is what the old assertions checked when
//     the generator was the thing making them.
// ---------------------------------------------------------------------------

for (let s = 0; s < Math.min(SEEDS, 8); s++) {
  const seed = `yard-${s}`;
  const base = { seed, shelves: 6, freezers: 1, checkouts: 1, plots: 6 };

  const bare = generateLayout(base);
  check(bare.bay === null && bare.drop === null,
    'the generator still draws its own yard pads', `${seed}`);
  check((bare.ground ?? []).length === 0,
    'a shop nobody has painted emits ground anyway', `${seed}`);

  const pads = defaultPads(bare);
  check(pads.length === 8, 'the seeded yard is not two 2x2 pads', `${seed}: ${pads.length} cells`);
  check(pads.every((c) => bare.tiles[c.z * bare.w + c.x] === T.GRASS),
    'the yard was seeded onto something that was not grass', `${seed}`);

  const L = generateLayout({ ...base, ground: pads });
  const grid = buildWalkGrid(L);
  const reach = flood(L, grid, L.spawn.x, L.spawn.z);

  for (const [kind, tile, pad] of [['bay', T.BAY, L.bay], ['drop', T.DROP, L.drop]]) {
    check(pad != null, `laying a ${kind} did not produce one`, `${seed}`);
    if (!pad) continue;
    check(pad.cells.length === 4, `the ${kind} is not the four cells it was laid as`,
      `${seed}: ${pad.cells.length}`);
    check(pad.cells.every((c) => L.tiles[c.z * L.w + c.x] === tile),
      `a ${kind} cell is not a ${kind} tile`, `${seed}`);
    // The point it reports has to be one of its own cells, or everything that
    // walks to a pad walks to a spot beside it.
    check(pad.cells.some((c) => c.x === pad.x && c.z === pad.z),
      `the ${kind}'s point is not one of its cells`, `${seed}: ${pad.x},${pad.z}`);
    check(pad.cells.some((c) => reach.has(`${c.x},${c.z}`)),
      `the ${kind} is unreachable from the street`, `${seed}`);
  }

  // They hold the same pallets, so a yard that let them overlap would read as
  // "the split didn't work" in exactly the way nobody would think to check.
  check(Math.hypot(L.drop.x - L.bay.x, L.drop.z - L.bay.z) >= 3,
    'the two yard pads are on top of each other', `${seed}`);

  // ...and the whole point: a re-flow leaves them exactly where they were. This
  // is the assertion the old generated pads could never fail and the new ones
  // could, so it is the one that matters.
  const again = generateLayout({ ...base, shelves: 9, ground: L.ground });
  check(JSON.stringify(again.bay?.cells) === JSON.stringify(L.bay.cells)
    && JSON.stringify(again.drop?.cells) === JSON.stringify(L.drop.cells),
    'buying a shelf moved the yard', `${seed}`);
}

// ---------------------------------------------------------------------------

/**
 * A layout with its yard laid, the way a real world gets one.
 *
 * Two passes because that is genuinely what happens: `Game.create` composes the
 * shop, `freezeYard` reads `defaultPads` off it and lays them into the ground
 * overlay, and the re-flow that follows is what puts bay tiles on the map.
 */
function withYard(opts) {
  const bare = generateLayout(opts);
  return generateLayout({ ...opts, ground: [...(opts.ground ?? []), ...defaultPads(bare)] });
}

const byLabel = new Map();
for (const f of failures) {
  if (!byLabel.has(f.label)) byLabel.set(f.label, []);
  byLabel.get(f.label).push(f.detail);
}

console.log(`\n${checks} assertions over ${SEEDS} seeds\n`);
if (failures.length === 0) {
  console.log('  ✅  every layout placed exactly what it was asked for, and all of it is reachable.\n');
  process.exit(0);
}

console.log(`  ❌  ${failures.length} failures across ${byLabel.size} invariants:\n`);
for (const [label, details] of [...byLabel].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(details.length).padStart(5)}x  ${label}`);
  const show = VERBOSE ? details : details.slice(0, 3);
  for (const d of show) console.log(`           ${d}`);
  if (!VERBOSE && details.length > show.length) console.log(`           …and ${details.length - show.length} more (-v for all)`);
  console.log();
}
process.exit(1);
