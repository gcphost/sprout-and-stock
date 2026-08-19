/**
 * THE SHOP, HOSTED BY COLYSEUS. The whole of the Node binding, and deliberately
 * the whole of it — every line of the game is next door in
 * [shop.js](shop.js), written against ten calls and no transport at all.
 *
 * Keeping this in its own file is not tidiness. `shop.js` is imported by a
 * browser bundle (see docs/browser.md), and one `import { Room } from 'colyseus'`
 * in that file would drag a Node websocket server in with it. The seam only
 * means anything if the thing on the far side of it can actually be left out.
 *
 * `instanceof Room` holds through the mixin, which is what `gameServer.define()`
 * and devMode's prototype lookups want, and the class keeps its name so the
 * matchmaker's logs say what they always said.
 *
 * The registry re-exports are here so that `server/api.js` and
 * `server/worlds.js` — which want the live rooms rather than the class — go on
 * importing from where they always did.
 */

import { Room } from 'colyseus';
import { ShopRoom } from './shop.js';

export { ShopRoom, rooms, primaryRoom } from './shop.js';

export class MartRoom extends ShopRoom(Room) {}
