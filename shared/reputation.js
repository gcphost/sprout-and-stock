/**
 * WHY THE SHOP'S NAME MOVED — the seven causes, in one place.
 *
 * Reputation is the slowest number in the game and the only one that had no
 * receipt. It is written from seven places at seven different rates — a
 * storm-out is worth six turned-away shoppers, and an hour of being too packed
 * to move is worth an unbounded number of either — so a shop sliding from 70%
 * to 40% over a week could say *that it had* and nothing whatsoever about what
 * did it. The HUD bar has always answered "how am I doing"; nothing anywhere
 * answered "what is costing me", which is the only version of the question a
 * player can act on.
 *
 * This is the vocabulary for that answer, and it lives in `shared/` for the
 * reason `shared/jobs.js` and `shared/pieces.js` do: three different readers
 * need to agree about it and none of them owns it.
 *
 * - `server/sim/index.js` writes the keys (`Game.moveRep`), so a cause is an
 *   `R.` constant rather than a string literal — a typo would otherwise open a
 *   silent eighth bucket that every readout prints as a raw key.
 * - `client/report.js` draws them, in the order below.
 * - `server/sim/simulate.js` names the worst one in its verdict.
 *
 * The ORDER is the reading order in the report: gains first, then the losses
 * roughly by how much a shop can do about them. It is not sorted by size at
 * runtime — a list whose rows swap places as you watch is a list you have to
 * re-read every time, and the bars already say which is biggest.
 *
 * Adding an eighth: a constant, a row here, and the `moveRep` call. Nothing
 * else — the panel maps over this table, and a cause with nothing behind it
 * today is simply not drawn.
 */

/** The cause ids, so nothing has to spell one by hand. */
export const R = {
  SERVED: 'served',
  GRUMPY: 'grumpy',
  STORMED: 'stormed',
  EMPTY: 'empty',
  MISSED: 'missed',
  CROWD: 'crowd',
  TURNED: 'turned',
  SHUT: 'shut',
};

/**
 * `name` is what the report calls it, `why` is what the balance runner says in
 * a sentence, and `up` marks the one cause that is ever a gain.
 *
 * Two spellings rather than one because they are read in two different voices:
 * the panel's row sits under a bar in a shop somebody is playing, and the
 * verdict line is a fragment inside "Reputation fell 8 points over the run —
 * mostly …". A single string cannot be both without reading badly in one of
 * them.
 */
export const REP_CAUSES = [
  {
    id: R.SERVED,
    up: true,
    name: 'Served happily',
    sub: 'left the till in a good mood',
    why: 'happy customers',
  },
  {
    id: R.GRUMPY,
    name: 'Served, but fed up',
    sub: 'bought something and left annoyed anyway',
    why: 'customers who bought but left annoyed',
  },
  {
    id: R.STORMED,
    name: 'Lost patience',
    sub: 'gave up waiting and walked out',
    why: 'shoppers losing patience and walking out',
  },
  {
    id: R.EMPTY,
    name: 'Left empty-handed',
    sub: 'came in, bought nothing at all',
    why: 'shoppers leaving with nothing',
  },
  {
    id: R.MISSED,
    name: 'You had none',
    sub: 'came in for something and you were out of it',
    why: 'coming in for things you had none of',
  },
  {
    id: R.CROWD,
    name: 'Too packed',
    sub: 'no room to move around the shop',
    why: 'the shop being too crowded to move in',
  },
  {
    id: R.TURNED,
    name: 'Turned away',
    sub: 'looked in, saw the crush, walked on',
    why: 'people turned away at a full door',
  },
  {
    id: R.SHUT,
    name: 'Found you shut',
    sub: 'walked up during opening hours to a closed door',
    why: 'people finding the shutters down in the middle of the day',
  },
];

/** By id, for a reader that has a key and wants the words. */
export const REP_BY_ID = Object.fromEntries(REP_CAUSES.map((c) => [c.id, c]));

/**
 * The whole day's movement — the sum of what caused it.
 *
 * Deliberately a sum of the causes rather than a difference of two levels, and
 * that is the claim the panel rests on: the total under the bars is arithmetic
 * on the bars, so a rounding step or a missing cause shows up as a total that
 * does not add up rather than as a breakdown that quietly explains less than
 * all of it.
 */
export const netRep = (moves) => Object.values(moves ?? {}).reduce((a, b) => a + b, 0);
