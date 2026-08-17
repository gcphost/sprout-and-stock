/**
 * THE ROOM — one shop, shared by everyone connected.
 *
 * Deliberately does NOT use @colyseus/schema. State is broadcast as plain JSON
 * snapshots at 10Hz. At our scale (a few dozen entities) that's a couple of KB
 * a tick, which is nothing — and in exchange the state is just an object that
 * anyone (including a 14-year-old and an LLM) can read, log and modify without
 * learning a schema DSL. That tradeoff is the right way round for this project.
 *
 * One room is one **world**, named by `options.worldId` and matched on it by
 * `filterBy` in server/index.js — so `joinOrCreate` puts you in the shop you
 * picked from the menu rather than in whichever room happened to exist.
 *
 * The room also registers itself in a module-level registry so the HTTP control
 * API (and therefore MCP) can reach the live game.
 */

import { Room } from 'colyseus';
import { Game } from '../sim/index.js';
import { content, refresh, onContentChange } from '../content.js';
import { JOBS } from '../../shared/schemas.js';
import { runDirector } from '../director.js';
// Straight to the row rather than through server/worlds.js: that module reads
// this one's `rooms` registry, and importing it back would make a cycle out of
// what is a one-line UPDATE.
import { touchWorldRow, worldRow, listWorldRows, DEFAULT_WORLD_ID } from '../db.js';

/** Every live room, so the HTTP API can find one to poke. */
export const rooms = new Set();

/**
 * The room the control API should act on when nothing says otherwise.
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

/**
 * How long a room with nobody in it keeps simulating before it saves and goes.
 *
 * There is a grace period at all because an agent's room is legitimately empty:
 * `roomForWorld` starts one headless to reset an economy or take a screenshot,
 * and a room that disposed the instant it had no clients would be gone before
 * the next call. Five minutes is long enough for a working session and short
 * enough that ten abandoned worlds aren't ticking overnight.
 */
const IDLE_MS = Number(process.env.SNS_ROOM_IDLE_MS ?? 5 * 60 * 1000);
const IDLE_CHECK_MS = 15_000;

/**
 * Which world a room that never named one is.
 *
 * Only one thing creates those: Colyseus devMode caches a room's *client
 * options* and replays them on boot, so the first restart after this feature
 * landed re-creates a room whose options predate `worldId` entirely. Throwing
 * there means the server won't start at all after a `git pull` — a crash on
 * upgrade, for a room that has a perfectly good answer, because the save it was
 * playing is exactly the one the migration renamed to `default`.
 */
function legacyWorldId() {
  const id = worldRow(DEFAULT_WORLD_ID) ? DEFAULT_WORLD_ID : listWorldRows()[0]?.id;
  if (!id) throw new Error('a room has to say which world it is, and there are no worlds');
  console.warn(`[room] created with no world named — assuming "${id}" (a cached room from before save slots)`);
  return id;
}

export class MartRoom extends Room {
  onCreate(options) {
    this.maxClients = 8;
    // A named world has to exist. `joinOrCreate` reaches this directly from the
    // browser, so without the check a stale bookmark or a shared link to a shop
    // that has since been deleted mints a new one: a room saving to a slot with
    // no row, invisible in the menu, that nobody meant to create. The client
    // reads this refusal and falls back to the menu.
    if (options?.worldId && !worldRow(options.worldId)) {
      throw new Error(`no world "${options.worldId}" — it may have been deleted`);
    }
    this.worldId = options?.worldId ?? legacyWorldId();
    this.game = Game.create({ worldId: this.worldId, seed: options?.seed });
    // Disposal is ours, not Colyseus's: `autoDispose` fires the moment the last
    // client leaves, and the whole point of the idle timer is that it doesn't.
    this.autoDispose = false;
    this.emptySince = Date.now();

    // So the menu can show which shops have somebody in them without opening a
    // socket to each one.
    this.setMetadata({ worldId: this.worldId });

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

    this.idleTimer = this.clock.setInterval(() => this.checkIdle(), IDLE_CHECK_MS);

    this.registerMessages();
    rooms.add(this);
    console.log(`[room] ${this.roomId} created for world "${this.worldId}" (seed ${this.game.seed})`);
  }

  /**
   * Save and shut down once nobody has been here for a while.
   *
   * `disconnect()` rather than letting it run: an empty room is still stepping
   * the sim 20 times a second, spawning shoppers nobody serves and asking the
   * director for a world event every in-game day. One of those is a paid API
   * call, and before save slots existed there was only ever one room, so it
   * never mattered.
   */
  checkIdle() {
    if (this.clients.length > 0) { this.emptySince = null; return; }
    this.emptySince ??= Date.now();
    if (Date.now() - this.emptySince < IDLE_MS) return;
    console.log(`[room] ${this.roomId} idle — saving world "${this.worldId}" and closing`);
    this.disconnect();
  }

  registerMessages() {
    this.onMessage('input', (client, m) => {
      this.game.setInput(client.sessionId, Number(m?.dx) || 0, Number(m?.dz) || 0);
    });

    // The button. Nothing in the shop fires without it — see `stepActions`.
    // Its own message rather than a field on `input` for the reason in
    // `setHolding`: a lost release must not also leave you walking.
    // A quick tap on a crate you are already stood at: one unit, in or out.
    // The hold is what lifts the whole box, and the two share a pointer press —
    // which is why this is a separate message rather than a mode on `take`.
    this.onMessage('crate-one', (client, m) => {
      const res = this.game.tapCrate(
        client.sessionId,
        m?.palletId ? String(m.palletId) : null,
        !!m?.put,
      );
      if (!res.ok) client.send('action-result', res);
    });

    this.onMessage('press', (client, m) => {
      this.game.setPressing(client.sessionId, !!m?.down);
    });

    // Tap a tile, walk there. Sent as a destination and not a route: the client
    // has no walk grid and no business having one, and a route is also the one
    // thing here that could outgrow the 4KB inbound cap.
    this.onMessage('walk-to', (client, m) => {
      // A tile or a thing. Naming the thing is not a convenience — it is what
      // gets you to the side of the shelf you can actually work from.
      const res = m?.fixture
        ? this.game.walkToFixture(client.sessionId, String(m.fixture))
        : this.game.walkTo(client.sessionId, Number(m?.x), Number(m?.z));
      if (!res.ok) client.send('action-result', res);
    });

    this.onMessage('interact', (client, m) => {
      const res = this.game.interact(client.sessionId, m ?? {});
      client.send('action-result', res);
    });

    // Name what you are picking up — a crate, or one board of a shelf — and
    // walk there to do it. Nothing is ever picked up unasked. See `Game.take`.
    this.onMessage('take', (client, m) => {
      const res = this.game.take(client.sessionId, {
        palletId: m?.palletId ? String(m.palletId) : null,
        shelfId: m?.shelfId ? String(m.shelfId) : null,
        itemId: m?.itemId ? String(m.itemId) : null,
      });
      if (!res.ok) client.send('action-result', res);
    });

    // Which seed this player is holding. The plot action reads it server-side,
    // so planting is "stand at a bare plot with a seed chosen", not a keypress.
    this.onMessage('select-crop', (client, m) => {
      client.send('action-result', this.game.selectCrop(client.sessionId, m?.cropId ?? null));
    });

    this.onMessage('plant', (client, m) => {
      client.send('action-result', this.game.plant(client.sessionId, m?.plotId, m?.cropId));
    });

    // Sowing from a plot's own menu: does the tilling and the planting in one,
    // and swaps out whatever was growing. See `Game.sow`.
    this.onMessage('sow', (client, m) => {
      client.send('action-result', this.game.sow(client.sessionId, m?.plotId, m?.cropId));
    });

    // Who works here. Hiring is a roster row, not an upgrade — see Game.hire.
    this.onMessage('hire', (client, m) => {
      client.send('action-result', this.game.hire(m?.kind));
    });

    this.onMessage('fire', (client, m) => {
      client.send('action-result', this.game.fire(m?.workerId));
    });

    this.onMessage('assign-jobs', (client, m) => {
      client.send('action-result', this.game.assignJobs(m?.workerId, m?.jobs));
    });

    this.onMessage('promote', (client, m) => {
      client.send('action-result', this.game.promote(m?.workerId));
    });

    // The same ladder downwards. A rung is the one thing you buy for somebody
    // that keeps charging you — `wage_mult` is per day — so it needs a way back
    // that isn't letting them go.
    this.onMessage('demote', (client, m) => {
      client.send('action-result', this.game.demote(m?.workerId));
    });

    // `?? null` rather than a bare read, so "take their skin off" is something
    // the wire can actually say — an absent field and a cleared one have to
    // mean the same thing or there is no way back to the factory colours.
    this.onMessage('set-skin', (client, m) => {
      client.send('action-result', this.game.setSkin(m?.workerId, m?.skin ?? null));
    });

    this.onMessage('buy-stock', (client, m) => {
      client.send('action-result', this.game.buyStock(client.sessionId, m?.itemId, Number(m?.qty) || 1));
    });

    // `itemId` is WHICH board. A unit holds one price per board, so a price
    // change that did not name one would have to guess, and any rule for
    // guessing reprices something the player was not looking at.
    this.onMessage('set-price', (client, m) => {
      client.send('action-result',
        this.game.setPrice(m?.shelfId, Number(m?.price), m?.itemId ?? null));
    });

    // What a shelf is for, and where it sits in the restock queue. Both are
    // sent from the fixture menu but neither is a `build-` verb: deciding what
    // goes on a shelf is a choice about stock, like sowing a bed, so — like
    // `sow` above — it needs no build mode and carries no gate.
    // `on` says which way the checkbox went. Passed through rather than left to
    // the server to infer: the row you pressed knows whether it was ticked, and
    // a toggle that re-reads the state it is toggling races the snapshot — press
    // twice quickly and the second press reads the first one's old answer.
    // Undefined still means "flip it", so a client that has not reloaded works.
    this.onMessage('assign', (client, m) => {
      client.send('action-result', this.game.assignShelf(
        client.sessionId, m?.shelfId, m?.itemId ?? null, m?.on ?? null,
      ));
    });

    // Which of its recipes an appliance is set to. Same gate as `assign` above
    // and for the same reason: deciding what the kitchen makes is a choice
    // about stock, not construction, so the menu can send it with the build bar
    // down. It names the recipe it pressed rather than a direction — a machine
    // that knows four has no "next one".
    this.onMessage('station-recipe', (client, m) => {
      client.send('action-result', this.game.setStationRecipe(
        client.sessionId, m?.stationId, m?.recipeId,
      ));
    });

    this.onMessage('restock-order', (client, m) => {
      client.send('action-result', this.game.setRestockPriority(m?.shelfId, m?.priority));
    });

    // Whether the shop hand may rearrange this unit. Not gated on build mode,
    // the same way `restock-order` isn't: it is a shopkeeping decision about a
    // shelf you are stood in front of, not a change to what the shop is made of.
    this.onMessage('shelf-hands', (client, m) => {
      client.send('action-result', this.game.setShelfHands(m?.shelfId, m?.on));
    });

    // What the shop does without being asked, and what that may cost per day.
    // Each field is optional — the supplier sends the one row you pressed, for
    // the same reason `assign` carries `on`: a message that re-sent the other
    // two would race the snapshot and put back whatever it last saw.
    this.onMessage('shop-orders', (client, m) => {
      client.send('action-result', this.game.setOrders(m ?? {}));
    });

    // The same three decisions for one item. A stepper sends the value it
    // arrived at rather than a direction, so two quick presses cannot land as
    // one — the row already knows what it is showing.
    this.onMessage('item-rule', (client, m) => {
      client.send('action-result', this.game.setItemRule(m?.itemId, m ?? {}));
    });

    /**
     * The doors, and the clock.
     *
     * Both send the state they want rather than "toggle": the button already
     * knows what it is showing, and two people sharing one shop means a toggle
     * can be pressed twice from two places and land as nothing. Both name who
     * did it, because the other person's shop just shut with them standing in it.
     */
    this.onMessage('shop-open', (client, m) => {
      const by = this.game.players[client.sessionId]?.name;
      client.send('action-result', this.game.setOpen(!!m?.open, by));
    });

    this.onMessage('pause', (client, m) => {
      const by = this.game.players[client.sessionId]?.name;
      client.send('action-result', this.game.setPaused(!!m?.paused, by));
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

    // Drawing on the boundaries between cells rather than on a cell: walls,
    // windows, doorways. Re-flows the shell, so the layout goes back out.
    this.onMessage('build-edge', (client, m) => {
      const res = this.game.buildEdge(client.sessionId, m ?? {});
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    // Painting an area of ground rather than drawing along a line. Two corners
    // for the same reason a wall sends two ends: a stroke is up to 256 cells
    // and the inbound cap is 4KB.
    this.onMessage('build-ground', (client, m) => {
      const res = this.game.buildGround(client.sessionId, m ?? {});
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    // ---- the fixture menu ---------------------------------------------------
    // One message per thing a fixture's own menu offers. They all take an id,
    // because the player opened that fixture's menu to get here.

    this.onMessage('build-lift', (client, m) => {
      client.send('action-result', this.game.liftFixture(client.sessionId, m?.id));
    });

    // With an `itemId` it is one board of a unit rather than the whole thing —
    // the delete button on a board row. Same gate, same crates, finer address.
    this.onMessage('build-empty', (client, m) => {
      client.send('action-result', this.game.emptyFixture(client.sessionId, m?.id, m?.itemId ?? null));
    });

    // The one fixture verb that sends no layout, because nothing about the shop
    // moved: `boh` rides the snapshot, beside `assigned` and `priority` and for
    // the same reason — it changes while the building stands still. This used to
    // claim the opposite and broadcast one anyway, which cost a full teardown
    // and rebuild of the scene every time somebody flipped a shelf.
    this.onMessage('build-boh', (client, m) => {
      client.send('action-result', this.game.setBackOfHouse(client.sessionId, m?.id, m?.on !== false));
    });
    this.onMessage('build-rotate', (client, m) => {
      const res = this.game.rotateFixture(client.sessionId, m?.id, m?.dir);
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    this.onMessage('build-upgrade', (client, m) => {
      const res = this.game.upgradeFixture(client.sessionId, m?.id);
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    this.onMessage('build-downgrade', (client, m) => {
      const res = this.game.downgradeFixture(client.sessionId, m?.id);
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    this.onMessage('build-style', (client, m) => {
      const res = this.game.styleFixture(client.sessionId, m?.id, m?.variant ?? '');
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
    this.emptySince = null;
    // "Last played" is what the menu sorts by and what the stale sweep measures,
    // so it moves when somebody actually walks in — not when a room boots, which
    // an agent can cause without anyone playing anything.
    touchWorldRow(this.worldId);
    this.game.addPlayer(client.sessionId, options?.name);
    this.sendLayout(client);
    client.send('catalog', this.catalog());
    // Which shop this is, sent with who you are. The HUD says the name out loud
    // because "am I in the right save" is not a question you should have to
    // answer by recognising your own aisles.
    const row = worldRow(this.worldId);
    client.send('you', {
      id: client.sessionId,
      world: { id: this.worldId, name: row?.name ?? this.worldId },
    });
  }

  onLeave(client) {
    this.game.removePlayer(client.sessionId);
    if (this.clients.length <= 1) this.emptySince = Date.now();
    // Save on the way out rather than only on dispose. Five minutes of idle
    // grace is five minutes in which the process can be killed, and everything
    // since the last upgrade would go with it.
    this.game.persist();
    touchWorldRow(this.worldId);
  }

  onDispose() {
    this.unsubscribeContent?.();
    rooms.delete(this);
    this.game.persist();
    console.log(`[room] ${this.roomId} disposed (world "${this.worldId}")`);
  }

  // ---- Colyseus devMode -----------------------------------------------------
  // These two let the shop survive a server restart while you're editing code.
  // Without them, saving a file in server/ would dump everyone back to a fresh
  // world, which makes iterating on the sim miserable.

  onCacheRoom() {
    // The "already asked the director about today" guard rides along inside
    // `serialize()` as `lastDirectorDay`, and is also on the save — it has to
    // survive a *cold* start as much as a hot one, or every restart fires
    // another world event for the same day. Caching it here as well would just
    // be a second copy to get out of step.
    return { state: this.game.serialize() };
  }

  onRestoreRoom(cached) {
    if (!cached?.state) return;
    this.game = Game.restore(cached.state);
    // The cache is the authority on which world this room was: `onCreate` ran
    // with whatever options the restore handed it, and a room that came back as
    // a different world would persist one shop's day over another's.
    this.worldId = this.game.worldId ?? this.worldId;
    // Players reconnect as new sessions, so old player entries are stale.
    this.game.players = {};
    console.log(`[room] ${this.roomId} restored world "${this.worldId}" at day ${this.game.day}`);
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
      // What each kind of fixture looks like and how far it upgrades. This is
      // what the renderer builds shelves out of, so it has to travel with the
      // rest of the catalog rather than being baked into the client.
      fixtures: c.fixtures,
      // The Staff menu lists who you can take on, what they cost and what they
      // will do — all authored, so a new kind of worker needs no client change.
      workers: c.workers,
      // Every job that can be assigned. Sent rather than copied into the client
      // so the assignment screen offers exactly what `staff.js` implements — a
      // tenth job appears in the menu the moment the vocabulary grows, and a
      // job the client invented could never be offered.
      jobs: JOBS,
      // What a worn-out hire goes off and does. Authored, so the roster can
      // name it without the client keeping its own list of breaks.
      pastimes: c.pastimes,
      // Every look a hire can wear. Sent whole because a skin is small (a few
      // colours and at most four parts) and because the renderer resolves them
      // per body — a skin edited over MCP has to reach the bots already on
      // shift, and it does that by riding the catalog rebroadcast.
      skins: c.skins,
      // Everything that drives: the delivery van, the customers' cars. Sent for
      // the same reason `fixtures` is — the renderer builds one out of its
      // authored model, so a van redrawn over MCP has to reach the client, and
      // it does that by riding the catalog rebroadcast rather than by anyone
      // baking a van into `props.js`.
      vehicles: c.vehicles,
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
    //
    // The day is claimed inside `runDirector`, synchronously, so this can't
    // re-fire on the next tick — and unlike the room-local flag this replaces,
    // what it claims is on the save.
    if (this.game.lastDirectorDay !== this.game.day) {
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
