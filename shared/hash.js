/**
 * A STABLE 0..1 FROM A STRING — the draw that isn't one.
 *
 * Every balance number in the game is downstream of how many times the sim's
 * rng has been called. That is why `Game.namer` is a stream of its own, and it
 * is why anything *cosmetic* and *per-person* must not come off `this.rng`:
 * drawing a shopper's bag out of the measured stream would move every basket,
 * crop and spawn roll after it, and two `simulate` runs either side of authoring
 * a paper bag would diverge with nothing in the output to say why.
 *
 * A hash of who they are costs no draw at all, which beats either stream. The
 * same shopper always carries the same bag, a reload gives them it back, and the
 * balance is provably untouched because nothing random happened.
 *
 * It lives in `shared/` for the reason `shared/jobs.js` and `shared/pieces.js`
 * do — three readers need to agree about it and none of them owns it:
 *
 * - `server/sim/index.js` picks a shopper's kit with it (`hash01(id:use)`).
 * - `server/sim/staff.js` picks where a hire wanders next on a chore, which is
 *   the reader that made this a file: it fires for every idle worker on every
 *   quiet tick, so an rng draw there would not nudge the stream, it would
 *   shred it.
 * - the client has done the same for a hire's breathing phase since before this
 *   existed (`hashId`, render/scene.js), which is what suggested it.
 *
 * Reach for it for anything cosmetic and per-person. If you find yourself
 * wanting a random *outcome* — what somebody buys, whether a crop takes — that
 * is the sim's rng and it belongs in the measured stream.
 */
export const hash01 = (str) => {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
};
