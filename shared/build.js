/**
 * BUILD RULES — where a fixture is allowed to go.
 *
 * Shared on purpose. The client needs this to colour the ghost red or green
 * sixty times a second, and the server needs it to be the authority on what
 * actually lands. If those two ever disagree the ghost lies to you, so there is
 * exactly one copy of the rules and both sides import it.
 *
 * Everything here is a pure function of `layout` + a placement spec. No content,
 * no game state, no money — those live on the server side of the fence.
 */

import { T, WALKABLE, BUILDABLE_INDOOR, BUILDABLE_OUTDOOR } from './tiles.js';
import { E, SOLID, edgeBetween, reachable, withEdge, computeIndoor } from './edges.js';

/**
 * What each buildable thing is. `anchor` is the tile you have to be able to
 * stand on to use it — a shelf you can't reach is scenery.
 *
 * This is the closed set, and it is closed on purpose: a kind is a set of
 * placement rules, which is behaviour, and behaviour lives in a file that can be
 * reviewed and diffed. What is *not* closed is how many designs name into one —
 * see `shared/pieces.js`. Kinds are code; pieces are content, and unlimited.
 *
 * `blocks` is the whole difference between the two halves below, and it is a
 * field you can read rather than a tile enum you have to be a member of. A
 * shelf owns its cell and pathing routes round it; a rug, a planter or a
 * hanging lamp sits in the cell without owning it. That used to be expressible
 * only as "which set is this tile value in", which is not something content —
 * or a second thing on the same cell — could ever reach.
 *
 * `ground` is the other half: a plot doesn't stand on the floor, it *is* the
 * floor, dug. So it changes what the cell is made of and blocks nobody.
 */
export const FIXTURES = {
  shelf: { label: 'Shelf', blocks: true, where: 'indoor', rotates: true, anchor: 'browseAt' },
  freezer: { label: 'Freezer', blocks: true, where: 'indoor', rotates: true, anchor: 'browseAt' },
  checkout: { label: 'Till', blocks: true, where: 'indoor', rotates: true, anchor: 'serveAt' },
  station: { label: 'Appliance', blocks: true, where: 'indoor', rotates: true, anchor: 'useAt' },
  plot: { label: 'Plot', blocks: false, ground: T.PLOT, where: 'outdoor', rotates: false, anchor: null },
  /**
   * Decorations. Both stand in a cell and neither blocks it.
   *
   * Deliberately NOT the authored-`blocks` kind the design doc describes. A
   * barrel that stops nobody is a lie you can see; a barrel that stops people
   * needs a tile stamp, and a tile can only say one thing at a time — which is
   * the whole reason step 5 exists. Until a cell can hold a list, "prop" means
   * "you walk past it", and that is true of everything below.
   */
  'prop-floor': { label: 'Decoration', blocks: false, where: 'any', rotates: true, anchor: null, at: 'floor' },
  'prop-ceiling': { label: 'Hanging', blocks: false, where: 'indoor', rotates: true, anchor: null, at: 'ceiling' },
};

/**
 * The one kind that is GROUND rather than something standing on it, which is
 * why it is not in `FIXTURES` above.
 *
 * Everything in that table answers "where may this stand, and who can reach
 * it". A floor answers neither: it is what the cell is *made of*, so it has no
 * anchor, blocks nobody, cannot be lifted, rotated or reached round the back,
 * and is painted over an area rather than placed on a tile. Giving it a row
 * there would mean five fields that are lies and a `canPlace` branch that skips
 * every rule in the function.
 *
 * It is still a build KIND, because it is still a thing content designs: "Oak
 * Boards" and "Chequer Tile" are rows in the same catalog a planter is a row
 * in, and `create_fixture` gates on this list.
 */
export const FLOOR_KIND = 'floor';

/** Every kind a piece may name. The closed vocabulary, in one place. */
export const BUILD_KINDS = [...Object.keys(FIXTURES), FLOOR_KIND];

/**
 * The kinds the generator has a budget for, and the kinds it doesn't.
 *
 * Read off `at` rather than off `blocks`, which they used to share: a plot
 * blocks nobody and is still very much a fixture you buy, own and count. A prop
 * is the thing with no budget, because nothing procedural ever places one.
 *
 * Both derive from `FIXTURES` rather than from `BUILD_KINDS`, so a floor is in
 * neither. It has no budget for the same reason a prop hasn't, and it is not a
 * fixture for a stronger one: nothing in the world is ever a floor, the ground
 * simply *is* one.
 */
export const PROP_KINDS = Object.keys(FIXTURES).filter((k) => FIXTURES[k].at != null);
export const FIXTURE_KINDS = Object.keys(FIXTURES).filter((k) => FIXTURES[k].at == null);

export const isProp = (kind) => FIXTURES[kind]?.at != null;

export const isFloor = (kind) => kind === FLOOR_KIND;

/** Does one of these own the cell it stands in? */
export const blocksCell = (kind) => FIXTURES[kind]?.blocks === true;


/**
 * Fraction of what a fixture cost that you get back for tearing it out.
 *
 * Shared for the same reason `canPlace` is: the fixture menu prints the refund
 * on the button *before* you press it, and the server is what actually pays it.
 * Two copies of that number is two different amounts of money.
 */
export const FIXTURE_REFUND = 0.5;

/** Quarter turns, clockwise from "anchor to the east" — which is how the
 *  procedural generator has always laid shelves out. */
const FACING = [
  { dx: 1, dz: 0 },
  { dx: 0, dz: 1 },
  { dx: -1, dz: 0 },
  { dx: 0, dz: -1 },
];

export const rot4 = (rot) => ((Math.round(rot) % 4) + 4) % 4;

/** The tile a worker or shopper stands on to use a fixture placed like this. */
export function anchorTile(x, z, rot) {
  const f = FACING[rot4(rot)];
  return { x: x + f.dx, z: z + f.dz };
}

/**
 * A step in model space, turned to face the way a fixture was actually stood.
 *
 * Models are authored facing east — rot 0 — so "the +z end of this unit" is
 * only a direction in the world once you know which way round it is. One
 * quarter turn takes +x to +z, which is the order `FACING` is indexed in.
 */
export function turn({ dx, dz }, rot) {
  let s = { dx, dz };
  for (let i = rot4(rot); i > 0; i--) s = { dx: -s.dz, dz: s.dx };
  return s;
}

/** For a till, the direction the queue trails off in: along the wall it faces. */
export function queueAxis(rot) {
  // Perpendicular to the serving direction, so the line forms beside the till
  // rather than stacking on top of the person being served.
  return rot4(rot) % 2 === 0
    ? [{ x: 0, z: 1 }, { x: 0, z: -1 }]
    : [{ x: 1, z: 0 }, { x: -1, z: 0 }];
}

// ---------------------------------------------------------------------------
// Reading a layout
// ---------------------------------------------------------------------------

export const tileAt = (L, x, z) =>
  (x < 0 || z < 0 || x >= L.w || z >= L.h ? -1 : L.tiles[z * L.w + x]);

/**
 * Is something standing in this cell?
 *
 * A mask, derived once by the generator from the fixture lists, rather than a
 * scan of those lists — because this is asked for every cell of a flood fill,
 * for every step of every path, sixty times a second while a ghost is up.
 *
 * `ignoreId` is the one thing that can un-block a cell: the fixture you are
 * currently moving has already left, as far as the question "may it go here"
 * is concerned, or a shelf could never be shuffled one square along. That costs
 * a list scan, which is why it is only paid when something is actually in the
 * air rather than folded into the mask.
 */
export function blockedAt(L, x, z, ignoreId = null) {
  if (x < 0 || z < 0 || x >= L.w || z >= L.h) return false;
  if (!L.blocked?.[z * L.w + x]) return false;
  if (!ignoreId) return true;
  const moving = fixturesOf(L).find((f) => f.id === ignoreId);
  return !(moving && Math.round(moving.x) === x && Math.round(moving.z) === z);
}

/**
 * Can a person be in this cell?
 *
 * Both halves, always: walkable ground *and* nothing standing on it. These were
 * one question while a tile said both at once, and separating them is the whole
 * of step 5 — the floor under a shelf is floor, and it goes back to being floor
 * the moment the shelf is sold.
 */
export const isWalkableTile = (L, x, z) =>
  WALKABLE.has(tileAt(L, x, z)) && !blockedAt(L, x, z);

/**
 * Is this cell indoors?
 *
 * Not "within the store rectangle" any more — within *anything the walls close
 * in*. The layout carries an `indoor` mask flooded from the map border through
 * the edges (`computeIndoor`, shared/edges.js), so an L-shaped shop, a lean-to
 * annex, a barn across the yard and a glasshouse in the middle of the field are
 * all indoors, and none of them is a case anybody had to write.
 *
 * Two consequences worth knowing, because they are rules now rather than
 * accidents. Floor you never enclosed is a patio — outdoors, so no shelf may go
 * on it. And a patch of grass you wall in is indoors, so no plot may be dug
 * there. Both fall out of asking the walls instead of asking the rect.
 *
 * The name is kept deliberately: it has call sites on both sides of the wire
 * and in two verify sweeps, and renaming it buys nothing a comment can't say.
 * The rect fallback is for a layout built before masks existed — the generator
 * has emitted one since edges landed.
 */
export function insideStore(L, x, z) {
  if (x < 0 || z < 0 || x >= L.w || z >= L.h) return false;
  if (L.indoor) return L.indoor[z * L.w + x] === 1;
  const s = L.store;
  return x >= s.x && x < s.x + s.w && z >= s.z && z < s.z + s.h;
}

/** How far a queue can run from `from` in `dir` before it leaves the shop. */
export function openRun(L, from, dir, max = 8, blocked = () => false) {
  let n = 0;
  for (let i = 1; i <= max; i++) {
    const x = from.x + dir.x * i;
    const z = from.z + dir.z * i;
    // A queue may not run through a wall, so the boundary crossed to reach each
    // successive tile counts as much as the tile itself.
    const prev = { x: x - dir.x, z: z - dir.z };
    if (SOLID.has(edgeBetween(L, prev.x, prev.z, x, z))) break;
    if (!insideStore(L, x, z) || !isWalkableTile(L, x, z) || blocked(x, z)) break;
    n++;
  }
  return n;
}

/**
 * May a wall, window or doorway go on this line?
 *
 * Same two answers as `canPlace`, and the same reasoning: off the map is
 * physics, but sealing your own shop is a *move*. You are allowed to wall off
 * the aisle, brick up the front door, or box a till into a cupboard — the game
 * says what it will cost and lets you, because a builder that refuses strange
 * buildings is a level editor with opinions.
 *
 * @param {object} spec { o: 'v'|'h', x, z, kind }
 */
export function canPlaceEdge(L, spec) {
  return canPlaceEdges(L, [spec], spec.kind ?? E.WALL);
}

/** Where a wall run from `start` to the far index `to` lays its segments. */
export function edgeRun(start, to, max = 40) {
  const o = start.o === 'v' ? 'v' : 'h';
  const x = Math.round(start.x);
  const z = Math.round(start.z);
  const end = to == null ? (o === 'v' ? z : x) : Math.round(to);
  const from = o === 'v' ? z : x;
  const lo = Math.min(from, end);
  const hi = Math.min(Math.max(from, end), lo + max - 1);
  const out = [];
  // A run follows the line it started on: a horizontal segment lies along x, a
  // vertical one along z. Turning a corner is a second drag, which is both
  // simpler to reason about and what a drawn wall actually wants.
  for (let i = lo; i <= hi; i++) out.push(o === 'v' ? { o, x, z: i } : { o, x: i, z });
  return out;
}

/**
 * The same question for a whole run at once.
 *
 * Asked once for the run rather than once per segment, because "does this seal
 * the shop" is only true of the run as a whole — no single segment of a wall
 * across the aisle seals anything, and validating them one at a time would
 * report no warning at all right up until the shop was shut.
 */
export function canPlaceEdges(L, segs, kind = E.WALL) {
  if (!segs?.length) return no('nothing to build');

  for (const s of segs) {
    const o = s.o;
    const x = Math.round(s.x);
    const z = Math.round(s.z);
    if (o !== 'v' && o !== 'h') return no('that is not a wall line');
    // A lattice line, not a cell: a vertical run has one more column than the
    // grid has cells, and vice versa. Off-by-one here writes into the next row.
    const maxX = o === 'v' ? L.w : L.w - 1;
    const maxZ = o === 'v' ? L.h - 1 : L.h;
    if (x < 1 || z < 1 || x > maxX - 1 || z > maxZ - 1) return no('off the edge of the world');
  }

  let probe = L;
  for (const s of segs) probe = withEdge(probe, s, kind);

  // Taking a wall out can't strand anybody — a hole only ever opens the way —
  // so a demolition skips every reachability question below. What it can still
  // do is un-roof, which is the half neither check used to cover.
  if (kind) {
    const from = L.spawn ?? L.door;
    const seen = reachable(probe, from.x, from.z);
    const at = (p) => seen.has(`${Math.round(p.x)},${Math.round(p.z)}`);

    if (!at(L.door)) return { ok: true, warn: 'that seals the shop — nobody can get in' };

    // A fixture asks a narrower question than "can anybody walk here", and it
    // has to since the yard behind the shop got its own door: the outside now
    // joins the two ends of any interior wall you can draw, so by the flood
    // above a partition straight across the aisles strands nothing at all. It
    // would go quiet on precisely the wall most worth warning about.
    //
    // What a shelf actually needs is to be reachable *on the shop floor* from
    // the front door — the trip a shopper makes. Out of the door, round the
    // building and in the back is a route, not a shop.
    //
    // Judged only on what is indoors after the change, so a shelf already out
    // on the patio isn't re-reported on every wall you ever draw; and skipped
    // entirely if the doorway itself ends up outdoors, which means the shell is
    // open rather than partitioned and is `whatThisUnroofs`'s story to tell.
    const after = computeIndoor(probe);
    const indoors = (x, z) => (x < 0 || z < 0 || x >= L.w || z >= L.h
      ? false
      : after[z * L.w + x] === 1);

    if (indoors(Math.round(L.door.x), Math.round(L.door.z))) {
      const onFloor = reachable(probe, L.door.x, L.door.z,
        (P, x, z) => indoors(x, z) && isWalkableTile(P, x, z));
      const joined = (p) => onFloor.has(`${Math.round(p.x)},${Math.round(p.z)}`);

      const stranded = fixturesOf(L)
        .map((f) => ({ f, spot: f.browseAt ?? f.serveAt ?? f.useAt }))
        .filter(({ f, spot }) => spot
          && indoors(Math.round(f.x), Math.round(f.z))
          && !joined(spot));
      if (stranded.length) {
        const what = FIXTURES[stranded[0].f.kind]?.label.toLowerCase() ?? 'fixture';
        return {
          ok: true,
          warn: stranded.length === 1
            ? `that cuts a ${what} off from the door`
            : `that cuts ${stranded.length} fixtures off from the door`,
        };
      }
    }
  }

  const roof = whatThisUnroofs(L, probe);
  return roof ? { ok: true, warn: roof } : { ok: true };
}

/**
 * What changing these edges would do to what counts as indoors.
 *
 * The half of "what will this cost me" that reachability cannot see. A shelf
 * has to be indoors and a plot has to be outdoors, and neither of those is about
 * being able to *walk* anywhere: knock the back wall through and a shelf nobody
 * touched is standing in a yard, wall the farm in and a bed nobody touched is in
 * a room. Both follow from `insideStore` meaning "whatever the walls close in",
 * so both arrived the day enclosure did and neither had anything watching for
 * it.
 *
 * This is also the answer to the demolition question docs/building.md left open.
 * Removal genuinely cannot strand a fixture the way placement can — that is why
 * it warned about nothing at all — but it can un-roof half the shop, and that is
 * worth being told before you swing rather than after.
 *
 * A consequence, not a refusal, exactly as everything else here is: putting your
 * shelving out in the weather is allowed, and the sim copes with it (a shelf
 * outdoors keeps its stock and keeps selling; what you lose is the right to
 * build another one beside it).
 */
function whatThisUnroofs(L, probe) {
  const after = computeIndoor(probe);
  const inside = (x, z) => (x < 0 || z < 0 || x >= L.w || z >= L.h
    ? false
    : after[z * L.w + x] === 1);

  const evicted = [];
  const roofed = [];
  for (const f of fixturesOf(L)) {
    const def = FIXTURES[f.kind];
    // `any` is a decoration, which is at home either way and has no opinion.
    if (!def || def.where === 'any') continue;
    const x = Math.round(f.x);
    const z = Math.round(f.z);
    // Only what this *changes*. Reported absolutely, a shop that already has a
    // shelf out on the patio would warn about it on every wall you ever drew,
    // and a warning that fires whatever you do is one nobody reads.
    const was = insideStore(L, x, z);
    const isIn = inside(x, z);
    if (was === isIn) continue;
    if (def.where === 'indoor' && !isIn) evicted.push(f);
    else if (def.where === 'outdoor' && isIn) roofed.push(f);
  }

  const label = (list) => FIXTURES[list[0].kind]?.label.toLowerCase() ?? 'fixture';
  if (evicted.length === 1) return `that leaves a ${label(evicted)} standing outside`;
  if (evicted.length) return `that leaves ${evicted.length} fixtures standing outside`;
  if (roofed.length === 1) return `that roofs over a ${label(roofed)} — nothing grows indoors`;
  if (roofed.length) return `that roofs over ${roofed.length} plots — nothing grows indoors`;
  return null;
}

// ---------------------------------------------------------------------------
// Laying a floor
//
// The third gesture, and the one that had been missing. A fixture is placed on
// a tile and a wall is drawn along a line; a floor is painted over an AREA,
// because "make this corner of the yard into shop" is a region and clicking it
// out one square at a time is not something anybody does twice.
//
// What it changes is `tiles` and only `tiles` — GRASS becomes FLOOR, FLOOR
// becomes GRASS — which is the whole reason it needed no new tile kinds. Every
// rule that already reads the ground reads the new ground for free: a shelf
// still needs `BUILDABLE_INDOOR`, a plot still needs bare grass, and both stay
// exactly as strict as they were. Which design of floor it is rides in a
// separate layer entirely (`layout.floors`), because a look must never be able
// to change what may stand somewhere.
//
// The pairing with walls is the point. Since enclosure replaced the store rect
// you could already wall off an annex, and it counted as indoors — and then
// refused every shelf you tried to put in it, because the ground under it was
// still grass. Walls said "this is a room" and nothing could say "this is a
// floor". That is the missing half, and it is why a floor tool is also the
// answer to "how do I make my shop bigger".
// ---------------------------------------------------------------------------

/**
 * Longest side of one paint stroke.
 *
 * A cap on the gesture, not on how much floor you may own — drag again. It is
 * here because a stroke is charged and re-flowed as one action: the drag has to
 * arrive as two corners (the 4KB inbound cap), it is priced per cell, and every
 * cell of it is validated before any of it is paid for.
 */
export const FLOOR_STROKE_MAX = 16;

/**
 * The cells a drag from `start` to `to` would paint.
 *
 * Clamped around `start` rather than around the lower corner, which is the one
 * place this differs from `edgeRun` and is a deliberate fix rather than a
 * divergence: clamping a rect by its minimum trims the corner you began the
 * drag on, so an oversized stroke up and to the left walks away from your
 * finger instead of stopping under it.
 */
export function floorStroke(start, to, max = FLOOR_STROKE_MAX) {
  const x0 = Math.round(start.x);
  const z0 = Math.round(start.z);
  const near = (from, end) => (end > from
    ? Math.min(end, from + max - 1)
    : Math.max(end, from - max + 1));
  const x1 = to == null ? x0 : near(x0, Math.round(to.x));
  const z1 = to == null ? z0 : near(z0, Math.round(to.z));
  const out = [];
  for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) out.push({ x, z });
  }
  return out;
}

/**
 * Which design of floor is painted on each cell, as a lookup.
 *
 * The layer that carries the *look*, kept clear of `tiles`, which carries what
 * may stand there. Sparse and rebuilt per call rather than emitted as a
 * full-grid array: an unpainted shop sends nothing at all, and the alternative
 * is a second w×h array on the wire on every re-flow to say "plain" 500 times.
 */
export function floorIndex(L) {
  const m = new Map();
  for (const f of L?.floors ?? []) m.set(`${f.x},${f.z}`, f.p);
  return m;
}

export const floorPieceAt = (L, x, z) => floorIndex(L).get(`${x},${z}`) ?? null;

/**
 * May this stroke be painted?
 *
 * Same two answers as everything else here, and the split falls in a slightly
 * different place because a floor is ground: almost all of this is physics.
 * There is no "you could seal yourself in" to warn about, since floor and grass
 * are both walkable and swapping one for the other cuts nothing off from
 * anything.
 *
 * The one refusal that is worth spelling out is taking floor out from under
 * something standing on it. That reads like the kind of consequence this
 * codebase usually allows you to cause — and it isn't, because the generator
 * would not leave the shelf standing on grass, it would DROP the placement on
 * the next re-flow and refund it. A tool that quietly sells your shelving and
 * its stock back is not a choice anybody made; it is a bulldozer wearing a
 * paintbrush. So it is a no, and the bulldozer is right there.
 *
 * @param {object} L        the layout
 * @param {object[]} cells  [{x, z}], from `floorStroke`
 * @param {?string} piece   which design to lay, or null to take the floor up
 */
export function canPaintFloor(L, cells, piece = null) {
  if (!cells?.length) return no('nothing to lay');
  const laying = piece != null;
  const painted = floorIndex(L);

  let changed = 0;
  let bared = 0;
  for (const c of cells) {
    const x = Math.round(c.x);
    const z = Math.round(c.z);
    if (x < 1 || z < 1 || x >= L.w - 1 || z >= L.h - 1) return no('off the edge of the world');

    const ground = tileAt(L, x, z);
    if (laying) {
      // Only ever over plain ground. Everything else a cell can be made of is
      // something with a job — a bed, the delivery bay, the drop-off, the path
      // out to the fields — and paving one over would take that job away
      // silently, with no fixture removed and nothing to put back.
      if (ground !== T.GRASS && ground !== T.FLOOR) return no(groundIsBusy(ground));
      // Restyling counts. Floor that is already floor still changes hands when
      // the design differs, which is most of what this tool is for — asking
      // only whether the GROUND moved would report a whole shop re-tiled as
      // "nothing to do".
      if (ground !== T.FLOOR || (painted.get(`${x},${z}`) ?? null) !== piece) changed++;
    } else {
      if (ground !== T.FLOOR) continue;              // nothing to take up
      // See above: this would drop the fixture rather than strand it.
      if (blockedAt(L, x, z)) return no('something is standing on it');
      changed++;
      if (insideStore(L, x, z)) bared++;
    }
  }

  if (!changed) return { ok: true, unchanged: true };

  // The one genuine consequence, and it only exists in one direction. Bare
  // ground indoors is a cell nothing can ever use: a shelf needs floor and a
  // bed needs to be outdoors, so it is not a patch of garden in your shop, it
  // is a hole. Allowed, because knocking your own floor out is a move and the
  // sim copes with it perfectly well — people walk over it.
  if (bared) {
    return {
      ok: true,
      warn: bared === 1
        ? 'that leaves bare ground indoors — nothing can be built or dug on it'
        : `that leaves ${bared} cells of bare ground indoors — nothing can be built or dug on them`,
    };
  }
  return { ok: true };
}

const groundIsBusy = (ground) => {
  if (ground === T.PLOT) return 'there is a bed there — clear it first';
  if (ground === T.BAY) return 'that is the delivery bay';
  if (ground === T.DROP) return 'that is the drop-off';
  if (ground === T.PATH) return 'that is the path out to the fields';
  return 'you can only lay floor over bare grass';
};

/** Every fixture currently in the layout, as uniform placement specs. */
export function fixturesOf(L) {
  const out = [];
  for (const s of L.shelves ?? []) out.push({ kind: s.kind === 'freezer' ? 'freezer' : 'shelf', ...s });
  for (const c of L.checkouts ?? []) out.push({ kind: 'checkout', ...c });
  for (const s of L.stations ?? []) out.push({ kind: 'station', ...s });
  for (const p of L.plots ?? []) out.push({ kind: 'plot', ...p });
  // Props carry their own kind, because there is more than one and they are not
  // told apart by which list they came out of.
  for (const p of L.props ?? []) out.push({ ...p });
  return out;
}

// ---------------------------------------------------------------------------
// The actual rule
// ---------------------------------------------------------------------------

/**
 * May this fixture go here?
 *
 * Two different answers, and the difference is the whole design.
 *
 * `ok: false` is physics — the tile is taken, or off the map, or a plot is
 * being dug in the shop. There is nowhere for the thing to be.
 *
 * `ok: true` with a `warn` is a *consequence*. Walling a shelf in, sealing the
 * doorway, standing a till where nobody can queue: all of that is allowed, and
 * it is allowed on purpose. A shelf nobody can reach simply never sells, and
 * the sim already copes — a shopper who can't path to a shelf writes it off and
 * picks another, one who can't reach the door leaves, staff cool down and find
 * another job. So the game says what it will cost you and lets you do it, which
 * is a game; refusing would be a level editor with opinions.
 *
 * The one caller that must still refuse a warning is the layout *generator* —
 * a procedurally furnished shop nobody can walk through is a bug, not a choice.
 * `canPlaceCleanly` is that caller's entry point.
 *
 * @param {object} L      the layout
 * @param {object} spec   { kind, x, z, rot }
 * @param {object} [opts] { ignoreId } — the fixture being moved, so it doesn't
 *                        block its own new position when they overlap.
 * @returns {{ok: boolean, reason?: string, warn?: string}}
 */
export function canPlace(L, spec, { ignoreId = null } = {}) {
  const def = FIXTURES[spec.kind];
  if (!def) return no(`"${spec.kind}" is not something you can build`);

  const x = Math.round(spec.x);
  const z = Math.round(spec.z);
  if (x < 1 || z < 1 || x >= L.w - 1 || z >= L.h - 1) return no('off the edge of the world');

  if (isProp(spec.kind)) return canPlaceProp(L, def, x, z, ignoreId);

  // Two questions where there used to be one, because a tile used to answer
  // both. What the ground is made of is `tiles`; whether something already
  // stands on it is `blocked`. A plot digs the ground, so it asks about grass;
  // everything else stands on the floor.
  const ground = tileAt(L, x, z);
  const taken = blockedAt(L, x, z, ignoreId);

  if (def.where === 'indoor') {
    if (!insideStore(L, x, z)) return no('that has to go inside the shop');
    if (taken) return no('something is already there');
    if (!BUILDABLE_INDOOR.has(ground)) {
      return no(ground === T.DOOR ? 'not in the doorway' : 'something is already there');
    }
  } else {
    if (insideStore(L, x, z)) return no('plots go outside, on the grass');
    if (taken) return no('something is already there');
    if (!BUILDABLE_OUTDOOR.has(ground)) return no('you can only dig into bare grass');
  }

  const warn = whatThisCosts(L, { ...spec, x, z }, def, { ignoreId });
  return warn ? { ok: true, warn } : { ok: true };
}

/**
 * May a decoration stand here?
 *
 * Much shorter than the fixture rule, and that is the point rather than an
 * omission. A prop stamps no tile, so it cannot cut a shelf off, cannot seal a
 * doorway and cannot leave a queue nowhere to form — every warning `canPlace`
 * has to reason about is about *occupying* a cell, and this doesn't. So there
 * are no soft answers here at all: what remains is genuine physics.
 *
 * One prop to a cell, though, and that is not fussiness. The pointer names a
 * cell (`fixtureAt`), so two things stacked on one is a menu you cannot open —
 * the same reason build mode aims at named targets rather than at whatever is
 * nearest. A cell holds one thing you can point at.
 */
function canPlaceProp(L, def, x, z, ignoreId) {
  if (def.where === 'indoor' && !insideStore(L, x, z)) return no('that has to go inside the shop');
  // A prop stands *in* the cell, so the cell has to be somewhere a person could
  // stand. This is also what keeps one out of a shelf without a second rule.
  if (!WALKABLE.has(tileAt(L, x, z)) || blockedAt(L, x, z, ignoreId)) {
    return no('something is already there');
  }
  const clash = (L.props ?? []).some((p) => p.id !== ignoreId && p.x === x && p.z === z);
  if (clash) return no('something is already there');
  return { ok: true };
}

/**
 * `canPlace`, for the one caller that cannot live with a warning: the layout
 * generator. It furnishes a shop nobody has looked at yet, so "you could seal
 * this off if you wanted to" is not an offer it can accept on your behalf.
 */
export function canPlaceCleanly(L, spec, opts = {}) {
  const r = canPlace(L, spec, opts);
  return r.ok && r.warn ? no(r.warn) : r;
}

const no = (reason) => ({ ok: false, reason });

/**
 * What placing this here would cost you, or null if it costs nothing.
 *
 * Every one of these used to be a refusal. They are the same checks, asked as
 * "what happens" rather than "may I" — so the order matters only in that the
 * most specific answer should come out first.
 */
function whatThisCosts(L, spec, def, { ignoreId }) {
  const { x, z } = spec;
  // Where a person could stand, with the thing being moved treated as already
  // gone and the thing being placed treated as already there.
  const open = (tx, tz) => WALKABLE.has(tileAt(L, tx, tz))
    && !blockedAt(L, tx, tz, ignoreId)
    && !(tx === x && tz === z && def.blocks);

  // ---- can anything use it, facing that way? -----------------------------
  if (def.anchor) {
    const a = anchorTile(x, z, spec.rot ?? 0);
    if (!open(a.x, a.z)) return 'nothing can use it facing that way';
    if (!insideStore(L, a.x, a.z)) return 'it faces out of the shop — nobody will use it';
  } else if (!FACING.some((f) => open(x + f.dx, z + f.dz))) {
    return 'nothing can get to it';
  }

  // ---- a till wants a queue ----------------------------------------------
  if (spec.kind === 'checkout') {
    const serve = anchorTile(x, z, spec.rot ?? 0);
    const clash = (L.checkouts ?? []).some((c) => c.id !== ignoreId
      && c.serveAt?.x === serve.x && c.serveAt?.z === serve.z);
    if (clash) return 'another till already serves that spot';
    // Measured against a shop with this till already standing in it, which used
    // to mean cloning the tile array. A mask is cheaper to say "and this one" to.
    const probe = { ...L, blocked: withBlocked(L, x, z) };
    const best = Math.max(...queueAxis(spec.rot ?? 0).map((d) => openRun(probe, serve, d)));
    if (best < 1) return 'no room for a queue — shoppers will pile up on one tile';
  }

  // ---- and what it cuts off ----------------------------------------------
  return whatThisBlocks(L, spec, def, ignoreId);
}

/**
 * A copy of the occupancy mask with one more cell taken.
 *
 * `removedTiles`, `baseTile` and `withTile` all lived here and all retired with
 * the stamp: there is no longer any difference between "what this tile is" and
 * "what this tile would be with nothing on it", because a tile never carried a
 * fixture in the first place. That is the simplification step 5 was for.
 */
function withBlocked(L, x, z) {
  const copy = Uint8Array.from(L.blocked ?? new Uint8Array(L.w * L.h));
  copy[z * L.w + x] = 1;
  return copy;
}

/**
 * Would putting this here cut something off — and if so, what?
 *
 * Returns the reason, or null when everything is still reachable. It answers
 * *which* thing rather than a flat yes/no because the two ways to fail read
 * completely differently to whoever is holding the shelf: one tile over is
 * where a shopper stands to reach the unit behind, and being told that "blocks
 * the way through" sends you looking for a corridor that was never the problem.
 *
 * The flood starts at the door, because that is where shoppers come in — a
 * pocket of floor nobody can walk to is not floor.
 */
function whatThisBlocks(L, spec, def, ignoreId) {
  // The flood runs over the *occupancy* mask now rather than a doctored copy of
  // the ground. The thing being moved has already left as far as this is
  // concerned — or a shelf could never be shuffled one square along — and the
  // thing being placed is treated as already standing there.
  const blocked = Uint8Array.from(L.blocked ?? new Uint8Array(L.w * L.h));
  if (ignoreId) {
    for (const f of fixturesOf(L)) {
      if (f.id === ignoreId) blocked[f.z * L.w + f.x] = 0;
    }
  }
  if (def.blocks) blocked[spec.z * L.w + spec.x] = 1;

  const probe = { ...L, blocked };
  const seen = new Set();
  const stack = [[L.door.x, L.door.z]];
  seen.add(`${L.door.x},${L.door.z}`);
  while (stack.length) {
    const [cx, cz] = stack.pop();
    for (const f of FACING) {
      const nx = cx + f.dx;
      const nz = cz + f.dz;
      const k = `${nx},${nz}`;
      if (seen.has(k)) continue;
      if (SOLID.has(edgeBetween(probe, cx, cz, nx, nz))) continue;
      if (!isWalkableTile(probe, nx, nz)) continue;
      seen.add(k);
      stack.push([nx, nz]);
    }
  }

  const reaches = (p) => seen.has(`${Math.round(p.x)},${Math.round(p.z)}`);
  const isHere = (p) => Math.round(p.x) === spec.x && Math.round(p.z) === spec.z;
  const label = (kind) => FIXTURES[kind]?.label.toLowerCase() ?? 'fixture';

  // Whatever you are placing has to be usable itself, and standing somewhere
  // walkable is not the same as standing somewhere you can walk *to*.
  if (def.anchor) {
    const mine = anchorTile(spec.x, spec.z, spec.rot ?? 0);
    if (!reaches(mine)) return 'you could never get round to that side of it';
  }

  for (const f of fixturesOf(L)) {
    if (f.id === ignoreId) continue;
    if (f.kind === 'plot') {
      // A bed is worked from any side, so it only needs one of them.
      const anySide = FACING.some((d) => reaches({ x: f.x + d.dx, z: f.z + d.dz }));
      if (!anySide) return 'that would leave a plot with no way in';
      continue;
    }
    const a = f.browseAt ?? f.serveAt ?? f.useAt;
    if (!a) continue;
    if (isHere(a)) return `that is where you stand to use the ${label(f.kind)} behind it`;
    if (!reaches(a)) return `that would cut off a ${label(f.kind)} you own`;
  }

  if (!reaches(L.spawn)) return 'that would block the way through';
  if (L.bay && !reaches(L.bay)) return 'that would cut the delivery bay off';
  if (L.drop && !reaches(L.drop)) return 'that would cut the drop-off off';
  return null;
}
