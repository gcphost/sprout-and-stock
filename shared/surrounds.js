/**
 * WHERE THE SHOP IS — the land past the last buyable tile, as a choice.
 *
 * Everything outside the lot used to be one hardcoded ring of 48 identical
 * trees (`buildVistaForest`, deleted with this). That is a decision about the
 * whole game made in a renderer, and it is the wrong place for it twice over:
 * a shop on a high street and a shop up a lane are the same fiction the
 * `catchment-*` upgrades already sell, and the one thing on screen that could
 * have said so said "countryside" to everybody.
 *
 * This file is the VOCABULARY, and it lives in `shared/` for the reason
 * `shared/reputation.js` does: three readers have to agree about it and none of
 * them owns it.
 *
 *   - `server/sim/index.js` stores the id on the save and refuses one it does
 *     not recognise, so a bad value cannot reach anybody's world.
 *   - `client/sections.js` draws the rows in the Menu, in the order below.
 *   - `client/render/surround.js` builds the art for whichever is picked.
 *
 * WHAT IS *NOT* HERE is every colour, height and scatter rule — those are art,
 * they live in `client/render/surround.js` and `palette.js` with the rest of
 * the look, and the server has no business knowing a suburb has pitched roofs.
 * What crosses the wire is a string.
 *
 * IT IS A FACT ABOUT THE SHOP, NOT ABOUT THE PERSON. Cel + Ink is a per-machine
 * toggle in `localStorage` because it is a taste in art; this is a fact about
 * where the building stands, so it rides in the save and both people in a co-op
 * shop see the same town. The test for the next one of these: if two people
 * looking at one shop could reasonably disagree, it is a setting; if they would
 * be looking at two different places, it is a save field.
 *
 * Adding a fourth: a row here, and a builder case in `client/render/surround.js`.
 * Nothing else — the Menu maps over this table and the server validates against
 * it, so neither has a list to keep in step.
 */

/** The ids, so nothing has to spell one by hand. */
export const S = {
  COUNTRY: 'country',
  SUBURB: 'suburb',
  CITY: 'city',
};

/**
 * WHAT A SAVE WITH NOTHING TO SAY READS AS.
 *
 * `country` and it has to be: every shop in existence was drawn with a ring of
 * trees round it, so any other default would silently rehouse all of them the
 * day this shipped. Same argument `open` makes one file over — the safe default
 * is the one where nothing moves.
 */
export const DEFAULT_SURROUND = S.COUNTRY;

/**
 * The three, in the order they are drawn in the Menu.
 *
 * Ordered by how BUILT UP each is rather than by taste, which is the only
 * ordering a row of three alternatives can carry without somebody having to
 * read all three to find the one they want. `sub` is one line in a 214px panel
 * — see the note on the Menu's copy in client/sections.js — so it says what you
 * would see, not what it is for.
 */
export const SURROUNDS = [
  {
    id: S.COUNTRY,
    name: 'Countryside',
    sub: 'woodland and hedgerow, open fields',
  },
  {
    id: S.SUBURB,
    name: 'Suburb',
    sub: 'low houses, gardens, the odd tree',
  },
  {
    id: S.CITY,
    name: 'City',
    sub: 'blocks and towers, lit windows after dark',
  },
];

/**
 * Is this a surround anybody has drawn?
 *
 * Total, and answering the DEFAULT rather than `null` for anything it does not
 * know — which is what makes a save written by a newer build survivable on an
 * older one, and what keeps `setSurround` from being the one verb that can
 * leave a world drawing nothing at all. A refusal belongs at the press (see
 * `Game.setSurround`, which asks `isSurround` first and says no out loud); a
 * READ has to answer something.
 */
export const isSurround = (id) => SURROUNDS.some((s) => s.id === id);

/** ...and the read. See `isSurround` for why this cannot fail. */
export const surroundOf = (id) => (isSurround(id) ? id : DEFAULT_SURROUND);
