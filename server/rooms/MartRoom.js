/**
 * THE ROOM — one shop, shared by everyone connected.
 *
 * Deliberately does NOT use @colyseus/schema. State is broadcast as plain JSON
 * snapshots at 10Hz. At our scale (a few dozen entities) that's a couple of KB
 * a tick, which is nothing — and in exchange the state is just an object that
 * anyone (including a 14-year-old and an LLM) can read, log and modify without
 * learning a schema DSL. That tradeoff is the right way round for this project.
 *
 * The room also registers itself in a module-level registry so the HTTP control
 * API (and therefore MCP) can reach the live game.
 */

import { Room } from 'colyseus';
import { Game } from '../sim/index.js';
import { content, refresh, onContentChange } from '../content.js';
import { runDirector } from '../director.js';

/** Every live room, so the HTTP API can find one to poke. */
export const rooms = new Set();

/**
 * The room the control API should act on.
 *
 * Prefers the room with the most connected clients rather than whichever was
 * registered first — after a devMode restart there can briefly be a stale,
 * empty room around, and targeting that one makes `screenshot` and `get_state`
 * silently report on a world nobody is playing.
 */
export function primaryRoom() {
  let best = null;
  for (const room of rooms) {
    if (!best || room.clients.length > best.clients.length) best = room;
  }
  return best;
}

const TICK_MS = 50;        // 20Hz simulation
const BROADCAST_MS = 100;  // 10Hz network

export class MartRoom extends Room {
  onCreate(options) {
    this.maxClients = 8;
    this.game = Game.create({ seed: options?.seed });
    this.autoDispose = false;

    // Pending screenshot requests, keyed by id. See `requestScreenshot`.
    this.screenshotWaiters = new Map();

    this.unsubscribeContent = onContentChange(() => {
      this.broadcast('content-changed', { version: content().version });
    });

    this.setSimulationInterval(() => this.game.step(TICK_MS / 1000), TICK_MS);
    this.broadcastTimer = this.clock.setInterval(() => this.pushState(), BROADCAST_MS);

    // Poll for content written by another process (MCP, the director, a human
    // with a SQLite client). This is what makes `create_item` appear live.
    this.contentTimer = this.clock.setInterval(() => refresh(), 250);

    this.registerMessages();
    rooms.add(this);
    console.log(`[room] ${this.roomId} created (seed ${this.game.seed})`);
  }

  registerMessages() {
    this.onMessage('input', (client, m) => {
      this.game.setInput(client.sessionId, Number(m?.dx) || 0, Number(m?.dz) || 0);
    });

    // Press and hold to commit to whatever standing here has armed. Sent on
    // press and on release only, not per frame — it's a latch, not a stream.
    this.onMessage('hold', (client, m) => {
      this.game.setHold(client.sessionId, !!m?.on);
    });

    this.onMessage('interact', (client, m) => {
      const res = this.game.interact(client.sessionId, m ?? {});
      client.send('action-result', res);
    });

    // Which seed this player is holding. The plot action reads it server-side,
    // so planting is "stand at a bare plot with a seed chosen", not a keypress.
    this.onMessage('select-crop', (client, m) => {
      client.send('action-result', this.game.selectCrop(client.sessionId, m?.cropId ?? null));
    });

    this.onMessage('plant', (client, m) => {
      client.send('action-result', this.game.plant(client.sessionId, m?.plotId, m?.cropId));
    });

    this.onMessage('buy-stock', (client, m) => {
      client.send('action-result', this.game.buyStock(client.sessionId, m?.itemId, Number(m?.qty) || 1));
    });

    this.onMessage('set-price', (client, m) => {
      client.send('action-result', this.game.setPrice(m?.shelfId, Number(m?.price)));
    });

    this.onMessage('buy-upgrade', (client, m) => {
      const res = this.game.buyUpgrade(m?.upgradeId);
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    this.onMessage('rename', (client, m) => {
      const p = this.game.players[client.sessionId];
      if (p && typeof m?.name === 'string') p.name = m.name.slice(0, 20);
    });

    // ---- build mode -------------------------------------------------------
    // Every one of these names its target: either a tile the client picked out
    // from under the pointer, or the id of the fixture whose menu is open. The
    // server never guesses which shelf you meant. All tiny payloads — well
    // inside the 4KB inbound cap, unlike anything carrying a layout.

    this.onMessage('build-mode', (client, m) => {
      client.send('action-result', this.game.setBuildMode(client.sessionId, !!m?.on, m?.tool));
    });

    this.onMessage('build-tool', (client, m) => {
      client.send('action-result', this.game.setBuildTool(client.sessionId, m?.tool));
    });

    this.onMessage('build-place', (client, m) => {
      const res = this.game.placeFixture(client.sessionId, m ?? {});
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    this.onMessage('build-drop', (client, m) => {
      const res = this.game.dropFixture(client.sessionId, m ?? {});
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    this.onMessage('build-cancel', (client) => {
      this.game.cancelBuildHold(client.sessionId);
    });

    // ---- the fixture menu ---------------------------------------------------
    // One message per thing a fixture's own menu offers. They all take an id,
    // because the player opened that fixture's menu to get here.

    this.onMessage('build-lift', (client, m) => {
      client.send('action-result', this.game.liftFixture(client.sessionId, m?.id));
    });

    this.onMessage('build-empty', (client, m) => {
      client.send('action-result', this.game.emptyFixture(client.sessionId, m?.id));
    });

    this.onMessage('build-rotate', (client, m) => {
      const res = this.game.rotateFixture(client.sessionId, m?.id, m?.dir);
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    this.onMessage('build-remove', (client, m) => {
      const res = this.game.removeFixture(client.sessionId, m?.id);
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    this.onMessage('move-door', (client, m) => {
      const res = this.game.moveDoor(client.sessionId, m?.shift);
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    // NOTE: screenshots deliberately do NOT come back over this websocket.
    // Colyseus caps *inbound* messages at 4KB and a PNG is ~150KB, which
    // silently closes the connection. The client POSTs the image to
    // /api/screenshot/upload instead; see resolveScreenshot() below.
  }

  onJoin(client, options) {
    this.game.addPlayer(client.sessionId, options?.name);
    this.sendLayout(client);
    client.send('catalog', this.catalog());
    client.send('you', { id: client.sessionId });
  }

  onLeave(client) {
    this.game.removePlayer(client.sessionId);
  }

  onDispose() {
    this.unsubscribeContent?.();
    rooms.delete(this);
    this.game.persist();
    console.log(`[room] ${this.roomId} disposed`);
  }

  // ---- Colyseus devMode -----------------------------------------------------
  // These two let the shop survive a server restart while you're editing code.
  // Without them, saving a file in server/ would dump everyone back to a fresh
  // world, which makes iterating on the sim miserable.

  onCacheRoom() {
    // `_directorDay` has to survive too. It's the "already asked the director
    // about today" guard, and losing it means every save-a-file restart fires
    // another world event for the same day — which is how the HUD ends up
    // showing the same headline five times over.
    return { state: this.game.serialize(), directorDay: this._directorDay ?? null };
  }

  onRestoreRoom(cached) {
    if (!cached?.state) return;
    this.game = Game.restore(cached.state);
    this._directorDay = cached.directorDay ?? this.game.day;
    // Players reconnect as new sessions, so old player entries are stale.
    this.game.players = {};
    console.log(`[room] ${this.roomId} restored at day ${this.game.day}`);
  }

  // -------------------------------------------------------------------------

  /** Static-ish data the client needs to render and to populate its menus. */
  catalog() {
    const c = content();
    return {
      version: c.version,
      items: c.items.map((i) => ({
        id: i.id, name: i.name, tags: i.tags, model: i.model,
        base_cost: i.base_cost, base_price: i.base_price, stack: i.stack,
      })),
      crops: c.crops.map((cr) => ({
        id: cr.id, name: cr.name, item_id: cr.item_id, seed_cost: cr.seed_cost,
        grow_minutes: cr.grow_minutes, seasons: cr.seasons, model: cr.model,
      })),
      upgrades: c.upgrades,
      // An appliance's own menu says what it can make, so the client needs the
      // recipe list. Tiny, and it means a recipe added via MCP shows up in the
      // blender's menu the moment it exists.
      recipes: c.recipes,
      // What one more of each fixture costs in build mode. Derived from the
      // upgrades that sell them, so adding a cheaper shelf upgrade via MCP
      // reprices the build palette with no code change.
      buildCosts: this.game.buildCosts(),
    };
  }

  sendLayout(client) {
    const payload = { layout: this.game.layout, version: this.game.layoutVersion };
    if (client) client.send('layout', payload);
    else this.broadcast('layout', payload);
  }

  pushState() {
    // A new in-game day: let the director decide what happens in town.
    // Deliberately fire-and-forget — the sim keeps ticking while it thinks,
    // and a failure just means the world stays as it was.
    if (this._directorDay !== this.game.day) {
      this._directorDay = this.game.day;
      runDirector(this.game).then((res) => {
        if (res?.ok) this.broadcast('news', { headline: res.headline, source: res.source });
      }).catch((err) => console.error('[room] director error:', err.message));
    }

    // If the layout changed (upgrade, regenerate), everyone needs the new one.
    if (this._sentLayoutVersion !== this.game.layoutVersion) {
      this._sentLayoutVersion = this.game.layoutVersion;
      this.sendLayout();
    }
    if (this._sentCatalogVersion !== content().version) {
      this._sentCatalogVersion = content().version;
      this.broadcast('catalog', this.catalog());
    }
    this.broadcast('state', this.game.snapshot());
  }

  /**
   * Ask a connected browser to render its canvas to a PNG.
   *
   * The server has no renderer, so "what does the game look like right now"
   * can only be answered by a real client. This is how an agent gets to *see*
   * the change it just made.
   *
   * The request goes out over the websocket (tiny); the image comes back over
   * HTTP (large). Sending it back over the socket exceeds Colyseus's 4KB
   * inbound cap and drops the connection.
   */
  requestScreenshot({ timeoutMs = 8000 } = {}) {
    const viewer = this.clients[0];
    if (!viewer) {
      return Promise.reject(new Error('no browser connected — open the game in a tab first'));
    }
    const id = `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.screenshotWaiters.delete(id);
        reject(new Error('screenshot timed out — is the game tab visible and rendering?'));
      }, timeoutMs);
      this.screenshotWaiters.set(id, { resolve, timeout });
      viewer.send('screenshot-request', { id });
    });
  }

  /** Called by the HTTP upload route once the browser POSTs its PNG back. */
  resolveScreenshot(id, dataUrl) {
    const waiter = this.screenshotWaiters.get(id);
    if (!waiter) return false;
    this.screenshotWaiters.delete(id);
    clearTimeout(waiter.timeout);
    waiter.resolve(dataUrl ?? null);
    return true;
  }
}
