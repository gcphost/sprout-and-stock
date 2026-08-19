/**
 * THE SECOND HOST — the shop with no server under it.
 *
 * `ShopRoom` (server/rooms/MartRoom.js) is the game, written against ten calls
 * and nothing else. `MartRoom` is those ten calls answered by Colyseus. This is
 * the other answer: they are answered by a **channel**, which is a `postMessage`
 * pair to a Worker today and a `RTCDataChannel` to somebody else's browser at
 * step 6 of docs/browser.md.
 *
 * It is the same object in both cases because it never learns which: a channel
 * is `{ post(frame), onFrame(fn), close() }` and the difference between a worker
 * boundary and a peer connection is entirely inside those three.
 *
 * THE RULE this file exists to obey: **no behaviour lives here.** Every method
 * below either moves a frame or keeps a timer. If you find yourself wanting to
 * put a game rule in — who may join, what a message means, when to save — it
 * belongs in `ShopRoom`, where the Colyseus build will get it too. The whole
 * value of the seam is that the other `verify:*` sweeps run against the other
 * Base and are therefore evidence about this one; a rule that lives on one side
 * only is the thing that ends that.
 *
 * ONE HONEST DIFFERENCE, and it is a difference in the world rather than in the
 * code: Colyseus mints a `sessionId` per socket and so does this, but there is
 * no matchmaker above it. Nothing here decides *which* room you reach, because
 * in a tab there is one, and at step 6 the peer connection has already decided
 * by the time a frame arrives.
 */

/**
 * A duplex of JSON-able frames.
 *
 * `onClose` is optional and only one transport has ever needed it: a worker port
 * cannot go away on its own, and a peer can. See the note on it in
 * `client/peer.js` — the shape lives here, the reason lives there.
 *
 * @typedef {{
 *   post(frame: any): void,
 *   onFrame(fn: (frame: any) => void): void,
 *   onClose?(fn: () => void): void,
 *   close?(): void,
 * }} Channel
 */

/** A frame is `[type, payload]`. Positional because every frame carries one. */
const FRAME = (type, payload) => [type, payload];

let seq = 0;

/**
 * Wrap a `postMessage` endpoint — a `Worker`, a `MessagePort`, or `self` inside
 * a worker — as a channel. The one place either side knows what a worker is.
 */
export function portChannel(port) {
  return {
    post: (frame) => port.postMessage(frame),
    onFrame: (fn) => { port.onmessage = (e) => fn(e.data); },
    close: () => port.close?.(),
  };
}

/**
 * Two channels wired to each other, in one thread.
 *
 * Not a test double — it is the no-worker case, which is worth keeping working
 * for two reasons. It is the thing to fall back to if `Worker` is unavailable
 * (an old embedded webview, a locked-down enterprise browser), and it is the
 * only configuration in which you can put a breakpoint in the sim and in the
 * renderer at the same time.
 */
export function linkedChannels() {
  const a = { fns: [], closers: [] };
  const b = { fns: [], closers: [] };
  let closed = false;

  /**
   * Closing is one event with two ends, which is the half a pair of channels
   * gets wrong if it only tidies up the side that called it.
   *
   * Every real transport works this way — a socket, a data channel, a worker
   * port — and a fallback that did not would be the one configuration in which
   * a shop can close under somebody without their end ever finding out. That is
   * precisely the bug this method exists to make impossible to write.
   */
  const shut = () => {
    if (closed) return;
    closed = true;
    a.fns.length = 0;
    b.fns.length = 0;
    for (const fn of [...a.closers, ...b.closers]) fn();
  };

  const make = (mine, theirs) => ({
    // A microtask, so a `send` never lands *inside* the caller's own stack. A
    // synchronous delivery here would let a handler re-enter the code that
    // called it, which is a class of bug neither real transport can produce.
    post: (frame) => {
      if (closed) return;
      queueMicrotask(() => { for (const fn of theirs.fns) fn(frame); });
    },
    onFrame: (fn) => mine.fns.push(fn),
    onClose: (fn) => { mine.closers.push(fn); if (closed) fn(); },
    close: shut,
  });
  return [make(a, b), make(b, a)];
}

/**
 * What `ShopRoom` extends when there is no Colyseus.
 *
 * Usage:
 *   const Room = ShopRoom(ChannelHost);
 *   const room = new Room();
 *   room.start({ worldId });
 *   const client = room.join(channel, { name, who });
 */
export class ChannelHost {
  constructor() {
    this.roomId = `local-${(++seq).toString(36)}`;
    /** @type {{sessionId: string, send: Function, channel: Channel}[]} */
    this.clients = [];
    this.maxClients = 8;
    this.autoDispose = false;
    this.metadata = {};
    this.handlers = new Map();
    this.timers = new Set();
    this.tick = null;
    this.stopped = false;
    // Colyseus's `clock` is a scheduler tied to the room's life. Ours is the
    // same promise in one line: anything started through it is cleared when the
    // room goes, so a disposed room cannot leave a 20Hz interval running.
    this.clock = { setInterval: (fn, ms) => this.setInterval(fn, ms) };
  }

  // ---- the ten calls ------------------------------------------------------

  setMetadata(meta) { this.metadata = { ...this.metadata, ...meta }; }

  onMessage(type, fn) { this.handlers.set(type, fn); }

  broadcast(type, payload) {
    const frame = FRAME(type, payload);
    for (const c of this.clients) c.channel.post(frame);
  }

  setSimulationInterval(fn, ms) {
    if (this.tick) clearInterval(this.tick);
    this.tick = setInterval(() => { try { fn(ms); } catch (err) { this.oops('tick', err); } }, ms);
    return this.tick;
  }

  setInterval(fn, ms) {
    const id = setInterval(() => { try { fn(); } catch (err) { this.oops('timer', err); } }, ms);
    this.timers.add(id);
    return { clear: () => { clearInterval(id); this.timers.delete(id); } };
  }

  /**
   * Shut the room down. `ShopRoom.checkIdle` calls this, which in a tab is a
   * shop nobody has touched for five minutes — worth keeping rather than
   * stubbing out, because the save it writes on the way is the point of it.
   */
  disconnect() { this.stop(); }

  // ---- lifecycle, which Colyseus does for us and nobody does here ---------

  start(options = {}) {
    this.onCreate?.(options);
    return this;
  }

  /**
   * Somebody arrives on a channel.
   *
   * The sessionId is per connection, exactly as Colyseus's is — `who` in the
   * options is what outlives it, and that is `ShopRoom`'s business rather than
   * this file's (see `Game.away`).
   */
  join(channel, options = {}) {
    const client = {
      sessionId: `s${(++seq).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
      channel,
      send: (type, payload) => channel.post(FRAME(type, payload)),
    };
    this.clients.push(client);
    channel.onFrame((frame) => this.receive(client, frame));
    this.onJoin?.(client, options);
    return client;
  }

  /**
   * Somebody is off the room, whichever end decided it.
   *
   * The channel is CLOSED on the way out, which is Colyseus's behaviour rather
   * than an addition — a client removed from a room has its socket closed, and a
   * client removed here that kept its wire open would be a browser still
   * listening to a shop that has let go of it. The visible half is the shop
   * closing under a guest: `stop()` leaves everybody, so the close is how the
   * far end learns there is nothing there any more instead of watching a
   * snapshot that stopped changing.
   *
   * Optional because the Worker's own end of the pipe has no `close` and needs
   * none: that channel dies with the page, and the page dying is the shop
   * dying.
   */
  leave(client) {
    const i = this.clients.indexOf(client);
    if (i < 0) return;
    this.clients.splice(i, 1);
    this.onLeave?.(client);
    client.channel.close?.();
  }

  /**
   * One inbound frame.
   *
   * An unknown type is dropped with a warning rather than thrown, which is
   * Colyseus's behaviour and matters more here: at step 6 the other end is a
   * *different build* of the game, so a message the host has never heard of is
   * an ordinary version skew and must not take the shop down with it.
   */
  receive(client, frame) {
    if (!Array.isArray(frame)) return;
    const [type, payload] = frame;
    const fn = this.handlers.get(type);
    if (!fn) { console.warn(`[host] no handler for "${type}"`); return; }
    try { fn(client, payload); } catch (err) { this.oops(type, err); }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.tick) clearInterval(this.tick);
    for (const id of this.timers) clearInterval(id);
    this.timers.clear();
    for (const c of [...this.clients]) this.leave(c);
    this.onDispose?.();
  }

  /**
   * A handler threw.
   *
   * Logged and swallowed, and that is a decision rather than laziness: on the
   * Colyseus side an exception in one message is caught by the framework and
   * the room keeps ticking. If it took the room down here instead, the same bug
   * would be a survivable glitch on the desktop build and a dead tab on the web
   * one — which is exactly the divergence this whole seam exists to prevent.
   */
  oops(what, err) {
    console.error(`[host] ${what} failed:`, err);
  }
}
