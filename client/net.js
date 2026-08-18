/**
 * NETWORK.
 *
 * Thin wrapper over the Colyseus client. State arrives as plain JSON snapshots
 * at 10Hz — no schema classes to learn, you can `console.log(state)` and read
 * the whole world.
 */

import { Client } from 'colyseus.js';

/**
 * WHO YOU ARE, ACROSS CONNECTIONS.
 *
 * A `sessionId` is minted per socket, so as far as the shop was concerned every
 * reload was a different person walking in — which is why you came back at the
 * door with empty hands however carefully you had positioned yourself. This is
 * the id that outlives the socket: step 3 of docs/shipping.md, and the thing
 * `removePlayer`'s own comment says is missing.
 *
 * In localStorage rather than a cookie or a server-issued token, because it has
 * exactly one job — being the same string tomorrow — and this is where the name
 * and the last world played already live. Two browsers are two people on
 * purpose: a shop you open on the laptop should not walk the shopkeeper out of
 * the tab on the desktop.
 */
const ME = 'sns-me';

function whoAmI() {
  try {
    const had = localStorage.getItem(ME);
    if (had) return had;
    // `randomUUID` needs a secure context and a tunnel is one; the fallback is
    // for plain-http LAN play, where a collision between two people would mean
    // one of them spawning in the other's shoes.
    const made = crypto.randomUUID?.()
      ?? `me-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(ME, made);
    return made;
  } catch {
    // Private mode, or storage turned off. No stable id means the old behaviour
    // — the door, empty-handed — rather than a crash.
    return null;
  }
}

export class Net {
  constructor() {
    this.room = null;
    this.myId = null;
    this.handlers = {};
  }

  on(event, fn) {
    (this.handlers[event] ??= []).push(fn);
    return this;
  }

  emit(event, payload) {
    for (const fn of this.handlers[event] ?? []) fn(payload);
  }

  /**
   * Join one shop.
   *
   * `worldId` is not optional. The server matches rooms on it (`filterBy` in
   * server/index.js), so leaving it off doesn't mean "any shop" — it means a
   * room whose world is undefined, which is a shop that saves nowhere.
   */
  async connect(name, worldId) {
    if (!worldId) throw new Error('no world chosen');
    this.worldId = worldId;

    // Same host as the page, so this works unchanged behind a tunnel.
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const port = import.meta.env.DEV ? 2567 : location.port;
    const endpoint = `${proto}://${location.hostname}${port ? `:${port}` : ''}`;

    const client = new Client(endpoint);
    this.room = await client.joinOrCreate('mart', { name, worldId, who: whoAmI() });

    this.room.onMessage('you', (m) => {
      this.myId = m.id;
      // The server names the shop; the client only ever knew its id.
      this.world = m.world ?? { id: worldId, name: worldId };
      this.emit('you', m);
    });
    this.room.onMessage('layout', (m) => this.emit('layout', m));
    // What the walls are painted, on its own. A layout is the shop having
    // MOVED, and the client throws the whole scene away on one — see
    // `Scene.setPaint` for why a colour must not cost that.
    this.room.onMessage('paint', (m) => this.emit('paint', m));
    this.room.onMessage('catalog', (m) => this.emit('catalog', m));
    this.room.onMessage('state', (m) => this.emit('state', m));
    this.room.onMessage('action-result', (m) => this.emit('action', m));
    this.room.onMessage('news', (m) => this.emit('news', m));
    // A milestone the shop has just passed. Its own message rather than a field
    // on the snapshot: it is an *event*, and a snapshot is a picture of now —
    // the client would have to diff two pictures to find it, and a dropped
    // frame at the wrong moment would be an award nobody was ever told about.
    this.room.onMessage('achieved', (m) => this.emit('achieved', m));
    this.room.onMessage('content-changed', (m) => this.emit('content-changed', m));

    // The server has no renderer, so when an agent asks "what does it look
    // like right now?", the answer has to come from a real browser tab.
    this.room.onMessage('screenshot-request', async ({ id }) => {
      let dataUrl = null;
      try {
        dataUrl = await this.emitScreenshot();
      } catch (err) {
        console.error('[net] screenshot failed:', err);
      }
      // Goes back over HTTP, not the websocket: a PNG is ~150KB and Colyseus
      // drops (and closes) inbound frames over 4KB.
      fetch('/api/screenshot/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, dataUrl }),
      }).catch((err) => console.error('[net] screenshot upload failed:', err));
    });

    this.room.onLeave(() => this.emit('disconnected'));
    return this.room;
  }

  /** Set by main.js — returns a PNG data URL of the current frame. */
  onScreenshot(fn) { this.screenshotFn = fn; }
  async emitScreenshot() {
    if (!this.screenshotFn) throw new Error('no renderer attached');
    return this.screenshotFn();
  }

  send(type, payload) {
    this.room?.send(type, payload);
  }
}
