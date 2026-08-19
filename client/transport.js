/**
 * WHICH NETWORK THIS BUILD HAS — the one line that decides, and it is an alias
 * rather than a branch.
 *
 * The server build gets [`Net`](net.js), a websocket to `server/index.js`. The
 * web build gets [`LocalNet`](localnet.js), a Worker in this tab — swapped in by
 * `vite.config.js`, which points this specifier at `transport.web.js` when
 * `VITE_SNS_LOCAL` is set. Same argument as the store swap in `server/db.js`:
 * no boot order to get wrong, no entry point that has to remember, and the
 * branch not taken is not merely unused but *absent*.
 *
 * A ternary over two dynamic imports was tried first and is the trap worth
 * recording, because it looks like it works: `import.meta.env` folds at build
 * time, so the dead branch does vanish from the output — but Rollup resolves
 * both edges of the graph long before it decides that, so the SERVER build
 * followed `localnet.js` into the worker, into `server/worlds.js`, and into a
 * Node websocket server. What that reads as is fifty lines of "Module 'http'
 * has been externalized for browser compatibility" in the build that was not
 * being changed.
 */

export { Net as Transport } from './net.js';
