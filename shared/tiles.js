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

export const T = {
  GRASS: 0,
  FLOOR: 1,
  WALL: 2,
  SHELF: 3,
  FREEZER: 4,
  CHECKOUT: 5,
  PLOT: 6,
  DOOR: 7,
  PATH: 8,
  FENCE: 9,
  STATION: 10,
  /** The loading pad outside the door: where pallets land and where you can
   *  put down anything you're carrying. */
  BAY: 11,
};

/** Tiles a walking character can stand on. */
export const WALKABLE = new Set([T.GRASS, T.FLOOR, T.DOOR, T.PATH, T.PLOT, T.BAY]);

/** Tiles you can build a shop fixture onto — bare indoor floor and nothing else. */
export const BUILDABLE_INDOOR = new Set([T.FLOOR]);

/** Tiles you can dig a farm plot into. */
export const BUILDABLE_OUTDOOR = new Set([T.GRASS]);
