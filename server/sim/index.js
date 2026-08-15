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

import { content, world as loadWorld, saveWorld } from '../content.js';
import { activeModifiers, addModifier, pruneModifiers } from '../db.js';
import { generateLayout, buildWalkGrid, T } from '../layout.js';
import { findPath, followPath } from './pathing.js';
import {
  foldModifiers, rankShelves, purchaseChance, suggestedPrice,
  wholesalePrice, footfall, clamp, round2,
} from './economy.js';
import { spoilRate, requiredFixture, desireFor } from '../../shared/tags.js';
import { makeRng } from '../../shared/rng.js';
import { stepStaff } from './staff.js';
import { FIXTURES, canPlace, rot4, FIXTURE_REFUND } from '../../shared/build.js';

/** Real seconds in one in-game day. */
export const DAY_SECONDS = 360;
export const OPEN_HOUR = 8;
export const CLOSE_HOUR = 20;
const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

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
 * How long each held action takes. Everything used to cost a flat second, which
 * made turning soil feel identical to picking a tomato up. Destructive things
 * are deliberately slower — a long ring is the confirmation dialog.
 */
const ACTION_TIMES = {
  till: 1.7,
  stow: 0.8,
};

/** Fallback prices for building a fixture when no upgrade grants that kind. */
const FALLBACK_FIXTURE_COST = { shelf: 60, freezer: 260, checkout: 300, plot: 40 };

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
  }

  // -------------------------------------------------------------------------
  // Construction / persistence
  // -------------------------------------------------------------------------

  static create({ seed, autoServe = false, ephemeral = false } = {}) {
    const w = loadWorld();
    const useSeed = seed ?? w.seed;
    const fixtures = fixtureLedger(w);
    const placements = w.placements ?? [];
    const grow = w.storeGrow ?? { w: 0, h: 0 };
    const doorShift = w.doorShift ?? 0;
    const layout = generateLayout({
      seed: useSeed,
      shelves: fixtures.shelf,
      freezers: fixtures.freezer,
      checkouts: fixtures.checkout,
      plots: fixtures.plot,
      stations: stationsFor(w),
      placements,
      grow,
      doorShift,
    });

    return new Game({
      seed: String(useSeed),
      day: w.day,
      time: OPEN_HOUR / 24,      // 0..1 through the day
      season: w.season,
      cash: w.cash,
      reputation: w.reputation,
      ownedUpgrades: w.ownedUpgrades ?? [],
      fixtures,
      placements,
      nextFixtureId: w.nextFixtureId ?? 1,
      grow,
      doorShift,
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
      seed: this.seed,
      day: this.day,
      time: this.time,
      season: this.season,
      cash: this.cash,
      reputation: this.reputation,
      ownedUpgrades: this.ownedUpgrades,
      fixtures: this.fixtures,
      placements: this.placements,
      nextFixtureId: this.nextFixtureId,
      grow: this.grow,
      doorShift: this.doorShift,
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
    saveWorld({
      seed: this.seed,
      day: this.day,
      cash: this.cash,
      reputation: this.reputation,
      season: this.season,
      ownedUpgrades: this.ownedUpgrades,
      // The ledger is authoritative. `plots`/`shelves` are only still written
      // so an older build could still boot this save.
      fixtures: this.fixtures,
      placements: this.placements,
      nextFixtureId: this.nextFixtureId,
      storeGrow: this.grow,
      doorShift: this.doorShift,
      plots: this.fixtures.plot,
      shelves: this.fixtures.shelf,
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
      fixtures: this.fixtures,
      players: Object.values(this.players).map((p) => ({
        id: p.id, name: p.name, x: r2(p.x), z: r2(p.z), facing: r2(p.facing),
        carry: p.carry, color: p.color, staff: p.staff ?? null,
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
        mood: r2(c.mood), want: c.wantHint ?? null,
      })),
      shelves: this.layout.shelves.map((s) => ({
        id: s.id, item_id: s.item_id, qty: s.qty, price: r2(s.price), kind: s.kind,
      })),
      plots: this.layout.plots.map((p) => ({
        id: p.id, crop_id: p.crop_id, growth: r2(this.plotGrowth(p)), ready: p.ready,
        soil: p.soil ?? 'untilled',
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
      modifiers: this.currentModifiers().map((m) => ({
        label: m.label || m.source, tag: m.tag,
        demand_mult: r2(m.demand_mult), price_mult: r2(m.price_mult),
      })),
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
      this._modCache = activeModifiers(this.day);
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
    pruneModifiers(this.day);
    this.invalidateModifiers();
    this.spoilStock();
    this.persist();
    this.rng = makeRng(`${this.seed}:${this.day}`);
    this.pushLog(`Day ${this.day} — ${this.season}. Yesterday: $${this.stats.revenue.toFixed(2)} in, ${this.stats.sold} sold, ${this.stats.abandoned} walked out.`);
    // Hand the finished day to whoever is watching (the balance runner reads
    // this, since `stats` is about to be wiped for the new day).
    this._lastDayStats = this.stats;
    this.stats = freshStats();
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
      // Freezers dramatically slow decay.
      const effLife = item.shelf_life_days * (shelf.kind === 'freezer' ? 4 : 1);
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
      if (this.canStand(nx, p.z)) p.x = nx;
      if (this.canStand(p.x, nz)) p.z = nz;
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
    return shelf.qty < item.stack;
  }

  stationWants(station, itemId) {
    return this.recipesFor(station.station)
      .some((r) => r.inputs.some((i) => i.item_id === itemId));
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
    const elapsedMin = (this.elapsed - plot.plantedAt) / 60;
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
    plot.crop_id = cropId;
    plot.plantedAt = this.elapsed;
    plot.ready = false;
    return ok({ planted: cropId });
  }

  harvest(playerId, plotId) {
    const p = this.players[playerId];
    const plot = this.layout.plots.find((x) => x.id === plotId);
    if (!p || !plot) return err('no such plot');
    if (!near(p, plot)) return err('too far from that plot');
    if (!plot.ready) return err('not ready yet');

    const crop = content().byId.crops[plot.crop_id];
    if (!crop) return err('that crop no longer exists');

    const yieldQty = this.rng.int(crop.yield_min, crop.yield_max);
    const cap = this.carryCapacity();

    if (p.carry && p.carry.item_id !== crop.item_id) {
      return err(`hands full of ${p.carry.item_id} — stock it first`);
    }
    const have = p.carry?.qty ?? 0;
    const taken = Math.min(yieldQty, cap - have);
    if (taken <= 0) return err('hands full');

    p.carry = { item_id: crop.item_id, qty: have + taken };
    plot.crop_id = null;
    plot.ready = false;
    plot.plantedAt = 0;
    // Picking a crop exhausts the bed — it needs turning again before the next
    // sowing. This is what gives a field a cycle rather than a single state.
    plot.soil = 'untilled';
    this.stats.harvested += taken;
    return ok({ item_id: crop.item_id, qty: taken, dropped: yieldQty - taken });
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
  ownedStations() {
    return content().upgrades
      .filter((u) => u.kind === 'station' && this.ownedUpgrades.includes(u.id))
      .map((u) => u.payload?.station)
      .filter(Boolean);
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
      st.busyUntil = this.elapsed + (recipe.minutes / (24 * 60)) * DAY_SECONDS;
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

    const room = item.stack - shelf.qty;
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
      plot.crop_id = crop.id;
      // Stagger growth so the fields show every stage at once.
      plot.plantedAt = this.elapsed - (i / this.layout.plots.length) * crop.grow_minutes * 60;
      plot.ready = false;
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
    ];
  }

  findFixture(id) {
    return this.allFixtures().find((f) => f.id === id) ?? null;
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
      plot.crop_id = null;
      plot.ready = false;
      plot.plantedAt = 0;
      plot.soil = 'untilled';
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
  fixtureUnitCost(kind) {
    const key = FIXTURE_PAYLOAD_KEY[kind];
    if (!key) return 0;
    const per = content().upgrades
      .filter((u) => u.kind === kind && (u.payload?.[key] ?? 0) > 0)
      .map((u) => u.cost / u.payload[key]);
    // Priced from content rather than a constant here, so an upgrade added via
    // MCP tomorrow reprices build mode with it and nothing needs recompiling.
    return round2(per.length ? Math.min(...per) : FALLBACK_FIXTURE_COST[kind] ?? 100);
  }

  /** Build-mode prices, for the client's palette. */
  buildCosts() {
    return Object.fromEntries(Object.keys(FIXTURE_PAYLOAD_KEY)
      .map((k) => [k, this.fixtureUnitCost(k)]));
  }

  /** Buy a fixture and site it where you're pointing. */
  placeFixture(playerId, spec = {}) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    if (!p.build?.on) return err('not in build mode');

    const kind = spec.kind;
    if (!FIXTURES[kind] || kind === 'station') return err('you cannot build that');

    const placement = {
      id: `fx-${this.nextFixtureId}`,
      kind,
      x: Math.round(Number(spec.x)),
      z: Math.round(Number(spec.z)),
      rot: rot4(Number(spec.rot) || 0),
    };
    const check = canPlace(this.layout, placement);
    if (!check.ok) return err(check.reason);

    const cost = this.fixtureUnitCost(kind);
    if (this.cash < cost) return err(`need $${cost.toFixed(2)}`);

    this.cash -= cost;
    this.stats.spent += cost;
    this.fixtures[kind] = (this.fixtures[kind] ?? 0) + 1;
    this.nextFixtureId++;
    this.placements.push(placement);
    this.regenerateLayout();
    this.pushLog(`Built a ${FIXTURES[kind].label.toLowerCase()} for $${cost.toFixed(2)}.`);
    return ok({ placed: placement.id, kind, cost: round2(cost) });
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
      station: f.station ?? null,
      rot: f.rot ?? 0,
      label: FIXTURES[f.kind]?.label ?? 'fixture',
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
      station: held.station,
      x: spec.x,
      z: spec.z,
      rot: spec.rot ?? held.rot,
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
    // Try all three other facings before giving up: the next one round is often
    // against a wall, and refusing there would make the button look broken.
    for (let i = 1; i <= 3; i++) {
      const rot = rot4((f.rot ?? 0) + step * i);
      const res = this.repositionFixture(id, {
        kind: f.kind, station: f.station ?? null, x: f.x, z: f.z, rot,
      });
      if (res.ok) return ok({ rotated: res.id, rot });
    }
    return err('nowhere to stand on any other side of it');
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
      station: spec.station ?? null,
      x: Math.round(Number(spec.x)),
      z: Math.round(Number(spec.z)),
      rot: rot4(Number(spec.rot) || 0),
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

    let refund = 0;
    if (f.kind === 'station') {
      const up = content().upgrades.find((u) => u.kind === 'station'
        && u.payload?.station === f.station && this.ownedUpgrades.includes(u.id));
      if (!up) return err("can't work out what that appliance cost");
      this.ownedUpgrades = this.ownedUpgrades.filter((x) => x !== up.id);
      refund = round2(up.cost * FIXTURE_REFUND);
    } else {
      if ((this.fixtures[f.kind] ?? 0) <= 0) return err('nothing to remove');
      this.fixtures[f.kind] -= 1;
      refund = round2(this.fixtureUnitCost(f.kind) * FIXTURE_REFUND);
    }

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

    carryOver(layout.plots, oldPlots, alias, ['soil', 'crop_id', 'plantedAt', 'ready']);

    if (newSeed) this.seed = String(newSeed);
    this.layout = layout;
    this.layoutVersion++;
    this.walk = buildWalkGrid(layout);

    // Everyone mid-path is now walking to somewhere that may not exist.
    for (const cu of Object.values(this.customers)) {
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

    const id = `c${this.nextCustomerId++}`;
    const cust = {
      id,
      archetype_id: arch.id,
      x: this.layout.spawn.x + this.rng.float(-1, 1),
      z: this.layout.spawn.z + this.rng.float(0, 1.5),
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
      visited: [],
      targetShelf: null,
      till: null,
      wantHint: null,
    };
    this.customers[id] = cust;
    this.pathTo(cust, { x: this.layout.door.x, z: this.layout.door.z - 1 });
    return ok({ id, archetype: arch.id });
  }

  pathTo(entity, goal) {
    const path = findPath(this.walk, this.layout, entity, goal);
    entity.path = path ?? [];
    return path !== null;
  }

  stepCustomers(dt, c, folded) {
    for (const cust of Object.values(this.customers)) {
      const arch = c.byId.archetypes[cust.archetype_id];
      if (!arch) { this.despawn(cust); continue; }

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
          if (followPath(cust, CUSTOMER_SPEED, dt)) this.despawn(cust);
          break;

        default:
          this.despawn(cust);
      }
    }
  }

  chooseShelf(cust, arch, c, folded) {
    // Done shopping?
    if (cust.basket.length >= cust.wantCount) return this.goToTill(cust);

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

    if (!shelf || !shelf.item_id || shelf.qty <= 0) return;
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
    cust.waited += dt;
    cust.mood = clamp(1 - cust.waited / cust.patience, 0, 1);

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

    if (cust.waited > cust.patience) {
      // Abandoned basket: stock is lost from the shelf, reputation takes a hit.
      this.stats.abandoned++;
      this.reputation = clamp(this.reputation - 0.02, 0, 1);
      this.pushLog(`A ${content().byId.archetypes[cust.archetype_id]?.name ?? 'customer'} gave up queueing and walked out.`);
      return this.leaveShop(cust);
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
    this.pathTo(cust, this.layout.spawn);
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
  if (w.fixtures) return { ...BASE_FIXTURES, ...w.fixtures };
  return {
    shelf: BASE_FIXTURES.shelf + countUpgrade(w, 'shelf', 'shelves'),
    freezer: BASE_FIXTURES.freezer + countUpgrade(w, 'freezer', 'freezers'),
    checkout: BASE_FIXTURES.checkout + countUpgrade(w, 'checkout', 'checkouts'),
    plot: BASE_FIXTURES.plot + countUpgrade(w, 'plot', 'plots'),
  };
}

/** Appliance kinds owned in a persisted world, for first layout generation. */
function stationsFor(w) {
  const owned = w.ownedUpgrades ?? [];
  return content().upgrades
    .filter((u) => u.kind === 'station' && owned.includes(u.id))
    .map((u) => u.payload?.station)
    .filter(Boolean);
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
