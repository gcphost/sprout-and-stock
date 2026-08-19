/**
 * COLYSEUS, IN A BUILD THAT HAS NONE.
 *
 * A build shim and not a second implementation of anything: `vite.config.js`
 * points the bare `colyseus` specifier here when `VITE_SNS_LOCAL` is set, so
 * that a browser bundle cannot follow a stray import into a Node websocket
 * server.
 *
 * It exists because of ONE line — `server/worlds.js` needs `matchMaker` in
 * `roomForWorld`, which starts a headless room for an agent that asked about a
 * shop nobody has open. There is no such thing in a tab: there is one room and
 * it is the one you are standing in. Making the import dynamic was not enough,
 * because a dynamic import is still an edge in the module graph — the build
 * followed it and died resolving `@pm2/io`, a process-metrics package, from a
 * file about save slots.
 *
 * It THROWS rather than no-oping, and that is the whole of the design here. A
 * silent stub would let a call that cannot work look like a call that did
 * nothing, which is the shape of every bug this port has been written to avoid.
 * Nothing in the web build calls it; if something ever does, this says so by
 * name and in one line.
 */

const nope = (what) => () => {
  throw new Error(`${what} needs a matchmaker, and this build has none — see server/rooms/no-matchmaker.js`);
};

export const matchMaker = {
  createRoom: nope('createRoom'),
  joinOrCreate: nope('joinOrCreate'),
  query: nope('query'),
  remoteRoomCall: nope('remoteRoomCall'),
};

/**
 * The base class, so that an accidental `import { Room } from 'colyseus'` fails
 * where it is written instead of at the bundler. `server/rooms/shop.js` has no
 * such import — that is the point of it being its own file — and this is the
 * belt to that pair of braces.
 */
export class Room {
  constructor() {
    throw new Error('this build has no Colyseus — the room is ShopRoom(ChannelHost), see server/rooms/host.js');
  }
}

export class Server extends Room {}
