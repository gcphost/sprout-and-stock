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
 *
 * THIS FILE IMPORTS NO TRANSPORT, and that is the point of it rather than a
 * tidiness. `ShopRoom` is the shop; `MartRoom.js` next door is `ShopRoom`
 * wearing Colyseus, and `server/rooms/host.js` is the same shop wearing a
 * channel. A single `import { Room } from 'colyseus'` up here would be enough to
 * drag a Node websocket server into a browser bundle, which is a build error at
 * best and three hundred kilobytes of dead matchmaker at worst — so the split is
 * load-bearing and not cosmetic. See the contract above `ShopRoom`, and
 * docs/browser.md for why there is a second host at all.
 */

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
 * Which fixtures a menu message is about — the ONE spelling of it.
 *
 * Every fixture verb took a single id, because until now the only way to name a
 * fixture was to open its menu. Several can be picked at once now, so the
 * message carries `ids` and the old singular field is what a selection of one
 * still sends. Both are read here rather than in five handlers, for the reason
 * `stockCrates` gives about rubbish: ten readers each doing their own version
 * of "which ones did they mean" is ten places a new caller can be subtly wrong.
 *
 * The singular field is not one name: a build verb says `id` and a shopkeeping
 * one says `shelfId`, and that split is older than this and worth keeping —
 * `assign` is a decision about stock and `build-style` is construction.
 */
const targets = (m) => (Array.isArray(m?.ids) && m.ids.length
  ? m.ids.map(String)
  : [m?.id ?? m?.shelfId].filter((x) => x != null).map(String));

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
 * How long a room with nobody in it stays OPEN before it saves and goes.
 *
 * It used to be how long one kept *simulating*, and that was the bug — see
 * `stepIfWatched`. The room is still here for five minutes; the world inside it
 * is not running for any of them.
 *
 * There is a grace period at all because an agent's room is legitimately empty:
 * `roomForWorld` starts one headless to reset an economy or take a screenshot,
 * and a room that disposed the instant it had no clients would be gone before
 * the next call. Five minutes is long enough for a working session and short
 * enough that ten abandoned worlds aren't sitting in memory overnight.
 */
// `globalThis.process?.env` for the reason `server/director.js` says at length:
// a bare `process` at module scope is a ReferenceError while this module is
// being evaluated, in a build where there is no process — which is not a
// setting failing to apply, it is the room never existing.
const IDLE_MS = Number(globalThis.process?.env?.SNS_ROOM_IDLE_MS ?? 5 * 60 * 1000);
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

/**
 * THE SHOP, WRITTEN AGAINST A HOST RATHER THAN AGAINST COLYSEUS.
 *
 * Everything below is the game: 50 handlers, the tick, the broadcast, the idle
 * timer, the catalog. None of it cares what is carrying the bytes. `Base` is
 * whatever does — Colyseus today, and in a browser build a data channel or
 * nothing at all (see docs/browser.md).
 *
 * A mixin rather than composition, deliberately. The alternative is a `Shop`
 * object holding a `host` and fifty handlers rewritten as `this.host.onMessage`,
 * which is a better-looking boundary and a worse *change*: this seam has to be
 * provably a no-op, and the only diff that proves itself is one where the body
 * is untouched. Every `this.broadcast` in here resolves exactly where it did.
 *
 * THE CONTRACT — what a `Base` has to provide. Ten things, and the browser
 * implementation is only honest if it has all ten:
 *
 *   broadcast(type, payload)         to everybody
 *   onMessage(type, (client, m))     inbound dispatch
 *   clients                          array; `.length` and `[0]` are both read
 *   client.sessionId                 stable for the life of the connection
 *   client.send(type, payload)       to one
 *   clock.setInterval(fn, ms)        a clock the host can stop with the room
 *   setSimulationInterval(fn, ms)    the 20Hz tick
 *   disconnect()                     shut this room down (the idle timer)
 *   roomId                           for the log lines
 *   maxClients / autoDispose / setMetadata()
 *                                    Colyseus's matchmaking knobs. A host with
 *                                    no matchmaker takes the writes and ignores
 *                                    them — they must not throw.
 *
 * ...and the Base must CALL `onCreate(options)`, `onJoin(client, options)`,
 * `onLeave(client)` and `onDispose()`. `onCacheRoom`/`onRestoreRoom` are
 * Colyseus's devMode alone and a host that has no such thing simply never calls
 * them; the guard they protect is on the save as well, which is why that is
 * safe (see `pushState`).
 *
 * THE RULE, and it is the whole reason the seam is worth anything: **no
 * behaviour lives in a Base.** It translates those ten calls and holds no state
 * of its own. The moment one of them branches on which build it is, the
 * twenty-one `verify:*` sweeps — every one of which runs against the Colyseus
 * side — have stopped being evidence about the other one.
 */
export const ShopRoom = (Base) => class extends Base {
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

    this.setSimulationInterval(() => this.stepIfWatched(), TICK_MS);
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
   * NOBODY IS HERE, SO NOTHING HAPPENS.
   *
   * The world only runs while somebody is in it. Close the last tab and the
   * clock stops on the tick the socket does; open one and it goes on from
   * exactly there.
   *
   * **Why this had to change.** The room kept stepping for the whole idle grace
   * — five real minutes, which is most of an in-game trading day, and more when
   * it crosses the night at `NIGHT_SPEED`. What runs in those minutes is a shop
   * that is OPEN with nobody behind the till and nobody to work it, so every
   * shopper who walks in queues, waits, and storms out at −0.03 reputation. It
   * takes 34 of those to move reputation across its entire range. So closing the
   * browser for tea and coming back to a shop the town has turned on is not an
   * edge case, it is the reliable outcome — and it is *invisible*: the ledger
   * blames "Lost patience", which is exactly what happened and says nothing
   * about the fact that nobody was playing. The old comment on `checkIdle`
   * described this precisely and read it as a reason to dispose *sooner*, which
   * treats the symptom.
   *
   * **It is not `Game.paused`.** That is a fact about a person — you pressed P,
   * it persists as a wall-clock stamp, the HUD strikes the clock through. This
   * is a fact about a room, it is nobody's decision, and it must leave no trace
   * on the save: a shop that came back stopped because it once sat empty would
   * be `pausedAt` firing for a reason the player never chose.
   *
   * **It is here rather than in either Base**, which is the whole seam
   * (`server/rooms/host.js`): `MartRoom` answers the ten calls with Colyseus and
   * `ChannelHost` answers them with a channel, and both extend this. So the
   * desktop build and the web build cannot disagree about when the world runs —
   * which is the one thing they must never disagree about, since it decides what
   * a save is worth.
   *
   * `clients.length` and not a flag: the two Bases maintain that array
   * themselves, and it is the one thing about a connection both of them already
   * agree on.
   */
  stepIfWatched() {
    if (!this.clients.length) return;
    this.game.step(TICK_MS / 1000);
  }

  /**
   * A STOPPED CLOCK REFUSES OUT LOUD, because it used to refuse in silence.
   *
   * Everything your body does is spread across ticks — a walk has legs, and
   * every held action is a ring wound by `stepActions`. None of that runs while
   * the clock is held, so a tap to walk, a hold to set a crate down and a press
   * to pick one up all *landed*, were accepted, and then sat there for ever. The
   * shop said nothing, because nothing had gone wrong: the message was fine and
   * the world simply never got to it.
   *
   * What that reads as is the game having frozen — which it has, and which is
   * the one thing the player already knows and has forgotten. A refusal names
   * it, and it costs nothing to build: `action-result` is already a toast and
   * the refusal sound on the client, on every verb in here.
   *
   * It guards the verbs that need the world to RUN and deliberately no others.
   * A tap that takes one unit off a board, a build, an order, opening a menu —
   * all of those are one immediate mutation and all of them still work stopped,
   * which is most of what looking round a paused shop is for. Refusing them
   * would be inventing a rule the sim does not have.
   *
   * It lives here beside `stepIfWatched` rather than in `Game`, because these
   * two are the same fact asked from either end: that one is the world not
   * running, and this is what to say to somebody who asked it to do something
   * while it wasn't.
   */
  frozen(client) {
    if (!this.game.paused) return false;
    client.send('action-result', {
      ok: false,
      error: 'The clock is stopped — start it and try again',
    });
    return true;
  }

  /**
   * Save and shut down once nobody has been here for a while.
   *
   * `disconnect()` rather than leaving it open: an empty room still holds a
   * world in memory, a content poll and a 20Hz timer, and asks the director for
   * a world event every in-game day — one of which is a paid API call. Before
   * save slots existed there was only ever one room, so it never mattered.
   *
   * It is no longer about the SIM, which is the half `stepIfWatched` took over:
   * these five minutes are frozen now, so what this reclaims is memory rather
   * than a shop being quietly ruined in the background.
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
      // Sprint and which camera you are behind both ride here rather than on
      // messages of their own — see `setInput`.
      this.game.setInput(
        client.sessionId,
        Number(m?.dx) || 0,
        Number(m?.dz) || 0,
        !!m?.sprint,
        !!m?.fpv,
      );
    });

    // Stop a shoplifter. Named rather than proximity, like every other verb
    // that moves goods, because the end of a chase is the most crowded two
    // tiles in the shop — see `Game.taze`.
    this.onMessage('taze', (client, m) => {
      // Guarded like `walk-to`: a chase is legs across ticks, so a stopped
      // clock has nowhere to put it, and tazing somebody in a frozen shop would
      // be reaching into a world that is not running.
      if (this.frozen(client)) return;
      const res = this.game.taze(client.sessionId, String(m?.id ?? ''));
      // Spoken on refusal, unlike `walk-to`: a tazer that did nothing and said
      // nothing is indistinguishable from a dropped message, and the answer is
      // usually something the player can act on in the next second ("too far
      // away", "still charging").
      client.send('action-result', res?.error ? { ok: false, error: res.error } : { ok: true, ...res });
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
        // Which pile in the box, for a crate holding more than one thing. The
        // same optional address `take` carries for one board of a shelf, and
        // omitted it means what it always meant: the biggest pile in there.
        m?.itemId ? String(m.itemId) : null,
      );
      if (!res.ok) client.send('action-result', res);
    });

    // ...and the same tap on one board of a shelf you are already stood at.
    // Its own message rather than a mode on `take` for the reason `crate-one`
    // is: the tap and the hold share a pointer press, and they mean different
    // amounts. See `Game.tapBoard`.
    this.onMessage('shelf-one', (client, m) => {
      const res = this.game.tapBoard(
        client.sessionId,
        m?.shelfId ? String(m.shelfId) : null,
        m?.itemId ? String(m.itemId) : null,
        // Which button, the same field `crate-one` carries and for the same
        // reason: left takes, right puts, and the shop is told which rather than
        // guessing from what happens to be in your hands.
        !!m?.put,
      );
      if (!res.ok) client.send('action-result', res);
    });

    // ...and the same tap on an appliance. Its own message rather than a mode on
    // `shelf-one` because a station is not a shelf and never was: that is exactly
    // the bug this fixes — `Game.tapStation`.
    this.onMessage('station-one', (client, m) => {
      const res = this.game.tapStation(
        client.sessionId,
        m?.stationId ? String(m.stationId) : null,
        // Which button, the same field `crate-one` and `shelf-one` carry: left
        // takes one off the tray, right puts one in the hopper. No pile to name
        // in either direction, unlike a shelf — a machine's goods are inside it,
        // so there is nothing on screen the pointer could have meant.
        !!m?.put,
      );
      if (!res.ok) client.send('action-result', res);
    });

    this.onMessage('press', (client, m) => {
      // NOT guarded by `frozen`, and it is the one in here that looks like it
      // should be. A ring cannot wind while the clock is held, so a hold is the
      // gesture that most looks like the game having broken — but this bit is
      // set by EVERY press on the canvas, including the ones that are perfectly
      // legal stopped: selecting a shelf, opening a menu, pointing at a hire. So
      // refusing it is a refusal on every tap of a paused shop, at the moments
      // the shop is in fact doing exactly what was asked.
      //
      // The refusals belong on the verbs that are the *ask* — `walk-to`,
      // `place`, `take`, `interact` — because those are the messages a player
      // sends when they want the world to do something, and a press is not one
      // of them. The press bit stays a bit: it goes down, nothing winds, and if
      // the hold went on to ask for anything the ask is what says no.
      this.game.setPressing(client.sessionId, !!m?.down);
    });

    // Tap a tile, walk there. Sent as a destination and not a route: the client
    // has no walk grid and no business having one, and a route is also the one
    // thing here that could outgrow the 4KB inbound cap.
    this.onMessage('walk-to', (client, m) => {
      // A walk is legs across ticks, so a stopped clock has nowhere to put it.
      if (this.frozen(client)) return;
      // A tile or a thing. Naming the thing is not a convenience — it is what
      // gets you to the side of the shelf you can actually work from.
      // `put` is which button asked, the same field `place` carries. A walk is
      // how the right button reaches a unit across the shop, and the direction
      // has to survive the journey — see `Game.walkToFixture`.
      const res = m?.fixture
        ? this.game.walkToFixture(client.sessionId, String(m.fixture), !!m?.put)
        : this.game.walkTo(client.sessionId, Number(m?.x), Number(m?.z));
      if (!res.ok) client.send('action-result', res);
    });

    // ...and name a square as somewhere to PUT what you are holding, without
    // going to it. The other half of the tile gesture: a tap walks (above), a
    // hold puts down, and this is what the press arms so the ring has a target.
    // Silent on refusal like `walk-to` is — the client only sends it for a square
    // it has drawn as green, so a no here is a disagreement to fix, not news for
    // the player. See `Game.placeAt`.
    // A square or a thing, the same pair `walk-to` above takes and for the same
    // reason: the two are one sentence ("this is where what I am holding goes")
    // with two kinds of address, and splitting them into two messages would let
    // the press aim at one and not the other — which is exactly the state this
    // fixed. See `Game.aimAt`.
    this.onMessage('place', (client, m) => {
      // Naming a square arms a ring, and a ring is `stepActions`.
      if (this.frozen(client)) return;
      const res = m?.clear
        ? this.game.clearAim(client.sessionId)
        : m?.fixture
          ? this.game.aimAt(client.sessionId, String(m.fixture))
          : this.game.placeAt(client.sessionId, Number(m?.x), Number(m?.z));
      if (!res.ok) client.send('action-result', res);
    });

    /**
     * Wave, cheer, dance, point.
     *
     * `frozen` like a walk, and for the same reason rather than out of
     * symmetry: an emote is a couple of seconds measured against `elapsed`,
     * and a stopped clock never advances it — so a wave started on a paused
     * shop is an arm that stays up until somebody presses play. A refusal
     * somebody can read beats a pose that welds itself on.
     *
     * The refusal is SENT, unlike `walk-to`'s. That one is silent because the
     * client only ever asks for a square it has drawn as walkable, so a no is
     * a disagreement rather than news; this is a bare press with nothing on
     * screen promising anything, so the one sentence it can be answered with
     * is worth having.
     */
    this.onMessage('emote', (client, m) => {
      if (this.frozen(client)) return;
      const res = this.game.emote(client.sessionId, String(m?.kind ?? ''));
      if (!res.ok) client.send('action-result', res);
    });

    this.onMessage('interact', (client, m) => {
      if (this.frozen(client)) return;
      const res = this.game.interact(client.sessionId, m ?? {});
      client.send('action-result', res);
    });

    // Name what you are picking up — a crate, or one board of a shelf — and
    // walk there to do it. Nothing is ever picked up unasked. See `Game.take`.
    this.onMessage('take', (client, m) => {
      // Nothing is ever picked up without walking to it first, which is the half
      // that needs a running world.
      if (this.frozen(client)) return;
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

    // ...and off it again, while it is still waiting for a run. Its own message
    // rather than a negative `qty` on the one above: the two have opposite
    // guards — one is about room at the bay and money in the till, the other
    // about whether the lorry has left — and a sign flip is the shape of a
    // typo that spends money.
    this.onMessage('cancel-order', (client, m) => {
      client.send('action-result', this.game.cancelOrder(client.sessionId, m?.itemId ? String(m.itemId) : null));
    });

    // `itemId` is WHICH board. A unit holds one price per board, so a price
    // change that did not name one would have to guess, and any rule for
    // guessing reprices something the player was not looking at.
    // Which board a thing sits on, top to bottom. One message carrying the WHOLE
    // order rather than a nudge per row: two people can be looking at one shelf,
    // and "move cheese up one" applied to a list that has changed underneath is
    // a swap with whatever happens to be there now. A full list is idempotent
    // and says what the person who sent it was looking at.
    this.onMessage('board-order', (client, m) => {
      client.send('action-result',
        this.game.orderBoards(m?.shelfId, Array.isArray(m?.order) ? m.order : null));
    });

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
    // ...and `ids` is which units, because several can be picked at once now.
    // `targets` is the one spelling of "who is this about" — see the note there.
    this.onMessage('assign', (client, m) => {
      const item = m?.itemId ?? null;
      client.send('action-result', this.game.bulkFixtures(
        targets(m),
        (id) => this.game.assignShelf(client.sessionId, id, item, m?.on ?? null),
        (n) => (item
          ? `${n} units ${m?.on === false ? 'no longer kept' : 'kept'} for ${this.game.itemSaid(item)}.`
          : `${n} units take anything again.`),
      ));
    });

    // Which of its recipes an appliance is set to. Same gate as `assign` above
    // and for the same reason: deciding what the kitchen makes is a choice
    // about stock, not construction, so the menu can send it with the build bar
    // down. It names the recipes it wants rather than a direction — a machine
    // that knows four has no "next one".
    //
    // The whole SET in one message, because a machine with two heads is two
    // decisions taken in one press, and `bulkFixtures`' argument applies to this
    // axis too: N messages is N lines in the feed for one press. `recipeId`
    // stays readable for the single-headed machine every shop owns.
    this.onMessage('station-recipe', (client, m) => {
      client.send('action-result', this.game.setStationRecipes(
        client.sessionId, m?.stationId, m?.recipeIds ?? m?.recipeId,
      ));
    });

    this.onMessage('restock-order', (client, m) => {
      client.send('action-result', this.game.bulkFixtures(
        targets(m),
        (id) => this.game.setRestockPriority(id, m?.priority),
        (n) => `${n} units moved in the refill queue.`,
      ));
    });

    // Whether the shop hand may rearrange this unit. Not gated on build mode,
    // the same way `restock-order` isn't: it is a shopkeeping decision about a
    // shelf you are stood in front of, not a change to what the shop is made of.
    this.onMessage('shelf-hands', (client, m) => {
      client.send('action-result', this.game.bulkFixtures(
        targets(m),
        (id) => this.game.setShelfHands(id, m?.on),
        (n) => (m?.on === false
          ? `${n} units left for you to arrange.`
          : `${n} units handed back to the shop hand.`),
      ));
    });

    // Whether the crew choose which way a sorter sends things. Build mode only,
    // unlike `shelf-hands`: a sorter is plumbing rather than shopkeeping, and
    // every other verb that changes what a conveyor DOES is a build verb.
    this.onMessage('sorter-auto', (client, m) => {
      client.send('action-result', this.game.bulkFixtures(
        targets(m),
        (id) => this.game.setSorterAuto(client.sessionId, id, m?.on),
        (n) => (m?.on === false
          ? `${n} sorters split everything evenly now.`
          : `${n} sorters left to the crew.`),
      ));
    });

    this.onMessage('sorter-route', (client, m) => {
      client.send('action-result', this.game.bulkFixtures(
        targets(m),
        (id) => this.game.setSorterRoute(client.sessionId, id, m?.route),
        (n) => `${n} sorters updated.`,
      ));
    });

    // What a packer is building. Build mode only, like every other verb that
    // changes what a conveyor does.
    //
    // Bulk like the rest, and it is the one of these where a batch is the
    // ordinary press rather than a convenience: a line of packers is what you
    // build to fold a whole delivery, and ticking eggs onto six of them one at a
    // time is the four-input shelf menu this game already deleted once.
    this.onMessage('packer-items', (client, m) => {
      client.send('action-result', this.game.bulkFixtures(
        targets(m),
        (id) => this.game.setPackerItems(client.sessionId, id, m?.items),
        (n) => ((m?.items ?? []).length
          ? `${n} packers updated.`
          : `${n} packers build whatever the run wants again.`),
      ));
    });

    // ...and who goes first where two lines meet, which is the same question
    // asked of a plain belt. Build mode only, like the rest of them.
    this.onMessage('belt-merge', (client, m) => {
      client.send('action-result', this.game.bulkFixtures(
        targets(m),
        (id) => this.game.setBeltMerge(client.sessionId, id, m?.merge),
        (n) => `${n} junctions updated.`,
      ));
    });

    // Which half of its job a loader does. Build mode only, like the two below.
    this.onMessage('arm-mode', (client, m) => {
      client.send('action-result', this.game.bulkFixtures(
        targets(m),
        (id) => this.game.setArmMode(client.sessionId, id, m?.mode),
        (n) => (m?.mode === 'load' ? `${n} loaders only put goods on the line now.`
          : m?.mode === 'unload' ? `${n} loaders only take goods off the line now.`
            : `${n} loaders load and unload again.`),
      ));
    });

    /**
     * ...and which of its SIDES a machine uses, one side per press.
     *
     * Bulk like the rest of them, and the fold is the interesting half: a side
     * is a compass turn, so picking six loaders and shutting "side 1" shuts the
     * same *direction* on all six rather than the same neighbour. That is the
     * honest reading of a batch — you are looking down an aisle at six machines
     * standing the same way round — and it is why the summary names the turn
     * rather than a tile, which would be right about one of the six.
     */
    this.onMessage('conveyor-sides', (client, m) => {
      client.send('action-result', this.game.bulkFixtures(
        targets(m),
        (id) => this.game.setConveyorSides(client.sessionId, id, m?.r, m?.mode),
        (n) => (m?.mode === 'in' ? `${n} machines only take boxes on that side.`
          : m?.mode === 'out' ? `${n} machines only give boxes on that side.`
            : m?.mode === 'off' ? `${n} machines leave that side alone.`
              : `${n} machines take and give on that side again.`),
      ));
    });

    // ...and which way it sends what nothing wants. Build mode only, like
    // `sorter-auto` and for the same reason.
    this.onMessage('sorter-reject', (client, m) => {
      client.send('action-result', this.game.bulkFixtures(
        targets(m),
        (id) => this.game.setSorterReject(client.sessionId, id, m?.rot ?? null),
        (n) => (m?.rot == null
          ? `${n} sorters split what nothing wants again.`
          : `${n} sorters send what nothing wants down one line.`),
      ));
    });

    // ...and whether a junction's fifth way out — the other storey — counts.
    // Build mode only, like the rest of the conveyor settings.
    //
    // A TUNNEL MOUTH answers it too, and the fold says the pieces rather than
    // one of them: a batch is one message, so "3 pieces" is the only honest
    // summary of a pick that could hold both.
    this.onMessage('sorter-riser', (client, m) => {
      client.send('action-result', this.game.bulkFixtures(
        targets(m),
        (id) => this.game.setSorterRiser(client.sessionId, id, m?.on === true),
        (n) => (m?.on === true
          ? `${n} pieces can send things to the other storey now.`
          : `${n} pieces keep everything on their own storey.`),
      ));
    });

    // ...and which way a shaft carries. Build mode only, like the three above,
    // and bulk like them because a loop rejoining on two levels is built out of
    // more than one shaft.
    this.onMessage('lift-way', (client, m) => {
      client.send('action-result', this.game.bulkFixtures(
        targets(m),
        (id) => this.game.setLiftWay(client.sessionId, id, m?.way ?? null),
        (n) => (m?.way == null
          ? `${n} lifts work out which way to carry again.`
          : `${n} lifts carry ${m.way} now.`),
      ));
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

    // Put something back on the list the shop stopped stocking by itself. Its
    // own message rather than a field on `item-rule` for the reason `stockAgain`
    // gives: one is a standing instruction of yours, the other is cancelling a
    // guess the shop made, and folding them together would leave you with a rule
    // you never wrote.
    this.onMessage('stock-again', (client, m) => {
      client.send('action-result', this.game.stockAgain(m?.itemId ? String(m.itemId) : null));
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

    /**
     * Where the shop stands. No layout to send and nothing to re-flow: the
     * surround is drawn from a group of its own outside the building (see
     * `Scene.setSurround`), and the id reaches every client on the next
     * ordinary state update.
     *
     * Named like the shutters are, and for the same reason: in a shop two
     * people share, the other person's entire horizon just changed.
     */
    this.onMessage('set-surround', (client, m) => {
      const by = this.game.players[client.sessionId]?.name;
      client.send('action-result', this.game.setSurround(m?.surround, by));
    });

    // `quiet` is a hold rather than a press — the client's Menu stopping the
    // world while it is open. Same switch, same stamp, no line in the feed.
    this.onMessage('pause', (client, m) => {
      const by = this.game.players[client.sessionId]?.name;
      client.send('action-result', this.game.setPaused(!!m?.paused, by, !!m?.quiet));
    });

    /**
     * Down tools while somebody is being shown round.
     *
     * The tutorial is client-side and sends no message the game did not already
     * have — except this one, and it is worth being honest about why it is the
     * exception. Every other beat asks the player to do something the game can
     * already do; this one asks the SHOP to hold off, and there was no verb for
     * that because until the shop came with a hire there was nobody to hold off.
     *
     * It carries no `by` and writes no log line: a hire standing still for two
     * minutes is not an event, and a feed that announced it would be announcing
     * the tutorial, which nothing else in the game does.
     */
    this.onMessage('crew-idle', (client, m) => {
      this.game.crewIdle = !!m?.idle;
    });

    /**
     * ...and where to stand while they are, which is the other half of it.
     *
     * The opening card is a shot of the shopfront with the two of you walking
     * into it, and the crew have downed tools for the length of the tour — so
     * without this the one hire a new shop comes with spends the establishing
     * shot standing behind the till indoors. Same argument as `crew-idle`
     * exactly: it asks the shop to do something no press has ever asked it to,
     * it writes no log line, and it is the tour's only other message.
     *
     * No `action-result`: nothing is waiting on it and a hire who cannot get
     * there simply does not go. See `Game.crewPose`.
     */
    this.onMessage('crew-pose', (client, m) => {
      // Two verbs on one message, because they are one idea — the tour staging
      // its cast — and both are one field of a card. `emote` alone is a wave
      // from where they already are, which is what the beat after the walk
      // wants: nobody moves, somebody says hello.
      if (m?.emote) this.game.crewEmote(String(m.emote));
      else this.game.crewPose(Number(m?.x), Number(m?.z), Number(m?.facing));
    });

    // Whether the build palette unfolds with the ladder. No layout to send —
    // this moves no fixture and no tile; it decides which tiles the BAR draws,
    // and the bar is redrawn off the snapshot that carries `reveal`.
    this.onMessage('reveal', (client, m) => {
      const by = this.game.players[client.sessionId]?.name;
      client.send('action-result', this.game.setReveal(!!m?.reveal, by));
    });

    this.onMessage('buy-upgrade', (client, m) => {
      const res = this.game.buyUpgrade(m?.upgradeId);
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    // The way back off one. No layout to send: the only upgrade that ever
    // changed the shape of the world is the one `sellUpgrade` refuses.
    this.onMessage('sell-upgrade', (client, m) => {
      client.send('action-result', this.game.sellUpgrade(m?.upgradeId));
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
      const res = this.game.undoStep('building that',
        () => this.game.placeFixture(client.sessionId, m ?? {}));
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    this.onMessage('build-drop', (client, m) => {
      const res = this.game.undoStep('moving that',
        () => this.game.dropFixture(client.sessionId, m ?? {}));
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    this.onMessage('build-cancel', (client) => {
      this.game.cancelBuildHold(client.sessionId);
    });

    // Drawing on the boundaries between cells rather than on a cell: walls,
    // windows, doorways. Re-flows the shell, so the layout goes back out.
    this.onMessage('build-edge', (client, m) => {
      const res = this.game.undoStep(m?.kind ? 'that wall' : 'knocking that through',
        () => this.game.buildEdge(client.sessionId, m ?? {}));
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    // Painting an area of ground rather than drawing along a line. Two corners
    // for the same reason a wall sends two ends: a stroke is up to 256 cells
    // and the inbound cap is 4KB.
    // Finishing one FACE of a wall, or a run of them. Two ends and a side, for
    // the reason above — and the reply is not a layout.
    //
    // `sendLayout` is what every other build verb answers with, because every
    // other build verb moves something: the client disposes its entire static
    // scene on one and builds it again. Paint moves nothing, so the shop it
    // would rebuild is the shop already on screen — the only thing that has
    // changed is which colour a few wall faces are drawn in, and the renderer
    // rebuilds walls on their own already (it does it on every quarter turn of
    // the camera). So the overlay goes out by itself, to everybody, because the
    // other player is looking at the same wall.
    this.onMessage('paint-face', (client, m) => {
      const res = this.game.undoStep('that paint',
        () => this.game.paintFaces(client.sessionId, m ?? {}));
      client.send('action-result', res);
      if (res.ok && !res.unchanged) this.broadcast('paint', this.game.paint);
    });

    // A run of conveyor, laid in one drag. Two ends and a piece, never the list —
    // the inbound cap is 4KB and the server re-runs `runCells` against the
    // same far end, so the two cannot disagree about which way it went.
    this.onMessage('build-run', (client, m) => {
      const res = this.game.undoStep('that run of conveyor',
        () => this.game.buildRun(client.sessionId, m ?? {}));
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    this.onMessage('build-ground', (client, m) => {
      const res = this.game.undoStep(m?.piece ? 'that ground' : 'taking that ground up',
        () => this.game.buildGround(client.sessionId, m ?? {}));
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    // ---- the fixture menu ---------------------------------------------------
    // One message per thing a fixture's own menu offers. They all take an id,
    // because the player opened that fixture's menu to get here.

    this.onMessage('build-lift', (client, m) => {
      client.send('action-result', this.game.liftFixture(client.sessionId, m?.id));
    });

    // ...and the same errand done to a SELECTION, which cannot be a carry: your
    // hands hold one fixture, so six picked up one at a time is six trips. A
    // batch is a rigid translation instead — one delta, one hold, one undo step
    // — and the client aims it the way it aims a stamp. See `shiftFixtures`.
    //
    // `sendLayout` on the way out like every other verb that moves a tile, and
    // one `undoStep` around the batch for `build-remove`'s reason: a player who
    // wants the aisle back wants all of it back in one press of Ctrl+Z.
    this.onMessage('build-shift', (client, m) => {
      const res = this.game.undoStep('that move', () => this.game.shiftFixtures(
        client.sessionId, targets(m), m?.dx, m?.dz,
      ));
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
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
      client.send('action-result', this.game.bulkFixtures(
        targets(m),
        (id) => this.game.setBackOfHouse(client.sessionId, id, m?.on !== false),
        (n) => (m?.on !== false
          ? `Moved ${n} units into the back.`
          : `Put ${n} units back on the shop floor.`),
      ));
    });
    this.onMessage('build-rotate', (client, m) => {
      const res = this.game.undoStep('turning that',
        () => this.game.rotateFixture(client.sessionId, m?.id, m?.dir));
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    // The ladder, both ways, over a whole selection — six freezers is one
    // decision about the shop rather than six about six units. Same shape as
    // `build-style` and `build-remove`: one hold, one undo step, one line.
    //
    // The money is the report, as it is for a removal, and here it is the whole
    // of the question: a rung is priced per PIECE, so six units at three
    // different tiers is six different prices and "upgraded 6" says nothing
    // about what just left the bank.
    //
    // Affordability stays where it is — inside `upgradeFixture`, against the
    // running cash. So a batch that outspends the shop upgrades what it can and
    // reports the rest as refused, which is the honest answer: the alternative
    // is pricing the batch up front and refusing the lot over the last unit.
    this.onMessage('build-upgrade', (client, m) => {
      let spent = 0;
      const res = this.game.undoStep('that upgrade', () => this.game.bulkFixtures(
        targets(m),
        (id) => {
          const r = this.game.upgradeFixture(client.sessionId, id);
          if (r?.ok) spent += r.cost ?? 0;
          return r;
        },
        (n) => `Upgraded ${n} fixtures for $${spent.toFixed(2)}.`,
      ));
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    this.onMessage('build-downgrade', (client, m) => {
      let back = 0;
      const res = this.game.undoStep('that downgrade', () => this.game.bulkFixtures(
        targets(m),
        (id) => {
          const r = this.game.downgradeFixture(client.sessionId, id);
          if (r?.ok) back += r.refund ?? 0;
          return r;
        },
        (n) => `Stepped ${n} fixtures back a rung — $${back.toFixed(2)} back.`,
      ));
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    // The one bulk verb that re-flows, which is the whole reason `bulkFixtures`
    // holds them: restyling eight shelves one message at a time is eight runs of
    // the generator and eight teardowns of the client's scene, for a change that
    // moves no tile. One message, one re-flow, one `sendLayout`.
    this.onMessage('build-style', (client, m) => {
      const res = this.game.undoStep('that restyle', () => this.game.bulkFixtures(
        targets(m),
        (id) => this.game.styleFixture(client.sessionId, id, m?.variant ?? ''),
        (n) => `Restyled ${n} fixtures.`,
      ));
      client.send('action-result', res);
      if (res.ok) this.sendLayout();
    });

    // The second bulk verb that re-flows, and the only destructive one — the
    // other four in the fixture menu's foot are deliberately one at a time (see
    // the note above `alone` in `client/fixture-menu.js`). Remove is the
    // exception because it is the verb people pick six things in order to do:
    // clearing an aisle out was six opens, six presses and six teardowns of the
    // client's whole scene, for one decision.
    //
    // One `undoStep` around the batch rather than one per fixture, which is
    // `buildRun`'s rule said about a selection: the player who wants an aisle
    // back wants all of it back in one press of Ctrl+Z.
    //
    // The money is what `say` reports, because it is the one thing about a
    // removal nobody can see afterwards — the fixtures are gone, and "six back"
    // says nothing about whether that was $30 or $900. Summed in the runner
    // rather than read off `bulkFixtures`, which keeps only the count.
    this.onMessage('build-remove', (client, m) => {
      const ids = targets(m);
      // The region rides along for the reason it rides along on `build-copy`,
      // and it is the same region: what a copy carries, a remove takes. A
      // selection clicked together sends none, and is the old verb exactly.
      const res = this.game.undoStep(ids.length > 1 ? 'removing those' : 'removing that',
        () => this.game.removeSelection(client.sessionId, ids, m?.region ?? null));
      client.send('action-result', res);
      if (res.ok) {
        this.sendLayout();
        // Paint comes off with the rest and `paintFaces` never re-flows, so the
        // overlay would otherwise arrive only on the next thing that did.
        this.broadcast('paint', this.game.paint);
      }
    });

    /**
     * Ctrl+Z, and Ctrl+Y.
     *
     * One pair of messages for every build verb above, because an undo step is
     * a *press* rather than a kind of change — see `server/sim/undo.js`. They
     * carry no payload at all: which step comes back is a fact about the shop's
     * own stack, and a client that named one could name a step the other player
     * has already reversed.
     *
     * Not gated on build mode, unlike everything they take back. Pressing
     * Ctrl+Z is not pointing at anything, so there is nothing for the mode to
     * disambiguate — and the moment you most want it is straight after leaving
     * the mode and seeing what you did.
     *
     * The answer says which half of the shop moved, because paint is the one
     * build verb that never re-flows: a step made only of colour would
     * otherwise come back with nothing on screen having changed at all.
     */
    const stepBack = (client, res) => {
      client.send('action-result', res);
      if (!res.ok) return;
      if (res.layout) this.sendLayout();
      if (res.paint) this.broadcast('paint', this.game.paint);
    };
    /**
     * Ctrl+C and Ctrl+V.
     *
     * The clipboard itself never crosses the wire in either direction — see
     * `Game.copyFixtures`. Copy sends the ids the player had picked and the four
     * ground-plane corners of the box they dragged them out of; paste sends the
     * cell they pointed at. All of it is well inside the 4KB inbound cap where
     * the thing it is about is not.
     *
     * The paste is one `undoStep`, which is the whole reason this is safe to
     * press: a stamp of twenty things is one Ctrl+Z, not twenty.
     */
    this.onMessage('build-copy', (client, m) => {
      client.send('action-result',
        this.game.copyFixtures(client.sessionId, targets(m), m?.region ?? null));
    });

    this.onMessage('build-paste', (client, m) => {
      const res = this.game.undoStep('that paste',
        () => this.game.pasteClipboard(client.sessionId, m ?? {}));
      client.send('action-result', res);
      if (res.ok) {
        this.sendLayout();
        // Paint rides its own message, exactly as it does everywhere else: a
        // stamp can carry a finish, and `paintFaces` deliberately never
        // re-flows, so the overlay would otherwise arrive only on the next
        // thing that did.
        this.broadcast('paint', this.game.paint);
      }
    });

    this.onMessage('undo', (client) => stepBack(client, this.game.undo()));
    this.onMessage('redo', (client) => stepBack(client, this.game.redo()));

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
    // `who` outlives the socket where `sessionId` does not — see `whoAmI` in
    // client/net.js. It is what puts you back where you were standing.
    this.game.addPlayer(client.sessionId, options?.name, options?.who);
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
    /**
     * Start the idle clock if that was the last of them.
     *
     * `<= 1` was a divergence between the two Bases, and the only one of its
     * kind: Colyseus calls `onLeave` with the leaver still in `clients`, while
     * `ChannelHost.leave` splices first — so the same line meant "nobody left"
     * on one build and "one person left" on the other, and on the web build two
     * players became one and started the empty-room timer under somebody who was
     * still standing there. It self-corrected within 15s (`checkIdle` clears
     * `emptySince` whenever anyone is in), which is why it could sit here
     * unnoticed; it is fixed rather than left because a rule that reads
     * differently on the two Bases is exactly what the seam exists to stop, and
     * the next one may not have a sweeper behind it.
     *
     * Asking the array both Bases have already updated their own way, rather
     * than counting the leaver, is what makes the answer the same on both.
     */
    if (!this.clients.some((c) => c !== client)) this.emptySince = Date.now();
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
        grow_minutes: cr.grow_minutes, model: cr.model,
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
      // What a shopper is carrying their shopping in. Sent whole and for the
      // same reason skins are: the renderer resolves one per person out of its
      // authored model, so a bag drawn over MCP has to reach the shoppers
      // already walking round the shop, and it does that by riding the catalog
      // rebroadcast rather than by anyone baking a bag into `props.js`.
      kits: c.kits,
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
    /**
     * Anything the shop has just achieved, drained rather than pushed.
     *
     * The sim has no sockets — this is the same shape the director's headline
     * uses — and it is a *queue* because two milestones can come due in one
     * tick. Broadcast rather than sent to one client: a shop two people are
     * playing achieved it together, and the modal pauses the world for both of
     * them either way.
     */
    for (const won of this.game.milestoneNews.splice(0)) this.broadcast('achieved', won);
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
};
