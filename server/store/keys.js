/**
 * THE TWO THINGS BOTH STORES HAVE TO AGREE ABOUT.
 *
 * Neither is storage. `worldStateKey` is the shape of the key a save lives
 * under and `DEFAULT_WORLD_ID` is the id every save carried before saves had
 * ids — they are the *format*, and a backend that spelled either of them
 * differently would be a store that cannot read its own saves.
 *
 * Their own module rather than living in `server/db.js` for one boring reason:
 * `db.js` re-exports the backend and the backend needs these, so putting them
 * there is a cycle. Kept out of `sqlite.js` for a less boring one — a constant
 * defined inside one implementation is a constant the *next* implementation
 * copies, and two copies of a key format is a save that opens in one build and
 * not the other.
 */

/** The id every save carried before saves had ids. */
export const DEFAULT_WORLD_ID = 'default';

/** Where one world's save blob lives in the `world` key/value table. */
export const worldStateKey = (id) => `state:${id}`;
