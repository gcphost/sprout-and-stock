/**
 * WHAT A SHOPPER LOOKS LIKE.
 *
 * A closed vocabulary, in `shared/` for the reason `shared/build.js` and
 * `shared/reputation.js` are: two ends have to agree about it and neither owns
 * it. `shared/schemas.js` validates an authored `look` against these lists, and
 * `client/render/props.js` builds the geometry for each entry. Written out by
 * hand in both, they would drift — and the way that fails is the one this repo
 * keeps finding: an archetype authored with a hairstyle the renderer has never
 * heard of validates perfectly, saves, loads, and draws a bald person, with
 * nothing anywhere saying a word.
 *
 * It is a vocabulary rather than a model (the shape a fixture, a worker and a
 * vehicle all use) because a person is a RIG, not a pile of parts: the renderer
 * has to sit a hairstyle on a head whose width moves with the build, hang arms
 * off shoulders that move with it, and keep a face on the front. A parts blob
 * has nobody to ask. The cost is that a new hairstyle is a line of code rather
 * than a row of content, and that is the honest trade — every other authored
 * thing in the game stands still.
 */

/**
 * How a body is proportioned, as four numbers.
 *
 * Four, because a silhouette at shop-camera zoom is height, width, shoulders
 * and waist and nothing else. A build that moved a dozen measurements would
 * differ from its neighbour in ways the camera cannot resolve, which is a knob
 * that costs authoring effort and moves no pixel.
 *
 * `shoulder` against `belly` is the pair that does the work, and they are
 * deliberately independent: wide-over-narrow is a bodybuilder, narrow-over-wide
 * is a pear, and those are the same character with two numbers swapped. One
 * "size" number could say neither of them.
 */
export const BUILDS = {
  regular: { h: 1.00, w: 1.00, shoulder: 1.00, belly: 1.00 },
  slight: { h: 1.00, w: 0.88, shoulder: 0.90, belly: 0.86 },
  stout: { h: 0.94, w: 1.12, shoulder: 1.00, belly: 1.26 },
  buff: { h: 1.08, w: 1.04, shoulder: 1.40, belly: 0.82 },
  tall: { h: 1.16, w: 0.94, shoulder: 1.02, belly: 0.92 },
  kid: { h: 0.76, w: 0.94, shoulder: 0.86, belly: 1.00 },
};

export const CHARACTER_BUILDS = Object.keys(BUILDS);

/**
 * Hairstyles.
 *
 * This is the half a Karen, an emo and a buff guy are actually told apart by:
 * a build says big or small, and at the eight pixels a shopper across the shop
 * gets, the hair says WHO.
 *
 * `none` is first because it is the one that has to keep working — a row that
 * wants a bald shopper must not have to pick a haircut and hide it.
 */
export const CHARACTER_HAIRS = [
  'none', 'crop', 'bob', 'swept', 'fringe', 'spikes', 'bun', 'cap', 'beanie',
  'puffs', 'mohawk', 'hardhat',
];

/**
 * A beard, which is the cheapest silhouette in the whole file.
 *
 * It is its own slot rather than more entries in `CHARACTER_HAIRS` because it
 * is a different PART OF THE HEAD, and folding it in would mean a combinatorial
 * list — `beanie`, `beanie-with-beard`, `cap-with-beard` — which is the shape
 * that makes a vocabulary stop being one. A lumberjack is a beanie AND a beard,
 * and neither of those is a hairstyle.
 *
 * It takes the hair's colour rather than one of its own. A beard that disagreed
 * with the hair above it is a thing you have to author carefully to avoid, and
 * nothing here is worth a second colour field yet.
 */
export const CHARACTER_BEARDS = ['none', 'stubble', 'moustache', 'goatee', 'full'];

/**
 * One thing on the face.
 *
 * Deliberately a single slot rather than a flag each: glasses and a clown's
 * nose are never worn together, and a slot that can only hold one thing cannot
 * be authored into a contradiction. `nose` is the one entry here that is a
 * *character* rather than an accessory, and it earns its place because a clown
 * without one is a person with silly hair.
 */
export const CHARACTER_FACES = ['none', 'glasses', 'shades', 'nose'];

/**
 * What a shopper with NO authored look falls back to.
 *
 * Every archetype in every database predates this file, so this list is what
 * the crowd looks like in a shop where nobody has authored a thing — which is
 * every shop today. It is deliberately the quiet end of the vocabulary: `swept`
 * and `fringe` are characters, and a character handed out at random to a third
 * of the town stops being one.
 */
export const STOCK_HAIR = ['crop', 'bob', 'cap', 'beanie', 'bun', 'spikes'];
export const STOCK_HAIR_COLOR = ['#3a2e28', '#5c4538', '#7d5230', '#9a8f86', '#2b2b30'];
