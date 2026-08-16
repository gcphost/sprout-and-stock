/**
 * THE TILE VOCABULARY.
 *
 * Lives in shared/ because three places have to agree on it exactly: the
 * generator that writes tiles (`server/layout.js`), the validator that decides
 * whether you may build on one (`shared/build.js`), and the renderer that draws
 * them (`client/render/palette.js`). It used to live in server/layout.js with a
 * "keep this in sync" comment on the client copy, which is a promise rather
 * than a mechanism.
 */

/**
 * A tile is GROUND. What the floor is made of, and nothing else.
 *
 * It used to mean two things at once — what the floor is made of *and* what is
 * standing on it — which is why there was nowhere to put a rug. A rug is not a
 * floor material and it is not an occupant, and one cell holding one value has
 * no third answer. Fixtures are records in the layout's own lists now, and
 * whether a cell is occupied is `blocked`, derived from those lists.
 *
 * The numbers are deliberately not renumbered. `SHELF`, `FREEZER`, `CHECKOUT`
 * and `STATION` left, but a live save holds `tiles` as raw numbers and a
 * renumbering would silently turn every existing shop's floor into grass.
 * Gaps in an enum cost nothing; a migration nobody remembers to write costs a
 * shop.
 */
export const T = {
  GRASS: 0,
  FLOOR: 1,
  WALL: 2,
  // 3, 4, 5 were SHELF, FREEZER, CHECKOUT — now records, not ground.
  /** Dug earth. Still ground: a plot is what the floor is made of there. */
  PLOT: 6,
  DOOR: 7,
  PATH: 8,
  FENCE: 9,
  // 10 was STATION.
  /** The delivery pad in the yard: where a wholesale order lands as a pallet. */
  BAY: 11,
  /** The other pad in the yard: where you clear your hands. Its own ground
   *  rather than more bay, because the whole point of the split is being able
   *  to tell "this arrived" from "I put this here" at a glance. */
  DROP: 12,
  /** Where the staff go when they stop. The first pad that is not about goods:
   *  a bay holds crates and this one holds people, one per cell. */
  BREAK: 13,
};

/**
 * Ground a walking character can stand on — before anything standing on it is
 * taken into account. Ask `isWalkableTile` in `shared/build.js` for the whole
 * question; this one only knows about the floor.
 */
export const WALKABLE = new Set([T.GRASS, T.FLOOR, T.DOOR, T.PATH, T.PLOT, T.BAY, T.DROP, T.BREAK]);

/** Ground you can stand a shop fixture on — bare indoor floor and nothing else. */
export const BUILDABLE_INDOOR = new Set([T.FLOOR]);

/** Ground you can dig a farm plot into. */
export const BUILDABLE_OUTDOOR = new Set([T.GRASS]);
