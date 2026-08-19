/**
 * THE SHOP, IN A WORKER — the whole server side of a browser build.
 *
 * Step 4 of docs/browser.md. The store, the world list, the room, the 20Hz tick
 * and the 10Hz broadcast, on a thread of its own, with a `postMessage` pair
 * where the websocket used to be.
 *
 * WHY A WORKER, since the sim would run perfectly well on the main thread: **a
 * backgrounded tab is throttled to roughly 1Hz.** The host switches to another
 * tab and a 20Hz simulation becomes a 1Hz one — and at step 6, for the guest as
 * well, since they are watching the host's clock. Browsers throttle workers far
 * less. The ordinary second reason applies too: this keeps the sim off the
 * thread that draws the frame.
 *
 * It lives in `client/` because it is the thing Vite bundles, and it imports
 * across the boundary on purpose. **This file is the whole of that crossing** —
 * every other rule about the client/server line still stands.
 *
 * TWO KINDS OF FRAME, and the `@` is the whole protocol. Anything beginning `@`
 * is the harness talking: open a shop, close it, or ask the question the HTTP
 * control API answers in the other build. Everything else is a game message and
 * goes straight to the room, untouched, in exactly the shape Colyseus would have
 * delivered it. That is why this does not simply use `portChannel(self)` — a
 * worker has one `onmessage` and two jobs for it. `portChannel` stays as it is
 * for step 6, where both ends already know what they are before a frame is sent.
 *
 * THE STORE IS OWNED HERE, and that is the load-bearing decision in this file.
 * The menu needs to list, create and delete worlds *before* there is a room, and
 * the obvious way to do that is to let the main thread open the store too. It
 * cannot: two threads importing the same module are two module instances with
 * two sets of memory, both writing the same IndexedDB — so a shop created by the
 * menu would be invisible to the shop the worker opens. One owner, and the menu
 * asks it, exactly as it asks an HTTP server in the other build.
 */

import { ShopRoom } from '../server/rooms/shop.js';
import { ChannelHost } from '../server/rooms/host.js';
// Direct rather than through `server/db.js`, because this file IS the web entry
// and knows perfectly well which store it wants. The alias in vite.config.js
// points `db.js` at this same module, so everything here is talking about one
// store rather than two.
import { openStore, idbVault, flushStore } from '../server/store/web.js';
import { listWorlds, createWorld, deleteWorld, renameWorld } from '../server/worlds.js';
import { content, refresh } from '../server/content.js';

const Room = ShopRoom(ChannelHost);

let room = null;
let deliver = null;
/** Guests, by the id the main thread gave them. See `@peer-join`. */
const peers = new Map();

/**
 * The store is woken once, on load, and everything waits on the same promise.
 *
 * It has to happen before anything else because the store contract is
 * synchronous by design (see server/db.js): `Game.create` reads the save during
 * construction, and `listWorlds` reads rows the same way. This is the only
 * await in the whole boot, and that is not an accident — it is the seam between
 * an asynchronous database and a sim that must never wait for one.
 */
const booted = openStore(idbVault()).then(() => {
  // The registry is normally kept live by a 250ms poll against a version that
  // another process might bump. Nothing else can write here, so this is the one
  // and only load — `contentVersion` is a constant in the web store precisely
  // so that poll finds nothing for ever after.
  refresh();
  return true;
});

/** The room's end of the pipe. Harness frames never reach it. */
const channel = {
  post: (frame) => self.postMessage(frame),
  onFrame: (fn) => { deliver = fn; },
};

const reply = (type, payload) => self.postMessage([type, payload]);

self.onmessage = (e) => {
  const frame = e.data;
  if (!Array.isArray(frame)) return;
  const [type, payload] = frame;
  if (type === '@rpc') { rpc(payload).catch((err) => fatal(payload?.id, err)); return; }
  if (type === '@open') { open(payload ?? {}).catch((err) => fatal(payload?.id, err)); return; }
  if (type === '@peer-join') { peerJoin(payload); return; }
  if (type === '@peer-frame') { peers.get(payload?.id)?.deliver?.(payload.frame); return; }
  if (type === '@peer-left') { peerLeft(payload?.id); return; }
  if (type === '@save') { save(); return; }
  if (type === '@close') { close(); return; }
  deliver?.(frame);
};

/**
 * The four things the menu asks, answered in the shape `client/menu.js` already
 * expects from `fetch('/api/…')`.
 *
 * Deliberately not a general RPC over `server/api.js`: that module is express,
 * twenty-eight routes, and every one of the other twenty-four is an agent tool
 * for a surface this build does not have. Four cases is the honest size of what
 * a menu needs, and anything that wants a fifth should have to add it here on
 * purpose.
 */
async function rpc({ id, method, path, body }) {
  await booted;
  const answer = (data) => reply('@rpc', { id, ok: true, data });

  if (method === 'GET' && path === '/worlds') {
    return answer({ worlds: listWorlds(), focused: null });
  }
  if (method === 'GET' && path === '/content/worker') {
    return answer({ rows: content().workers });
  }
  if (method === 'POST' && path === '/worlds') {
    return answer({ world: createWorld(body ?? {}) });
  }
  if (method === 'DELETE' && path.startsWith('/worlds/')) {
    const id2 = decodeURIComponent(path.slice('/worlds/'.length));
    // `deleteWorld` disposes any live room for that world first. In this build
    // there is at most one, and it is the shop you are standing in — which the
    // menu will not offer to delete, but a stale tab could.
    await deleteWorld(id2);
    return answer({ deleted: id2 });
  }
  if (method === 'PATCH' && path.startsWith('/worlds/')) {
    const id2 = decodeURIComponent(path.slice('/worlds/'.length));
    return answer({ world: renameWorld(id2, body?.name) });
  }
  return reply('@rpc', { id, ok: false, error: `no route for ${method} ${path}` });
}

/** Open one shop. */
async function open({ worldId, name, who }) {
  await booted;
  if (room) close();

  const rows = listWorlds();
  const id = worldId ?? rows[0]?.id;
  if (!id || !rows.some((w) => w.id === id)) {
    // Answered rather than thrown, and the main thread turns it into the same
    // refusal `ShopRoom.onCreate` makes in the server build: a link naming a
    // shop that has since been deleted falls back to the menu instead of
    // minting a save nobody can see. See `LocalNet.connect`.
    reply('@no-world', { asked: id ?? worldId ?? '' });
    return;
  }

  room = new Room();
  room.start({ worldId: id });
  const client = room.join(channel, { name, who });
  reply('@ready', { worldId: id, sessionId: client.sessionId });
}

/**
 * A guest arrives — step 6 of docs/browser.md.
 *
 * The peer connection itself lives in the MAIN thread and not here, because
 * `RTCPeerConnection` is not exposed to workers. So the main thread owns the
 * wire and this owns the shop, and frames are relayed between them: exactly one
 * extra hop, invisible to `ShopRoom`, which is handed a channel of the same
 * three methods a Worker port has.
 *
 * The guest becomes an ordinary client — `room.join`, a `sessionId`,
 * `onJoin` — so every one of the fifty handlers, the broadcast and the idle
 * timer treat them as a second person in the shop, which is what they are. That
 * is the whole payoff of the transport seam: nothing in this feature had to
 * teach the game about a second player, because the game has always had them.
 */
function peerJoin({ id, name, who }) {
  if (!room) return; // nobody is hosting anything yet
  const peer = { deliver: null };
  const channel = {
    post: (frame) => self.postMessage(['@peer-frame', { id, frame }]),
    onFrame: (fn) => { peer.deliver = fn; },
    close: () => self.postMessage(['@peer-left', { id }]),
  };
  peer.client = room.join(channel, { name, who });
  peers.set(id, peer);
}

function peerLeft(id) {
  const peer = peers.get(id);
  if (!peer) return;
  peers.delete(id);
  // Through the room, so `onLeave` runs — which is what writes where they were
  // standing and what they were holding into `Game.away`. A guest whose wifi
  // drops for four seconds should come back to their own hands.
  if (peer.client) room?.leave(peer.client);
}

/**
 * Write the shop down where it stands, without shutting anything.
 *
 * The gap this closes is not the shop — `Game.persist` is already called from
 * some thirty places, so buying, building and the day roll all land in memory
 * and reach the vault a microtask later. It is **you**: where you are standing
 * and what is in your hands ride in `saveState`, and until now the only thing
 * that called it on your behalf was leaving. In the server build that never
 * mattered, because the server outlives the tab and `onLeave` runs when the
 * socket drops. Here the shop dies with the page, so closing it mid-aisle put
 * you back at the door with empty hands — which is precisely the bug
 * docs/shipping.md step 3 was written to fix, reintroduced by a new transport.
 *
 * `persist()` rather than `stop()`, because the page being hidden is not the
 * page being closed: tab back and the shop is still ticking, which is what you
 * want when you looked something up for ten seconds.
 */
function save() {
  room?.game.persist();
  flushStore().catch(() => {});
}

/**
 * Shut the shop down properly rather than letting the thread be terminated.
 *
 * `stop()` clears the tick and runs `onDispose`, and `onDispose` is what calls
 * `game.persist()`. A worker killed from outside skips both, so the last thing
 * that happened in the shop is not the last thing that was saved — and then
 * `flushStore` is the second half of the same sentence, because `persist()`
 * only reaches memory. Two steps, because the store is deliberately synchronous
 * on top of an asynchronous vault.
 */
function close() {
  room?.stop();
  room = null;
  peers.clear();
  flushStore().catch(() => {});
}

function fatal(id, err) {
  console.error('[worker] failed:', err);
  if (id != null) reply('@rpc', { id, ok: false, error: String(err?.message ?? err) });
  else reply('@error', { message: String(err?.message ?? err) });
}
