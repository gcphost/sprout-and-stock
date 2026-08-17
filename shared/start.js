/**
 * HOW MUCH SHOP YOU START WITH.
 *
 * Three sizes, and the size is the whole decision: how much money is in the
 * till on day one, and how much building there is around it. They go together
 * on purpose — a shop is mostly the walking you do in it, and $250 of stock
 * rattling around six shelves is the same shop as $250 of stock on two, except
 * that every trip to the counter takes four times as long. That was the old
 * default, and it read as the game being slow rather than as the shop being
 * too big for the money.
 *
 * The counts are a *starting kit*, not a ceiling: everything here is something
 * you can build more of, and the tier only decides where you begin. Which is
 * also why there is no "custom" tier — the numbers used to be three text boxes
 * in the new-shop form, and a shelf count typed before you have seen a shelf is
 * a decision nobody has the information to make. Sizes you can compare are.
 *
 * **The building is derived, never authored.** There is no `w`/`h` in here and
 * there must not be: `generateLayout` grows the shop until what it was asked
 * for genuinely fits, which is the invariant the whole of `server/layout.js`
 * rests on. Ask for two shelves and the building comes out small because there
 * is nothing to put in a bigger one — so a tier gets its footprint for free,
 * and cannot ever ask for a shop its own contents do not fit into.
 *
 * Shared because both ends need the same table for different halves of it. The
 * server reads `fixtures` and `cash` and is the authority on both; the menu
 * reads `name` and `blurb` to say what you are choosing between. The alternative
 * — labels hardcoded in the client beside numbers held on the server — is the
 * second-picture-of-one-thing trap `client/thumb.js` exists to avoid, and here
 * it would present as a menu that promises two shelves and hands you five.
 */

/**
 * @typedef {object} StartTier
 * @property {string} id       what the API is sent
 * @property {string} name     what the button says
 * @property {number} cash     what the cash box is pre-filled with
 * @property {object} fixtures the one-shot budget `starterShop` furnishes from
 * @property {string} blurb    what the button says underneath, in shop terms
 */

/** @type {StartTier[]} */
export const START_TIERS = [
  {
    id: 'corner',
    name: 'Corner shop',
    cash: 250,
    fixtures: { shelf: 2, freezer: 1, checkout: 1, plot: 4 },
    blurb: 'One short aisle, a cooler and a till. The smallest building the game will draw.',
  },
  {
    id: 'mini',
    name: 'Mini-mart',
    cash: 800,
    fixtures: { shelf: 5, freezer: 1, checkout: 1, plot: 6 },
    blurb: 'Two aisles and a bigger farm. Room to carry a range rather than a shelf of it.',
  },
  {
    id: 'super',
    name: 'Supermarket',
    cash: 2400,
    fixtures: { shelf: 10, freezer: 2, checkout: 2, plot: 10 },
    blurb: 'A second till, so a queue has somewhere else to go. Big enough to need staff.',
  },
];

/**
 * The one you get for saying nothing.
 *
 * The smallest, deliberately: it is the only one of the three that teaches you
 * what a shelf is worth before you own ten of them, and it is the one a shop
 * grows *out of*, which is the game.
 */
export const DEFAULT_TIER = 'corner';

/** A tier by id, or null. Blank and unknown are the same answer — see `startTier`. */
export const tierById = (id) => START_TIERS.find((t) => t.id === String(id ?? '')) ?? null;

/**
 * The tier a request meant, always answering with one.
 *
 * An unknown id falls back rather than refusing, for the reason every other
 * starting number is clamped rather than bounced: this is the last gate before
 * a shop exists, and losing the name, the seed and the money somebody typed
 * over a stale tier id from an older client is a worse trade than quietly
 * starting them small.
 */
export const startTier = (id) => tierById(id) ?? tierById(DEFAULT_TIER);

/** How many of each kind a tier opens with, as a fresh object nobody shares. */
export const tierFixtures = (id) => ({ ...startTier(id).fixtures });
