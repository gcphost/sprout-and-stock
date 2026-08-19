/**
 * NETWORK, WITH NO NETWORK.
 *
 * The same shape as [net.js](net.js) — `on`, `send`, `connect`, `myId`,
 * `onScreenshot` — with a Worker where the websocket was. `main.js` is meant to
 * be unable to tell them apart, and that is the test of it: if this file ever
 * needs a method the other one does not have, the renderer has learned which
 * build it is in and the seam has leaked upwards.
 *
 * It carries one thing `net.js` does not, and it is the same job by another
 * road: `api()`. In the server build the menu lists and creates shops over
 * HTTP; here there is no HTTP, and the worker owns the store, so the menu asks
 * the worker. Same four calls, same signature, same shapes back — see
 * `setMenuApi` in client/menu.js.
 *
 * Two things it deliberately keeps from `net.js`, because they are facts about
 * the *player* rather than about the transport:
 *
 *   - `who`, minted once into local storage, is still how the shop knows you
 *     across a reload (`Game.away`). A worker restarting is exactly the case it
 *     was written for, so there is no reason to invent a second identity here.
 *   - `action-result` is emitted as `action`, the same rename `net.js` does,
 *     because the client listens for the short one.
 *
 * And one it drops: there is no `screenshot-request` round trip. That exists so
 * an agent over MCP can see the game, and MCP cannot reach a tab — see
 * docs/browser.md. The hook stays so `main.js` can call it unconditionally.
 *
 * IT IS ALSO THE GUEST'S TRANSPORT, and folding that in here rather than
 * writing a third class is the design decision worth recording. A guest has a
 * wire to a browser that is running the shop; a host has a wire to a Worker
 * that is running the shop. Both are `{post, onFrame}`, both carry the same
 * frames, and the only real difference is which end owns the save.
 *
 * A separate `PeerNet` was written first and thrown away, because of something
 * that has nothing to do with networking: `main.js` wires forty `net.send`
 * calls and forty `net.on` handlers at module scope, and hands `net` to the UI.
 * Swapping the object afterwards means every one of those references still
 * points at the old one — so joining a friend would have needed a rewiring pass
 * over the whole client, and the first thing anybody added later would be the
 * thing that got left out of it. One object whose *wire* can change costs
 * nothing and cannot rot that way. See `becomeGuest`.
 */

/** Same key as `net.js` on purpose: one browser is one person in both builds. */
const ME = 'sns-me';

/**
 * This browser's id for its person.
 *
 * Exported because joining somebody else's shop needs it *outside* this class:
 * a guest's `who` has to be in the answer blob (see `client/peer.js`), and the
 * blob is built by the dialogue rather than by the transport. One minting, one
 * key, one person — a second `whoAmI` in the UI layer would be a second identity
 * for the same browser, and the failure would be a guest who is a stranger to
 * the shop they have been in twice.
 */
export function whoAmI() {
  try {
    const had = localStorage.getItem(ME);
    if (had) return had;
    const made = crypto.randomUUID?.()
      ?? `me-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(ME, made);
    return made;
  } catch {
    return null;
  }
}

export class LocalNet {
  constructor() {
    this.worker = null;
    this.myId = null;
    this.world = null;
    this.handlers = {};
    /** Outstanding `api()` calls, by id. */
    this.pending = new Map();
    this.nextRpc = 1;
    /** The in-flight `connect()`, if any. */
    this.opening = null;
    /** Guests, by id: their data channel. See `host`. */
    this.peers = new Map();
    this.nextPeer = 1;
    /**
     * Set when this browser is a GUEST — the wire to whoever is hosting. While
     * it is set the Worker is not started at all: there is no shop on this
     * machine, no store and no save.
     */
    this.wire = null;
  }

  on(event, fn) {
    (this.handlers[event] ??= []).push(fn);
    return this;
  }

  emit(event, payload) {
    for (const fn of this.handlers[event] ?? []) fn(payload);
  }

  /**
   * The worker, started on first use and then kept.
   *
   * Lazily rather than in the constructor because the **menu** is the first
   * thing that needs it: listing and creating shops happens before anybody has
   * opened one. So `api()` and `connect()` share one thread and therefore one
   * store, which is the whole reason the store lives over there — two threads
   * importing it would be two sets of memory over one database, and a shop
   * created by the menu would be invisible to the shop the room opens.
   */
  boot() {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onerror = (err) => {
      // A worker that fails to *load* answers nothing at all, so everything
      // waiting on it has to be failed by hand — otherwise the caller sits on a
      // spinner with a clean console, which is the least debuggable failure
      // there is.
      const boom = new Error(`the shop could not start: ${err.message ?? 'worker failed to load'}`);
      for (const [, p] of this.pending) p.reject(boom);
      this.pending.clear();
      this.opening?.reject(boom);
      this.opening = null;
      // ...and it must be FORGOTTEN, which is the half that was missing and the
      // one that produces a hang rather than an error. A dead worker left in
      // this field is one `boot()` will happily hand back for ever: the failure
      // surfaces once, on whatever happened to be in flight, and every call
      // after it posts a message into a thread that is not there and waits
      // silently. Nulling it means the next call builds a new one — a transient
      // 404 on the chunk (a deploy mid-session, a flaky edge) then costs a
      // retry instead of the rest of the session.
      this.worker = null;
    };
    this.worker.onmessage = (e) => this.receive(e.data ?? []);
    this.watchForLeaving();
    return this.worker;
  }

  /**
   * Save when the page goes away, because in this build the shop goes with it.
   *
   * `visibilitychange` is the one that does the work and `pagehide` is the
   * backstop, in that order deliberately: hidden fires when you switch tab or
   * apps — which is what happens *before* almost every close, and reliably, on
   * mobile where `pagehide` sometimes never comes at all. By the time a real
   * close arrives the save is usually already written and this is a no-op.
   *
   * Neither one closes the shop. A hidden tab is not a closed one, and
   * `pagehide` can be a page going into bfcache and coming straight back — tear
   * the room down there and stepping back into the tab is a blank screen. The
   * worker dying with the page is the teardown; this is only making sure the
   * last thing that happened was written before it does.
   *
   * Wired here rather than in `main.js` for the reason the whole seam exists:
   * this is a fact about a transport whose server is inside the page, and the
   * other transport has a server that outlives it. `main.js` should not have to
   * know which one it has.
   */
  watchForLeaving() {
    if (this.watching) return;
    this.watching = true;
    const save = () => { if (document.visibilityState === 'hidden') this.save(); };
    document.addEventListener('visibilitychange', save);
    window.addEventListener('pagehide', () => this.save());
  }

  /** Write the shop down where it stands. Cheap, and safe to call at any time. */
  save() {
    // A guest has nothing to save. Asking anyway would be harmless and would
    // also be a lie about where the shop lives.
    if (!this.wire) this.worker?.postMessage(['@save']);
  }

  /**
   * The four calls `client/menu.js` makes, in the shape it already makes them.
   *
   * @param {'GET'|'POST'|'DELETE'|'PATCH'} method
   * @param {string} path e.g. `/worlds`
   */
  api(method, path, body) {
    this.boot();
    const id = this.nextRpc++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(['@rpc', { id, method, path, body }]);
    });
  }

  /**
   * Open a shop and wait until it is standing.
   *
   * Resolves once the worker has answered `@ready`, which is after the store
   * has been read out of IndexedDB and the room created — so a caller that
   * awaits this can assume the first `layout` and `catalog` are on their way
   * rather than racing them.
   *
   * A shop that is not there REJECTS, with the same words the server uses, and
   * that wording is load-bearing: `main.js` matches on `/no world/i` to decide
   * whether to fall back to the menu, because a link or a bookmark can name a
   * shop somebody has since deleted. Answering `null` instead would take that
   * path off the boot, and what you would see is a game that removed its
   * loading screen and then drew nothing at all.
   */
  connect(name, worldId) {
    this.boot();
    return new Promise((resolve, reject) => {
      // A deadline, because the failure this replaces had no symptom at all:
      // the shop opens by posting a message and waiting to be told it is
      // standing, so anything that stops the worker answering — a chunk that
      // 404ed, a thread that died, a message posted at one that was already
      // gone — is a loading screen that never changes. Ten seconds is far
      // longer than opening a shop takes (it is a store read and a layout) and
      // far shorter than somebody's patience with a frozen page.
      const timer = setTimeout(() => {
        if (!this.opening) return;
        this.opening = null;
        // Forget the worker with it: whatever is wrong, asking the same one
        // again is asking the thing that just failed to answer.
        this.worker?.terminate();
        this.worker = null;
        reject(new Error('The shop did not start. Reload the page — if it keeps happening, the game files may not have finished uploading.'));
      }, 10000);
      const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.opening = { resolve: done(resolve), reject: done(reject) };
      this.worker.postMessage(['@open', { worldId, name, who: whoAmI() }]);
    });
  }

  receive([type, payload]) {
    switch (type) {
      // A frame the room addressed to a guest. The worker cannot reach them —
      // it has no peer connection — so it hands it back here to be posted down
      // the wire.
      case '@peer-frame':
        this.peers.get(payload?.id)?.post(payload.frame);
        return;
      // The room let go of a guest at ITS end — they were dropped, or the shop
      // was closed under them. Same road out as any other way of going, so that
      // "a guest left" is one path however it started.
      case '@peer-left':
        this.dropPeer(payload?.id);
        return;
      case '@rpc': {
        const p = this.pending.get(payload?.id);
        if (!p) return;
        this.pending.delete(payload.id);
        if (payload.ok) p.resolve(payload.data);
        else p.reject(new Error(payload.error ?? 'the shop refused'));
        return;
      }
      case '@ready':
        this.myId = payload.sessionId;
        this.world = { id: payload.worldId, name: payload.worldId };
        this.opening?.resolve(this.worker);
        this.opening = null;
        return;
      case '@no-world':
        this.opening?.reject(new Error(`no world "${payload?.asked ?? ''}" — it may have been deleted`));
        this.opening = null;
        return;
      case '@error':
        this.opening?.reject(new Error(payload?.message ?? 'the shop could not start'));
        this.opening = null;
        return;
      // `you` carries the world's *name*, which the handshake does not know —
      // the room reads it off the save. Both are kept: the handshake is what
      // unblocks the boot, and this is what the HUD says out loud.
      case 'you':
        this.myId = payload.id;
        this.world = payload.world ?? this.world;
        this.emit('you', payload);
        return;
      case 'action-result':
        this.emit('action', payload);
        return;
      default:
        this.emit(type, payload);
    }
  }

  send(type, payload) {
    if (this.wire) this.wire.post([type, payload]);
    else this.worker?.postMessage([type, payload]);
  }

  /**
   * Become a guest in somebody else's shop.
   *
   * No Worker is started: there is no shop here to run. The host's room mints
   * the `sessionId` and announces it in `you`, exactly as a websocket join
   * always did, so there is no handshake of our own — we are joining a room
   * rather than starting one.
   *
   * `name` and `who` have already crossed, in the answer blob — see
   * `client/peer.js`. They have to arrive together and they have to arrive
   * *before* the first frame, because the host calls `room.join` the moment the
   * channel opens and `addPlayer` reads `who` there: `Game.away` is keyed by it,
   * so a guest who says who they are a tick later has already been spawned as a
   * stranger. The `rename` below is therefore a belt-and-braces for a host on an
   * older build, and costs one frame.
   *
   * What it buys is the whole of what `Game.away` does, pointed at somebody
   * else's shop: a guest whose wifi blinks gets their own hands, their own
   * shoulder and their own spot back, exactly as the host does across a reload,
   * rather than becoming a stranger at the door with a crate on the floor where
   * they were standing.
   *
   * Two browsers sharing a `who` — the same person hosting in one tab and
   * joining in another, which is how this gets tested — is the collision
   * `removePlayer` already documents: one `away` row per person, so whoever
   * leaves second finds the first's row and sets those goods down on the floor
   * rather than overwriting them. Conservative, and never silent destruction.
   */
  becomeGuest(channel, name) {
    this.wire = channel;
    channel.onFrame((frame) => this.receive(frame));
    /**
     * The shop was on somebody else's machine and it has gone.
     *
     * Its own event rather than `disconnected`, which is a toast that fades:
     * these are two different sizes of fact. A host who closed their tab has
     * taken the whole world with them — there is no reconnect, no save on this
     * machine and nothing to go back to — and a message that disappears after
     * four seconds in front of a shop that has silently stopped ticking is
     * exactly the failure this build keeps saying must not exist. `main.js`
     * turns it into something you have to press.
     *
     * Guarded on `this.wire`, because leaving on purpose closes the same wire
     * and must not be told that the host has abandoned them.
     */
    channel.onClose?.(() => {
      if (!this.wire) return;
      this.wire = null;
      this.emit('host-gone');
    });
    if (name) this.send('rename', { name });
    this.watchForLeaving();
    return this;
  }

  /**
   * Let somebody in — step 6 of docs/browser.md.
   *
   * Two calls because a human is the signalling channel: this hands back a code
   * to paste into a chat, and `accept` takes the one that comes back. In
   * between, nothing is connected and nothing is waiting on a socket.
   *
   * The peer connection lives HERE rather than in the worker because
   * `RTCPeerConnection` is not exposed to workers. So the main thread owns the
   * wire and the worker owns the shop, and frames are relayed across the same
   * `postMessage` pair the local client already uses — one extra hop, invisible
   * to `ShopRoom`, which is handed three methods either way.
   */
  async host({ onProgress } = {}) {
    this.boot();
    const { createOffer } = await import('./peer.js');
    const offer = await createOffer({ onProgress });
    return {
      code: offer.code,
      accept: async (answerCode, { name } = {}) => {
        const { channel, who, name: theirName } = await offer.accept(answerCode);
        const id = `g${this.nextPeer++}`;
        this.peers.set(id, channel);
        channel.onFrame((frame) => this.worker?.postMessage(['@peer-frame', { id, frame }]));
        // The wire going away has to reach the ROOM, or a guest who closes their
        // tab is a person still standing in the shop: `onLeave` is what runs
        // `removePlayer`, and `removePlayer` is what decides what happens to the
        // armful they were holding. Nothing else calls it — a channel is the
        // only thing that knows, and until it could say so, it never did.
        channel.onClose?.(() => this.dropPeer(id));
        // Their own name and their own id, both off the answer blob. The name
        // was always coming a moment later as a `rename`; taking it here means
        // they are called the right thing in the log line that says they walked
        // in, rather than being "Guest" for a tick and then somebody else.
        this.worker.postMessage(['@peer-join', { id, who, name: theirName || name || 'Guest' }]);
        this.emit('peers', { count: this.peers.size, joined: id });
        return id;
      },
      cancel: () => offer.close(),
    };
  }

  /**
   * A guest is gone — because they left, because the room dropped them, or
   * because their laptop shut.
   *
   * One function for all three, and it is safe to call twice: the delete is the
   * latch, so the close it triggers on the way out cannot come back round. That
   * matters more than it looks, because every one of the three arrives here by a
   * different road — the data channel closing, and `@peer-left` coming back
   * from the worker when the room lets somebody go, which is every guest at
   * once when `leave()` shuts the shop.
   */
  dropPeer(id) {
    const channel = this.peers.get(id);
    if (!channel) return;
    this.peers.delete(id);
    channel.close?.();
    // Through the worker rather than straight at the room, because the room is
    // over there: `peerLeft` calls `room.leave`, which is `onLeave`, which is
    // where their hands and their spot are written down.
    this.worker?.postMessage(['@peer-left', { id }]);
    this.emit('peers', { count: this.peers.size, left: id });
  }

  /**
   * Put the shop away without putting the worker away.
   *
   * `@close` is what stops the room, and stopping the room is what runs
   * `onDispose` and therefore `game.persist()`. Terminating the thread instead
   * skips both, so the last thing that happened in the shop is not the last
   * thing that was saved. The worker is kept alive afterwards because the menu
   * is about to want it again — leaving a shop is going back to the front door,
   * not closing the game.
   */
  leave() {
    // A guest owns none of the shop — no save to write, no room to stop — so
    // leaving is closing the wire and nothing else. What happens to what they
    // were carrying is the HOST's business, and the host already does it: the
    // channel closing runs `onLeave` over there, the same path a dropped
    // websocket has always taken.
    if (this.wire) {
      // Forgotten BEFORE it is closed, and that order is the whole of what
      // stops leaving on purpose from being reported as the host vanishing:
      // `close()` fires the same notice a dropped connection does, because from
      // inside the wire the two are the same event.
      const wire = this.wire;
      this.wire = null;
      wire.close?.();
    } else {
      // Every guest goes with it. `@close` stops the room, and a stopped room
      // lets go of its clients — which closes their channels at the far end of
      // the relay, so somebody in your shop is TOLD rather than left looking at
      // a picture of it. See `ChannelHost.leave`.
      this.worker?.postMessage(['@close']);
    }
    this.myId = null;
    this.world = null;
    this.emit('disconnected');
  }

  /** Kept so `main.js` can call it in both builds. Nothing asks for one here. */
  onScreenshot(fn) { this.screenshotFn = fn; }

  async emitScreenshot() {
    if (!this.screenshotFn) throw new Error('no renderer attached');
    return this.screenshotFn();
  }
}
