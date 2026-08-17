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
import {
  E, SOLID, RULED, edgeBetween, reachable, withEdge, computeIndoor, shopperCanCross,
} from './edges.js';

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
 *
 * `behind` is the second working spot, and only a till has one. Everything else
 * in this table is used from ONE side by ONE person: a shopper browses a shelf,
 * a worker loads an appliance, and the far side is the back of the unit. A
 * counter is used from both sides at once, by two different people, and the
 * shop only works when both of them can stand where they need to.
 *
 * `ends` is a *softer* claim than either, and the difference is what it is FOR.
 * `anchor` is the spot the generator reserves, floods for reachability and
 * routes a walk to — one tile, chosen when the thing was laid, and everything
 * that has to agree on a single answer reads it. `ends` says you can also work
 * the unit from either END of it, which is simply true of a shelf and of a
 * machine and is nobody's decision: you walk up to the side of a display unit
 * and put a loaf on it, and the shop refusing that is the shop being wrong
 * about its own furniture.
 *
 * So it deliberately changes only *reach* and what the markers draw. Widening
 * `anchor` would mean the generator reserving three tiles per shelf and
 * `canPlace` accepting a unit whose front is walled in, which is a different
 * and much larger change to what a shop is allowed to look like.
 *
 * A till has no `ends` on purpose. Its two spots are ROLES — one for the person
 * being served and one for the person serving — and a third tile at the end of
 * the counter is neither of those; it is somebody standing at the side of a
 * till, which is not a thing anybody does.
 *
 * The BACK is a fact about the piece rather than the kind, and it is the one
 * piece of this that content owns: `open` on a `fixtures` row (see
 * `shared/pieces.js`). A shelving unit has a back panel and a produce table has
 * four legs, and those are the same kind wearing two shapes — so which of them
 * you can walk all the way round cannot be answered here. It is deliberately
 * NOT a variant: a variant is a look and may never move a number, and how many
 * sides a unit can be worked from moves how a shop flows. See `spotsOf`.
 *
 * It was hardcoded as `{ x: till.x, z: till.z - 1 }` in `server/sim/staff.js`
 * before it was a field — "one tile north", which is right for exactly the
 * facing the generator happens to use and wrong for the other three. Turning a
 * till sent the clerk to a wall, or to a shelf, or onto the head of the queue,
 * and nothing refused the rotation because nothing knew the spot existed.
 * `anchor` was validated, reserved, drawn under the ghost and flooded for
 * reachability; this one was a literal in a job function.
 */
export const FIXTURES = {
  shelf: { label: 'Shelf', blocks: true, where: 'indoor', rotates: true, anchor: 'browseAt', ends: true },
  freezer: { label: 'Freezer', blocks: true, where: 'indoor', rotates: true, anchor: 'browseAt', ends: true },
  /**
   * The hot counter — a freezer pointed the other way, and the third and last
   * thing a unit of shelving can be.
   *
   * Every field on this row is a copy of the freezer's, which is the argument
   * for it being a kind at all rather than a field on the `fixtures` piece: the
   * two are identical in the things a kind decides — where it may stand, which
   * side you browse it from, whether you can walk round the back. What they
   * disagree about is WHAT MAY GO ON IT, and that is read off `shelf.kind`
   * everywhere in the sim. A `keeps: 'hot'` column on the piece would mean
   * every one of those sites resolving a placement back to its catalog row to
   * ask a question the placement already had the answer to.
   *
   * The kitchen is why it exists. Raw `chicken` is `needs-freezer` and the
   * `roast-chicken` it becomes required nothing at all, so the shop took
   * something out of a freezer, cooked it, and stood it on a wooden shelf next
   * to the bread — for as long as there had been a kitchen. `needs-warmer` is
   * the other half of a tag that was only ever written down cold.
   */
  warmer: { label: 'Hot Counter', blocks: true, where: 'indoor', rotates: true, anchor: 'browseAt', ends: true },
  checkout: {
    label: 'Till', blocks: true, where: 'indoor', rotates: true,
    anchor: 'serveAt', behind: 'tendAt',
  },
  station: { label: 'Appliance', blocks: true, where: 'indoor', rotates: true, anchor: 'useAt', ends: true },
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
 * The kinds that are GROUND rather than something standing on it, which is why
 * none of them is in `FIXTURES` above.
 *
 * Everything in that table answers "where may this stand, and who can reach
 * it". Ground answers neither: it is what the cell is *made of*, so it has no
 * anchor, blocks nobody, cannot be lifted, rotated or reached round the back,
 * and is painted over an area rather than placed on a tile. Giving one a row
 * there would mean five fields that are lies and a `canPlace` branch that skips
 * every rule in the function.
 *
 * They are still build KINDS, because they are still things content designs:
 * "Oak Boards" and "Chequer Tile" are rows in the same catalog a planter is a
 * row in, and `create_fixture` gates on this list.
 *
 * `floor` was the only one until the yard pads came in here. The delivery bay
 * and the drop-off were generated furniture — two 2x2 patches the generator
 * stamped against the back wall, that you could neither move, resize nor get
 * rid of — and they are ground in exactly the sense floor is: a cell is made of
 * bay, nothing stands on it. So they became two more designs for the same
 * brush rather than a second mechanism, which is the whole reason `tile` is a
 * field here: one painter, and the KIND of what you painted decides what the
 * cell becomes.
 *
 * The difference between them, and the only one: a floor is a *look*, and a pad
 * is a *job*. `verify:floor` pins the first half — two floors of different
 * colours must produce byte-identical `tiles` — and `pad` is how the second
 * half says so out loud, because a cell that says "deliveries land here" is
 * carrying meaning no colour ever could.
 *
 * `does` is that job in one sentence, and it is a field rather than prose in
 * `docs/fixtures.md` because the generated doc used to branch on the kind id to
 * describe it — two pads, one ternary, and a third would have read as the
 * second. Whatever a pad is for, the row that defines it is where it says so.
 */
export const GROUND = {
  floor: { label: 'Floor', tile: T.FLOOR },
  bay: {
    label: 'Delivery Bay',
    tile: T.BAY,
    pad: true,
    does: 'wholesale orders land here, and how big you paint it is how many crates it holds',
    lastGone: 'that is your last delivery bay — an order would have nowhere to land',
  },
  drop: {
    label: 'Storage',
    tile: T.DROP,
    pad: true,
    does: 'hands are cleared here and stock waits, and how big you paint it is how much waits at once',
    lastGone: 'that is your last storage tile — there would be nowhere to put goods down',
  },
  /**
   * The break area — the first pad that holds people rather than goods.
   *
   * A break has always happened *somewhere*: `PASTIME_SPOTS` names the back of
   * the yard, the front step or the till, which is a pastime saying where it
   * looks right rather than the shop saying where its staff go. This is the
   * shop's answer, and it outranks all of them (`spotFor`, server/sim/staff.js).
   *
   * It is ground rather than a bench on two counts. A bench is one worker and a
   * facing, so a second hire needs a second bench and the shop needs to know
   * which is free; an area is however big you painted it, and one cell seats one
   * person with no fixture, no anchor and no rotation. And it is what makes the
   * size mean something in the same breath the yard does: paint one cell and one
   * hire rests in it while the rest take theirs where they stand.
   *
   * Losing it is a warning rather than a refusal, because the fallback is
   * genuinely the whole of what the game did before — a shop with no break area
   * plays exactly as it always has.
   */
  break: {
    label: 'Break Area',
    tile: T.BREAK,
    pad: true,
    does: 'staff take their breaks here, and how big you paint it is how many of them it seats at once',
    lastGone: 'that is your last break tile — staff would go back to resting wherever they finished',
  },
  /**
   * The car park — the fourth pad, and the first that is not the shop's own
   * ground at all.
   *
   * The bay and the drop-off hold the shop's goods; the break area holds the
   * shop's people. This one holds the people who came to *buy*, which is the
   * whole reason it is neither Yard nor Staff in the palette — filing it beside
   * the bay would put it behind the one word that says it is about stock, and
   * filing it beside the break area would put it behind the one word that says
   * it is about the payroll.
   *
   * Mechanically it is nothing new, and that is the argument for it being ground
   * rather than a fixture with parking bays drawn on it: it is the same brush,
   * the same "how big you paint it is how many it holds" the yard already
   * teaches, and the same one-cell-one-occupant the break area already teaches.
   * Nothing seeds one either, for the break area's reason — a shop with no car
   * park is every shop that exists today, and it plays exactly as it always has.
   *
   * Everything on this row is true of the ground the day it is painted: it is
   * walkable, it is never buildable (`BUILDABLE_INDOOR` is floor and
   * `BUILDABLE_OUTDOOR` is grass, so a pad is neither without a word being
   * written), and it belongs outdoors — indoors it is the same hole a bay is,
   * with the same warning. Who arrives on it and what having driven is worth is
   * step 4b of docs/deliveries.md. The ground goes first deliberately: a
   * mechanic with nowhere to happen is one nobody can measure.
   */
  park: {
    label: 'Car Park',
    tile: T.PARK,
    pad: true,
    does: 'shoppers who drive here leave the car, and how big you paint it is how many of them can',
    lastGone: 'that is your last parking space — nobody would be able to drive to the shop',
  },
  /**
   * The road — the fifth ground kind and the second that is only a *look*.
   *
   * `floor` is the other one, and the pair is the whole taxonomy: the four pads
   * between them carry a job (`pad: true`, and a `does` sentence saying what),
   * and these two carry nothing but a surface. That is why this row is four
   * fields and a bay is six.
   *
   * **It is a preference, never a requirement**, and everything else about it
   * follows from that. `DRIVABLE` in `server/layout.js` has included `GRASS`
   * since the van first drove — every outdoor cell in the game is already a
   * road — so what a painted one changes is which lane the finder *chooses*,
   * by weighing a road cell cheaper than the grass beside it. Pointed the other
   * way, as ground a vehicle must have, it would be a brush that breaks every
   * shop in the world on the re-flow after it ships: no road, no lane, no van.
   *
   * It is also the reason the ring stopped being a technicality. One lorry for
   * six seconds a run could drive over a lawn and nobody minded — that is the
   * argument step 3 of docs/deliveries.md used to turn this down. A dozen
   * shoppers' cars using the same stretch is the busiest ground on the map, and
   * the thing you notice is that it is grass.
   */
  road: {
    label: 'Road',
    tile: T.ROAD,
  },
  /**
   * The pavement — the road's pedestrian twin, and the one ground kind that was
   * already in the game before it had a row.
   *
   * `T.PATH` is the strip the generator lays from the door out to the fields.
   * It has been a tile since long before ground was paintable, so it was
   * hardcoded scenery in exactly the way the delivery bay and the drop-off were
   * before step 13 of docs/building.md — a thing you could see, could not move,
   * and could not have more of. Giving it a kind is the same promotion, and it
   * costs one row: no new enum, no new colour, no renderer change. The generated
   * strip becomes ground you could have painted, which is the yard's rule the
   * other way round.
   *
   * It does the same job for people that a road does for vehicles — `findPath`
   * charges a step across anything else outdoors slightly more — and the two are
   * deliberately the same shape, down to the preference never being cheaper than
   * an ordinary step. What makes it *not* simply the road is that both are true
   * of it at once: `T.PATH` is in `DRIVABLE` and always has been, so a design of
   * this kind painted across a road is a **crossing** — the place the pavement
   * and the lane are the same cell — and that is content rather than a kind.
   */
  path: {
    label: 'Pavement',
    tile: T.PATH,
  },
};

export const FLOOR_KIND = 'floor';

/** Every kind a piece may name. The closed vocabulary, in one place. */
export const GROUND_KINDS = Object.keys(GROUND);
export const BUILD_KINDS = [...Object.keys(FIXTURES), ...GROUND_KINDS];

/** The ground kinds that carry a job rather than only a look. */
export const PAD_KINDS = GROUND_KINDS.filter((k) => GROUND[k].pad);

/**
 * The kinds that hold GOODS — the three things a unit of shelving can be.
 *
 * They all live in `layout.shelves`, and every one of them is browsed, stocked,
 * reserved, spoiled and re-flowed by the same code. What separates them is only
 * which items may sit on them, which is `requiredFixture` in `shared/tags.js`
 * answering with a kind from this list.
 *
 * It exists because there were two of them and the test was therefore a
 * BOOLEAN. `s.kind === 'freezer' ? 'freezer' : 'shelf'` was written in six
 * files, and every stocking rule in the game was some spelling of
 * `(itemIsFrozen) === (shelfIsFreezer)` — correct, and true only while there is
 * nothing else a shelf can be. A third kind turns every one of those into a
 * silent bug rather than a compile error: a hot counter reads as `'shelf'`,
 * accepts bread, and refuses the roast chicken it was bought for. So the
 * normalisation is here, once, and it is a lookup rather than a ternary.
 */
export const STOCK_KINDS = ['shelf', 'freezer', 'warmer'];

/**
 * Which of `STOCK_KINDS` a stored shelf is, defaulting to plain shelving.
 *
 * The default is load-bearing rather than defensive: `layout.shelves` is
 * persisted, and a save written before this existed holds units with no kind at
 * all beside ones that say `'freezer'`. Both have to come out right with nobody
 * running a migration — the same read-time default `kindOf` gives a piece.
 */
export const shelfKind = (kind) => (STOCK_KINDS.includes(kind) ? kind : 'shelf');

/** Does this kind hold goods? True of a shelf, a freezer and a hot counter. */
export const holdsGoods = (kind) => STOCK_KINDS.includes(kind);

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

export const isGround = (kind) => GROUND[kind] != null;

export const isFloor = (kind) => kind === FLOOR_KIND;

/** Does this ground kind carry a job — a place deliveries land, or stock waits? */
export const isPad = (kind) => GROUND[kind]?.pad === true;

/** What a cell painted with this kind is made of. */
export const groundTile = (kind) => GROUND[kind]?.tile ?? null;

/**
 * Which ground kind a tile value IS, or null for ground nobody painted.
 *
 * The inverse of `groundTile`, and the reason the pads never needed a second
 * array: `tiles` already says which cells are bay, so "where is the bay" is a
 * read rather than a record that can drift out of step with the ground.
 */
export const groundKindOfTile = (tile) => GROUND_KINDS.find((k) => GROUND[k].tile === tile) ?? null;

/** Does one of these own the cell it stands in? */
export const blocksCell = (kind) => FIXTURES[kind]?.blocks === true;


/**
 * Fraction of what a fixture cost that you get back for tearing it out.
 *
 * Shared for the same reason `canPlace` is: the fixture menu prints the refund
 * on the button *before* you press it, and the server is what actually pays it.
 * Two copies of that number is two different amounts of money.
 *
 * It is the shop's one sell-back rate rather than the fixture's, which is why a
 * name with `FIXTURE` in it now reaches the worker menu: stepping back down a
 * ladder — a shelf's tier, a hire's grade — hands back half of the rung you are
 * standing on, and half is half. What that guarantees is the thing a rate per
 * ladder could not: every climb costs money whichever way it is walked, so no
 * amount of up-and-down cycling can print any.
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
 * The tile on the far side — where whoever WORKS a fixture stands, as opposed
 * to whoever uses it.
 *
 * Two quarter turns, which is the whole implementation, and that is the reason
 * this is a function rather than a stored offset: a counter's two sides are
 * always opposite, so there is nothing to author and nothing that can drift out
 * of step with the facing.
 */
export function behindTile(x, z, rot) {
  return anchorTile(x, z, rot + 2);
}

/**
 * Every tile a person has to be able to stand on to use this, placed like this.
 *
 * One function, so the ghost, the validator, the generator and the staff all
 * agree about how many spots a thing has and where they are. The `role` is what
 * the preview draws differently: the two sides of a till are not
 * interchangeable, and a player who cannot tell which is which will stand their
 * counter with the queue forming in the stockroom.
 *
 * Ordered use-side first, because that is the side rotation is *about* — a till
 * faces its customers the way a shelf faces its browsers.
 *
 * @returns {Array<{x: number, z: number, role: 'use'|'tend', field: string}>}
 */
export function workSpots(kind, x, z, rot = 0) {
  const def = FIXTURES[kind];
  if (!def) return [];
  const out = [];
  if (def.anchor) out.push({ ...anchorTile(x, z, rot), role: 'use', field: def.anchor });
  if (def.behind) out.push({ ...behindTile(x, z, rot), role: 'tend', field: def.behind });
  return out;
}

/**
 * Where you stand to work a fixture that has already been placed.
 *
 * `workSpots` above answers it from a *spec* — kind, tile, rotation — which is
 * what the ghost and the generator have. This answers it from the placed record,
 * which is what everything downstream has: the spot the layout actually stamped,
 * read back rather than re-derived, so a facing the generator refused is not
 * quietly drawn as though it had been honoured.
 *
 * In `shared/` because the client has to ask it too. A press names the unit you
 * are pointing at (`Game.aimAt`) and is refused out of reach, so the client has
 * to decide whether to send — and reach measured to the fixture on one side and
 * to its working spot on the other is the green-ghost bug: a press that looks
 * legal and comes back as a red toast. One spelling, two callers.
 *
 * Falls back to the fixture itself, which is right for everything that has no
 * side — a decoration, a pad, anything a person stands *on* rather than beside.
 */
export function workSpotOf(f) {
  return f.browseAt ?? f.serveAt ?? f.useAt ?? f;
}

/**
 * How close is close enough to work something without walking.
 *
 * The sim's own number, spelled here for the same reason `workSpotOf` is: the
 * client decides whether a press is worth sending and the server decides whether
 * it lands, and two constants would disagree exactly at the edge — where every
 * complaint about reach comes from.
 */
export const REACH = 1.6;

/**
 * Which way a thing put down HERE should face, given how it is facing now.
 *
 * Aim assist, not a rule. It answers the thing anybody building a row of
 * shelving does by hand and resents doing: standing something against a wall
 * means turning its back to the wall, every time, and there is exactly one
 * right answer per tile, so asking the player for it is asking them to type
 * out a fact the shop already knows.
 *
 * Two tests, and the second is the whole trick. **Usable** is the same
 * condition `whatThisCosts` warns about — somebody can stand where you browse
 * it from, and that spot is indoors. **Backed** is the one that reads a wall:
 * whatever is on the *opposite* side is NOT somewhere a person can be. Usable
 * alone is not enough, and the difference only shows up against a wall running
 * the other way — a shelf on the east wall facing south has a perfectly good
 * browsing spot and is standing side-on to the wall, which is what "it doesn't
 * rotate properly" would have meant.
 *
 * Ties go to the facing it already has, because the search starts there. That
 * is what keeps this from fighting you: out in the middle of the floor nothing
 * is backed, so it returns what you gave it and slides along the wall without
 * spinning. It is also why the caller has to stop asking once the player has
 * turned it by hand — see `rotPinned`.
 *
 * A till is the exception it looks like: it is worked from behind, so its back
 * is a *place* rather than a wall, and the best facing is the one with room on
 * both sides. Same search, opposite test.
 *
 * `keep` is what a fixture you are CARRYING asks for, and it is the difference
 * between assisting and overruling. A new unit off the palette has no facing
 * anybody chose — rot 0 is where the model happens to have been drawn — so the
 * best answer for the tile is the right answer. One you picked up already has
 * one, and it is the one you set the last time it was standing somewhere; a
 * search that improves on it is taking away a decision rather than saving you
 * one. So `keep` settles for a facing that WORKS rather than holding out for
 * the best available: the unit only turns when its own angle would leave it
 * with nowhere to browse it from, which is the case where keeping it would
 * silently cost you the shelf. Everything else — sliding it down a wall, past a
 * corner, along a row — leaves it exactly as you had it.
 */
export function faceAlong(L, spec, { ignoreId = null, keep = false } = {}) {
  const def = FIXTURES[spec.kind];
  const from = rot4(spec.rot ?? 0);
  if (!L || !def?.rotates || !def.anchor) return from;
  const { x, z } = spec;
  /**
   * Can somebody use this unit from that side?
   *
   * One predicate, asked of both sides, and every kind of "no" it has to
   * recognise is in it. The edge test is the one that is easy to leave out and
   * impossible to notice missing: **a wall is not a tile**, it is drawn on the
   * line between two of them, so the far side of your own shop wall is ordinary
   * walkable grass and the far side of an annex divider is ordinary shop floor.
   * Read tiles alone and a shelf against a wall you *drew* stands side-on to
   * it, which is exactly the case somebody building a back room hits first.
   */
  const open = (t) => WALKABLE.has(tileAt(L, t.x, t.z))
    && !blockedAt(L, t.x, t.z, ignoreId)
    && insideStore(L, t.x, t.z)
    && !SOLID.has(edgeBetween(L, x, z, t.x, t.z));
  const usable = (rot) => open(anchorTile(x, z, rot));
  const backed = (rot) => !open(behindTile(x, z, rot));
  const tries = [0, 1, 2, 3].map((i) => rot4(from + i));
  // The bar a facing has to clear to be worth having at all, as opposed to the
  // best one going. It is the same test each search below settles for when it
  // cannot do better — written once so `keep` cannot quietly hold a facing to a
  // different standard than the search that would replace it.
  const workable = def.behind ? (r) => usable(r) && !backed(r) : usable;
  if (keep && workable(from)) return from;
  if (def.behind) return tries.find(workable) ?? from;
  return tries.find((r) => usable(r) && backed(r)) ?? tries.find(usable) ?? from;
}

/**
 * The working spots a fixture ALREADY STANDING has, read off the record rather
 * than recomputed.
 *
 * Not the same question as `workSpots` above, and the difference has bitten
 * this codebase before (`canPlace` vs `canKeep`): that one asks where the spots
 * WOULD be for a placement being judged, this one asks where they ARE for
 * something the generator has already laid down. A record is the authority on
 * its own spots — `serveAt` is stored, not derived, because a till that was
 * turned mid-compose would otherwise report the facing it used to have.
 */
export function spotsOf(f, { layout = null, open = false } = {}) {
  const def = FIXTURES[f?.kind];
  if (!def) return [];
  const out = [];
  const use = f.browseAt ?? f.serveAt ?? f.useAt;
  if (use) out.push({ ...use, role: 'use' });
  if (def.behind && f[def.behind]) out.push({ ...f[def.behind], role: 'tend' });
  if (!def.ends || !use) return out;

  // The ends, and — if the piece says it is open all round — the back. Derived
  // rather than stored, which is the opposite call to `browseAt` and the right
  // one for the same reason: the anchor is a DECISION made when the thing was
  // laid and has to survive being read back, while these are a fact about a box
  // standing on a tile and are true again every time you ask.
  //
  // Filtered against the shop, or the picture lies: an end that is inside a
  // wall, under another shelf or across a wall line is not a place anybody can
  // stand, and marking it would be advertising a spot the game will not accept
  // you at. Without a layout there is nothing to filter against, which is what
  // an unplaced ghost is — see `workSpots`, which answers the same question for
  // a placement being judged.
  const rot = rot4(f.rot ?? 0);
  const more = open ? [rot + 1, rot + 3, rot + 2] : [rot + 1, rot + 3];
  const seen = new Set(out.map((s) => `${s.x},${s.z}`));
  for (const r of more) {
    const t = anchorTile(f.x, f.z, r);
    if (seen.has(`${t.x},${t.z}`)) continue;
    if (!standableSide(layout, f, t)) continue;
    seen.add(`${t.x},${t.z}`);
    out.push({ ...t, role: 'side' });
  }
  return out;
}

/**
 * Can somebody actually stand HERE and work the thing next to them?
 *
 * Two tests, and the second is the one a tile lookup cannot make: the ground
 * has to take a person and hold nothing (`isWalkableTile`, which is what the
 * walk grid itself is built from), and the line between that tile and the unit
 * has to not be a wall. Leaving the edge test out works perfectly against every
 * generated shop and fails the day somebody draws a divider — the same trap
 * `faceAlong` documents, where the far side of your own shop wall is ordinary
 * walkable grass.
 */
function standableSide(L, f, t) {
  if (!L) return true;
  if (!isWalkableTile(L, t.x, t.z)) return false;
  return !SOLID.has(edgeBetween(L, t.x, t.z, f.x, f.z));
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

/**
 * How long a line may get before the shop is the problem rather than the lane.
 *
 * Not a tuning knob for how a queue *looks* — a lane that bends has as many
 * slots as the room has floor, and the reason to stop counting is that a
 * sixteenth shopper at one till means the turn-away rule should have fired
 * long ago. It is a backstop on the walk, not a shape.
 */
export const QUEUE_LANE_MAX = 16;

/** Rotate a step 90°, in a grid where +x is east and +z is south. */
const cwTurn = (d) => ({ x: -d.z, z: d.x });
const ccwTurn = (d) => ({ x: d.z, z: -d.x });

/**
 * Where a till's line actually stands — one tile per place in it.
 *
 * This replaces `openRun`, which measured a *straight* run and stopped at the
 * first thing in the way — the shape the queue used to be. A fixed count of
 * slots, and anybody past the end of it was handed the last one, so a till that
 * was doing well grew a pile of shoppers standing inside one another instead of
 * a line. It got worse exactly as the shop got better, which is why it read as
 * the game breaking under load rather than as a missing turn.
 *
 * A line in a room turns the corner rather than ending. This walks the lane a
 * tile at a time — straight while it can, and round when it can't, preferring
 * to keep bending the way it bent last so the tail curls along the wall instead
 * of jittering side to side. Every rule the straight run enforced still holds
 * at every step, including the one only an edge can answer: a queue may not run
 * through a wall, so the boundary crossed to reach each tile counts as much as
 * the tile does. `used` is what stops the curl eating its own tail.
 *
 * **`lane[0]` is `from`** — the person being served is in the queue. That is
 * what lets every caller say "slot i is `lane[i]`" with no arithmetic, which is
 * where the old off-by-one pile-up lived.
 *
 * `claimed` is passed in by whoever lays every till at once, so two tills side
 * by side grow two lines rather than one line twice. Without it the first lane
 * laid runs through the second till's front, and which till that is comes down
 * to array order.
 *
 * A lane is grown a step at a time rather than in one go because `queueLanes`
 * needs to interleave them — see there.
 */
export function queueLane(L, from, dir, opts = {}) {
  const lane = startLane(L, from, dir, opts);
  while (growLane(lane));
  return lane.tiles;
}

const sameStep = (a, b) => a.x === b.x && a.z === b.z;

function startLane(L, from, dir, opts = {}) {
  const { max = QUEUE_LANE_MAX, claimed = null, blocked = () => false } = opts;
  return {
    L,
    max,
    claimed,
    blocked,
    /**
     * WHETHER THIS LANE IS AN INDOOR ONE, decided by where it starts.
     *
     * "A queue stays indoors" is the right rule for a till in a room, and it is
     * asserted as one in `verify:layout`. It is not a rule a till can *obey*
     * when there is no room: knock the back wall through and enclosure is
     * gone, so `insideStore` is false on every tile in the world — no lane can
     * grow a single step, every lane comes out length 1, and `queueSlot` then
     * clamps every shopper in the shop onto the serving tile. A real shop hit
     * exactly that and it reads as the queue code having broken, because what
     * you see is a heap of people standing inside one another at the counter
     * and nothing anywhere connecting it to a wall you took out last week.
     *
     * So the requirement is the *serving spot's own* answer rather than a
     * constant. A till standing in a room queues in that room, exactly as
     * before, and every generated shop is that case — which is why nothing in
     * the sweeps moves. A till with no room around it queues on whatever floor
     * it can reach, which is a line rather than a pile, and is the same call
     * the rest of this file makes about strange buildings: the sim copes, and
     * you keep what you built.
     */
    indoorOnly: insideStore(L, from.x, from.z),
    tiles: [{ x: from.x, z: from.z }],
    used: new Set([`${from.x},${from.z}`]),
    heading: dir,
    // Which way the line bent last, so the second corner turns the same way as
    // the first. A lane that alternates reads as a crowd; one that keeps
    // curling reads as a line that went round something.
    bend: cwTurn,
  };
}

/**
 * Add one place to the end of a line, or report that there is nowhere to add
 * one. Never writes to `claimed` — the caller sharing that set decides when a
 * tile is spoken for, and `queueLane` calls this twice per till to choose a
 * direction, which would otherwise have the first choice block the second.
 */
function growLane(s) {
  if (s.tiles.length > s.max) return false;
  const at = s.tiles[s.tiles.length - 1];
  // Straight first, then the two corners — never the reverse, which is the one
  // turn that would walk the line back up itself.
  const turn = s.bend(s.heading);
  for (const d of [s.heading, turn, (s.bend === cwTurn ? ccwTurn : cwTurn)(s.heading)]) {
    const x = at.x + d.x;
    const z = at.z + d.z;
    const key = `${x},${z}`;
    if (s.used.has(key) || s.claimed?.has(key)) continue;
    // A line may not run through a wall, and it may not run through a way
    // through that has a rule on it either. `RULED` rather than
    // `shopperCanCross`, because a lane is grown from the till OUTWARD and
    // walked toward the till, so a one-way door would be crossable in whichever
    // direction this loop happened to ask about — and a queue that files in
    // through the entrance and cannot leave is not a queue. Nothing about a
    // staff-only door wants a customer standing in it either way.
    const line = edgeBetween(s.L, at.x, at.z, x, z);
    if (SOLID.has(line) || RULED.has(line)) continue;
    // The wall between two tiles still stops the line either way — a queue may
    // not run through one whether or not the shop has an inside. What relaxes
    // when there is no inside is only which floor counts. See `indoorOnly`.
    if (s.indoorOnly && !insideStore(s.L, x, z)) continue;
    if (!isWalkableTile(s.L, x, z) || s.blocked(x, z)) continue;
    // Bent the other way, so the next corner should follow this one. Compared
    // by value: every turn helper mints a fresh object, so `===` on a step is
    // always false and the line would forget which way it last bent.
    if (!sameStep(d, s.heading) && !sameStep(d, turn)) {
      s.bend = s.bend === cwTurn ? ccwTurn : cwTurn;
    }
    s.heading = d;
    s.tiles.push({ x, z });
    s.used.add(key);
    return true;
  }
  return false;
}

/**
 * Every till's lane, keyed by till id, laid against one shared `claimed` set.
 *
 * The lanes are grown **in step with each other**, a place at a time, and that
 * is the whole of this function. Laying one line to its full length before
 * starting the next hands the first till the entire aisle: with the generator's
 * tills three tiles apart, till #1's line runs the length of the shop, round
 * the corner and back, and till #2 then finds every tile beside it spoken for
 * and gets a line of nobody. It reads as "the second till is broken", and the
 * shop it happens in looks completely ordinary.
 *
 * Interleaving is also just what a queue is. Two lines beside each other grow
 * away from one another because each has already taken the tile the other
 * would have wanted next — nobody has to arbitrate.
 *
 * The sim, the generator's final measure and `verify:layout` all come through
 * here, so there is one answer to where a line stands rather than three that
 * agree right up until one of them is edited.
 */
export function queueLanes(L) {
  const tills = (L.checkouts ?? []).filter((t) => t.serveAt && t.queueDir);
  const claimed = new Set();
  // Every serving spot is spoken for before any line is laid, including the
  // ones whose line has not started yet — otherwise the first lane runs through
  // the second till's front.
  for (const t of tills) claimed.add(`${t.serveAt.x},${t.serveAt.z}`);

  const growing = tills.map((t) => startLane(L, t.serveAt, t.queueDir, { claimed }));
  for (let moved = true; moved;) {
    moved = false;
    for (const s of growing) {
      if (!growLane(s)) continue;
      const end = s.tiles[s.tiles.length - 1];
      claimed.add(`${end.x},${end.z}`);
      moved = true;
    }
  }

  return new Map(tills.map((t, i) => [t.id, growing[i].tiles]));
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
  // `withEdge` carries the OLD `indoor` mask across, and a one-way door reads
  // which way is in off that mask — so the probe has to be told what it would
  // enclose before anything asks it a question about a shopper. Computed once
  // here rather than twice below, which is what it used to cost.
  const after = computeIndoor(probe);
  probe = { ...probe, indoor: after };

  // Taking a wall out can't strand anybody — a hole only ever opens the way —
  // so a demolition skips every reachability question below. What it can still
  // do is un-roof, which is the half neither check used to cover.
  if (kind) {
    const from = L.spawn ?? L.door;
    // Asked as a SHOPPER, which is the whole of the first warning since a way
    // through can be signed: unchanged, you could turn your own front door
    // staff-only or exit-only and the game would say nothing at all while no
    // customer could ever come in again — a shop that looks completely normal
    // and takes no money.
    const seen = reachable(probe, from.x, from.z, undefined, shopperCanCross);
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
    const indoors = (x, z) => (x < 0 || z < 0 || x >= L.w || z >= L.h
      ? false
      : after[z * L.w + x] === 1);

    if (indoors(Math.round(L.door.x), Math.round(L.door.z))) {
      // Deliberately NOT a shopper's flood, unlike the one above. If this went
      // shopper-solid too, every shelf you ever stand in a stockroom would warn
      // "that cuts a shelf off from the door" on every wall you drew afterwards,
      // for ever, about something you did on purpose. Same argument
      // `whatThisUnroofs` already makes: report what the action *changes*.
      const onFloor = reachable(probe, L.door.x, L.door.z,
        (P, x, z) => indoors(x, z) && isWalkableTile(P, x, z));
      const joined = (p) => onFloor.has(`${Math.round(p.x)},${Math.round(p.z)}`);

      // ANY of a fixture's working spots being cut off strands it, which for a
      // till means the clerk's side counts: a wall drawn between the counter
      // and the back of the shop leaves a till the queue can still reach and
      // nobody can ever staff, and that is exactly the wall worth warning about.
      // `layout` matters, and it is the difference between this warning firing
      // for a reason and firing always. A unit's ENDS are derived rather than
      // stored, so unfiltered they include tiles nobody could ever stand on —
      // and a run of shelving is solid down the column now (`SHELF_ROW_PITCH`),
      // which means every unit in it has another unit for an end. `every` then
      // reads that as stranded whatever wall you drew, so a shop with an aisle
      // in it warned "that cuts 11 fixtures off from the door" about a single
      // segment in a corner. Filtered against the shop as it stands *before*
      // the change, which is what makes this a delta.
      const stranded = fixturesOf(L)
        .map((f) => ({ f, spots: spotsOf(f, { layout: L }) }))
        .filter(({ f, spots }) => spots.length
          && indoors(Math.round(f.x), Math.round(f.z))
          && !spots.every(joined));
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

  const roof = whatThisUnroofs(L, after);
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
function whatThisUnroofs(L, after) {
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
 * A cap on the gesture, not on how much ground you may own — drag again. It is
 * here because a stroke is charged and re-flowed as one action: the drag has to
 * arrive as two corners (the 4KB inbound cap), it is priced per cell, and every
 * cell of it is validated before any of it is paid for.
 */
export const GROUND_STROKE_MAX = 16;

/**
 * How thick a lane the road brush lays, whatever you dragged.
 *
 * A car is 1.21 tiles wide — see the `vehicles` rows — so a one-cell lane is
 * one a car hangs off both edges of. That is a scale fact rather than a taste,
 * and the brush is where it belongs: a road you can draw too narrow for the
 * things that drive on it is a brush that lets you make a mistake with no way
 * to see you have made it, because the lane finder is perfectly happy with one
 * cell and the ghost is green either way.
 *
 * It is a FLOOR on the thickness rather than a fixed size — drag a wide
 * rectangle and you get what you dragged. One drag is one road; four drags is
 * a car park you should have painted with the car park brush.
 */
export const ROAD_THICK = 2;

/**
 * The cells a drag from `start` to `to` would paint.
 *
 * Clamped around `start` rather than around the lower corner, which is the one
 * place this differs from `edgeRun` and is a deliberate fix rather than a
 * divergence: clamping a rect by its minimum trims the corner you began the
 * drag on, so an oversized stroke up and to the left walks away from your
 * finger instead of stopping under it.
 *
 * `thick` widens a stroke that came out thinner than that, which is the road
 * brush and nothing else. **Which way it widens has to be decided here**, in
 * the one function both the ghost and the server run: the client sends the two
 * ends of the drag and never the cells (the 4KB inbound cap), so a rule the
 * preview applied and the server did not would be a green ghost promising a
 * road the shop then refuses. It grows towards the higher coordinate, and away
 * from it when that would run off the map — which is not a nicety, it is the
 * seeded street: that sits in the bottom paintable row, so a road brush that
 * only ever grew downward could never redraw the one the world starts with.
 */
export function groundStroke(start, to, max = GROUND_STROKE_MAX, thick = 1, L = null) {
  const x0 = Math.round(start.x);
  const z0 = Math.round(start.z);
  const near = (from, end) => (end > from
    ? Math.min(end, from + max - 1)
    : Math.max(end, from - max + 1));
  const x1 = to == null ? x0 : near(x0, Math.round(to.x));
  const z1 = to == null ? z0 : near(z0, Math.round(to.z));

  let ax = Math.min(x0, x1);
  let bx = Math.max(x0, x1);
  let az = Math.min(z0, z1);
  let bz = Math.max(z0, z1);

  if (thick > 1) {
    // The thin axis is the one that gets widened, and a stroke thin both ways —
    // a single tap — is widened across rather than along, so a tap lays a stub
    // of road pointing the way a road points.
    const wide = bx - ax + 1;
    const deep = bz - az + 1;
    const grow = (a, b, limit) => {
      const room = Math.min(thick - (b - a + 1), max - (b - a + 1));
      if (room <= 0) return [a, b];
      // Down/right unless that leaves the world, in which case up/left.
      if (limit == null || b + room <= limit) return [a, b + room];
      return [Math.max(1, a - room), b];
    };
    if (deep <= wide && deep < thick) [az, bz] = grow(az, bz, L ? L.h - 2 : null);
    else if (wide < thick) [ax, bx] = grow(ax, bx, L ? L.w - 2 : null);
  }

  const out = [];
  for (let z = az; z <= bz; z++) {
    for (let x = ax; x <= bx; x++) out.push({ x, z });
  }
  return out;
}

/** How thick a stroke of this kind comes out, whatever was dragged. */
export const strokeThick = (kind) => (kind === 'road' ? ROAD_THICK : 1);

/**
 * Which design of ground is painted on each cell, as a lookup.
 *
 * The layer that carries the *design*, kept clear of `tiles`, which carries
 * what may stand there. Sparse and rebuilt per call rather than emitted as a
 * full-grid array: an unpainted shop sends nothing at all, and the alternative
 * is a second w×h array on the wire on every re-flow to say "plain" 500 times.
 *
 * Reads `ground`, falling back to `floors` — the name this carried while floor
 * was the only thing you could paint. A read-time default rather than a
 * migration, the same bargain `kindOf` strikes for a row with no `kind`, so an
 * old save, an old export and a fresh seed all agree with no ceremony.
 */
export function groundIndex(L) {
  const m = new Map();
  for (const f of L?.ground ?? L?.floors ?? []) m.set(`${f.x},${f.z}`, f.p);
  return m;
}

export const groundPieceAt = (L, x, z) => groundIndex(L).get(`${x},${z}`) ?? null;

/**
 * Every cell of one pad, read off `tiles`.
 *
 * A read, deliberately, rather than a list kept beside the ground — the same
 * argument `Game.fixtureCounts` makes against the fixture ledger it replaced. A
 * stored region can disagree with what the cells actually are; a scan cannot.
 * It also means a pad is however many cells you painted, in whatever shape, and
 * nothing has to be taught what an L looks like.
 */
export function padCells(L, kind) {
  const want = groundTile(kind);
  const out = [];
  if (want == null || !L?.tiles) return out;
  for (let z = 0; z < L.h; z++) {
    for (let x = 0; x < L.w; x++) if (L.tiles[z * L.w + x] === want) out.push({ x, z });
  }
  return out;
}

/** Is this cell part of that pad? */
export const isPadAt = (L, kind, x, z) => tileAt(L, x, z) === groundTile(kind);

/**
 * May this stroke be painted?
 *
 * Same two answers as everything else here, and the split falls in a slightly
 * different place because this is ground: almost all of it is physics. There is
 * no "you could seal yourself in" to warn about, since every ground kind is
 * walkable and swapping one for another cuts nothing off from anything.
 *
 * The one refusal worth spelling out is taking ground out from under something
 * standing on it. That reads like the kind of consequence this codebase usually
 * allows you to cause — and it isn't, because the generator would not leave the
 * shelf standing on grass, it would DROP the placement on the next re-flow and
 * refund it. A tool that quietly sells your shelving and its stock back is not a
 * choice anybody made; it is a bulldozer wearing a paintbrush. So it is a no,
 * and the bulldozer is right there.
 *
 * One kind of ground may be painted straight over another, and that is what
 * makes the pads editable at all: moving your delivery bay is painting a new
 * one and then flooring over the old, with no separate verb for erasing.
 *
 * @param {object} L        the layout
 * @param {object[]} cells  [{x, z}], from `groundStroke`
 * @param {?string} kind    which ground kind to lay, or null to take it up
 * @param {?string} piece   which design of that kind
 */
export function canPaintGround(L, cells, kind = null, piece = null) {
  if (!cells?.length) return no('nothing to lay');
  const laying = kind != null;
  if (laying && groundTile(kind) == null) return no('that is not a kind of ground');
  const want = laying ? groundTile(kind) : T.GRASS;
  const painted = groundIndex(L);

  // What the pads have now, so the stroke can be judged against what it would
  // leave rather than against each cell in isolation. Painting over the last
  // bay is only a consequence when it was the last one.
  const padWas = new Map(PAD_KINDS.map((k) => [k, 0]));
  const padLost = new Map(PAD_KINDS.map((k) => [k, 0]));
  for (const k of PAD_KINDS) padWas.set(k, padCells(L, k).length);

  let changed = 0;
  let bared = 0;
  for (const c of cells) {
    const x = Math.round(c.x);
    const z = Math.round(c.z);
    if (x < 1 || z < 1 || x >= L.w - 1 || z >= L.h - 1) return no('off the edge of the world');

    const ground = tileAt(L, x, z);
    const was = groundKindOfTile(ground);

    if (laying) {
      // Only ever over ground. Everything else a cell can be made of is
      // something with a job of a different sort — a bed, the path out to the
      // fields, a wall — and paving one over would take that job away silently,
      // with no fixture removed and nothing to put back.
      if (ground !== T.GRASS && was == null) return no(groundIsBusy(ground));
      // Restyling counts. Ground that is already this kind still changes hands
      // when the design differs, which is most of what this tool is for —
      // asking only whether the TILE moved would report a whole shop re-tiled
      // as "nothing to do".
      if (ground !== want || (painted.get(`${x},${z}`) ?? null) !== piece) changed++;
    } else {
      if (was == null) continue;                     // nothing to take up
      // See above: this would drop the fixture rather than strand it.
      if (blockedAt(L, x, z)) return no('something is standing on it');
      changed++;
    }

    if (ground === want && was === kind) continue;
    // Two consequences, counted the same way in both directions: a cell that
    // ends up indoors and is not floor is one nothing can ever be built or dug
    // on, and a pad cell this stroke paints over is one that pad no longer has.
    if (was && was !== kind && padWas.has(was)) padLost.set(was, padLost.get(was) + 1);
    if (want !== T.FLOOR && insideStore(L, x, z)) bared++;
  }

  if (!changed) return { ok: true, unchanged: true };

  const warns = [];

  // Losing the last of a pad. Allowed — the whole point of the pads being
  // paintable is that you may move them, and moving one is two strokes with a
  // moment in between where you own none. But orders land on the bay and hands
  // are cleared at the drop-off, so a shop with neither is one where `order`
  // has nowhere to put a pallet, and that is worth being told before rather
  // than discovering it at the wholesaler.
  for (const k of PAD_KINDS) {
    if (padWas.get(k) > 0 && padLost.get(k) >= padWas.get(k)) warns.push(GROUND[k].lastGone);
  }

  // Bare ground indoors is a cell nothing can ever use: a shelf needs floor and
  // a bed needs to be outdoors, so it is not a patch of garden in your shop, it
  // is a hole. Allowed, because knocking your own floor out is a move and the
  // sim copes with it perfectly well — people walk over it. A stockroom floored
  // as bay is the same shape of hole, deliberately: it is a room for crates.
  if (bared) {
    warns.push(bared === 1
      ? 'that leaves a cell indoors that nothing can be built or dug on'
      : `that leaves ${bared} cells indoors that nothing can be built or dug on`);
  }

  return warns.length ? { ok: true, warn: warns.join('; ') } : { ok: true };
}

const groundIsBusy = (ground) => {
  if (ground === T.PLOT) return 'there is a bed there — clear it first';
  // T.PATH used to be refused here — "that is the path out to the fields" — and
  // that line retired with `GROUND.path`. It is a kind now, so `was` answers for
  // it above and this is never reached with one: the strip the generator lays is
  // ground you could have painted, and therefore ground you may paint over.
  return 'you can only lay ground over bare grass';
};

/** Every fixture currently in the layout, as uniform placement specs. */
export function fixturesOf(L) {
  const out = [];
  for (const s of L.shelves ?? []) out.push({ kind: shelfKind(s.kind), ...s });
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
 * And there is a third question, which is not "may this go here" at all but "is
 * this still allowed to be where it already is". `canKeep` is that one, and
 * `keeping` is what it sets — see there for why the two cannot be the same rule.
 *
 * @param {object} L      the layout
 * @param {object} spec   { kind, x, z, rot }
 * @param {object} [opts] { ignoreId } — the fixture being moved, so it doesn't
 *                        block its own new position when they overlap.
 *                        { keeping } — judging something already standing.
 * @returns {{ok: boolean, reason?: string, warn?: string}}
 */
export function canPlace(L, spec, { ignoreId = null, keeping = false } = {}) {
  const def = FIXTURES[spec.kind];
  if (!def) return no(`"${spec.kind}" is not something you can build`);

  const x = Math.round(spec.x);
  const z = Math.round(spec.z);
  if (x < 1 || z < 1 || x >= L.w - 1 || z >= L.h - 1) return no('off the edge of the world');

  if (isProp(spec.kind)) return canPlaceProp(L, def, x, z, ignoreId, keeping);

  // Two questions where there used to be one, because a tile used to answer
  // both. What the ground is made of is `tiles`; whether something already
  // stands on it is `blocked`. A plot digs the ground, so it asks about grass;
  // everything else stands on the floor.
  const ground = tileAt(L, x, z);
  const taken = blockedAt(L, x, z, ignoreId);

  // `where` is asked only of something being put down. Of something already
  // standing it is not a fact about the fixture at all — it is a fact about the
  // walls around it, and those move. See `canKeep`.
  if (def.where === 'indoor') {
    if (!keeping && !insideStore(L, x, z)) return no('that has to go inside the shop');
    if (taken) return no('something is already there');
    if (!BUILDABLE_INDOOR.has(ground)) {
      return no(ground === T.DOOR ? 'not in the doorway' : 'something is already there');
    }
  } else {
    if (!keeping && insideStore(L, x, z)) return no('plots go outside, on the grass');
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
function canPlaceProp(L, def, x, z, ignoreId, keeping = false) {
  if (!keeping && def.where === 'indoor' && !insideStore(L, x, z)) {
    return no('that has to go inside the shop');
  }
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

/**
 * `canPlace`, for the question the re-flow actually asks: may this stay where it
 * already is?
 *
 * The third entry point, and it exists because "may this go here" and "may this
 * stay here" are different questions that looked like one. `compose` re-judges
 * every placement on every re-flow, and it was asking the *placement* rule — so
 * a rule about where you may PUT a shelf became a rule about where a shelf is
 * allowed to CONTINUE STANDING, and the difference is a bug that deleted
 * people's shops.
 *
 * `where` is the whole of it. Being indoors is not a property of a shelf, it is
 * a property of the walls around the shelf, and walls are a thing the player
 * moves. So knocking one hole in your wall un-enclosed the building, every
 * fixture in it was suddenly "outdoors", and every one of them failed
 * `canPlace` and was dropped — six shelves, a freezer and the till, refunded at
 * full price and gone, on a gesture the game had described as a warning. The
 * warning was even correct ("that leaves 8 fixtures standing outside"); what
 * was wrong was that standing outside was fatal.
 *
 * It is fatal nowhere else, deliberately. `whatThisUnroofs` has said since the
 * day enclosure arrived that putting your shelving out in the weather is
 * allowed and the sim copes — a shelf outdoors keeps its stock and keeps
 * selling, and what you lose is the right to build another one beside it. That
 * was true of everything except the one piece of code that could act on it.
 *
 * Everything else stays exactly as strict, because everything else is physics
 * that really can take a cell away: off the map, ground it cannot stand on,
 * something else already in it. Those are the cases `droppedPlacements` was
 * written for and they still drop.
 *
 * This is the same mistake as the `canPlaceCleanly` one directly above, one
 * layer further down: a rule written for a caller putting something down, asked
 * of a caller re-applying what is already there. Both times the symptom was a
 * fixture vanishing a tick after you touched something near it.
 */
export function canKeep(L, spec, opts = {}) {
  return canPlace(L, spec, { ...opts, keeping: true });
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

  // ---- ...and can anyone stand behind it and work it? ---------------------
  // A warning rather than a refusal, like everything else here: a till with its
  // back to a wall still takes money, because a *player* serves from anywhere
  // within reach (`Game.serve` checks a radius, not a tile). What it costs you
  // is staff — a hire walks to this spot and no other, so a till without one is
  // a till you have to work yourself, forever.
  if (def.behind) {
    const b = behindTile(x, z, spec.rot ?? 0);
    if (!open(b.x, b.z)) return 'nowhere to stand behind it — staff could never work it';
    if (!insideStore(L, b.x, b.z)) return 'its working side is outside the shop';
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
    // The same walk the line itself will take, so the warning cannot promise a
    // pile-up the lane then bends its way out of. A till in a corner used to be
    // warned about on the strength of a straight run it never had.
    const others = new Set((L.checkouts ?? [])
      .filter((c) => c.id !== ignoreId && c.serveAt)
      .map((c) => `${c.serveAt.x},${c.serveAt.z}`));
    const best = Math.max(...queueAxis(spec.rot ?? 0)
      .map((d) => queueLane(probe, serve, d, { claimed: others }).length - 1));
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
 *
 * **A warning is a DELTA, and it was an absolute for as long as this existed.**
 * The flood was run once, with the thing already standing there, and anything
 * it failed to reach was blamed on the placement. So one freezer with a crate
 * on its browse tile — a shop somebody had already half-blocked, which is a
 * move the game explicitly allows — made *every* ghost anywhere in the world
 * say "that would cut off a freezer you own". Including a plot out in the
 * middle of a field, which is where it was finally noticed, and including the
 * one placement that genuinely was about to seal something off: a warning that
 * is always on is a warning nobody reads.
 *
 * So both floods, and only a spot that was reachable *before* and isn't now.
 * The second one is lazy and usually free: the two masks differ by exactly the
 * one cell being taken, so a piece that blocks nothing — a plot, a decoration —
 * cannot change reachability at all and reuses the first flood outright. That
 * matters here, because this runs on every ghost frame and ~100k times in
 * `verify:layout`.
 */
function whatThisBlocks(L, spec, def, ignoreId) {
  // The flood runs over the *occupancy* mask now rather than a doctored copy of
  // the ground. The thing being moved has already left as far as this is
  // concerned — or a shelf could never be shuffled one square along — and the
  // thing being placed is treated as already standing there.
  const before = Uint8Array.from(L.blocked ?? new Uint8Array(L.w * L.h));
  if (ignoreId) {
    for (const f of fixturesOf(L)) {
      if (f.id === ignoreId) before[f.z * L.w + f.x] = 0;
    }
  }
  // Which is also the baseline: what the shop is like with this thing lifted
  // and not yet put down, which is exactly what the player is looking at.
  const after = def.blocks ? Uint8Array.from(before) : before;
  if (def.blocks) after[spec.z * L.w + spec.x] = 1;

  const flood = (blocked) => {
    const probe = { ...L, blocked };
    const seen = new Set([`${L.door.x},${L.door.z}`]);
    const stack = [[L.door.x, L.door.z]];
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
    return seen;
  };

  const seen = flood(after);
  // Paid for only when something is unreachable and this placement could be the
  // reason — so the common case, where nothing is cut off at all, runs one flood
  // exactly as it always did.
  let base = after === before ? seen : null;
  const key = (p) => `${Math.round(p.x)},${Math.round(p.z)}`;
  const reached = (p) => seen.has(key(p));
  const wasReached = (p) => {
    base ??= flood(before);
    return base.has(key(p));
  };
  // The one question every check below is really asking. Said as two floods
  // rather than folded into a single "reaches", because the checks that take
  // ANY of several tiles cannot be built out of a per-tile answer: a bay with
  // three cells already cut off and one good one is sealed by taking the good
  // one, and a predicate that calls the three "fine, they were already gone"
  // reports that as no change at all.
  const cutOff = (p) => !reached(p) && wasReached(p);
  const isHere = (p) => Math.round(p.x) === spec.x && Math.round(p.z) === spec.z;
  const label = (kind) => FIXTURES[kind]?.label.toLowerCase() ?? 'fixture';

  // Whatever you are placing has to be usable itself, and standing somewhere
  // walkable is not the same as standing somewhere you can walk *to*.
  //
  // `reached` and not `reaches`: these two are the exception to the delta, and
  // for the reason the delta exists. A thing you are about to put down has no
  // "before" — it wasn't anywhere — so nothing here can be somebody else's
  // pre-existing mess. Standing a shelf in a room you have sealed off deserves
  // to be told so every time, even though that room was already sealed.
  if (def.anchor) {
    const mine = anchorTile(spec.x, spec.z, spec.rot ?? 0);
    if (!reached(mine)) return 'you could never get round to that side of it';
  }
  if (def.behind) {
    const mine = behindTile(spec.x, spec.z, spec.rot ?? 0);
    if (!reached(mine)) return 'nobody could get round behind it to serve';
  }

  for (const f of fixturesOf(L)) {
    if (f.id === ignoreId) continue;
    if (f.kind === 'plot') {
      // A bed is worked from any side, so it only needs one of them — and it
      // has to have had one, or a bed you had already boxed in blames the next
      // thing you put down anywhere in the shop.
      const sides = FACING.map((d) => ({ x: f.x + d.dx, z: f.z + d.dz }));
      if (!sides.some(reached) && sides.some(wasReached)) {
        return 'that would leave a plot with no way in';
      }
      continue;
    }
    // Both sides of a counter, and the reason this reads them off the record
    // rather than recomputing from `rot`: a re-flow judges placements against a
    // half-built layout, and `serveAt` is what the till was actually laid with.
    // ...and the same filter, for the same reason: `L` is the shop before this
    // placement, so an end that is already another unit is not a spot this is
    // taking away. Without it, standing a shelf at the end of a run — which is
    // how a run of shelving gets built — reports "that is where you stand to
    // use the shelf behind it" about a tile nobody has ever stood on.
    for (const s of spotsOf(f, { layout: L })) {
      if (s.role === 'tend') {
        // Said differently on purpose. "Where you stand to use it" is wrong for
        // this side — you never do — and a player told that about a tile behind
        // a counter goes looking for a shelf that isn't there.
        if (isHere(s)) return `that is where your clerk stands to work the ${label(f.kind)}`;
        if (cutOff(s)) return `that would leave a ${label(f.kind)} nobody can get behind`;
        continue;
      }
      if (isHere(s)) return `that is where you stand to use the ${label(f.kind)} behind it`;
      if (cutOff(s)) return `that would cut off a ${label(f.kind)} you own`;
    }
  }

  if (cutOff(L.spawn)) return 'that would block the way through';
  // A pad is a region rather than a point now, so the question is whether ANY
  // of it is still reachable — walling off one corner of a big stockroom is a
  // choice, and sealing the whole thing is what this is here to catch.
  for (const k of PAD_KINDS) {
    const cells = padCells(L, k);
    if (cells.length && !cells.some(reached) && cells.some(wasReached)) {
      return `that would cut off the ${GROUND[k].label.toLowerCase()}`;
    }
  }
  return null;
}
