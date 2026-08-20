/**
 * WHAT THE WORLD IS DOING, AS ONE NUMBER.
 *
 * `shared/model.js` says a model is either one look or a run of stages, and
 * whoever draws it passes a single 0..1 number — growth for a crop, the tier for
 * a fixture, how far through a break somebody is. Every one of those is a fact
 * about the THING. This is the other kind of driver: a fact about the shop,
 * which the thing has no way to know on its own.
 *
 * A clock and a sign are the two that make the case. Both are props, so their
 * one 0..1 is spent on a tier ladder they do not have — a piece with a single
 * tier resolves to 0 for ever, which is why every hanging sign in the game has
 * been a photograph of a sign. A clock that does not tell the time and an OPEN
 * sign hanging over a shut shop are the same failure, and neither is a bug you
 * can see: they look exactly like a clock and a sign.
 *
 * So a piece may name a signal, and naming one is what spends its 0..1 on the
 * world instead of on its tier. Both readers take it from here:
 *
 *   stages   the model swaps look — a sign that says CLOSED and then OPEN
 *   sweep    a part turns TO the number rather than looping — a clock hand
 *
 * It lives in `shared/` for the reason `model.js` does: the schema validates the
 * name on the way into the database and the renderer resolves it on the way out,
 * and those two disagreeing is a piece that authors fine and draws nothing.
 *
 * **Adding one is two lines here and no code anywhere else** — a name in the
 * list and a case in `signalValue`. What it costs is the thing CLAUDE.md warns
 * about repeatedly: a signal nothing is authored against is indistinguishable
 * from a signal that does not work, so add one when you are about to draw the
 * prop that reads it, not before.
 */

/**
 * Every world quantity a prop may watch, and what each means as 0..1.
 *
 * A closed set, for the reason `BUILD_KINDS` and `KIT_USES` are: the sim has to
 * be able to answer each of these, so an open one would let content name a
 * number nothing can ever hand it.
 */
export const WORLD_SIGNALS = {
  /**
   * How far through the day it is — 0 at midnight, 0.5 at noon, back to 0.
   *
   * The whole day rather than the trading window, because a clock face is a
   * clock face at four in the morning. A sweep of `turns: 2` is therefore an
   * hour hand and `turns: 24` is a minute hand, and both read 12 o'clock at
   * midnight with no offset anywhere.
   */
  time: 'How far through the day it is, midnight to midnight',
  /**
   * Whether anybody is being served: the shutters up AND the trading day open,
   * which is `isOpen()` and deliberately not either half on its own. A sign
   * that reads OPEN because you left the shutters up is a sign that lies twelve
   * hours a day.
   */
  open: 'Whether the shop is serving right now — 1 or 0',
};

/** The names, for a schema that has to validate one. */
export const SIGNAL_NAMES = Object.keys(WORLD_SIGNALS);

/**
 * What `name` is worth in `state`, as 0..1, or null when the snapshot cannot
 * say yet.
 *
 * Null rather than 0 because the two mean different things to a caller: a shop
 * whose first frame has not arrived is not a shut shop at midnight, and a prop
 * that snapped from one to the other on the second frame reads as a flicker.
 * Whoever asks holds its last answer instead.
 */
export function signalValue(name, state) {
  if (!state) return null;
  if (name === 'time') return clamp01(state.time);
  if (name === 'open') return state.isOpen ? 1 : 0;
  return null;
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}
