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
import { generateLayout, defaultPads, buildWalkGrid, T } from '../layout.js';
import { E, SOLID, edgeBetween } from '../../shared/edges.js';
import { findPath, followPath } from './pathing.js';
import {
  foldModifiers, modifierMeter, departmentMeter, rankShelves, purchaseChance,
  suggestedPrice, wholesalePrice, footfall, pull, clamp, round2,
} from './economy.js';
import {
  spoilRate, requiredFixture, desireFor, impulsePull, DEPARTMENTS,
} from '../../shared/tags.js';
import { makeRng } from '../../shared/rng.js';
import { stepStaff, breakProgress } from './staff.js';
import {
  FIXTURES, FIXTURE_KINDS, canPlace, rot4, FIXTURE_REFUND,
  canPlaceEdge, canPlaceEdges, edgeRun, isProp, fixturesOf, insideStore, queueLanes,
  canPaintGround, groundStroke, groundIndex, GROUND_STROKE_MAX,
  GROUND, PAD_KINDS, isGround, groundKindOfTile, padCells, isPadAt,
} from '../../shared/build.js';
import { pieceFor, kindOf, defaultPiece, countKey, boardsOf } from '../../shared/pieces.js';

/** Real seconds in one in-game day. */
export const DAY_SECONDS = 360;
export const OPEN_HOUR = 8;
export const CLOSE_HOUR = 20;
/**
 * How much faster the world turns once the shop is shut. The twelve closed
 * hours are 180 real seconds at 1×; at 6× they are 30, which is long enough to
 * put a delivery away and short enough that nobody waits out the sunrise.
 */
const NIGHT_SPEED = 6;
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
/**
 * Most of one thing anybody takes off one shelf in one visit.
 *
 * The list made this look redundant — an errand says "two milks", so why cap it
 * — and it was deleted on that argument. Wrong: the errand bounds what *one*
 * shopper wants, and the cap bounds what one shelf gives up to them. Without it
 * a bulk-shopper drawing `kids:4` empties four units in a single stop, and a
 * busy hour strips the shop faster than anyone can restock. Invisible while
 * reputation was on the floor; the moment footfall came back it read as being
 * raided.
 */
const MAX_UNITS_PER_SHELF = 3;
const CASH_REACH = 1.8;        // how close you stand to scoop up the till
const CASH_MIN_LIFE = 3.5;     // seconds a pile stays put so you can see it

/** Real seconds in one in-game minute. The same conversion a recipe uses. */
const SECONDS_PER_MIN = DAY_SECONDS / (24 * 60);

/**
 * The most catchment a beautiful shop can ever buy, and how much charm gets you
 * half of it. See `Game.charmReach`.
 *
 * A ceiling rather than a rate, because charm is content-authored and unbounded
 * — nothing stops somebody authoring a planter at 20 and standing forty of them
 * in a room. Saturating means the answer to that is "a warehouse full of pot
 * plants is worth about as much as a nice shop", which is correct.
 */
const CHARM_MAX = 8;
const CHARM_HALF = 10;
const UNLOAD_REACH = 1.8;      // how close you stand to unload a pallet

/**
 * How many finished days the save remembers, and how many of them go on the wire.
 *
 * Two numbers rather than one because they answer different questions. Thirty is
 * how far back a report could ever look; seven is what the corner readout draws,
 * and a sparkline of thirty points in 40 pixels is a smudge. Sending the tail
 * rather than the lot keeps a month of history off a 10Hz snapshot.
 */
const LEDGER_DAYS = 30;
const LEDGER_SHOWN = 7;

/**
 * How much of the demand meter's memory survives a day, 0..1.
 *
 * The meter has to read correctly at 08:00, when today has had no shoppers, and
 * it has to stop reading yesterday by mid-afternoon. So it is yesterday's
 * average carried forward at this weight plus today's tally in full — early on
 * the memory is the whole signal, and by evening today outweighs it.
 *
 * Also why it is an average and not a window: a per-day history of twelve
 * departments is an array on the save that has to be capped, migrated and sent,
 * where this is two small objects that cannot grow.
 */
const DEMAND_MEMORY = 0.55;
/**
 * The four tiles touching one. A pad is asked about by cell rather than by
 * distance now (`onPad`), which replaced a `BAY_REACH` of 2.2 — a fair
 * description of a 2x2 pad and a bad one of any other shape.
 */
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const ACTION_TIME = 1.0;       // seconds of standing still before an action fires
/**
 * When a board is worth sending a van for, as a SHARE of what that board holds.
 *
 * It was a flat 2, and it had to stop being one. A unit's capacity is split
 * between the kinds you keep it for, so a shelf kept for three things holds as
 * few as 2 of one of them — and "at or below 2" then describes a board that is
 * completely full. The shop ordered for a shelf it had just filled, for ever,
 * and spent itself broke doing it: a solo shop went from surviving 60 days to
 * bankrupt on day 26, measured, which is the whole reason `simulate` exists.
 *
 * A quarter, because a quarter of the shipped stack of 8 is exactly the 2 this
 * replaces — so a shop where nobody has ticked a second box orders on precisely
 * the schedule it always did, and the constant did not quietly become a tuning
 * change riding along with a feature.
 */
const RESTOCK_FRACTION = 0.25;
/** …and never zero, or a board that holds 2 would have to hit empty first. */
const RESTOCK_MIN = 1;
/**
 * How many batches of a recipe an appliance holds — of ingredients going in and
 * of finished goods coming out alike.
 *
 * An appliance used to hold exactly one batch of each and stop dead: load a
 * coffee machine with one milk and one coffee, and it made one Flat White and
 * then waited for somebody to come and take it. Which meant one chef could
 * never keep even one machine busy, let alone three — every batch cost two
 * fetching trips, a wait and a collection, and the machine was idle for all of
 * them. A hopper is the fix: fill it up and walk away, and it runs itself down
 * while you are somewhere else. That is what a kitchen is *for*.
 *
 * It is also what a station's `capacity_mult` finally reads — the tier ladder
 * carried one since it was authored and nothing had ever looked at it, which is
 * the "a tier that changes no number" trap in CLAUDE.md, sitting in the game.
 */
const STATION_BATCHES = 4;

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
const ANNOY_CROWD = 0.6;       // per whole multiple of capacity over the top
/**
 * One-off, per staple you did not stock. Bigger than a wasted trip to an empty
 * shelf, because this is the thing they came in for and no other shelf in the
 * building answers it — but well short of walking them out on its own, since
 * the sale of everything *else* on the list is still worth making.
 */
const ANNOY_MISSED_STAPLE = 0.2;
/** And what it does to your standing in the town, per staple missed. */
const REP_MISSED_STAPLE = 0.008;

/** How many distinct tags one shopping trip is spread across. */
const MAX_LIST_LINES = 3;
/**
 * How much a shelf being on the list is worth when choosing where to walk.
 *
 * A preference BIASES the ranking; it does not filter it. Filtering is the
 * shape this was first built in and it cost 44–77% of sales on two of three
 * seeds: it marched people to whichever shelf carried the tag however badly it
 * converted, and a wasted trip costs patience *and* strikes a shelf off
 * `visited` whether or not anything is bought. Shoppers ran out of shop before
 * they ran out of list, left empty-handed, and took reputation — and therefore
 * footfall — down with them.
 */
const LIST_BONUS = 1.6;

/**
 * ENDCAPS.
 *
 * An endcap is not a fixture — it is a shelf within `IMPULSE_RADIUS` of the
 * till somebody just queued at. Derived rather than authored, so the rule is
 * "put the sweets by the checkout" and the player finds it by playing.
 *
 * The roll fires ONCE, on joining the queue, and is scaled by how many people
 * are already in the line rather than by how long this shopper waits. That is
 * not a simplification: `simulate`'s bot serves the front of the queue after
 * 1.5s, so a wait-scaled impulse would be invisible to every balance run and
 * land unmeasured. See docs/customers.md.
 */
const IMPULSE_RADIUS = 2.6;    // tiles from the till, so roughly "the end of the aisle"
const IMPULSE_BASE = 0.35;     // scales purchaseChance — an impulse is a weaker pull than an errand
const IMPULSE_PER_AHEAD = 0.2; // ...and a longer line gives you longer to look at it
const IMPULSE_MAX_AHEAD = 3;

/**
 * HOW BIG THE SHOP IS.
 *
 * There was no such number before: the spawner stopped at a flat forty
 * shoppers whether you owned one till or six, so footfall could keep pushing
 * people through a single checkout for ever and nothing anywhere said the shop
 * was full.
 *
 * Capacity is derived from what you own so that *building* is the answer to
 * being too popular. Stocked shelves rather than all shelves, deliberately: an
 * empty shelf is not somewhere to shop, so letting the stock run dry shrinks
 * the shop, which is the compounding the sim should have.
 *
 * Tills dominate, and that ratio is the whole model. Shelves are where people
 * *browse*; the till is the only way anybody leaves, so it sets the rate. A
 * first pass weighted shelves at 1.5 and tills at 6, which made a seventeen-
 * shelf one-till shop hold 31.5 — the turn-away landed at 42, looser than the
 * flat 40 cap it replaced, and a second checkout bought 19% more room for
 * something that nearly doubles how fast the shop empties. Getting that
 * backwards means the funnel everybody is actually stuck in reads as roomy.
 */
const CAPACITY_PER_TILL = 8;
const CAPACITY_PER_SHELF = 0.5;
/** Past this much over capacity, arrivals look in and walk on instead. */
const TURN_AWAY_AT = 1.35;

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
 * A basket as goods rather than as a number.
 *
 * The snapshot used to send `basket.length`, which nothing read, and the
 * consequence was a shopper who lifted a jar off a shelf you could now count
 * the jars on and then carried nothing — the stock left the board and arrived
 * nowhere. Lines are collapsed by item so four of one thing is one entry with
 * a quantity, the same `{item_id, qty}` shape a player's hands already use, so
 * the renderer has one thing to draw and not two.
 *
 * Price is deliberately dropped: what somebody is holding is public, what they
 * are about to be charged for it is not the shopper's business to broadcast.
 */
const basketGoods = (lines) => {
  const by = new Map();
  for (const l of lines) by.set(l.item_id, (by.get(l.item_id) ?? 0) + 1);
  return [...by].map(([item_id, qty]) => ({ item_id, qty }));
};

/**
 * How long each held action takes. Everything used to cost a flat second, which
 * made turning soil feel identical to picking a tomato up. Destructive things
 * are deliberately slower — a long ring is the confirmation dialog.
 */
const ACTION_TIMES = {
  till: 1.7,
  stow: 0.8,
  // What one sale costs the person doing it, before the till's own speed. It
  // was the flat second by omission until a checkout had a ladder worth
  // climbing; naming it is what lets `serveSeconds` divide it.
  serve: 1.0,
};

/**
 * The same sale with the balance bot standing in for you (`autoServe`).
 *
 * Slower than a player deliberately: a headless run must not measure a shop
 * with a perfect clerk welded to every till, or every queue upgrade in the
 * game would read as worthless.
 */
const AUTO_SERVE_TIME = 1.5;

/**
 * What a fixture costs when its catalog row doesn't say.
 *
 * A floor rather than a price list: a kind is buildable whether or not anybody
 * has drawn one, and a shelf that fell out of the catalog must not become free
 * shelving. Content is what actually prices things — see `fixtureUnitCost`.
 */
const FALLBACK_FIXTURE_COST = { shelf: 60, freezer: 260, checkout: 300, plot: 40, station: 200 };

/** How much of a fixture's price a discount deal may ever take off. */
const MAX_FIXTURE_DISCOUNT = 0.6;

/** What a brand new shop is furnished with, before anybody has built anything. */
/**
 * What a shop nobody has opened yet starts with.
 *
 * The freezer went from 0 to 1 the day milk, eggs and soda became chilled
 * goods. Those are the three biggest sellers in the game, and with no freezer
 * to put them in a new shop could not trade its own staples: measured over five
 * seeds it stopped varying at all and sat at a flat loss, which is what a shop
 * that cannot sell anything looks like. A starting freezer is the difference
 * between "buy a cooler early" and "the opening is unwinnable".
 */
const BASE_FIXTURES = { shelf: 6, freezer: 1, checkout: 1, plot: 4 };

/**
 * How many people are within reach of a shop nobody has moved yet — a back
 * lane. In customers per minute at full pull and an average hour, so it reads
 * on the same scale as `footfall` returns.
 *
 * This is the number a `catchment` upgrade raises, and it is deliberately the
 * only way to raise it: the town is not something you can restock your way
 * into. Six shelves is already slightly too much shop for it, which is the
 * intended first lesson.
 */
const BASE_CATCHMENT = 16;

/**
 * What the generator is asked to furnish, for a shop that is already stamped.
 *
 * The placements, counted. Step 4 made every fixture in a stamped shop a
 * placement, which turned `world.fixtures` from a shopping list into a second
 * opinion about a fact — and a second opinion is a thing that drifts. So the
 * question "how many shelves does this shop want" is answered by looking at the
 * shop, and the generator lays nothing of its own because every budget is
 * already spent by the time it gets there.
 *
 * Appliances come back as a list rather than a count because `compose` matches
 * each placement against a named machine: a blender is not a toaster, and the
 * generator has to put the right one back.
 */
function budgetOf(placements) {
  const b = { shelf: 0, freezer: 0, checkout: 0, plot: 0, stations: [] };
  for (const p of placements ?? []) {
    if (p.kind === 'station') b.stations.push(p.station);
    else if (b[p.kind] !== undefined) b[p.kind]++;
  }
  return b;
}

export class Game {
  constructor(state) {
    Object.assign(this, state);
    this.rng = makeRng(`${this.seed}:${this.day}`);
    this.walk = buildWalkGrid(this.layout);
    this.layQueueLanes();
    // Money waiting on a counter for someone to pick it up.
    this.cashDrops = state.cashDrops ?? [];
    /**
     * When each earning fixture last paid out, by placement id.
     *
     * Deliberately NOT saved, and that is the opposite of the obvious choice.
     * These are stamps against `elapsed`, which restarts at zero on every load
     * — so a saved stamp puts the last payout in the *future* and the tree
     * never pays again. `persist` already learned this about `plantedAt` and
     * stores crops as how long they HAVE grown for exactly this reason.
     *
     * The cost of not saving it is that a restart resets the clock, which is
     * at most one payout period. `stepYields` guards the same trap from the
     * other side.
     */
    this.yieldedAt = new Map();
    this.nextCashId = state.nextCashId ?? 1;
    // Pallets waiting at the bay to be unloaded.
    this.deliveries = state.deliveries ?? [];
    this.nextDeliveryId = state.nextDeliveryId ?? 1;
    // Recomputed at the top of every tick; seeded here so anything that reads
    // the world without stepping it first sees an empty shop, not `undefined`.
    this.occupancy = 0;
    this.turningAway = false;
    /**
     * Everything standing in the shop, and where.
     *
     * The only record of it there is. There used to be a second one —
     * `world.fixtures`, a stored count per kind — and it was necessary right up
     * until step 4 stamped the shop: while the generator furnished the place
     * itself, "six shelves" was a number nothing in the world could be read back
     * from. Every fixture is a placement now, so the count is a recount
     * (`fixtureCounts`) and the two can no longer disagree.
     */
    this.placements = state.placements ?? [];
    this.nextFixtureId = state.nextFixtureId ?? 1;
    this.grow = state.grow ?? { w: 0, h: 0 };
    this.doorShift = state.doorShift ?? 0;
    // Walls, windows and doorways the player drew, as an overlay on the shell.
    this.edits = state.edits ?? [];
    /**
     * Ground the player laid, as an overlay — [{x, z, k, p}], `k` the ground
     * KIND and `p` the design of it, both null where they took it back up.
     *
     * The same shape as `edits` and for the same reason: the generator restamps
     * the shell's whole footprint as bare floor on every re-flow, so ground
     * anybody chose has to be re-applied on top of that or buying a shelf
     * repaints the shop.
     *
     * It carries the two yard pads as well as flooring. They were procedural
     * furniture until they moved in here, re-stamped against the back wall on
     * every re-flow, which is why they could never be moved — the shop put them
     * back. `Game.freezeShell` seeds them once and they are ordinary ground
     * from then on. Reads `floors` too, the name this held while floor was the
     * only thing you could paint.
     */
    this.ground = state.ground ?? state.floors ?? [];
    /**
     * Whether the yard has ever been stamped — see `freezeYard`.
     *
     * A mark, not a count. "Does this shop own a bay" answers a different
     * question the moment somebody paints over their last one.
     */
    this.yardStamped = state.yardStamped ?? false;
    /**
     * How big the building is, once somebody has one.
     *
     * Null until a shop has been stamped, then a fact about that shop. See
     * `freezeShell` — the short version is that the size of your building
     * stopped being a function of your shopping list.
     */
    this.shell = state.shell ?? null;
    /**
     * How much of the ordering the shop does without asking, and what that is
     * allowed to cost.
     *
     * The two limits on a stocker's spending used to be `CASH_FLOOR` and
     * `SPEND_FRACTION` in `staff.js` — a floor of $15 and three tenths of
     * whatever sat above it. Both are still there and both are still sensible
     * defaults, but neither is *yours*: nothing on screen said they existed and
     * nothing could change them, so the answer to "stop buying that" was to
     * fire the hire. These three are the same decision made out loud.
     *
     * `auto` is the whole job — off, and staff never order, though they still
     * unload, shelve and tidy what is already in the building. `assign` is
     * narrower and it is the one worth stating precisely: it governs what the
     * shop **buys for a shelf nobody has reserved**, which is `pickItem`
     * choosing for itself. It deliberately does NOT stop a stocker putting an
     * armful onto a bare shelf — that is tidying goods you already paid for,
     * and refusing it would strand your own deliveries on the floor for ever.
     *
     * `budget` is null by default, which means "no cap" rather than "zero" and
     * is why turning none of this on changes no balance number. `spent` is
     * money the STAFF have ordered with today; the player's own purchases out
     * of the supplier panel are never counted, because a cap you set on
     * yourself is a cap you would have to keep raising.
     *
     * `items` is the same three decisions taken one item at a time, keyed by
     * item id — see `itemRule`. Only items you have actually said something
     * about are in here, which is what keeps the save from growing a row per
     * item in the catalogue the first time anybody opens the supplier.
     */
    this.orders = {
      auto: state.orders?.auto ?? true,
      assign: state.orders?.assign ?? true,
      budget: state.orders?.budget ?? null,
      items: state.orders?.items ?? {},
      day: state.orders?.day ?? this.day,
      spent: state.orders?.spent ?? 0,
    };
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
    const placements = w.placements ?? [];
    const grow = w.storeGrow ?? { w: 0, h: 0 };
    const doorShift = w.doorShift ?? 0;
    const edits = w.edits ?? [];
    const ground = w.ground ?? w.floors ?? [];
    const yardStamped = w.yardStamped ?? false;
    const shell = w.shell ?? null;
    // A stamped shop asks for what is standing in it; one nobody has opened yet
    // asks for a starter shop. `starterShop` is the second case only, and it is
    // read at most once per save ever, because `freezeShell` at the bottom of
    // this function stamps the shop before anybody can look at it.
    const want = shell ? budgetOf(placements) : starterShop(w);
    const layout = generateLayout({
      seed: useSeed,
      shelves: want.shelf,
      freezers: want.freezer,
      checkouts: want.checkout,
      plots: want.plot,
      stations: want.stations,
      placements,
      grow,
      doorShift,
      edits,
      ground,
      shell,
    });

    // Derived before the Game is built so the id counter can clear it.
    const roster = w.roster ?? rosterFromUpgrades(w);

    const game = new Game({
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
      // Every day that has finished, and the demand meter's memory of them. A
      // save from before either reads as a shop with no history, which is what
      // it is — the readouts say "not yet" for a day rather than inventing a
      // past, and both fill in on the next rollover.
      ledger: (w.ledger ?? []).slice(-LEDGER_DAYS),
      demand: {
        asked: w.demand?.asked ?? {},
        served: w.demand?.served ?? {},
        moved: w.demand?.moved ?? {},
      },
      // Who actually works here. Derived once from the old staff upgrades for a
      // save that predates the roster, and authoritative from then on.
      roster,
      nextWorkerId: w.nextWorkerId ?? roster.length + 1,
      placements,
      nextFixtureId: w.nextFixtureId ?? 1,
      grow,
      doorShift,
      edits,
      ground,
      yardStamped,
      shell,
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

    // Stamp once, here, so every path into a world goes through it: a fresh
    // shop, an old save, a balance run, a restored room. A migration that only
    // one caller remembers to run is a migration that has already been skipped.
    game.freezeShell();
    // ...and the yard, which stamps on its own mark rather than on `shell`'s —
    // see `freezeYard` for the save this order exists to rescue.
    game.freezeYard();
    // After the stamp, not before: `freezeShell` can re-flow the layout, and
    // restoring onto shelves that are about to be replaced puts the stock back
    // on objects nobody keeps.
    game.restoreContents(w.stock, w.crops);
    return game;
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
      ledger: this.ledger,
      demand: this.demand,
      roster: this.roster,
      nextWorkerId: this.nextWorkerId,
      placements: this.placements,
      nextFixtureId: this.nextFixtureId,
      grow: this.grow,
      doorShift: this.doorShift,
      edits: this.edits,
      ground: this.ground,
      yardStamped: this.yardStamped,
      shell: this.shell,
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
      // Both are written at the day rollover, *before* this runs — see
      // `onNewDay`. Saved after the day they describe rather than during the day
      // that follows, or a restart loses the day you just finished.
      ledger: this.ledger,
      demand: this.demand,
      roster: this.roster,
      nextWorkerId: this.nextWorkerId,
      // `placements` is what the shop *is*. The three counts under it are
      // written and never read back: a build from before step 9 boots a save by
      // way of `fixtureLedger`, and handed nothing it would furnish someone's
      // sixteen-shelf shop with six. Derived on the way out, so they cannot go
      // stale the way a stored ledger could.
      placements: this.placements,
      fixtures: legacyLedger(this.placements),
      nextFixtureId: this.nextFixtureId,
      storeGrow: this.grow,
      doorShift: this.doorShift,
      edits: this.edits,
      ground: this.ground,
      yardStamped: this.yardStamped,
      shell: this.shell,
      // Settings and the day's running total together, because the total is
      // only meaningful beside the day it belongs to — see `staffSpentToday`.
      orders: this.orders,
      plots: budgetOf(this.placements).plot,
      shelves: budgetOf(this.placements).shelf,
      // What is ON the shop, as opposed to what the shop IS. The save held
      // placements and never their contents, so every restart — and
      // `dev:server` runs under `node --watch`, so every edit to `server/` is a
      // restart — emptied every shelf and unplanted every bed. The shop looked
      // untouched, which is exactly why it read as a mystery rather than a
      // reload. Keyed by fixture id, the same key `carryOver` re-homes stock on
      // during a re-flow.
      // A shelf with nothing on it is still worth saving once it has been set
      // aside for something: the reservation is the half a restart would
      // otherwise quietly drop, and it would present as the stocker refilling
      // your freezer aisle with whatever it fancied.
      stock: this.layout.shelves
        .filter((s) => this.shelfStacks(s).length || s.assigned?.length || s.priority)
        .map((s) => ({
          id: s.id,
          // Every board, each with its own price and its own clock. Saved as a
          // list rather than as the four loose fields it replaced, and read back
          // by `restoreContents`, which still accepts the old shape — a save
          // written before this is a shop somebody is mid-game in.
          stacks: this.shelfStacks(s).map((k) => ({
            item_id: k.item_id, qty: k.qty, price: k.price, stockedDay: k.stockedDay ?? 0,
          })),
          assigned: s.assigned ?? [], priority: s.priority ?? 0,
        })),
      crops: this.layout.plots
        .filter((p) => p.crop_id || p.soil !== 'untilled')
        .map((p) => ({
          id: p.id,
          soil: p.soil,
          crop_id: p.crop_id,
          ready: p.ready,
          yield: p.yield ?? null,
          // How long it HAS grown, not when it was planted: `plantedAt` is
          // measured against `elapsed`, which restarts at zero, so a stamp
          // saved raw would put every bed's sowing in the future and freeze it
          // half-grown for ever.
          grown: round2(Math.max(0, this.elapsed - (p.plantedAt ?? 0))),
        })),
    });
  }

  /**
   * Put the shelves and beds back after a restart. Anything whose fixture is no
   * longer there is dropped on the floor rather than restored onto nothing —
   * a shelf you sold between sessions should not resurrect with its stock.
   */
  restoreContents(stock, crops) {
    for (const row of stock ?? []) {
      const shelf = this.layout.shelves.find((s) => s.id === row.id);
      if (!shelf) continue;
      // A row written before a unit could hold two things carries the four loose
      // fields and a single `assigned`. Read as one board's worth and one
      // reservation rather than migrated, the same bargain `kindOf` and
      // `shell.z` strike: an old save, an old export and a fresh seed all agree
      // with nothing to run. Somebody is mid-game in one of these.
      shelf.stacks = Array.isArray(row.stacks)
        ? row.stacks.map((k) => ({
          item_id: k.item_id, qty: k.qty, price: k.price, stockedDay: k.stockedDay ?? 0,
        }))
        : (row.item_id
          ? [{
            item_id: row.item_id, qty: row.qty, price: row.price, stockedDay: row.stockedDay ?? 0,
          }]
          : []);
      shelf.assigned = toList(row.assigned);
      shelf.priority = row.priority ?? 0;
    }
    for (const row of crops ?? []) {
      const plot = this.layout.plots.find((p) => p.id === row.id);
      if (!plot) continue;
      plot.soil = row.soil;
      plot.crop_id = row.crop_id;
      plot.ready = row.ready;
      if (row.yield != null) plot.yield = row.yield;
      plot.plantedAt = -(row.grown ?? 0);
    }
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
      // The two halves of "how is it going in there right now". Reputation is
      // the shop's slow memory; these are today. `occupancy` is sent as a raw
      // ratio rather than a percentage of the turn-away line, because the HUD
      // is not the only thing that will ever want to know how full it is.
      mood: round2(this.shopMood()),
      occupancy: round2(this.occupancy),
      turnAwayAt: TURN_AWAY_AT,
      // The town, and what share of it you're getting. Sent as the two terms
      // rather than the product because they mean opposite things to a player:
      // catchment is what you buy, pull is what you earn.
      catchment: this.catchment(),
      pull: round2(pull({ reputation: this.reputation, folded: this.folded() })),
      isOpen: this.isOpen(),
      layoutVersion: this.layoutVersion,
      stats: this.stats,
      // The upgrades panel needs this to grey out what you already own, and
      // the palette needs it to know which deals you have bought — a discount
      // has to show on the button before you press it, or the price you are
      // quoted and the price you pay are two different numbers.
      ownedUpgrades: this.ownedUpgrades,
      roster: this.roster,
      // What the shop does without asking, plus how much of today's cap the
      // staff have used — the supplier draws all four, and `left` is the half
      // that makes a cap something you can watch rather than only set.
      orders: {
        ...this.orders,
        spent: round2(this.staffSpentToday()),
        left: this.orders.budget > 0 ? round2(this.orderBudgetLeft()) : null,
      },
      // How many of each thing is standing in the shop, under the name the
      // palette calls it. Keyed by *piece* throughout, which the old stored
      // ledger could not be — see `fixtureCounts`.
      fixtures: this.fixtureCounts(),
      players: Object.values(this.players).map((p) => ({
        id: p.id, name: p.name, x: r2(p.x), z: r2(p.z), facing: r2(p.facing),
        carry: p.carry, color: p.color, staff: p.staff ?? null,
        // ...and where it could go, so an armful of tomatoes points at the
        // shelves that would have it rather than making you walk the shop
        // trying each one. Only for a human: staff already know, and five
        // hires carrying five things would be recomputed ten times a second
        // for a marker nobody draws.
        takers: !p.staff && p.carry ? this.stockTargets(p.carry.item_id) : null,
        // Which roster row this body belongs to, and which rung it is on. The
        // roster says who works here and this says what they are up to; without
        // a key the UI can only join them by reconstructing `staff-${id}`,
        // which makes an id format a protocol.
        hire: p.hire ?? null,
        tier: p.tier ?? null,
        // Which look they have on. Rides beside `tier` because the two together
        // are exactly what decides the body the client builds — see `actorKey`.
        skin: p.skin ?? null,
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
        // Sent from the tick it arms, before there is any progress on it, so
        // the client can light the target up and name what is about to happen.
        // `progress` is the whole story now that nothing gates the charge: if
        // it's moving, this is going to fire unless you walk away.
        action: p.action
          ? {
            kind: p.action.kind,
            target: p.action.target,
            label: p.action.label,
            at: p.action.at ? { x: r2(p.action.at.x), z: r2(p.action.at.z) } : null,
            progress: r2(Math.min(1, p.action.elapsed / (p.action.time || ACTION_TIME))),
          }
          : null,
      })),
      customers: Object.values(this.customers).map((c) => ({
        id: c.id, x: r2(c.x), z: r2(c.z), facing: r2(c.facing),
        color: c.color, state: c.state,
        // What is in their arms, which after the till is what they PAID for —
        // `bought`. Goods that vanished at the counter would read as the sale
        // eating them, and someone walking out with their shopping is the only
        // frame in which a shop looks like it worked. A basket abandoned on the
        // way out leaves both empty, because they put it all back.
        basket: basketGoods(c.basket.length ? c.basket : (c.bought ?? [])),
        mood: r2(c.mood), anger: r2(angerOf(c)), want: c.wantHint ?? null,
      })),
      shelves: this.layout.shelves.map((s) => ({
        id: s.id, kind: s.kind,
        // Every board, in board order, each with its own price — which is why
        // the price control in the menu had to move down onto the row it prices.
        //
        // `cap` rides along because BOTH clients were working it out for
        // themselves off the item, the tier and the share count, and the
        // renderer needs it too now that it draws how full a board looks rather
        // than one facing per unit. Three spellings of one division is how a
        // shelf starts disagreeing with the menu describing it — the sim
        // enforces this number, so the sim says what it is.
        stacks: this.shelfStacks(s).map((k) => {
          const item = content().byId.items[k.item_id];
          return {
            item_id: k.item_id, qty: k.qty, price: r2(k.price),
            cap: item ? this.shelfCapacity(s, item) : k.qty,
          };
        }),
        // How many kinds it may hold, so the menu can grey the boxes once you
        // have ticked as many as it has boards. Sent rather than worked out
        // client-side: it comes off the model at this fixture's tier, and the
        // client would need the whole ladder to ask.
        boards: this.shelfBoards(s),
        // What it is *for* and where it sits in the restock queue. Both ride the
        // snapshot rather than the layout, because they change while the shop
        // stands still — a menu reading them off the layout would show the shelf
        // you set aside ten seconds ago as still taking anything.
        assigned: s.assigned ?? [], priority: s.priority ?? 0,
        // Whether shoppers can see it, so the menu can say which it is. Two
        // units of the same design differ only by this, and nothing about the
        // model shows it — without it on the wire the button has no state.
        boh: s.boh === true,
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
        // How many batches it holds, so the menu can draw "2 / 8" against a
        // hopper rather than "2". A number, not the caps themselves: the client
        // already has every recipe, so it can do the same multiplication the
        // server does, and it is one field instead of one per ingredient. Only
        // the tier's `capacity_mult` was ever missing over there.
        batches: this.stationBatches(s),
        progress: s.making
          ? r2(Math.min(1, 1 - (s.busyUntil - this.elapsed) / Math.max(0.001, s.busyUntil - (s.startedAt ?? s.busyUntil - 1))))
          : 0,
      })),
      // Folded to one net number per tag. Not the HUD meter any more — that is
      // `departments` below — but still what the supplier's heat pills and the
      // to-do chips read, and it should stay the same numbers the economy
      // charges against rather than a second opinion about the same events.
      modifiers: modifierMeter(this.folded()),
      // The demand meter: one row per department, always all of them, always in
      // the same order. See `departmentMeter` for what the sign means.
      departments: departmentMeter({
        ...this.demandNow(),
        boards: this.departmentBoards(),
        folded: this.folded(),
      }),
      // The last week of finished days, oldest first, so the corner readout can
      // say whether today is better than yesterday and draw the shape of the
      // week. Only the tail: a month of history on a 10Hz snapshot is a month of
      // history sent six hundred times a minute.
      ledger: this.ledger.slice(-LEDGER_SHOWN),
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
    // Once the doors are shut the clock runs on. Twelve closed hours is half of
    // every day, and at 1× that is three real minutes of standing in an empty
    // shop waiting for the sun — far more time than restocking has ever needed.
    //
    // The night is compressed rather than skipped, and the line is drawn at
    // legs: **time-passage scales, bodies don't.** `elapsed` scales, so crops
    // grow and appliances finish by exactly as much over a night as they always
    // did, just sooner — neither has any motion to look wrong.
    //
    // Staff were briefly on the scaled clock, on the theory that they are the
    // night passing as much as the crops are. They are not: they have legs, and
    // six hires sprinting round a shut shop reads as a physics bug rather than
    // as a time-lapse. They walk and work at their own pace, so a shorter night
    // is genuinely less overnight restocking — if that starts leaving shelves
    // bare at opening, the number to change is NIGHT_SPEED, not the staff.
    const world = dt * (this.isOpen() ? 1 : NIGHT_SPEED);

    this.elapsed += world;
    const prevDay = this.day;

    this.time += world / DAY_SECONDS;
    while (this.time >= 1) {
      this.time -= 1;
      this.day++;
    }
    if (this.day !== prevDay) this.onNewDay();

    const c = content();
    const folded = this.folded();

    this.stepPlayers(dt);
    // The *world's* delta, not the tick's: a roofed bed holds its clock still by
    // moving `plantedAt` along with `elapsed`, and `elapsed` runs on the scaled
    // night clock. Handed `dt` it would drift forward every night.
    this.stepCrops(world);
    // Once per tick, before the two things that read it. Both the crowd
    // everyone inside is fed up with and the queue an arrival balks at have to
    // be the *same* number, or the shop turns people away over a crush its own
    // shoppers aren't feeling.
    this.occupancy = this.measureOccupancy();
    this.stepCustomers(dt, c, folded);
    this.stepSpawning(dt, c, folded);
    stepStaff(this, dt);
    // Before the pickup, so a payout is collectable on the tick after it lands
    // rather than the one after that. `CASH_MIN_LIFE` is what stops it being
    // swept the instant it appears.
    this.stepYields();
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
    // Housekeeping, and only a real game's to do. An ephemeral run shares the
    // live world's id, so this line is `simulate` deleting the world events of
    // the shop it was only supposed to be measuring — sixty simulated days
    // expire every modifier the director has written, permanently. `ephemeral`
    // already covers `persist()`; this was the other write, and it hid because
    // `activeModifiers` filters by day itself, so no run has ever needed it.
    //
    // It also made a balance run unrepeatable, which is how it was found: the
    // first `simulate` against a fresh `VACUUM INTO` copy measures a shop with
    // the modifiers, every run after it measures a shop without them, and one
    // measured seed came back 9305 / 6723 / 25 on identical code.
    if (!this.ephemeral) pruneModifiers(this.day, this.worldId);
    this.invalidateModifiers();
    this.spoilStock();
    this.payWages();
    // Before `persist`, and after the last thing that touches the day's money —
    // `payWages` is it, since `spoilStock` counts units rather than cash. File
    // the finished day the other side of the save and a restart drops it.
    this.closeLedger();
    this.rollDemand();
    this.persist();
    this.rng = makeRng(`${this.seed}:${this.day}`);
    // Turned-away only appears once it has happened, because a shop that isn't
    // full shouldn't have to read a zero every morning to find that out.
    const turned = this.stats.turnedAway
      ? `, ${this.stats.turnedAway} turned away at the door`
      : '';
    this.pushLog(`Day ${this.day} — ${this.season}. Yesterday: $${this.stats.revenue.toFixed(2)} in, ${this.stats.sold} sold, ${this.stats.abandoned} walked out${turned}.`);
    // Hand the finished day to whoever is watching (the balance runner reads
    // this, since `stats` is about to be wiped for the new day).
    this._lastDayStats = this.stats;
    this.stats = freshStats();
  }

  /**
   * File the day that just ended, so tomorrow has something to compare against.
   *
   * `this.day` has already moved on by the time `onNewDay` runs — it is called
   * *because* it moved — so the row being closed is the day before it.
   */
  closeLedger() {
    this.ledger.push({
      day: this.day - 1,
      revenue: round2(this.stats.revenue),
      spent: round2(this.stats.spent),
    });
    if (this.ledger.length > LEDGER_DAYS) this.ledger = this.ledger.slice(-LEDGER_DAYS);
  }

  /**
   * Fold today's asks into the demand meter's memory.
   *
   * A true running average of finished days, so what it holds is "asks on a
   * normal day here" and stays in that unit however many days pass. A tag that
   * has faded below noticing is dropped rather than kept at 0.001 forever — the
   * vocabulary grows every time somebody authors an archetype, and a map that
   * only ever gains keys is a save that only ever gets bigger.
   */
  rollDemand() {
    const roll = (memory, today) => {
      const out = {};
      for (const tag of new Set([...Object.keys(memory), ...Object.keys(today)])) {
        const v = round2((memory[tag] ?? 0) * DEMAND_MEMORY + (today[tag] ?? 0) * (1 - DEMAND_MEMORY));
        if (v >= 0.05) out[tag] = v;
      }
      return out;
    };
    this.demand = {
      asked: roll(this.demand.asked, this.stats.asked),
      served: roll(this.demand.served, this.stats.served),
      moved: roll(this.demand.moved, this.stats.moved),
    };
  }

  /**
   * What the town is asking of you, as the meter should read it right now.
   *
   * A normal day here plus today so far. Both halves go on both sides, which is
   * the only thing that has to be true: the meter divides asks by fills and
   * compares one department's share against another's, so the *scale* is free as
   * long as it is the same scale on the top and the bottom. That is why the
   * result is an index rather than a count of shoppers, and why nothing hands it
   * to the client to print.
   *
   * The alternative — read today only — is a meter that is blank at 08:00 and
   * built on four shoppers at 09:00, which is the shuffling it exists to fix.
   */
  demandNow() {
    const add = (memory, today) => {
      const out = { ...memory };
      for (const [tag, n] of Object.entries(today)) out[tag] = (out[tag] ?? 0) + n;
      return out;
    };
    return {
      asked: add(this.demand.asked, this.stats.asked),
      served: add(this.demand.served, this.stats.served),
      moved: add(this.demand.moved, this.stats.moved),
    };
  }

  /**
   * How many shelf boards are given over to each department.
   *
   * By *board*, because that is the unit of shelf space a player allocates — a
   * unit holding milk and cheese has committed one board to dairy and one to
   * dairy again, and a unit holding forty tins has committed one board to
   * pantry, not forty. Counting units of stock instead would call a well-kept
   * full aisle an overstock, which is the whole reason the meter's left half is
   * measured this way. See `departmentMeter`.
   *
   * A board that is *labelled* and empty does not count, and getting that wrong
   * inverted the meter. The bar's left half asks "is this space earning?", and an
   * empty board is not failing to earn — it has nothing on it to earn with.
   * Counting them read a department that people ask for and you have run out of
   * as *overstocked*, which is the opposite of what it needs to say, and it is
   * the more common state of the two: a bare shelf keeps its label on purpose
   * (see `stockShelf`). Bare shelves are the to-do chip's job, not this meter's.
   */
  departmentBoards() {
    const items = content().byId.items;
    const out = {};
    for (const shelf of this.layout.shelves) {
      for (const stack of this.shelfStacks(shelf)) {
        if (!(stack.qty > 0)) continue;
        const item = items[stack.item_id];
        if (!item) continue;
        for (const tag of item.tags) {
          if (DEPARTMENTS.includes(tag)) out[tag] = (out[tag] ?? 0) + 1;
        }
      }
    }
    return out;
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
      // Board by board, and each against its OWN clock. One clock per fixture
      // would mean the cheese you put out on Monday going off on Thursday
      // because somebody topped up the milk beside it on Wednesday — which is
      // the whole argument for `stockedDay` living on the stack.
      for (const stack of [...this.shelfStacks(shelf)]) {
        if (!stack.item_id || stack.qty <= 0) continue;
        const item = items[stack.item_id];
        if (!item) continue;
        const rate = spoilRate(item);
        if (rate <= 0) continue;
        // Freezers dramatically slow decay, and a better one slows it further —
        // `keeps_mult` is the tier's contribution on top of that.
        const effLife = item.shelf_life_days
          * (shelf.kind === 'freezer' ? 4 : 1)
          * this.fixtureStats(shelf).keeps_mult;
        const age = this.day - stack.stockedDay;
        if (age > effLife) {
          const lost = stack.qty;
          // The board goes; the reservation stays. Binning a shelf of milk is
          // not a decision to stop selling milk there — leaving `assigned` alone
          // is what sends the stocker back with more of it. Removing the stack
          // rather than zeroing it is what frees the board for something else,
          // and it is why `shelfShares` reads the reservation first: a shop kept
          // for three things must not re-share itself every time one rots.
          this.clearStack(shelf, stack.item_id);
          this.stats.spoiled += lost;
          this.pushLog(`${lost}x ${item.name} spoiled and was binned.`);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Players
  // -------------------------------------------------------------------------

  stepPlayers(dt) {
    for (const p of Object.values(this.players)) {
      // Staff are players — same entity, same `players` map, which is what lets
      // every action take a player id and work for either. They are NOT moved
      // here. `stepStaff` walks them at `speedOf`, their authored speed scaled
      // by tier and how worn out they are; falling through to the line below
      // moved them a second time in the same tick, at PLAYER_SPEED, which is
      // 4.2 against a worker's 2.6. Two movers, and the wrong one setting the
      // pace: hires crossed the shop faster than the person who hired them and
      // no authored `speed` made any difference, because most of the distance
      // was not coming from it.
      if (p.staff) continue;

      const { dx = 0, dz = 0 } = p.input ?? {};
      const steering = dx !== 0 || dz !== 0;

      // Steering outranks a walk order, always, and cancels it on the first
      // frame of input rather than fighting it. A key that only slowed the
      // route down would read as the game ignoring you — and this is the whole
      // reason the two schemes can share a player: you take the wheel by
      // touching it, and there is never a moment where both are driving.
      if (steering) { p.path = null; p.errand = null; }
      if (!moving(p)) continue;

      // A routed walk is the same mover customers and staff are: A* planned it
      // against `this.walk`, which is the grid `canStand` reads, so there is no
      // second opinion about where a person may be. `canWalk` is not consulted
      // per step because the route already crossed no solid edge — checking
      // again would only ever disagree by rounding, and disagreeing means
      // stopping dead in a doorway.
      if (!steering) {
        if (followPath(p, PLAYER_SPEED * this.speedMult(), dt)) p.path = null;
        continue;
      }

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
  // Actions
  //
  // **Anything that moves goods into or out of your hands is named.** You point
  // at the thing, you walk there, and it happens when you arrive — see
  // `errandAction`. Proximity keeps only the two jobs that move no goods: a till
  // with somebody waiting, and turning a rough bed over. Money is not in this
  // list at all; it is scooped up by walking (`stepCashPickup`).
  //
  // It was the other way round for a long time, and the reasoning was sound
  // until it met a shop with things in it. Proximity armed everything and the
  // ring made it safe: an action takes a second, the target lights up, and
  // walking away throws the charge away, so you said no by not standing there.
  // Pickups came out first, because proximity can only ever offer the *nearest*
  // pallet, which at a bay stacked three deep is not a choice anybody made.
  //
  // Putting things down is the same bug pointing the other way, and worse,
  // because you are already holding something when it fires. An aisle is a row
  // of shelves on a three-tile pitch: stop anywhere in it with an armful and one
  // of them takes it, and which one was a question about where your feet
  // happened to be. Carrying stock across your own shop stopped being possible.
  // The patches that fell out of it are the tell — `stowLock`, then `tookFrom` —
  // both of them latches holding off an action nobody had asked for, and both
  // gone now, because an errand is spent when it fires and nothing re-arms.
  //
  // What is left of proximity is the ring, which every named action still winds:
  // arriving arms it, a second passes, and leaving before it closes is still how
  // you change your mind. The tap says *what*; the ring still says *when*.
  // -------------------------------------------------------------------------

  stepActions(dt) {
    for (const p of Object.values(this.players)) {
      if (p.staff) continue;              // hires drive themselves

      // Standing still is half of "standing next to it", and it was missing.
      //
      // ACTION_TIME is a second and crossing a REACH takes about three quarters
      // of one, so the arithmetic said a walk-past could not fire. The
      // arithmetic is about the straight line through the middle: clip the edge
      // of the circle, turn, slow down at a corner, or walk *along* an aisle of
      // shelves and you are in range of one thing or another for as long as you
      // like. So goods got picked up, tills got served and beds got harvested by
      // people who were on their way somewhere else — and a pickup you did not
      // ask for fills your hands, which then refuses you everything.
      //
      // Stopping is the consent, and it is the same consent leaving throws away:
      // the charge is dropped exactly as if you had walked out of reach, because
      // from the action's point of view you did. It costs nothing anybody wanted
      // — every route ends stopped at the working spot, which is where the tap
      // was aiming the whole time, and the errand still fires the moment you
      // arrive. What it removes is the only class of action in the game that
      // happened *to* you.
      //
      // Read after `stepPlayers` has moved everyone this tick, or arriving would
      // spend a tick still looking like walking.
      if (moving(p)) { p.action = null; p.actionBlocked = null; continue; }

      const candidate = this.actionFor(p);

      // Nothing in range, or the target changed out from under us. Either way
      // the charge starts again from zero next time — walking off mid-ring is
      // how you decline, so it must never bank.
      if (!candidate) { p.action = null; continue; }

      // A refusal that nothing has changed since must not wind another ring.
      //
      // `actionFor` is a fresh guess every tick, so an action that refuses for
      // a standing reason — hands full of the same thing you are stood over,
      // a board that will not take what you are holding — was armed again the
      // instant it failed, and the ring wound, and failed, for as long as you
      // stood there. Nothing said why: `actionBlocked` was written and never
      // read by anything, so what a player saw was a shop endlessly charging
      // an action that never happened.
      //
      // The latch is (what, on what, holding what), and it is dropped the
      // moment you MOVE — walking away and coming back is how you say "try
      // that again", the same gesture that already declines a ring in progress.
      // Your hands are in the key because they are the other half of most
      // refusals, so putting something down re-offers it without a walk.
      const held = p.carry ? `${p.carry.item_id}:${p.carry.qty}` : '';
      const stop = p.actionBlocked;
      if (stop && stop.kind === candidate.kind
          && stop.target === candidate.target && stop.held === held) {
        p.action = null;
        continue;
      }
      if (!p.action || p.action.kind !== candidate.kind || p.action.target !== candidate.target) {
        p.action = { ...candidate, elapsed: 0 };
      }

      p.action.elapsed += dt;
      if (p.action.elapsed < (p.action.time || ACTION_TIME)) continue;

      const res = candidate.run();
      p.action = null;
      if (!res?.ok) {
        p.actionBlocked = { kind: candidate.kind, target: candidate.target, held, why: res?.error ?? null };
        // Said once, here, for every action rather than only for the one that
        // was asked for by name — a ring that winds and does nothing is a
        // button that looks broken whether or not you pressed it. Once is what
        // the latch above buys: this used to be a line a second.
        if (res?.error) this.pushLog(res.error);
      } else {
        p.actionBlocked = null;
      }
    }
  }

  /**
   * The single thing you would do here, or null.
   *
   * Two sources, and the order between them is the whole scheme: what you
   * *named* first, then the short list of jobs proximity is still allowed to
   * offer. That list is short on purpose — a till with somebody at it, and a
   * bed that wants turning. Neither one touches your hands, which is the test:
   * nothing is picked up or put down that was not pointed at.
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

    // What you *asked for* outranks everything standing here would offer, and
    // it is the only entry in this list that is not a guess about what you
    // meant. See `errandAction`.
    const named = this.errandAction(p);
    if (named) return named;

    const till = this.nearest(this.layout.checkouts, p, 2.2);
    if (till?.queue?.length
        && till.queue.some((id) => this.customers[id]?.state === 'QUEUE')) {
      return {
        kind: 'serve', target: till.id, label: 'Serve', time: this.serveSeconds(till), at: till,
        run: () => this.serve(p.id, till.id),
      };
    }

    const plot = this.nearest(this.layout.plots, p, REACH);
    // Seed goes into broken soil, never into turf, so turning it over is a job
    // standing here can do. Turf costs nothing to break and nothing to put
    // back, and it moves no goods either way, which is what makes it the one
    // thing besides a waiting till that is safe to fire on its own.
    if (plot && !plot.crop_id && plot.soil !== 'tilled') {
      return {
        kind: 'till', target: plot.id, label: 'Till the soil', time: ACTION_TIMES.till, at: plot,
        run: () => this.till(p.id, plot.id),
      };
    }
    // Sowing is not here, and neither is harvesting any more. A seed is a
    // purchase, and a purchase you did not choose is one you keep making —
    // stand at a bed, pay, walk to the next bed, pay. A ripe bed is the same
    // objection wearing the opposite sign: picking it fills your hands, and
    // full hands refuse you everything else. Both are a tap on the bed now.
    return null;
  }

  /**
   * What this particular thing would do for you, or null.
   *
   * Split out from `actionFor` when naming a target became the rule rather than
   * the exception. It is the same list of jobs, asked as "what would *this*
   * do" instead of "what is nearest" — which is the only question that has an
   * answer in an aisle where three shelves are always in reach at once.
   *
   * It does not check reach and it does not check whether the job will be
   * accepted. Reach belongs to the caller (arriving is what arms it), and a
   * named job that cannot be done should be armed and then *refused out loud*:
   * you pointed at that freezer, so "bread needs a freezer" is the answer you
   * are owed. Guessing silently is what proximity did.
   */
  actionAt(p, f, itemId = null) {
    const at = workSpot(f);

    if (f.kind === 'shelf' || f.kind === 'freezer') {
      // A board named by item is a Take — that is the shelf menu's button, and
      // it outranks stocking so that topping your hands up off a board still
      // works while you are holding some of the same thing.
      if (itemId) {
        return { kind: 'take', target: f.id, label: 'Take it', at, run: () => this.unshelve(p.id, f.id, itemId) };
      }
      if (p.carry) {
        return { kind: 'stock', target: f.id, label: 'Stock', at, run: () => this.stockShelf(p.id, f.id) };
      }
      return null;
    }

    if (f.kind === 'station') {
      if (f.output && (!p.carry || p.carry.item_id === f.output.item_id)) {
        return { kind: 'collect', target: f.id, label: 'Collect', at, run: () => this.collectStation(p.id, f.id) };
      }
      if (p.carry) {
        return { kind: 'load', target: f.id, label: 'Load', at, run: () => this.loadStation(p.id, f.id) };
      }
      return null;
    }

    if (f.kind === 'plot') {
      if (f.ready) {
        return { kind: 'harvest', target: f.id, label: 'Harvest', at, run: () => this.harvest(p.id, f.id) };
      }
      if (!f.crop_id && f.soil !== 'tilled') {
        return {
          kind: 'till', target: f.id, label: 'Till the soil', time: ACTION_TIMES.till, at,
          run: () => this.till(p.id, f.id),
        };
      }
      return null;
    }

    // A till only ever offers the one job, and only while somebody is standing
    // at it — the same test proximity makes, because serving is the one action
    // a player never has to name and this is just the other way to reach it.
    if (f.kind === 'checkout') {
      const waiting = f.queue?.some((id) => this.customers[id]?.state === 'QUEUE');
      if (waiting) return { kind: 'serve', target: f.id, label: 'Serve', at, run: () => this.serve(p.id, f.id) };
      return null;
    }

    // A decoration is a thing you aim at in build mode and nothing else.
    return null;
  }

  /**
   * The job you named, once you are close enough to do it.
   *
   * An errand is a target and nothing else — no progress, no timer. It arms
   * the ordinary charge when you get there, so a named job looks and cancels
   * exactly like every other action: the ring winds in, the thing lights up,
   * and walking off before it closes throws it away. What the naming buys is
   * that it is *that* crate, *that* board and *that* shelf, rather than
   * whichever happened to be nearest a pair of feet.
   *
   * Three kinds of address, because there are three kinds of thing you can
   * point at: a crate on the floor by its own id, a fixture by its id, and the
   * drop-off, which is ground and has no id at all. The pad is why the errand
   * is `{ at, itemId }` rather than a fixture id — `'pad'` is a place, and the
   * one target in the shop that is a region rather than an object.
   *
   * It is spent whether or not it worked — a refusal ("hands full of something
   * else") must not sit here retrying every tick against the same full hands.
   * That is also what retired the two latches this scheme used to need: nothing
   * re-arms, so there is no loop for `stowLock` or `tookFrom` to break.
   * The refusal is *said*, by `stepActions`, along with every other one.
   */
  errandAction(p) {
    const e = p.errand;
    if (!e) return null;
    const spend = (fn) => { p.errand = null; return fn(); };

    // The drop-off. Not an object, so reach is the pad's own five-tile test
    // rather than a distance to a point — see `onPad`.
    if (e.at === 'pad') {
      const pad = this.dropPad();
      if (!pad) { p.errand = null; return null; }
      if (!this.onPad(p, this.dropPadKind())) return null;
      return {
        kind: 'stow', target: 'drop', label: 'Put back', time: ACTION_TIMES.stow, at: pad,
        run: () => spend(() => this.stow(p.id)),
      };
    }

    const crate = this.deliveries.find((d) => d.id === e.at);
    if (crate) {
      if (!near(p, crate, UNLOAD_REACH)) return null;
      return {
        kind: 'unload', target: crate.id, label: 'Take it', at: crate,
        run: () => spend(() => this.unload(p.id, crate.id)),
      };
    }

    const f = this.findFixture(e.at);
    // Somebody else got there first, a stocker tidied the crate away, or the
    // shelf was sold back. There is nothing left to walk to, so stop pointing.
    if (!f) { p.errand = null; return null; }
    if (!near(p, workSpot(f))) return null;

    const act = this.actionAt(p, f, e.itemId);
    // It offered something when you set off and offers nothing now — the bed
    // was picked, the tray was collected. Not a refusal, just gone.
    if (!act) { p.errand = null; return null; }
    return { ...act, run: () => spend(act.run) };
  }

  /**
   * Say what you are going to pick up, and set off to get it.
   *
   * One verb for a crate and a shelf board, because they are the same errand
   * with a different address: go there, fill your hands from that pile. The
   * walk is part of it — a menu button that filled your arms from across the
   * shop would be the supplier-as-vending-machine bug again (see `buyStock`),
   * where the shop floor stops mattering because the goods come to you.
   *
   * Kept as its own verb even though `walkToFixture` now names an errand for
   * anything you point at, because this is the one case that names a *board*:
   * a shelf holding three things is three piles at one address, and only the
   * menu can say which of them you meant.
   */
  take(playerId, { palletId = null, shelfId = null, itemId = null } = {}) {
    const p = this.players[playerId];
    if (!p) return err('no such player');

    const target = palletId
      ? this.deliveries.find((d) => d.id === palletId)
      : this.layout.shelves.find((s) => s.id === shelfId);
    if (!target) return err('nothing there to take');

    // Refused *before* the errand is set, so a shelf behind a wall you have not
    // put a door in yet leaves you where you stand with nothing pending, rather
    // than committed to a walk that never happens.
    const spot = target.browseAt ?? target;
    const walk = this.walkTo(playerId, spot.x, spot.z);
    if (!walk.ok) return walk;

    p.errand = { at: palletId ?? shelfId, itemId: palletId ? null : itemId };
    return ok({ walking: walk.steps });
  }

  /** Would this shelf take that item right now? */
  shelfAccepts(shelf, itemId) {
    const item = content().byId.items[itemId];
    if (!item) return false;
    if (requiredFixture(item) === 'freezer' && shelf.kind !== 'freezer') return false;
    // A reservation binds even when the shelf is bare — that is the whole
    // difference between it and a board that merely happens to hold something.
    // A LIST of reservations binds the same way: ticking three boxes says these
    // three and nothing else, not "these three as well as whatever turns up".
    const kept = toList(shelf.assigned);
    if (kept.length && !kept.includes(itemId)) return false;
    // Room for another KIND is now a separate question from room for another
    // unit, and it has to be asked first: a shelf with every board taken is
    // full for a fourth thing while still having space on all three.
    if (!this.shelfHasRoomFor(shelf, itemId)) return false;
    return (this.shelfStack(shelf, itemId)?.qty ?? 0) < this.shelfCapacity(shelf, item);
  }

  /**
   * Everything standing in the shop that would take what you are holding.
   *
   * Answered here rather than on the client, and that is the same call the
   * build ghost makes for the opposite reason. The ghost has to *predict*, so
   * it shares a validator; this has nothing to predict — the shop already
   * knows — and the four things that decide it (a freezer's cold, a shelf set
   * aside, a label with stock still under it, how much room is left at this
   * tier) are four facts the client would need shipping to it before it could
   * even ask. One array of ids is smaller than any of them.
   *
   * Appliances are in here too, because "where can this go" is a question
   * about the shop and not about shelving: a blender that wants tomatoes is a
   * place tomatoes can go. The drop-off pad deliberately is not — it takes
   * anything, always, so marking it says nothing you did not already know.
   */
  stockTargets(itemId) {
    if (!itemId) return null;
    return [
      ...this.layout.shelves.filter((s) => this.shelfAccepts(s, itemId)),
      ...(this.layout.stations ?? []).filter((st) => this.stationWants(st, itemId)),
    ].map((f) => f.id);
  }

  /**
   * Which shelves want stock, most urgent first.
   *
   * The rule lives here rather than inside the stocker's job because it is a
   * rule about the shop — it is what the player set when they marked a shelf —
   * and a second copy of it in `staff.js` would be the half that quietly
   * disagreed with the menu.
   *
   * Priority sorts *before* emptiness rather than adjusting it. "Fill this one
   * first" is a decision about which shelf gets the next van, not a claim that
   * a shelf with four on it is somehow emptier than a shelf with one.
   */
  restockQueue() {
    // Thin per BOARD rather than per unit, and that is the difference between a
    // queue that works and one that starves. A shelf kept for three things with
    // two of them full is not a shelf that needs nothing — it is a shelf with an
    // empty board on it — and measuring the whole fixture would mean the third
    // thing never arriving until the other two had sold through.
    // How far below its own line a board is, as a ratio: 0 is empty, 1 is at the
    // line, above 1 needs nothing. A ratio rather than a count because the line
    // is per board now — see RESTOCK_FRACTION.
    const items = content().byId.items;
    const lineFor = (s, itemId) => {
      const item = items[itemId];
      if (!item) return RESTOCK_MIN;
      return Math.max(RESTOCK_MIN, Math.floor(this.shelfCapacity(s, item) * RESTOCK_FRACTION));
    };
    // A board is thin when either the shop-wide rule or the board's own line
    // says so, and the two are measured in different units on purpose: a rule
    // counts what the SHOP holds ("keep 5 eggs"), the line counts what the
    // BOARD holds. Taking the lower ratio of the two means a rule can only ever
    // pull a van forward, never hold one back — the default stays the default
    // for every item nobody has said anything about.
    const ratio = (s, k) => {
      const board = (k.qty ?? 0) / lineFor(s, k.item_id);
      const floor = this.itemRule(k.item_id).min;
      if (!(floor > 0)) return board;
      return Math.min(board, this.itemHeld(k.item_id) / floor);
    };
    const thinnest = (s) => {
      const stacks = this.shelfStacks(s);
      if (!stacks.length) return 0;
      return Math.min(...stacks.map((k) => ratio(s, k)));
    };
    // A board you asked for and have not got. This is a *want*, not a
    // measurement, and it is why it sorts on its own rather than as a thin
    // shelf: a shelf kept for bread with no bread on it and a bare shelf nobody
    // ever mentioned are both "empty", so emptiness alone made them tie — and a
    // tie is settled by whatever order the shelves happen to sit in the layout.
    //
    // Which is exactly the complaint: you tick two boxes, and the shop spends
    // the next six in-game hours buying things for five shelves you said nothing
    // about before it gets to the one you actually asked for. Measured at 3,880
    // ticks and eight vans on the shipped six-shelf shop.
    //
    // `shelfFor` has always known this rule — "a shelf set aside for it first…
    // being asked for beats both" — and it decides where a case that is already
    // in the building goes. Nothing was applying it to the decision one step
    // earlier, which is what the shop chooses to BUY.
    const asked = (s) => toList(s.assigned).filter((id) => !this.shelfStack(s, id)).length;
    return this.layout.shelves
      .map((s) => ({ s, thin: thinnest(s), want: asked(s) }))
      // A shelf with an unfilled reservation is worth a van however full its
      // other boards are — otherwise ticking a third thing onto a well-stocked
      // unit would never be acted on at all.
      .filter(({ thin, want }) => want > 0 || thin <= 1)
      .sort((a, b) => (b.s.priority ?? 0) - (a.s.priority ?? 0)
        // Below the player's own "fill this first", because that one is a direct
        // instruction about order and this is an inference from one.
        || (b.want > 0) - (a.want > 0)
        || a.thin - b.thin)
      .map(({ s }) => s);
  }

  /**
   * How much of an item the shop could shelve without paying for it.
   *
   * Cases on the floor, armfuls in hand, and the beds. The restocker knew about
   * exactly one of these and only as a *scheduling* question — "is there a
   * pallet at the bay I could unload instead of ordering" — which says what to
   * do next tick and nothing about how much to order. So a shelf reserved for
   * carrot, stripped into crates two tiles away, read as bare and bought a full
   * unit; and a shop with four beds of carrots bought carrots at wholesale for
   * ever, which is the farm competing with itself.
   *
   * A growing bed counts in proportion to how grown it is rather than by a
   * ripe/not-ripe cutoff. A cutoff would be a threshold nobody can see and would
   * order a full shelf of carrots six seconds before the harvest lands; scaling
   * by `plotGrowth` means a crop authored at 600 minutes contributes nothing
   * early — which is right, because a shelf held empty against a promise that
   * far off is just a bare shelf.
   */
  homeSupply(itemId) {
    if (!itemId) return 0;
    const crops = content().byId.crops;
    let n = 0;
    for (const d of this.deliveries) if (d.item_id === itemId) n += d.qty ?? 0;
    for (const p of Object.values(this.players)) {
      if (p.carry?.item_id === itemId) n += p.carry.qty ?? 0;
    }
    for (const plot of this.layout.plots) {
      if (!plot.crop_id) continue;
      const crop = crops[plot.crop_id];
      if (crop?.item_id !== itemId) continue;
      const grown = plot.ready ? 1 : this.plotGrowth(plot);
      n += Math.floor((plot.yield || crop.yield_min || 0) * grown);
    }
    return n;
  }

  /**
   * What the staff have spent ordering today, rolling the counter over lazily.
   *
   * The reset is here rather than in `onNewDay` on purpose, and it is the same
   * argument `lastDirectorDay` makes about claiming its guard synchronously: a
   * counter that is only cleared by one code path is a counter that is wrong
   * every time the day changes some *other* way. A save loaded on a later day,
   * a `set_time` jump, a sixty-day balance run — each of those is a day
   * rollover the tick loop did not perform. Asking "is this counter about the
   * day we are actually in" at the moment of reading cannot miss any of them.
   */
  staffSpentToday() {
    if (this.orders.day !== this.day) {
      this.orders.day = this.day;
      this.orders.spent = 0;
    }
    return this.orders.spent;
  }

  /**
   * What the player has said about ordering ONE item.
   *
   * Three fields, all optional, and the two numbers are about **the whole shop**
   * rather than about a board. That is the difference between this and the
   * shelf's own settings, and it is why the two do not fight: a shelf says where
   * a thing goes and how much of that unit it may take; a rule says how many
   * eggs you want to own. "Keep 5, never more than 20" is a sentence about eggs,
   * and no board can express it — a shop with three egg shelves would mean it
   * three times over.
   *
   * `min` outranks the 25% board line rather than replacing it: a board is thin
   * when EITHER says so, because a rule is a floor you asked for and the line is
   * the default for everything you have not.
   */
  itemRule(itemId) {
    return this.orders.items?.[itemId] ?? {};
  }

  /** How many of an item are standing on the shop's shelves right now. */
  itemHeld(itemId) {
    let n = 0;
    for (const s of this.layout.shelves) n += this.shelfStack(s, itemId)?.qty ?? 0;
    return n;
  }

  /**
   * Change the rule for one item. An absent field is left alone; an explicit
   * null clears it, which is how "no minimum" is said out loud.
   *
   * A rule that says nothing is deleted rather than stored as three nulls, so
   * "has this item been given a rule" stays a key test — that is what the
   * supplier's badge asks, and a row of nulls would light every badge in the
   * catalogue the first time you nudged a number and put it back.
   */
  setItemRule(itemId, patch) {
    if (!content().byId.items[itemId]) return err('no such item');
    if (!patch || typeof patch !== 'object') return err('nothing to set');
    const rule = { ...this.itemRule(itemId) };

    if (patch.auto !== undefined) {
      if (patch.auto === null || patch.auto === true) delete rule.auto;
      else rule.auto = false;
    }
    for (const key of ['min', 'max']) {
      if (patch[key] === undefined) continue;
      const n = Number(patch[key]);
      if (patch[key] === null || !Number.isFinite(n) || n <= 0) delete rule[key];
      else rule[key] = Math.min(Math.round(n), 999);
    }
    // A max under a min is a rule that can never be satisfied, and the shop
    // would sit forever below a floor it is not allowed to reach. Whichever
    // one you just moved is the one you meant, so the other gives way.
    if (rule.min > 0 && rule.max > 0 && rule.max < rule.min) {
      if (patch.max !== undefined) rule.min = rule.max; else rule.max = rule.min;
    }

    const items = { ...this.orders.items };
    if (Object.keys(rule).length) items[itemId] = rule; else delete items[itemId];
    this.orders.items = items;
    this.persist();
    return ok({ itemId, rule });
  }

  /** What is left of the cap, or Infinity where the player has not set one. */
  orderBudgetLeft() {
    const cap = this.orders.budget;
    if (!(cap > 0)) return Infinity;
    return Math.max(0, cap - this.staffSpentToday());
  }

  noteStaffSpend(cost) {
    this.staffSpentToday();
    this.orders.spent = round2(this.orders.spent + cost);
  }

  /**
   * Change what the shop does on its own.
   *
   * Each field is optional and absent means "leave it alone", so the three rows
   * in the supplier are three independent presses rather than one form that
   * has to send the other two back unchanged — which is the same race the
   * `assign` message avoids by carrying `on`.
   */
  setOrders(patch) {
    if (!patch || typeof patch !== 'object') return err('nothing to set');
    if (patch.auto !== undefined) this.orders.auto = !!patch.auto;
    if (patch.assign !== undefined) this.orders.assign = !!patch.assign;
    if (patch.budget !== undefined) {
      const n = Number(patch.budget);
      // Null, and anything that isn't a positive number, is "no cap". A cap of
      // zero would be a shop that has switched ordering off while still saying
      // it is on, which is a state the two rows would then disagree about.
      this.orders.budget = patch.budget === null || !Number.isFinite(n) || n <= 0
        ? null : round2(Math.min(n, 1e6));
    }
    this.persist();
    return ok({ orders: this.orders });
  }

  // ---- what is on a unit ---------------------------------------------------
  //
  // A unit holds one entry per KIND of thing, capped by how many boards its art
  // draws. These five read that list, and everything else in the sim goes
  // through them rather than touching `stacks` directly — there is one spelling
  // of "how much is on this", and a second one is how a shelf starts disagreeing
  // with the menu that describes it.

  /** Every kind of thing on a unit, its own stack, in board order. */
  shelfStacks(shelf) {
    return shelf?.stacks ?? [];
  }

  /** The stack of one particular item on a unit, or null if it isn't on it. */
  shelfStack(shelf, itemId) {
    return this.shelfStacks(shelf).find((s) => s.item_id === itemId) ?? null;
  }

  /** How much of everything is on it, across every board. */
  shelfQty(shelf) {
    return this.shelfStacks(shelf).reduce((n, s) => n + (s.qty ?? 0), 0);
  }

  /** How many different things it may hold — its boards, read off its art. */
  shelfBoards(shelf) {
    return boardsOf(content().fixtures ?? [], shelf);
  }

  /** Is there a free board, or is this kind already on one? */
  shelfHasRoomFor(shelf, itemId) {
    return !!this.shelfStack(shelf, itemId)
      || this.shelfStacks(shelf).length < this.shelfBoards(shelf);
  }

  /**
   * Take a kind off a unit entirely, freeing its board.
   *
   * Removed rather than left at zero, which is the difference between a board
   * that is empty and a board that is spare: a stack sitting at qty 0 would go
   * on holding a board against the next thing that wanted one, and a shelf that
   * had held three things once could never hold anything again.
   */
  clearStack(shelf, itemId) {
    shelf.stacks = this.shelfStacks(shelf).filter((s) => s.item_id !== itemId);
  }

  /**
   * The board this item is on, opening one if it isn't on the unit yet.
   *
   * Null when every board is taken by something else — the caller's refusal to
   * write, not a silent no-op, because "the shelf is full" and "the shelf has no
   * room for a fourth KIND" are different sentences and the player needs the
   * second one.
   */
  openStack(shelf, item) {
    const have = this.shelfStack(shelf, item.id);
    if (have) return have;
    if (this.shelfStacks(shelf).length >= this.shelfBoards(shelf)) return null;
    const stack = {
      item_id: item.id,
      qty: 0,
      price: suggestedPrice(item, this.folded(), this.season),
      stockedDay: this.day,
    };
    shelf.stacks = [...this.shelfStacks(shelf), stack];
    return stack;
  }

  /**
   * How many ways the unit is being shared, which is what divides its capacity.
   *
   * Everything the unit is committed to: what you TICKED, plus whatever is
   * standing on it that you didn't. The union rather than either one alone, and
   * both halves are load-bearing.
   *
   * The reservations have to count even when the goods have not arrived, or a
   * shelf kept for three things would hold a full stack of the first, and the
   * stocker would fill it to a line that halves the moment the second turns up.
   *
   * The stock has to count even when nothing reserved it, or a unit with milk
   * on it that you then tick for cheese alone would give the cheese a whole
   * unit's worth while the milk sat on the next board — and the total a shelf
   * carries, which is the one number this change promised not to move, would
   * quietly go up every time somebody ticked a box.
   *
   * Never zero. A bare unit reserved for nothing is one share, which is exactly
   * what every shelf in the game was before it could hold two things.
   */
  shelfShares(shelf) {
    const kinds = new Set([
      ...toList(shelf?.assigned),
      ...this.shelfStacks(shelf).map((k) => k.item_id).filter(Boolean),
    ]);
    return Math.max(1, kinds.size);
  }

  /**
   * How many units of an item one board's worth of this shelf holds.
   *
   * The item says how big a stack of it is; the shelf's tier says how much
   * shelving there is to stack it on; and the shares say how much of that
   * shelving THIS kind gets. Dividing rather than multiplying is deliberate and
   * it is the one balance decision in the whole change: a unit holds exactly
   * what it always held, and what ticking a second box buys you is variety
   * rather than volume. The other way round — a full stack per board — triples
   * what a shelving unit carries, and that wants measuring against ten seeds
   * before anybody believes it.
   */
  shelfCapacity(shelf, item) {
    const total = item.stack * this.fixtureStats(shelf).capacity_mult;
    return Math.max(1, Math.floor(total / this.shelfShares(shelf)));
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

  /**
   * How many people are in range of the shop. The back lane, plus whatever
   * better address you have bought your way to.
   *
   * Summed rather than replaced so the ladder is authored as steps ("+18, the
   * high street") instead of absolutes — an absolute would mean buying rungs
   * out of order could make the town smaller.
   */
  catchment() {
    // Charm sits alongside the upgrade rather than inside it: an upgrade is
    // land you bought, charm is a shop worth crossing town for, and they are
    // different sentences that happen to add.
    return BASE_CATCHMENT + countUpgrade(this, 'catchment', 'reach') + this.charmReach();
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

  /**
   * Walk to a tile, the way everything else in the shop already walks.
   *
   * The player was the only mover in the game steering by raw velocity; this
   * makes them one more caller of `pathTo`, so a tap routes round the shelving
   * for free and honours edge walls at plan time rather than bouncing off them
   * a frame at a time.
   *
   * A refused route is a real answer and not an error the HUD should shout
   * about — you tapped the far side of a wall you have not put a door in yet —
   * so it clears the path and says so, leaving you where you stand.
   *
   * Tapping the drop-off with your hands full is the one tile in the shop that
   * means more than "go there", and it has to be, because the drop-off is the
   * only target you can point at that has no id to name: it is painted ground.
   * The tap IS the naming, so it is read here rather than given its own verb —
   * and walking onto the pad any other way puts nothing down, which is the
   * whole change. See `errandAction`.
   */
  walkTo(id, x, z) {
    const p = this.players[id];
    if (!p) return err('no such player');
    // Going somewhere else is changing your mind about the job you named.
    // `take` sets its errand *after* calling this, so it survives its own walk.
    p.errand = null;
    const goal = { x: Math.round(x), z: Math.round(z) };
    if (!this.pathTo(p, goal)) {
      p.path = null;
      return err('No way through to there');
    }
    // A tap on the tile you are already stood on plans a route of no legs, and
    // `pathTo` spells that `[]`. Left as an empty array it is a walk in
    // progress that never progresses — nothing moves, but `p.path` is truthy
    // and every later "am I walking?" has to know that a route can be a lie.
    const steps = p.path.length;
    if (steps === 0) p.path = null;
    // Whatever the stick last said, stop saying it — otherwise a stale vector
    // from the frame before the tap cancels the route on the very next step.
    p.input = { dx: 0, dz: 0 };
    // The tile you tapped, not a tile near it: a pad you walked *past* on your
    // way to the tile behind it is not a pad you asked for. (`onPad` is the
    // looser test, and it belongs on the other end — arriving at the pad you
    // named should not fail for landing one cell off it.)
    const pad = this.dropPadKind();
    if (p.carry && pad && isPadAt(this.layout, pad, goal.x, goal.z)) {
      p.errand = { at: 'pad', itemId: null };
    }
    return ok({ to: goal, steps });
  }

  /**
   * Walk to where you'd *work* a fixture, not to the fixture.
   *
   * A shelf is browsed from one side, and A*'s own fallback — "goal blocked, so
   * aim at any walkable neighbour" — would happily park you behind it, in reach
   * of nothing, which reads as the tap having been ignored. The anchor is the
   * side the thing is used from, the layout already stores it, and the sim's
   * own reach checks already read it (`nearest(..., (s) => s.browseAt)`), so
   * arriving there is arriving armed.
   *
   * Resolved here rather than client-side for the reason the build ghost shares
   * one validator with the server: an anchor worked out twice can disagree with
   * itself, and this one decides whether a tap does anything at all.
   *
   * ...and pointing at a thing is *naming* it. That is the difference between
   * this and tapping the floor beside it: the errand is set here, so what
   * happens when you arrive is what you pointed at, and standing in the same
   * spot having walked there for some other reason does nothing at all. What
   * the errand turns out to be is `actionAt`'s answer, read on arrival rather
   * than now — a bed that ripens while you cross the farm is still a harvest.
   */
  walkToFixture(id, fixtureId) {
    const f = this.findFixture(fixtureId);
    if (!f) return err('no such fixture');
    const spot = workSpot(f);
    const walk = this.walkTo(id, spot.x, spot.z);
    if (!walk.ok) return walk;
    this.players[id].errand = { at: fixtureId, itemId: null };
    return walk;
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

  /**
   * Crops come on, unless somebody has built a roof over them.
   *
   * "Nothing grows indoors" is a sentence the game has said out loud since
   * enclosure arrived — it is the warning you get for walling in your own farm
   * (`whatThisUnroofs`) — and until now nothing whatsoever implemented it. What
   * enforced it was the layout generator DROPPING a roofed bed as a placement it
   * could no longer honour, which is not the same claim at all: one is a crop
   * that stops ripening, the other is your bed and its crop deleted and refunded
   * for the crime of your having drawn a wall nearby. That was half of the bug
   * where knocking one wall through took most of a shop with it, so the drop is
   * gone (`canKeep`, shared/build.js) and this is the half that should always
   * have been here.
   *
   * The clock is *held* rather than reset: `plantedAt` is pushed along by exactly
   * the time that just passed, so `elapsed - plantedAt` doesn't move and a crop
   * three quarters grown is still three quarters grown when you take the roof
   * back off. Resetting would make a wall drawn near the farm destroy a season's
   * growth silently, which is the same class of thing as dropping the bed.
   *
   * A bed that was already ripe stays ripe. It finished; a roof is not a reason
   * to un-harvest something.
   */
  stepCrops(world = 0) {
    for (const plot of this.layout.plots) {
      if (!plot.crop_id) continue;
      if (insideStore(this.layout, plot.x, plot.z)) {
        plot.plantedAt += world;
        continue;
      }
      if (!plot.ready && this.plotGrowth(plot) >= 1) plot.ready = true;
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
      // Nobody is issued a look. Null means "as the kind was drawn", which is a
      // complete bot — so a shop that has never heard of skins is not a shop of
      // undressed robots, and a save written before them reads the same way.
      skin: null,
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
      this.dropGoods(body.carry.item_id, body.carry.qty, this.dropPad());
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

  /**
   * Change what one hire looks like. Free, instant, and reversible.
   *
   * The counterpart to `promote`, and deliberately its opposite in every
   * respect: a promotion costs money and moves numbers, a skin costs nothing
   * and moves none. That is not generosity, it is the same split `variants` and
   * `tiers` make on a fixture — if a look could be paid for it would sooner or
   * later be balanced, and then `simulate` would have to be re-run every time
   * somebody recoloured a robot.
   *
   * Null is a real argument, not a missing one: it puts them back in the
   * factory colours, so there is a way out of every skin without needing a
   * "default" row that could be deleted.
   */
  setSkin(workerId, skinId) {
    const entry = this.roster.find((e) => e.id === workerId);
    if (!entry) return err('nobody by that name works here');
    if (skinId != null && !content().byId.skins[skinId]) return err('no such skin');

    entry.skin = skinId ?? null;
    // `syncStaff` copies this onto the body on the next tick, which is also
    // what makes the change survive a hire who is halfway across the shop.
    this.persist();
    return ok({ worker: workerId, skin: entry.skin });
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
      // Charged against the daily cap here rather than at the call site, so
      // every way a hire can spend money on stock goes past it — `restock` is
      // the only one today and this is the line that keeps that from mattering.
      if (p.staff) this.noteStaffSpend(cost);
      p.carry = { item_id: itemId, qty: have + take };
      return ok({ bought: take, cost: round2(cost) });
    }

    const take = Math.min(qty, item.stack);
    if (take <= 0) return err('order at least one');

    // Physics rather than a consequence, so this one refuses — and it refuses
    // up here with the other refusals, before a penny moves. A wholesaler with
    // nowhere to unload does not deliver into a field, and taking the money for
    // a pallet that then has nowhere to exist is the worst of the three
    // answers. `canPaintGround` warns you before you paint over your last bay,
    // which is where this is meant to be prevented.
    if (!this.layout.bay) return err('nowhere for it to land — lay a delivery bay first');

    const unit = wholesalePrice(item, this.folded(), this.season);
    const cost = unit * take;
    if (this.cash < cost) return err(`need $${cost.toFixed(2)}, you have $${this.cash.toFixed(2)}`);

    this.cash -= cost;
    this.stats.spent += cost;
    if (p.staff) this.noteStaffSpend(cost);

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
   *
   * **A crate holds an armful, and a bigger drop is more crates.** It used to
   * hold any number, because merging was the only defence against a forest of
   * one-unit pallets — so sixteen carrots were one crate wearing "x16", which
   * is a box the size of every other box that four trips could not empty. The
   * cap is what makes the pile mean something: how tall it stands is how much
   * is there, three crates is three trips, and taking one is exactly one
   * armful with nothing left behind in it.
   */
  dropGoods(itemId, qty, at) {
    if (!(qty > 0) || !at) return null;

    // Where a crate may stand.
    //
    // A pad hands over its own cells, so goods fill the area you actually
    // painted: the 2x2 the shop starts with holds four crates, and a back room
    // you floored as storage holds as many as it has tiles. How big your yard
    // is became a decision the day the pads became paintable, and this is the
    // line that gives that decision an effect.
    //
    // Anywhere else — goods off a stripped shelf, an emptied hopper — there is
    // no region, and the crate stands on the tile it was let go of. A crate
    // stands in the MIDDLE of a tile either way: the ±0.9 spread this replaced
    // sat the first one on the seam between two tiles and hung the second a
    // third of a tile off the edge of the pad onto the grass.
    const slots = at.cells?.length
      ? at.cells
      : [{ x: Math.round(at.x), z: Math.round(at.z) }];

    // Top up crates of the same thing already standing in this area rather than
    // building a little forest of one-unit pallets — but only to the brim, which
    // is what stops the merge going the other way and swallowing a whole
    // delivery into one box. Membership rather than a radius, because a radius
    // around one point is the wrong shape for a room — the far end of a big
    // stockroom is still the stockroom.
    const here = (d) => slots.some((s) => s.x === d.x && s.z === d.z)
      || Math.hypot(d.x - at.x, d.z - at.z) <= 2.2;

    const cap = this.crateCapacity();
    let left = Math.round(qty);
    let first = null;

    for (const d of this.deliveries) {
      if (left <= 0) break;
      if (d.item_id !== itemId || !here(d)) continue;
      const room = cap - d.qty;
      if (room <= 0) continue;
      const add = Math.min(room, left);
      d.qty += add;
      left -= add;
      first = first ?? d;
    }

    // Whatever is still in your arms becomes crates of its own, ONE CELL for
    // the lot of them: a delivery is a pallet of a thing, so sixteen carrots
    // are a pile of carrots on a cell rather than three quarters of your bay
    // spoken for by a single order. A free cell is preferred and the counter
    // only decides who shares once the whole pad is full — otherwise the pile
    // is drawn inside whatever was already standing there, and how big you
    // painted the pad would stop meaning anything. What a cell holds is a KIND;
    // how high it stands is how much of it there is.
    const n0 = this.nextDeliveryId;
    const taken = new Set(this.deliveries.map((d) => `${d.x},${d.z}`));
    const spot = slots.find((s) => !taken.has(`${s.x},${s.z}`)) ?? slots[n0 % slots.length];

    while (left > 0) {
      const n = this.nextDeliveryId++;
      const take = Math.min(cap, left);
      const del = {
        id: `del-${n}`,
        item_id: itemId,
        qty: take,
        x: r2(spot.x),
        z: r2(spot.z),
        day: this.day,
      };
      this.deliveries.push(del);
      left -= take;
      first = first ?? del;
    }

    return first;
  }

  /**
   * How much one crate holds: an armful.
   *
   * Deliberately the same number as a pair of hands rather than one of its own.
   * It makes a crate a *trip* — one crate is one carry, taking one leaves
   * nothing behind in it, and a pile of three says three journeys before that
   * pad is clear. A number of its own would be a second unit of "how much is a
   * lot" for the player to learn, and it would drift from the rucksack the day
   * somebody authors one.
   */
  crateCapacity() {
    return this.carryCapacity();
  }

  /**
   * Clear your hands at the drop-off pad.
   *
   * Stocking a shelf used to be the only way to let go of anything, so one
   * armful of the wrong crop could strand you — every shelf claimed, nowhere
   * legal to put it, and no way to pick anything else up.
   *
   * The goods go back into a crate rather than into a bin. Binning at a cost
   * punishes the exact moment a new player is experimenting, and they'd learn
   * to stand there holding it forever instead; leaving it loose on the floor
   * needs a tidy-up system nobody asked for. A crate in the yard costs nothing,
   * is completely reversible, renders as an object you can walk back to, and
   * the stocker will quietly shelve it for you — because pallets are already
   * the first job on their list.
   *
   * Its own pad, not the delivery bay. Both hold the same pallets, and that is
   * exactly why they have to be apart: on one pad there is no way to look at
   * the yard and tell an order that arrived from an armful you parked.
   */
  stow(playerId) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    if (!p.carry || p.carry.qty <= 0) return err('nothing in hand');
    if (!this.dropPad()) return err('nowhere to put it down — lay some storage first');
    if (!this.onPad(p, this.dropPadKind())) return err('take it round to the drop-off');

    const { item_id: itemId, qty } = p.carry;
    this.dropGoods(itemId, qty, this.dropPad());
    p.carry = null;
    const name = content().byId.items[itemId]?.name ?? itemId;
    this.pushLog(`${qty}x ${name} put back in a crate at the drop-off.`);
    return ok({ stowed: qty, item_id: itemId });
  }

  /**
   * Where clearing your hands puts a crate.
   *
   * Falls back to the delivery bay, because a world saved before the yard
   * existed has a layout with no `drop` in it and "you cannot put that down
   * anywhere" is a worse answer than the old one. Null when a shop has neither,
   * which is now a thing you can do to yourself on purpose — see `freezeYard`.
   */
  dropPad() {
    return this.layout.drop ?? this.layout.bay;
  }

  /** ...and which KIND that is, which is what `onPad` needs to test against. */
  dropPadKind() {
    if (this.layout.drop) return 'drop';
    return this.layout.bay ? 'bay' : null;
  }

  /**
   * Are you standing on this pad, or on a tile touching it?
   *
   * Five tile reads rather than a distance to a point, and the difference is
   * the whole reason pads became regions. A radius from the middle of a 2x2 was
   * a fair description of a 2x2; measured from the middle of a stockroom it
   * says you are too far from the storage you are standing in the back of.
   */
  onPad(p, kind) {
    if (!kind) return false;
    const x = Math.round(p.x);
    const z = Math.round(p.z);
    if (isPadAt(this.layout, kind, x, z)) return true;
    return NEIGHBOURS.some(([dx, dz]) => isPadAt(this.layout, kind, x + dx, z + dz));
  }

  // -------------------------------------------------------------------------
  // Appliances — turning ingredients into finished goods
  // -------------------------------------------------------------------------

  /** Which appliances the shop owns, in purchase order. */
  /**
   * Every appliance the shop owns, by name, one entry per machine.
   *
   * Read off what is standing in the shop rather than off `ownedUpgrades`,
   * which is what made an appliance a permanent single thing you could never
   * buy a second of and never really tear out. It was a stored count in between;
   * the count and the machines can't disagree now because there is only one of
   * them.
   */
  ownedStations() {
    return budgetOf(this.placements).stations;
  }

  /** Is this item the output of some recipe? Then it can't be bought in. */
  isCrafted(itemId) {
    return content().recipes.some((r) => r.output_id === itemId);
  }

  /** Recipes this appliance can make. */
  recipesFor(stationKind) {
    return content().recipes.filter((r) => r.station === stationKind);
  }

  // ---- how much an appliance holds ----------------------------------------
  //
  // Four numbers, and every one of them is `STATION_BATCHES` times something a
  // recipe already says. Nothing here is authored: an appliance invented this
  // afternoon gets a hopper sized to its own recipes for free, which is the
  // same bargain a tag makes for an item.

  /** How many batches of anything this machine holds, in or out. */
  stationBatches(station) {
    return Math.max(1, Math.round(STATION_BATCHES * this.fixtureStats(station).capacity_mult));
  }

  /**
   * How much of one ingredient the hopper takes.
   *
   * Sized off the LARGEST call any recipe on this machine makes for it, not off
   * the recipe being made — a blender that wants 3 tomatoes for salsa and 1 for
   * something else has one tomato bin, and which of the two it happens to be
   * making cannot change how big the bin is.
   */
  stationHopperCap(station, itemId) {
    const per = this.recipesFor(station.station)
      .flatMap((r) => r.inputs.filter((i) => i.item_id === itemId))
      .reduce((n, i) => Math.max(n, i.qty), 0);
    return per * this.stationBatches(station);
  }

  /** Room left in the hopper for one ingredient. */
  stationHopperRoom(station, itemId) {
    return this.stationHopperCap(station, itemId) - (station.contents[itemId] ?? 0);
  }

  /**
   * Room left for finished goods, for one recipe.
   *
   * Zero when something else is already sitting in the tray, which is what
   * keeps "one product at a time" true without ever destroying a batch. The
   * rule used to be enforced *after* the timer ran out — make it, then throw it
   * away if the tray held something else — so a machine with two recipes could
   * silently eat its own ingredients. Asking before starting is the same rule
   * and costs nothing.
   */
  stationOutputRoom(station, recipe) {
    if (station.output && station.output.item_id !== recipe.output_id) return 0;
    return recipe.output_qty * this.stationBatches(station) - (station.output?.qty ?? 0);
  }

  /**
   * The next batch this appliance can start, or null.
   *
   * Ingredients in the hopper AND somewhere to put the result. The second half
   * is the whole difference between a machine that runs itself down and one
   * that makes a single portion and waits for a human.
   */
  nextBatch(station) {
    return this.recipesFor(station.station).find((r) => (
      r.inputs.every((i) => (station.contents[i.item_id] ?? 0) >= i.qty)
      && this.stationOutputRoom(station, r) >= r.output_qty
    )) ?? null;
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

    // As much as fits, and the rest stays in your hands. A partial load rather
    // than a refusal, because the alternative is a machine that takes an armful
    // of four when it has room for three and one that takes none of it — and
    // the second is the version you have to do arithmetic to use.
    const itemId = p.carry.item_id;
    const room = this.stationHopperRoom(st, itemId);
    if (room <= 0) {
      const name = content().byId.items[itemId]?.name ?? itemId;
      return err(`the ${st.station} is full of ${name}`);
    }
    const moved = Math.min(p.carry.qty, room);
    st.contents[itemId] = (st.contents[itemId] ?? 0) + moved;
    p.carry.qty -= moved;
    if (p.carry.qty <= 0) p.carry = null;
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
   *
   * And they keep going: a finished batch starts the next one in the same tick
   * rather than parking until somebody collects. The old loop finished a batch
   * and `continue`d, then refused to start anything while `st.output` was set,
   * so a machine ran for `minutes` and then idled for however long it took a
   * chef to walk over — which with one chef and three appliances is most of the
   * day. Nothing about that is visible in a screenshot or in the log; what you
   * see is a kitchen that produces about one thing.
   */
  stepStations(dt) {
    const stations = this.layout.stations ?? [];
    if (!stations.length) return;

    for (const st of stations) {
      let finished = null;

      if (st.making) {
        if (this.elapsed < st.busyUntil) continue;
        const recipe = content().byId.recipes[st.making];
        st.making = null;
        if (recipe) {
          const out = st.output ?? { item_id: recipe.output_id, qty: 0 };
          // Can't disagree any more — `nextBatch` only ever starts a recipe
          // whose output the tray will accept. Kept as a guard rather than an
          // assumption because content reloads underneath a running batch.
          if (out.item_id === recipe.output_id) {
            out.qty += recipe.output_qty;
            st.output = out;
            finished = recipe;
          }
        }
      }

      const next = this.nextBatch(st);
      if (!next) {
        // One line per RUN, not per batch. Four batches back to back is four
        // "is ready" lines in an eight-line log, which buries everything else
        // that happened this morning — and the useful message is the one that
        // says how much is waiting, since that is what you are walking over for.
        if (finished) this.pushLog(`${st.output.qty}x ${finished.name} ready at the ${st.station}.`);
        continue;
      }

      for (const i of next.inputs) {
        st.contents[i.item_id] -= i.qty;
        if (st.contents[i.item_id] <= 0) delete st.contents[i.item_id];
      }
      st.making = next.id;
      st.startedAt = this.elapsed;
      // `minutes` is in-game minutes; a day is DAY_SECONDS real seconds.
      const speed = this.fixtureStats(st).speed_mult;
      st.busyUntil = this.elapsed + (next.minutes / speed / (24 * 60)) * DAY_SECONDS;
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

  /**
   * Take an armful off one of a shelf's boards.
   *
   * `unshelve` because `takeFromShelf` is already taken — by a *shopper*
   * putting one in their basket, which is a different act with the same English
   * name. This one pairs with the `shelve` job instead, which is the thing it
   * undoes.
   *
   * The other direction of `stockShelf`, and the answer to a shop where the
   * only way to get goods back off a shelf was to tip the whole unit onto the
   * floor. One board, because a unit holds three kinds and "empty it" already
   * covers meaning all of them.
   *
   * An emptied board keeps its label. A stack at zero is what a shelf
   * *remembers* — it is why an empty shelf can be relabelled but a stocked one
   * cannot — so clearing it here would quietly hand a reserved board back to
   * whatever the next delivery happened to be. Taking the labels off is its own
   * row in the menu.
   */
  unshelve(playerId, shelfId, itemId) {
    const p = this.players[playerId];
    const shelf = this.layout.shelves.find((s) => s.id === shelfId);
    if (!p || !shelf) return err('no such shelf');
    if (!near(p, shelf)) return err('too far from that shelf');

    const stack = this.shelfStack(shelf, itemId);
    if (!stack || stack.qty <= 0) return err('nothing on that board');

    const item = content().byId.items[itemId];
    if (p.carry && p.carry.item_id !== itemId) {
      const held = content().byId.items[p.carry.item_id]?.name ?? p.carry.item_id;
      return err(`hands full of ${held} — put it down first`);
    }
    const have = p.carry?.qty ?? 0;
    const take = Math.min(stack.qty, this.carryCapacity() - have);
    if (take <= 0) return err('hands full');

    stack.qty -= take;
    p.carry = { item_id: itemId, qty: have + take };
    this.pushLog(`Took ${take}x ${item?.name ?? itemId} off ${shelf.id}.`);
    return ok({ took: take, item_id: itemId, left: stack.qty });
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
    // A reservation refuses your hands too, and says how to take it back —
    // otherwise the shelf you set aside this morning reads as broken tonight.
    const kept = toList(shelf.assigned);
    if (kept.length && !kept.includes(p.carry.item_id)) {
      const names = kept.map((id) => content().byId.items[id]?.name ?? id);
      return err(`that shelf is set aside for ${names.join(' and ')} — change it in the shelf's menu`);
    }
    // Every board taken by something else is the "shelf already holds…" refusal
    // this replaces, and it is a better one: the old rule fired the moment ONE
    // other thing was on it, which is exactly what stopped a unit being shared.
    // Farm produce still has somewhere to go while a board is spare, which is
    // what that rule was really protecting.
    const stack = this.openStack(shelf, item);
    if (!stack) {
      const held = this.shelfStacks(shelf)
        .map((k) => content().byId.items[k.item_id]?.name ?? k.item_id);
      return err(`every board is taken — ${held.join(', ')}`);
    }

    const room = this.shelfCapacity(shelf, item) - stack.qty;
    if (room <= 0) return err('shelf is full');

    const moved = Math.min(room, p.carry.qty);
    const wasEmpty = stack.qty === 0;
    stack.qty += moved;
    // The clock and the price belong to the board, and both are set when it
    // starts rather than every time it is topped up: restocking the milk must
    // not reset how long the milk has already been out, let alone the cheese's.
    if (wasEmpty) {
      stack.stockedDay = this.day;
      stack.price = suggestedPrice(item, this.folded(), this.season);
    }

    p.carry.qty -= moved;
    if (p.carry.qty <= 0) p.carry = null;
    return ok({ stocked: moved, price: stack.price });
  }

  /**
   * Reprice one board.
   *
   * `itemId` is which board, and it is required in spirit rather than in the
   * signature: a unit holding one thing has one board and omitting it still
   * means what it always meant, which is what keeps an older client working.
   * Naming no board on a unit holding three would otherwise have to pick one,
   * and any rule for picking is a rule that reprices the wrong cheese.
   */
  setPrice(shelfId, price, itemId = null) {
    const shelf = this.layout.shelves.find((s) => s.id === shelfId);
    if (!shelf) return err('no such shelf');
    const stacks = this.shelfStacks(shelf);
    const stack = itemId ? this.shelfStack(shelf, itemId) : (stacks.length === 1 ? stacks[0] : null);
    if (!stack) return err('say which of those to reprice');
    stack.price = Math.max(0, round2(price));
    return ok({ price: stack.price, item_id: stack.item_id });
  }

  /**
   * Say what a shelf is *for*, whether or not anything is on it yet.
   *
   * `stacks` is what is physically on the unit, and each board is set by whoever
   * last put something there — a delivery, a harvest, a stocker with their hands
   * full. That is exactly why a bare board takes anything (see `stockShelf`): a
   * leftover board is a record of what happened, not a decision, and treating it
   * as one strands farm produce the day every shelf has been claimed once.
   *
   * `assigned` is the other half — a decision somebody made. So it binds, it
   * survives the shelf selling out and spoiling, and it is what the stocker
   * refills with instead of picking for themselves. Two lists rather than one
   * flag on the stack, because "there is milk on this" and "milk goes here" stop
   * agreeing the moment the last carton sells.
   *
   * A TOGGLE, one item per press, because that is what a row of checkboxes is.
   * `on` says which way when the caller knows; omitting it flips, so a client
   * that sends nothing but the item still behaves. A null item clears the lot —
   * "anything at all", which cannot fail.
   *
   * Not gated on build mode: this is a choice about stock, like sowing a bed,
   * not construction.
   */
  assignShelf(playerId, shelfId, itemId, on = null) {
    const shelf = this.layout.shelves.find((s) => s.id === shelfId);
    if (!shelf) return err('no such shelf');
    const kept = toList(shelf.assigned);

    // Handing it back is always allowed — "anything at all" cannot fail.
    if (!itemId) {
      if (!kept.length) return err('that shelf already takes anything');
      shelf.assigned = [];
      this.pushLog(`${shelf.id} takes anything again.`);
      return ok({ assigned: [], shelf: shelf.id });
    }

    const item = content().byId.items[itemId];
    if (!item) return err('no such item');

    // Untick. Always allowed, and deliberately does NOT touch the stock: you
    // said stop reserving a board for this, not throw away what is on it. The
    // goods stay and sell down, and the board frees itself when they are gone.
    const want = on === null ? !kept.includes(itemId) : on === true;
    if (!want) {
      if (!kept.includes(itemId)) return err(`${shelf.id} was not kept for ${item.name}`);
      shelf.assigned = kept.filter((id) => id !== itemId);
      this.pushLog(`${shelf.id} is no longer kept for ${item.name}.`);
      return ok({ assigned: shelf.assigned, shelf: shelf.id });
    }
    if (kept.includes(itemId)) return ok({ assigned: kept, shelf: shelf.id });

    // The rule here is the one the *staff* work to, not the looser one your own
    // hands get. By hand you may stand a loaf in a freezer if you like; a
    // reservation is an instruction to the shop, and one nobody will ever carry
    // out is worse than none at all — the shelf just sits empty for ever.
    const frozen = requiredFixture(item) === 'freezer';
    if (frozen && shelf.kind !== 'freezer') return err(`${item.name} needs a freezer`);
    if (!frozen && shelf.kind === 'freezer') return err(`${item.name} doesn't need freezing`);

    // You cannot ask for more kinds than it has boards to put them on. This is
    // the ceiling the whole feature hangs off, and it is the art's number rather
    // than one invented here — see `boardsOf`.
    const boards = this.shelfBoards(shelf);
    if (kept.length >= boards) {
      return err(`that ${shelf.kind} only has ${boards} board${boards === 1 ? '' : 's'}`);
    }
    // …and a board already carrying somebody else's goods is not a free one.
    // Same refusal the single-reservation version gave, asked of the boards
    // rather than of the unit: a reservation nothing can honour until you empty
    // the thing is a shelf that quietly sits there never being filled.
    if (!this.shelfHasRoomFor(shelf, itemId)) {
      const held = this.shelfStacks(shelf)
        .map((k) => content().byId.items[k.item_id]?.name ?? k.item_id);
      return err(`every board is full — empty the ${held.join(' or ')} off it first`);
    }

    shelf.assigned = [...kept, itemId];
    this.pushLog(`${shelf.id} is set aside for ${item.name}.`);
    return ok({ assigned: shelf.assigned, shelf: shelf.id });
  }

  /**
   * Which shelf the next van fills. -1 last, 0 as it comes, 1 first.
   *
   * Three steps rather than a number you type, because the only thing anybody
   * wants to say is which end of the queue this goes on, and a shop of eleven
   * shelves each holding its own integer is a spreadsheet.
   */
  setRestockPriority(shelfId, priority) {
    const shelf = this.layout.shelves.find((s) => s.id === shelfId);
    if (!shelf) return err('no such shelf');
    shelf.priority = Math.sign(Math.trunc(Number(priority) || 0));
    return ok({ priority: shelf.priority, shelf: shelf.id });
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
      // Every board, not just the first — `stock_shop` exists so an agent can
      // look at a full shop, and filling one board of three would show the new
      // thing off half empty.
      //
      // Chosen in full before any of it is written, because capacity is a
      // SHARE: `shelfCapacity` divides by how many ways the unit is split, so
      // filling board one to its brim and then opening board two leaves the
      // first one over its own limit and the stocker refusing to touch it.
      const want = [pick];
      for (let b = 1; b < this.shelfBoards(shelf); b++) {
        const it = c.items.find((x) => (requiredFixture(x) === 'freezer') === wantsFreezer
          && !used.has(x.id));
        if (!it) break;
        used.add(it.id);
        want.push(it);
      }
      shelf.stacks = [];
      for (const it of want) this.openStack(shelf, it);
      for (const stack of this.shelfStacks(shelf)) {
        const it = c.byId.items[stack.item_id];
        stack.qty = Math.max(1, Math.floor(this.shelfCapacity(shelf, it) * 0.7));
      }
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
    if (!f) return { capacity_mult: 1, keeps_mult: 1, speed_mult: 1, unattended: 0 };
    const tier = this.fixtureTiers(f)[this.fixtureTier(f) - 1] ?? {};
    return {
      capacity_mult: tier.capacity_mult ?? 1,
      keeps_mult: tier.keeps_mult ?? 1,
      speed_mult: tier.speed_mult ?? 1,
      // Zero rather than one: this is not a multiplier on anything, it is a
      // machine that either serves its own line or doesn't, and how well.
      unattended: tier.unattended ?? 0,
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
    // Across every board — "empty it first" has to mean the whole unit, or a
    // shelf with a full middle board would pass the check that guards removing
    // it and take the goods with it when it went.
    return this.shelfQty(f);
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

  /**
   * Take a shelf's stock off it and hand the shelf back unlabelled.
   *
   * Unlabelled, not unreserved: `assigned` and `priority` deliberately survive.
   * Emptying a shelf is nearly always the first half of restocking it, and a
   * clear-out that also forgot what the shelf was for would mean re-choosing it
   * every time. Handing it back to "anything" is its own choice, in its own row.
   */
  stripShelf(playerId, shelfId) {
    const p = this.players[playerId];
    const shelf = this.layout.shelves.find((s) => s.id === shelfId);
    if (!p || !shelf) return err('no such shelf');
    const stacks = this.shelfStacks(shelf);
    if (!stacks.length) return err('that shelf is already bare');

    // Every board, into its own crate — a pallet holds one kind, so a shelf of
    // three things tips out as three of them. That is the pallet rule paying
    // for itself rather than a new container: three crates render, get picked
    // up and get tidied away by machinery that already existed.
    let moved = 0;
    const names = [];
    for (const stack of [...stacks]) {
      const name = content().byId.items[stack.item_id]?.name ?? stack.item_id;
      if (stack.qty > 0) {
        this.dropGoods(stack.item_id, stack.qty, shelf.browseAt);
        moved += stack.qty;
        names.push(`${stack.qty}x ${name}`);
      }
    }
    shelf.stacks = [];
    this.pushLog(moved > 0
      ? `Stripped ${names.join(', ')} off ${shelf.id} — it's in crates beside it.`
      : `Cleared the labels off ${shelf.id}.`);
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

  /**
   * What one more of these costs to put down.
   *
   * The price is on the piece. It used to be reverse-engineered — scan the
   * upgrade table for whichever row sold this kind, divide its cost by how many
   * it granted, take the cheapest — which worked only because every kind had
   * exactly such a row. A planter never will, and neither will the fourth shelf
   * design somebody authors this afternoon, so a catalog entry that could not
   * name its own price was a catalog with five entries in it.
   *
   * `FALLBACK_FIXTURE_COST` is a floor rather than a second price list: a kind
   * is buildable whether or not anybody has drawn one, and a shelf whose row got
   * tidied out of the catalog must not become free shelving. A prop is the
   * exception and deliberately so — a decoration *is* its row, so one authored
   * at 0 is free rather than mysteriously priced at a hundred dollars.
   *
   * Appliances are the one kind still priced elsewhere, and it is not the old
   * scan: a station upgrade is one machine rather than a pack, so its cost is
   * already a unit price and nothing is being divided. Moving those onto the
   * catalog needs a piece per machine, which is its own change — see step 12 of
   * docs/building.md.
   */
  fixtureUnitCost(kind, station = null, piece = null) {
    if (kind === 'station') {
      const up = this.stationUpgrade(station);
      return round2((up?.cost ?? FALLBACK_FIXTURE_COST.station) * this.fixtureDiscount(kind));
    }
    const row = pieceFor(content().fixtures ?? [], { kind, piece: piece ?? null });
    const listed = row?.cost > 0 ? row.cost : (isProp(kind) ? 0 : FALLBACK_FIXTURE_COST[kind] ?? 100);
    return round2(listed * this.fixtureDiscount(kind));
  }

  /**
   * The best deal you have bought on this kind of fixture, as a multiplier.
   *
   * This is what the five old fixture upgrades became. They used to grant you
   * "two more shelf units" and have the generator decide where those went,
   * which is the blind half of a purchase build mode replaced — so between step
   * 4 and here they were rows that could not be bought at all, kept alive only
   * because `fixtureUnitCost` read them as a price list. Now they sell a rate.
   *
   * The best of them rather than all of them multiplied together, and that is a
   * rule rather than an optimisation: the ladder is already ordered — a trade
   * account is strictly better than a standing order and costs four times as
   * much — so owning both should read as owning the better one, not as 40% off.
   * Same shape `foldModifiers` uses when two copies of one world event land on
   * the same day. `MAX_FIXTURE_DISCOUNT` is the backstop for a deal authored via
   * MCP at 0.95, which is a typo away from free shelving.
   */
  fixtureDiscount(kind) {
    let best = 0;
    for (const u of content().upgrades) {
      if (u.kind !== kind || !this.ownedUpgrades.includes(u.id)) continue;
      const d = Number(u.payload?.discount ?? 0);
      if (d > best) best = d;
    }
    return 1 - clamp(best, 0, MAX_FIXTURE_DISCOUNT);
  }

  /**
   * How many of each thing the shop has, under the name the palette calls it.
   *
   * A recount over `placements`, which is the whole of the ledger's retirement.
   * `world.fixtures` was a stored count because it had to be: it was the
   * generator's shopping list, and while the generator furnished the shop
   * itself "six shelves" was a number nothing in the world could be read back
   * from. A stamped shop *is* its placements, so this is a fact about the world
   * rather than a second opinion about it — and it cannot double-count a
   * freezer on a server restart or forget one you tore out, both of which the
   * thing before it managed.
   *
   * Keyed by *piece* for everything except an appliance, and that uniformity is
   * the other half. `ledgerKey` had to spell a shelf by its KIND, because a
   * second shelf design counted under its own name would have had no budget
   * asked for it and the next re-flow would drop it, silently, one at a time.
   * Nothing is asked for any more, so the asymmetry that protected the budget
   * retires with the budget, and the palette can finally say how many of *this*
   * design you own.
   */
  fixtureCounts() {
    const out = {};
    for (const p of this.placements) {
      // Through `pieceId` rather than off the placement, because a placement
      // written before the catalog split has no `piece` at all and would count
      // under nothing. The client spells the same key with the same function.
      const key = countKey(p.kind, {
        station: p.station,
        piece: p.kind === 'station' ? null : this.pieceId(p.kind, p.piece),
      });
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  }

  /** The upgrade that sells a named appliance, or undefined. */
  stationUpgrade(station) {
    return content().upgrades.find((u) => u.kind === 'station' && u.payload?.station === station);
  }

  /**
   * Build-mode prices, for the client's palette.
   *
   * Keyed exactly the way `fixtureCounts` is, so the palette looks a price and a
   * count up with one id and needs to know nothing about appliances being a
   * special case. Add a piece or an appliance via MCP and it appears, priced.
   *
   * Discounts are already folded in, because this is the number printed on the
   * button and `placeFixture` is the number actually charged. Two ways of
   * working out one price is two different amounts of money.
   */
  buildCosts() {
    // A kind with no row in the catalog is still buildable — an undrawn shelf
    // renders as a plain block and always has — so every kind gets an entry
    // under its own name whether or not anybody has designed one.
    const costs = Object.fromEntries(FIXTURE_KINDS
      .filter((k) => k !== 'station')
      .map((k) => [k, this.fixtureUnitCost(k)]));
    // ...and one per piece, because a price belongs to a design now rather than
    // to a kind. The five pieces that predate the split are named after their
    // kind, so those entries land on exactly the keys the line above wrote.
    for (const row of content().fixtures ?? []) {
      const k = kindOf(row);
      // Ground is priced per tile off its own row and has no kind-level entry
      // to fall back to, because no upgrade ever sold flooring. It is also the
      // one price here that is not "what one of these costs" but "what a tile
      // of it costs" — which the palette says on the button.
      if (isGround(k)) { costs[row.id] = this.groundUnitCost(row.id); continue; }
      if (!FIXTURES[k]) continue;
      costs[row.id] = this.fixtureUnitCost(k, null, row.id);
    }
    for (const u of content().upgrades) {
      if (u.kind !== 'station' || !u.payload?.station) continue;
      costs[`station:${u.payload.station}`] = this.fixtureUnitCost('station', u.payload.station);
    }
    // The shell, priced per segment. Same reason fixture prices are shared: the
    // palette prints the number on the button and the server is what charges
    // it, so two copies would be two different amounts of money.
    costs.wall = EDGE_COST[E.WALL];
    costs.window = EDGE_COST[E.WINDOW];
    costs.door = EDGE_COST[E.DOOR];
    costs.fence = EDGE_COST[E.FENCE];
    costs.gate = EDGE_COST[E.GATE];
    // Demolishing is deliberately absent rather than priced at 0. It pays you
    // `FIXTURE_REFUND` back, so "$0" on the button would be the one number here
    // that isn't what happens — and a button with no price prints nothing.
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
    /**
     * One quarter turn, and then the next one, in order.
     *
     * This used to skip ahead to the first facing that drew no *warning* —
     * "turning it should not silently make it useless" — and that was a
     * workaround for a bug rather than a feature. A warned facing used to be
     * fatal: the generator dropped the placement on the next re-flow, so
     * avoiding warned facings was the only way a rotation could survive at all.
     *
     * The cost of that workaround is that you cannot reach the angle you want.
     * In a corner almost every facing is warned — the browsing spot is against
     * a wall — so rotate found the same one or two clean facings every time and
     * cycled between them forever. Measured on a corner shelf: six presses gave
     * 1, 0, 1, 0, 1, 0. Two of the four angles were simply unreachable, which
     * is not something you can tell from the outside; it reads as the shelf
     * refusing to turn the way you are asking.
     *
     * With warned placements honoured (see `compose` in server/layout.js), a
     * facing you were warned about is a facing you can have. So this steps one
     * quarter turn, every time, and the warning rides back to say what it cost.
     * Which side a shelf faces is a decision about how your shop looks as much
     * as how it works, and that decision is yours.
     */
    const tries = [1, 2, 3].map((i) => rot4((f.rot ?? 0) + step * i));
    const spec = (rot) => ({ kind: f.kind, station: f.station ?? null, x: f.x, z: f.z, rot });
    // Still a list rather than a single turn, because a rotation can be refused
    // outright — a till whose serving spot is already claimed by another till.
    // That is physics, and stepping over it beats refusing to turn.
    for (const rot of tries) {
      const res = this.repositionFixture(id, spec(rot));
      if (res.ok) return ok({ rotated: res.id, rot });
    }
    return err('nowhere for it to turn to');
  }

  /**
   * Make a unit back-of-house, or put it back on the shop floor.
   *
   * A property of THIS unit rather than of its design, which is the whole point
   * of it being a toggle: the same shelving is a shop fitting out front and a
   * pantry in the kitchen, and which one it is is a decision about the room it
   * stands in. Wall off a back room, put ordinary shelving and a cooler in it,
   * flip them, and you have a kitchen — a room you designate rather than
   * furniture you buy, the same way the yard pads work.
   *
   * Only stock-holding units, because it means one thing and one thing only:
   * shoppers cannot see it. A till or a plot has no shoppers to hide from.
   *
   * It changes nothing about where the thing may stand, so this does not go
   * through `repositionFixture` — a toggle that re-sited the fixture would move
   * your kitchen every time you changed your mind about it.
   *
   * It does not re-flow *at all*, and that is the second half of the same
   * argument. `regenerateLayout` is not a repaint: it re-runs the generator,
   * carries every shelf's stock across, rebuilds the walk grid, throws away the
   * path of every shopper in the building, and bumps `layoutVersion` — which on
   * the client disposes the entire static scene and every stock prop in it and
   * builds them again. All of that to change who is allowed to look at one
   * shelf. What you saw was the shop visibly redrawing under a checkbox, and
   * what you did not see was the re-pathing.
   *
   * So it writes both copies by hand instead. The placement is the durable one —
   * `compose` reads `p.boh` back onto the shelf on the next genuine re-flow —
   * and `f.ref` is the live layout row. **`f` itself is not it.** `allFixtures`
   * spreads every record into a fresh object to stamp a `kind` on it and hangs
   * the original off `ref`, so writing to `f` writes to a copy that is thrown
   * away when this function returns. It fails silently and in the most
   * convincing way there is: the placement is correct, so the flag is right
   * again the moment anything else re-flows the shop — which, while this handler
   * re-flowed on its own, it always immediately did.
   *
   * Nothing else needs telling: the sim reads the layout row when it picks a
   * shelf for a shopper, so do the staff, and the snapshot already carries `boh`
   * at 10Hz for exactly the reason the comment beside it gives — it changes
   * while the shop stands still.
   */
  setBackOfHouse(playerId, id, on = true) {
    const { f, error } = this.buildTarget(playerId, id);
    if (error) return err(error);
    if (f.kind !== 'shelf' && f.kind !== 'freezer') {
      return err('only somewhere that holds stock can be back of house');
    }
    const placement = this.placements.find((p) => p.id === id);
    if (!placement) return err('that fixture is gone');

    placement.boh = on === true;
    if (f.ref) f.ref.boh = placement.boh;
    this.pushLog(placement.boh
      ? 'Moved a unit into the back — shoppers will not see it.'
      : 'Put a unit back on the shop floor.');
    return ok({ id, boh: placement.boh });
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
      // Rides along with the tier and the shape. Without it, turning a pantry
      // shelf puts it back on the shop floor — and the unit looks identical
      // either way, so what you would see is customers browsing your kitchen.
      boh: from.boh === true,
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
   * Half of what one costs *today*, which is a decision worth naming: the shop
   * doesn't remember what you paid, so a deal you bought since makes your old
   * shelving worth less to sell back. That is the right way round — the refund
   * tracks what the thing is worth rather than what it cost you — and it also
   * means a discount can never be laundered into free money by buying one, then
   * the deal, then selling it back.
   */
  removeFixture(playerId, id) {
    const { p, f, error } = this.buildTarget(playerId, id);
    if (error) return err(error);
    if (this.fixtureContents(f) > 0) return err('empty it first');
    if (f.kind === 'checkout' && this.layout.checkouts.length <= 1) {
      return err('you need at least one till to take money');
    }

    // One path for everything. Tearing out an appliance used to un-own its
    // upgrade — the only way a boolean can count down — which meant selling one
    // back put it up for sale again at full price and re-buying it was the only
    // way to get a second. There is no count to check against either: the
    // fixture is standing there, which is the whole of "is there one to remove".
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

  /**
   * Paint an area of ground, or take it back up.
   *
   * The third build verb, and the one that finally makes the second one worth
   * something. Walls have enclosed since step 3, so an annex you drew *counted*
   * as indoors and then refused every shelf you tried to stand in it — the
   * ground under it was grass and `BUILDABLE_INDOOR` is floor. This is that
   * half. Draw the walls, lay the floor, and the room is a room.
   *
   * Stored as an overlay for the same reason `edits` is: the generator restamps
   * the shell's footprint every re-flow, so ground anybody chose has to be
   * re-applied over it or buying a shelf repaints the shop.
   *
   * Priced per cell, exactly as a wall is priced per edge, and for the argument
   * docs/building.md settles under "does a wall cost per edge or per run": per
   * area makes a big room cheaper per tile than a small one, so the cheapest
   * shop becomes one enormous drag and the pricing quietly argues against the
   * odd shapes enclosure exists to allow. Running out halfway lays what you
   * could afford, the same way a wall does.
   *
   * It paints the yard pads as well as flooring, and that is the entire
   * mechanism by which they became yours — one brush, and the KIND of the row
   * you named decides whether the cell becomes floor, delivery bay or storage.
   * There is deliberately no second verb for "designate a bay": a pad you can
   * lay with the tool you already know is a pad you will actually move.
   */
  buildGround(playerId, spec = {}) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    if (!p.build?.on) return err('not in build mode');

    const x = Math.round(Number(spec.x));
    const z = Math.round(Number(spec.z));
    if (!Number.isFinite(x) || !Number.isFinite(z)) return err('nowhere to lay that');

    // An empty piece is the bulldozer: take the ground up. Anything else has to
    // name a row that really is ground — falling back to a default the way
    // `placeFixture` does would mean a typo silently laying oak.
    const want = String(spec.piece ?? '');
    const piece = want
      ? (content().fixtures ?? []).find((f) => f.id === want && isGround(kindOf(f)))
      : null;
    if (want && !piece) return err('nothing in the catalog lays that');
    // Read off the row rather than taken from the message. The client sends
    // which tool it thinks it is holding, and a client that said `bay` while
    // naming a flooring row would paint a delivery bay the colour of oak.
    const kind = piece ? kindOf(piece) : null;

    const to = spec.to ? { x: Number(spec.to.x), z: Number(spec.to.z) } : null;
    const cells = groundStroke({ x, z }, to, GROUND_STROKE_MAX);

    // Asked for the whole stroke before any of it is paid for, so a drag that
    // clips a bed at one corner is refused as a gesture rather than laid up to
    // the bed and then billed for.
    const check = canPaintGround(this.layout, cells, kind, piece?.id ?? null);
    if (!check.ok) return err(check.reason);

    const unit = piece ? this.groundUnitCost(piece.id) : 0;
    const painted = groundIndex(this.layout);
    const kept = new Map(this.ground.map((f) => [`${f.x},${f.z}`, f]));

    let spent = 0;
    let laid = 0;
    let short = false;
    for (const c of cells) {
      const key = `${c.x},${c.z}`;
      const had = painted.get(key) ?? null;
      if (had === (piece?.id ?? null) && this.groundKindAt(c.x, c.z) === kind) continue;

      // Pay the difference, exactly as swapping a wall for a window does: what
      // was underfoot is worth `FIXTURE_REFUND` of what it cost, whether you
      // laid it or the shell came with it.
      const cost = round2(unit - this.groundUnitCost(had) * FIXTURE_REFUND);
      if (cost > 0 && this.cash - spent < cost) { short = true; break; }

      spent = round2(spent + cost);
      kept.set(key, { x: c.x, z: c.z, k: kind, p: piece?.id ?? null });
      laid++;
    }

    if (!laid) {
      return short ? err(`need $${unit.toFixed(2)}`) : ok({ laid: 0, unchanged: true });
    }

    this.ground = [...kept.values()];
    this.cash = round2(this.cash - spent);
    if (spent > 0) this.stats.spent += spent;
    this.regenerateLayout();

    const what = piece ? piece.name.toLowerCase() : 'ground';
    this.pushLog(piece
      ? `Laid ${laid} ${laid === 1 ? 'tile' : 'tiles'} of ${what}`
        + `${spent > 0 ? ` for $${spent.toFixed(2)}` : ''}.`
      : `Took up ${laid} ${laid === 1 ? 'tile' : 'tiles'} of ground.`);
    return ok({ laid, cost: spent, short, warn: check.warn ?? null });
  }

  /**
   * Which ground kind this cell is right now, or null for bare grass.
   *
   * The half of a repaint the overlay can't answer: `ground` says what you
   * painted, and this says what the cell actually ended up as, which differ for
   * exactly as long as it takes a re-flow to run.
   */
  groundKindAt(x, z) {
    return groundKindOfTile(this.layout.tiles[z * this.layout.w + x]);
  }

  /**
   * What one tile of ground costs to lay.
   *
   * Off the catalog row and nowhere else, which is what ground gets for
   * arriving after step 9 rather than before it — there is no upgrade that ever
   * sold flooring, so there is no payload to fall back to and no
   * `FALLBACK_FIXTURE_COST` entry pretending otherwise. Ground authored at 0
   * is genuinely free, the same way a prop is: it *is* its row, so bare
   * concrete costing nothing is an authoring decision rather than a hole.
   *
   * Null is the ground the shell came with, which cost nothing and refunds
   * nothing — you never bought it. The seeded yard pads are that too: they
   * arrive with no piece, so tearing out the bay the shop gave you refunds
   * nothing, which is right — nobody charged you for it.
   *
   * The discount is read against the row's own kind rather than against
   * `floor`, or a Storage upgrade would quietly discount parquet.
   */
  groundUnitCost(pieceId) {
    if (!pieceId) return 0;
    const row = (content().fixtures ?? []).find((f) => f.id === pieceId && isGround(kindOf(f)));
    if (!row) return 0;
    return round2((row.cost ?? 0) * this.fixtureDiscount(kindOf(row)));
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
    // A trial run, so the drop is not paid for. This one refuses rather than
    // warns — moving the door is a nudge you can simply not make, and there is
    // nothing to weigh up — which means the drop it provokes never happens, and
    // compensating for it would be paying you for a shelf you still have.
    const kept = this.placements;
    this.doorShift = next;
    this.regenerateLayout(null, {}, { compensate: false });
    if (this.layout.droppedPlacements?.length) {
      // Moving the door re-flows the shop; if that orphaned things, put it back.
      this.doorShift = before;
      this.placements = kept;
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
    if (up.kind === 'station') {
      // An appliance is still bought per machine, in build mode, on a tile you
      // chose — and this row is the price of that machine rather than something
      // you own. It is the last kind priced off an upgrade; see `fixtureUnitCost`
      // and step 12 of docs/building.md.
      return err('an appliance is bought in the Build menu, one machine at a time');
    }
    if (this.ownedUpgrades.includes(upgradeId)) return err('already owned');
    const missing = up.requires.filter((r) => !this.ownedUpgrades.includes(r));
    if (missing.length) return err(`needs ${missing.join(', ')} first`);
    if (this.cash < up.cost) return err(`need $${up.cost.toFixed(2)}`);

    this.cash -= up.cost;
    this.stats.spent += up.cost;
    this.ownedUpgrades.push(upgradeId);

    // A fixture upgrade grants nothing you can stand on. It used to hand you
    // "two more shelf units" and let the generator decide where they went,
    // which is the blind half of a purchase that build mode replaced — so what
    // these sell now is a rate, read at the moment you place something. See
    // `fixtureDiscount`. Nothing to do here: owning it *is* the effect.
    if (up.kind === 'space') {
      const dw = Math.max(0, Math.trunc(up.payload.width ?? 0));
      const dh = Math.max(0, Math.trunc(up.payload.depth ?? 0));
      this.grow = { w: this.grow.w + dw, h: this.grow.h + dh };
      // Land extends the building you have, rather than re-deriving one. Both
      // are kept: `grow` still sizes a shop that has never been stamped, and the
      // shell is what a stamped one actually is.
      //
      // It extends east and south, never re-centring, because a stored shop's
      // fixtures are absolute — nudging the west wall out would move the whole
      // building out from under every shelf in it.
      if (this.shell) this.shell = { w: this.shell.w + dw, h: this.shell.h + dh };
    }

    // Land is the only upgrade left that changes the shape of the world. Every
    // other structural one used to, because buying shelving moved shelving;
    // buying a deal on shelving moves nothing until you go and build something.
    if (up.kind === 'space') this.regenerateLayout();
    this.pushLog(`Bought ${up.name}.`);
    return ok({ upgrade: upgradeId });
  }

  /**
   * Throw the arrangement away and let the generator lay the shop out again.
   *
   * The way back to a procedurally furnished shop once one has been stamped,
   * and it has to exist as its own verb now. `clearPlacements` on the regenerate
   * endpoint used to get this for free: the ledger said how many shelves you
   * owned quite independently of where any of them were, so dropping every
   * placement left the generator a list to work from. With the shop *being* its
   * placements, dropping them without saying what to put back is how you end up
   * standing in an empty building.
   *
   * So the count is taken first. The shell goes with them — a stored shell means
   * "build exactly this size and place nothing", which is the opposite of what
   * is being asked for — and what comes out is re-stamped on the way, exactly
   * the way a brand-new world is.
   *
   * @param {object} [want] what to furnish with; defaults to what is there now.
   */
  reflow(want = null, newSeed = null) {
    const spec = want ?? budgetOf(this.placements);
    this.placements = [];
    this.shell = null;
    this.regenerateLayout(newSeed, {}, { want: spec });
    this.freezeShell();
    return this.layout;
  }

  /**
   * Stamp the shop once, and stop generating it.
   *
   * The moment a world first opens, everything the generator laid out becomes a
   * placement and the size of the building becomes a stored fact. From then on
   * the "generator" only ever re-applies what is already there: same fixtures,
   * same tiles, same building, no search. That is step 4 of docs/building.md.
   *
   * Three things stop being possible once this has run, and each of them is a
   * bug somebody has actually hit:
   *
   * - **The shop re-flowing under you.** Buying a shelf used to re-run the whole
   *   generator, which could shuffle every other shelf to make room. Your aisles
   *   are yours now.
   * - **`droppedPlacements` in ordinary play.** It existed to apologise for the
   *   above. The mechanism stays as a backstop — a wall you build can still make
   *   a cell illegal — but a purchase can no longer trigger it.
   * - **A generated id being re-minted.** `shelf-p0` was invented fresh on every
   *   re-flow, which is why anything remembered against one drifted onto a
   *   different fixture. Frozen into placements, the ids stop moving.
   *
   * Idempotent, and deliberately: it runs on every load and does nothing at all
   * once `shell` is set. A migration you have to remember to run is a migration
   * that gets run twice or never.
   */
  freezeShell() {
    if (this.shell) return false;

    // Everything standing in the generated shop, as placements. `fixturesOf`
    // rather than four hand-written loops, so a kind added later is carried
    // across on the day it exists rather than the day somebody notices.
    const frozen = [];
    const known = new Set(this.placements.map((p) => p.id));
    for (const f of fixturesOf(this.layout)) {
      if (known.has(f.id)) continue;   // already a placement — leave it be
      frozen.push({
        id: `fx-${this.nextFixtureId++}`,
        kind: f.kind,
        piece: f.piece ?? null,
        station: f.station ?? null,
        x: f.x,
        z: f.z,
        rot: f.rot ?? 0,
        tier: f.tier ?? 1,
        variant: f.variant ?? '',
        boh: f.boh === true,
      });
    }

    // The generated ids go with them, so whatever was on `shelf-p0` follows it
    // onto its new one. Same mechanism a moved fixture already uses.
    const alias = {};
    let i = 0;
    for (const f of fixturesOf(this.layout)) {
      if (known.has(f.id)) continue;
      alias[f.id] = frozen[i++].id;
    }

    this.placements = [...this.placements, ...frozen];
    // Where it is, as well as how big. A shop that predates the field reads as
    // the position it was generated at, so nothing standing in one moves — see
    // `storeNorth` in server/layout.js for why that matters more than it looks.
    this.shell = { w: this.layout.store.w, h: this.layout.store.h, z: this.layout.store.z };
    this.regenerateLayout(null, alias);
    return true;
  }

  /**
   * Stamp the yard once, by exactly the argument `freezeShell` makes about the
   * shelving.
   *
   * The delivery bay and the drop-off were procedural until this landed:
   * `compose` re-stamped them against the corners of the back wall on every
   * single re-flow, so they could not be moved, resized or got rid of — buying
   * a shelf put them back where they were. Laid into the ground overlay they
   * are painted cells like any other, and the generator has no opinion about
   * them at all.
   *
   * Its own stamp rather than a branch inside `freezeShell`, and the reason is
   * the case `freezeShell`'s early return would miss: a world saved before this
   * existed already has a shell, so it would never run — and its yard tiles came
   * from a generator that no longer draws them, which means the shop would open
   * with no bay at all. This runs on every load and stamps once, so that world
   * gets its pads handed to it on the very tiles they used to occupy and
   * notices nothing.
   *
   * The mark is its own boolean and not "does this shop own any pads", because
   * those are different questions the moment a player paints over the last one.
   * Deleting your bay has to stay deleted; re-seeding it on the next load would
   * make the pads the one thing in the shop you are not allowed to get rid of,
   * which is the whole complaint this feature answers.
   */
  freezeYard() {
    if (this.yardStamped) return false;
    this.yardStamped = true;
    const yard = defaultPads(this.layout);
    if (!yard.length) return false;
    this.ground = [...this.ground, ...yard];
    this.regenerateLayout();
    return true;
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
   * @param {object} [opts]
   * @param {boolean} [opts.compensate] pay a dropped placement back. False for a
   *   caller that is only asking "what would this look like" and intends to put
   *   the placements back itself — see `moveDoor`.
   * @param {object} [opts.want] furnish an *unstamped* shop with this, rather
   *   than with the base shop: `{shelf, freezer, checkout, plot, stations}`.
   *   The only way left to hand the generator a shopping list, because there
   *   isn't one any more — see `reflow`, which is the one caller in the game,
   *   and the verify sweeps, which need a shop of a stated shape to drive.
   */
  regenerateLayout(newSeed, alias = {}, { compensate = true, want: asked = null } = {}) {
    const oldShelves = this.layout.shelves;
    const oldPlots = this.layout.plots;
    const oldStations = this.layout.stations ?? [];
    const c = content();

    // What to furnish with. A stamped shop asks for exactly what is standing in
    // it, so every budget is spent on placements before the generator reaches
    // its own loops and it lays nothing — which is what "the shop stays where
    // you put it" is, from the generator's side of the fence.
    const want = this.shell
      ? budgetOf(this.placements)
      : { ...BASE_FIXTURES, stations: [], ...(asked ?? {}) };
    const layout = generateLayout({
      seed: newSeed ?? this.seed,
      shelves: want.shelf,
      freezers: want.freezer,
      checkouts: want.checkout,
      plots: want.plot,
      stations: want.stations,
      placements: this.placements,
      grow: this.grow,
      doorShift: this.doorShift,
      edits: this.edits,
      ground: this.ground,
      yardStamped: this.yardStamped,
      shell: this.shell,
    });

    // A placement the re-flow could no longer honour is paid back rather than
    // put back. It used to go back to the generator, which re-sited it wherever
    // it fancied — possible only while the ledger said you owned one regardless
    // of where it was. With the shop being its placements, "put it back" has
    // nowhere to put it, and quietly destroying something you bought is worse
    // than either. So you get the money, at full price rather than the tear-out
    // rate: you didn't choose to sell it, the building did.
    if (layout.droppedPlacements?.length) {
      const gone = new Set(layout.droppedPlacements);
      const lost = this.placements.filter((p) => gone.has(p.id));
      this.placements = this.placements.filter((p) => !gone.has(p.id));
      if (compensate) {
        const back = round2(lost.reduce(
          (s, p) => s + this.fixtureUnitCost(p.kind, p.station, p.piece), 0,
        ));
        this.cash = round2(this.cash + back);
        this.pushLog(`${gone.size} placed fixture(s) no longer fit — $${back.toFixed(2)} refunded.`);
      }
    }

    // Appliances keep whatever was in them across a re-flow.
    carryOver(layout.stations, oldStations, alias,
      ['contents', 'busyUntil', 'making', 'output', 'startedAt'],
      (from, to) => from.station === to.station);

    carryOver(layout.shelves, oldShelves, alias,
      ['stacks', 'assigned', 'priority'],
      (from, to) => {
        // Don't move freezer-only goods onto a normal shelf. Every board has to
        // pass, not just the first: carrying a unit whose middle board is ice
        // cream onto ordinary shelving would leave it there melting.
        const frozen = (from.stacks ?? []).some((k) => {
          const item = k.item_id ? c.byId.items[k.item_id] : null;
          return item && requiredFixture(item) === 'freezer';
        });
        return !(frozen && to.kind !== 'freezer');
      });

    // Boards and reservations the destination cannot honour are dropped, not
    // carried. It has to be a sweep afterwards rather than another clause in
    // the predicate above: failing that test skips *every* key, so refusing the
    // row over a bad reservation would destroy the goods on it to save the
    // label. Clearing it costs the player a choice they can remake; the other
    // way round costs them a shelf full of stock.
    //
    // Boards are new here, and they are the reason this sweep grew a second
    // half: a three-board unit re-flowing onto a design that draws two has to
    // shed one, or it keeps stock on shelving that does not exist and the menu
    // offers a checkbox nothing can honour. The last board goes rather than a
    // chosen one — with no positions to speak of, the honest rule is that the
    // boards you filled first are the boards you keep.
    for (const s of layout.shelves) {
      const kept = toList(s.assigned);
      s.assigned = kept.filter((id) => {
        const want = c.byId.items[id];
        return want && (requiredFixture(want) === 'freezer') === (s.kind === 'freezer');
      });
      const boards = this.shelfBoards(s);
      s.stacks = this.shelfStacks(s).filter((k) => {
        const item = k.item_id ? c.byId.items[k.item_id] : null;
        // An item nobody can look up rides along rather than being binned. The
        // same forgiveness `pieceFor` shows a deleted design, and it matters
        // more here: content is edited live, so somebody tidying an item out of
        // the catalog would otherwise destroy every case of it on every shelf in
        // the shop, on the next re-flow, with a refund for nothing.
        if (!item) return true;
        return (requiredFixture(item) === 'freezer') === (s.kind === 'freezer');
      });
      if (s.assigned.length > boards) s.assigned = s.assigned.slice(0, boards);
      if (s.stacks.length > boards) {
        for (const k of s.stacks.slice(boards)) {
          if (k.qty > 0) this.dropGoods(k.item_id, k.qty, s.browseAt);
        }
        s.stacks = s.stacks.slice(0, boards);
      }
    }

    // `yield` rides along or a re-flow would hand the bed a different harvest
    // than the one it has been drawing.
    carryOver(layout.plots, oldPlots, alias, ['soil', 'crop_id', 'plantedAt', 'ready', 'yield']);

    if (newSeed) this.seed = String(newSeed);
    this.layout = layout;
    this.layoutVersion++;
    this.walk = buildWalkGrid(layout);
    this.layQueueLanes();

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
      cu.targetShelf = null;
      // Anyone on their way out stays on their way out. Sending them back to
      // BROWSE restarts a shopper who has already paid — with an emptied basket
      // and a finished list, so they walk back in, find they want nothing, and
      // are counted as having left empty-handed. Every re-flow charged the shop
      // 0.015 reputation for each of them, and a player who is *building* is
      // re-flowing constantly: reputation floors, `pull` floors with it, and the
      // shop stops getting customers for the crime of having served some.
      if (cu.state === 'LEAVE') {
        const out = this.rng.pick(this.layout.approaches ?? [this.layout.spawn]);
        if (this.pathTo(cu, out) && out.off) cu.path.push({ ...out.off });
        continue;
      }
      cu.state = 'BROWSE';
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

  /**
   * How full the shop is, as a ratio of what it can hold. 1.0 is comfortably
   * busy; above that people start getting in each other's way.
   *
   * Counts everyone past the door, including the ones on their way out — they
   * are still bodies on the floor. The ones still walking up the path outside
   * are not in the shop yet, and counting them would have the shop turn people
   * away because of the queue *to get in*.
   */
  measureOccupancy() {
    const inside = Object.values(this.customers)
      .reduce((n, cu) => n + (cu.state === 'ENTER' ? 0 : 1), 0);
    // Units with something on them, NOT boards. How much room a shop has is
    // about how many places there are to stand and browse, and a shelf holding
    // three things is still one shelf with one aisle in front of it — counting
    // boards would have ticking a checkbox make the building bigger.
    const stocked = this.layout.shelves.reduce((n, s) => n + (this.shelfQty(s) > 0 ? 1 : 0), 0);
    const capacity = this.layout.checkouts.length * CAPACITY_PER_TILL
      + stocked * CAPACITY_PER_SHELF;
    // A shop with no till and nothing on the shelves is not a shop with
    // infinite room; it is one nobody can use.
    return capacity > 0 ? inside / capacity : Infinity;
  }

  /**
   * How the room feels, averaged over everyone actually in it.
   *
   * An empty shop reads as 1 rather than 0: nobody is having a bad time in
   * there. Averaging over nobody and calling it misery would have the meter
   * bottom out every night at closing, which is the one moment it means least.
   */
  shopMood() {
    let sum = 0;
    let n = 0;
    for (const cu of Object.values(this.customers)) {
      if (cu.state === 'ENTER' || cu.state === 'LEAVE') continue;
      sum += cu.mood;
      n++;
    }
    return n ? sum / n : 1;
  }

  stepSpawning(dt, c, folded) {
    if (!this.isOpen() || c.archetypes.length === 0) return;
    const rate = footfall({
      day: this.day, hourFraction: this.time,
      reputation: this.reputation, folded, catchment: this.catchment(),
    });
    this.spawnAccumulator += (rate / 60) * dt;
    while (this.spawnAccumulator >= 1) {
      this.spawnAccumulator -= 1;

      // Full. They look in, see it, and go somewhere else — which is the whole
      // point: footfall used to keep pushing people at a shop that could not
      // serve them, and the only thing that ever pushed back was reputation
      // three days later. This is the same loop, closed on the same tick.
      if (this.occupancy > TURN_AWAY_AT) {
        this.stats.turnedAway++;
        this.reputation = clamp(this.reputation - 0.005, 0, 1);
        // Logged on the way in and out of the state rather than per person, or
        // a busy hour buries every other line in the log.
        if (!this.turningAway) {
          this.turningAway = true;
          this.pushLog('The shop is packed — people are looking in and walking on by.');
        }
        continue;
      }
      if (this.turningAway) this.turningAway = false;
      this.spawnCustomer();
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
    const units = this.rng.int(arch.basket_min, arch.basket_max);
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
      // Set at the till and never read by the sim — it is what they walk out
      // holding. See the `basket` line in `snapshot`.
      bought: null,
      budget: this.rng.float(arch.budget_min, arch.budget_max),
      wantCount: units,
      list: this.rollList(arch, units),
      errandAt: -1,
      missed: [],
      settled: false,
      impulsed: false,
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
   * What this shopper came in for, as a list of TAG lines.
   *
   * A line is a tag and never an item id — a shopper who wants `tomato` breaks
   * the day somebody authors a second red thing, and the whole game is built so
   * that never has to happen. `dairy` is answered by whatever dairy is on the
   * shelf today.
   *
   * `units` is `basket_min..basket_max`, unchanged in meaning: it is still how
   * many things they leave with, now spread across lines rather than counted
   * flat. So basket sizes — and the balance tuned around them — come out where
   * they were.
   *
   * A repeat draw of a tag raises that line's `qty` instead of adding a second
   * line, which is what turns a strong affinity into "three of those" rather
   * than three separate errands for the same thing.
   */
  rollList(arch, units) {
    const lines = new Map();
    const add = (tag, must) => {
      const line = lines.get(tag) ?? { tag, qty: 0, got: 0, must: false, failed: false };
      line.qty++;
      line.must = line.must || must;
      lines.set(tag, line);
    };

    let placed = 0;
    // Staples first: these are the reason they left the house, so they get
    // their line even on a one-item trip.
    for (const tag of arch.staple_tags ?? []) {
      if (placed >= units) break;
      add(tag, true);
      placed++;
    }

    // The rest is opportunistic, drawn from what they already like. Negative
    // and zero affinities are excluded rather than clamped: a Health Nut with
    // `junk: -0.6` did not come in for junk, and `purchaseChance` would refuse
    // the line anyway — it would just fail as unmet demand and blame the shop.
    const wants = Object.entries(arch.affinities)
      .filter(([, w]) => w > 0)
      .map(([tag, w]) => ({ tag, w }));
    while (placed < units && wants.length) {
      // A trip is a few categories bought several of, not eight single items.
      // Past MAX_LIST_LINES a draw becomes another of something already on the
      // list. That is not flavour: a shelf is visited once and a one-unit line
      // is one visit, so an eight-line list walks a shopper past every shelf in
      // the building, burning patience and running them out of unvisited
      // shelves before the basket is full.
      const tag = lines.size >= MAX_LIST_LINES
        ? this.rng.pick([...lines.keys()])
        : this.rng.weighted(wants, 'w').tag;
      add(tag, false);
      placed++;
    }

    return [...lines.values()];
  }

  /** The line they are working on: first one still wanted and not written off. */
  openLine(cust) {
    return cust.list.find((l) => !l.failed && l.got < l.qty) ?? null;
  }

  /**
   * Nothing on the shelves answers this line. Written off rather than retried,
   * which is also what stops an unsatisfiable list looping — `chooseShelf` only
   * ever considers unvisited shelves, so a line runs out of candidates and
   * lands here.
   *
   * Only a *staple* they got none of counts against the shop. A missed
   * nice-to-have is browsing, and a line they got two of three on is the shelf
   * being thin, which `ANNOY_EMPTY_SHELF` already charges for.
   */
  failLine(cust, line) {
    line.failed = true;
    if (!line.must || line.got > 0) return;
    cust.missed.push(line.tag);
    cust.mood = clamp(cust.mood - ANNOY_MISSED_STAPLE, 0, 1);
    this.stats.unmet[line.tag] = (this.stats.unmet[line.tag] ?? 0) + 1;
  }

  /**
   * They have stopped shopping, for whatever reason. Charge for the staples
   * that went unmet, then route them to the till or out of the door.
   *
   * The three ways to stop shopping all pass through `chooseShelf`, which is
   * why this can be one place. A storm-out is the exception and deliberately
   * skips it: `stormOut` already takes 0.03 off reputation, and the tally was
   * taken when the line failed.
   */
  stopShopping(cust, arch) {
    // Once per shopper, whatever happens to them afterwards. Anything that puts
    // a finished customer back on the shop floor — a layout re-flow is the one
    // that bites — must not be able to bill the shop for them twice.
    const first = !cust.settled;
    cust.settled = true;

    // The whole exchange, tallied here because this is already the once-per-
    // shopper point the shop is billed at — and it has to be once, or a layout
    // re-flow that puts a finished shopper back on the floor counts their list
    // twice and the demand meter reads a shop that was busier than it was.
    //
    // A line they never reached counts as asked and not served, which is right
    // whatever stopped them: they came in for it and left without it. It does
    // mean a till so slow that people give up shows as unserved *demand* rather
    // than as a queue, so the two readouts have to be read together — the
    // walked-out count in the Shop report is the other half.
    if (first) {
      for (const line of cust.list) {
        this.stats.asked[line.tag] = (this.stats.asked[line.tag] ?? 0) + line.qty;
        this.stats.served[line.tag] = (this.stats.served[line.tag] ?? 0) + line.got;
      }
    }

    if (first && cust.missed.length) {
      this.reputation = clamp(
        this.reputation - REP_MISSED_STAPLE * cust.missed.length, 0, 1,
      );
      const name = arch?.name ?? 'customer';
      this.pushLog(`A ${name} came in for ${cust.missed.join(' and ')} and you had none.`);
    }

    if (cust.basket.length) return this.goToTill(cust, arch);
    if (first) {
      // Walking out empty-handed is a much stronger signal than a happy sale,
      // so it moves reputation harder — otherwise a busy shop can post great
      // numbers while quietly failing a third of its customers.
      this.reputation = clamp(this.reputation - 0.015, 0, 1);
      this.stats.leftEmpty++;
    }
    return this.leaveShop(cust);
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
    // Everyone inside pays for the crush, whatever they're doing.
    if (this.occupancy > 1) annoy += ANNOY_CROWD * (this.occupancy - 1);

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
    // Everything on the list either bought or written off?
    if (!this.openLine(cust)) return this.stopShopping(cust, arch);

    // Fuming: not walking to one more shelf. Someone still empty-handed has
    // nothing to lose by leaving now; someone holding goods would rather pay
    // and get out, and will storm out of the line itself if it comes to that.
    if (cust.mood < MOOD_FUMING) {
      if (!cust.basket.length) return this.stormOut(cust);
      return this.stopShopping(cust, arch);
    }

    const ranked = rankShelves({
      // Back-of-house units are invisible to a shopper. One condition, here,
      // because `chooseShelf` is the single gate every shopping decision passes
      // through — filtering anywhere else would leave a customer able to *want*
      // something they can never walk to, which is how a shop starts turning
      // people away over stock it is holding in the kitchen.
      shelves: this.layout.shelves.filter((s) => !s.boh && !cust.visited.includes(s.id)),
      items: c.byId.items,
      archetype: arch,
      folded,
      season: this.season,
      reputation: this.reputation,
    }).filter(({ stack }) => {
      const inBasket = cust.basket.reduce((s, b) => s + b.price, 0);
      return stack.price + inBasket <= cust.budget;
    });

    if (ranked.length === 0) {
      // Nothing left in the shop they'd take at all — no point walking the rest
      // of the list. Every open staple is a miss, and they leave.
      for (const line of cust.list) if (!line.failed && line.got < line.qty) this.failLine(cust, line);
      return this.stopShopping(cust, arch);
    }

    // The two kinds of line part company here.
    //
    // A STAPLE is absolute: it is what they came in for, so if anything on an
    // unvisited shelf carries the tag that is where they are going, whatever it
    // costs them in conversion. Nothing carrying it is the miss worth counting.
    let target = null;
    let at = -1;
    for (let i = 0; i < cust.list.length; i++) {
      const l = cust.list[i];
      if (l.failed || l.got >= l.qty || !l.must) continue;
      const hit = ranked.find(({ item }) => item.tags.includes(l.tag));
      if (hit) { target = hit; at = i; break; }
      this.failLine(cust, l);
    }

    // Everything else is a PREFERENCE, and a preference weights the choice
    // rather than making it — see LIST_BONUS. They always end up at a shelf
    // worth walking to; the list decides which of the good ones.
    if (!target) {
      const open = cust.list.filter((l) => !l.failed && l.got < l.qty);
      if (!open.length) return this.stopShopping(cust, arch);
      const wanted = new Set(open.map((l) => l.tag));
      let best = -1;
      for (const cand of ranked) {
        const score = cand.chance * (cand.item.tags.some((t) => wanted.has(t)) ? LIST_BONUS : 1);
        if (score > best) { best = score; target = cand; }
      }
      if (!target) return this.stopShopping(cust, arch);
      // Which line does this serve? Its own tag if that is on the list;
      // otherwise the first open preference, which is a substitution.
      const openAt = (fn) => cust.list.findIndex((l) => !l.failed && l.got < l.qty && fn(l));
      at = openAt((l) => target.item.tags.includes(l.tag));
      if (at < 0) at = openAt((l) => !l.must);
      if (at < 0) at = cust.list.indexOf(open[0]);
    }

    cust.errandAt = at;
    cust.targetShelf = target.shelf.id;
    // WHICH board they walked over for. A unit can offer three things now, and
    // "the shelf they chose" stopped being enough to say what they came for —
    // without this they arrive and take whatever is on the first board, which is
    // a shopper who wanted cheese going home with milk.
    cust.targetItem = target.item.id;
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

    // The board they came for, not whichever one is first. `targetItem` is
    // missing on a shopper who was already mid-walk when this landed, and on
    // one aimed by an older path — falling back to the only stack keeps them
    // moving rather than freezing them in front of a shelf.
    const stacks = this.shelfStacks(shelf);
    const stack = (cust.targetItem ? this.shelfStack(shelf, cust.targetItem) : null)
      ?? (stacks.length === 1 ? stacks[0] : null);
    cust.targetItem = null;

    if (!shelf || !stack || stack.qty <= 0) {
      // `rankShelves` only ever aims them at a stocked board, so getting here
      // means somebody took the last one while this shopper was walking over.
      // A wasted trip is the shop being thin, not the shopper being unlucky.
      cust.mood = clamp(cust.mood - ANNOY_EMPTY_SHELF, 0, 1);
      return;
    }
    const item = c.byId.items[stack.item_id];
    if (!item) return;

    const chance = purchaseChance({
      item, archetype: arch, price: stack.price, folded,
      season: this.season, reputation: this.reputation,
    });

    // How many they take is how many that line still wants. This used to be a
    // flat MAX_UNITS_PER_SHELF, which existed only because a shelf is visited
    // once and a one-per-shelf basket was capped at the shelf count — the list
    // says "two milks" outright, so the constant retired with it.
    //
    // Each extra unit still passes its own roll and stays inside the budget, so
    // a weak match yields one and a strong one clears the errand.
    // By index, not by tag: a substituted line is being served by something
    // that does not carry its tag, which is the whole point of a substitution.
    const line = cust.list[cust.errandAt] ?? null;
    const spent = () => cust.basket.reduce((s, b) => s + b.price, 0);
    const maxRun = Math.min(line ? line.qty - line.got : 1, MAX_UNITS_PER_SHELF, stack.qty);

    for (let n = 0; n < maxRun; n++) {
      if (spent() + stack.price > cust.budget) break;
      if (this.rng.next() >= chance) break;
      stack.qty--;
      cust.basket.push({ item_id: item.id, price: stack.price });
      if (line) line.got++;
      // NOTE: the stack is deliberately LEFT on the shelf at qty 0 rather than
      // cleared, so the board keeps its label and its price and the stocker
      // knows what belongs there. Only spoiling and a strip take a board away —
      // selling out is the shelf doing its job, not the shelf changing.
    }
  }

  /**
   * Walk every till's line and remember where its places are.
   *
   * Laid beside the walk grid and for the same reason: a lane *is* a walk, so
   * anything that changes what can be walked over changes where the line
   * stands. Both are rebuilt at the two points the layout is set and there is
   * no third — a fixture you place re-flows the layout, which comes back
   * through here, so parking a shelf in the aisle pushes the line round it.
   *
   * `queueMax` is re-stamped rather than trusted, and the reason is the save
   * rather than the generator — `compose` already re-measures it at the end of
   * a fresh flow. The layout is *persisted*, so a shop stamped before lanes
   * existed carries a `queueMax` that is the old straight run, and the fixture
   * menu would print it. A read-time correction rather than a migration, the
   * same way `kindOf` handles a fixture row written before kinds.
   */
  layQueueLanes() {
    this.lanes = queueLanes(this.layout);
    for (const t of this.layout.checkouts ?? []) {
      t.queueMax = (this.lanes.get(t.id)?.length ?? 1) - 1;
    }
  }

  /** Where this till's line stands, `lane[0]` being the serving spot itself. */
  laneOf(till) {
    return this.lanes?.get(till.id) ?? [till.serveAt];
  }

  /**
   * Where the i-th person in a line stands. A copy, so a caller handing this
   * to `pathTo` can never write through it into the cached lane.
   *
   * The clamp is a last resort and should almost never fire now: a lane turns
   * corners, so it runs out only in a shop with nowhere left to put anybody,
   * and a queue that long means the turn-away rule should have stopped them at
   * the door. It used to fire constantly — the lane was a straight run of at
   * most eight and every shopper past the end was handed the last slot, which
   * is exactly what a pile of people standing inside one another at a busy
   * till was.
   */
  queueSlot(till, i) {
    const lane = this.laneOf(till);
    const c = lane[Math.min(i, lane.length - 1)];
    return { x: c.x, z: c.z };
  }

  goToTill(cust, arch = null) {
    if (cust.basket.length === 0) return this.leaveShop(cust);

    // Join the shortest queue.
    const tills = this.layout.checkouts;
    if (tills.length === 0) return this.leaveShop(cust);
    for (const t of tills) t.queue = t.queue ?? [];
    const till = tills.reduce((a, b) => (a.queue.length <= b.queue.length ? a : b));

    const ahead = till.queue.length;
    till.queue.push(cust.id);
    cust.till = till.id;
    cust.state = 'TO_TILL';
    cust.waited = 0;

    const goal = this.queueSlot(till, till.queue.length - 1);
    if (!this.pathTo(cust, goal)) return this.leaveShop(cust);

    this.impulseBuy(cust, arch, till, ahead);
  }

  /**
   * The endcap. One look at whatever is stacked by the till they just joined.
   *
   * There is no endcap fixture and there should not be one: `BUILD_KINDS` is
   * closed because where a thing may go is behaviour, and an endcap is neither
   * a new behaviour nor a new piece — it is a shelf you chose to put next to a
   * checkout. Deriving it from the distance makes *placement* worth money for
   * the first time, and makes the rule something a player finds rather than
   * reads.
   *
   * Off-list on purpose, so this can push a basket past `wantCount` — that is
   * what an impulse buy is. `visited` is ignored too: walking past a shelf and
   * declining it is not a decision that survives contact with the sweets.
   */
  impulseBuy(cust, arch, till, ahead) {
    if (cust.impulsed) return;
    cust.impulsed = true;
    // Somebody visibly cross is not browsing the sweets on the way out.
    if (!arch || cust.mood < MOOD_ANNOYED) return;

    const c = content();
    const folded = this.folded();
    const spent = cust.basket.reduce((s, b) => s + b.price, 0);
    // A longer line is longer spent looking at it.
    const dwell = 1 + IMPULSE_PER_AHEAD * Math.min(ahead, IMPULSE_MAX_AHEAD);

    let best = null;
    for (const shelf of this.layout.shelves) {
      if (Math.hypot(shelf.x - till.x, shelf.z - till.z) > IMPULSE_RADIUS) continue;
      // Every board by the till competes on its own. A sweet on the top shelf
      // and a magazine on the middle are two temptations, and judging the unit
      // by one of them is most of the point of a display by the checkout gone.
      for (const stack of this.shelfStacks(shelf)) {
        if (!stack.item_id || stack.qty <= 0) continue;
        const item = c.byId.items[stack.item_id];
        if (!item) continue;
        if (spent + stack.price > cust.budget) continue;
        const chance = purchaseChance({
          item, archetype: arch, price: stack.price, folded,
          season: this.season, reputation: this.reputation,
        }) * IMPULSE_BASE * impulsePull(item) * dwell;
        if (chance > 0 && (!best || chance > best.chance)) best = { stack, item, chance };
      }
    }

    if (!best || this.rng.next() >= best.chance) return;
    best.stack.qty--;
    cust.basket.push({ item_id: best.item.id, price: best.stack.price });
    this.stats.impulse++;
  }

  /**
   * How long one sale takes at this till, for whoever is ringing it up.
   *
   * The first thing in the game to read a checkout's tier at all — before this
   * the ladder was priced at 0 precisely because nothing did, which is the
   * honest version of a button that takes money and does nothing.
   *
   * `base` is the sale at a plain till: a second for a person holding the
   * action, `AUTO_SERVE_TIME` for the bot standing in for one.
   */
  serveSeconds(till, base = ACTION_TIMES.serve) {
    return base / (this.fixtureStats(till).speed_mult || 1);
  }

  /**
   * ...and the same sale with nobody behind the counter, or Infinity.
   *
   * Infinity rather than a flag, so the caller is a comparison rather than a
   * branch: every till ever built answers it, and a line at one waits forever,
   * which is exactly what a queue with nobody serving it did before there was
   * such a thing as a self-checkout.
   */
  selfServeSeconds(till) {
    const { speed_mult: speed, unattended } = this.fixtureStats(till);
    if (!(unattended > 0)) return Infinity;
    return ACTION_TIMES.serve / ((speed || 1) * unattended);
  }

  stepQueue(cust, dt) {
    // Still counted, and only for the log and the HUD. Patience itself is spent
    // in `stepMood`, which also charges for the walk up the line.
    cust.waited += dt;

    const till = this.layout.checkouts.find((t) => t.id === cust.till);
    if (!till) return this.leaveShop(cust);

    // "Front" means the first shopper actually standing in their slot — the
    // ones ahead who are still walking must not hold up the till.
    const isFront = till.queue
      .map((id) => this.customers[id])
      .find((cu) => cu && cu.state === 'QUEUE') === cust;
    if (!isFront) return;

    /**
     * The TILL's clock, not the shopper's.
     *
     * This used to time off `cust.waited`, which is how long they have been in
     * the *line* — and by the time somebody reaches the front that is most of
     * the length of the queue, so each of them was already past the threshold
     * on the tick they arrived and the whole line rang through as fast as it
     * could shuffle forward. Which meant a till had no throughput to be better
     * at, and no ladder could ever have been worth buying.
     *
     * Stamped with whose sale it is so it resets itself for free: the front
     * changing for any reason at all — served, stormed out, a re-flow — is the
     * next tick finding a different id here.
     */
    if (till.ringing !== cust.id) { till.ringing = cust.id; till.rang = 0; }
    till.rang += dt;

    // Auto-serve exists so headless balance runs don't need a human at the
    // till. A self-checkout is the same idea with money behind it: the machine
    // rings its own line up, only slower than a person would.
    const takes = this.autoServe
      ? this.serveSeconds(till, AUTO_SERVE_TIME)
      : this.selfServeSeconds(till);
    if (till.rang >= takes) return this.completeSale(cust);
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
    const items = content().byId.items;
    for (const line of cust.basket) {
      this.stats.byItem[line.item_id] = (this.stats.byItem[line.item_id] ?? 0) + 1;
      // ...and again by department, which is not the same tally read a second
      // way. A shelf earns its space by what leaves it, and most of what leaves
      // a shop was never asked for by department: a `cheap` line is filled by a
      // frozen pizza and a `kids` line by a chocolate bar, so counting asks
      // would have the demand meter tell you to tear the freezers out of a shop
      // that sells nine frozen lines. Tallied at the sale rather than at the
      // shelf, because an abandoned basket is not a sale.
      for (const tag of items[line.item_id]?.tags ?? []) {
        if (DEPARTMENTS.includes(tag)) this.stats.moved[tag] = (this.stats.moved[tag] ?? 0) + 1;
      }
    }
    // Happy customers nudge reputation up; a long wait blunts that.
    this.reputation = clamp(this.reputation + 0.004 * cust.mood, 0, 1);
    // Out of the basket and into their arms — the shop no longer owns it, but
    // they still have it until they are off the map.
    cust.bought = cust.basket;
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
    // Nudge onto the till itself so the pile reads as "on the counter" rather
    // than standing in the queue.
    this.dropCashAt(till ? till.x : at.x, till ? till.z : at.z, amount);
  }

  /**
   * ...and the same pile, anywhere.
   *
   * Split out when fixtures started earning: a money tree pays into the exact
   * entity a till does, so it renders, is picked up and is tidied away by the
   * code that already existed. A second kind of money on the floor would need
   * its own everything, which is the mistake `dropGoods` exists not to repeat.
   */
  dropCashAt(x, z, amount) {
    if (amount <= 0) return null;
    // Fan successive piles — stacked at one point they read as a single sale no
    // matter how many are waiting.
    const n = this.nextCashId;
    const spread = [[0, 0], [0.3, 0.16], [-0.28, 0.2], [0.16, -0.22], [-0.18, -0.16]][n % 5];

    const drop = {
      id: `cash-${this.nextCashId++}`,
      x: x + spread[0],
      z: z + spread[1],
      amount: round2(amount),
      bornDay: this.day,
      bornAt: this.elapsed,
    };
    this.cashDrops.push(drop);
    return drop;
  }

  /**
   * Everything in the shop that earns on its own, paid out on its own clock.
   *
   * Per fixture rather than on one global cadence, so two trees planted an hour
   * apart do not pay in lockstep — and the clock is stored, because a tree that
   * reset its timer on every restart would pay nothing in a session anybody was
   * actively building in, which is every session.
   *
   * It pays whether or not the shop is open. A money tree does not keep hours,
   * and the pile is still there in the morning.
   */
  stepYields() {
    for (const p of this.placements) {
      const piece = pieceFor(content().fixtures ?? [], p);
      const y = piece?.yields;
      if (!y?.cash || !(y.every > 0)) continue;
      const period = y.every * SECONDS_PER_MIN;
      const last = this.yieldedAt.get(p.id);
      // A fixture that has never paid starts its clock now rather than owing a
      // payout for every minute since the world began. A stamp in the FUTURE
      // means the world reloaded under it and `elapsed` went back to zero —
      // same reset, same reason.
      if (last == null || last > this.elapsed) { this.yieldedAt.set(p.id, this.elapsed); continue; }
      if (this.elapsed - last < period) continue;
      // One payout per tick at most, even if the shop was closed for hours.
      // Banking up eight of them dumps a pile you did not watch accumulate,
      // which reads as a bug rather than as a reward.
      this.yieldedAt.set(p.id, this.elapsed);
      this.dropCashAt(p.x, p.z, y.cash);
    }
    // A fixture that was torn out should not keep a clock — otherwise the map
    // grows for the life of the save.
    if (this.yieldedAt.size > this.placements.length) {
      const live = new Set(this.placements.map((p) => p.id));
      for (const id of this.yieldedAt.keys()) if (!live.has(id)) this.yieldedAt.delete(id);
    }
  }

  /**
   * How nice the shop looks, as one number.
   *
   * Summed off what is actually standing in the shop — the same recount
   * `fixtureCounts` makes, for the same reason a stored total would drift. Plus
   * whatever `decor` upgrades are owned, which is the first thing that has ever
   * read that upgrade kind: it has been in the schema and dead since the day it
   * was written.
   */
  charm() {
    const rows = content().fixtures ?? [];
    const fromShop = this.placements.reduce(
      (s, p) => s + (pieceFor(rows, p)?.charm ?? 0), 0,
    );
    return round2(fromShop + countUpgrade(this, 'decor', 'charm'));
  }

  /**
   * ...and how much of the town that reaches, which saturates.
   *
   * Diminishing on purpose, and hard: without it the cheapest strategy in the
   * game is a room full of pot plants, and "a hundred planters" is a warehouse
   * rather than a destination. The curve gives roughly half of `CHARM_MAX` at
   * ten charm and never quite arrives, so there is always a reason to add one
   * more and never a reason to add twenty.
   */
  charmReach() {
    const c = this.charm();
    if (c <= 0) return 0;
    return round2(CHARM_MAX * (1 - Math.exp(-c / CHARM_HALF)));
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
      /**
       * Everyone behind shuffles forward — *everyone*, including the ones still
       * walking up to the place they were given.
       *
       * This used to skip anybody not already standing still (`state !==
       * 'QUEUE'`), and that is the second way a line piled up, at ordinary
       * lengths that fit the lane with room to spare. A shopper's place is
       * their index in `till.queue`, and this call is where that index moves.
       * Skipping the walkers left one heading for a slot the line no longer
       * reached — and the next arrival is handed `queue.length - 1`, which is
       * exactly the slot the walker is still crossing the shop towards. Two
       * people, one tile, and neither of them ever did anything wrong.
       *
       * The two states are one thing here: both are people whose place in this
       * line just changed, and a walker is only a stander who has not arrived.
       * The gap it leaves the rest of the time is the same bug wearing a
       * disguise — a line with a hole in it where somebody left.
       */
      till.queue.forEach((id, i) => {
        const other = this.customers[id];
        if (!other || (other.state !== 'QUEUE' && other.state !== 'TO_TILL')) return;
        this.pathTo(other, this.queueSlot(till, i));
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
    if (p.carry && this.onPad(p, this.dropPadKind())) return this.stow(playerId);

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
    spoiled: 0, harvested: 0, tilled: 0, leftEmpty: 0, turnedAway: 0, byItem: {},
    // Staples people came in for and you did not stock, by tag. The one number
    // in here that says what to do about itself.
    unmet: {}, impulse: 0,
    // What every shopping list asked for and how much of it got filled, by tag.
    // `unmet` is the same idea narrowed to staples-missed-entirely, because it
    // exists to move reputation; these two are the whole exchange, which is what
    // a demand meter needs — a department served nine asks out of ten is doing
    // well, and `unmet` cannot tell that from silence. Tallied once per shopper
    // in `stopShopping`.
    asked: {}, served: {},
    // Units that actually left, by department, tallied at the till. The other
    // half of the demand meter, and it has to be its own count rather than a
    // projection of `served`: see `completeSale`.
    moved: {},
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
 * What to furnish a shop that has never been stamped with.
 *
 * The last thing that reads `world.fixtures`, and it reads it at most once per
 * save ever: `Game.create` stamps the shop (`freezeShell`) the moment it has
 * built one, and from then on the shop *is* its placements and this is never
 * consulted again. A read-time default rather than a migration script — the same
 * shape `kindOf` uses for a piece with no kind — so an old save, a fresh seed
 * and a world created five minutes ago all boot with nobody having to run
 * anything.
 *
 * Three generations of save land here and all three have to come out right:
 * one with a stored ledger (use it), one from before the ledger with staff and
 * fixtures as upgrade ownership (count them), and a brand new world (the base
 * shop). Hand a sixteen-shelf save the base shop and it opens with six.
 */
function starterShop(w) {
  const led = w.fixtures ? { ...BASE_FIXTURES, ...w.fixtures } : {
    shelf: BASE_FIXTURES.shelf + countUpgrade(w, 'shelf', 'shelves'),
    freezer: BASE_FIXTURES.freezer + countUpgrade(w, 'freezer', 'freezers'),
    checkout: BASE_FIXTURES.checkout + countUpgrade(w, 'checkout', 'checkouts'),
    plot: BASE_FIXTURES.plot + countUpgrade(w, 'plot', 'plots'),
  };

  // Appliances were upgrade *ownership* — one of each, forever, sited by the
  // generator — before they became things you put down. A save from either side
  // of that keeps what it bought.
  //
  // The presence of any `station:` key is what says the ledger generation had
  // already happened, not the counts: they can all legitimately be zero once you
  // tear the last one out, and re-deriving from `ownedUpgrades` would hand it
  // straight back.
  const stations = [];
  if (Object.keys(led).some((k) => k.startsWith('station:'))) {
    for (const [key, n] of Object.entries(led)) {
      if (!key.startsWith('station:')) continue;
      for (let i = 0; i < n; i++) stations.push(key.slice('station:'.length));
    }
  } else {
    const owned = w.ownedUpgrades ?? [];
    for (const u of content().upgrades) {
      if (u.kind !== 'station' || !u.payload?.station) continue;
      if (owned.includes(u.id)) stations.push(u.payload.station);
    }
  }
  return { ...led, stations };
}

/**
 * The stored ledger, rebuilt on the way out to disk and never read back in.
 *
 * Purely so a build from before step 9 can still boot a save written by one
 * after it: that build calls `fixtureLedger(w)`, and handed nothing it would
 * furnish a sixteen-shelf shop with six. Derived from the placements at write
 * time, so unlike the thing it replaces it cannot drift out of step with them.
 */
function legacyLedger(placements) {
  const out = { ...budgetOf(placements) };
  for (const s of out.stations) out[`station:${s}`] = (out[`station:${s}`] ?? 0) + 1;
  delete out.stations;
  return out;
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

/**
 * The side of a thing you work it from — one spelling, for three callers.
 *
 * `walkToFixture` routes here, `actionAt` points the ring here, and
 * `errandAction` measures reach from here. A fixture only ever carries one of
 * these fields, so any order of the three agrees today; they are one function
 * because the day a unit carries two of them, three copies falling out of step
 * would show up as a tap that walks you somewhere and then does nothing, which
 * reads as the tap having been ignored.
 */
const workSpot = (f) => f.browseAt ?? f.serveAt ?? f.useAt ?? f;

/**
 * Is this player going somewhere — under their own steering or on a route?
 *
 * One spelling for the two movers, because `stepActions` now asks the same
 * question `stepPlayers` does and a second opinion about whether somebody is
 * walking is a charge that fires on a frame the legs disagree about. Keys are
 * live input rather than a velocity, and a finished route is a null `path`, so
 * neither mover needs a position from last tick to answer it.
 */
function moving(p) {
  const { dx = 0, dz = 0 } = p.input ?? {};
  return dx !== 0 || dz !== 0 || p.path?.length > 0;
}
const r2 = (v) => Math.round(v * 100) / 100;
/**
 * One id, several, or none — always as a list.
 *
 * `assigned` was a single id or null and is a list now, and all three shapes
 * arrive at once: out of a save written before the change, off a record a
 * re-flow is carrying across, and in an `assign` message from a client that has
 * not reloaded yet. One reader for all of them beats three call sites each
 * remembering to check.
 */
const toList = (v) => (Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []));
const ok = (data = {}) => ({ ok: true, ...data });
const err = (message) => ({ ok: false, error: message });
