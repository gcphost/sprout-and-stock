/**
 * THE SIMULATION.
 *
 * One `Game` instance = one shop. It owns all mutable state and advances it in
 * `step(dt)`. Deliberately free of any networking or rendering so that:
 *
 *   - the Colyseus room can drive it at 20Hz for real players, and
 *   - the MCP `simulate()` tool can drive it at 10000x with no renderer,
 *     to answer "does this economy actually work?" in a couple of seconds.
 *
 * It reads content (items, crops, archetypes) from the live registry every
 * tick, so content added via MCP appears mid-game without a restart.
 */

import { content, world as loadWorld, saveWorld, freshEconomy } from '../content.js';
import { JOBS } from '../../shared/schemas.js';
import { activeModifiers, addModifier, pruneModifiers, clearModifiers } from '../db.js';
import { generateLayout, buildWalkGrid, T } from '../layout.js';
import { E, SOLID, edgeBetween } from '../../shared/edges.js';
import { findPath, followPath } from './pathing.js';
import {
  foldModifiers, modifierMeter, rankShelves, purchaseChance, suggestedPrice,
  wholesalePrice, footfall, clamp, round2,
} from './economy.js';
import { spoilRate, requiredFixture, desireFor } from '../../shared/tags.js';
import { makeRng } from '../../shared/rng.js';
import { stepStaff, breakProgress } from './staff.js';
import { FIXTURES, FIXTURE_KINDS, canPlace, rot4, FIXTURE_REFUND, canPlaceEdge, canPlaceEdges, edgeRun, isProp } from '../../shared/build.js';
import { pieceFor, kindOf, defaultPiece, ledgerKey } from '../../shared/pieces.js';

/** Real seconds in one in-game day. */
export const DAY_SECONDS = 360;
export const OPEN_HOUR = 8;
export const CLOSE_HOUR = 20;
const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

/** Half a body's width, for stopping short of a thin wall rather than in it. */
const PLAYER_RADIUS = 0.34;

/**
 * What a metre of each thing costs to build.
 *
 * Here rather than in content because these are the *shell* — you cannot author
 * a new kind of wall without teaching the enclosure fill what it means, so the
 * vocabulary is closed and the prices may as well sit beside it. A doorway
 * costs more than the wall it interrupts, which is why knocking one through is
 * not free money.
 */
/** Longest wall one drag will lay, so a stray gesture can't spend everything. */
const EDGE_RUN_MAX = 40;
const EDGE_COST = { [E.WALL]: 12, [E.WINDOW]: 26, [E.DOOR]: 34, [E.GATE]: 8, [E.FENCE]: 4 };
const EDGE_LABEL = {
  [E.WALL]: 'a wall', [E.WINDOW]: 'a window', [E.DOOR]: 'a doorway',
  [E.GATE]: 'a gate', [E.FENCE]: 'a fence',
};
const PLAYER_SPEED = 4.2;      // tiles/sec
const CUSTOMER_SPEED = 2.4;
const REACH = 1.6;             // how close you must be to interact
const MAX_UNITS_PER_SHELF = 3; // how many of one thing a shopper will take at once
const CASH_REACH = 1.8;        // how close you stand to scoop up the till
const CASH_MIN_LIFE = 3.5;     // seconds a pile stays put so you can see it
const UNLOAD_REACH = 1.8;      // how close you stand to unload a pallet
const BAY_REACH = 2.2;         // the loading pad is 2x2, so reach from its middle
const ACTION_TIME = 1.0;       // seconds of standing still before an action fires

/**
 * MOOD.
 *
 * `patience` is a budget, in seconds, and everything wrong with the shop draws
 * on it. Rates below are in budget-per-second and are relative to queueing,
 * which is 1.0 by definition: a shopper who does nothing but queue runs out in
 * exactly `patience` seconds, which is what the old `1 - waited/patience` did.
 * Anchoring on that means the queue timeout keeps the balance it was tuned for
 * and everything else is measured against a number that already felt right.
 */
const ANNOY_IN_SHOP = 0.15;    // being in a shop at all, however good it is
const ANNOY_LINE = 1.0;        // waiting to pay, walking up the line or standing in it
const ANNOY_EMPTY_SHELF = 0.12; // one-off: walked over and somebody took the last one

/** Visibly unhappy below the first, ready to walk out below the second. */
const MOOD_ANNOYED = 0.5;
const MOOD_FUMING = 0.2;
/** Storming out is a stride, not a stroll. */
const STORM_SPEED = 1.6;

/**
 * How cross someone looks, 0..1. Derived here rather than on the client so the
 * renderer and the sim can't drift on what "cross" means — the same mistake
 * `shared/build.js` exists to prevent for the build ghost.
 */
const angerOf = (c) => clamp((MOOD_ANNOYED - c.mood) / (MOOD_ANNOYED - MOOD_FUMING), 0, 1);

/**
 * How long each held action takes. Everything used to cost a flat second, which
 * made turning soil feel identical to picking a tomato up. Destructive things
 * are deliberately slower — a long ring is the confirmation dialog.
 */
const ACTION_TIMES = {
  till: 1.7,
  stow: 0.8,
};

/** Fallback prices for building a fixture when no upgrade grants that kind. */
const FALLBACK_FIXTURE_COST = { shelf: 60, freezer: 260, checkout: 300, plot: 40, station: 200 };

// Where a fixture is counted in the ledger now lives in `shared/pieces.js`,
// because the palette on the client has to look a count up by exactly the same
// name the server files it under — and two spellings of "how many of these do
// I own" is a button that says 0 next to eleven shelves.

/** The appliance names the ledger says you own, expanded one per machine. */
function stationList(fixtures) {
  const out = [];
  for (const [key, n] of Object.entries(fixtures ?? {})) {
    if (!key.startsWith('station:')) continue;
    for (let i = 0; i < n; i++) out.push(key.slice('station:'.length));
  }
  return out;
}

/** Which upgrade payload field grants each countable fixture. */
const FIXTURE_PAYLOAD_KEY = {
  shelf: 'shelves', freezer: 'freezers', checkout: 'checkouts', plot: 'plots',
};

/** What a brand new shop starts with, before any upgrade. */
const BASE_FIXTURES = { shelf: 6, freezer: 0, checkout: 1, plot: 4 };

export class Game {
  constructor(state) {
    Object.assign(this, state);
    this.rng = makeRng(`${this.seed}:${this.day}`);
    this.walk = buildWalkGrid(this.layout);
    // Money waiting on a counter for someone to pick it up.
    this.cashDrops = state.cashDrops ?? [];
    this.nextCashId = state.nextCashId ?? 1;
    // Pallets waiting at the bay to be unloaded.
    this.deliveries = state.deliveries ?? [];
    this.nextDeliveryId = state.nextDeliveryId ?? 1;
    // How many of each fixture the shop owns, and where the player has chosen
    // to put some of them. See `fixtureLedger` for why this is a stored count
    // rather than something recomputed from upgrades every boot.
    this.fixtures = { ...BASE_FIXTURES, ...(state.fixtures ?? {}) };
    this.placements = state.placements ?? [];
    this.nextFixtureId = state.nextFixtureId ?? 1;
    this.grow = state.grow ?? { w: 0, h: 0 };
    this.doorShift = state.doorShift ?? 0;
    // Walls, windows and doorways the player drew, as an overlay on the shell.
    this.edits = state.edits ?? [];
  }

  // -------------------------------------------------------------------------
  // Construction / persistence
  // -------------------------------------------------------------------------

  /**
   * `worldId` names which save slot this game is. It is required rather than
   * defaulted on purpose: a Game that doesn't know which world it is will read
   * one shop and `persist()` over another, and every symptom of that shows up
   * hours later as "my save keeps reverting".
   */
  static create({ worldId, seed, autoServe = false, ephemeral = false } = {}) {
    if (!worldId) throw new Error('Game.create needs a worldId — see server/worlds.js');
    const w = loadWorld(worldId);
    const useSeed = seed ?? w.seed;
    const fixtures = fixtureLedger(w);
    const placements = w.placements ?? [];
    const grow = w.storeGrow ?? { w: 0, h: 0 };
    const doorShift = w.doorShift ?? 0;
    const edits = w.edits ?? [];
    const layout = generateLayout({
      seed: useSeed,
      shelves: fixtures.shelf,
      freezers: fixtures.freezer,
      checkouts: fixtures.checkout,
      plots: fixtures.plot,
      stations: stationList(fixtures),
      placements,
      grow,
      doorShift,
      edits,
    });

    // Derived before the Game is built so the id counter can clear it.
    const roster = w.roster ?? rosterFromUpgrades(w);

    return new Game({
      worldId,
      seed: String(useSeed),
      day: w.day,
      time: OPEN_HOUR / 24,      // 0..1 through the day
      season: w.season,
      cash: w.cash,
      reputation: w.reputation,
      // The last day the director spoke. Saved rather than held in the room,
      // because a guard that only survives a hot reload fires a fresh world
      // event on every cold start — see `runDirector`.
      lastDirectorDay: w.lastDirectorDay ?? null,
      ownedUpgrades: w.ownedUpgrades ?? [],
      // Who actually works here. Derived once from the old staff upgrades for a
      // save that predates the roster, and authoritative from then on.
      roster,
      nextWorkerId: w.nextWorkerId ?? roster.length + 1,
      fixtures,
      placements,
      nextFixtureId: w.nextFixtureId ?? 1,
      grow,
      doorShift,
      edits,
      layout,
      layoutVersion: 1,
      players: {},
      customers: {},
      nextCustomerId: 1,
      spawnAccumulator: 0,
      autoServe,
      ephemeral,
      stats: freshStats(),
      log: [],
      elapsed: 0,
    });
  }

  /** JSON-safe full state — used for devMode room caching and MCP inspection. */
  serialize() {
    return {
      // Which save slot this is. First field for the same reason it is required
      // in `create`: a cached room restored without it would persist into a
      // world named `undefined` and take an hour of play with it.
      worldId: this.worldId,
      seed: this.seed,
      day: this.day,
      time: this.time,
      season: this.season,
      cash: this.cash,
      reputation: this.reputation,
      lastDirectorDay: this.lastDirectorDay ?? null,
      ownedUpgrades: this.ownedUpgrades,
      roster: this.roster,
      nextWorkerId: this.nextWorkerId,
      fixtures: this.fixtures,
      placements: this.placements,
      nextFixtureId: this.nextFixtureId,
      grow: this.grow,
      doorShift: this.doorShift,
      edits: this.edits,
      layout: this.layout,
      layoutVersion: this.layoutVersion,
      players: this.players,
      customers: this.customers,
      nextCustomerId: this.nextCustomerId,
      spawnAccumulator: this.spawnAccumulator,
      autoServe: this.autoServe,
      cashDrops: this.cashDrops,
      nextCashId: this.nextCashId,
      deliveries: this.deliveries,
      nextDeliveryId: this.nextDeliveryId,
      stats: this.stats,
      log: this.log.slice(-40),
      elapsed: this.elapsed,
    };
  }

  static restore(data) {
    return new Game({ ...data, log: data.log ?? [] });
  }

  /**
   * Persist the bits that should survive a full server restart.
   * Ephemeral games (headless balance runs) never write — otherwise calling
   * `simulate()` would quietly overwrite the live shop's save.
   */
  persist() {
    if (this.ephemeral) return;
    saveWorld(this.worldId, {
      seed: this.seed,
      day: this.day,
      cash: this.cash,
      reputation: this.reputation,
      season: this.season,
      lastDirectorDay: this.lastDirectorDay ?? null,
      ownedUpgrades: this.ownedUpgrades,
      roster: this.roster,
      nextWorkerId: this.nextWorkerId,
      // The ledger is authoritative. `plots`/`shelves` are only still written
      // so an older build could still boot this save.
      fixtures: this.fixtures,
      placements: this.placements,
      nextFixtureId: this.nextFixtureId,
      storeGrow: this.grow,
      doorShift: this.doorShift,
      edits: this.edits,
      plots: this.fixtures.plot,
      shelves: this.fixtures.shelf,
    });
  }

  /**
   * Back to day one on the money, without touching the shop you built.
   *
   * Upgrades, staff, fixtures, placements, walls and shelf stock all stay —
   * this resets what a run *earned*, not what it owns. (The full wipe is
   * `npm run reset:economy -- --all`, offline: tearing the roster and the
   * fixture ledger out from under a live room is a different operation, and
   * one nobody should trigger while four other people are playing.)
   *
   * Money in flight goes with it. Cash on the floor and customers holding
   * baskets were earned under the old prices, and a shopper left mid-aisle
   * would pay day-27 money into a day-1 till. Their till queues are emptied in
   * the same pass — a queue holds customer *ids*, so dropping the customers
   * without the queues strands ids that `serve` would then look up and miss.
   */
  resetEconomy() {
    const before = { day: this.day, cash: round2(this.cash) };

    Object.assign(this, freshEconomy());
    this.lastDirectorDay = null;
    this.stats = freshStats();
    this.rng = makeRng(`${this.seed}:${this.day}`);

    const customers = Object.keys(this.customers).length;
    this.customers = {};
    this.nextCustomerId = 1;
    this.spawnAccumulator = 0;
    for (const till of this.layout.checkouts) till.queue = [];
    this.cashDrops = [];
    this.nextCashId = 1;

    const cleared = clearModifiers(undefined, this.worldId);
    this.invalidateModifiers();
    this.persist();
    this.pushLog(`Economy reset: day ${before.day} → 1, $${before.cash.toFixed(2)} → $${this.cash.toFixed(2)}.`);

    return ok({
      day: this.day, cash: round2(this.cash), season: this.season, reputation: this.reputation,
      clearedModifiers: cleared, sentHome: customers,
      kept: {
        upgrades: this.ownedUpgrades.length,
        staff: this.roster.length,
        placements: this.placements.length,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Dynamic snapshot — what actually goes over the wire each tick.
  // The layout is big and changes rarely, so it's sent separately.
  // -------------------------------------------------------------------------

  snapshot() {
    return {
      day: this.day,
      time: this.time,
      season: this.season,
      cash: round2(this.cash),
      reputation: round2(this.reputation),
      isOpen: this.isOpen(),
      layoutVersion: this.layoutVersion,
      stats: this.stats,
      // The upgrades panel needs this to grey out what you already own, and
      // build mode needs the ledger to price the palette.
      ownedUpgrades: this.ownedUpgrades,
      roster: this.roster,
      fixtures: this.fixtures,
      players: Object.values(this.players).map((p) => ({
        id: p.id, name: p.name, x: r2(p.x), z: r2(p.z), facing: r2(p.facing),
        carry: p.carry, color: p.color, staff: p.staff ?? null,
        // Which roster row this body belongs to, and which rung it is on. The
        // roster says who works here and this says what they are up to; without
        // a key the UI can only join them by reconstructing `staff-${id}`,
        // which makes an id format a protocol.
        hire: p.hire ?? null,
        tier: p.tier ?? null,
        // How worn out they are, and what they are doing about it. Both are
        // read straight off the body, so the roster says the same thing you
        // can watch happening on the floor.
        energy: p.energy ?? null,
        pastime: p.pastime ?? null,
        // ...and how far through it they are, which is what flips the stages of
        // the pastime's authored model. Sent rather than worked out on the
        // client, because the client can see the break but not the clock the
        // deadline was set against.
        breakProgress: p.pastime ? r2(breakProgress(p, this.elapsed)) : null,
        // What a hire is doing right now. Staff never set `action` — that is
        // the armed-action field a human's held button drives — so without this
        // the roster can only ever say "idle" about someone halfway up a field.
        job: p.job ?? null,
        selectedCrop: p.selectedCrop ?? null,
        build: p.build?.on ? (p.build.tool ?? null) : null,
        holding: p.holding ?? null,
        // Sent whenever an action is *available*, not just while it's running,
        // so the client can light the target up and say what holding would do.
        action: p.action
          ? {
            kind: p.action.kind,
            target: p.action.target,
            label: p.action.label,
            at: p.action.at ? { x: r2(p.action.at.x), z: r2(p.action.at.z) } : null,
            progress: r2(Math.min(1, p.action.elapsed / (p.action.time || ACTION_TIME))),
            holding: !!p.holdInput,
          }
          : null,
        // Standing at a turned-over plot with no seed chosen pops the picker.
        atBarePlot: this.barePlotNear(p)?.id ?? null,
      })),
      customers: Object.values(this.customers).map((c) => ({
        id: c.id, x: r2(c.x), z: r2(c.z), facing: r2(c.facing),
        color: c.color, state: c.state, basket: c.basket.length,
        mood: r2(c.mood), anger: r2(angerOf(c)), want: c.wantHint ?? null,
      })),
      shelves: this.layout.shelves.map((s) => ({
        id: s.id, item_id: s.item_id, qty: s.qty, price: r2(s.price), kind: s.kind,
      })),
      plots: this.layout.plots.map((p) => ({
        id: p.id, crop_id: p.crop_id, growth: r2(this.plotGrowth(p)), ready: p.ready,
        soil: p.soil ?? 'untilled',
        // How many plants the bed is carrying, so the renderer draws exactly
        // what harvesting will hand over.
        yield: p.yield ?? 0,
      })),
      queues: this.layout.checkouts.map((c) => ({ id: c.id, queue: c.queue?.length ?? 0 })),
      cashDrops: this.cashDrops.map((d) => ({
        id: d.id, x: r2(d.x), z: r2(d.z), amount: d.amount,
      })),
      deliveries: this.deliveries.map((d) => ({
        id: d.id, x: r2(d.x), z: r2(d.z), item_id: d.item_id, qty: d.qty,
      })),
      stations: (this.layout.stations ?? []).map((s) => ({
        id: s.id, x: s.x, z: s.z, station: s.station,
        contents: s.contents, making: s.making, output: s.output,
        progress: s.making
          ? r2(Math.min(1, 1 - (s.busyUntil - this.elapsed) / Math.max(0.001, s.busyUntil - (s.startedAt ?? s.busyUntil - 1))))
          : 0,
      })),
      // Folded to one net number per tag — the HUD draws a meter off these, and
      // it should be reading the same numbers the economy charges against.
      modifiers: modifierMeter(this.folded()),
      log: this.log.slice(-8),
    };
  }

  // -------------------------------------------------------------------------
  // Clock
  // -------------------------------------------------------------------------

  isOpen() {
    const h = this.time * 24;
    return h >= OPEN_HOUR && h < CLOSE_HOUR;
  }

  hour() { return this.time * 24; }

  currentModifiers() {
    if (!this._modCache || this._modCacheDay !== this.day) {
      this._modCache = activeModifiers(this.day, this.worldId);
      this._modCacheDay = this.day;
    }
    return this._modCache;
  }

  /** Force a modifier reload (called after the director writes new ones). */
  invalidateModifiers() { this._modCacheDay = -1; }

  folded() { return foldModifiers(this.currentModifiers()); }

  // -------------------------------------------------------------------------
  // Main tick
  // -------------------------------------------------------------------------

  step(dt) {
    this.elapsed += dt;
    const prevDay = this.day;

    this.time += dt / DAY_SECONDS;
    while (this.time >= 1) {
      this.time -= 1;
      this.day++;
    }
    if (this.day !== prevDay) this.onNewDay();

    const c = content();
    const folded = this.folded();

    this.stepPlayers(dt);
    this.stepCrops(c);
    this.stepCustomers(dt, c, folded);
    this.stepSpawning(dt, c, folded);
    stepStaff(this, dt);
    this.stepCashPickup();
    this.stepStations(dt);
    this.stepActions(dt);
  }

  onNewDay() {
    // Cash left on the counter overnight gets banked rather than vanishing —
    // an unattended till should look untidy, not quietly delete your takings.
    if (this.cashDrops.length) {
      const swept = round2(this.cashDrops.reduce((s, d) => s + d.amount, 0));
      this.cash += swept;
      this.stats.revenue += swept;
      this.cashDrops = [];
      this.pushLog(`Cashed up $${swept.toFixed(2)} left on the counter.`);
    }
    this.season = SEASONS[Math.floor((this.day - 1) / 7) % SEASONS.length];
    pruneModifiers(this.day, this.worldId);
    this.invalidateModifiers();
    this.spoilStock();
    this.payWages();
    this.persist();
    this.rng = makeRng(`${this.seed}:${this.day}`);
    this.pushLog(`Day ${this.day} — ${this.season}. Yesterday: $${this.stats.revenue.toFixed(2)} in, ${this.stats.sold} sold, ${this.stats.abandoned} walked out.`);
    // Hand the finished day to whoever is watching (the balance runner reads
    // this, since `stats` is about to be wiped for the new day).
    this._lastDayStats = this.stats;
    this.stats = freshStats();
  }

  /**
   * Everybody gets paid, whether or not the shop can cover it.
   *
   * A hire used to be a one-off cost with unlimited upside, so taking on every
   * worker the moment you could afford one was strictly correct and there was
   * no ongoing decision at all. A daily wage makes each one a bet — and gives a
   * shop that over-hires a way to go under, because cash is allowed to go
   * negative and that is already exactly what `simulate` reads as bankrupt.
   *
   * Nobody walks out over it. Staff leaving in the night would be a second
   * mechanic firing on a number the player cannot see coming, and the ledger
   * going red says the same thing where they can act on it.
   *
   * The wage lives on the kind and is scaled by the rung, so a promotion is a
   * raise as well as an upgrade. It is charged against the day that has just
   * ended, which is the day they worked — `this.stats` is not rolled over until
   * the bottom of `onNewDay`.
   */
  payWages() {
    const kinds = content().byId.workers;
    let total = 0;
    for (const entry of this.roster) {
      const kind = kinds[entry.kind];
      // Their kind was deleted, so nobody turned up and there is nothing to pay
      // for. Charging for a worker who cannot exist is a bill with no worker.
      if (!kind) continue;
      const rungs = kind.tiers ?? [];
      const rung = rungs[Math.min(Math.max(1, Math.trunc(entry.tier ?? 1)), rungs.length) - 1];
      total += (kind.wage ?? 0) * (rung?.wage_mult ?? 1);
    }
    if (total <= 0) return;

    total = round2(total);
    this.cash = round2(this.cash - total);
    this.stats.spent += total;
    this.pushLog(this.cash < 0
      ? `Paid $${total.toFixed(2)} in wages — the shop is now in the red.`
      : `Paid $${total.toFixed(2)} in wages.`);
  }

  /** Perishables rot on the shelf if they sit too long. */
  spoilStock() {
    const items = content().byId.items;
    for (const shelf of this.layout.shelves) {
      if (!shelf.item_id || shelf.qty <= 0) continue;
      const item = items[shelf.item_id];
      if (!item) continue;
      const rate = spoilRate(item);
      if (rate <= 0) continue;
      // Freezers dramatically slow decay, and a better one slows it further —
      // `keeps_mult` is the tier's contribution on top of that.
      const effLife = item.shelf_life_days
        * (shelf.kind === 'freezer' ? 4 : 1)
        * this.fixtureStats(shelf).keeps_mult;
      const age = this.day - shelf.stockedDay;
      if (age > effLife) {
        const lost = shelf.qty;
        shelf.qty = 0;
        shelf.item_id = null;
        this.stats.spoiled += lost;
        this.pushLog(`${lost}x ${item.name} spoiled and was binned.`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Players
  // -------------------------------------------------------------------------

  stepPlayers(dt) {
    for (const p of Object.values(this.players)) {
      if (!p.input) continue;
      const { dx, dz } = p.input;
      if (dx === 0 && dz === 0) continue;
      // Moving is what clears the "don't pick that straight back up" lock.
      p.stowLock = false;

      const len = Math.hypot(dx, dz) || 1;
      // A drag-joystick sends a partial vector for a small nudge, so honour the
      // magnitude instead of snapping everyone to full sprint. Keys send a unit
      // vector and are unaffected.
      const throttle = Math.min(1, len);
      const speed = PLAYER_SPEED * this.speedMult() * throttle;
      const nx = p.x + (dx / len) * speed * dt;
      const nz = p.z + (dz / len) * speed * dt;

      // Axis-separated so sliding along a wall feels right instead of sticking.
      // Which is also exactly the shape edge walls want: each axis crosses at
      // most one boundary, so "may I be there" and "may I get there" are one
      // check per axis rather than a swept volume.
      if (this.canWalk(p.x, p.z, nx, p.z)) p.x = nx;
      if (this.canWalk(p.x, p.z, p.x, nz)) p.z = nz;
      p.facing = Math.atan2(dx, dz);
    }
  }

  // -------------------------------------------------------------------------
  // Held actions
  //
  // Standing next to something works out *what* you'd do; holding the button
  // is what actually does it. Proximity alone used to fire things at you —
  // walk past a ripe plot and you'd harvest it whether you meant to or not,
  // and the only way to say no was to keep walking.
  //
  // So: being in range arms an action and lights the thing up, and you press
  // and hold to commit. Same charge-up, same ring, same "let go and nothing
  // happened" — it just needs your consent now.
  // -------------------------------------------------------------------------

  /** Press and hold. Releasing — or walking off — abandons the charge. */
  setHold(playerId, on) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    p.holdInput = !!on;
    if (!on && p.action) p.action.elapsed = 0;
    return ok({ holding: p.holdInput });
  }

  stepActions(dt) {
    for (const p of Object.values(this.players)) {
      if (p.staff) continue;              // hires drive themselves

      const candidate = this.actionFor(p);

      // Nothing in range, or the target changed out from under us.
      if (!candidate) { p.action = null; continue; }
      if (!p.action || p.action.kind !== candidate.kind || p.action.target !== candidate.target) {
        // Armed but not started. It still goes in the snapshot, because the
        // client has to be able to highlight the thing and say what holding
        // would do — an action you can't see coming is worse than a keybind.
        p.action = { ...candidate, elapsed: 0 };
      }

      if (!p.holdInput) { p.action.elapsed = 0; continue; }

      p.action.elapsed += dt;
      if (p.action.elapsed < (p.action.time || ACTION_TIME)) continue;

      const res = candidate.run();
      p.action = null;
      // A failed attempt shouldn't instantly retry in a loop — let them move.
      if (!res?.ok) p.actionBlocked = res?.error ?? null;
      else p.actionBlocked = null;
    }
  }

  /**
   * The single thing standing here would do, or null. Ordered by what's most
   * valuable so a player near both a till and a shelf takes the money first.
   */
  actionFor(p) {
    // In build mode the normal jobs are suspended entirely, and nothing takes
    // their place: every build action is aimed with the pointer and chosen from
    // that fixture's own menu.
    //
    // Proximity used to arm one here, and it could not work. It picked the
    // nearest fixture *centre* within reach, so in an aisle of shelves on a
    // three-tile pitch two or three were always candidates at once and you got
    // whichever happened to be closest — with no way to say which one you meant.
    // Aiming is the fix, and once you are aiming there is nothing left for
    // proximity to decide.
    if (p.build?.on) return null;

    const till = this.nearest(this.layout.checkouts, p, 2.2);
    if (till?.queue?.length
        && till.queue.some((id) => this.customers[id]?.state === 'QUEUE')) {
      return { kind: 'serve', target: till.id, label: 'Serve', at: till, run: () => this.serve(p.id, till.id) };
    }

    // At the bay: take goods off a pallet, or put down what you're holding.
    // These are two halves of one spot, so which you get depends on whether
    // your hands are free.
    //
    // `stowLock` is why this isn't just an if/else. Both actions re-arm the
    // moment they finish, so putting an armful down next to a crate of the same
    // thing would pick it straight back up, put it down, pick it back up —
    // forever. Stowing therefore locks pickup until you actually walk somewhere,
    // which is the same "move to cancel" rule the rest of the ring already uses.
    const pallet = this.nearest(this.deliveries, p, UNLOAD_REACH);
    const canTake = pallet && !p.stowLock
      && (!p.carry || (p.carry.item_id === pallet.item_id && p.carry.qty < this.carryCapacity()));
    if (canTake) {
      return { kind: 'unload', target: pallet.id, label: 'Unload', at: pallet, run: () => this.unload(p.id, pallet.id) };
    }
    if (p.carry && near(p, this.layout.bay, BAY_REACH)) {
      return {
        kind: 'stow', target: 'bay', label: 'Put back', time: ACTION_TIMES.stow, at: this.layout.bay,
        run: () => this.stow(p.id),
      };
    }

    const station = this.nearest(this.layout.stations ?? [], p, REACH, (o) => o.useAt);
    if (station) {
      if (station.output && (!p.carry || p.carry.item_id === station.output.item_id)) {
        return { kind: 'collect', target: station.id, label: 'Collect', at: station, run: () => this.collectStation(p.id, station.id) };
      }
      if (p.carry && this.stationWants(station, p.carry.item_id)) {
        return { kind: 'load', target: station.id, label: 'Load', at: station, run: () => this.loadStation(p.id, station.id) };
      }
    }

    if (p.carry) {
      const shelf = this.nearest(this.layout.shelves, p, REACH, (s) => s.browseAt);
      if (shelf && this.shelfAccepts(shelf, p.carry.item_id)) {
        return { kind: 'stock', target: shelf.id, label: 'Stock', at: shelf, run: () => this.stockShelf(p.id, shelf.id) };
      }
    }

    const plot = this.nearest(this.layout.plots, p, REACH);
    if (plot) {
      if (plot.ready && (!p.carry || p.carry.item_id === content().byId.crops[plot.crop_id]?.item_id)) {
        return { kind: 'harvest', target: plot.id, label: 'Harvest', at: plot, run: () => this.harvest(p.id, plot.id) };
      }
      // Seed goes into broken soil, never into turf. Harvesting exhausts a plot
      // back to untilled, so a field has a rhythm: turn it, sow it, pick it.
      if (!plot.crop_id && plot.soil !== 'tilled') {
        return {
          kind: 'till', target: plot.id, label: 'Till the soil', time: ACTION_TIMES.till, at: plot,
          run: () => this.till(p.id, plot.id),
        };
      }
      if (!plot.crop_id && p.selectedCrop) {
        const crop = content().byId.crops[p.selectedCrop];
        const inSeason = !crop?.seasons?.length || crop.seasons.includes(this.season);
        if (crop && inSeason && this.cash >= crop.seed_cost) {
          return {
            kind: 'plant', target: plot.id, label: `Plant ${crop.name}`, at: plot,
            run: () => this.plant(p.id, plot.id, p.selectedCrop),
          };
        }
      }
    }
    return null;
  }

  /** The plot this player could sow right now, if any. */
  barePlotNear(p) {
    const plot = this.nearest(this.layout.plots, p, REACH);
    return plot && !plot.crop_id && plot.soil === 'tilled' ? plot : null;
  }

  /** Would this shelf take that item right now? */
  shelfAccepts(shelf, itemId) {
    const item = content().byId.items[itemId];
    if (!item) return false;
    if (requiredFixture(item) === 'freezer' && shelf.kind !== 'freezer') return false;
    if (shelf.item_id && shelf.qty > 0 && shelf.item_id !== itemId) return false;
    return shelf.qty < this.shelfCapacity(shelf, item);
  }

  /**
   * How many units of an item this particular shelf holds. The item says how
   * big a stack of it is; the shelf's tier says how much shelving there is to
   * stack it on.
   */
  shelfCapacity(shelf, item) {
    return Math.max(1, Math.floor(item.stack * this.fixtureStats(shelf).capacity_mult));
  }

  stationWants(station, itemId) {
    return this.recipesFor(station.station)
      .some((r) => r.inputs.some((i) => i.item_id === itemId));
  }

  /**
   * May somebody move from one point to another?
   *
   * Two questions, and a wall on a boundary is why they came apart: the
   * destination has to be standable, *and* nothing solid may sit on the line
   * crossed to reach it. A tile check alone would let you walk through any
   * wall, because with edges the tiles either side of one are both plain floor.
   *
   * The destination is probed a body-radius ahead rather than at the centre, or
   * you would stop with the wall running through your middle — a tile-thick
   * wall used to hide that, a 0.17-thick one would not.
   */
  canWalk(fromX, fromZ, toX, toZ) {
    if (!this.canStand(toX, toZ)) return false;
    const ax = Math.round(fromX);
    const az = Math.round(fromZ);
    const bx = Math.round(toX + Math.sign(toX - fromX) * PLAYER_RADIUS);
    const bz = Math.round(toZ + Math.sign(toZ - fromZ) * PLAYER_RADIUS);
    if (ax === bx && az === bz) return true;
    return !SOLID.has(edgeBetween(this.layout, ax, az, bx, bz));
  }

  canStand(x, z) {
    const tx = Math.round(x);
    const tz = Math.round(z);
    if (tx < 0 || tz < 0 || tx >= this.layout.w || tz >= this.layout.h) return false;
    return this.walk[tz * this.layout.w + tx] === 1;
  }

  speedMult() {
    return this.ownedUpgrades.includes('boots-1') ? 1.3 : 1;
  }

  carryCapacity() {
    const base = 6;
    const bonus = content().upgrades
      .filter((u) => u.kind === 'capacity' && this.ownedUpgrades.includes(u.id))
      .reduce((s, u) => s + (u.payload.carry ?? 0), 0);
    return base + bonus;
  }

  addPlayer(id, name) {
    const spawn = this.layout.spawn;
    const colors = ['#5b8ff9', '#f2a03d', '#7cc46a', '#c98ad9'];
    // Hired staff share `this.players`, so count only the humans — otherwise
    // hiring a clerk renames and recolours the next person who joins.
    const humans = Object.values(this.players).filter((p) => !p.staff).length;
    this.players[id] = {
      id,
      name: name || `Player ${humans + 1}`,
      x: spawn.x + (humans % 2 === 0 ? -1 : 1),
      z: spawn.z - 1,
      facing: 0,
      color: colors[humans % colors.length],
      carry: null,
      input: { dx: 0, dz: 0 },
    };
    this.pushLog(`${this.players[id].name} clocked in.`);
    return this.players[id];
  }

  removePlayer(id) {
    delete this.players[id];
  }

  setInput(id, dx, dz) {
    const p = this.players[id];
    if (!p) return;
    p.input = { dx: clamp(dx, -1, 1), dz: clamp(dz, -1, 1) };
  }

  /** Which seed this player plants when they stand on a bare plot. */
  selectCrop(id, cropId) {
    const p = this.players[id];
    if (!p) return err('no such player');
    if (cropId && !content().byId.crops[cropId]) return err('no such crop');
    p.selectedCrop = cropId ?? null;
    return ok({ selectedCrop: p.selectedCrop });
  }

  // -------------------------------------------------------------------------
  // Crops
  // -------------------------------------------------------------------------

  plotGrowth(plot) {
    if (!plot.crop_id) return 0;
    const crop = content().byId.crops[plot.crop_id];
    if (!crop) return 0;
    const elapsedMin = ((this.elapsed - plot.plantedAt) / 60) * this.fixtureStats(plot).speed_mult;
    return clamp(elapsedMin / crop.grow_minutes, 0, 1);
  }

  stepCrops() {
    for (const plot of this.layout.plots) {
      if (plot.crop_id && !plot.ready && this.plotGrowth(plot) >= 1) {
        plot.ready = true;
      }
    }
  }

  /**
   * Turn the soil so it will take a seed.
   *
   * Free, but it costs time, and harvesting exhausts the plot back to untilled.
   * That's the whole point: farming used to be a single button, and a field
   * where every plot is one action deep has no rhythm to it.
   */
  till(playerId, plotId) {
    const p = this.players[playerId];
    const plot = this.layout.plots.find((x) => x.id === plotId);
    if (!p || !plot) return err('no such plot');
    if (!near(p, plot)) return err('too far from that plot');
    if (plot.crop_id) return err('something is already growing there');
    if (plot.soil === 'tilled') return err('that soil is already turned');

    plot.soil = 'tilled';
    this.stats.tilled++;
    return ok({ tilled: plot.id });
  }

  plant(playerId, plotId, cropId) {
    const p = this.players[playerId];
    const plot = this.layout.plots.find((x) => x.id === plotId);
    const crop = content().byId.crops[cropId];
    if (!p || !plot || !crop) return err('no such plot or crop');
    if (!near(p, plot)) return err('too far from that plot');
    if (plot.crop_id) return err('that plot is already planted');
    if (plot.soil !== 'tilled') return err('turn the soil over first');
    if (this.cash < crop.seed_cost) return err(`need $${crop.seed_cost.toFixed(2)} for seed`);
    if (crop.seasons.length && !crop.seasons.includes(this.season)) {
      return err(`${crop.name} won't grow in ${this.season}`);
    }

    this.cash -= crop.seed_cost;
    this.stats.spent += crop.seed_cost;
    this.sowInto(plot, crop);
    return ok({ planted: cropId, yield: plot.yield });
  }

  /**
   * Sow a plot straight from its own menu.
   *
   * The walk-up loop is untouched: hold to till, hold to plant, and that is
   * still how farming feels with your hands. This is the menu half of the same
   * job, and it does the *whole* job — turns rough soil over, charges for the
   * seed, and replaces whatever was in there. Picking a crop and then being
   * told to go and plant it again is the annoyance this exists to delete.
   *
   * No proximity check, deliberately: every other action a fixture's own menu
   * offers — move it, empty it, sell it back — already reaches across the shop,
   * and a seed picker that worked only while stood on the bed would be the odd
   * one out.
   */
  sow(playerId, plotId, cropId) {
    const p = this.players[playerId];
    const plot = this.layout.plots.find((x) => x.id === plotId);
    const crop = content().byId.crops[cropId];
    if (!p || !plot || !crop) return err('no such plot or crop');
    if (crop.seasons.length && !crop.seasons.includes(this.season)) {
      return err(`${crop.name} won't grow in ${this.season}`);
    }
    // Ripe is worth money. Losing it to a mis-tap on a list of seeds is not a
    // trade anyone meant to make, and harvesting first costs one hold.
    if (plot.ready) return err('that is ready to pick — harvest it first');
    if (plot.crop_id === cropId) return err(`${crop.name} is already coming up there`);
    if (this.cash < crop.seed_cost) return err(`need $${crop.seed_cost.toFixed(2)} for seed`);

    const replaced = plot.crop_id ? content().byId.crops[plot.crop_id]?.name : null;
    this.cash -= crop.seed_cost;
    this.stats.spent += crop.seed_cost;
    if (plot.soil !== 'tilled') {
      plot.soil = 'tilled';
      this.stats.tilled++;
    }
    this.sowInto(plot, crop);
    // Choosing it here is choosing it, so the next bed you walk up to agrees.
    p.selectedCrop = cropId;
    this.pushLog(replaced
      ? `Turned ${plot.id} over from ${replaced} to ${crop.name}.`
      : `Sowed ${crop.name} in ${plot.id}.`);
    return ok({ sown: cropId, plot: plot.id });
  }

  // ---- who works here ---------------------------------------------------
  //
  // A hire is a row in `roster`, not an upgrade you own. That is what lets you
  // take on two stockers, let one go, and give one of them a different job list
  // from the other — none of which "you own upgrade staff-stocker" can say.

  /** Take someone on. `kindId` is a row in the workers content table. */
  hire(kindId) {
    const w = content().byId.workers[kindId];
    if (!w) return err('no such kind of worker');
    if (this.cash < w.cost) return err(`need $${w.cost.toFixed(2)} to take them on`);

    this.cash -= w.cost;
    this.stats.spent += w.cost;
    const id = `w${this.nextWorkerId++}`;
    // Two clerks are two people, so the second one has to be tellable apart.
    const sameKind = this.roster.filter((e) => e.kind === kindId).length;
    const name = sameKind ? `${w.name} ${sameKind + 1}` : w.name;
    this.roster.push({
      id,
      kind: kindId,
      tier: 1,
      name,
      // Copied, not referenced: the kind is the default, and this hire's list
      // is theirs to change from here on.
      jobs: w.jobs.map((j) => ({ job: j.job, weight: j.weight })),
    });
    this.pushLog(`${name} started their shift.`);
    this.persist();
    return ok({ hired: id, name });
  }

  /** Let someone go. Anything in their hands is left in a crate, not deleted. */
  fire(workerId) {
    const i = this.roster.findIndex((e) => e.id === workerId);
    if (i < 0) return err('nobody by that name works here');
    const [gone] = this.roster.splice(i, 1);

    const body = this.players[`staff-${gone.id}`];
    if (body?.carry) {
      this.dropGoods(body.carry.item_id, body.carry.qty, this.layout.bay);
      body.carry = null;
    }
    delete this.players[`staff-${gone.id}`];
    this.pushLog(`${gone.name} finished up for the last time.`);
    this.persist();
    return ok({ fired: workerId });
  }

  /**
   * Change what one hire does, and how much of each.
   *
   * The whole point of the roster: two people of the same kind can be told to
   * do different things. Validated against the job vocabulary, because a job
   * name nothing implements is a worker standing still.
   */
  assignJobs(workerId, jobs) {
    const entry = this.roster.find((e) => e.id === workerId);
    if (!entry) return err('nobody by that name works here');
    if (!Array.isArray(jobs) || !jobs.length) return err('give them at least one job');

    const clean = [];
    for (const j of jobs) {
      if (!JOBS.includes(j?.job)) return err(`"${j?.job}" is not a job`);
      const weight = Number(j.weight);
      if (!Number.isFinite(weight) || weight <= 0) return err('a weight has to be a positive number');
      clean.push({ job: j.job, weight: Math.min(100, Math.max(0.1, weight)) });
    }
    entry.jobs = clean;
    this.persist();
    return ok({ jobs: clean });
  }

  /**
   * Pay to move someone up their kind's ladder.
   *
   * The rungs are authored on the kind, exactly as a fixture's are, and both
   * halves of what a rung means are read back off it every tick — the stats in
   * `staff.js`, the art in the renderer. So a promotion is one number changing
   * in the roster, and getting faster and looking different both follow from
   * it rather than needing their own bookkeeping.
   */
  promote(workerId) {
    const entry = this.roster.find((e) => e.id === workerId);
    if (!entry) return err('nobody by that name works here');
    const kind = content().byId.workers[entry.kind];
    if (!kind) return err('their kind no longer exists');

    const at = Math.max(1, Math.trunc(entry.tier ?? 1));
    const next = kind.tiers?.[at];
    if (!next) return err('they are already as good as they get');
    if (this.cash < next.cost) return err(`need $${next.cost.toFixed(2)} to promote them`);

    this.cash -= next.cost;
    this.stats.spent += next.cost;
    entry.tier = at + 1;
    this.pushLog(`${entry.name} is now ${next.name}.`);
    this.persist();
    return ok({ promoted: workerId, tier: entry.tier });
  }

  harvest(playerId, plotId) {
    const p = this.players[playerId];
    const plot = this.layout.plots.find((x) => x.id === plotId);
    if (!p || !plot) return err('no such plot');
    if (!near(p, plot)) return err('too far from that plot');
    if (!plot.ready) return err('not ready yet');

    const crop = content().byId.crops[plot.crop_id];
    if (!crop) return err('that crop no longer exists');

    // Decided when it was sown, not now: the bed has been drawing this many
    // plants the whole time it grew, and picking has to hand over what it
    // showed. A plot from before yields were stored has none, so roll one.
    const yieldQty = plot.yield || this.rng.int(crop.yield_min, crop.yield_max);
    const cap = this.carryCapacity();

    if (p.carry && p.carry.item_id !== crop.item_id) {
      return err(`hands full of ${p.carry.item_id} — stock it first`);
    }
    const have = p.carry?.qty ?? 0;
    const taken = Math.min(yieldQty, cap - have);
    if (taken <= 0) return err('hands full');

    p.carry = { item_id: crop.item_id, qty: have + taken };
    this.stats.harvested += taken;

    // The same crop goes straight back into the bed you just picked it from.
    //
    // Picking used to exhaust the plot to untilled every time, so a field you
    // had already set up cost you a till and a sow before it did anything
    // again. That reads as busywork, not rhythm — you had already said what
    // you wanted growing there.
    //
    // Note this re-arms nothing: the plot now holds an unripe crop, so
    // `actionFor` returns null for it and a held button stops here. The old
    // path was the one that looped, cycling till → plant under a held finger.
    // What goes back in is the seed you have *selected*, which is normally the
    // one you just picked — that is why it was selected. If you have since
    // chosen something else, you get that instead.
    //
    // Replanting the harvested crop regardless looks equivalent and is not:
    // it charges for a seed you were about to replace, so every switch costs
    // two. Measured over 60 days that alone was a third of all profit, and it
    // is money the player never agreed to spend.
    const wanted = content().byId.crops[p.selectedCrop] ?? crop;
    const again = this.replantable(wanted);
    if (again.ok) {
      this.cash -= wanted.seed_cost;
      this.stats.spent += wanted.seed_cost;
      // The turned soil stays turned — that is the busywork this removes — and
      // the new planting rolls its own yield, so the bed immediately shows what
      // this next crop is worth rather than inheriting the last one's number.
      this.sowInto(plot, wanted);
      return ok({
        item_id: crop.item_id, qty: taken, dropped: yieldQty - taken,
        replanted: wanted.id, yield: plot.yield,
      });
    }

    // Can't re-sow it, so the old exhaust rule stands: you get the bare bed
    // back and turn it over yourself. `why` travels up so the client can say
    // which of the two it was, instead of the field just going quiet.
    this.clearPlot(plot);
    return ok({
      item_id: crop.item_id, qty: taken, dropped: yieldQty - taken, replanted: null, why: again.why,
    });
  }

  /**
   * Put a crop in the ground, and decide there and then how much it will give.
   *
   * The yield used to be rolled at harvest, which meant the bed could not show
   * you what was in it — the number did not exist until you pulled it up. Now
   * a plot growing three lettuces draws three lettuces, and picking it hands
   * you those three. What you see is the promise, not a guess at it.
   *
   * Every planting route goes through here on purpose. A site that set
   * `crop_id` by hand would grow a bed with no yield on it, and the renderer
   * would quietly fall back to drawing one plant while harvest handed over a
   * different number — which is precisely the mismatch this removes.
   */
  sowInto(plot, crop) {
    plot.crop_id = crop.id;
    plot.plantedAt = this.elapsed;
    plot.ready = false;
    plot.yield = this.rng.int(crop.yield_min, crop.yield_max);
    return plot.yield;
  }

  /** Empty the bed out. The counterpart to `sowInto`, so no field is missed. */
  clearPlot(plot, { soil = 'untilled' } = {}) {
    plot.crop_id = null;
    plot.ready = false;
    plot.plantedAt = 0;
    plot.yield = 0;
    plot.soil = soil;
  }

  /**
   * Will the bed take this seed again the moment it's picked?
   *
   * Deliberately the same two gates `plant` applies — season and money — and
   * nothing else. Skipping the proximity and soil checks is the point: you are
   * stood on the plot, and it is already turned.
   */
  replantable(crop) {
    if (crop.seasons.length && !crop.seasons.includes(this.season)) {
      return { ok: false, why: `${crop.name} won't grow in ${this.season}` };
    }
    if (this.cash < crop.seed_cost) {
      return { ok: false, why: `need $${crop.seed_cost.toFixed(2)} for seed` };
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Shelves & stock
  // -------------------------------------------------------------------------

  /**
   * Order stock from the supplier.
   *
   * It arrives as a pallet at the delivery bay that somebody has to walk out
   * and unload — ordering used to teleport goods into your hands, which made
   * the supplier a vending machine and the shop floor irrelevant. Headless
   * balance runs skip the walk so `simulate()` keeps measuring the economy
   * rather than the pathfinding.
   */
  buyStock(playerId, itemId, qty) {
    const p = this.players[playerId];
    const item = content().byId.items[itemId];
    if (!p || !item) return err('no such item');

    // Anything a recipe produces has to be made, not ordered. Without this the
    // supplier sells the finished product too and the appliances are pointless.
    if (this.isCrafted(itemId)) {
      return err(`${item.name} has to be made in an appliance, not ordered`);
    }

    if (this.autoServe) {
      const cap = this.carryCapacity();
      if (p.carry && p.carry.item_id !== itemId) return err('hands full of something else');
      const have = p.carry?.qty ?? 0;
      const take = Math.min(qty, cap - have);
      if (take <= 0) return err('hands full');

      const unit = wholesalePrice(item, this.folded(), this.season);
      const cost = unit * take;
      if (this.cash < cost) return err(`need $${cost.toFixed(2)}, you have $${this.cash.toFixed(2)}`);

      this.cash -= cost;
      this.stats.spent += cost;
      p.carry = { item_id: itemId, qty: have + take };
      return ok({ bought: take, cost: round2(cost) });
    }

    const take = Math.min(qty, item.stack);
    if (take <= 0) return err('order at least one');

    const unit = wholesalePrice(item, this.folded(), this.season);
    const cost = unit * take;
    if (this.cash < cost) return err(`need $${cost.toFixed(2)}, you have $${this.cash.toFixed(2)}`);

    this.cash -= cost;
    this.stats.spent += cost;

    this.dropGoods(itemId, take, this.layout.bay);
    this.pushLog(`${take}x ${item.name} delivered — unload it at the bay.`);
    return ok({ ordered: take, cost: round2(cost), delivery: true });
  }

  /**
   * Put goods down somewhere as a crate on the floor.
   *
   * A pallet is the game's one and only "goods that aren't in anyone's hands"
   * object, so everything that needs to let go of stock funnels through here:
   * a delivery arriving, a player clearing their hands at the bay, a stripped
   * shelf, an emptied hopper. That means all of it renders, all of it can be
   * picked back up, and the stocker tidies all of it away for free — because
   * unloading pallets is already the first thing on their list.
   */
  dropGoods(itemId, qty, at) {
    if (!(qty > 0)) return null;
    // Merge into a crate of the same thing already sitting here rather than
    // building a little forest of one-unit pallets.
    const existing = this.deliveries.find((d) => d.item_id === itemId
      && Math.hypot(d.x - at.x, d.z - at.z) <= 2.2);
    if (existing) {
      existing.qty += qty;
      return existing;
    }
    const n = this.nextDeliveryId++;
    const spread = [[0, 0], [0.9, 0], [0, 0.9], [0.9, 0.9], [-0.9, 0.45]][n % 5];
    const del = {
      id: `del-${n}`,
      item_id: itemId,
      qty,
      x: r2(at.x + spread[0]),
      z: r2(at.z + spread[1]),
      day: this.day,
    };
    this.deliveries.push(del);
    return del;
  }

  /**
   * Clear your hands at the loading bay.
   *
   * Stocking a shelf used to be the only way to let go of anything, so one
   * armful of the wrong crop could strand you — every shelf claimed, nowhere
   * legal to put it, and no way to pick anything else up.
   *
   * The goods go back into a crate rather than into a bin. Binning at a cost
   * punishes the exact moment a new player is experimenting, and they'd learn
   * to stand there holding it forever instead; leaving it loose on the floor
   * needs a tidy-up system nobody asked for. A crate at the bay costs nothing,
   * is completely reversible, renders as an object you can walk back to, and
   * the stocker will quietly shelve it for you — because pallets are already
   * the first job on their list.
   */
  stow(playerId) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    if (!p.carry || p.carry.qty <= 0) return err('nothing in hand');
    if (!near(p, this.layout.bay, BAY_REACH)) return err('take it out to the loading bay');

    const { item_id: itemId, qty } = p.carry;
    this.dropGoods(itemId, qty, this.layout.bay);
    p.carry = null;
    // Don't hand it straight back — see the note in actionFor.
    p.stowLock = true;
    const name = content().byId.items[itemId]?.name ?? itemId;
    this.pushLog(`${qty}x ${name} put back in a crate at the bay.`);
    return ok({ stowed: qty, item_id: itemId });
  }

  // -------------------------------------------------------------------------
  // Appliances — turning ingredients into finished goods
  // -------------------------------------------------------------------------

  /** Which appliances the shop owns, in purchase order. */
  /**
   * Every appliance the shop owns, by name, one entry per machine.
   *
   * Read off the ledger rather than off `ownedUpgrades`, which is what made an
   * appliance a permanent single thing you could never buy a second of and
   * never really tear out — the upgrade now grants the first one and sets the
   * price, exactly as a shelf upgrade does.
   */
  ownedStations() {
    return stationList(this.fixtures);
  }

  /** Is this item the output of some recipe? Then it can't be bought in. */
  isCrafted(itemId) {
    return content().recipes.some((r) => r.output_id === itemId);
  }

  /** Recipes this appliance can make. */
  recipesFor(stationKind) {
    return content().recipes.filter((r) => r.station === stationKind);
  }

  /**
   * Put what you're holding into an appliance. Ingredients go in one armful at
   * a time, which is why a station has a hopper rather than taking a whole
   * recipe in one action.
   */
  loadStation(playerId, stationId) {
    const p = this.players[playerId];
    const st = (this.layout.stations ?? []).find((s) => s.id === stationId);
    if (!p || !st) return err('no such appliance');
    if (!near(p, st.useAt, REACH) && !near(p, st, REACH)) return err('too far from it');
    if (!p.carry || p.carry.qty <= 0) return err('nothing in hand');

    // Only accept things some recipe on this appliance actually wants —
    // otherwise the hopper fills with junk that can never come out.
    const wanted = new Set(
      this.recipesFor(st.station).flatMap((r) => r.inputs.map((i) => i.item_id)),
    );
    if (!wanted.size) return err(`no recipes for the ${st.station} yet`);
    if (!wanted.has(p.carry.item_id)) {
      return err(`the ${st.station} has no use for ${p.carry.item_id}`);
    }

    const moved = p.carry.qty;
    st.contents[p.carry.item_id] = (st.contents[p.carry.item_id] ?? 0) + moved;
    p.carry = null;
    return ok({ loaded: moved, station: st.id, contents: { ...st.contents } });
  }

  /** Take the finished product out. */
  collectStation(playerId, stationId) {
    const p = this.players[playerId];
    const st = (this.layout.stations ?? []).find((s) => s.id === stationId);
    if (!p || !st) return err('no such appliance');
    if (!st.output) return err('nothing ready');
    if (p.carry && p.carry.item_id !== st.output.item_id) {
      return err(`hands full of ${p.carry.item_id}`);
    }
    const have = p.carry?.qty ?? 0;
    const take = Math.min(st.output.qty, this.carryCapacity() - have);
    if (take <= 0) return err('hands full');

    st.output.qty -= take;
    p.carry = { item_id: st.output.item_id, qty: have + take };
    const madeId = st.output.item_id;
    if (st.output.qty <= 0) st.output = null;
    return ok({ collected: take, item_id: madeId });
  }

  /**
   * Run every appliance. They work on their own once loaded — an appliance you
   * have to stand and watch is just a slower shelf.
   */
  stepStations(dt) {
    const stations = this.layout.stations ?? [];
    if (!stations.length) return;

    for (const st of stations) {
      if (st.making) {
        if (this.elapsed < st.busyUntil) continue;
        const recipe = content().byId.recipes[st.making];
        st.making = null;
        if (!recipe) continue;
        const out = st.output ?? { item_id: recipe.output_id, qty: 0 };
        // Only ever hold one product at a time, so a finished batch has to be
        // cleared before the next one starts.
        if (out.item_id !== recipe.output_id) continue;
        out.qty += recipe.output_qty;
        st.output = out;
        this.pushLog(`${recipe.name} is ready at the ${st.station}.`);
        continue;
      }

      if (st.output) continue;   // clear the last batch first

      const recipe = this.recipesFor(st.station).find((r) =>
        r.inputs.every((i) => (st.contents[i.item_id] ?? 0) >= i.qty));
      if (!recipe) continue;

      for (const i of recipe.inputs) {
        st.contents[i.item_id] -= i.qty;
        if (st.contents[i.item_id] <= 0) delete st.contents[i.item_id];
      }
      st.making = recipe.id;
      st.startedAt = this.elapsed;
      // `minutes` is in-game minutes; a day is DAY_SECONDS real seconds.
      const speed = this.fixtureStats(st).speed_mult;
      st.busyUntil = this.elapsed + (recipe.minutes / speed / (24 * 60)) * DAY_SECONDS;
    }
  }

  /** Take a pallet's contents into your hands, as much as you can hold. */
  unload(playerId, deliveryId) {
    const p = this.players[playerId];
    if (!p) return err('no such player');

    const del = deliveryId
      ? this.deliveries.find((d) => d.id === deliveryId)
      : this.nearest(this.deliveries, p, UNLOAD_REACH);
    if (!del) return err('no delivery here');
    if (!near(p, del, UNLOAD_REACH)) return err('too far from the pallet');

    if (p.carry && p.carry.item_id !== del.item_id) {
      return err(`hands full of ${p.carry.item_id} — shelve it first`);
    }
    const have = p.carry?.qty ?? 0;
    const take = Math.min(del.qty, this.carryCapacity() - have);
    if (take <= 0) return err('hands full');

    del.qty -= take;
    p.carry = { item_id: del.item_id, qty: have + take };
    if (del.qty <= 0) this.deliveries = this.deliveries.filter((d) => d.id !== del.id);
    return ok({ unloaded: take, item_id: del.item_id, left: del.qty });
  }

  stockShelf(playerId, shelfId) {
    const p = this.players[playerId];
    const shelf = this.layout.shelves.find((s) => s.id === shelfId);
    if (!p || !shelf) return err('no such shelf');
    if (!near(p, shelf)) return err('too far from that shelf');
    if (!p.carry || p.carry.qty <= 0) return err('nothing in hand');

    const item = content().byId.items[p.carry.item_id];
    if (!item) return err('that item no longer exists');

    const fixture = requiredFixture(item);
    if (fixture === 'freezer' && shelf.kind !== 'freezer') {
      return err(`${item.name} needs a freezer`);
    }
    // An empty shelf can be relabelled to anything — only a shelf with stock
    // still on it is "claimed". Without this, farm produce has nowhere to go
    // once every shelf has been labelled by a previous delivery.
    if (shelf.item_id && shelf.qty > 0 && shelf.item_id !== p.carry.item_id) {
      return err(`shelf already holds ${shelf.item_id}`);
    }
    if (shelf.qty === 0) shelf.item_id = null;

    const room = this.shelfCapacity(shelf, item) - shelf.qty;
    if (room <= 0) return err('shelf is full');

    const moved = Math.min(room, p.carry.qty);
    const wasEmpty = shelf.qty === 0;
    shelf.item_id = p.carry.item_id;
    shelf.qty += moved;
    if (wasEmpty) {
      shelf.stockedDay = this.day;
      shelf.price = suggestedPrice(item, this.folded(), this.season);
    }

    p.carry.qty -= moved;
    if (p.carry.qty <= 0) p.carry = null;
    return ok({ stocked: moved, price: shelf.price });
  }

  setPrice(shelfId, price) {
    const shelf = this.layout.shelves.find((s) => s.id === shelfId);
    if (!shelf) return err('no such shelf');
    shelf.price = Math.max(0, round2(price));
    return ok({ price: shelf.price });
  }

  /**
   * Fill the shop and plant the fields instantly, for free.
   *
   * This is a staging tool, not a gameplay one: an agent that wants to *look*
   * at the shop (or test how a new item reads on a shelf) shouldn't have to
   * play twenty minutes of farming first. Never called during normal play.
   */
  autoStock() {
    const c = content();
    if (c.items.length === 0) return err('no items exist');

    const farmGrown = new Set(c.crops.map((cr) => cr.item_id));
    const used = new Set();
    let stocked = 0;

    for (const shelf of this.layout.shelves) {
      const wantsFreezer = shelf.kind === 'freezer';
      const pick = c.items.find((it) => {
        if ((requiredFixture(it) === 'freezer') !== wantsFreezer) return false;
        return !used.has(it.id);
      }) ?? c.items.find((it) => (requiredFixture(it) === 'freezer') === wantsFreezer);
      if (!pick) continue;

      used.add(pick.id);
      shelf.item_id = pick.id;
      shelf.qty = Math.max(1, Math.floor(pick.stack * 0.7));
      shelf.price = suggestedPrice(pick, this.folded(), this.season);
      shelf.stockedDay = this.day;
      stocked++;
    }

    let planted = 0;
    const inSeason = c.crops.filter((cr) => !cr.seasons.length || cr.seasons.includes(this.season));
    for (let i = 0; i < this.layout.plots.length; i++) {
      const plot = this.layout.plots[i];
      const crop = (inSeason.length ? inSeason : c.crops)[i % Math.max(1, (inSeason.length || c.crops.length))];
      if (!crop) break;
      // Staging skips the tilling, but a planted plot must still read as broken
      // soil or the renderer would draw a crop growing out of turf.
      plot.soil = 'tilled';
      this.sowInto(plot, crop);
      // Stagger growth so the fields show every stage at once. Set after
      // sowing, which stamps `plantedAt` with now.
      plot.plantedAt = this.elapsed - (i / this.layout.plots.length) * crop.grow_minutes * 60;
      planted++;
    }

    this.pushLog(`Shop stocked: ${stocked} shelves, ${planted} plots planted.`);
    return ok({ stocked, planted });
  }

  // -------------------------------------------------------------------------
  // Build mode — placing, moving, turning, emptying and tearing out fixtures.
  //
  // Everything in here acts on a fixture the player *named*, because the client
  // picked it out from under the pointer. Nothing is chosen by proximity: in a
  // shop with seventeen shelves in it, "the nearest one" is not a choice, and
  // there was no way to express which of the three in reach you meant.
  //
  // So the shape is: the bar along the bottom holds the things you can put
  // down, and every fixture already in the world carries its own menu — move,
  // turn, empty, remove, plus whatever only makes sense for that kind. One tap
  // opens it, and the menu is the confirmation.
  //
  // Build mode is still the safety catch. Outside it, standing next to a full
  // shelf stocks it and none of this is reachable at all.
  // -------------------------------------------------------------------------

  setBuildMode(playerId, on, tool = null) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    p.build = on ? { on: true, tool: tool ?? p.build?.tool ?? 'shelf' } : null;
    if (!on) p.holding = null;
    p.action = null;
    return ok({ build: p.build?.tool ?? null });
  }

  setBuildTool(playerId, tool) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    if (!p.build?.on) return err('not in build mode');
    // Only things you can put down. Move and Clear used to live in this list
    // and acted on whatever you were stood by; they're per-fixture menu items
    // now, so a tool is never anything but a fixture you're about to buy.
    if (!FIXTURES[tool] || tool === 'station') return err('no such build tool');
    p.build.tool = tool;
    // A lifted fixture deliberately survives this. It isn't a tool any more —
    // it's a thing in your hands — and dropping it because you clicked Freezer
    // would leave the shelf you were repositioning silently back where it was.
    p.action = null;
    return ok({ tool });
  }

  /** Every fixture as a uniform `{kind, ...}`, for build mode to work over. */
  allFixtures() {
    return [
      ...this.layout.shelves.map((s) => ({ ...s, kind: s.kind === 'freezer' ? 'freezer' : 'shelf', ref: s })),
      ...this.layout.checkouts.map((c) => ({ ...c, kind: 'checkout', ref: c })),
      ...(this.layout.stations ?? []).map((s) => ({ ...s, kind: 'station', ref: s })),
      ...this.layout.plots.map((pl) => ({ ...pl, kind: 'plot', ref: pl })),
      // Decorations are fixtures to everything in build mode — you aim at one,
      // open its menu, turn it, move it, sell it back — so they belong in the
      // one list rather than growing a parallel set of verbs that do the same
      // things to a different noun. They carry their own kind because there is
      // more than one and the list they came from no longer says which.
      ...(this.layout.props ?? []).map((p) => ({ ...p, ref: p })),
    ];
  }

  findFixture(id) {
    return this.allFixtures().find((f) => f.id === id) ?? null;
  }

  // ---- tiers ---------------------------------------------------------------
  //
  // A fixture can be upgraded in place: a better freezer keeps things longer, a
  // better blender works faster. The ladder itself is content (`fixtures` rows),
  // so a third tier of shelf is authored, not deployed.
  //
  // Which tier a *particular* fixture is at lives on its placement, for the same
  // reason its position does — the generator re-mints `shelf-pN` ids on every
  // re-flow, so anything remembered against one of those names would drift onto
  // a different fixture. Upgrading therefore pins a fixture into a placement,
  // exactly as moving or turning it already does.

  /**
   * The piece this is, in content terms.
   *
   * Takes a fixture, because which design a shelf is belongs to *that shelf* now
   * rather than to shelves in general. A bare kind still answers — with the
   * kind's default piece — because plenty of callers legitimately mean "what
   * does a shelf cost" rather than "what does this shelf cost".
   */
  fixtureContent(kindOrFixture) {
    const rows = content().fixtures ?? [];
    return typeof kindOrFixture === 'string'
      ? defaultPiece(rows, kindOrFixture)
      : pieceFor(rows, kindOrFixture);
  }

  /**
   * Which piece id a request to build one of these should record.
   *
   * Names the piece asked for when the catalog has it, the kind's default when
   * it doesn't. The fallback matters more than it looks: a fixture kind exists
   * in code whether or not anybody has drawn it — an undrawn shelf renders as a
   * plain block and has been buildable that way since long before there was a
   * catalog — so a kind with no rows at all still builds under its own name. A
   * prop is *only* its art, so a prop nobody has drawn has nothing to place.
   */
  pieceId(kind, want = null) {
    const rows = content().fixtures ?? [];
    if (want) {
      const hit = rows.find((p) => p.id === want && kindOf(p) === kind);
      if (hit) return hit.id;
    }
    return defaultPiece(rows, kind)?.id ?? (isProp(kind) ? null : kind);
  }

  /** The tier ladder for a piece. Always at least one rung: what a new one is. */
  fixtureTiers(kindOrFixture) {
    const tiers = this.fixtureContent(kindOrFixture)?.tiers;
    return tiers?.length ? tiers : [{ name: 'Standard', cost: 0 }];
  }

  /** Which rung a fixture is on, clamped to what content currently offers. */
  fixtureTier(idOrFixture) {
    const f = typeof idOrFixture === 'string' ? this.findFixture(idOrFixture) : idOrFixture;
    if (!f) return 1;
    // The layout carries the tier through from the placement it was built from,
    // so read that first — this runs for every plot and shelf on every tick and
    // rescanning the placement list each time is a scan nobody needs.
    const tier = f.tier ?? this.placements.find((p) => p.id === f.id)?.tier ?? 1;
    // Clamped against *this fixture's* ladder, not its kind's. Two shelf designs
    // may climb to different heights, and reading the wrong ladder is how a
    // tier-3 unit silently demotes itself the day somebody authors a shorter one.
    return clamp(Math.trunc(tier), 1, this.fixtureTiers(f).length);
  }

  /**
   * Which shape a fixture is, as an id content still recognises.
   *
   * A variant that has since been deleted falls back to Standard rather than
   * drawing nothing — the same forgiveness `fixtureTier` shows a tier ladder
   * that got shorter. Empty string is Standard, and always valid.
   */
  fixtureVariant(idOrFixture) {
    const f = typeof idOrFixture === 'string' ? this.findFixture(idOrFixture) : idOrFixture;
    if (!f) return '';
    const want = f.variant ?? this.placements.find((p) => p.id === f.id)?.variant ?? '';
    return this.fixtureHasVariant(f, want) ? want : '';
  }

  /** Is this a shape this piece actually comes in? */
  fixtureHasVariant(kindOrFixture, variant) {
    if (!variant) return true;
    return (this.fixtureContent(kindOrFixture)?.variants ?? []).some((v) => v.id === variant);
  }

  /** The stat block a fixture is currently running on. */
  fixtureStats(idOrFixture) {
    const f = typeof idOrFixture === 'string' ? this.findFixture(idOrFixture) : idOrFixture;
    if (!f) return { capacity_mult: 1, keeps_mult: 1, speed_mult: 1 };
    const tier = this.fixtureTiers(f)[this.fixtureTier(f) - 1] ?? {};
    return {
      capacity_mult: tier.capacity_mult ?? 1,
      keeps_mult: tier.keeps_mult ?? 1,
      speed_mult: tier.speed_mult ?? 1,
    };
  }

  /** The next rung and what it costs, or null when it's already the best. */
  nextTier(idOrFixture) {
    const f = typeof idOrFixture === 'string' ? this.findFixture(idOrFixture) : idOrFixture;
    if (!f) return null;
    const tiers = this.fixtureTiers(f);
    const next = tiers[this.fixtureTier(f)];
    return next ? { ...next, tier: this.fixtureTier(f) + 1 } : null;
  }

  /**
   * Pay to step one fixture up a tier. Same fixture, same tile, same stock —
   * it just gets better at its job and (usually) looks it.
   */
  upgradeFixture(playerId, id) {
    const { f, error } = this.buildTarget(playerId, id);
    if (error) return err(error);

    const next = this.nextTier(f);
    if (!next) return err('that is already as good as it gets');
    if (this.cash < next.cost) return err(`need $${next.cost.toFixed(2)}`);

    const res = this.repositionFixture(id, {
      kind: f.kind, station: f.station ?? null, x: f.x, z: f.z, rot: f.rot ?? 0, tier: next.tier,
    });
    if (!res.ok) return res;

    this.cash -= next.cost;
    this.stats.spent += next.cost;
    this.pushLog(`Upgraded a ${FIXTURES[f.kind]?.label.toLowerCase() ?? 'fixture'} to ${next.name} for $${next.cost.toFixed(2)}.`);
    return ok({ upgraded: res.id, tier: next.tier, cost: round2(next.cost) });
  }

  /**
   * Change the shape of something you already own. Free, and instant.
   *
   * Upgrading's cheap counterpart. A tier is a number you paid for; a variant
   * is only how the thing looks, and charging for taste turns rearranging your
   * own shop into something you ration. It goes through `repositionFixture`
   * like everything else so a restyled shelf keeps its stock.
   */
  styleFixture(playerId, id, variant = '') {
    const { f, error } = this.buildTarget(playerId, id);
    if (error) return err(error);

    const want = variant ?? '';
    if (!this.fixtureHasVariant(f, want)) return err('that is not a shape this comes in');
    if (this.fixtureVariant(f) === want) return ok({ styled: id, variant: want });

    const res = this.repositionFixture(id, {
      kind: f.kind, station: f.station ?? null, x: f.x, z: f.z, rot: f.rot ?? 0, variant: want,
    });
    if (!res.ok) return res;
    return ok({ styled: res.id, variant: want });
  }

  /** The fixture occupying a tile, which is how build mode names its target. */
  fixtureAt(x, z) {
    const tx = Math.round(x);
    const tz = Math.round(z);
    return this.allFixtures().find((f) => f.x === tx && f.z === tz) ?? null;
  }

  /**
   * The one gate every fixture menu action goes through.
   *
   * There's no reach check: you aimed at it, and placing a fixture has never
   * required you to walk over there either. Being in build mode is the consent,
   * and it's a mode you can only be in on purpose.
   */
  buildTarget(playerId, id) {
    const p = this.players[playerId];
    if (!p) return { error: 'no such player' };
    if (!p.build?.on) return { error: 'not in build mode' };
    const f = this.findFixture(id);
    if (!f) return { error: 'no such fixture' };
    return { p, f };
  }

  /** How much stuff is inside a fixture — what "empty it first" is measuring. */
  fixtureContents(f) {
    if (f.kind === 'station') {
      return Object.values(f.contents ?? {}).reduce((a, b) => a + b, 0) + (f.output?.qty ?? 0);
    }
    if (f.kind === 'plot') return f.crop_id ? 1 : 0;
    if (f.kind === 'checkout') return 0;
    return f.qty ?? 0;
  }

  /**
   * Tip a fixture out. Everything recoverable lands in a crate on the floor
   * beside it, so emptying is never destruction — it's just moving stock into
   * the one container the whole game already understands.
   */
  emptyFixture(playerId, id) {
    const { p, f, error } = this.buildTarget(playerId, id);
    if (error) return err(error);

    if (f.kind === 'shelf' || f.kind === 'freezer') return this.stripShelf(playerId, id);
    if (f.kind === 'station') return this.dumpStation(playerId, id);
    if (f.kind === 'plot') {
      const plot = f.ref;
      if (!plot.crop_id) return err('nothing growing there');
      // A half-grown crop is a sunk cost — there's nothing to put in a crate.
      const name = content().byId.crops[plot.crop_id]?.name ?? plot.crop_id;
      this.clearPlot(plot);
      this.pushLog(`Cleared the ${name} out of ${plot.id}.`);
      return ok({ cleared: plot.id });
    }
    return err('nothing to empty there');
  }

  /** Take a shelf's stock off it and hand the shelf back unlabelled. */
  stripShelf(playerId, shelfId) {
    const p = this.players[playerId];
    const shelf = this.layout.shelves.find((s) => s.id === shelfId);
    if (!p || !shelf) return err('no such shelf');
    if (!shelf.item_id && shelf.qty <= 0) return err('that shelf is already bare');

    const moved = shelf.qty;
    if (moved > 0) this.dropGoods(shelf.item_id, moved, shelf.browseAt);
    const name = content().byId.items[shelf.item_id]?.name ?? shelf.item_id;
    shelf.item_id = null;
    shelf.qty = 0;
    shelf.price = 0;
    shelf.stockedDay = this.day;
    this.pushLog(moved > 0
      ? `Stripped ${moved}x ${name} off ${shelf.id} — it's in a crate beside it.`
      : `Cleared the label off ${shelf.id}.`);
    return ok({ emptied: moved, shelf: shelf.id });
  }

  /** Tip an appliance's hopper (and any finished batch) out into crates. */
  dumpStation(playerId, stationId) {
    const p = this.players[playerId];
    const st = (this.layout.stations ?? []).find((s) => s.id === stationId);
    if (!p || !st) return err('no such appliance');

    let moved = 0;
    for (const [itemId, n] of Object.entries(st.contents ?? {})) {
      this.dropGoods(itemId, n, st.useAt);
      moved += n;
    }
    st.contents = {};
    if (st.output) {
      this.dropGoods(st.output.item_id, st.output.qty, st.useAt);
      moved += st.output.qty;
      st.output = null;
    }
    if (moved === 0) return err('that hopper is already empty');
    // A batch already underway is left to finish — its ingredients are spent,
    // so cancelling it would destroy them for nothing.
    this.pushLog(`Emptied the ${st.station} — ${moved} units back in crates.`);
    return ok({ dumped: moved, station: st.id });
  }

  /** What one more of this fixture costs, priced off whatever upgrade sells it. */
  fixtureUnitCost(kind, station = null, piece = null) {
    // A piece that names its own price is worth exactly that, whatever kind it
    // is. This is the only way a decoration can be priced at all — nothing
    // sells a planter — and it is the on-ramp for moving every price onto the
    // catalog later. Left at 0 everywhere today, so no existing thing moved.
    const row = piece ? pieceFor(content().fixtures ?? [], { kind, piece }) : null;
    if (row?.cost > 0) return round2(row.cost);

    // An appliance is priced by the upgrade that sells *that* appliance. There
    // is nothing to divide by the way a pack of shelves has: one upgrade, one
    // machine, and a blender and a coffee machine are not the same purchase.
    if (kind === 'station') {
      const up = this.stationUpgrade(station);
      return round2(up?.cost ?? FALLBACK_FIXTURE_COST.station);
    }

    const key = FIXTURE_PAYLOAD_KEY[kind];
    if (!key) return 0;
    const per = content().upgrades
      .filter((u) => u.kind === kind && (u.payload?.[key] ?? 0) > 0)
      .map((u) => u.cost / u.payload[key]);
    // Priced from content rather than a constant here, so an upgrade added via
    // MCP tomorrow reprices build mode with it and nothing needs recompiling.
    return round2(per.length ? Math.min(...per) : FALLBACK_FIXTURE_COST[kind] ?? 100);
  }

  /** The upgrade that sells a named appliance, or undefined. */
  stationUpgrade(station) {
    return content().upgrades.find((u) => u.kind === 'station' && u.payload?.station === station);
  }

  /**
   * Build-mode prices, for the client's palette.
   *
   * Appliances are keyed the same way the ledger keys them, so the palette
   * looks up a price and a count with one id and needs to know nothing about
   * appliances being a special case. Add one via MCP and it appears, priced.
   */
  buildCosts() {
    const costs = Object.fromEntries(Object.keys(FIXTURE_PAYLOAD_KEY)
      .map((k) => [k, this.fixtureUnitCost(k)]));
    // ...and one per piece, keyed by piece id, because a price belongs to a
    // design now rather than to a kind. The five pieces that predate the split
    // are named after their kind, so those entries land on exactly the keys the
    // line above already wrote and nothing about them moved.
    for (const row of content().fixtures ?? []) {
      const k = kindOf(row);
      if (!FIXTURES[k]) continue;
      costs[row.id] = this.fixtureUnitCost(k, null, row.id);
    }
    for (const u of content().upgrades) {
      if (u.kind !== 'station' || !u.payload?.station) continue;
      costs[ledgerKey('station', { station: u.payload.station })] = round2(u.cost);
    }
    // The shell, priced per segment. Same reason fixture prices are shared: the
    // palette prints the number on the button and the server is what charges
    // it, so two copies would be two different amounts of money.
    costs.wall = EDGE_COST[E.WALL];
    costs.window = EDGE_COST[E.WINDOW];
    costs.door = EDGE_COST[E.DOOR];
    costs.knock = 0;
    return costs;
  }

  /** Buy a fixture and site it where you're pointing. */
  placeFixture(playerId, spec = {}) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    if (!p.build?.on) return err('not in build mode');

    const kind = spec.kind;
    if (!FIXTURES[kind]) return err('you cannot build that');

    // Which appliance, for a station. It rides on the placement the way a
    // variant does, because to the build rules every appliance is the same
    // shape in the same places — only the price and what it cooks differ.
    const station = kind === 'station' ? String(spec.station ?? '') : null;
    if (kind === 'station' && !this.stationUpgrade(station)) return err('no such appliance');

    // Which design off the catalog. Unknown ids fall back to the kind's default
    // rather than refusing, which is what keeps every caller that predates
    // pieces — the bot, the API, an older client — building shelves.
    const piece = this.pieceId(kind, spec.piece);
    if (!piece) return err('nothing in the catalog builds that');

    const placement = {
      id: `fx-${this.nextFixtureId}`,
      kind,
      piece,
      station,
      x: Math.round(Number(spec.x)),
      z: Math.round(Number(spec.z)),
      rot: rot4(Number(spec.rot) || 0),
      tier: 1,
      // Which shape you picked off the palette. Costs the same as any other:
      // a variant is a look, and the price is the piece's.
      variant: this.fixtureHasVariant({ kind, piece }, spec.variant) ? (spec.variant ?? '') : '',
    };
    const check = canPlace(this.layout, placement);
    if (!check.ok) return err(check.reason);

    const cost = this.fixtureUnitCost(kind, station, piece);
    if (this.cash < cost) return err(`need $${cost.toFixed(2)}`);

    this.cash -= cost;
    this.stats.spent += cost;
    const key = ledgerKey(kind, { station, piece });
    this.fixtures[key] = (this.fixtures[key] ?? 0) + 1;
    this.nextFixtureId++;
    this.placements.push(placement);
    this.regenerateLayout();
    // An appliance is named after the machine, not after "appliance" — you
    // bought a blender and the log should say so. A piece is named after
    // itself for the same reason: you bought a planter, not a "decoration".
    const what = station
      ? (this.stationUpgrade(station)?.name ?? station).toLowerCase()
      : (this.fixtureContent(placement)?.name ?? FIXTURES[kind].label).toLowerCase();
    this.pushLog(`Built a ${what} for $${cost.toFixed(2)}.`);
    // Carried back out so anything driving this headlessly — the API, MCP, a
    // bot — is told what it just did to the shop, rather than only the player
    // who saw the ghost turn amber.
    return ok({ placed: placement.id, kind, cost: round2(cost), warn: check.warn ?? null });
  }

  /**
   * Pick a fixture up to reposition it. Nothing leaves the world yet — it stays
   * exactly where it is, stock and all, until you choose a destination. That
   * way backing out of a move costs nothing and can't strand a shelf's stock.
   */
  liftFixture(playerId, id) {
    const { p, f, error } = this.buildTarget(playerId, id);
    if (error) return err(error);
    if (p.holding && p.holding.id !== id) return err('put down what you are carrying first');

    p.holding = {
      id: f.id,
      kind: f.kind,
      piece: f.piece ?? null,
      station: f.station ?? null,
      rot: f.rot ?? 0,
      tier: this.fixtureTier(f),
      variant: this.fixtureVariant(f),
      // What the hint calls it while you carry it. The piece's own name when it
      // has one, because "carrying a decoration" tells you nothing in a shop
      // with four kinds of planter in it.
      label: this.fixtureContent(f)?.name ?? FIXTURES[f.kind]?.label ?? 'fixture',
    };
    return ok({ lifted: f.id, kind: f.kind });
  }

  /** Set a lifted fixture back down somewhere else. Free — it's the same one. */
  dropFixture(playerId, spec = {}) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    const held = p.holding;
    if (!held) return err('nothing picked up');

    const res = this.repositionFixture(held.id, {
      kind: held.kind,
      piece: held.piece ?? null,
      station: held.station,
      x: spec.x,
      z: spec.z,
      rot: spec.rot ?? held.rot,
      tier: held.tier,
      variant: held.variant ?? '',
    });
    if (!res.ok) {
      // The only way this fixture can be gone is if it was removed under us —
      // in which case there is nothing left to be carrying.
      if (res.error === 'that fixture is gone') p.holding = null;
      return res;
    }
    p.holding = null;
    return ok({ moved: res.id, kind: held.kind });
  }

  /**
   * Turn a fixture a quarter turn on the spot.
   *
   * Rotation is which side people use it from, so for a shelf it decides which
   * aisle shoppers browse it out of and for a till it decides where the queue
   * forms. That was previously only reachable by moving something and putting
   * it back, which is a lot of ceremony for "face the other way".
   */
  rotateFixture(playerId, id, dir = 1) {
    const { f, error } = this.buildTarget(playerId, id);
    if (error) return err(error);
    if (!FIXTURES[f.kind]?.rotates) return err('that does not face anywhere');

    const step = Number(dir) < 0 ? 3 : 1;
    // Every facing is legal now that walling something in is your business, so
    // this is about which one you *meant*: take the next quarter turn that
    // leaves it usable, and only fall back to a facing that doesn't if all
    // three would. Turning it should not silently make it useless, but nor
    // should it refuse to turn.
    const tries = [1, 2, 3].map((i) => rot4((f.rot ?? 0) + step * i));
    const spec = (rot) => ({ kind: f.kind, station: f.station ?? null, x: f.x, z: f.z, rot });
    const clean = tries.find((rot) => !canPlace(this.layout, { ...spec(rot), id }, { ignoreId: id }).warn);
    for (const rot of clean != null ? [clean, ...tries] : tries) {
      const res = this.repositionFixture(id, spec(rot));
      if (res.ok) return ok({ rotated: res.id, rot });
    }
    return err('nowhere for it to turn to');
  }

  /**
   * Put an existing fixture somewhere (possibly the same tile, turned).
   *
   * The one path that both moving and turning go through, so a fixture can
   * never lose its stock one way and keep it the other. A repositioned fixture
   * gets a fresh id so it can't collide with one the generator is about to
   * mint, and `alias` carries its contents across the re-flow.
   */
  repositionFixture(id, spec) {
    const from = this.findFixture(id);
    if (!from) return err('that fixture is gone');

    const placement = {
      id: `fx-${this.nextFixtureId}`,
      kind: spec.kind,
      // Which design it is rides along exactly as the tier and the shape do. Let
      // it fall back to the kind's default here and picking a shelf up would set
      // it down as whichever shelf the catalog lists first.
      piece: spec.piece ?? from.piece ?? this.pieceId(spec.kind),
      station: spec.station ?? null,
      x: Math.round(Number(spec.x)),
      z: Math.round(Number(spec.z)),
      rot: rot4(Number(spec.rot) || 0),
      // Moving or turning something must never quietly demote it, so the tier
      // rides along unless the caller is deliberately changing it. Same for the
      // shape: a corner shelf you pick up is still a corner shelf when it lands.
      tier: Math.max(1, Math.trunc(Number(spec.tier ?? this.fixtureTier(id)) || 1)),
      variant: spec.variant ?? this.fixtureVariant(id),
    };
    const check = canPlace(this.layout, placement, { ignoreId: id });
    if (!check.ok) return err(check.reason);

    this.nextFixtureId++;
    this.placements = this.placements.filter((pl) => pl.id !== id);
    this.placements.push(placement);
    // Anyone carrying this follows it to its new id, or they'd be holding a
    // fixture that no longer exists.
    for (const pl of Object.values(this.players)) {
      if (pl.holding?.id === id) pl.holding = { ...pl.holding, id: placement.id };
    }
    this.regenerateLayout(null, { [id]: placement.id });
    return ok({ id: placement.id });
  }

  cancelBuildHold(playerId) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    p.holding = null;
    return ok({});
  }

  /**
   * Tear a fixture out and get some money back.
   *
   * Countable fixtures come off the ledger and refund half of what one costs.
   * An appliance isn't countable — it exists because you own an upgrade — so
   * removing it sells that upgrade back instead, which keeps the two systems
   * honest and lets you re-buy and re-site it later.
   */
  removeFixture(playerId, id) {
    const { p, f, error } = this.buildTarget(playerId, id);
    if (error) return err(error);
    if (this.fixtureContents(f) > 0) return err('empty it first');
    if (f.kind === 'checkout' && this.layout.checkouts.length <= 1) {
      return err('you need at least one till to take money');
    }

    // One path for everything now. Tearing out an appliance used to un-own its
    // upgrade — the only way a boolean can count down — which meant selling one
    // back put it up for sale again at full price and re-buying it was the only
    // way to get a second.
    const key = ledgerKey(f.kind, { station: f.station, piece: f.piece });
    if ((this.fixtures[key] ?? 0) <= 0) return err('nothing to remove');
    this.fixtures[key] -= 1;
    const refund = round2(this.fixtureUnitCost(f.kind, f.station, f.piece) * FIXTURE_REFUND);

    this.placements = this.placements.filter((pl) => pl.id !== id);
    this.cash += refund;
    for (const pl of Object.values(this.players)) {
      if (pl.holding?.id === id) pl.holding = null;
    }
    // A removal used to have to disarm the Clear tool, because proximity
    // re-armed it the instant it finished and standing still would eat one
    // fixture after another while you read the log. Nothing re-arms now — the
    // menu you pressed it in went away with the fixture.
    p.action = null;
    this.regenerateLayout();
    this.pushLog(`Removed a ${FIXTURES[f.kind]?.label.toLowerCase() ?? 'fixture'} — $${refund.toFixed(2)} back.`);
    return ok({ removed: id, refund });
  }

  /** Slide the front door along the south wall. */
  /**
   * Draw or erase one segment of wall, window or doorway.
   *
   * Stored as an *overlay* rather than written into the layout, because the
   * generator rebuilds the shell from scratch on every re-flow — the same
   * reason `placements` exists. Write it into the tiles and buying a shelf
   * would quietly demolish your back room.
   *
   * Re-drawing the same line replaces whatever was there, so a window over a
   * wall is one action rather than erase-then-place.
   */
  buildEdge(playerId, spec = {}) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    if (!p.build?.on) return err('not in build mode');

    const o = spec.o === 'v' ? 'v' : 'h';
    const x = Math.round(Number(spec.x));
    const z = Math.round(Number(spec.z));
    if (!Number.isFinite(x) || !Number.isFinite(z)) return err('nowhere to build that');

    const kind = Math.max(0, Math.trunc(Number(spec.kind ?? E.WALL)) || 0);
    if (kind && !EDGE_COST[kind]) return err('you cannot build that');

    // A run arrives as its two ends, never as a list of tiles — Colyseus caps
    // inbound messages at 4KB, and a long wall is a lot of tiles.
    const segs = edgeRun({ o, x, z }, spec.to, EDGE_RUN_MAX);

    // Asked for the whole run at once: no single segment of a wall across the
    // aisle seals anything, so per-segment checks would report no warning right
    // up until the shop was shut.
    const check = canPlaceEdges(this.layout, segs, kind);
    if (!check.ok) return err(check.reason);

    let spent = 0;
    let placed = 0;
    let short = false;
    for (const s of segs) {
      const key = `${s.o}:${s.x},${s.z}`;
      const had = this.edits.find((e) => `${e.o}:${e.x},${e.z}` === key);
      const existing = had ? had.k : this.edgeKindAt(s.o, s.x, s.z);
      if (existing === kind) continue;

      // Pay the difference: taking a wall out refunds, swapping wall for window
      // charges only the gap. Erasing something the generator built refunds
      // too — the shell is as much yours as anything you drew.
      const cost = round2((EDGE_COST[kind] ?? 0)
        - (EDGE_COST[existing] ?? 0) * FIXTURE_REFUND);
      // Running out halfway builds what you could afford rather than refusing
      // the lot: a drag is a gesture, and losing all of it to the last segment
      // being a dollar short is the kind of thing you cannot see coming.
      if (cost > 0 && this.cash - spent < cost) { short = true; break; }

      spent = round2(spent + cost);
      this.edits = this.edits.filter((e) => `${e.o}:${e.x},${e.z}` !== key);
      this.edits.push({ o: s.o, x: s.x, z: s.z, k: kind });
      placed++;
    }

    if (!placed) {
      return short ? err(`need $${EDGE_COST[kind].toFixed(2)}`) : ok({ placed: 0, unchanged: true });
    }

    this.cash = round2(this.cash - spent);
    if (spent > 0) this.stats.spent += spent;
    this.regenerateLayout();

    const what = EDGE_LABEL[kind] ?? 'a wall';
    this.pushLog(kind
      ? `Built ${placed > 1 ? `${placed} segments of ${what.replace(/^an? /, '')}` : what}`
        + `${spent > 0 ? ` for $${spent.toFixed(2)}` : ''}.`
      : `Knocked ${placed > 1 ? `${placed} segments` : 'a hole'} through.`);
    return ok({ placed, cost: spent, short, warn: check.warn ?? null });
  }

  /** What is currently on a lattice line, generated shell included. */
  edgeKindAt(o, x, z) {
    const L = this.layout;
    if (o === 'v') return L.edgesV?.[z * (L.w + 1) + x] ?? 0;
    return L.edgesH?.[z * L.w + x] ?? 0;
  }

  moveDoor(playerId, shift) {
    const p = this.players[playerId];
    if (!p?.build?.on) return err('not in build mode');
    const next = clamp(Math.trunc(Number(shift) || 0), -8, 8);
    if (next === this.doorShift) return ok({ doorShift: next });
    const before = this.doorShift;
    this.doorShift = next;
    this.regenerateLayout();
    if (this.layout.droppedPlacements?.length) {
      // Moving the door re-flows the shop; if that orphaned things, put it back.
      this.doorShift = before;
      this.regenerateLayout();
      return err('that would displace something you have placed');
    }
    return ok({ doorShift: this.doorShift });
  }

  // -------------------------------------------------------------------------
  // Upgrades
  // -------------------------------------------------------------------------

  buyUpgrade(upgradeId) {
    const up = content().byId.upgrades[upgradeId];
    if (!up) return err('no such upgrade');
    if (up.kind === 'staff') {
      // Hiring moved to the roster, which can express two of someone and
      // letting one go. Selling this again would be a second way in.
      return err('take people on from the Staff menu');
    }
    if (FIXTURE_KINDS.includes(up.kind)) {
      // Same story: anything you can put down is bought in build mode, one at a
      // time, on a tile you chose. This row still exists as the price list —
      // `fixtureUnitCost` reads it — but buying it would hand you a lump of
      // fixtures the generator sites for you, which is the thing build mode
      // replaced.
      return err('build that from the Build menu');
    }
    if (this.ownedUpgrades.includes(upgradeId)) return err('already owned');
    const missing = up.requires.filter((r) => !this.ownedUpgrades.includes(r));
    if (missing.length) return err(`needs ${missing.join(', ')} first`);
    if (this.cash < up.cost) return err(`need $${up.cost.toFixed(2)}`);

    this.cash -= up.cost;
    this.stats.spent += up.cost;
    this.ownedUpgrades.push(upgradeId);

    // Fixture upgrades top up the ledger. It's a stored count rather than a
    // recount of what you own, because build mode has to be able to take one
    // back off again — and because the old recount quietly double-counted
    // freezers on every server restart.
    const key = FIXTURE_PAYLOAD_KEY[up.kind];
    if (key) this.fixtures[up.kind] = (this.fixtures[up.kind] ?? 0) + (up.payload[key] ?? 0);
    // An appliance upgrade grants the first machine and sets what another one
    // costs in build mode — the same deal a shelf upgrade offers.
    if (up.kind === 'station' && up.payload?.station) {
      const sk = ledgerKey('station', { station: up.payload.station });
      this.fixtures[sk] = (this.fixtures[sk] ?? 0) + 1;
    }
    if (up.kind === 'space') {
      this.grow = {
        w: this.grow.w + Math.max(0, Math.trunc(up.payload.width ?? 0)),
        h: this.grow.h + Math.max(0, Math.trunc(up.payload.depth ?? 0)),
      };
    }

    // Structural upgrades re-flow the building. Appliances count — they occupy
    // floor tiles, so buying one without regenerating leaves it unplaced.
    if (['plot', 'shelf', 'freezer', 'checkout', 'station', 'space'].includes(up.kind)) {
      this.regenerateLayout();
    }
    this.pushLog(`Bought ${up.name}.`);
    return ok({ upgrade: upgradeId });
  }

  /**
   * Rebuild the world from the current seed + what the shop owns, carrying
   * shelf, plot and appliance contents across so nobody loses stock when the
   * building re-flows.
   *
   * @param {string} [newSeed]
   * @param {object} [alias] old fixture id -> new one, for a fixture that just
   *   moved. Contents follow the id, so a stocked shelf keeps its stock when
   *   you pick it up and put it down somewhere else.
   */
  regenerateLayout(newSeed, alias = {}) {
    const oldShelves = this.layout.shelves;
    const oldPlots = this.layout.plots;
    const oldStations = this.layout.stations ?? [];
    const c = content();

    const layout = generateLayout({
      seed: newSeed ?? this.seed,
      shelves: this.fixtures.shelf,
      freezers: this.fixtures.freezer,
      checkouts: this.fixtures.checkout,
      plots: this.fixtures.plot,
      stations: this.ownedStations(),
      placements: this.placements,
      grow: this.grow,
      doorShift: this.doorShift,
      edits: this.edits,
    });

    // A placement the re-flow could no longer honour goes back to the generator
    // rather than lingering as a ghost that silently eats a fixture.
    if (layout.droppedPlacements?.length) {
      const gone = new Set(layout.droppedPlacements);
      this.placements = this.placements.filter((p) => !gone.has(p.id));
      this.pushLog(`${gone.size} placed fixture(s) no longer fit — put back automatically.`);
    }

    // Appliances keep whatever was in them across a re-flow.
    carryOver(layout.stations, oldStations, alias,
      ['contents', 'busyUntil', 'making', 'output', 'startedAt'],
      (from, to) => from.station === to.station);

    carryOver(layout.shelves, oldShelves, alias,
      ['item_id', 'qty', 'price', 'stockedDay'],
      (from, to) => {
        // Don't move freezer-only goods onto a normal shelf.
        const item = from.item_id ? c.byId.items[from.item_id] : null;
        return !(item && requiredFixture(item) === 'freezer' && to.kind !== 'freezer');
      });

    // `yield` rides along or a re-flow would hand the bed a different harvest
    // than the one it has been drawing.
    carryOver(layout.plots, oldPlots, alias, ['soil', 'crop_id', 'plantedAt', 'ready', 'yield']);

    if (newSeed) this.seed = String(newSeed);
    this.layout = layout;
    this.layoutVersion++;
    this.walk = buildWalkGrid(layout);

    // Everyone mid-path is now walking to somewhere that may not exist.
    for (const cu of Object.values(this.customers)) {
      // Except anyone still out on the approach: they have no tile under them,
      // and A* can't route out of one that doesn't exist, so a re-flow would
      // strand them off the edge of the world forever. They haven't set foot in
      // the shop yet — dropping them costs nothing and the next one is seconds
      // away.
      if (cu.x < 0 || cu.z < 0 || cu.x >= layout.w || cu.z >= layout.h) {
        this.despawn(cu);
        continue;
      }
      cu.path = null;
      cu.state = 'BROWSE';
      cu.targetShelf = null;
    }
    for (const p of Object.values(this.players)) {
      if (!this.canStand(p.x, p.z)) {
        p.x = layout.spawn.x;
        p.z = layout.spawn.z;
      }
    }
    return layout;
  }

  // -------------------------------------------------------------------------
  // Customers
  // -------------------------------------------------------------------------

  stepSpawning(dt, c, folded) {
    if (!this.isOpen() || c.archetypes.length === 0) return;
    const rate = footfall({
      day: this.day, hourFraction: this.time,
      reputation: this.reputation, folded,
    });
    this.spawnAccumulator += (rate / 60) * dt;
    while (this.spawnAccumulator >= 1) {
      this.spawnAccumulator -= 1;
      if (Object.keys(this.customers).length < 40) this.spawnCustomer();
    }
  }

  spawnCustomer(archetypeId) {
    const c = content();
    if (c.archetypes.length === 0) return err('no customer archetypes exist');

    const arch = archetypeId
      ? c.byId.archetypes[archetypeId]
      : this.rng.weighted(c.archetypes, 'spawn_weight');
    if (!arch) return err(`no archetype "${archetypeId}"`);

    // They arrive from somewhere, rather than appearing in the middle of the
    // farm. `approach.off` is off the tile grid entirely, so the first leg of
    // the walk is in from nowhere — see `pathTo`'s `from`.
    const approach = this.rng.pick(this.layout.approaches ?? [
      { ...this.layout.spawn, off: this.layout.spawn },
    ]);

    const id = `c${this.nextCustomerId++}`;
    const cust = {
      id,
      archetype_id: arch.id,
      x: approach.off.x + this.rng.float(-0.7, 0.7),
      z: approach.off.z + this.rng.float(-0.7, 0.7),
      facing: 0,
      color: arch.color,
      state: 'ENTER',
      path: null,
      basket: [],
      budget: this.rng.float(arch.budget_min, arch.budget_max),
      wantCount: this.rng.int(arch.basket_min, arch.basket_max),
      patience: arch.patience,
      waited: 0,
      mood: 1,
      storming: false,
      visited: [],
      targetShelf: null,
      till: null,
      wantHint: null,
    };
    this.customers[id] = cust;
    this.pathTo(cust, { x: this.layout.door.x, z: this.layout.door.z - 1 }, approach);
    return ok({ id, archetype: arch.id });
  }

  /**
   * Route `entity` to `goal`, optionally starting the route somewhere it isn't.
   *
   * `from` exists because a shopper walking on from off the map is standing
   * where there are no tiles, and A* has nothing to expand out of. So the route
   * is computed from the edge tile they're heading for, and that tile is
   * prepended — the walk in from nowhere is just the first leg.
   */
  pathTo(entity, goal, from = null) {
    const path = findPath(this.walk, this.layout, from ?? entity, goal);
    entity.path = path ?? [];
    if (path && from) entity.path.unshift({ x: from.x, z: from.z });
    return path !== null;
  }

  stepCustomers(dt, c, folded) {
    for (const cust of Object.values(this.customers)) {
      const arch = c.byId.archetypes[cust.archetype_id];
      if (!arch) { this.despawn(cust); continue; }
      if (this.stepMood(cust, dt)) continue;   // walked out; already heading for the door

      switch (cust.state) {
        case 'ENTER':
          if (followPath(cust, CUSTOMER_SPEED, dt)) cust.state = 'BROWSE';
          break;

        case 'BROWSE':
          this.chooseShelf(cust, arch, c, folded);
          break;

        case 'WALK':
          if (followPath(cust, CUSTOMER_SPEED, dt)) cust.state = 'TAKE';
          break;

        case 'TAKE':
          this.takeFromShelf(cust, arch, c, folded);
          break;

        case 'TO_TILL':
          if (followPath(cust, CUSTOMER_SPEED, dt)) cust.state = 'QUEUE';
          break;

        case 'QUEUE':
          this.stepQueue(cust, dt);
          break;

        case 'LEAVE':
          if (followPath(cust, CUSTOMER_SPEED * (cust.storming ? STORM_SPEED : 1), dt)) this.despawn(cust);
          break;

        default:
          this.despawn(cust);
      }
    }
  }

  /**
   * Spend patience on whatever is currently wrong. Returns true if they just
   * walked out, so the caller skips the rest of their tick.
   *
   * Only the queue used to cost anything, which left two holes. The line
   * *shuffles* — `leaveShop` puts everyone behind the sale back into `TO_TILL`
   * and only `stepQueue` charged for waiting, so most of a busy queue's wait
   * was free. And a shop with nothing anyone wanted on its shelves annoyed
   * nobody at all: they left, `leftEmpty` went up, and their mood was still 1.
   */
  stepMood(cust, dt) {
    // Not yet through the door, or already on their way out.
    if (cust.state === 'ENTER' || cust.state === 'LEAVE') return false;

    let annoy = ANNOY_IN_SHOP;
    // `till` is set the moment a slot is claimed, so walking up the line costs
    // the same as standing in it.
    if (cust.till) annoy += ANNOY_LINE;

    cust.mood = clamp(cust.mood - (annoy / cust.patience) * dt, 0, 1);
    if (cust.mood > 0) return false;
    this.stormOut(cust);
    return true;
  }

  /**
   * Out of patience. Deliberately not just `leaveShop`: the basket is
   * abandoned, the door swings harder than a queue timeout used to be worth
   * (it can now happen to someone who never reached the line), and `storming`
   * makes the walk itself read as temper rather than as a finished shop.
   */
  stormOut(cust) {
    const name = content().byId.archetypes[cust.archetype_id]?.name ?? 'customer';
    const had = cust.basket.length;
    this.stats.abandoned++;
    this.reputation = clamp(this.reputation - 0.03, 0, 1);
    this.pushLog(had
      ? `A ${name} lost patience and stormed out — ${had} item${had === 1 ? '' : 's'} abandoned.`
      : `A ${name} lost patience and stormed out.`);
    cust.basket = [];
    cust.storming = true;
    this.leaveShop(cust);
  }

  chooseShelf(cust, arch, c, folded) {
    // Done shopping?
    if (cust.basket.length >= cust.wantCount) return this.goToTill(cust);

    // Fuming: not walking to one more shelf. Someone still empty-handed has
    // nothing to lose by leaving now; someone holding goods would rather pay
    // and get out, and will storm out of the line itself if it comes to that.
    if (cust.mood < MOOD_FUMING) {
      return cust.basket.length ? this.goToTill(cust) : this.stormOut(cust);
    }

    const ranked = rankShelves({
      shelves: this.layout.shelves.filter((s) => !cust.visited.includes(s.id)),
      items: c.byId.items,
      archetype: arch,
      folded,
      season: this.season,
      reputation: this.reputation,
    }).filter(({ shelf, item }) => {
      const inBasket = cust.basket.reduce((s, b) => s + b.price, 0);
      return shelf.price + inBasket <= cust.budget;
    });

    if (ranked.length === 0) {
      // Nothing here they want. If they found nothing at all, they leave
      // annoyed — that's the signal your shelves are wrong.
      if (cust.basket.length === 0) {
        // Walking out empty-handed is a much stronger signal than a happy sale,
        // so it moves reputation harder — otherwise a busy shop can post
        // great numbers while quietly failing a third of its customers.
        this.reputation = clamp(this.reputation - 0.015, 0, 1);
        this.stats.leftEmpty++;
        return this.leaveShop(cust);
      }
      return this.goToTill(cust);
    }

    const target = ranked[0];
    cust.targetShelf = target.shelf.id;
    cust.wantHint = target.item.id;
    cust.state = 'WALK';
    if (!this.pathTo(cust, target.shelf.browseAt)) {
      cust.visited.push(target.shelf.id);
      cust.state = 'BROWSE';
    }
  }

  takeFromShelf(cust, arch, c, folded) {
    const shelf = this.layout.shelves.find((s) => s.id === cust.targetShelf);
    cust.visited.push(cust.targetShelf);
    cust.state = 'BROWSE';
    cust.wantHint = null;

    if (!shelf || !shelf.item_id || shelf.qty <= 0) {
      // `rankShelves` only ever aims them at a stocked shelf, so getting here
      // means somebody took the last one while this shopper was walking over.
      // A wasted trip is the shop being thin, not the shopper being unlucky.
      cust.mood = clamp(cust.mood - ANNOY_EMPTY_SHELF, 0, 1);
      return;
    }
    const item = c.byId.items[shelf.item_id];
    if (!item) return;

    const chance = purchaseChance({
      item, archetype: arch, price: shelf.price, folded,
      season: this.season, reputation: this.reputation,
    });

    // Shoppers take a small run of the same thing rather than exactly one.
    // A shelf is only ever visited once, so one-unit-per-shelf capped every
    // basket at the shelf count and left people leaving with far less than
    // they came for. Each extra unit has to pass its own roll and stay inside
    // the budget, so a weak match still only yields one.
    const room = () => cust.wantCount - cust.basket.length;
    const spent = () => cust.basket.reduce((s, b) => s + b.price, 0);
    const maxRun = Math.min(MAX_UNITS_PER_SHELF, room(), shelf.qty);

    for (let n = 0; n < maxRun; n++) {
      if (spent() + shelf.price > cust.budget) break;
      if (this.rng.next() >= chance) break;
      shelf.qty--;
      cust.basket.push({ item_id: item.id, price: shelf.price });
      // NOTE: item_id is deliberately left set when qty hits 0, so the shelf
      // keeps its label and players/bots know what to restock it with.
    }
  }

  goToTill(cust) {
    if (cust.basket.length === 0) return this.leaveShop(cust);

    // Join the shortest queue.
    const tills = this.layout.checkouts;
    if (tills.length === 0) return this.leaveShop(cust);
    for (const t of tills) t.queue = t.queue ?? [];
    const till = tills.reduce((a, b) => (a.queue.length <= b.queue.length ? a : b));

    till.queue.push(cust.id);
    cust.till = till.id;
    cust.state = 'TO_TILL';
    cust.waited = 0;

    const slot = Math.min(till.queue.length - 1, till.queueMax ?? Infinity);
    const goal = {
      x: till.serveAt.x + till.queueDir.x * slot,
      z: till.serveAt.z + till.queueDir.z * slot,
    };
    if (!this.pathTo(cust, goal)) this.leaveShop(cust);
  }

  stepQueue(cust, dt) {
    // Still counted, but only to tell auto-serve that this one has settled into
    // their slot. Patience itself is spent in `stepMood`, which also charges
    // for the walk up the line.
    cust.waited += dt;

    const till = this.layout.checkouts.find((t) => t.id === cust.till);
    if (!till) return this.leaveShop(cust);

    // "Front" means the first shopper actually standing in their slot — the
    // ones ahead who are still walking must not hold up the till.
    const isFront = till.queue
      .map((id) => this.customers[id])
      .find((cu) => cu && cu.state === 'QUEUE') === cust;

    // Auto-serve exists so headless balance runs don't need a human at the till.
    if (isFront && this.autoServe && cust.waited > 1.5) {
      return this.completeSale(cust);
    }
  }

  /** Called when a player serves the front of a queue. */
  serve(playerId, tillId) {
    const p = this.players[playerId];
    const till = this.layout.checkouts.find((t) => t.id === tillId);
    if (!p || !till) return err('no such till');
    if (!near(p, till, 2.2)) return err('too far from the till');
    if (!till.queue?.length) return err('nobody waiting');

    // Serve the first shopper who has actually reached their slot. Insisting on
    // queue[0] stalls the whole line whenever the front is still shuffling
    // forward after the last sale — the till sits idle with people waiting.
    const cust = till.queue
      .map((id) => this.customers[id])
      .find((cu) => cu && cu.state === 'QUEUE');
    if (!cust) return err('nobody ready to pay');
    const total = this.completeSale(cust);
    return ok({ served: cust.id, total });
  }

  completeSale(cust) {
    const total = cust.basket.reduce((s, b) => s + b.price, 0);
    // The money lands on the counter as a physical thing someone has to pick
    // up. Headless balance runs bank it straight away — a drop nobody collects
    // would read as a broken economy rather than an uncollected till.
    if (this.autoServe) {
      this.cash += total;
      this.stats.revenue += total;
    } else {
      this.dropCash(cust, total);
    }
    this.stats.sold += cust.basket.length;
    for (const line of cust.basket) {
      this.stats.byItem[line.item_id] = (this.stats.byItem[line.item_id] ?? 0) + 1;
    }
    // Happy customers nudge reputation up; a long wait blunts that.
    this.reputation = clamp(this.reputation + 0.004 * cust.mood, 0, 1);
    cust.basket = [];
    this.leaveShop(cust);
    return round2(total);
  }

  // -------------------------------------------------------------------------
  // Cash on the counter
  // -------------------------------------------------------------------------

  /** Leave a takeable pile of money where the sale happened. */
  dropCash(cust, amount) {
    if (amount <= 0) return;
    const till = this.layout.checkouts.find((t) => t.id === cust.till) ?? this.layout.checkouts[0];
    const at = till?.serveAt ?? cust;
    // Fan successive piles across the counter — stacked at one point they read
    // as a single sale no matter how many are waiting.
    const n = this.nextCashId;
    const spread = [[0, 0], [0.3, 0.16], [-0.28, 0.2], [0.16, -0.22], [-0.18, -0.16]][n % 5];

    this.cashDrops.push({
      id: `cash-${this.nextCashId++}`,
      // Nudge onto the till itself so the pile reads as "on the counter"
      // rather than standing in the queue.
      x: (till ? till.x : at.x) + spread[0],
      z: (till ? till.z : at.z) + spread[1],
      amount: round2(amount),
      bornDay: this.day,
      bornAt: this.elapsed,
    });
  }

  /** Anyone standing close enough scoops up the till. */
  collectCash(entity) {
    if (!this.cashDrops.length) return 0;
    let taken = 0;
    this.cashDrops = this.cashDrops.filter((d) => {
      // Money has to be visible for a beat before it can be swept up — the
      // clerk stands on the till, so without this a sale never renders.
      if (this.elapsed - (d.bornAt ?? 0) < CASH_MIN_LIFE) return true;
      if (Math.hypot(d.x - entity.x, d.z - entity.z) > CASH_REACH) return true;
      taken += d.amount;
      return false;
    });
    if (taken > 0) {
      this.cash += taken;
      this.stats.revenue += taken;
    }
    return round2(taken);
  }

  /**
   * Humans scoop up money just by walking over it. Staff don't collect here —
   * a clerk parked on the till would empty it the instant a sale landed, so
   * they pick up through their own job loop, on their own cooldown.
   */
  stepCashPickup() {
    if (!this.cashDrops.length) return;
    for (const p of Object.values(this.players)) {
      if (!p.staff) this.collectCash(p);
    }
  }

  leaveShop(cust) {
    const till = this.layout.checkouts.find((t) => t.id === cust.till);
    if (till?.queue) {
      till.queue = till.queue.filter((id) => id !== cust.id);
      // Everyone behind shuffles forward.
      till.queue.forEach((id, i) => {
        const other = this.customers[id];
        if (!other || other.state !== 'QUEUE') return;
        const slot = Math.min(i, till.queueMax ?? Infinity);
        this.pathTo(other, {
          x: till.serveAt.x + till.queueDir.x * slot,
          z: till.serveAt.z + till.queueDir.z * slot,
        });
        other.state = 'TO_TILL';
      });
    }
    cust.till = null;
    cust.state = 'LEAVE';

    // Home is a fresh edge of the map, not the one they came in by — everyone
    // filing back out the same corner reads as a conveyor belt. The off-map leg
    // is only appended when a route actually exists; if they're walled in,
    // despawning where they stand is still better than walking through a wall.
    const out = this.rng.pick(this.layout.approaches ?? [this.layout.spawn]);
    if (this.pathTo(cust, out) && out.off) cust.path.push({ ...out.off });
  }

  despawn(cust) {
    delete this.customers[cust.id];
  }

  // -------------------------------------------------------------------------
  // Context-sensitive interact — one call does everything, based on proximity.
  //
  // NOT what the game client uses any more: players arm an action by standing
  // near something and commit to it by holding (see stepActions). This is the
  // one-shot version, kept because it's a genuinely useful API surface — an
  // agent or a curl can say "do the sensible thing here" without simulating a
  // press. It deliberately skips the charge-up.
  // -------------------------------------------------------------------------

  interact(playerId, hint = {}) {
    const p = this.players[playerId];
    if (!p) return err('no such player');

    // 1. A till with someone waiting always wins — that's money on the table.
    const till = this.nearest(this.layout.checkouts, p, 2.2);
    if (till?.queue?.length) return this.serve(playerId, till.id);

    // 2. A pallet at the bay -> load up, or put down what you're holding.
    //    Checked before shelves because the bay sits outside, where there's
    //    nothing else to interact with.
    const pallet = this.nearest(this.deliveries, p, UNLOAD_REACH);
    if (pallet && (!p.carry || p.carry.item_id === pallet.item_id)) {
      return this.unload(playerId, pallet.id);
    }
    if (p.carry && near(p, this.layout.bay, BAY_REACH)) return this.stow(playerId);

    // 3. An appliance: take the finished product, or tip in what you're holding.
    const station = this.nearest(this.layout.stations ?? [], p, REACH, (o) => o.useAt);
    if (station) {
      if (station.output) return this.collectStation(playerId, station.id);
      if (p.carry) return this.loadStation(playerId, station.id);
      if (station.making) return err(`${station.station} is still going`);
    }

    // 4. Holding stock next to a shelf -> stock it.
    const shelf = this.nearest(this.layout.shelves, p, REACH, (s) => s.browseAt);
    if (shelf && p.carry) return this.stockShelf(playerId, shelf.id);

    // 5. A plot: harvest if ready, turn it if it's turf, otherwise sow.
    const plot = this.nearest(this.layout.plots, p, REACH);
    if (plot) {
      if (plot.ready) return this.harvest(playerId, plot.id);
      if (!plot.crop_id && plot.soil !== 'tilled') return this.till(playerId, plot.id);
      if (!plot.crop_id && hint.crop_id) return this.plant(playerId, plot.id, hint.crop_id);
      if (!plot.crop_id) return err('pick a seed first');
      return err(`${Math.round(this.plotGrowth(plot) * 100)}% grown`);
    }

    if (shelf) return err('nothing in hand to stock');
    return err('nothing here');
  }

  nearest(list, p, radius, accessor = (o) => o) {
    let best = null;
    let bestD = radius;
    for (const o of list) {
      const t = accessor(o);
      const d = Math.hypot(t.x - p.x, t.z - p.z);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  pushLog(msg) {
    this.log.push({ day: this.day, t: r2(this.time), msg });
    if (this.log.length > 200) this.log.shift();
  }
}

// ---------------------------------------------------------------------------

function freshStats() {
  return {
    revenue: 0, spent: 0, sold: 0, abandoned: 0,
    spoiled: 0, harvested: 0, tilled: 0, leftEmpty: 0, byItem: {},
  };
}

/**
 * Move per-fixture state from the old layout onto the new one.
 *
 * Matches by id first so anything the player positioned by hand keeps its
 * contents no matter where the re-flow puts it in the list, then pairs off
 * whatever's left in order — which is what the generated fixtures need, since
 * their ids are positional.
 */
function carryOver(next, prev, alias, keys, compatible = () => true) {
  const idOf = (o) => alias[o.id] ?? o.id;
  const byId = new Map(prev.map((o) => [idOf(o), o]));
  const usedPrev = new Set();
  const filledNext = new Set();

  for (const n of next) {
    const from = byId.get(n.id);
    if (!from || usedPrev.has(from)) continue;
    usedPrev.add(from);
    filledNext.add(n);
    if (compatible(from, n)) copyKeys(from, n, keys);
  }

  const restPrev = prev.filter((o) => !usedPrev.has(o));
  const restNext = next.filter((o) => !filledNext.has(o));
  for (let i = 0; i < restNext.length && i < restPrev.length; i++) {
    if (!compatible(restPrev[i], restNext[i])) continue;
    copyKeys(restPrev[i], restNext[i], keys);
  }
}

function copyKeys(from, to, keys) {
  for (const k of keys) {
    if (from[k] !== undefined) to[k] = from[k];
  }
}

/**
 * How many of each fixture the shop owns.
 *
 * Stored rather than derived, for two reasons. Build mode has to be able to
 * remove one, which a recount from `ownedUpgrades` can't express. And the old
 * derivation was wrong: it persisted `shelves` as the *total* unit count while
 * separately re-adding the freezer upgrade each boot, so a shop with a freezer
 * grew a phantom shelf on every server restart.
 */
function fixtureLedger(w) {
  const led = w.fixtures ? { ...BASE_FIXTURES, ...w.fixtures } : {
    shelf: BASE_FIXTURES.shelf + countUpgrade(w, 'shelf', 'shelves'),
    freezer: BASE_FIXTURES.freezer + countUpgrade(w, 'freezer', 'freezers'),
    checkout: BASE_FIXTURES.checkout + countUpgrade(w, 'checkout', 'checkouts'),
    plot: BASE_FIXTURES.plot + countUpgrade(w, 'plot', 'plots'),
  };

  // Appliances were upgrade *ownership* — one of each, forever, sited by the
  // generator — until they joined the ledger like everything else you can put
  // down. A save from before that keeps what it bought.
  //
  // The presence of any `station:` key is what says the migration has happened,
  // not the counts: they can all legitimately be zero once you tear the last
  // one out, and re-deriving from `ownedUpgrades` would hand it straight back.
  if (!Object.keys(led).some((k) => k.startsWith('station:'))) {
    const owned = w.ownedUpgrades ?? [];
    for (const u of content().upgrades) {
      if (u.kind !== 'station' || !u.payload?.station) continue;
      if (owned.includes(u.id)) led[ledgerKey('station', { station: u.payload.station })] = 1;
    }
  }
  return led;
}

/**
 * A roster for a save made before there was one.
 *
 * Hiring used to be upgrade ownership, one per role and permanent. Anyone who
 * had bought a staff upgrade keeps that person; the upgrade itself goes inert
 * from here, because two ways to hire is one too many.
 */
function rosterFromUpgrades(w) {
  const owned = w.ownedUpgrades ?? [];
  const kinds = content().byId.workers;
  return content().upgrades
    .filter((u) => u.kind === 'staff' && owned.includes(u.id))
    .map((u) => u.payload?.role)
    .filter((role) => role && kinds[role])
    .map((role, i) => ({
      id: `w${i + 1}`,
      kind: role,
      tier: 1,
      name: kinds[role].name,
      jobs: kinds[role].jobs.map((j) => ({ job: j.job, weight: j.weight })),
    }));
}

/** Sum a payload field across every owned upgrade of a given kind. */
function countUpgrade(w, kind, key) {
  const owned = w.ownedUpgrades ?? [];
  if (owned.length === 0) return 0;
  return content().upgrades
    .filter((u) => u.kind === kind && owned.includes(u.id))
    .reduce((s, u) => s + (u.payload[key] ?? 0), 0);
}

const near = (a, b, radius = REACH) => Math.hypot(a.x - b.x, a.z - b.z) <= radius;
const r2 = (v) => Math.round(v * 100) / 100;
const ok = (data = {}) => ({ ok: true, ...data });
const err = (message) => ({ ok: false, error: message });
