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
import {
  generateLayout, defaultPads, defaultAwning, buildWalkGrid, isWalkable, T,
} from '../layout.js';
import { E, SOLID, edgeBetween } from '../../shared/edges.js';
import { findPath, followPath } from './pathing.js';
import {
  foldModifiers, modifierMeter, departmentMeter, rankShelves, purchaseChance,
  stapleChance, suggestedPrice, wholesalePrice, footfall, pull, clamp, round2,
} from './economy.js';
import {
  spoilRate, requiredFixture, desireFor, impulsePull, tagLabel, DEPARTMENTS,
} from '../../shared/tags.js';
import { makeRng } from '../../shared/rng.js';
import { stepStaff, syncStaff, breakProgress, carryOf } from './staff.js';
import {
  FIXTURES, FIXTURE_KINDS, canPlace, rot4, FIXTURE_REFUND,
  canPlaceEdge, canPlaceEdges, edgeRun, isProp, fixturesOf, insideStore, queueLanes,
  canPaintGround, groundStroke, groundIndex, GROUND_STROKE_MAX,
  GROUND, PAD_KINDS, isGround, groundKindOfTile, padCells, isPadAt,
} from '../../shared/build.js';
import {
  pieceFor, kindOf, defaultPiece, countKey, boardsOf, fixtureLabel,
} from '../../shared/pieces.js';

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

/**
 * When the van comes. Hours of the day, ascending.
 *
 * **Runs, not timers**, and the difference is the whole feature. A per-order
 * countdown is "wait five minutes" — it makes ordering slower and changes
 * nothing about how you order. A fixed run means everything asked for before
 * the cutoff comes together, so *when* you order is a decision: a board that
 * dips at 13:50 is stocked by teatime and the same board dipping at 14:10 is
 * bare until morning. That is what makes a minimum worth setting and a maximum
 * worth thinking about, and it is why the settings in docs/ordering.md go from
 * numbers you set once to numbers that bind.
 *
 * **Every two hours while you are open, every hour while you are shut**, both
 * derived from the opening times rather than written out — a shop that opens
 * earlier gets an earlier first van with nothing else to change.
 *
 * It began as two runs, at 08:00 and 14:00, and two turned out to be a rule you
 * get caught by rather than one you plan around. Missing the 08:00 by a minute
 * cost five trading hours, and everything ordered overnight arrived on one lorry
 * regardless — so the honest description was "orders land twice", a mechanic
 * about the clock rather than about the shop. In play it read as the game
 * withholding stock: you order pizza at 09:00, you are told 14:00, and there was
 * nothing you could have done differently.
 *
 * The split is deliberately the opposite way round to the one you would guess,
 * and it is the trading day that earns the *slower* half. While the doors are
 * open a wait is a decision — a board that dips at 13:50 is stocked by teatime
 * and the same board at 14:10 is bare for two hours — and that is the whole
 * reason runs exist rather than per-order timers. Two hours is long enough for
 * that to bite and short enough that it is a cost rather than a wall.
 *
 * Night is the opposite: nobody is shopping, `NIGHT_SPEED` means those hours
 * cost almost no real time, and stock landing at 03:00 is on the shelf before
 * the doors open. There is nothing to plan around, so a wait there is dead time
 * and nothing else. Hourly overnight means a shop you left short is a shop that
 * opens full, which is what an overnight restock is FOR.
 *
 * Measured on a staffed shop over ten seeds: going from two runs to hourly took
 * shelves-found-empty from 206 to 53 and revenue up 12%. Almost all of that was
 * the night, which is why the night is the half that stayed hourly.
 */
const DELIVERY_RUNS = [
  // Open: every second hour, starting as the doors do.
  ...Array.from({ length: Math.ceil((CLOSE_HOUR - OPEN_HOUR) / 2) },
    (_, i) => OPEN_HOUR + i * 2),
  // Shut: every hour, from closing round to opening. Written as one sweep of
  // the clock so it cannot leave a gap when the trading hours move.
  ...Array.from({ length: 24 }, (_, h) => h).filter((h) => h < OPEN_HOUR || h >= CLOSE_HOUR),
].sort((a, b) => a - b);

/**
 * How long the van stands at the bay with its back doors open, in seconds.
 *
 * Counted down in `dt` rather than stamped against `elapsed`, and that is not
 * fussiness. A stamp would be a third thing in this file that lands in the
 * future on the next load (`plantedAt`, `yieldedAt`), and it would run at
 * `NIGHT_SPEED` overnight — a lorry emptying six times faster in the dark is
 * the "time-passage scales, bodies don't" line in `step`, and a van is a body.
 * A countdown that only ever sees `dt` cannot be either.
 */
const UNLOAD_SECONDS = 2.5;

/**
 * How fast a van goes when its row does not say. A `speed` is authored content
 * and this is a floor under a row somebody left blank, not a second opinion —
 * the same bargain `FALLBACK_FIXTURE_COST` strikes for a kind nobody priced.
 */
const VAN_SPEED = 3;

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
const CUSTOMER_SPEED = 2.2;
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

/**
 * THE CAR PARK.
 *
 * Three numbers, and every one of them moves the balance, so each says what it
 * is measured in and what the wrong value would look like from inside the game.
 * None of them is the size of a driver's shop — that is `capacity` on the car,
 * which is content (see `spawnCustomer`), and it is deliberately the only part
 * of this a person can author.
 *
 * `DRIVE_SHARE` is how many of the people the town sends you would have driven,
 * given somewhere to put the car. It is a share of arrivals rather than a rate,
 * because how many shoppers there are is `footfall`'s question and this one is
 * only "how did that one get here". Well under half on purpose: a car park is a
 * thing some of your customers use, and at 1.0 it would stop being a car park
 * and become the front door — every shopper who could not find a space would
 * read as the shop being closed to them, which is not what a full car park
 * means. It is also an upper bound and rarely the real figure: the roll is only
 * reached when a space is free, so a small pad that stays full is a shop where
 * far fewer than a third of arrivals drove, and that is the pad size being the
 * decision rather than this constant.
 *
 * `PARK_MAX` and `PARK_HALF` are the catchment half, and the ceiling is the
 * whole point — the same argument `CHARM_MAX` makes, made about ground that is
 * even cheaper to lay than a planter is to stand up. Without saturation the
 * cheapest strategy in the game is a field of tarmac, which is the sentence
 * CLAUDE.md already uses about pot plants. `PARK_MAX` is a quarter of
 * `BASE_CATCHMENT` and half of `CHARM_MAX`: parking widens the town by less
 * than a shop worth crossing it for does, because it is one decision on ground
 * rather than everything you have ever placed. `PARK_HALF` is the e-folding
 * size in spaces, so six spaces is about two thirds of the ceiling and twelve
 * is about six sevenths of it — a small pad is most of what a big one is worth,
 * and nothing anybody paints is worth more than `PARK_MAX`.
 */
const DRIVE_SHARE = 0.35;
const PARK_MAX = 4;
const PARK_HALF = 6;

const UNLOAD_REACH = 1.8;      // how close you stand to unload a pallet
/**
 * How much one crate holds, and the one number that makes hauling a decision.
 *
 * Twice a pair of hands, so a crate carried whole is worth two journeys and a
 * crate emptied by hand costs two. Not authored content: a crate is the only
 * container in the game and how much it holds is what a pad's size means (see
 * `bayRoom`, `padRoom`), so it belongs beside the other measurements of the
 * shop rather than on a row somebody can edit into an imbalance.
 */
const CRATE_UNITS = 12;

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

/**
 * How long a board sits empty with nothing coming before the unit takes it back.
 * One quiet day is a Tuesday; two is a decision. See `releaseBoards`.
 */
const EMPTY_BOARD_DAYS = 2;

/**
 * How long a board sits with stock ON it and nothing sold before the shop hand
 * takes it back — see `staleBoards` and the `merchandise` job.
 *
 * Longer than `EMPTY_BOARD_DAYS` on purpose, because the two are different
 * sizes of question: an empty board is asking to be refilled, a full one is
 * asking to be given up. Getting the first wrong costs a trip to the bay;
 * getting the second wrong throws away stock somebody paid for.
 */
const STALE_BOARD_DAYS = 4;

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
  /**
   * Picking a whole crate up, and setting it down again.
   *
   * ONE number for both ends on purpose. They were 1.0 and 0.8 by accident —
   * lifting fell through to `ACTION_TIME` and setting down borrowed `stow` —
   * and a hold that is shorter one way than the other reads as the game being
   * inconsistent rather than as two different jobs. It is the same object and
   * the same effort; the only thing that changes is which way up.
   *
   * Longer than `stow`, which is an armful going into a box you are stood over.
   * A crate is the box.
   */
  crate: 1.0,
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
    /**
     * Whether the shutters are up — YOUR half of "is the shop open".
     *
     * The other half is the clock, and it is still there: `isOpen` is this AND
     * `trading()`, so this can only ever shut you inside the business day, never
     * stretch it. Opening used to be entirely something that happened to you at
     * 08:00, which meant there was no way to close for an hour and rebuild an
     * aisle without shoppers walking through the rubble.
     *
     * Defaults to **open** so that no save that predates the switch moves — a
     * shop somebody was playing yesterday is a shop that trades tomorrow. A
     * brand-new world is written with `open: false` by `createWorld`, which is
     * the whole of "a new shop starts shut and you raise the shutters", and it
     * is written at CREATION rather than defaulted here on purpose: a default of
     * `false` would also shut every ephemeral game — `simulate` and every
     * `verify:*` sweep — and a balance run against a shop that never opens
     * measures nothing and says nothing about why.
     */
    this.open = state.open ?? true;
    /**
     * ...and whether the world is moving at all.
     *
     * Not saved, and not the same idea as `open`. Shut is a state of the shop
     * that the shop keeps having — stock spoils, staff restock, the night rolls
     * round. Paused is the absence of time: `step` returns before anything, so
     * nobody moves, nothing grows, no van arrives, and `elapsed` does not
     * advance, which is what keeps every stamp against it honest for free.
     *
     * In memory because it is a thing you do while you are sitting here, like
     * where the camera is pointing. A save that came back paused would be a
     * shop that looks broken on load with nothing on screen from before you
     * left to say why.
     */
    this.paused = false;
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
    /**
     * The lorry, while there is one on the road. In memory only, and never read
     * off `state` — that is the answer to "what happens to a van in flight when
     * the shop reloads", and it is a decision rather than an omission.
     *
     * **The order is the record; the van is only the picture of it.** A row
     * stays in `orders.pending` for the whole journey and leaves it in the same
     * breath as `dropGoods`, so there is exactly one place the goods can be at
     * any moment and a restart cannot lose them, double them, or leave them
     * aboard a lorry nobody is drawing. What a reload costs is one drive-in: the
     * row is already due, `loadVan` sends a fresh van from the edge of the map,
     * and thirty seconds later the shop is where it would have been.
     *
     * Saving it would mean saving a position and a half-eaten waypoint list
     * against a route that is recomputed on every re-flow — a van restored onto
     * a lane that moved under it, holding goods that are also still on the save.
     * Two records of one delivery is the mistake `dropGoods` exists to prevent,
     * wearing a windscreen.
     */
    this.van = null;
    /**
     * The car park, worked out once and kept until the layout changes —
     * `{ layout, cells }`. See `parkSpaces`, which is the only thing that reads
     * or writes it.
     *
     * Keyed on the layout OBJECT rather than on `layoutVersion`, and that is the
     * cheaper claim of the two: `regenerateLayout` replaces `this.layout` and
     * `this.walk` together, so holding the object we measured is holding the
     * grid we measured it against. A version number is a second thing that has
     * to be remembered to move.
     */
    this.parkCache = null;
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
     * Whether the shop front has ever been stamped — see `freezeAwning`.
     *
     * Its own mark for `yardStamped`'s reason, said about decorations: "does
     * this shop own an awning" hands you a new one the day you decide you
     * didn't want it, which would make it the one prop in the game you are not
     * allowed to remove — the exact complaint it exists to answer.
     */
    this.awningStamped = state.awningStamped ?? false;
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
      // What the shop hand has given up on: `{ item_id: day }`. It lives beside
      // the standing orders rather than on a shelf because it is a decision
      // about the RANGE — "we don't do those any more" — and a board is the
      // wrong scale for it: give up on a board alone and the next delivery puts
      // the same thing on the unit next door. See `giveUpBoard`.
      dropped: state.orders?.dropped ?? {},
      day: state.orders?.day ?? this.day,
      spent: state.orders?.spent ?? 0,
      /**
       * What has been paid for and has not landed yet.
       *
       * An order is a promise now rather than a delivery — `buyStock` takes the
       * money and files a row, and the crate exists when the van comes. The
       * fields the sim reads are `item_id`, `qty` and `arrivesAt`; the rest is
       * so the supplier can say what it is waiting for and since when.
       *
       * **`arrivesAt` is reconstructed here rather than read.** It is a stamp
       * against `elapsed`, which restarts at zero on every load, so a save
       * holds `arrivesIn` — how long there is left to wait — and this is the
       * one place that turns it back into a stamp. That is exactly the bargain
       * `plantedAt`/`grown` strikes in `persist`, and the trap `yieldedAt`
       * documents from the other side: a stamp saved raw puts the van in the
       * future for ever and the goods never arrive.
       */
      pending: (state.orders?.pending ?? []).map(({ arrivesIn, arrivesAt, ...o }) => ({
        ...o,
        arrivesAt: this.elapsed + Math.max(0, arrivesIn ?? 0),
      })),
    };
    this.nextOrderId = state.nextOrderId ?? 1;
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
    const awningStamped = w.awningStamped ?? false;
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
      // Whether the doors were left open. A save with nothing to say reads as
      // open, so nobody's shop shuts itself the day this shipped — the field is
      // written `false` by `createWorld`, which is where "a new shop starts
      // shut" actually lives.
      open: w.open,
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
      // What is standing on the floor and lying on the counters. A save from
      // before these were written has neither, which reads as a shop somebody
      // tidied — the right answer, and better than the old one, which was that
      // every shop looked tidied every time a file was saved.
      deliveries: w.deliveries ?? [],
      nextDeliveryId: w.nextDeliveryId ?? 1,
      /**
       * What the shop buys without asking, and what it has already paid for
       * that has not landed yet.
       *
       * `persist` has written this since the switches existed and nothing ever
       * read it back — the constructor's defaults won every load, so switching
       * auto-ordering off survived until the next restart and no further. That
       * was invisible while the whole of `orders` was settings: a shop that
       * silently starts ordering again looks like a shop that is ordering.
       * `pending` is money, so it stops being invisible — a reload that ate the
       * van would be goods you paid for and never received.
       */
      orders: w.orders ?? {},
      nextOrderId: w.nextOrderId ?? 1,
      cashDrops: w.cashDrops ?? [],
      nextCashId: w.nextCashId ?? 1,
      grow,
      doorShift,
      edits,
      ground,
      yardStamped,
      awningStamped,
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
    // ...and the shop front, for the same reason and on the same terms: it was
    // drawn rather than owned, so no save has ever had one to restore.
    game.freezeAwning();
    // After the stamp, not before: `freezeShell` can re-flow the layout, and
    // restoring onto shelves that are about to be replaced puts the stock back
    // on objects nobody keeps.
    game.restoreContents(w.stock, w.crops, w.hoppers);
    // ...and the people who work here, back where they were standing. After the
    // layout for the same reason the stock is: they are put down at coordinates,
    // and a re-flow can move the shop out from under them.
    game.restoreStaff(w.staffAt);
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
      open: this.open,
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
      awningStamped: this.awningStamped,
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
      // A devMode reload is a reload. `elapsed` is carried in this payload, so
      // a raw `arrivesAt` would survive it correctly by luck — and would stop
      // the day anybody trims this list. `ordersOut` writes the wait rather
      // than the stamp, exactly as the save does, and the constructor adds
      // whatever `elapsed` it is handed back on: right for both callers,
      // because the arithmetic never assumes the clock stayed where it was.
      orders: this.ordersOut(),
      nextOrderId: this.nextOrderId,
      stats: this.stats,
      log: this.log.slice(-40),
      elapsed: this.elapsed,
    };
  }

  /**
   * `orders`, with the van's arrival written as how long there is LEFT to wait.
   *
   * The one conversion this feature needs and the one it would have been bitten
   * by. `arrivesAt` is a stamp against `elapsed`, and `elapsed` restarts at zero
   * on every load — so a stamp stored raw lands in the future for ever and the
   * goods you paid for never turn up. `plantedAt` is stored as `grown` for the
   * same reason and `yieldedAt` is not stored at all for the same reason; this
   * is the third time, which is why it is a named function both writers call
   * rather than a spread with a fix-up in it.
   */
  ordersOut() {
    return {
      ...this.orders,
      pending: this.orders.pending.map(({ arrivesAt, ...o }) => ({
        ...o,
        arrivesIn: round2(Math.max(0, arrivesAt - this.elapsed)),
      })),
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
    saveWorld(this.worldId, this.saveState());
  }

  /**
   * Everything a restart has to be handed back, as a plain object.
   *
   * Split out of `persist` so it can be *asked*. What survives a restart is a
   * claim worth a sweep — CLAUDE.md's own gotcha is that a fallback nobody has
   * watched work is a fallback that isn't there — and it was untestable while
   * the payload only existed inside a function that refuses to run on the
   * ephemeral games every sweep uses.
   */
  saveState() {
    return {
      seed: this.seed,
      day: this.day,
      cash: this.cash,
      reputation: this.reputation,
      season: this.season,
      // Whether the doors are open. `paused` deliberately is not here — see the
      // two fields in the constructor for why one of them is a fact about the
      // shop and the other is a fact about the person sitting in front of it.
      open: this.open,
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
      awningStamped: this.awningStamped,
      shell: this.shell,
      // Settings, the day's running total and whatever is on the van, because
      // the total is only meaningful beside the day it belongs to — see
      // `staffSpentToday` — and an order is money already gone. `ordersOut`
      // rewrites the arrival as time REMAINING; see it for why.
      orders: this.ordersOut(),
      nextOrderId: this.nextOrderId,
      /**
       * Goods on the floor, and money on the counter.
       *
       * Both were only ever in `serialize()`, which is the devMode room cache —
       * and that cache has never once run (Colyseus disposes every room before
       * it asks `onCacheRoom`, so the hook is dead code). What that meant in
       * play is that every restart binned a whole delivery: you pay for it, the
       * crates land on the bay, you edit a file, and the bay is bare. Nothing
       * logs it and the money is already gone, so it reads as an order that
       * never arrived.
       *
       * A crate is safe to save flat — it stands on ground, by absolute
       * position, and owes nothing to a fixture that might have been sold
       * between sessions. `day` on it is stamped from `this.day`, which is
       * saved too, so it stays honest.
       */
      deliveries: this.deliveries,
      nextDeliveryId: this.nextDeliveryId,
      /**
       * ...and a pile of cash is the same, minus its clock. `bornAt` is a stamp
       * against `elapsed`, which RESTARTS AT ZERO on every load — the same trap
       * `plantedAt` and `yieldedAt` are already written around. Saved raw it
       * would put the pile's birth in the future, `collectCash` would read
       * `elapsed - bornAt` as negative, and money you walked over would refuse
       * to be picked up rather than obviously vanishing. Dropped on the way out
       * so the `?? 0` on the way back in does the work: a pile restored from a
       * save has been sitting there since you left, which is exactly what
       * "born at zero" says.
       */
      cashDrops: this.cashDrops.map(({ bornAt, ...rest }) => rest),
      nextCashId: this.nextCashId,
      /**
       * Where the staff were standing and what they had in their hands.
       *
       * The one body in the shop that CAN be saved, because a hire's id
       * (`staff-<n>`) outlives the socket — yours is a `sessionId`, minted per
       * connection, which is the whole of why you come back at the door. So a
       * restart used to teleport four workers to the doorway holding nothing,
       * which is a conservation failure with a walk on top: whatever they were
       * carrying to a shelf simply stopped existing.
       *
       * Position and hands only. `job`, `path` and `cooldown` are a decision
       * mid-flight — pointed at a fixture that may not be there next boot — and
       * `energy` is deliberately reset, so a restart stays a good night's sleep.
       * They pick a fresh job from where they stand.
       */
      staffAt: Object.values(this.players)
        .filter((p) => p.staff)
        .map((p) => ({
          id: p.id,
          x: round2(p.x),
          z: round2(p.z),
          facing: p.facing ?? 0,
          carry: p.carry ?? null,
          // Hands AND shoulder. A hire mid-haul across a restart is the same
          // conservation hole this row exists to close, and a crate is twice the
          // stock an armful is.
          haul: p.haul ?? null,
        })),
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
        // `managed === false` on its own is enough to save a shelf. A switch
        // flipped on an empty unit is still a decision, and the filter above it
        // was written when everything worth keeping was stock or a label.
        .filter((s) => this.shelfStacks(s).length || s.assigned?.length || s.priority
          || s.managed === false)
        .map((s) => ({
          id: s.id,
          // Every board, each with its own price and its own clock. Saved as a
          // list rather than as the four loose fields it replaced, and read back
          // by `restoreContents`, which still accepts the old shape — a save
          // written before this is a shop somebody is mid-game in.
          stacks: this.shelfStacks(s).map((k) => ({
            item_id: k.item_id, qty: k.qty, price: k.price, stockedDay: k.stockedDay ?? 0,
            // Undefined on a board that has never sold, and left that way
            // rather than defaulted here — `staleBoards` reads
            // `soldDay ?? stockedDay`, so a save written before this counts
            // stale from when it was filled. Which is the right answer rather
            // than the lenient one: never having sold is the case the shop hand
            // exists for, not an edge of it.
            soldDay: k.soldDay,
          })),
          assigned: s.assigned ?? [], priority: s.priority ?? 0,
        managed: s.managed !== false,
          managed: s.managed !== false,
        })),
      // What each appliance is set to make. A decision, so it is saved for the
      // same reason a shelf's reservation is: a restart that handed every
      // machine back to its first recipe would quietly repoint the kitchen, and
      // `dev:server` runs under `node --watch` — every edit to `server/` is a
      // restart. Only the choice: what is IN a hopper is not saved, and a batch
      // in flight is not either.
      hoppers: (this.layout.stations ?? [])
        .filter((s) => s.recipe)
        .map((s) => ({ id: s.id, recipe: s.recipe })),
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
    };
  }

  /**
   * Put the shelves and beds back after a restart. Anything whose fixture is no
   * longer there is dropped on the floor rather than restored onto nothing —
   * a shelf you sold between sessions should not resurrect with its stock.
   */
  restoreContents(stock, crops, hoppers) {
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
          soldDay: k.soldDay,
        }))
        : (row.item_id
          ? [{
            item_id: row.item_id, qty: row.qty, price: row.price, stockedDay: row.stockedDay ?? 0,
          }]
          : []);
      shelf.assigned = toList(row.assigned);
      shelf.priority = row.priority ?? 0;
      // Absent on every save written before the switch existed, and true is
      // what those shops have always done.
      shelf.managed = row.managed !== false;
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
    for (const row of hoppers ?? []) {
      const st = (this.layout.stations ?? []).find((s) => s.id === row.id);
      // Written back raw, not validated: the recipe may have been edited or
      // deleted while the shop was shut, and `stationRecipe` already falls back
      // for exactly that. Refusing it here would silently forget a choice that
      // becomes valid again the moment somebody restores the row.
      if (st) st.recipe = row.recipe ?? null;
    }
  }

  /**
   * ...and put the staff back where they were, still holding what they held.
   *
   * `syncStaff` is called first and does the making: it is the one place a
   * worker's body is built, it runs every tick anyway, and a second constructor
   * here would be a second answer to "what is a hire" that drifts the day
   * somebody authors a field. This only moves what it made.
   *
   * A hire who has been fired, or whose kind was deleted, has no body — the
   * `if` is what keeps them from coming back as a ghost with an armful.
   */
  restoreStaff(staffAt) {
    if (!staffAt?.length) return;
    syncStaff(this);
    for (const row of staffAt) {
      const s = this.players[row.id];
      if (!s?.staff) continue;
      s.x = row.x;
      s.z = row.z;
      s.facing = row.facing ?? 0;
      s.carry = row.carry ?? null;
      s.haul = row.haul ?? null;
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
    // Orders in flight are money in flight, so they go the same way the cash on
    // the counters does. A van paid for at day-27 wholesale, unloading free into
    // a day-1 shop, is exactly the pound-of-old-money-into-a-new-till case the
    // customers above are dropped for — and this one arrives six hours later,
    // when nothing on screen remembers there was a reset.
    this.orders.pending = [];
    // ...and the lorry carrying them, or it arrives into the new economy and
    // unloads a run whose rows no longer exist. Nothing is lost by sending it
    // home: `landRun` reads `orders.pending`, which is now empty.
    this.van = null;

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
      // Whether anybody is being served, which is the two questions ANDed.
      isOpen: this.isOpen(),
      /**
       * ...and the two questions, separately, because the HUD has to tell them
       * apart. At 22:00 with the shutters up the shop is not serving anybody and
       * there is nothing wrong: the button must not offer to "open up" a shop
       * you have already opened, and the to-do line must not nag you nightly
       * about a decision you already made. `paused` is here for the same reason
       * — a button that does not know its own state reads as broken the moment
       * the other player presses it.
       */
      shutters: this.open,
      trading: this.trading(),
      paused: this.paused,
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
        /**
         * What is on the van. The whole point of a wait is planning, and you
         * cannot plan against a list you cannot see — the supplier's `Short`
         * tab should be able to say "already on its way" rather than telling
         * you to buy more of something you have just bought.
         *
         * Sent as `in` — seconds still to wait — rather than as `arrivesAt`,
         * which is a stamp against a server clock the client does not have and
         * which is rewritten on every load anyway. `at` is the hour it is
         * booked for, which is the thing the player was actually told.
         */
        pending: this.orders.pending.map((o) => ({
          id: o.id,
          item_id: o.item_id,
          qty: o.qty,
          cost: round2(o.cost ?? 0),
          placedDay: o.placedDay ?? this.day,
          at: clockLabel(o.runHour ?? DELIVERY_RUNS[0]),
          in: r2(Math.max(0, o.arrivesAt - this.elapsed)),
          // Its wait ran out and it is on the lorry you can see coming up the
          // road. Without it a row on the van and a row nobody has loaded both
          // read as "0 seconds", which is a countdown that finished and then
          // sat there — the one moment in the whole feature where something IS
          // happening and the panel would say nothing is.
          onVan: this.van?.orders?.includes(o.id) === true,
        })),
        // When the vans come at all, so the panel can say what the next one is
        // without knowing the schedule. It is a rule of the world rather than a
        // setting, and it is the one number that explains every wait above it.
        runs: DELIVERY_RUNS.map(clockLabel),
        // How much more the yard will take. A cap that refuses you at the till
        // and never shows you the number is a refusal that reads as a bug.
        bayRoom: this.bayRoom(),
      },
      // How many of each thing is standing in the shop, under the name the
      // palette calls it. Keyed by *piece* throughout, which the old stored
      // ledger could not be — see `fixtureCounts`.
      fixtures: this.fixtureCounts(),
      players: Object.values(this.players).map((p) => ({
        id: p.id, name: p.name, x: r2(p.x), z: r2(p.z), facing: r2(p.facing),
        carry: p.carry, color: p.color, staff: p.staff ?? null,
        // A crate on the shoulder. Its own field rather than a flag on `carry`
        // so every existing reader — the ghost of where an armful could go, the
        // HUD, the props — keeps answering about hands and never has to learn
        // that one of them is a box.
        haul: p.haul ?? null,
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
      /**
       * How many a crate holds, so the renderer can draw one as full when it
       * IS full.
       *
       * `buildPallet` drew its sample as `ceil(qty / 6)` rows against a literal,
       * capped at three — so it needed thirteen to look full and a crate cannot
       * hold more than `crateCapacity()`, which is six. Every crate the game is
       * able to make therefore drew exactly one item and read as a quarter
       * full, which presents as the stocker not packing them rather than as art
       * measured against a number nothing else uses.
       *
       * Sent rather than hardcoded a second time because it is not a constant:
       * a `capacity` upgrade moves `carryCapacity`, and `crateCapacity` is the
       * same number by design. A client with its own copy would go back to
       * being wrong the moment somebody bought a rucksack.
       */
      crateCap: this.crateCapacity(),
      /**
       * The lorry, if one is on the road. Null far more often than not, which
       * is why it is one field rather than a list — there is one run at a time
       * and one van doing it.
       *
       * `vehicle` is the catalog row to draw, `load` is how full it is as one
       * 0..1 number for the model's stages, and `phase` is what it is doing, so
       * the renderer can hold it still with its doors open rather than having
       * to notice that it stopped moving.
       */
      van: this.van ? {
        vehicle: this.van.vehicle,
        x: r2(this.van.x),
        z: r2(this.van.z),
        facing: r2(this.van.facing ?? 0),
        phase: this.van.phase,
        load: r2(this.van.load),
      } : null,
      /**
       * ...and the cars in the car park, which is a list where the van is one
       * field: there is one delivery run at a time and as many shoppers as
       * there are spaces.
       *
       * Whole tiles, no phase and no load. A parked car does not move, does not
       * fill and does not empty — it is there while its driver is in the shop
       * and then it is not, which is the one thing about it worth sending. The
       * shopping goes home in their arms, the way it already does.
       */
      cars: this.parkedCars(),
      stations: (this.layout.stations ?? []).map((s) => ({
        id: s.id, x: s.x, z: s.z, station: s.station,
        contents: s.contents, making: s.making, output: s.output,
        // What it is set to make, RESOLVED rather than raw: a machine nobody
        // has chosen for is running its first recipe, and a client sent null
        // would draw an appliance that wants nothing while it works away.
        recipe: this.stationRecipe(s)?.id ?? null,
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

  /**
   * Is the shop actually serving anybody? BOTH switches, and the order of them
   * is the whole design.
   *
   * The business day is still the business day — `trading()` below, unchanged,
   * 08:00 to 20:00. What is new is that you can shut inside it. So the toggle
   * can only ever take hours AWAY: it shuts you early, keeps you shut, and
   * cannot sell a single thing at three in the morning.
   *
   * That direction is deliberate rather than incidental. A switch that could
   * *extend* the day would be free money with no cost attached — never closing
   * would simply be correct, and a button whose right answer is always "on" is
   * not a decision. Pointed the other way it is one: shutting is something you
   * spend trade on, to rebuild an aisle without shoppers walking through it.
   */
  isOpen() { return this.open && this.trading(); }

  /**
   * Is the town out shopping? The hours, and only the hours.
   *
   * Split out from `isOpen` rather than folded into it because three things
   * read the *clock* and not the shutters: the compressed night in `step`, the
   * delivery runs, and everything on screen that says whether this is a time of
   * day when people shop. Shutting at noon must not fling you through the
   * afternoon at 6×, and the van still comes at 03:00 whether or not you are
   * standing there — those are facts about the world, not about your doors.
   */
  trading() {
    const h = this.time * 24;
    return h >= OPEN_HOUR && h < CLOSE_HOUR;
  }

  hour() { return this.time * 24; }

  /**
   * Open or shut the doors.
   *
   * Closing says nothing to the people already inside, on purpose — `lastOrders`
   * has wound them up since the hours did this, and it is written to run
   * continuously rather than to fire on the stroke of eight *specifically* so
   * that "a shop closed for any other reason" gets the same handling free.
   * This is that other reason arriving. Anyone in the queue keeps their place,
   * anyone still on the approach turns round, everybody else settles up.
   *
   * Idempotent and silent when nothing changes: this is a toggle two people can
   * both press, and a log line per press would be a shop that reads as opening
   * twice.
   */
  setOpen(open, by = null) {
    const want = !!open;
    if (want === this.open) return ok({ open: this.open });
    this.open = want;
    const who = by ? `${by} ` : '';
    this.pushLog(want
      ? `${who}opened the shop.`
      : `${who}shut the shop${this.trading() ? ' — mid-trade' : ''}.`);
    // Straight to the save rather than waiting for the day to turn: a shop you
    // shut and walked away from has to still be shut when you come back, and
    // `persist` otherwise only runs at the rollover — which a shut shop reaches
    // eventually and a *paused* one never does.
    this.persist();
    return ok({ open: this.open });
  }

  /**
   * Stop or start the world.
   *
   * Never persisted — see the field. The log line is the only trace it leaves,
   * and it earns its place because pause is world-wide in a shop two people
   * share: without it the other person's game simply stops with nothing said.
   */
  setPaused(paused, by = null) {
    const want = !!paused;
    if (want === this.paused) return ok({ paused: this.paused });
    this.paused = want;
    const who = by ? `${by} ` : '';
    this.pushLog(want ? `${who}stopped the clock.` : `${who}started the clock.`);
    return ok({ paused: this.paused });
  }

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
    // Nothing happens, and that is the whole of it. One return rather than a
    // scale of zero: `dt * 0` would still walk every list, still fire anything
    // that triggers on equality, and would leave `stepOrders` counting a van
    // down by nothing forever. Stopping before `elapsed` moves is also what
    // makes pause free of the stamp trap the rest of this file is written
    // around — every clock in here is relative to `elapsed`, so a clock that
    // does not move is a world that does not drift.
    if (this.paused) return;

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
    //
    // It follows the CLOCK and not the shutters, which matters now that they are
    // two different questions. The reason the night is compressed is that nobody
    // is out there to shop — which is `dayShape`, an hour of the day. Hang it on
    // `isOpen` instead and shutting at noon to re-plan an aisle would fling you
    // through the afternoon at 6×, which is a control that punishes the thing it
    // is for. Pause is what stops the clock; this only ever skips the dark.
    const world = dt * (this.trading() ? 1 : NIGHT_SPEED);

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

    // Before anybody moves, so a crate the van just dropped is on the floor for
    // the stocker who is about to look for one.
    //
    // It takes `dt` for the van's legs and reads `elapsed` for its schedule,
    // which is the same split every other body in here makes: an arrival is a
    // stamp coming due against the world clock the lines above have already
    // advanced, and the drive from the edge of the map is a thing with wheels
    // that must not go six times faster at night.
    this.stepOrders(dt);
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
    this.releaseBoards();
    this.payWages();
    // Before `persist`, and after the last thing that touches the day's money —
    // `payWages` is it. `spoilStock` runs first and deliberately moves no cash:
    // it prices what it binned into `stats.spoiledValue`, which is a readout of
    // money already spent rather than a second charge for it. File the finished
    // day the other side of the save and a restart drops it.
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

  /**
   * Perishables rot if they sit too long — on a board, and now in a crate.
   *
   * **The bin does not take money, and that is not an oversight.** You paid for
   * that milk when the van came, and `stats.spent` has it; charging again here
   * would bill the shop twice for one carton and make spoilage look like a tax
   * rather than what it is. The loss has always been real and has always been in
   * the P&L — what was missing is that nothing ever *attributed* it, so a shop
   * quietly binning a tenth of everything it handled read as a shop with a
   * mysterious margin. `spoiledValue` is that attribution, at what it would cost
   * to replace, and it is a readout rather than a charge.
   */
  spoilStock() {
    const items = content().byId.items;
    const folded = this.folded();

    /** What binning this much of it just cost, at what replacing it would. */
    const bin = (item, qty) => {
      this.stats.spoiled += qty;
      this.stats.spoiledValue = round2(
        this.stats.spoiledValue + wholesalePrice(item, folded, this.season) * qty,
      );
    };

    for (const shelf of this.layout.shelves) {
      // Board by board, and each against its OWN clock. One clock per fixture
      // would mean the cheese you put out on Monday going off on Thursday
      // because somebody topped up the milk beside it on Wednesday — which is
      // the whole argument for `stockedDay` living on the stack.
      for (const stack of [...this.shelfStacks(shelf)]) {
        if (!stack.item_id || stack.qty <= 0) continue;
        const item = items[stack.item_id];
        if (!item) continue;
        // Whether this board is cold is the fixture's business; what cold is
        // WORTH is the item's, and `spoilRate` is where the two meet. The `× 4`
        // that used to sit on this line was the freezer's half of it said in the
        // wrong file, which is why it applied to a tub of ice cream that already
        // assumed it and to nothing that had been left out of one.
        const rate = spoilRate(item, { chilled: shelf.kind === 'freezer' });
        if (rate <= 0) continue;
        // `keeps_mult` is the tier's contribution: a better freezer keeps for
        // longer than a basic one, whatever is in it.
        const effLife = item.shelf_life_days * this.fixtureStats(shelf).keeps_mult / rate;
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
          bin(item, lost);
          this.pushLog(`${lost}x ${item.name} spoiled on the shelf and was binned.`);
        }
      }
    }

    /**
     * And the same sweep over the yard, which is the half that made spoilage
     * dodgeable rather than merely invisible.
     *
     * A crate has carried a `day` since `dropGoods` was written; nothing had
     * ever read it. So a board of lettuce rotted in three days and a pallet of
     * the same lettuce two tiles away kept for ever, which means the way to
     * beat spoilage was to leave your stock in the yard — the exact opposite of
     * what the mechanic is for, and reachable by accident by any shop whose
     * boards are all committed.
     *
     * Nothing here is chilled. A cold crate would be a fixture that holds
     * pallets, and there isn't one — if there is ever a walk-in, this is the
     * line that learns about it.
     */
    for (const crate of [...this.deliveries]) {
      const item = items[crate.item_id];
      if (!item || !(crate.qty > 0)) continue;
      const rate = spoilRate(item);
      if (rate <= 0) continue;
      const effLife = item.shelf_life_days / rate;
      // A crate written before this has no stamp and is treated as fresh rather
      // than as infinitely old — a save that binned the whole yard on the first
      // morning after an update is a worse bug than the one being fixed.
      const age = this.day - (crate.day ?? this.day);
      if (age > effLife) {
        const lost = crate.qty;
        this.deliveries = this.deliveries.filter((d) => d.id !== crate.id);
        bin(item, lost);
        this.pushLog(`${lost}x ${item.name} spoiled in the yard and was binned.`);
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

      // ...and the other half of consent, which standing still was never able
      // to be. `moving` above stops a walk-PAST firing; it cannot stop a walk
      // *to*, and every route this game plans ends stopped at the working spot
      // — so arriving anywhere was arriving armed, and a second later the thing
      // happened whether or not you had decided you wanted it. Standing at a
      // ripe bed picked it. Standing at a rough bed turned it over. That is the
      // class of action that happens *to* you, one layer further in than the
      // walk-past this file already talks about.
      //
      // So the ring winds while a BUTTON IS DOWN. The candidate is still armed
      // and still sent at zero progress, because "what would happen here" is
      // worth showing and is the whole reason the prompt exists — what is gone
      // is it happening on its own. Releasing resets rather than banks, which
      // is the same rule leaving already followed: there is no partial charge
      // anywhere in this game.
      //
      // It also makes the two ends of a crate one gesture said twice — press to
      // lift, press to set down — where before both fired themselves and the
      // player never pressed anything at all.
      if (!p.pressing) { p.action.elapsed = 0; continue; }

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

    // A tile you named while holding a crate. The only errand whose address is
    // a coordinate — the drop-off above is a *region* and a fixture has an id,
    // and setting a crate down is neither: it is that tile and no other, which
    // is what makes "hold on an empty square" mean somewhere rather than near
    // somewhere.
    if (e.at === 'ground') {
      if (!p.haul) { p.errand = null; return null; }
      if (Math.hypot(e.x - p.x, e.z - p.z) > UNLOAD_REACH) return null;
      return {
        kind: 'setdown', target: 'ground', label: 'Set it down', time: ACTION_TIMES.crate,
        at: { x: e.x, z: e.z },
        run: () => spend(() => this.dropCrate(p.id, e.x, e.z)),
      };
    }

    const crate = this.deliveries.find((d) => d.id === e.at);
    if (crate) {
      if (!near(p, crate, UNLOAD_REACH)) return null;
      // Empty-handed at a crate is a LIFT, and full hands is the armful it
      // always was. One address, two jobs, chosen by the state you are in
      // rather than by a modifier nobody would find — and the choice is the
      // honest one both ways round: you cannot shoulder a box while holding
      // tomatoes, and somebody already holding six of this walked over to top
      // up rather than to pick the box up.
      // ...and only the one on top. Buried, it falls through to the armful,
      // which is the one thing you CAN do to a crate under a stack — reach in
      // and take some. Deciding here rather than refusing in `liftCrate` is
      // what makes every row of the pile menu do something.
      if (!p.carry && !p.haul && this.crateOnTop(crate)) {
        return {
          kind: 'lift', target: crate.id, label: 'Pick up crate', time: ACTION_TIMES.crate, at: crate,
          run: () => spend(() => this.liftCrate(p.id, crate.id)),
        };
      }
      if (p.haul) { p.errand = null; return null; }
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
   * How much of an item the shop could shelve without paying for it AGAIN.
   *
   * Cases on the floor, armfuls in hand, the beds, and what is on the van. The
   * restocker knew about exactly one of these and only as a *scheduling*
   * question — "is there a pallet at the bay I could unload instead of
   * ordering" — which says what to do next tick and nothing about how much to
   * order. So a shelf reserved for carrot, stripped into crates two tiles away,
   * read as bare and bought a full unit; and a shop with four beds of carrots
   * bought carrots at wholesale for ever, which is the farm competing with
   * itself.
   *
   * **Pending orders are the newest source and the one this function exists
   * for.** An order used to become a crate in the same tick it was placed, so
   * "have I already bought this" was answered by the crate; with a wait of up
   * to six hours in between, a restocker that did not count the van would look
   * at the same thin board and buy it again on every single tick until the van
   * came — a shelf's worth of milk becoming twenty. That is precisely the bug
   * step 1 of docs/ordering.md fixed for crates, arriving again through a
   * different door, which is the argument for one function rather than a check
   * per caller.
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
    for (const o of this.orders.pending) if (o.item_id === itemId) n += o.qty ?? 0;
    for (const p of Object.values(this.players)) {
      if (p.carry?.item_id === itemId) n += p.carry.qty ?? 0;
      // A crate on somebody's shoulder is stock the shop already owns, exactly
      // as an armful is. Missing it here would have the supplier order twelve
      // more of whatever a hire is halfway across the yard with.
      if (p.haul?.item_id === itemId) n += p.haul.qty ?? 0;
    }
    for (const plot of this.layout.plots) {
      if (!plot.crop_id) continue;
      const crop = crops[plot.crop_id];
      if (crop?.item_id !== itemId) continue;
      // A planted bed counts for its WHOLE yield, not the share of it that has
      // grown so far. Scaling by growth reads as the careful answer and is the
      // wrong question: it says how much the farm has *become*, when what the
      // supplier needs to know is how much is *coming*. A coop three hours off
      // ripening counted as one egg, so the shop ordered a fortnight of eggs and
      // the harvest landed on top of them — the farm competing with the shop's
      // own buyer, which presents as the farm being pointless rather than as the
      // ordering being wrong. It is the same mistake `restock`'s pallet guard
      // made about crates: a thing on its way is supply, not absence.
      //
      // The cost is honest and worth stating: a bed sown today holds the
      // supplier off that item until it is picked, so a slow crop can leave a
      // board bare. That is the trade you make by growing your own.
      n += Math.floor(plot.yield || crop.yield_min || 0);
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
   * Hand back a board that has been empty for days with nothing coming.
   *
   * A sold-out board deliberately keeps its label — that is what tells the
   * stocker to refill it, and it is why an empty shelf can be relabelled while a
   * stocked one cannot. What was missing is the other end: nothing ever let one
   * GO. Only spoiling or a strip by hand freed a board, so a unit whose kinds
   * stopped selling stayed committed to them for ever.
   *
   * Which is invisible until the shop needs the space. A live shop reached five
   * freezer boards labelled `egg` and `frozen-berries`, all at zero, all of them
   * items the owner had switched auto-ordering OFF for — so they could never
   * refill and could never be released, and crates of fish fingers, oven chips
   * and ice cream sat on the pad with nowhere in the building to go. The
   * freezers read as empty and were, in fact, entirely spoken for.
   *
   * Three things protect a board from this, and the first is the important one:
   *
   *   `assigned` — you TICKED it. A reservation is a decision, and a decision
   *                the shop quietly undoes after two quiet days is not one. A
   *                shelf you set aside for cheese stays set aside for cheese
   *                whether or not there is any cheese this week.
   *   supply     — a crate, an armful or a van of it is on the way, so the board
   *                is not idle, it is waiting. `homeSupply` is already the one
   *                spelling of that question.
   *   days       — one quiet day is a Tuesday. Two is a decision.
   */
  releaseBoards() {
    for (const shelf of this.layout.shelves) {
      const kept = toList(shelf.assigned);
      for (const stack of [...this.shelfStacks(shelf)]) {
        if (stack.qty > 0) { stack.emptyDays = 0; continue; }
        if (kept.includes(stack.item_id)) continue;
        if (this.homeSupply(stack.item_id) > 0) { stack.emptyDays = 0; continue; }
        stack.emptyDays = (stack.emptyDays ?? 0) + 1;
        if (stack.emptyDays < EMPTY_BOARD_DAYS) continue;
        const name = content().byId.items[stack.item_id]?.name ?? stack.item_id;
        this.clearStack(shelf, stack.item_id);
        this.pushLog(`Gave the ${name} board back — empty ${EMPTY_BOARD_DAYS} days with none coming.`);
      }
    }
  }

  /**
   * Boards with stock on them that nothing has bought, longest dead first.
   *
   * The other half of `releaseBoards`, and the half that was missing. That one
   * only ever looks at boards at *zero* — "empty two days with none coming" —
   * so three units of something nobody wants never qualifies, and a
   * non-perishable has no `shelf_life_days` for spoilage to take it with
   * either. The board was gone for the rest of the save.
   *
   * Which matters because **boards are the scarce thing, not shelf space**:
   * `shelfCapacity` divides a unit by its `shelfShares`, so a board is what the
   * shop spends to carry range. A dead one is not untidiness, it is one fewer
   * kind the shop can ever sell — and `pickItem` cannot choose around it,
   * because `already` counts a stocked board as part of the range.
   *
   * It lives here rather than in `staff.js` for the reason `restockQueue` does:
   * what counts as dead is a rule about the shop, and a second copy of it
   * inside the job is the one that would drift from the sentence the log
   * prints. The three protections are `releaseBoards`', said about a board with
   * something on it:
   *
   *   `assigned` — you TICKED it. A shelf set aside for cheese stays set aside
   *                for cheese whether or not any cheese sold this week.
   *   supply     — a crate, an armful or a van of it is on the way, so somebody
   *                has already decided this board is worth filling.
   *   days       — `STALE_BOARD_DAYS`, against the sale rather than the fill.
   */
  staleBoards() {
    const out = [];
    for (const shelf of this.layout.shelves) {
      // "Leave that one alone", which is its own switch rather than a side
      // effect of a reservation — see `setShelfHands`.
      if (!this.handMayTouch(shelf)) continue;
      const kept = toList(shelf.assigned);
      for (const stack of this.shelfStacks(shelf)) {
        if ((stack.qty ?? 0) <= 0) continue;          // `releaseBoards`' half
        if (kept.includes(stack.item_id)) continue;
        if (this.homeSupply(stack.item_id) > 0) continue;
        const days = this.day - (stack.soldDay ?? stack.stockedDay ?? 0);
        if (days < STALE_BOARD_DAYS) continue;
        out.push({ shelf, stack, days });
      }
    }
    return out.sort((a, b) => b.days - a.days);
  }

  /**
   * The shop stops stocking something, and says so.
   *
   * Called by the `merchandise` job the moment it pulls the FIRST armful off a
   * dead board — before the goods are anywhere, rather than when the board
   * finally empties — and that ordering is the whole of why this is a method
   * rather than two lines in the job.
   *
   * Without the mark the feature is a loop that moves stock around and changes
   * nothing: the hand clears a board to the drop-off, the crate is a pallet
   * like any other, `unload` sees a shelf with a free board and room on it, and
   * `shelve` puts the same goods straight back where they came from. Marking
   * the ITEM rather than the board is what makes it stick — give up on one
   * board alone and the next delivery lands the same thing on the unit next
   * door.
   *
   * It does not expire, and there are two ways to overrule it, both of which
   * already existed:
   *
   *   - **Tick a shelf for it.** A reservation outranks everything in
   *     `shelvesFor` and always has; that is what a reservation is *for*.
   *   - **Put it on a shelf yourself.** `stockShelf` never reads this. The shop
   *     giving up is the shop's judgement about its own range — the same line
   *     `orders.assign` draws — and it was never a rule about your hands.
   *
   * A timer instead would be worse than either: the crate is still on the pad,
   * so the day it lapsed a worker would carry the same goods back to the same
   * board and start the same four days again. Churn on a loop reads as a bug in
   * a way "we don't stock that any more" never does.
   */
  giveUpBoard(shelf, itemId, days) {
    if (this.orders.dropped[itemId] !== undefined) return;
    this.orders.dropped[itemId] = this.day;
    const name = content().byId.items[itemId]?.name ?? itemId;
    this.pushLog(
      `Gave up on the ${name} — nothing sold in ${days} days. `
      + 'Set a shelf aside for it to stock it again.',
    );
  }

  /** Has the shop given up on stocking this? Staff read it; your hands don't. */
  droppedItem(itemId) {
    return this.orders.dropped?.[itemId] !== undefined;
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
   * How many units of an item this shelf holds.
   *
   * Four things, and the one that was missing is the unit's own size: the item
   * says how big a stack of it is, the tier says how much shelving there is,
   * how many BOARDS it was drawn with says how big the thing standing there
   * actually is, and the shares say how much of it this kind gets.
   *
   * It used to be one stack per unit however many boards the art had, divided
   * among the kinds on it — "a unit holds exactly what it always held, and
   * ticking a second box buys variety rather than volume". That is defensible as
   * balance and indefensible as a picture. A three-board freezer kept for one
   * thing reported FULL at eight units, with two empty boards drawn under them
   * and a third of the first one used. The number said full and the shop said
   * otherwise, and the shop is the thing you are looking at. Same family as the
   * lid `drawableBoards` exists for: a shelf whose count and whose art disagree
   * reads as stock that never arrived.
   *
   * `boards` is `drawableBoards` by way of `shelfBoards` — boards you can SEE
   * into, so a canopy that hides a row does not silently promise capacity behind
   * it. And it is the same number `assignShelf` caps reservations at, so shares
   * can never exceed boards: every kind on a unit gets at least one board's
   * worth, and a unit kept for one thing gets all of them.
   *
   * This does multiply what the shop can carry, roughly by the boards on a
   * unit — measured over 16 seeds before it landed rather than argued about.
   */
  shelfCapacity(shelf, item) {
    const boards = Math.max(1, this.shelfBoards(shelf));
    const total = item.stack * this.fixtureStats(shelf).capacity_mult * boards;
    return Math.max(1, Math.floor(total / this.shelfShares(shelf)));
  }

  /**
   * Is this an ingredient for what the machine is set to make? Which is what
   * the shop buys in for it and what a stocker walks over with — so a blender
   * set to salsa stops the shop ordering milk it has nowhere to put.
   */
  stationWants(station, itemId) {
    return (this.stationRecipe(station)?.inputs ?? []).some((i) => i.item_id === itemId);
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
    //
    // Parking is a third: how far people will come, which is what catchment has
    // always meant and the one thing neither of the other two says. A shop that
    // is lovely and on the high street is still a shop you cannot get to with a
    // boot full of shopping. Both of the terms you can build saturate, and for
    // the same reason — see `parkReach` and `charmReach`.
    return BASE_CATCHMENT + countUpgrade(this, 'catchment', 'reach')
      + this.charmReach() + this.parkReach();
  }

  /**
   * How much fits in one pair of hands.
   *
   * **Whose hands.** The rucksack you buy is yours, and a hire's reach is what
   * their kind was authored with times their rung — `carry` on the `workers` row,
   * which is the whole reason the field exists. It was read in exactly one place
   * (a chef fetching off a shelf) and nowhere that mattered: every pickup in the
   * game went through the shop-wide 6, so a Stocker authored to carry ten lifted
   * six, a promotion to a rung with `carry_mult: 2` lifted six, and the number on
   * the hire panel was a decoration. It reads in play as staff who will not pick
   * up a whole crate — because they cannot.
   *
   * `p` is optional so nothing that asks the shop-wide question has to change,
   * and a human still gets the upgrades, which a hire never does: a rucksack is
   * a thing you bought and put on.
   */
  carryCapacity(p = null) {
    // `carryOf` rather than the same sum written out again — see its note.
    if (p?.staff && content().byId.workers[p.staff]) return carryOf(p);
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
      haul: null,
      input: { dx: 0, dz: 0 },
    };
    this.pushLog(`${this.players[id].name} clocked in.`);
    return this.players[id];
  }

  /**
   * ...and what you were holding goes on the floor, not into nothing.
   *
   * Identity is `client.sessionId`, minted fresh per *connection*, so leaving
   * has always deleted the whole person — `carry` included. On localhost that
   * looked like a tidy-up and is actually a conservation failure: a devMode
   * restart, a wifi blip or a closed tab destroyed an armful of stock, silently,
   * with the money already spent. It reads as "the reload ate my hands".
   *
   * A pallet is the only "goods on the floor" object there is, so this is the
   * fifth caller of `dropGoods` rather than anything new — the crate lands where
   * you were standing, merges with one of the same thing already there, the
   * stocker tidies it away for free, and it now survives the restart because
   * crates are saved. See docs/shipping.md, step 2. Step 3 — a player id that
   * outlives the socket — is what would keep it in your hands instead.
   */
  removePlayer(id) {
    const p = this.players[id];
    if (p?.carry?.qty > 0) this.dropGoods(p.carry.item_id, p.carry.qty, { x: p.x, z: p.z });
    // ...and the crate on their shoulder, for exactly the same reason and by
    // exactly the same route. A hauled crate is the biggest single thing a
    // disconnect could ever have destroyed — twelve of something rather than
    // six — and it was one `if` away from being the bug this function was
    // written to fix, wearing a new field's name.
    if (p?.haul?.qty > 0) this.dropGoods(p.haul.item_id, p.haul.qty, { x: p.x, z: p.z });
    delete this.players[id];
  }

  /**
   * Is the button down?
   *
   * `pressing`, NOT `holding` — that name was taken, by the fixture in your
   * hands in build mode (`liftFixture`). Calling this one `holding` overwrote a
   * carried shelf with `true` and every sweep that moves a fixture failed
   * several sections later, in code that had nothing to do with either. Two
   * meanings of "holding" is one too many for a player record.
   *
   * One bit, sent on press and release, and it is what `stepActions` charges
   * against. Deliberately not part of `input`: that is a movement vector the
   * client streams while a key is held, and folding a press into it would mean
   * a dropped release leaves you walking AND holding. A release that goes
   * missing here costs you a ring that will not wind, which you fix by pressing
   * again — the failure is visible and self-correcting, which is the right way
   * round for the half that makes things happen.
   */
  setPressing(id, down) {
    const p = this.players[id];
    if (!p) return;
    p.pressing = !!down;
    // Let go early and the ring goes back to zero rather than keeping what it
    // had. Banking a part charge would make a rapid tap-tap-tap fire things,
    // which is the auto-fire this replaced wearing a faster hat.
    if (!down && p.action) p.action.elapsed = 0;
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
    // Holding a crate, a tap on any walkable tile is "set it down there". It
    // outranks the pad rule rather than joining it: a crate is already a thing
    // that stands on the floor, so the drop-off has nothing special to offer it
    // and answering `stow` would refuse — `stow` empties your HANDS.
    //
    // Note the target is the tile you tapped, and `errandAction` re-measures
    // reach to it on arrival. The route ends stopped on it, so that is normally
    // free; what it buys is the case where the way is blocked and you stop
    // short, which has to be "you did not get there" rather than a crate landing
    // wherever you gave up.
    if (p.haul) p.errand = { at: 'ground', x: goal.x, z: goal.z, itemId: null };
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
      ? `Turned the ${this.fixtureSaid(plot)} over from ${replaced} to ${crop.name}.`
      : `Sowed ${crop.name} in the ${this.fixtureSaid(plot)}.`);
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
    if (body?.haul) {
      this.dropGoods(body.haul.item_id, body.haul.qty, this.dropPad());
      body.haul = null;
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
   * Move someone back down their ladder, for half of what that rung cost.
   *
   * Not an undo, and this is the one ladder where that distinction has teeth: a
   * rung carries `wage_mult`, so where a fixture's tier is paid for once, a
   * hire's is paid for again every day. A shop that promoted its clerk in a good
   * season and is now watching the wage bill had exactly one way out of it —
   * `fire`, which refunds nothing and loses the person.
   *
   * Half back, the same rate `FIXTURE_REFUND` pays for tearing a fixture out, so
   * promoting and demoting in a circle always costs money. It is deliberately
   * NOT the mirror of `hire`, which pays nothing back: what is being sold here
   * is a rung, not a person, and the rung is a thing the shop can still see.
   */
  demote(workerId) {
    const entry = this.roster.find((e) => e.id === workerId);
    if (!entry) return err('nobody by that name works here');
    const kind = content().byId.workers[entry.kind];
    if (!kind) return err('their kind no longer exists');

    // Clamped against the ladder as it stands, exactly as `staff.js` reads it:
    // a kind whose rungs were trimmed leaves somebody sitting above the top of
    // their own ladder, and stepping down from a rung that no longer exists
    // would hand back a price nobody was ever charged.
    const at = Math.min(Math.max(1, Math.trunc(entry.tier ?? 1)), kind.tiers?.length ?? 1);
    if (at <= 1) return err('they are already on the first rung');
    const rung = kind.tiers?.[at - 1];
    const back = round2((rung?.cost ?? 0) * FIXTURE_REFUND);
    const below = kind.tiers?.[at - 2];

    entry.tier = at - 1;
    this.cash += back;
    this.pushLog(back > 0
      ? `${entry.name} is back to ${below?.name ?? 'where they started'} — $${back.toFixed(2)} back.`
      : `${entry.name} is back to ${below?.name ?? 'where they started'}.`);
    this.persist();
    return ok({ demoted: workerId, tier: entry.tier, refund: back });
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
    const cap = this.carryCapacity(p);

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
   * Order stock from the supplier. **An order is a promise, not a delivery.**
   *
   * Pressing the button used to make the crate exist, which is why the bay —
   * the one piece of ground whose whole job is to be a place things arrive at —
   * had never had anything arrive on it, and why nothing you could set about
   * ordering could matter: a shop that refills any shelf in a second is never
   * actually short, so a minimum is a number you set once and never think about
   * again. This files a row instead and the goods land when the van comes.
   *
   * **Paid here, delivered later.** Every refusal below is the one that was
   * always here and it still runs before a penny moves — the money is the half
   * worth keeping at order time, because an order you can cancel for free is a
   * free option and the wait stops costing anything. The only thing that moved
   * to arrival is `dropGoods` and its log line, in `stepOrders`.
   *
   * **`autoServe` no longer takes a shortcut through this.** It used to hand
   * the goods straight into the buyer's arms, and the argument for that is
   * sound and is about *walking*: a balance run should measure the economy
   * rather than the pathfinding. A wait is not a walk. Leaving the fast path in
   * would have meant `simulate` was the one shop in the world where ordering is
   * still instant, so step 1 of docs/deliveries.md would have measured as
   * costing nothing — the "broken instrument reads as a broken feature" trap in
   * CLAUDE.md, pointed the other way round. The bot skips the walk by
   * teleporting to the crate, which is where that shortcut belongs.
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

    const take = Math.min(qty, item.stack);
    if (take <= 0) return err('order at least one');

    // Physics rather than a consequence, so this one refuses — and it refuses
    // up here with the other refusals, before a penny moves. A wholesaler with
    // nowhere to unload does not deliver into a field, and taking the money for
    // a pallet that then has nowhere to exist is the worst of the three
    // answers. `canPaintGround` warns you before you paint over your last bay,
    // which is where this is meant to be prevented.
    if (!this.layout.bay) return err('nowhere for it to land — lay a delivery bay first');

    // ...and the same argument one step further along, which is new: a run that
    // turns up with more than the pad can hold has nowhere to put it. The pad's
    // capacity caps what may be IN FLIGHT, checked here with the other guards,
    // rather than a full bay quietly delaying the van — the first is a number
    // you can see and paint your way out of, the second is a mechanic nobody
    // asked for that presents as the supplier having stopped working.
    //
    // It has to count the orders as well as the crates. Counting only what is
    // standing there would let six orders placed in one tick all pass a check
    // against an empty pad and land together on a bay that holds four.
    const room = this.bayRoom();
    if (room <= 0) return err('the bay is full — unload it before ordering more');
    if (take > room) return err(`only room for ${room} more at the bay`);

    const unit = wholesalePrice(item, this.folded(), this.season);
    const cost = unit * take;
    if (this.cash < cost) return err(`need $${cost.toFixed(2)}, you have $${this.cash.toFixed(2)}`);

    this.cash -= cost;
    this.stats.spent += cost;
    // Charged against the daily cap here rather than at the call site, so
    // every way a hire can spend money on stock goes past it — `restock` is
    // the only one today and this is the line that keeps that from mattering.
    if (p.staff) this.noteStaffSpend(cost);

    const run = this.nextRun();
    const order = {
      id: `ord-${this.nextOrderId++}`,
      item_id: itemId,
      qty: take,
      cost: round2(cost),
      // When it was asked for, so the supplier can say how long you have been
      // waiting without the client having to keep its own clock.
      placedDay: this.day,
      placedAt: r2(this.time * 24),
      // Which van it is on, as an hour of the day. Kept beside the stamp rather
      // than derived from it: `arrivesAt` is rewritten every time the world is
      // saved and loaded, and "the 14:00 one" is what the player was told.
      runHour: run.hour,
      arrivesAt: this.elapsed + run.wait,
    };
    this.orders.pending.push(order);
    this.persist();

    this.pushLog(`${take}x ${item.name} ordered — on the ${clockLabel(run.hour)} van.`);
    return ok({
      ordered: take, cost: round2(cost), delivery: true, orderId: order.id,
      arrivesAt: clockLabel(run.hour), arrivesIn: round2(run.wait),
    });
  }

  /**
   * Which van the next thing ordered goes on, and how long that is in seconds.
   *
   * Seconds of `elapsed`, which is the same clock `this.time` runs on — both
   * advance by `world` in `step`, so the night running at `NIGHT_SPEED` speeds
   * the two up together and a gap measured in hours converts exactly. Anything
   * that measured the wait in real seconds instead would have the morning van
   * arrive six hours late every night.
   *
   * The comparison is strict, so an order placed at exactly 08:00 is on the
   * 14:00 van rather than the one pulling away. That is the cutoff doing its
   * job — and it also means an arrival is ALWAYS in the future, which is what
   * makes "an order is not a delivery" a rule rather than usually true.
   */
  nextRun() {
    const hour = (this.time % 1) * 24;
    const at = DELIVERY_RUNS.find((h) => h > hour) ?? DELIVERY_RUNS[0] + 24;
    return { hour: at % 24, wait: ((at - hour) / 24) * DAY_SECONDS };
  }

  /**
   * How much more the delivery bay can take, counting what is on its way.
   *
   * A cell holds one crate and a crate holds an armful, which is the rule the
   * pads have had since they became paintable — "how big you paint it is how
   * much it holds", said in units so an order can be measured against it.
   *
   * Crates anywhere else are deliberately not counted. The drop-off is where
   * you park an armful and a stripped shelf leaves its stock where it stood;
   * neither is the wholesaler's problem, and counting them would mean tidying
   * your own goods into the yard stopped you being able to order.
   */
  bayRoom() {
    const bay = this.layout.bay;
    if (!bay?.cells?.length) return 0;
    let used = 0;
    for (const d of this.deliveries) {
      if (bay.cells.some((c) => c.x === d.x && c.z === d.z)) used += d.qty ?? 0;
    }
    for (const o of this.orders.pending) used += o.qty ?? 0;
    return Math.max(0, bay.cells.length * this.crateCapacity() - used);
  }

  /**
   * The same question about the drop-off, for the goods the shop makes itself.
   *
   * `bayRoom` is what stops the shop *buying* more than the yard can hold, and
   * it has been there since the pads became paintable. Nothing asked it of the
   * two things the shop *produces* — so a kitchen and a farm with every board
   * committed piled their output at the drop-off for ever, and because
   * `dropGoods` shares a cell once the pad is full rather than refusing, the
   * pile grew upwards with nothing anywhere to say stop. That is a tower of
   * crates you cannot walk through and did not ask for, and it reads as a
   * stocker who has quit rather than as a farm that will not stop picking.
   *
   * So: the pad you painted is the buffer, and it is exactly as big as you
   * painted it. A shop that wants its farm to run while the shelves are full
   * paints more storage — which is the same sentence the bay already makes, and
   * the reason the pads are regions at all.
   *
   * Counts only what is standing ON the pad, like `bayRoom` does: a crate off a
   * stripped shelf is standing where the shelf was, and holding the farm off
   * because you tidied a shelf in the corner would be a rule nobody could see.
   */
  padRoom() {
    const pad = this.dropPad();
    if (!pad?.cells?.length) return 0;
    let used = 0;
    for (const d of this.deliveries) {
      if (pad.cells.some((c) => c.x === d.x && c.z === d.z)) used += d.qty ?? 0;
    }
    return Math.max(0, pad.cells.length * this.crateCapacity() - used);
  }

  /**
   * The delivery run: load the van when one is due, and drive whichever one is
   * out.
   *
   * Two halves on purpose. `loadVan` is a decision about the *world* — is there
   * anything due, is there a bay, is there a lane — and it is asked on the world
   * clock, which the night speeds up. `driveVan` is a body moving, and it gets
   * the raw `dt` for the same reason the staff do: six hires sprinting round a
   * shut shop reads as a physics bug, and so does a lorry.
   */
  stepOrders(dt) {
    this.loadVan();
    this.driveVan(dt);
  }

  /**
   * Which vehicle of a given `use` turns up.
   *
   * Content, not code: a vehicle is a thing you look at, and everything in this
   * game you look at is a row somebody can draw. Chosen by `use` — the field
   * that exists so a delivery can never be handed the shopper's car — and never
   * by id, because `if (vehicle.id === 'delivery-van')` is the line CLAUDE.md
   * bans and it would make one authored row load-bearing.
   *
   * **Smallest first, deliberately.** The shop owns one van and a bigger one is
   * an upgrade you buy later; picking the biggest row in the table would mean
   * that drawing a lorry silently gave every shop in the world a bigger one, and
   * `capacity` is the only field on a vehicle the sim reads as a number. So
   * authoring is free until somebody wires the upgrade up. The car park makes
   * that rule matter twice over: a driver's boot is a car's `capacity`, so
   * "biggest wins" would mean drawing an estate quietly raised every basket in
   * the game.
   *
   * Null is a real answer — a database with no vehicles in it yet, or none of
   * this kind — and it is the caller's job to say what the shop does without
   * one. It is never a reason for the mechanic not to happen: the goods still
   * land without a van.
   */
  vehicleFor(use) {
    const rows = (content().vehicles ?? []).filter((v) => v.use === use);
    if (!rows.length) return null;
    const holds = (v) => Math.max(1, Math.round(v.capacity ?? 1));
    // Ordered by id where two hold the same, so which one turns up is a fact
    // about the catalogue rather than about the order rows came back in.
    return rows.reduce((best, v) => {
      if (holds(v) !== holds(best)) return holds(v) < holds(best) ? v : best;
      return String(v.id) < String(best.id) ? v : best;
    });
  }

  /** The lorry that brings the wholesale run in. */
  deliveryVan() {
    return this.vehicleFor('delivery');
  }

  /** ...and the car a shopper who drove here parked. */
  customerCar() {
    return this.vehicleFor('customer');
  }

  /**
   * Send a van out for everything the run is carrying.
   *
   * One van at a time, and it is not a limit so much as what a run *is*:
   * everything ordered before the cutoff comes together, so a second lorry on
   * the road at the same time would be the run having happened twice. Anything
   * that does not fit on this one — more crates than it holds, or ordered while
   * it was out — is still `pending` and still due, so the next tick after it
   * pulls away sends it back for the rest.
   *
   * Nothing here takes the goods off the save. The orders ride the whole
   * journey in `orders.pending` and leave it only in `landRun`, in the same
   * breath as `dropGoods` — see `this.van` for why that matters.
   */
  loadVan() {
    if (this.van) return;                          // already out
    if (!this.orders.pending.length) return;
    // A shop that has painted over its bay in the six hours between paying and
    // arriving keeps the whole run waiting rather than having it dropped. That
    // is not the "a full bay delays the van" mechanic this feature turned down
    // — that case is refused at order time, in `buyStock` — and the only other
    // answer is deleting goods somebody bought.
    const pad = this.layout.bay ?? this.dropPad();
    if (!pad) return;

    const due = this.orders.pending.filter((o) => o.arrivesAt <= this.elapsed);
    if (!due.length) return;

    const row = this.deliveryVan();
    const lane = this.layout.vanRoute;
    // No van authored, or no way in to the yard. Both land the goods exactly the
    // way they landed before there was anything to look at, because a shop whose
    // bay is walled in must still receive the stock it paid for — an animation
    // that can fail must never be the thing that decides whether a delivery
    // happens. See `vanRoute` in server/layout.js for when a lane is null.
    if (!row || !lane?.in?.length) { this.landRun(due, pad); return; }

    // How many crates it can take. A crate is an armful (`crateCapacity`), which
    // is the unit the pads and the pallets already count in, so a van's
    // `capacity` is measured in the same thing a bay's cells are.
    const cap = Math.max(1, Math.round(row.capacity ?? 1));
    const crates = (o) => Math.max(1, Math.ceil(o.qty / this.crateCapacity()));
    const aboard = [];
    let load = 0;
    for (const o of due) {
      // The first order always gets on, however big it is. Otherwise a van
      // authored smaller than one order strands those goods for ever — paid
      // for, due, and refused by every van that ever comes.
      if (aboard.length && load + crates(o) > cap) break;
      aboard.push(o);
      load += crates(o);
    }

    const start = lane.in[0];
    this.van = {
      vehicle: row.id,
      x: start.x,
      z: start.z,
      facing: 0,
      // `followPath` eats this array from the front, so it is a copy of the
      // lane rather than the lane itself — the layout's route is read by every
      // van that ever comes.
      path: lane.in.slice(1).map((p) => ({ ...p })),
      // ...and its way home is taken now rather than looked up on the way out:
      // a re-flow between arriving and leaving would otherwise hand the van a
      // route computed for a shop it is standing in the wrong version of.
      out: lane.out.map((p) => ({ ...p })),
      // Where it is headed, kept so a re-flow can ask whether the lane it set
      // out on is still the lane. See the tail of `regenerateLayout`.
      dock: { ...lane.dock },
      phase: 'in',
      orders: aboard.map((o) => o.id),
      // How full it looks, 0..1, which is what drives the stages of its model —
      // the same one number a crop passes as growth and a break passes as
      // progress. Nothing in the renderer has to know what a crate is.
      //
      // `full` is what it left the depot with and `load` is what is still on
      // board. Two fields rather than one being scaled down each tick, which
      // reads as the same thing and decays geometrically: a tenth off a tenth
      // off a tenth never reaches empty, and the van would pull away still
      // looking a quarter full.
      full: clamp(load / cap, 0, 1),
      load: clamp(load / cap, 0, 1),
      wait: UNLOAD_SECONDS,
      // Set only if it arrives to find nowhere to unload — see `driveVan`.
      kept: false,
    };
  }

  /**
   * Drive it. In, stop, unload, out, gone.
   *
   * `followPath` and nothing else — the same function a shopper walks with,
   * handed a route that was decided once when the layout was made rather than
   * found per tick. **A vehicle is not a person**: A* would thread this lorry
   * between two planters and turn it on the spot, which is why the lane is
   * straight legs computed in `vanRoute` and why there is no pathfinding here.
   *
   * It occupies nothing while it does it — no tile, no `blocked`, no walk grid.
   * A decoration weighs nothing for the same reason, and this has a sharper
   * edge: the van parks on the one strip of ground a stocker is most likely to
   * be standing on, so a van that owned its cells could trap somebody at the bay
   * for the length of a delivery, and a van that arrived while they stood there
   * would have to decide what to do about a person under a lorry.
   */
  driveVan(dt) {
    const v = this.van;
    if (!v) return;

    const speed = content().byId.vehicles?.[v.vehicle]?.speed || VAN_SPEED;

    if (v.phase === 'in') {
      if (!followPath(v, speed, dt)) return;
      v.phase = 'unload';
      // The goods land as the doors open rather than as they shut, so the pile
      // growing on the pad and the van emptying are the same event. `load` runs
      // down over the pause below.
      const pad = this.layout.bay ?? this.dropPad();
      const run = this.orders.pending.filter((o) => v.orders.includes(o.id));
      if (pad && run.length) this.landRun(run, pad);
      // ...unless there was nowhere to put it, in which case it drives away
      // still loaded and the run stays pending for the next one. Worth the
      // extra field: a van that stood there emptying its load bar and left
      // nothing behind is a picture of a delivery that did not happen.
      else v.kept = true;
      return;
    }

    if (v.phase === 'unload') {
      v.wait -= dt;
      if (!v.kept) v.load = v.full * clamp(v.wait / UNLOAD_SECONDS, 0, 1);
      if (v.wait > 0) return;
      v.phase = 'out';
      if (!v.kept) v.load = 0;
      v.path = v.out;
      return;
    }

    if (followPath(v, speed, dt)) this.van = null;
  }

  /**
   * Land what the van brought.
   *
   * The only half of a delivery that touches goods: `dropGoods` and nothing
   * else, because a van that stacked crates by some second mechanism is the
   * "never invent a second container" mistake in CLAUDE.md wearing a
   * windscreen. It is also the one place an order stops being pending, so the
   * goods are on the van or on the floor and never both.
   */
  landRun(run, pad) {
    const landed = new Set(run.map((o) => o.id));
    this.orders.pending = this.orders.pending.filter((o) => !landed.has(o.id));

    const c = content();
    let units = 0;
    for (const o of run) {
      this.dropGoods(o.item_id, o.qty, pad);
      units += o.qty;
    }
    // One line for the run, not one per order. That is the whole point of a
    // run: everything asked for before the cutoff turns up together, and a log
    // that said it six times would read as six vans.
    const what = run.length === 1
      ? `${run[0].qty}x ${c.byId.items[run[0].item_id]?.name ?? run[0].item_id}`
      : `${units} units across ${run.length} orders`;
    this.pushLog(`The van's here — ${what} at the bay.`);
    this.persist();
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
   * How much one crate holds — and it is no longer an armful.
   *
   * It was `carryCapacity()`, deliberately, on the argument that a crate should
   * be a *trip*: one crate is one carry, taking one leaves nothing behind in
   * it, and a number of its own is a second unit of "how much is a lot" for the
   * player to learn. That was right for as long as a crate was only ever
   * something you emptied.
   *
   * It stopped being right the day you could pick the whole crate up. Hauling
   * is a decision — more goods per journey, but your hands are full of box, so
   * you have to set it down before you can do anything with what is inside —
   * and a crate that holds exactly what your arms hold makes that decision for
   * you by being pointless. The two numbers have to differ or there is nothing
   * on either side of the trade.
   *
   * So a crate is `CRATE_UNITS` and hands stay at six. It follows that a crate
   * is now TWO armfuls to empty by hand, which is the cost of the extra
   * capacity rather than an oversight, and that a pad holds twice what it did —
   * `bayRoom` and `padRoom` are both cells × this. That last one is a balance
   * change and was measured, not assumed.
   */
  crateCapacity() {
    return CRATE_UNITS;
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
   * One unit, in or out, on a quick tap.
   *
   * The third thing a crate does, and it exists because the other two left a
   * hole you could not get out of: a hold lifts the whole box, and once
   * empty-handed always meant "lift", there was no way left to start an armful
   * at all. Rummaging is the gesture that was missing.
   *
   * Direction is SAID rather than inferred. Reading it off your hands — put one
   * back if you happen to be holding some of what is in there, take one
   * otherwise — is one gesture and the wrong one: it makes the same press mean
   * opposite things depending on state you are not looking at, so rummaging
   * through a crate of the thing you are already carrying quietly unloads you
   * into it. Left takes, right puts. You always know which you asked for.
   *
   * ONE, not an armful. `unload` is the armful and it is what the pile menu and
   * a buried crate arm; this is the fine-grained one, so the three gestures
   * grade properly: a tap is a unit, a hold is the box, and the menu is the
   * armful in between.
   */
  tapCrate(playerId, crateId, put = false) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    if (p.haul) return err('put the crate down first');

    const crate = crateId
      ? this.deliveries.find((d) => d.id === crateId)
      : this.nearest(this.deliveries, p, UNLOAD_REACH);
    if (!crate) return err('no crate here');
    if (!near(p, crate, UNLOAD_REACH)) return err('too far from the crate');

    const name = content().byId.items[crate.item_id]?.name ?? crate.item_id;

    // Rummaging replaces whatever you had named. The press that opened this
    // gesture armed a lift on the way down — that is what lets one press be
    // either — so a tap has to spend it, or the lift sits there waiting and the
    // next time you hold anything near this crate you shoulder it instead.
    p.errand = null;
    p.action = null;

    // Putting one back. Same item only — a crate holds one kind, which is the
    // rule the whole pile display rests on.
    if (put) {
      if (!p.carry) return err('nothing in hand to put back');
      if (p.carry.item_id !== crate.item_id) {
        const mine = content().byId.items[p.carry.item_id]?.name ?? p.carry.item_id;
        return err(`that crate is for ${name}, not ${mine}`);
      }
      if (crate.qty >= this.crateCapacity()) return err(`that crate is full of ${name}`);
      crate.qty += 1;
      p.carry.qty -= 1;
      if (p.carry.qty <= 0) p.carry = null;
      return ok({ put: 1, item_id: crate.item_id, left: p.carry?.qty ?? 0 });
    }

    // ...and taking one out.
    if (p.carry && p.carry.item_id !== crate.item_id) {
      const mine = content().byId.items[p.carry.item_id]?.name ?? p.carry.item_id;
      return err(`hands full of ${mine} \u2014 put it down first`);
    }
    if (crate.qty <= 0) return err('that crate is empty');
    if ((p.carry?.qty ?? 0) >= this.carryCapacity(p)) return err('hands full');
    crate.qty -= 1;
    p.carry = { item_id: crate.item_id, qty: (p.carry?.qty ?? 0) + 1 };
    // A crate emptied to nothing stops existing, exactly as `unload` leaves it.
    // Two spellings of "the box is gone" would be a pile that keeps a ghost in
    // it, and the renderer stacks by what is in `deliveries`.
    if (crate.qty <= 0) this.deliveries = this.deliveries.filter((d) => d.id !== crate.id);
    return ok({ took: 1, item_id: crate.item_id, left: crate.qty });
  }

  /**
   * Is this the crate you could actually get hold of — nothing standing on it?
   *
   * A pile is drawn oldest at the bottom, by id, so "on top" is "no crate of a
   * higher id on this tile". Taking one out from underneath would drop the
   * tower through the floor, and it is also just not a thing you can do.
   *
   * Asked in two places and that is the point. `liftCrate` refuses on it,
   * because a verb has to defend itself; `errandAction` *chooses* on it, so a
   * buried crate arms the armful instead of arming a refusal. The pile menu
   * lists every crate on the tile, so without the second caller four rows out
   * of five walk you over there to be told no.
   */
  crateOnTop(crate) {
    const n = (d) => Number(String(d.id).slice(4)) || 0;
    return !this.deliveries.some((d) => d.id !== crate.id
      && Math.round(d.x) === Math.round(crate.x)
      && Math.round(d.z) === Math.round(crate.z)
      && n(d) > n(crate));
  }

  /**
   * Pick the whole crate up.
   *
   * The other half of `unload`, and the difference between them is the whole
   * mechanic: `unload` fills your ARMS off a crate and leaves the box where it
   * stands; this shoulders the box. So it moves twice as much per journey
   * (`CRATE_UNITS` against `carryCapacity`) and buys that with your hands —
   * everything that needs them refuses while you are holding it, and you get
   * them back by setting it down.
   *
   * Hands have to be empty to lift, which is a physical rule rather than a
   * balance one and is why it reads as obvious in play: you cannot pick up a
   * box while holding an armful of tomatoes. It also keeps the two states
   * disjoint, so nothing anywhere has to answer "what if both".
   *
   * Note this is `haul`, not a second kind of `carry`. Every existing reader of
   * `carry` — stocking, loading a hopper, `homeSupply`, the ring — keeps
   * working untouched and simply never sees a hauled crate, which is exactly
   * right: a crate on your shoulder is not stock in your hands.
   */
  liftCrate(playerId, crateId) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    if (p.haul) return err('already carrying a crate');
    if (p.carry) return err('hands full — put that down first');

    const crate = crateId
      ? this.deliveries.find((d) => d.id === crateId)
      : this.nearest(this.deliveries, p, UNLOAD_REACH);
    if (!crate) return err('no crate here');
    if (!near(p, crate, UNLOAD_REACH)) return err('too far from the crate');

    // A crate under a stack is a crate with another one standing on it. Taking
    // it out from underneath would drop the tower through the floor — the
    // renderer stacks by id per tile — so the top one comes off first, which is
    // also what anybody would do.
    if (!this.crateOnTop(crate)) return err('something is stacked on that one');

    this.deliveries = this.deliveries.filter((d) => d.id !== crate.id);
    p.haul = { item_id: crate.item_id, qty: crate.qty };
    const name = content().byId.items[crate.item_id]?.name ?? crate.item_id;

    // Rummaging replaces whatever you had named. The press that opened this
    // gesture armed a lift on the way down — that is what lets one press be
    // either — so a tap has to spend it, or the lift sits there waiting and the
    // next time you hold anything near this crate you shoulder it instead.
    p.errand = null;
    p.action = null;
    this.pushLog(`Picked up a crate of ${crate.qty}x ${name}.`);
    return ok({ lifted: crate.qty, item_id: crate.item_id });
  }

  /**
   * ...and set it down again, on the tile you are standing on.
   *
   * Anywhere walkable, deliberately — not the drop-off. `stow` exists because
   * an ARMFUL with nowhere to go strands you, so it needs a guaranteed legal
   * destination; a crate is already an object that stands on the floor and the
   * whole point of carrying one is to put it somewhere the goods are wanted.
   * Making the pad the only legal answer would mean hauling could only ever
   * move a crate between two pads.
   *
   * It goes down through `dropGoods` like everything else — the fifth caller's
   * argument, in CLAUDE.md — so it merges with a crate of the same thing
   * already standing there rather than growing a second box on one tile.
   */
  dropCrate(playerId, x = null, z = null) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    if (!p.haul) return err('not carrying a crate');

    // Where you are, unless you named a tile you can reach. Rounded, because a
    // crate stands in the middle of a tile — see `dropGoods`.
    const at = { x: Math.round(x ?? p.x), z: Math.round(z ?? p.z) };
    // The live walk grid, not the tile kind: it is both halves at once — the
    // ground is walkable AND nothing is standing on it — so a crate cannot be
    // set down inside a shelf you happened to be facing.
    if (!isWalkable(this.walk, this.layout, at.x, at.z)) {
      return err('nothing to stand a crate on there');
    }
    if (Math.hypot(at.x - p.x, at.z - p.z) > UNLOAD_REACH) return err('too far to reach');

    const { item_id: itemId, qty } = p.haul;
    this.dropGoods(itemId, qty, at);
    p.haul = null;
    const name = content().byId.items[itemId]?.name ?? itemId;
    this.pushLog(`Set down a crate of ${qty}x ${name}.`);
    return ok({ dropped: qty, item_id: itemId, at });
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

  /**
   * The one recipe this appliance is set to, or null if it knows none.
   *
   * A machine knows several and runs ONE. It used to run whichever it could —
   * `nextBatch` took the first recipe the hopper happened to satisfy — and that
   * is a machine nobody is driving: load a blender for salsa, have a jar of jam
   * left over from yesterday in it, and it makes smoothies. Worse, it made the
   * hopper unanswerable, because "how many tomatoes does this take" has no
   * answer until you know what it is making.
   *
   * Null on the record means *nobody has said*, which reads as the first recipe
   * it knows rather than as idle. Every appliance in every existing shop is that
   * — a read-time default rather than a migration, the same bargain `kindOf` and
   * `shell.z` strike — and an appliance that sat there making things yesterday
   * goes on making them today.
   *
   * A choice pointing at a recipe that has since been deleted falls back the
   * same way. Content is live-editable here, so that is a Tuesday afternoon
   * rather than a corrupt save.
   */
  stationRecipe(station) {
    const mine = this.recipesFor(station.station);
    if (!mine.length) return null;
    return mine.find((r) => r.id === station.recipe) ?? mine[0];
  }

  /**
   * Set which one. Not gated on build mode: this is a choice about what the
   * shop makes, like reserving a shelf or sowing a bed, not construction.
   *
   * Whatever is already in the hopper stays where it is. Ingredients the new
   * recipe has no use for are still yours — Empty tips the lot back into crates
   * — and destroying them on a menu press would make changing your mind cost
   * money. It does mean a machine can sit holding something it will never use,
   * which the bays say out loud by not drawing it.
   */
  setStationRecipe(playerId, stationId, recipeId) {
    const st = (this.layout.stations ?? []).find((s) => s.id === stationId);
    if (!st) return err('no such appliance');
    const want = this.recipesFor(st.station).find((r) => r.id === recipeId);
    if (!want) return err(`the ${st.station} cannot make that`);
    if (st.recipe === want.id) return ok({ station: st.id, recipe: want.id });
    // A batch already running is left to finish. It has eaten its ingredients
    // and its output is promised — cancelling it here would destroy both, and
    // the machine is a minute from being free anyway.
    st.recipe = want.id;
    this.pushLog(`The ${st.station} is set to ${want.name}.`);
    return ok({ station: st.id, recipe: want.id });
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
   * How much of one ingredient the hopper takes: what the recipe it is SET TO
   * calls for, times the batches it holds. Anything that recipe doesn't want,
   * it has no room for at all.
   *
   * This used to be the largest call any recipe on the machine made, because a
   * machine that flipped between recipes on its own could not have a bin sized
   * to one of them. That reasoning went with the flipping. The number is now
   * something a player can act on — "3 tomatoes a batch, four batches, twelve"
   * — where before it was the maximum of things it might turn out to be doing.
   */
  stationHopperCap(station, itemId) {
    const per = (this.stationRecipe(station)?.inputs ?? [])
      .filter((i) => i.item_id === itemId)
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
   * One candidate — the recipe it is set to. Ingredients in the hopper AND
   * somewhere to put the result. The second half is the whole difference
   * between a machine that runs itself down and one that makes a single portion
   * and waits for a human.
   */
  nextBatch(station) {
    const r = this.stationRecipe(station);
    if (!r) return null;
    const can = r.inputs.every((i) => (station.contents[i.item_id] ?? 0) >= i.qty)
      && this.stationOutputRoom(station, r) >= r.output_qty;
    return can ? r : null;
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

    // Only accept things the recipe it is SET TO wants — otherwise the hopper
    // fills with ingredients for a recipe it isn't making, which can never come
    // out except by tipping the whole machine up. It was every recipe's inputs
    // while the machine chose for itself; now that you choose, a refusal here is
    // the machine telling you it is set to the other thing.
    const recipe = this.stationRecipe(st);
    if (!recipe) return err(`no recipes for the ${st.station} yet`);
    if (!recipe.inputs.some((i) => i.item_id === p.carry.item_id)) {
      const name = content().byId.items[p.carry.item_id]?.name ?? p.carry.item_id;
      return err(`the ${st.station} is making ${recipe.name} — no use for ${name}`);
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
    const take = Math.min(st.output.qty, this.carryCapacity(p) - have);
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
  /**
   * Lift an armful off a pallet.
   *
   * `cap` is "don't hand me more than this", and it exists for the one caller
   * that knows something this method cannot: a stocker knows how much room the
   * shelves actually have. Without it a worker lifts six, finds a board with
   * space for one, puts one away and is left holding five with nowhere to go —
   * so `tidy` walks them to the drop-off and crates it, `unload` sees a crate
   * with somewhere to go the moment a customer buys one, and the shop spends the
   * rest of the day milling the same eggs between two pads. Twelve round trips
   * in one in-game hour, every one of them logged, none of them work.
   *
   * A cap rather than a refusal, because taking *some* is right — half a crate
   * onto a half-empty board is a good trip. It is only the surplus that has
   * nowhere to be.
   */
  unload(playerId, deliveryId, cap = Infinity) {
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
    const take = Math.min(del.qty, this.carryCapacity(p) - have, Math.max(0, cap));
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
    const take = Math.min(stack.qty, this.carryCapacity(p) - have);
    if (take <= 0) return err('hands full');

    stack.qty -= take;
    p.carry = { item_id: itemId, qty: have + take };
    this.pushLog(`Took ${take}x ${item?.name ?? itemId} off the ${this.fixtureSaid(shelf)}.`);
    return ok({ took: take, item_id: itemId, left: stack.qty });
  }

  /**
   * Which board on this unit will take this item, and how much of it.
   *
   * Extracted so the two things that fill a shelf — an armful (`stockShelf`)
   * and a crate poured straight in (`stockFromCrate`) — ask ONE question. They
   * are the same rules: a freezer item needs a freezer, a reservation binds, a
   * unit out of free boards refuses, a full board refuses. Written twice they
   * would drift, and the drift is invisible: a shelf you set aside would accept
   * a crate and refuse an armful, or the other way round, and both look like
   * the staff being stupid rather than like two copies of one rule.
   *
   * Returns the same `{ ok, error }` shape everything else does, plus the board
   * and how much it will take.
   */
  boardFor(shelf, item) {
    if (!item) return err('that item no longer exists');

    const fixture = requiredFixture(item);
    if (fixture === 'freezer' && shelf.kind !== 'freezer') {
      return err(`${item.name} needs a freezer`);
    }
    // A reservation refuses your hands too, and says how to take it back —
    // otherwise the shelf you set aside this morning reads as broken tonight.
    const kept = toList(shelf.assigned);
    if (kept.length && !kept.includes(item.id)) {
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
    return ok({ stack, room });
  }

  /**
   * Pour a carried crate straight onto the shelf, without setting it down.
   *
   * The staff half of hauling, and the reason there is no crate on your shop
   * floor. The first shape of this had a hire set the box down at the board and
   * then unload it by armfuls — which is a person carrying twelve across the
   * shop, putting them on the ground, and picking six of them up again. Worse,
   * the dance is interruptible at every step, so what you actually watched was
   * one hire drop a crate and wander off, a second take four out of it, and a
   * third carry it back to the yard. Three people, one crate, no chain.
   *
   * Whatever will not fit stays on the shoulder. That is what lets one hire
   * finish the job: the next tick they take the rest to the next board, and
   * when nothing more will have it they walk it home. The crate is only ever on
   * a pad or on somebody.
   */
  stockFromCrate(playerId, shelfId) {
    const p = this.players[playerId];
    const shelf = this.layout.shelves.find((s) => s.id === shelfId);
    if (!p || !shelf) return err('no such shelf');
    if (!near(p, shelf)) return err('too far from that shelf');
    if (!p.haul || p.haul.qty <= 0) return err('no crate to empty');

    const item = content().byId.items[p.haul.item_id];
    const board = this.boardFor(shelf, item);
    if (!board.ok) return board;

    const moved = Math.min(board.room, p.haul.qty);
    const wasEmpty = board.stack.qty === 0;
    board.stack.qty += moved;
    if (wasEmpty) {
      board.stack.stockedDay = this.day;
      board.stack.price = suggestedPrice(item, this.folded(), this.season);
    }
    p.haul.qty -= moved;
    if (p.haul.qty <= 0) p.haul = null;
    return ok({ stocked: moved, item_id: item.id, left: p.haul?.qty ?? 0 });
  }

  stockShelf(playerId, shelfId) {
    const p = this.players[playerId];
    const shelf = this.layout.shelves.find((s) => s.id === shelfId);
    if (!p || !shelf) return err('no such shelf');
    if (!near(p, shelf)) return err('too far from that shelf');
    if (!p.carry || p.carry.qty <= 0) return err('nothing in hand');

    const item = content().byId.items[p.carry.item_id];
    const board = this.boardFor(shelf, item);
    if (!board.ok) return board;
    const { stack, room } = board;

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
      this.pushLog(`The ${this.fixtureSaid(shelf)} takes anything again.`);
      return ok({ assigned: [], shelf: shelf.id });
    }

    const item = content().byId.items[itemId];
    if (!item) return err('no such item');

    // Untick. Always allowed, and deliberately does NOT touch the stock: you
    // said stop reserving a board for this, not throw away what is on it. The
    // goods stay and sell down, and the board frees itself when they are gone.
    const want = on === null ? !kept.includes(itemId) : on === true;
    if (!want) {
      if (!kept.includes(itemId)) return err(`that ${this.fixtureSaid(shelf)} was not kept for ${item.name}`);
      shelf.assigned = kept.filter((id) => id !== itemId);
      this.pushLog(`The ${this.fixtureSaid(shelf)} is no longer kept for ${item.name}.`);
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
      return err(`that ${this.fixtureSaid(shelf)} only has ${boards} board${boards === 1 ? '' : 's'}`);
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
    // …and asking for it back is how you overrule the shop having given up on
    // it (`giveUpBoard`). One mechanism rather than two: the alternative was to
    // leave the mark and let a reservation outrank it inside `shelvesFor`,
    // which works and then leaves a shop carrying a "we don't stock that"
    // against something on a shelf with its name on it. The log line promises
    // this outright, so it has to be the thing that happens.
    if (this.orders.dropped?.[itemId] !== undefined) delete this.orders.dropped[itemId];
    this.pushLog(`The ${this.fixtureSaid(shelf)} is set aside for ${item.name}.`);
    return ok({ assigned: shelf.assigned, shelf: shelf.id });
  }

  /**
   * Which shelf the next van fills. -1 last, 0 as it comes, 1 first.
   *
   * Three steps rather than a number you type, because the only thing anybody
   * wants to say is which end of the queue this goes on, and a shop of eleven
   * shelves each holding its own integer is a spreadsheet.
   */
  /**
   * May the shop hand rearrange this unit?
   *
   * The `merchandise` job's own veto, and it is deliberately NOT the
   * reservation. A reservation says *what a board is for* and comes with a
   * hands-off rule attached, which covers the shelf you have plans for and
   * nothing else — every unit you have said nothing about is fair game, and
   * "leave that one alone" was a sentence the shop had no way to hear. Two
   * different questions wearing one control is how you end up ticking an item
   * you do not want onto a shelf to stop a worker touching it.
   *
   * Stored the way round that makes the shipped shop the default: `managed`
   * reads true when a save does not mention it, so nothing changes for a shop
   * that has never opened this menu — the same argument `open` makes. Which is
   * why `persist` has to keep a shelf that holds *nothing* and says only this:
   * a switch you flipped on an empty unit is still a decision.
   */
  setShelfHands(shelfId, on) {
    const shelf = this.layout.shelves.find((s) => s.id === shelfId);
    if (!shelf) return err('no such shelf');
    shelf.managed = on !== false;
    this.pushLog(shelf.managed
      ? `The shop hand looks after the ${this.fixtureSaid(shelf)} again.`
      : `The shop hand leaves the ${this.fixtureSaid(shelf)} alone.`);
    return ok({ managed: shelf.managed, shelf: shelf.id });
  }

  /** Is this unit the shop hand's to rearrange? True unless you said otherwise. */
  handMayTouch(shelf) {
    return shelf?.managed !== false;
  }

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
   * What to call one in a sentence — "the bakery case", "the plot".
   *
   * Lowercased, because every caller is writing "the …" mid-log. The capital
   * lives in `fixtureLabel` where the client wants it for a panel heading.
   */
  fixtureSaid(f) {
    return fixtureLabel(content().fixtures ?? [], f).toLowerCase();
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
    this.pushLog(`Upgraded a ${this.fixtureSaid(f)} to ${next.name} for $${next.cost.toFixed(2)}.`);
    return ok({ upgraded: res.id, tier: next.tier, cost: round2(next.cost) });
  }

  /**
   * The rung below, and what stepping back onto it hands you.
   *
   * The refund is half of what the rung it is *on* costs today — the same
   * `FIXTURE_REFUND` the Remove button pays, read off the catalog rather than
   * off what anybody remembers paying. Two consequences, both deliberate: a
   * ladder somebody re-prices is worth what it is worth now, and up-then-down
   * always loses money, so no amount of cycling can print any.
   */
  prevTier(idOrFixture) {
    const f = typeof idOrFixture === 'string' ? this.findFixture(idOrFixture) : idOrFixture;
    if (!f) return null;
    const at = this.fixtureTier(f);
    if (at <= 1) return null;
    const tiers = this.fixtureTiers(f);
    const below = tiers[at - 2];
    if (!below) return null;
    return {
      ...below,
      tier: at - 1,
      refund: round2((tiers[at - 1]?.cost ?? 0) * FIXTURE_REFUND),
    };
  }

  /**
   * What a lower rung could not hold, said in a sentence — or null if it fits.
   *
   * A tier is not only a multiplier: a staged model can grow a *board* as it
   * climbs (the shipped freezer draws 2, 2, 3), so stepping down can take away
   * both how much of one thing a unit holds and how many things it holds at
   * all. Neither is checked anywhere else, because nothing else has ever made a
   * fixture smaller — `stockShelf` asks before putting goods on and no goods
   * are moving here.
   *
   * So it is asked before the money moves, with the guards, the way `buyStock`
   * had to learn to. Refusing rather than tipping the excess into a crate is
   * the same call `removeFixture` makes with "empty it first": a verb that
   * quietly rearranges your stock is one you cannot undo by pressing it again.
   */
  tierShortfall(f, tier) {
    const as = { ...f, tier };
    if (f.kind === 'shelf' || f.kind === 'freezer') {
      const held = this.shelfStacks(f).filter((k) => (k.qty ?? 0) > 0);
      const boards = this.shelfBoards(as);
      if (held.length > boards) {
        return `a smaller one holds ${boards} kind${boards === 1 ? '' : 's'} and there are ${held.length} on it`;
      }
      for (const k of held) {
        const item = content().byId.items[k.item_id];
        if (!item) continue;
        const cap = this.shelfCapacity(as, item);
        if (k.qty > cap) {
          return `a smaller one holds ${cap}× ${item.name} and there are ${k.qty} on it — take ${k.qty - cap} off first`;
        }
      }
      return null;
    }
    if (f.kind === 'station') {
      for (const [itemId, qty] of Object.entries(f.contents ?? {})) {
        const cap = this.stationHopperCap(as, itemId);
        if (qty > cap) {
          const name = content().byId.items[itemId]?.name ?? itemId;
          return `a smaller one takes ${cap}× ${name} and the hopper has ${qty} — empty it first`;
        }
      }
      const out = f.output;
      const recipe = out ? this.stationRecipe(as) : null;
      if (out && recipe && recipe.output_id === out.item_id) {
        const cap = recipe.output_qty * this.stationBatches(as);
        if (out.qty > cap) return `a smaller one holds ${cap} made up and there are ${out.qty} waiting — collect them first`;
      }
      return null;
    }
    return null;
  }

  /**
   * Step one fixture back down a tier, for half of what that rung costs.
   *
   * `upgradeFixture` read one way for as long as it existed: a ladder you climb
   * and cannot come back down, so a rung bought by mistake — or one whose upkeep
   * stopped being worth it — was undone by selling the whole unit back and
   * building it again, which loses the stock, the reservations and the tile.
   * This is the same one call the other way: same fixture, same tile, same
   * stock, one number down.
   */
  downgradeFixture(playerId, id) {
    const { f, error } = this.buildTarget(playerId, id);
    if (error) return err(error);

    const prev = this.prevTier(f);
    if (!prev) return err('that is as plain as it gets');
    const shortfall = this.tierShortfall(f, prev.tier);
    if (shortfall) return err(shortfall);

    const res = this.repositionFixture(id, {
      kind: f.kind, station: f.station ?? null, x: f.x, z: f.z, rot: f.rot ?? 0, tier: prev.tier,
    });
    if (!res.ok) return res;

    this.cash += prev.refund;
    this.pushLog(`Put a ${this.fixtureSaid(f)} back to ${prev.name} — $${prev.refund.toFixed(2)} back.`);
    return ok({ downgraded: res.id, tier: prev.tier, refund: prev.refund });
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
  emptyFixture(playerId, id, itemId = null) {
    const { p, f, error } = this.buildTarget(playerId, id);
    if (error) return err(error);

    if (f.kind === 'shelf' || f.kind === 'freezer') {
      // Same verb, one address finer. A unit holding three things is three
      // boards at one id, and "tip it out" asked of the row you are looking at
      // is not the same sentence as asked of the unit — the errand's three
      // kinds of address, said about a shelf.
      return itemId ? this.clearBoard(playerId, id, itemId) : this.stripShelf(playerId, id);
    }
    if (f.kind === 'station') return this.dumpStation(playerId, id);
    if (f.kind === 'plot') {
      const plot = f.ref;
      if (!plot.crop_id) return err('nothing growing there');
      // A half-grown crop is a sunk cost — there's nothing to put in a crate.
      const name = content().byId.crops[plot.crop_id]?.name ?? plot.crop_id;
      this.clearPlot(plot);
      this.pushLog(`Cleared the ${name} out of the ${this.fixtureSaid(plot)}.`);
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
      ? `Stripped ${names.join(', ')} off the ${this.fixtureSaid(shelf)} — it's in crates beside it.`
      : `Cleared the labels off the ${this.fixtureSaid(shelf)}.`);
    return ok({ emptied: moved, shelf: shelf.id });
  }

  /**
   * Take ONE board off a unit — the goods into a crate, and the label with them.
   *
   * The only thing in the game that clears a reservation *and* the stock, and
   * that is deliberate rather than an oversight of the rule above it.
   * `stripShelf` keeps `assigned` because tipping a shelf out is nearly always
   * the first half of restocking it. This is the opposite ask: the row is on the
   * menu because the shelf sells this, and a delete that left the reservation
   * behind would put the row straight back on the next van — a button that
   * visibly undoes itself, which reads as broken rather than as careful.
   *
   * An empty board is deleted rather than refused. A stack sitting at 0 still
   * holds a board (see `clearStack`), so "there is nothing to tip out" is
   * exactly when you most want the row gone.
   */
  clearBoard(playerId, shelfId, itemId) {
    const shelf = this.layout.shelves.find((s) => s.id === shelfId);
    if (!shelf) return err('no such shelf');
    const kept = toList(shelf.assigned);
    const stack = this.shelfStack(shelf, itemId);
    if (!stack && !kept.includes(itemId)) return err('that is not on this shelf');

    const name = content().byId.items[itemId]?.name ?? itemId;
    const qty = stack?.qty ?? 0;
    // Never destruction — a pallet beside it, the same crate `stripShelf` tips
    // a whole unit into and the same one the stocker will tidy away.
    if (qty > 0) this.dropGoods(itemId, qty, shelf.browseAt);
    this.clearStack(shelf, itemId);
    shelf.assigned = kept.filter((id) => id !== itemId);

    this.pushLog(qty > 0
      ? `Took ${qty}x ${name} off the ${this.fixtureSaid(shelf)} — it's in a crate beside it.`
      : `Took ${name} off the ${this.fixtureSaid(shelf)}.`);
    return ok({ emptied: qty, shelf: shelf.id, item: itemId });
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
    this.pushLog(`Removed a ${this.fixtureSaid(f)} — $${refund.toFixed(2)} back.`);
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
      // Spread, not rebuilt. Writing the two fields it changes and nothing else
      // dropped `z`, and `storeNorth` reads `shell.z ?? STORE_NORTH_LEGACY` — so
      // a shop stamped at the modern z=5 silently became a legacy z=2 the moment
      // you bought space, jumping the entire building three rows north. Every
      // placement then outside it was dropped and refunded, which on a real save
      // meant shelves 21 -> 14, plots 3 -> 0 and checkouts 1 -> **0**: a shop
      // that cannot sell, presenting as "I bought an upgrade and went broke".
      // Measured at revenue $723 over 60 days against $33,353 with this fixed.
      //
      // The irony is that `shell.z` exists precisely to stop the building
      // moving. A field added to pin something down is exactly the field a
      // wholesale rewrite of its object will lose, so extend rather than replace.
      if (this.shell) this.shell = { ...this.shell, w: this.shell.w + dw, h: this.shell.h + dh };
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
   * Stamp the awning over the front door once, and stop drawing it.
   *
   * `freezeYard`'s argument, made about the shop front. The awning was four
   * striped boxes the renderer laid over `L.door` every time it built the
   * world, which meant it was not a thing: you could not aim at it, move it,
   * sell it back, put a second one anywhere, or take it down. The palette had
   * nothing that could produce one either, so "get rid of that" had no answer
   * at all — not even an expensive one.
   *
   * Handed over as ordinary `prop-floor` placements it is all of those things
   * at once, and no code in the renderer knows what an awning is any more: it
   * is a catalog row with a striped model, the same as a planter or a lamp.
   *
   * Free, deliberately. Every existing shop is being given back the thing it
   * was already looking at, and charging for that would read as the game
   * billing you on load. What it costs is `cost` on the row, from the second
   * one onwards.
   *
   * `canPlace` is asked about each section rather than trusted, for the rule
   * the yard learned the hard way: **the seed may only lay what the player
   * could lay**. A shop whose doorway opens onto a plot, a crate or the border
   * ring gets fewer sections rather than four illegal ones, and the mark is set
   * either way — one attempt, on the load this lands, and never again.
   */
  freezeAwning() {
    if (this.awningStamped) return false;
    this.awningStamped = true;
    const spec = defaultAwning(this.layout);
    const stamped = [];
    for (const s of spec) {
      const p = {
        id: `fx-${this.nextFixtureId}`,
        kind: 'prop-floor',
        piece: 'awning',
        station: null,
        x: s.x,
        z: s.z,
        rot: s.rot,
        tier: 1,
        variant: '',
        boh: false,
      };
      // Against the layout *plus* whatever this loop has already put down, so
      // two sections cannot be stamped onto one cell — `canPlaceProp` allows
      // one prop to a cell and it reads `L.props`, which has not been rebuilt
      // yet. Cheapest correct answer is to re-flow as we go; there are four.
      if (!canPlace(this.layout, p).ok) continue;
      this.nextFixtureId++;
      this.placements = [...this.placements, p];
      stamped.push(p);
      this.regenerateLayout();
    }
    return stamped.length > 0;
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
      ['contents', 'busyUntil', 'making', 'output', 'startedAt', 'recipe'],
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
        // ...and one who drove is still walking back to their car rather than to
        // the edge of the map. Same reasoning as `leaveShop`, and it has to be
        // repeated here rather than delegated: this is a re-path of somebody
        // already leaving, and `leaveShop` is the act of leaving. If the pad was
        // painted over while they shopped the cell is ordinary ground now, and
        // walking to it is still the least surprising thing they could do.
        if (cu.parkedAt) { this.pathTo(cu, cu.parkedAt); continue; }
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

    // ...and the van is driving to a dock that may have moved. Same problem as
    // the shoppers above, with one difference that decides the answer: its
    // route is not A*, it is `layout.vanRoute`, recomputed right here.
    //
    // So it goes home only when the lane it set out on is no longer the lane.
    // Restarting it on *every* re-flow reads as a van that never arrives, and a
    // player who is building re-flows on every wall segment — one drive-in per
    // wall, forever. Only the inbound half is worth restarting: its cargo is
    // still `orders.pending` and still due, so dropping it puts a fresh van at
    // the edge of the map on the very next tick and nothing is lost. One that
    // is already leaving has nothing aboard, and popping it out of existence
    // beside the bay is worse than letting it drive off a lane that moved.
    const dock = layout.vanRoute?.dock;
    if (this.van?.phase === 'in'
      && (!dock || dock.x !== this.van.dock.x || dock.z !== this.van.dock.z)) {
      this.van = null;
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

  /**
   * Every cell of the car park a shopper could actually park in — nearest the
   * door first, and only the ones they can walk out of.
   *
   * **One cell holds one car.** That is the break area's "one cell seats one
   * person" said about the people who came to buy, and it is what makes how big
   * you paint it the entire decision: this list is how many drivers the shop can
   * hold at once, and `parkReach` reads its length as how far away people are
   * willing to come from.
   *
   * The route test is not decoration, and it is the same one `seatIn` makes
   * about a seat. A space is only a space if there is a way from it to the door
   * — a pad painted behind the building, or walled off by an annex somebody drew
   * afterwards, would otherwise spawn shoppers with nowhere to go: `pathTo`
   * hands them an empty path, they arrive nowhere, browse nothing, and leave
   * counted as having found nothing they wanted. That is a car park that makes
   * the shop *worse* than no car park, which is precisely the shape of the
   * walled-off break room this borrows the fix from.
   *
   * Nearest the door first so a pad fills from the end a person would use, and
   * so the reachable one is almost always the first one tried. The tie-break is
   * on coordinates rather than left to the sort, because which space a shopper
   * takes has to be a fact about the shop and not about the order a scan
   * happened to run in — two runs of one seed must agree.
   *
   * Memoised, and it has to be: this is A* per cell, and it is asked on the
   * spawn of every shopper and on every snapshot. Once per re-flow is free, and
   * a shop with no car park never gets past the empty `padCells`.
   */
  parkSpaces() {
    if (this.parkCache?.layout === this.layout) return this.parkCache.cells;
    const door = { x: this.layout.door.x, z: this.layout.door.z - 1 };
    const near = (c) => Math.hypot(c.x - door.x, c.z - door.z);
    const cells = padCells(this.layout, 'park')
      .sort((a, b) => (near(a) - near(b)) || (a.z - b.z) || (a.x - b.x))
      .filter((c) => findPath(this.walk, this.layout, c, door) !== null);
    this.parkCache = { layout: this.layout, cells };
    return cells;
  }

  /**
   * A space with no car in it, or null — which is both "the pad is full" and
   * "there is no pad", and the caller wants the same answer to both.
   *
   * A claim is read off the customers themselves rather than kept in a set
   * beside them, for the reason the fixture ledger retired: a list of who is
   * parked where is a second record that can disagree with the shoppers, and
   * `despawn` would have to remember to clear it. Somebody who has gone home
   * cannot still be holding a space if the space is only ever held by somebody
   * who is here.
   */
  freeSpace() {
    const spaces = this.parkSpaces();
    if (!spaces.length) return null;
    const taken = new Set();
    for (const cu of Object.values(this.customers)) {
      if (cu.parkedAt) taken.add(`${cu.parkedAt.x},${cu.parkedAt.z}`);
    }
    return spaces.find((c) => !taken.has(`${c.x},${c.z}`)) ?? null;
  }

  /**
   * ...and how much of the town that reaches, which saturates.
   *
   * The second thing a car park is worth, and the honest one: parking is how far
   * people are willing to come, which is exactly what catchment means and
   * exactly what shopkeeping cannot otherwise move. A shelf cannot make somebody
   * live nearer.
   *
   * Diminishing on purpose and hard, for the reason `charmReach` gives about pot
   * plants: ground is the cheapest thing in the game to lay, so an unbounded
   * term here would make a field of tarmac the whole strategy. The curve is the
   * same shape charm's is — most of the value in a small pad, never quite
   * arriving, so there is always a reason to add one more space and never a
   * reason to add twenty.
   *
   * Painted spaces, not occupied ones: this is the town knowing it can park,
   * which is true on a quiet Tuesday as well as at noon on Saturday.
   */
  parkReach() {
    const n = this.parkSpaces().length;
    if (n <= 0) return 0;
    return round2(PARK_MAX * (1 - Math.exp(-n / PARK_HALF)));
  }

  /**
   * The cars standing in the car park, for whoever is drawing them.
   *
   * Derived from the shoppers rather than kept as its own list, so a car exists
   * for exactly as long as the person who drove it is in the shop and there is
   * no second thing to tidy up. Keyed by the customer's id for the same reason
   * the van sends `vehicle`: the renderer needs to know which mesh is which one
   * between frames, and a car is the one prop in the game that stands perfectly
   * still for a minute and then is gone.
   */
  parkedCars() {
    const out = [];
    for (const cu of Object.values(this.customers)) {
      if (!cu.parkedAt || !cu.car) continue;
      out.push({
        id: cu.id, vehicle: cu.car,
        x: cu.parkedAt.x, z: cu.parkedAt.z, facing: r2(cu.parkedFacing ?? 0),
      });
    }
    return out;
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

      // Did this one drive?
      //
      // The space is looked for BEFORE the roll, and the order is the whole
      // reason this is two expressions rather than one. `&&` short-circuits, so
      // a shop with no car park — which is every shop that exists today — never
      // reaches `rng.next()`, draws exactly the random numbers it always drew,
      // and comes out of a balance run byte-identical to the same seed before
      // this feature existed. Rolling first and then asking would shift the
      // whole RNG stream for shops that cannot use the answer, and CLAUDE.md is
      // explicit about what that does to a measurement: two runs diverge for
      // reasons that have nothing to do with what changed.
      //
      // It also means a full car park costs nothing but the scan. There is no
      // waiting for a space and there should not be — somebody who could not
      // park drove past, and what they did instead is walk in, which is the
      // ordinary arrival this game has always had.
      const space = this.freeSpace();
      this.spawnCustomer(null, space && this.rng.next() < DRIVE_SHARE ? space : null);
    }
  }

  spawnCustomer(archetypeId, space = null) {
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

    /**
     * ...unless they drove, in which case they are already here, standing at
     * the car. A driver walks in from the space rather than from the edge of
     * the map, which is the visible half of the whole feature: the reason to
     * pay for the ground is that you can watch it fill up.
     *
     * Both halves have to be true to have driven. The space is the shop's — one
     * cell, one car — and the CAR is content's, because the size of a driver's
     * shop is that row's `capacity` and there is no second spelling of it
     * anywhere in `server/`. So a database with no customer vehicle in it has no
     * drivers at all rather than drivers with an invented boot: `capacity` is
     * the one field on a vehicle the sim reads as a number, and a fallback here
     * would be a balance constant nobody authored, sitting where the author is
     * supposed to be looking. The pad is still worth its catchment either way.
     */
    const car = space ? this.customerCar() : null;
    const at = car ? space : approach.off;

    const id = `c${this.nextCustomerId++}`;
    /**
     * How much they are here for, and what a car is worth.
     *
     * **A driver takes a bigger basket, and how much bigger is the car.** It is
     * added rather than multiplied because that is what the field says it is —
     * "a shopper who drove takes home this much more than one who walked",
     * `VehicleSchema` — and because a multiplier would make the car worth most
     * to whoever was already buying the most, which is backwards: the boot is
     * the same size whoever is filling it.
     *
     * The draw itself is untouched, deliberately, so a walker takes exactly the
     * basket they always took from exactly the same random number. Everything
     * about a driver is arithmetic on top of it.
     *
     * `MAX_LIST_LINES` is doing quiet work here and should stay: a bigger
     * basket becomes *more of the same few things* rather than a longer walk
     * round the shop, which is what a car full of shopping is and also what
     * stops a driver burning their patience visiting eleven shelves.
     */
    const walked = this.rng.int(arch.basket_min, arch.basket_max);
    const units = walked + (car ? Math.max(1, Math.round(car.capacity ?? 1)) : 0);
    /**
     * ...and the wallet comes with it, in the same proportion.
     *
     * Not a second knob and not a reward: `budget` is what this trip is worth to
     * them, and a bigger list against the same money is not a bigger shop, it is
     * a shopper who stops paying halfway down it. The extra items would simply
     * fail the `spent() + price > budget` test at the shelf and be booked as
     * demand the shop did not serve — so the car park would read as making
     * people *want* more and get less, which is the opposite of what it is for.
     * Money-per-item is held exactly where the archetype put it.
     */
    const bigger = walked > 0 ? units / walked : 1;
    const cust = {
      id,
      archetype_id: arch.id,
      // A driver is put down ON their space and a walker off the edge of the
      // world. The jitter that keeps four people arriving on one footpath from
      // filing in single file is wrong in a car park, where two thirds of a tile
      // is standing on the next car — so a driver gets none of it, at the cost
      // of the same two draws either way.
      x: at.x + this.rng.float(-(car ? 0 : 0.7), car ? 0 : 0.7),
      z: at.z + this.rng.float(-(car ? 0 : 0.7), car ? 0 : 0.7),
      facing: 0,
      color: arch.color,
      state: 'ENTER',
      path: null,
      basket: [],
      // Set at the till and never read by the sim — it is what they walk out
      // holding. See the `basket` line in `snapshot`.
      bought: null,
      budget: this.rng.float(arch.budget_min, arch.budget_max) * bigger,
      // Which space they are holding and what is standing in it, or null for
      // everybody who walked. It is the claim on the cell (`freeSpace`), the
      // thing the renderer draws (`parkedCars`), and where they walk back to
      // when they are done (`leaveShop`) — one field, because they are one fact.
      parkedAt: car ? { x: space.x, z: space.z } : null,
      car: car?.id ?? null,
      // Nose towards the shop, worked out once. A parked car never moves, so
      // there is nothing to derive a facing from later.
      parkedFacing: car
        ? Math.atan2(this.layout.door.x - space.x, this.layout.door.z - space.z)
        : 0,
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
    if (car) this.stats.drove++;
    // A driver has a tile under them already, so they walk from where they are.
    // The `from` argument is the off-grid leg a walker needs and a shopper
    // standing in a marked bay does not — handing A* a start that is not on the
    // grid is exactly what it exists for, and handing it one that is would tack
    // a phantom first step onto the route.
    this.pathTo(cust, { x: this.layout.door.x, z: this.layout.door.z - 1 },
      car ? null : approach);
    return ok({ id, archetype: arch.id, drove: !!car });
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
      // `seen` and `blocked` are what `failLine` reads to tell a stockout from a
      // price-out from a shelf nobody can walk to — counts rather than flags,
      // because "some of the candidates were unreachable" and "all of them were"
      // are different answers and only the second one is the shop's fault.
      const line = lines.get(tag)
        ?? { tag, qty: 0, got: 0, must: false, failed: false, seen: 0, blocked: 0 };
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
   * WHICH BOARD, not which shelf — the address `visited` is kept in.
   *
   * A shopper looks at a board once per trip, and that used to be spelled as
   * "once per shelf", which was the same sentence back when a unit held one
   * thing. It stopped being true the day a shelf grew boards, and the failure
   * is silent and total: take the eggs off a freezer and the milk standing
   * beside them is struck off with it, so a shopper on a `dairy` errand is told
   * the shop has no dairy while stood in front of eight bottles of it.
   */
  boardKey(shelfId, itemId) {
    return `${shelfId} ${itemId ?? ''}`;
  }

  /**
   * Strike one board off, or — with no item — the whole unit.
   *
   * The unit-wide form is for a shelf there is no route to. Marking only the
   * board they aimed at would send them back to the same unreachable fixture
   * for the next board on it, and the one after that, spending the patience
   * that walling a shelf in is supposed to cost them once.
   */
  markVisited(cust, shelf, itemId = null) {
    if (!shelf) return;
    if (itemId) { cust.visited.push(this.boardKey(shelf.id, itemId)); return; }
    for (const stack of this.shelfStacks(shelf)) {
      cust.visited.push(this.boardKey(shelf.id, stack.item_id));
    }
  }

  /**
   * Is there a stocked board out front carrying this tag at all, and what would
   * the cheapest one cost?
   *
   * The honest answer to "did you have any", asked of the shop rather than
   * inferred from what this shopper got round to looking at. Ignores `visited`
   * and ignores who is asking on purpose — this is stock-taking, not shopping.
   * Back of house is excluded because a shopper cannot walk into your stockroom,
   * which is the one exclusion that is genuinely about *having* it.
   */
  stockedForTag(tag, c = content()) {
    let best = null;
    for (const shelf of this.layout.shelves) {
      if (shelf.boh) continue;
      for (const stack of this.shelfStacks(shelf)) {
        if (!stack.item_id || stack.qty <= 0) continue;
        const item = c.byId.items[stack.item_id];
        if (!item || !item.tags.includes(tag)) continue;
        if (!best || stack.price < best.price) best = { item, price: stack.price, shelf };
      }
    }
    return best;
  }

  /**
   * Nothing on the shelves answers this line. Written off rather than retried,
   * which is also what stops an unsatisfiable list looping — `chooseShelf` only
   * ever considers unvisited boards, so a line runs out of candidates and lands
   * here.
   *
   * Only a *staple* they got none of counts against the shop. A missed
   * nice-to-have is browsing, and a line they got two of three on is the shelf
   * being thin, which `ANNOY_EMPTY_SHELF` already charges for.
   *
   * **Why it failed is worked out here and nowhere else.** Every one of these
   * used to be reported as "you had none", which is a lie in three of the four
   * cases and the most misleading kind: it names a fixable problem that is not
   * the one you have. A shop that is out of milk, a shop whose milk is priced
   * where this shopper won't have it, a shop whose milk costs more than the
   * shopper walked in with, and a shop that has bricked its dairy aisle in are
   * four different mistakes with four different answers, and the log line is the
   * only place any of them is ever going to be said out loud.
   *
   * The tallies split with the message, because `simulate`'s `unmetDemand`
   * verdict reads as a shopping list — "this demand exists and nothing on your
   * shelves answers it" — and price-outs filed under it would have the balance
   * runner telling an agent to order more of something already sat on the shelf.
   */
  failLine(cust, line, c = content()) {
    line.failed = true;
    if (!line.must || line.got > 0) return;

    const had = this.stockedForTag(line.tag, c);
    const spent = cust.basket.reduce((s, b) => s + b.price, 0);
    // Blocked only when they never got to stand at ANY of it. One unreachable
    // shelf among four is a shop with an awkward corner, not a shop with no way
    // through, and reporting it as one would hide the real miss behind it.
    const why = !had ? 'none'
      : (line.blocked > 0 && line.seen === 0) ? 'blocked'
        : (had.price + spent > cust.budget) ? 'budget'
          : 'passed';

    cust.missed.push({ tag: line.tag, why, what: had?.item?.name ?? null, price: had?.price ?? 0 });
    cust.mood = clamp(cust.mood - ANNOY_MISSED_STAPLE, 0, 1);
    // `unmet` keeps its meaning — staples the shop did not stock — so only a
    // genuine stockout goes in it. The rest are shelves you own that did not
    // sell, which is `passed`: a different tally because it is a different job.
    const tally = why === 'none' ? this.stats.unmet : this.stats.passed;
    tally[line.tag] = (tally[line.tag] ?? 0) + 1;
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
      // Reputation does not care WHY. They came in for something and left
      // without it, and a shopper who thought your milk was daylight robbery is
      // no happier than one who found the fridge empty — so the split above is
      // about telling the player what to do, never about softening the blow.
      this.reputation = clamp(
        this.reputation - REP_MISSED_STAPLE * cust.missed.length, 0, 1,
      );
      const name = arch?.name ?? 'customer';
      // One line per KIND of miss rather than per line, so a shopper who struck
      // out on two tags for the same reason reads as one sentence.
      const byWhy = new Map();
      for (const m of cust.missed) byWhy.set(m.why, [...(byWhy.get(m.why) ?? []), m]);
      for (const [why, misses] of byWhy) {
        const tags = misses.map((m) => tagLabel(m.tag)).join(' and ');
        const it = misses[0];
        this.pushLog(
          why === 'none' ? `A ${name} came in for ${tags} and you had none.`
            : why === 'blocked' ? `A ${name} came in for ${tags} and couldn't get to it.`
              : why === 'budget' ? `A ${name} came in for ${tags} and couldn't afford any of it.`
                : `A ${name} came in for ${tags}, looked at your ${it.what} at $${it.price.toFixed(2)} and left it.`,
        );
      }
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
    const open = this.isOpen();
    for (const cust of Object.values(this.customers)) {
      const arch = c.byId.archetypes[cust.archetype_id];
      if (!arch) { this.despawn(cust); continue; }
      if (!open && this.lastOrders(cust)) continue;
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
   * LAST ORDERS. The shop is shut; wind this shopper up.
   *
   * `stepSpawning` has always refused to bring anybody new in after `CLOSE_HOUR`,
   * and that was the whole of "closing" — nothing was ever said to the people
   * already here. So a shopper who was crossing the car park at 19:59 walked in
   * anyway, and the shop went on browsing, taking stock off shelves and *ringing
   * sales through the till* at three in the morning. It shows up in the HUD as a
   * Morning Regular in a shop whose clock is struck through.
   *
   * Three rules, and the split is about who has committed to what:
   *
   *   ENTER  — has not set foot inside. They turn round and go home, which is
   *            what a shut door does. The same argument the layout re-flow makes
   *            about anyone still out on the approach.
   *   QUEUE  — money is already out. You do not throw somebody out of the line
   *   TO_TILL  they are standing in, so these are left entirely alone.
   *   the rest— stop shopping: pay for what is in the basket, or go home.
   *
   * Continuous rather than fired once on the stroke of eight, deliberately.
   * There is no "did we already do this tonight" flag to keep in step with the
   * clock, a shop closed for any other reason later gets the same behaviour
   * free, and the whole thing is idempotent — everyone it touches ends up in a
   * state it does not touch.
   *
   * It does NOT tally their list. `stopShopping` books every unfilled line as
   * demand the shop did not serve, and closing time is not the shop failing to
   * stock something — counting it would drag the department meter down every
   * night for reasons no amount of ordering could fix.
   *
   * @returns true if this shopper has been dealt with and the tick should stop.
   */
  lastOrders(cust) {
    if (cust.state === 'LEAVE' || cust.state === 'TO_TILL' || cust.state === 'QUEUE') return false;

    if (cust.state === 'ENTER') { this.despawn(cust); return true; }

    // Settled without a tally — see above. It also stops `stopShopping` billing
    // the shop for them later if anything else routes them through it.
    cust.settled = true;
    cust.wantHint = null;
    cust.targetShelf = null;
    cust.targetItem = null;
    if (cust.basket.length) this.goToTill(cust, content().byId.archetypes[cust.archetype_id]);
    else this.leaveShop(cust);
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
      shelves: this.layout.shelves.filter((s) => !s.boh),
      items: c.byId.items,
      archetype: arch,
      folded,
      season: this.season,
      reputation: this.reputation,
    }).filter(({ shelf, stack }) => {
      // A BOARD is looked at once, not a unit — see `boardKey`.
      if (cust.visited.includes(this.boardKey(shelf.id, stack.item_id))) return false;
      const inBasket = cust.basket.reduce((s, b) => s + b.price, 0);
      return stack.price + inBasket <= cust.budget;
    });

    if (ranked.length === 0) {
      // Nothing left in the shop they'd take at all — no point walking the rest
      // of the list. Every open staple is a miss, and they leave.
      for (const line of cust.list) if (!line.failed && line.got < line.qty) this.failLine(cust, line, c);
      return this.stopShopping(cust, arch);
    }

    // The two kinds of line part company here.
    //
    // A STAPLE is absolute: it is what they came in for, so if anything on an
    // unvisited board carries the tag that is where they are going, whatever it
    // costs them in conversion. Nothing carrying it is the miss worth counting.
    let target = null;
    let at = -1;
    for (let i = 0; i < cust.list.length; i++) {
      const l = cust.list[i];
      if (l.failed || l.got >= l.qty || !l.must) continue;
      const hit = ranked.find(({ item }) => item.tags.includes(l.tag));
      if (hit) { target = hit; at = i; break; }
      this.failLine(cust, l, c);
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
      // No route to it, so the whole unit is struck off rather than the one
      // board — and the line remembers *why* it lost this candidate. A shelf
      // walled in behind another one is a real thing a player can do and the
      // one miss that is neither a stockout nor a price: without this it would
      // be reported as "looked at your milk and left it", which sends them off
      // to fix a price that was never the problem.
      this.markVisited(cust, target.shelf);
      const line = cust.list[at];
      if (line) line.blocked++;
      cust.state = 'BROWSE';
    }
  }

  takeFromShelf(cust, arch, c, folded) {
    const shelf = this.layout.shelves.find((s) => s.id === cust.targetShelf);
    cust.state = 'BROWSE';
    cust.wantHint = null;

    // The board they came for, not whichever one is first. `targetItem` is
    // missing on a shopper who was already mid-walk when this landed, and on
    // one aimed by an older path — falling back to the only stack keeps them
    // moving rather than freezing them in front of a shelf.
    const stacks = this.shelfStacks(shelf);
    const stack = (cust.targetItem ? this.shelfStack(shelf, cust.targetItem) : null)
      ?? (stacks.length === 1 ? stacks[0] : null);
    // The BOARD is what they have now looked at. Struck off by the id they came
    // for rather than by the stack they found, so a board that sold out from
    // under them still counts as looked at and cannot be walked to twice — and
    // a unit with no stack left at all is struck off whole, since there is
    // nothing on it to come back for.
    if (cust.targetItem) this.markVisited(cust, shelf, cust.targetItem);
    else this.markVisited(cust, shelf);
    // They stood at something for this line, whether or not they bought: which
    // is what stops a price-out being reported as a shelf nobody can reach.
    const errand = cust.list[cust.errandAt] ?? null;
    if (errand) errand.seen++;
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

    // How many they take is how many that line still wants. This used to be a
    // flat MAX_UNITS_PER_SHELF, which existed only because a shelf is visited
    // once and a one-per-shelf basket was capped at the shelf count — the list
    // says "two milks" outright, so the constant retired with it.
    //
    // Each extra unit still passes its own roll and stays inside the budget, so
    // a weak match yields one and a strong one clears the errand.
    // By index, not by tag: a substituted line is being served by something
    // that does not carry its tag, which is the whole point of a substitution.
    const line = errand;

    // A staple is not a sale you have to make — see `stapleChance`. And it is
    // the LINE that decides, not the item: something bought as a substitute for
    // a staple is being taken instead of the thing they came for, so it is
    // browsed for exactly as hard as anything else on the shelf.
    const browse = purchaseChance({
      item, archetype: arch, price: stack.price, folded,
      season: this.season, reputation: this.reputation,
    });
    const chance = line?.must && item.tags.includes(line.tag)
      ? stapleChance(browse) : browse;

    const spent = () => cust.basket.reduce((s, b) => s + b.price, 0);
    const maxRun = Math.min(line ? line.qty - line.got : 1, MAX_UNITS_PER_SHELF, stack.qty);

    for (let n = 0; n < maxRun; n++) {
      if (spent() + stack.price > cust.budget) break;
      if (this.rng.next() >= chance) break;
      stack.qty--;
      // When this board last did its job, which is a different question from
      // `stockedDay` — a board refilled yesterday and untouched since is fresh
      // by that clock and dead by this one. `this.day` and never `this.elapsed`:
      // `elapsed` restarts at zero on load, which is the trap `yieldedAt` and
      // `plantedAt` both had to learn. Read by `staleBoards`.
      //
      // Only a SALE stamps it. `unshelve` also takes stock off a board and must
      // not, or the shop hand clearing a dead board would make it look busy on
      // the way past.
      stack.soldDay = this.day;
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

    // Somebody who drove goes back to the car, and it leaves with them. Their
    // space is held right up until `despawn` for exactly that reason: a car that
    // freed its bay the moment its owner joined the queue is a car park that
    // holds more shopping trips than it holds cars.
    //
    // There is no drive out, and that is a limit rather than a decision. A
    // vehicle needs a lane — `vanRoute`, which is the layout's job and computed
    // once per re-flow — and there is no lane per parking space yet, so the car
    // goes when its driver does. Whoever writes `carRoute` changes this line and
    // nothing else.
    if (cust.parkedAt) {
      this.pathTo(cust, cust.parkedAt);
      return;
    }

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
    spoiled: 0, spoiledValue: 0, harvested: 0, tilled: 0, leftEmpty: 0, turnedAway: 0, byItem: {},
    // How many of today's arrivals drove in. The measurement handle for the car
    // park and the only one there is: the pad's two effects are a bigger basket
    // and a wider town, and both of them show up in the takings as "the shop did
    // better" with nothing anywhere saying how many people it was better for.
    // A share that never moves off the floor when a pad is painted means nobody
    // can reach it; one that sits at `DRIVE_SHARE` of arrivals means the pad is
    // never full and paying for more of it is buying nothing.
    drove: 0,
    // Staples people came in for and you did not stock, by tag. The one number
    // in here that says what to do about itself.
    unmet: {}, impulse: 0,
    // ...and staples you DID stock and still did not sell — they stood at the
    // board and left it, or could not afford it. Split out of `unmet` because
    // the two read as one number and prescribe opposite things: `unmet` is a
    // shopping list, `passed` is a price list, and a shop told to order more
    // milk when the milk is sat there is being sent to make it worse.
    passed: {},
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
 * An hour of the day as a shopkeeper would write it — 8 becomes "08:00".
 *
 * Whole hours only, because the only thing that gets labelled this way is a
 * delivery run and `DELIVERY_RUNS` is whole hours. A run at half past would
 * want minutes here, and that is the moment to widen it rather than now.
 */
const clockLabel = (h) => `${String(Math.floor(h)).padStart(2, '0')}:00`;
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
