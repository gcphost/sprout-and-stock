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

/**
 * How long to wait before each attempt at getting back in, in ms.
 *
 * Front-loaded, because the overwhelmingly common drop is a dev-server restart
 * (`node --watch` on `server/` and `shared/`) and that is back inside a second
 * — so the first retry should land while you are still looking at the shop
 * rather than after a pause long enough to reach for the reload. The tail is
 * for a laptop lid or a tunnel blipping, where nothing is going to help for a
 * few seconds anyway. Roughly sixteen seconds all in.
 */
const REJOIN_WAITS = [300, 700, 1500, 3000, 5000, 5000];

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

export class Net {
  constructor() {
    this.room = null;
    this.myId = null;
    this.handlers = {};
    // A page on its way out closes the socket like any other drop, and trying
    // to rejoin from a document that is unloading either fails noisily or —
    // worse, on a reload — races the fresh page for the same `who`, whose
    // record `addPlayer` CONSUMES. Two claimants for one armful.
    this.closing = false;
    addEventListener('pagehide', () => { this.closing = true; });
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
    // Kept so a rejoin can be made without asking anybody. `who` is already
    // stable across sockets (see `whoAmI`), so these two are the whole of what
    // it takes to walk back in as the same person.
    this.name = name;

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

    this.room.onLeave(() => this.rejoin());
    return this.room;
  }

  /**
   * The socket went away without being asked to. Walk back in.
   *
   * Every drop reaches here, because the client has no deliberate `leave` —
   * going back to the front door is a page navigation, and `closing` covers
   * that. So there is nothing to tell apart: a socket that closed while the
   * page is still up is one nobody wanted closed.
   *
   * The reason this is worth having at all is the dev loop rather than the
   * network. `dev:server` runs under `node --watch` over `server/` and
   * `shared/`, so every edit to either restarts the process and drops everyone
   * standing in the shop — and devMode restores the room, so the shop is
   * genuinely still there half a second later. What you got was a toast telling
   * you the game had gone, over a game that had not, and the only way back was
   * a reload.
   *
   * `disconnected` is now the GIVING UP rather than the drop, which is why the
   * toast that hangs off it did not have to move: it says the true thing in
   * both worlds, and it says it a good deal less often.
   */
  async rejoin() {
    if (this.closing || this.rejoining) return;
    this.rejoining = true;
    this.emit('dropped');
    try {
      for (const wait of REJOIN_WAITS) {
        await sleep(wait);
        if (this.closing) return;
        try {
          await this.connect(this.name, this.worldId);
          this.emit('rejoined');
          return;
        } catch { /* the server is still coming up; try the next one */ }
      }
      this.emit('disconnected');
    } finally {
      this.rejoining = false;
    }
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
