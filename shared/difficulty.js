/**
 * HOW HARD THE TOWN IS ON YOU.
 *
 * The second axis of a new shop. `shared/start.js` owns *how much shop* — the
 * money on day one and the building around it — which is a question about where
 * you begin. This one is about what happens next: whether standing still costs
 * anything, and how far down a shop nobody is looking after can actually go.
 *
 * See docs/difficulty.md for why it needed to exist. The short of it: three
 * decisions that are each individually right add up to a shop that cannot rot.
 * The town forgets a bad week (`repSettle`), a floored shop still gets a
 * trickle (`pullFloor`), and nothing at all costs money until you hire somebody
 * — so a neglected shop converges on mediocre and sits there for a hundred
 * days, while `townGrowth` quietly makes it busier the whole time. That last
 * clause is weaker than it was and deliberately so: the town is banked at a
 * rate scaled by reputation now (`TOWN_PER_DAY`), so a mediocre shop still
 * grows and grows at a mediocre pace, where the old day-based curve handed it
 * the same town a thriving one got.
 *
 * **Explicit numbers, not multipliers over the constants.** Same shape as
 * `START_TIERS` and for a better reason than symmetry: `0.6 × REP_SETTLE` is a
 * number nobody can read and nobody can argue with, where `repSettle: 0.22` is
 * a line in a table you can look at and disagree about. Every value here is the
 * whole value the sim uses.
 *
 * Shared for the reason `shared/start.js` is: the server reads the numbers and
 * is the authority on them, the menu reads `name` and `blurb` to say what you
 * are choosing between. Labels hardcoded in the client beside numbers held on
 * the server is the second-picture-of-one-thing trap `client/thumb.js` exists
 * to avoid, and here it would present as a menu that promises a hard game and
 * hands you an easy one.
 */

/**
 * @typedef {object} Difficulty
 * @property {string} id
 * @property {string} name           what the button says
 * @property {string} blurb          what it says underneath, in shop terms
 * @property {number} repSettle      the level a bad week decays back UP to
 * @property {number} repSettleRate  how much of that gap closes per trading day
 * @property {number} pullFloor      share of the town that comes anyway, at rep 0
 * @property {number} moodBase       the mood a shopper walks in on, day one
 * @property {number} moodFloor      ...and what it decays to over `MOOD_TAU`
 */

/** @type {Difficulty[]} */
export const DIFFICULTIES = [
  {
    id: 'relaxed',
    name: 'Relaxed',
    blurb: 'The town forgives a bad week and somebody always walks in. '
      + 'Nothing here goes badly wrong while you find your feet.',
    repSettle: 0.35,
    repSettleRate: 0.45,
    pullFloor: 0.08,
    moodBase: 0.72,
    moodFloor: 0.45,
  },
  {
    id: 'normal',
    name: 'Normal',
    blurb: 'A bad week stays bad for a while, and a shop nobody rates is one '
      + 'fewer people bother with. A slide is yours to stop.',
    repSettle: 0.22,
    repSettleRate: 0.30,
    pullFloor: 0.05,
    moodBase: 0.68,
    moodFloor: 0.42,
  },
  {
    id: 'hard',
    name: 'Hard',
    blurb: 'The town has a long memory and somewhere else to shop. People arrive '
      + 'short of patience and do not come back for nothing.',
    repSettle: 0.10,
    repSettleRate: 0.18,
    pullFloor: 0.02,
    moodBase: 0.60,
    moodFloor: 0.36,
  },
];

/**
 * THE TWO DEFAULTS, AND WHY THEY ARE DIFFERENT ONES.
 *
 * This is the whole safety of the feature and it is the same asymmetry
 * `createWorld` uses for `open` and `time` — written at creation, defaulted the
 * other way at read.
 *
 * `SAVED_DIFFICULTY` is what a save with nothing to say reads as, and it has to
 * be the preset whose numbers are the old constants to the digit. Every
 * existing shop reads it, and so does every headless game: `simulate` and all
 * fifteen `verify:*` sweeps build from a save, so a default that shifted the
 * constants would have every balance run in the project measuring a different
 * game with nothing in the output to say why. Same trap, same shape, as
 * defaulting `open` to `false` and reporting zero revenue.
 *
 * `NEW_DIFFICULTY` is what a brand new shop is *written* with, and it is a
 * harder game than anyone has played. That is the point of the split: today's
 * balance is the gentle one — it simply never had anything beside it to be
 * gentle compared to — so it keeps every save it already owns and stops being
 * what you get for saying nothing.
 */
export const SAVED_DIFFICULTY = 'relaxed';
export const NEW_DIFFICULTY = 'normal';

/** A preset by id, or null. Blank and unknown are the same answer — see `difficultyOf`. */
export const difficultyById = (id) => DIFFICULTIES.find((d) => d.id === String(id ?? '')) ?? null;

/**
 * The preset a save meant, always answering with one.
 *
 * An unknown id falls back rather than throwing, for the reason `startTier`
 * gives: this is read on the way into a live shop, and refusing to open
 * somebody's world over a stale id from an older client is a worse trade than
 * quietly handing them the gentle numbers.
 */
export const difficultyOf = (id) => difficultyById(id) ?? difficultyById(SAVED_DIFFICULTY);

/**
 * ...and the one a *creation* request meant, which defaults the other way.
 *
 * Separate function rather than a parameter, because the two defaults are the
 * feature and a boolean argument would let a caller pick the wrong one by
 * accident. There is exactly one caller of this and it is `createWorld`.
 */
export const startDifficulty = (id) => difficultyById(id) ?? difficultyById(NEW_DIFFICULTY);
