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
import { jobBudget, jobsAffordable, foldJobs } from '../../shared/jobs.js';
import { activeModifiers, addModifier, pruneModifiers, clearModifiers } from '../db.js';
import {
  generateLayout, defaultPads, defaultStreet, defaultAwning, buildWalkGrid, isWalkable, carLanes, T,
} from '../layout.js';
import { E, SOLID, edgeBetween, edgeFamily } from '../../shared/edges.js';
import { findPath, followPath } from './pathing.js';
import {
  foldModifiers, modifierMeter, departmentMeter, rankShelves, purchaseChance,
  stapleChance, suggestedPrice, wholesalePrice, footfall, pull, clamp, round2,
} from './economy.js';
import {
  spoilRate, homeKind, desireFor, impulsePull, tagLabel, DEPARTMENTS,
} from '../../shared/tags.js';
import { makeRng } from '../../shared/rng.js';
import { hash01 } from '../../shared/hash.js';
import { hourLabel } from '../../shared/clock.js';
import { R, netRep } from '../../shared/reputation.js';
import { DEFAULT_TIER, tierFixtures } from '../../shared/start.js';
import { difficultyOf } from '../../shared/difficulty.js';
import { makeNamer } from './names.js';
import { stepStaff, syncStaff, breakProgress, carryOf } from './staff.js';
import { checkMilestones, milestoneProgress, milestoneReach } from './goals.js';
import {
  FIXTURES, FIXTURE_KINDS, canPlace, rot4, FIXTURE_REFUND,
  canPlaceEdge, canPlaceEdges, edgeRun, isProp, fixturesOf, insideStore, queueLanes,
  canPaintGround, groundStroke, strokeThick, groundIndex, GROUND_STROKE_MAX,
  GROUND, PAD_KINDS, isGround, groundKindOfTile, padCells, isPadAt, workSpotOf, REACH, spotsOf,
  shelfKind, holdsGoods, isPaint, faceKey, faceRun, canPaintFaces,
} from '../../shared/build.js';
import {
  pieceFor, kindOf, defaultPiece, countKey, boardsOf, fixtureLabel,
} from '../../shared/pieces.js';
import {
  LOT_KINDS, lotStacks, lotTotal, lotQty, lotHas, lotMain, lotRoom,
  lotAdd, lotTake, lotSweep, lotLabel, lotOf,
} from '../../shared/lot.js';
import { modelExtent } from '../../shared/model.js';

/** Real seconds in one in-game day. */
export const DAY_SECONDS = 360;
export const OPEN_HOUR = 8;
export const CLOSE_HOUR = 20;
/**
 * What the clock reads when a world opens, which is not `OPEN_HOUR` any more.
 *
 * `time` is the one clock in the game that is never persisted — every load has
 * always begun at 08:00 sharp, doors down, town already out. A new shop that
 * starts *on* the hour it should be trading is a shop whose first frame gives
 * you nothing to do and no sign you have not done it, which is how three
 * separate new worlds got played for a while with the shutters shut.
 *
 * Beginning before opening is the ritual instead: you turn up, and the day
 * starts when you raise them. Be honest about what it buys, though — the night
 * runs at `NIGHT_SPEED`, so those two hours are about **five real seconds**.
 * It is a frame, not a prep window. The 08:00 line in `step` and the shutter
 * pulse in the HUD are what actually say the shop is shut.
 */
export const PREP_HOUR = 6;
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
 * **Every hour, all day and all night**, and the flat cadence is the point. It
 * began as two runs, at 08:00 and 14:00, and two turned out to be a rule you
 * get caught by rather than one you plan around. Missing the 08:00 by a minute
 * cost five trading hours, and everything ordered overnight arrived on one lorry
 * regardless — so the honest description was "orders land twice", a mechanic
 * about the clock rather than about the shop. In play it read as the game
 * withholding stock: you order pizza at 09:00, you are told 14:00, and there was
 * nothing you could have done differently.
 *
 * Then it was two-hourly while the doors were open and hourly once they shut, on
 * the argument that the trading day is where a wait is a *decision* and the night
 * is dead time. That argument is fine on paper and wrong in the hand: a cadence
 * that changes with the clock is one more thing to hold in your head, and the
 * half it slows down is the half you are actually stood in the shop for. A run
 * you can predict without thinking is worth more than a wait engineered to bite.
 *
 * So the hour is the whole rule, and every derived thing falls out of it: the
 * cutoff is still strict, so ordering at 09:00 exactly puts you on the 10:00 van;
 * the longest anyone ever waits is an hour; and a shop you left short overnight
 * still opens full, which is what an overnight restock is FOR.
 *
 * Measured on a staffed shop over ten seeds when the night first went hourly:
 * shelves-found-empty from 206 to 53 and revenue up 12%. Nothing here trades any
 * of that away — the day only gets faster.
 *
 * Note it is a sweep of the clock rather than a list, so it cannot leave a gap
 * when the trading hours move, and it no longer reads `OPEN_HOUR`/`CLOSE_HOUR`
 * at all: when the van comes stopped being a fact about when you are open.
 */
const DELIVERY_RUNS = Array.from({ length: 24 }, (_, h) => h);

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

/**
 * ...and the same floor for a shopper's car, which is a different number
 * because it is a different thing. A car is quicker than a lorry, and it is the
 * quicker one that spends the least time being a box sliding across your lawn.
 *
 * Both are only reached by a row with no `speed`, which the seeded pair have.
 */
const CAR_SPEED = 4;

/**
 * Is this shopper still in their car — driving in, or driving out?
 *
 * The one predicate step 5 of docs/deliveries.md added, and it exists because
 * **a shopper who has not arrived is not a customer yet**. Four loops walk
 * `this.customers` and every one of them meant "people in my shop" while the
 * only way to be in that object was to be standing in the shop: the crush
 * everybody is fed up with, the crush an arrival balks at, the shop's average
 * mood, and — the one that costs money — the patience budget, which would
 * otherwise start draining at the edge of the map. The further away somebody
 * parked, the crosser they would arrive, and it would present as shoppers
 * storming out of a shop that had done nothing to them.
 *
 * Deliberately not folded in with `ENTER`, which is a person on foot who really
 * has arrived and is walking to the door. The three readers disagree about
 * `ENTER` and `LEAVE` — occupancy counts a leaver and mood does not — and they
 * agree about this, which is why it is one word rather than a fourth list.
 */
const inACar = (cu) => cu.state === 'DRIVE' || cu.state === 'DEPART';

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
const EDGE_COST = {
  [E.WALL]: 12, [E.WINDOW]: 26, [E.DOOR]: 34, [E.GATE]: 8, [E.FENCE]: 4,
  // A sign on a door you already own is not a purchase. Priced identically to
  // the opening it is a rule about, which — with the refit rule in `buildEdge`
  // — is what makes flipping the switch and flipping it back cost nothing.
  // Priced as its own thing, and the way back charges you half a door for
  // changing your mind, twice; a switch that quietly bills you $17 either
  // direction is not a switch.
  [E.DOOR_STAFF]: 34, [E.DOOR_IN]: 34, [E.DOOR_OUT]: 34, [E.GATE_STAFF]: 8,
  // ...and a glazing is a look, so all four are one price. The codebase's own rule
  // about variants, said about an edge: a look must never move a number, or
  // choosing a shopfront is a balance change and `simulate` has to be re-run over
  // a picture. It is also what makes reglazing free — see the refit below.
  [E.WINDOW_FULL]: 26, [E.WINDOW_BAY]: 26, [E.WINDOW_HIGH]: 26,
};
const EDGE_LABEL = {
  [E.WALL]: 'a wall', [E.WINDOW]: 'a window', [E.DOOR]: 'a doorway',
  [E.GATE]: 'a gate', [E.FENCE]: 'a fence',
  [E.DOOR_STAFF]: 'a staff doorway', [E.DOOR_IN]: 'an entrance',
  [E.DOOR_OUT]: 'an exit', [E.GATE_STAFF]: 'a staff gate',
  [E.WINDOW_FULL]: 'a shopfront', [E.WINDOW_BAY]: 'a bay window',
  [E.WINDOW_HIGH]: 'a high window',
};
const PLAYER_SPEED = 4.2;      // tiles/sec
const CUSTOMER_SPEED = 2.2;
// REACH lives in `shared/build.js` now, beside `workSpotOf`, for the same
// reason: the client has to decide whether a press that names a unit is worth
// sending, and a reach spelled twice disagrees exactly at the edge.
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
/**
 * Money is the one thing in the shop that has never needed a gesture, and these
 * two numbers are the whole of what "walking over it" means.
 *
 * `REACH` is 1.6 and a counter is worked from its side, so 1.8 was arm's length
 * from the till and no more — walk past the front of your own counter and the
 * takings stayed on it. 2.5 is "anywhere at the counter", which is what a
 * player means by walking over money.
 *
 * The delay is there so a sale RENDERS: the clerk stands on the till, so with
 * no beat at all the pile is created and swept inside a tick and money simply
 * appears in the total with nothing on screen. That is worth about a second,
 * not three and a half — at 3.5 you stand on your own counter watching cash you
 * are already touching, which reads as needing to do something to it.
 */
const CASH_REACH = 2.5;        // how close you stand to scoop up the till
const CASH_MIN_LIFE = 1.2;     // seconds a pile stays put so you can see it

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
 * size in BAYS — halved from 6 when a bay stopped being one cell and became
 * two, so that a pad of a given painted size is worth what it was worth before
 * the cars were drawn to scale. That is deliberate and it is the whole of the
 * re-tune: the geometry changed, the balance was not meant to.
 */
const DRIVE_SHARE = 0.35;
const PARK_MAX = 4;
const PARK_HALF = 3;

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
 * How many different things one crate holds, and one pair of hands.
 *
 * The cap that makes mixing safe rather than total. Both are `LOT_KINDS` today
 * and are spelled separately anyway, because they answer different questions —
 * how many samples fit legibly in an open-topped box, and how many armfuls a
 * person can keep hold of at once — and the day one of them wants to be a
 * different number, a shared constant is the thing that has to be untangled
 * first. Neither is authored content for the reason `CRATE_UNITS` is not: what
 * a container holds is what a pad's size means.
 */
const CRATE_KINDS = LOT_KINDS;
const CARRY_KINDS = LOT_KINDS;

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
/**
 * Seconds of standing still before an action fires — the default, and what
 * every job that moves goods by hand costs: an armful off a board, an armful
 * out of a crate, stocking, collecting a tray, picking a bed.
 *
 * It was a flat second, and a second is what it had to be while the duration was
 * the whole defence against a walk-past: `REACH` takes about three quarters of
 * one to cross, so anything shorter fired on people going somewhere else, and a
 * pickup nobody asked for fills your hands and then refuses you everything.
 *
 * Neither half of that argument survives. `stepActions` drops the charge for
 * anyone `moving`, so stopping is the consent and the clock is no longer
 * defending anything; and every one of these jobs is *named* by pointing at the
 * thing first, so the ring is confirming a sentence you have already finished
 * rather than guessing at one. What is left for it to buy is the chance to
 * change your mind by walking off, which half a second says as well as a whole
 * one — and a full second of holding still for each of a dozen armfuls is the
 * shop's most repeated gesture charging rent.
 *
 * The floor is the client's `LONG_PRESS_MS` (420ms): a press whose action lands
 * *before* the gesture has been ruled a hold would have its release read as a
 * tap as well, which re-sends the errand it just spent. Nothing held may be
 * quicker than that, which is why the numbers below stop at 0.45.
 */
const ACTION_TIME = 0.5;
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
const ANNOY_CROWD = 1.2;       // per whole multiple of capacity over CROWD_FROM
/**
 * ...and per whole multiple of the floor under boxes, over `MESS_FROM`.
 *
 * Deliberately below `ANNOY_CROWD`: a shop you cannot move through is worse than
 * a shop that needs a tidy, and a mess is also something the player can see and
 * fix in a minute. What it is worth is that clutter stops being free — before
 * this, thirty boxes of rot in an aisle cost the shop precisely nothing, and the
 * only tell was the picture.
 */
const ANNOY_MESS = 0.9;
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
 * WHERE A BAD WEEK STOPS — the level the town's memory of you decays back to,
 * and how much of the gap closes each night.
 *
 * Every other mover of reputation is an event, so until this existed the number
 * only ever went where customers took it, and it had no restoring force at all.
 * That is fine in a shop with shelves, and it is a trap in a new one, because
 * the per-visit arithmetic is negative for a small range whatever the player
 * does: a perfect sale is worth `0.008 * (mood - MOOD_ANNOYED)` — at best
 * +0.004 — while one thing on their list you did not stock is `REP_MISSED_STAPLE`
 * against it, so a shopper who buys two of the three things they came for and
 * leaves delighted is a NET LOSS. A shop with six boards cannot fill a list, so
 * the opening week bleeds by construction.
 *
 * That bleed then locks: `pull` floors at 0.08, so a floored shop gets a
 * trickle of footfall and a trickle is also its only supply of the +0.004s it
 * would need to climb out. Two real saves reached it inside nine days and
 * neither could have played its way back in under a week of flawless trading —
 * which is a game that has stopped being one, with nothing on screen to say
 * why.
 *
 * So the fix is a floor made of *forgetting* rather than a bigger clamp on
 * `pull`, and two things about its shape are the whole of it.
 *
 * It is ONE-SIDED. It pulls up toward `REP_SETTLE` and never down, so a shop
 * above that level does not exist as far as this is concerned — a two-sided
 * drift toward a mean is a cap on the best shops in the game, which is a
 * balance change nobody asked for wearing a bug fix. Every save above 0.35 is
 * byte-identical to what it was.
 *
 * And it does not make bad play free, because it closes a *fraction of the gap*
 * rather than adding a fixed amount: a shop losing 0.1 a day settles where
 * `RATE × (SETTLE − rep)` matches that, which is about 0.13 — still dismal,
 * still the consequence of being dismal, and no longer a hole with no bottom.
 * A shop that has merely had a bad week and stopped having one is back to
 * mediocre in three nights and has to earn everything above that the old way.
 *
 * **Both numbers are the difficulty preset's now** — `repSettle` and
 * `repSettleRate` in `shared/difficulty.js`, read off the save as `this.town`.
 * They are the clearest example of what a difficulty *is* in this game: nothing
 * above changes, the spring is still one-sided and still gated on having
 * traded, and all that moves is how far down a bad month is allowed to go. The
 * gentle preset carries 0.35 / 0.45 — the figures this comment was written
 * about and the ones every existing save reads.
 */

/**
 * How hard the town has to be pulling on a tag before it is a reason somebody
 * left the house — see `rollList`.
 *
 * A `demand_mult` used to be worth two things and neither of them was a
 * shopping list: it made more people come (`pull`) and made each of them keener
 * at the shelf (`purchaseChance`). So a craze the shop was caught out by cost
 * exactly the sales it cost and nothing else — nobody walked in *for* the
 * bakery, so nobody left without it, so `failLine` never charged for it. A shop
 * that missed the whole event and a shop that never had one differ only in the
 * takings, which is the one signal a busy day already hides.
 *
 * 1.5 sits deliberately between the director's two bands: a surge writes
 * 1.8–2.8 on the tag the event is *about* and 1.25–1.6 on the ones it drags
 * along, so the headline of an event promotes and its side effects mostly do
 * not. Under it nothing is promoted at all, which is what keeps an ordinary day
 * — every multiplier 1 — identical to the tick.
 */
const CRAZE_STAPLE = 1.5;

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
/**
 * ...and how long YOUR hands' version of it lasts.
 *
 * A cooldown rather than the hand's forever: Clear and Strip say "not on this
 * board", and the shop reading that as "never stock this again" is a permanent
 * decision taken on your behalf by a tidy-up. Long enough that the crate you
 * just made gets shelved somewhere else or picked up first — which is the whole
 * loop the mark exists to break — and short enough to lapse inside a week.
 */
const HAND_DROP_DAYS = 5;

/**
 * How much longer than its authored life a thing actually keeps.
 *
 * This is not a fudge factor, it is the old behaviour written down. Spoilage
 * ran once a day and stamped whole days, so `shelf_life_days` was never the
 * number the game enforced: an item was given the rest of the day it was put
 * out, and then it lived until the next midnight after its life ran out. Every
 * `shelf_life_days` in the catalog was authored and balance-tuned against that,
 * which makes the generosity part of the content rather than a bug in it.
 *
 * Checking hourly against a fractional stamp is *stricter* — it enforces the
 * authored number exactly — and stricter is a balance change nobody asked for:
 * measured at six times the spoilage and −7.5% mean profit over three seeds, on
 * a change whose entire purpose was that you could watch it happen. So the day
 * the old rule handed out for free is handed out on purpose, and what moved is
 * WHEN you find out rather than how much rots.
 *
 * The one thing to keep straight if you retune it: raising an item's
 * `shelf_life_days` and raising this are not the same lever. That one is "this
 * food keeps longer than that food"; this is "the shop is a day behind noticing"
 * — and it applies to the tin as much as the lettuce, which is why it is flat
 * rather than a multiplier.
 */
const SPOIL_GRACE_DAYS = 1;

/** What share of normal footfall still walks up to a shop that has shut. */
const SHUT_FOOTFALL = 0.5;
/** ...and what share of those take it personally — see `stepShutArrivals`. */
const SHUT_ANGER = 0.35;
/** What one of those costs. Between a turn-away (0.005) and a storm-out (0.03). */
const REP_FOUND_SHUT = 0.012;
/**
 * ...and how long the SHOP's own version lasts, which used to be for ever.
 *
 * Forever was argued from the crate: the goods the hand cleared are standing on
 * a pad, so a mark that lapsed would send somebody to carry the same units back
 * to the same board and start the same four days again — churn on a loop, which
 * reads as a bug in a way "we don't stock that any more" never does.
 *
 * The argument is sound and what it justified was not, because the alternative
 * it was weighed against was never "churn": it was a permanent, compounding
 * change to the shop's range, taken without asking, shown nowhere, and undoable
 * only by a player who already knew the mechanic existed. Seven items went in
 * five days on a real save, every crate of them stranded on the drop-off, and
 * because `padRoom` is what gates the farm and the kitchen the shop then stopped
 * producing too — which is what "the robots just stop" turned out to be.
 *
 * Two things pay off the churn it feared, and both are new here. The crate goes
 * to the BAY rather than the drop-off, so it is out of the production buffer and
 * `homeSupply` counts it — the shop will not buy more of something it is holding
 * a crate of, so the lapse cannot land more stock. And it is on screen the whole
 * time (`Not stocking`, in the supplier), so the state it lapses out of is one
 * you have been able to see and cancel all along.
 *
 * Longer than `HAND_DROP_DAYS` because the shop has more evidence than a
 * tidy-up does: four days of nothing selling is a real signal, and it should
 * outlast the week rather than the afternoon.
 */
const SHOP_DROP_DAYS = 12;

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
/**
 * ...and how many bodies a square of shop FLOOR holds, which is the half that
 * was missing.
 *
 * Capacity was tills and stocked shelves alone, so it measured how much the shop
 * could *serve* and never how much of it there was to stand in. A 7x8 shop and a
 * 30x30 shop with the same fittings were equally roomy, and the only way to make
 * a cramped shop read as cramped was to own fewer tills — backwards, since the
 * fix a player reaches for is to build.
 *
 * Walkable indoor tiles, so shelving takes its own room away: a unit you add
 * gives you half a person of service and costs you a quarter of one in floor,
 * which is the trade-off a real aisle makes.
 */
const CAPACITY_PER_TILE = 0.25;
/** Past this much over capacity, arrivals look in and walk on instead. */
const TURN_AWAY_AT = 1.35;
/**
 * Where the crush starts being FELT, as a share of capacity.
 *
 * Was 1.0 — dead on the top — which left the whole penalty living in the band
 * between full and `TURN_AWAY_AT`, about a quarter of the gauge. A shop at 90%
 * annoyed nobody at all, so the Room bar spent most of its travel saying
 * something that changed no number.
 */
const CROWD_FROM = 0.7;
/**
 * How much of the floor may be under boxes before anybody minds.
 *
 * Not zero, and that is the whole of the number. A working shop always has
 * something on the floor — a delivery being put away, an armful set down, a bed
 * just picked — and charging for the first crate would mean the shop is never
 * *not* being penalised, which makes the term a constant and therefore invisible.
 * A tenth of the floor is a shop mid-job; a third is a shop nobody is tidying.
 */
const MESS_FROM = 0.1;
/**
 * What a packed shop does to your name, per second, per whole multiple over
 * `CROWD_FROM`.
 *
 * Reputation used to move on the crush only once it was bad enough to turn
 * people away at the door. Everything short of that was mood, and mood is
 * per-person and recovers when they leave — so a shop that was permanently
 * uncomfortable had no lasting consequence at all.
 */
const CROWD_REP_RATE = 0.0015;

/** Visibly unhappy below the first, ready to walk out below the second. */
const MOOD_ANNOYED = 0.5;
const MOOD_FUMING = 0.2;

/**
 * What mood somebody walks in on, before the shop is anything to look at.
 *
 * It was 1 — everybody arrived perfectly happy and the only thing that could
 * ever happen to them was worse. That makes the room itself worth nothing:
 * `charm` fed `catchment` and nothing else, so a shop with fourteen awnings and
 * a bare concrete box got exactly the same shoppers once they were through the
 * door, and every pot plant in the game was a bet on *how many* people came
 * rather than on what happened to them.
 *
 * So the walk-in is `MOOD_BASE` and charm buys back the rest of it, on the same
 * saturating curve `charmReach` uses and for the same reason. Two consequences
 * are the point rather than side effects: `stepMood` drains a budget that now
 * starts lower, so an ugly shop has less slack for a queue — and a sale is
 * worth `0.008 * (mood - MOOD_ANNOYED)` in reputation, so an ugly shop earns
 * its name more slowly off the same trade.
 *
 * Above `MOOD_ANNOYED` by a clear margin on purpose. Start it near that line
 * and a new shop's customers arrive already looking cross, which reads as the
 * town hating you rather than as a room nobody has decorated.
 *
 * **And it slides, which is what makes charm maintenance rather than a
 * purchase.** `MOOD_BASE` is what the town expects of a shop that has just
 * opened; `MOOD_FLOOR` is what it expects of one that has been there a year.
 * Decorate once and you are ahead of it for a season and behind it by the
 * following spring, which is the same sentence `TOWN_GROWTH` makes about
 * footfall said about the room — the town grows, and a bigger town is fussier.
 *
 * The floor is deliberately *below* `MOOD_ANNOYED`. Everywhere else in here a
 * number stops short of a threshold; this one is allowed through it, because
 * "people walk into your shop already cross" is exactly what a decade of doing
 * nothing to the place should look like, and it is one planter away from not
 * being true. `TOWN_TAU` is not reused: the town growing and the town's
 * standards rising are two facts that happen to both be about time, and tying
 * them to one constant would make them one fact.
 *
 * **Both ends of the slide are the difficulty preset's now** — `moodBase` and
 * `moodFloor` in `shared/difficulty.js`, read as `this.town` in `moodBase()`.
 * The gentle preset is 0.72 / 0.45, which is what this comment describes and
 * what every existing save reads. `MOOD_TAU` stays a constant on purpose: how
 * fast a town's standards rise is the same fact about towns everywhere, and a
 * preset that moved it too would be saying two things with one button.
 */
const MOOD_TAU = 90;

/**
 * ...and how much of the walk-in mood is what they had HEARD about you.
 *
 * Reputation was a term in `pull` and nowhere else: it decided how many people
 * came and then stopped mattering at the door, so a shop on 42% and a shop on
 * 100% played identically for everyone who did walk in. That is why a slide is
 * survivable in a way it should not be — the money is footfall × basket, the
 * basket never noticed, and a big enough town covers the difference. What you
 * see is the bar going down all week beside seven green columns.
 *
 * At `MOOD_REP` = 0.25, a spotless shop is unchanged and a shop nobody rates
 * walks people in at three quarters of the mood the room earned. That is
 * deliberately the smallest of the three terms in `moodBase`, because this is
 * the one that FEEDS BACK: a sale is worth `0.008 * (mood - MOOD_ANNOYED)`, so
 * a shop losing its name earns it back more slowly, which costs it more name.
 * A loop like that wants to be gentle and it wants a way out, and the way out
 * is the term next to it — charm is measured *before* this scales it, so
 * decorating lifts a shop whose reputation is on the floor. Making the room
 * nicer being the answer to a bad name is the right sentence for a shop.
 */
const MOOD_REP = 0.25;
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
 * Which kit this shopper has on them at this moment, or null for none authored.
 *
 * The same shape `choosePastime` uses — filter by the moment, drop anything
 * weighted to zero, keep what their tags allow, then draw by weight — because
 * two spellings of "pick an authored thing for this person" is two things that
 * drift apart. The draw is the hash above rather than an rng.
 *
 * Asked per snapshot rather than stored on the shopper. It is a filter over a
 * handful of rows, and it buys the thing skins already promise: a bag authored
 * or edited over MCP reaches the people already walking round the shop, instead
 * of only the ones who arrive after it.
 */
const pickKit = (cust, arch, use) => {
  const mine = new Set(arch?.tags ?? []);
  const options = (content().kits ?? [])
    .filter((k) => k.use === use)
    .filter((k) => (k.weight ?? 1) > 0)
    .filter((k) => !k.tags?.length || k.tags.some((t) => mine.has(t)));
  if (!options.length) return null;

  const total = options.reduce((n, k) => n + (k.weight ?? 1), 0);
  let r = hash01(`${cust.id}:${use}`) * total;
  for (const k of options) {
    r -= k.weight ?? 1;
    if (r <= 0) return k;
  }
  return options[options.length - 1];
};

/**
 * How long each held action takes. Everything used to cost a flat second, which
 * made turning soil feel identical to picking a tomato up. Destructive things
 * are deliberately slower — a long ring is the confirmation dialog.
 *
 * The order between them is the part worth keeping: an armful is quicker than a
 * box, a box is quicker than serving somebody, and turning a bed over is the
 * slowest thing in the shop. Only the *scale* came down (see `ACTION_TIME`) —
 * everything that moves goods by hand now sits between 0.45 and 0.65, because
 * those are the actions you make dozens of in a row.
 */
const ACTION_TIMES = {
  till: 1.7,
  stow: 0.45,
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
   * A crate is the box. Still the longest of the goods-handling holds now they
   * have all come down, for the same reason it was: it is the heaviest thing a
   * pair of hands in this game picks up, and the ring is the only weight it has.
   */
  crate: 0.65,
  // What one sale costs the person doing it, before the till's own speed. It
  // was the flat second by omission until a checkout had a ladder worth
  // climbing; naming it is what lets `serveSeconds` divide it.
  serve: 1.0,
};

/**
 * How long it takes to pull a board into a crate — the WHOLE board, whatever
 * is on it.
 *
 * A duration, not a rate, and that is the entire design. The hold used to be
 * one ring and then a crate, which is a second of nothing followed by a result;
 * now the goods cross one at a time across the same second, so what you are
 * watching is the box filling and letting go at half of it leaves you with half
 * the board. That only reads as one gesture if the *time* is the constant: a
 * per-item timer makes a board of twenty take four times as long as a board of
 * five, and then the hold is a chore rather than a decision.
 *
 * So the interval between units is `PULL_SECONDS / n`, worked out once at the
 * start of the pull (see `pullEvery`) and never re-derived — a board that is
 * draining answers a smaller `n` every tick, and a pull that re-read it would
 * accelerate to nothing.
 */
const PULL_SECONDS = 1.0;

/**
 * ...and the floor under that interval, which is one simulation tick.
 *
 * Nothing can be handed over faster than the sim can say it happened. A crate
 * caps the pull at `crateCapacity` units, so at any sane `CRATE_UNITS` this
 * never binds — it is here so that authoring a huge crate makes the pull take
 * longer than a second rather than silently dropping units on the floor.
 */
const PULL_STEP_MIN = 0.05;

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

/**
 * ...and the same backstop on how fast a `speed` upgrade may make you walk.
 *
 * A player who crosses the shop in a frame is through every `REACH` test in the
 * game before the tick that would have fired one, so this is a correctness bound
 * rather than a balance one — see `speedMult`.
 */
const SPEED_CAP = 2.5;

/**
 * What a shop nobody has opened yet starts with.
 *
 * Read off the smallest tier rather than written here, and that is a rule about
 * *counting to one*: `createWorld` writes the chosen tier's counts onto the save
 * before anybody opens it, so this only ever answers for a save that predates
 * tiers — and if the two disagreed, the shop a save described and the shop it
 * opened as would differ by whichever number was edited last. There is one
 * table (`shared/start.js`) and this is a read of it.
 *
 * The freezer went from 0 to 1 the day milk, eggs and soda became chilled
 * goods, and every tier carries at least one for the same reason. Those are the
 * three biggest sellers in the game, and with no freezer to put them in a new
 * shop could not trade its own staples: measured over five seeds it stopped
 * varying at all and sat at a flat loss, which is what a shop that cannot sell
 * anything looks like. A starting freezer is the difference between "buy a
 * cooler early" and "the opening is unwinnable".
 */
const BASE_FIXTURES = tierFixtures(DEFAULT_TIER);

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
 * ...and how much the town grows around a shop that keeps opening, and when.
 *
 * Everything else in `catchment` is a thing you BOUGHT or a thing you EARNED —
 * an address, pot plants, tarmac, a rung of the ladder — and between two of
 * those the number is a flat line. That is what "the town is not progressing"
 * is: on a shop whose reputation has already pinned at 1.0, `pull` is maxed and
 * catchment is the only term left, so a fortnight of good trading with no
 * milestone in it moves nothing at all and the shop stops getting better while
 * getting bigger.
 *
 * This is the world's own term rather than a fifth thing to spend on, and that
 * is what keeps the split in `footfall` intact: restocking, pricing and serving
 * still cannot touch catchment, because a town growing around an established
 * shop is not shopkeeping — it is the same class of fact as `trading()` being
 * the world's hours rather than your shutters.
 *
 * **It saturates, for the reason `charmReach` and `parkReach` do.** A term that
 * climbs for ever is not a town, it is a printing press with a slow fuse — and
 * a curve rather than a step so there is no morning where the shop doubles. Tau
 * is deliberately longer than the early game: +3.9 by the end of week one, +11.5
 * by day 26, +22 by day 100, and the last two of it spread over the year. What
 * that buys is a number that moves every single day you play, which is the half
 * a ladder of occasional rungs can never provide.
 */
const TOWN_GROWTH = 24;
const TOWN_TAU = 40;

/**
 * How long a pause outlives the process that was holding it, in wall-clock ms.
 *
 * The line between "the server restarted under me" and "I paused this and went
 * to bed", and it only has to be long enough for the first — a dev-mode reload
 * is a couple of seconds, a cold `npm run dev` is a few more. Five minutes is
 * generous for that and nowhere near a break, a meal or tomorrow.
 *
 * Erring long is the cheap direction: coming back to a shop that is still
 * stopped costs one press of a button you already know about, while coming back
 * to one that ran without you costs whatever it did in the meantime. Six
 * in-game days, in the case that prompted this.
 */
const PAUSE_HOLDS_FOR = 5 * 60 * 1000;

/**
 * Should a saved pause still be honoured?
 *
 * A stamp from the future reads as false rather than as for ever — a clock
 * moved back, a save copied between machines. The failure it prevents is the
 * one that cannot be pressed away: a shop that will not start whatever you do.
 */
const pauseHolds = (at) => {
  const t = Number(at);
  if (!Number.isFinite(t) || t <= 0) return false;
  const since = Date.now() - t;
  return since >= 0 && since < PAUSE_HOLDS_FOR;
};

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
  // Every fixture kind, counted — rather than the four somebody wrote out. A
  // kind missing from here is a fixture the shop owns and the generator is
  // never told about, which `compose` then drops and refunds on the next
  // re-flow. See the budget map in `server/layout.js`, which had the same bug
  // from the same cause.
  const b = { stations: [] };
  for (const k of FIXTURE_KINDS) if (k !== 'station') b[k] = 0;
  for (const p of placements ?? []) {
    if (p.kind === 'station') b.stations.push(p.station);
    else if (b[p.kind] !== undefined) b[p.kind]++;
  }
  return b;
}

export class Game {
  constructor(state) {
    Object.assign(this, state);
    /**
     * The counter behind every feed line's `id` — see `pushLog`.
     *
     * Carried on from the highest id in the restored log rather than restarted
     * at zero, because the client keys its lines by this: a reload that started
     * counting again would hand a brand-new line the id of one still on screen,
     * and the client would quietly rewrite that one instead of adding it.
     */
    this.logSeq = (this.log ?? []).reduce((n, e) => Math.max(n, e.id ?? 0), 0);
    // Defaulted here as well as in `create`, because a Game can be built from a
    // serialized room too and `removePlayer` writes into this on a path nobody
    // tests: a shop that only ever crashed while somebody was standing in it.
    this.away ??= {};
    this.rng = makeRng(`${this.seed}:${this.day}`);
    /**
     * Who everybody is — and a stream of its own, which is the whole of what
     * makes naming free. `this.rng` is re-seeded every morning and every
     * balance number in the game is downstream of how many times it has been
     * called, so a name drawn out of it would move every crop, basket and spawn
     * roll after it. This one is seeded once, here, and nothing re-seeds it: a
     * namer restarted at each day roll hands out yesterday's names again.
     */
    this.namer = makeNamer(String(this.seed));
    this.nameTheRoster();
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
     * ...and whether the doors have actually been open at any point today.
     *
     * Not the same question as `open`, which is what the shutters say right
     * now. This is what the DAY was, and the only thing that reads it is the
     * board clock — see `holdBoardClocks`.
     *
     * Saved, because the day it is about outlives a reload: a shop shut on
     * Tuesday and restarted on Tuesday afternoon would otherwise roll into
     * Wednesday having forgotten Tuesday was shut. Defaults to `true` on a save
     * that predates it, which is the same reasoning `open` gives one line up —
     * the safe default is the one where nothing changes.
     */
    this.tradedToday = state.tradedToday ?? true;
    /**
     * HOW HARD THE TOWN IS ON THIS SHOP — the difficulty preset, resolved once.
     *
     * `this.difficulty` is the id and rides in the save (`Object.assign` above
     * puts it there, `saveState` writes it back); this is the row it names, and
     * every knob on it is a fact about the *town* rather than about the shop —
     * how long its memory is, how much of it comes anyway, what mood it walks in
     * on. Hence the name: `this.town.repSettle` reads as the sentence it is.
     *
     * Resolved here rather than looked up per read, because it is asked on the
     * spawn path — and resolved from the SAVE rather than from a module
     * constant, which is the co-op case: two worlds open at once under two
     * presets have to tick differently, and a constant would silently give them
     * both whichever was compiled in.
     *
     * A save with nothing to say reads as `relaxed` — the old constants to the
     * digit — so no existing shop moves and no headless game does either. A new
     * shop is written `normal` by `createWorld`, which is a harder game than
     * anyone has played. See `shared/difficulty.js` for why those are two
     * different defaults; it is the same asymmetry `open` and `time` use one
     * screen up.
     */
    this.town = difficultyOf(this.difficulty);
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
     * where the camera is pointing. A save that came back paused a week later
     * would be a shop that looks broken on load with nothing on screen from
     * before you left to say why.
     *
     * **...and "a week later" is the whole of that argument, which is why this
     * is now a stamp rather than nothing.** In memory meant a pause survived
     * exactly as long as the process, and a dev-mode restart is not a player
     * walking away — it is the same person, at the same desk, two seconds later,
     * looking at a shop they stopped. A live save had six in-game days run past
     * a pause that was pressed at 18:00, because the server was restarted to
     * pick up a code change and `paused` came back false. Nothing said a word:
     * an un-pausing shop and a running shop are the same screen.
     *
     * So the pause is saved with the WALL-CLOCK moment it was pressed, and honoured
     * on load only inside `PAUSE_HOLDS_FOR`. Both halves are then true: a restart
     * comes back stopped where you stopped it, and a shop you paused and left is
     * running when you come back to it.
     *
     * Wall clock and NOT `elapsed`, which is the trap this list is full of —
     * `elapsed` restarts at zero on every load, so a stamp against it cannot
     * measure the one thing being asked about here, which is time spent with the
     * game *not running*. `Date.now()` is the right clock precisely because it is
     * the only one that keeps going while the process is dead.
     */
    this.paused = pauseHolds(state.pausedAt);
    this.pausedAt = this.paused ? state.pausedAt : null;
    /**
     * The ladder, and the lifetime tallies it is measured against.
     *
     * Normalised here rather than in `create` because every way into a Game
     * goes past this line — a fresh shop, an old save, a balance run, a
     * restored room — and a milestone list that is `undefined` on one of those
     * paths is a crash in `step` on a shop nobody has opened. See
     * `server/sim/goals.js`.
     *
     * `totals` is the half a save from before this shipped genuinely cannot
     * have: `stats` is wiped nightly and `ledger` is capped at 30 days, so a
     * shop that took $9,000 last month starts this ladder at whatever it takes
     * from today. That is the honest answer and it is why the rows are
     * measurements rather than a stored score — nothing is claimed to have been
     * remembered that never was.
     */
    /**
     * `known` is which rungs this save has ever been *swept against*, and it is
     * what makes a rung that is already true bank quietly instead of throwing a
     * card. It replaces the `opened` boolean, which was the same idea asked once
     * per save rather than once per rung — right until the ladder grew.
     *
     * A shop on day 81 that has already had its opening sweep would otherwise
     * meet a dozen newly-added rungs in one tick and be congratulated a dozen
     * times, back to back, each one stopping the world — which is precisely the
     * bad first impression `opened` was written to prevent, arriving instead on
     * the *second* impression. Per rung, it cannot happen again however many are
     * added later.
     *
     * The fallback is `done`, and that is exact rather than approximate: a save
     * written before this line either knows nothing (no ladder yet — banks
     * everything true, unchanged behaviour) or has been swept against a ladder
     * whose earned rungs are precisely what is in `done`. Rungs it had swept and
     * NOT earned are the one thing lost, and they cost nothing — they are not
     * true, so they cannot bank, and being re-swept awards them properly on the
     * day they come due. See `checkMilestones`.
     */
    this.milestones = {
      done: [...(state.milestones?.done ?? [])],
      known: [...(state.milestones?.known ?? state.milestones?.done ?? [])],
    };
    this.totals = { revenue: 0, sold: 0, harvested: 0, ...(state.totals ?? {}) };
    /**
     * What is waiting to be announced, drained by the room.
     *
     * A queue rather than a callback for the reason the director's headline is
     * one: the sim has no sockets, and two milestones can land in one tick.
     */
    this.milestoneNews = [];
    // `elapsed` at the last sweep of the ladder. Zero means "never", which is
    // right — the first tick of every session checks.
    this._milestoneAt = 0;
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
    // Its divisor, kept beside it for the snapshot. `null` rather than 0 so a
    // world nobody has stepped prints a headcount with nothing after it, which
    // is honest — "0" would say the shop holds nobody.
    this.capacity = null;
    // Measured once a tick beside occupancy. Zero rather than undefined so a
    // shop that has not stepped yet reads as tidy — every sweep that asserts on
    // mood without stepping would otherwise get NaN out of `stepMood`.
    this.mess = 0;
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
     * What each WALL FACE is finished in — `{ [faceKey]: pieceId }`.
     *
     * A map rather than the list `ground` is, and the difference is the key: a
     * cell is named by two numbers that a list can carry as fields, while a face
     * is a line plus a side and every reader wants it by that name. It also
     * makes a repaint an assignment rather than a search, which matters because
     * a drag along the front of a shop repaints thirty of them.
     *
     * Unlike `ground` it takes no part in the re-flow at all: paint stamps no
     * tile, so the generator is never told about it and `regenerateLayout` hangs
     * it on the finished layout. That is the claim `verify:paint` makes, and
     * doing it this way is what makes the claim true rather than tested.
     */
    this.paint = { ...(state.paint ?? {}) };
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
      dropFor: state.orders?.dropFor ?? {},
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
        // An order placed before the journey was recorded has no distance to
        // measure against, and a progress bar with no total reads 0 for ever —
        // a countdown that never counts. Reconstructing it HERE, once, as
        // "however far there is left to go", is what makes it fill from the
        // load onward. Doing the same thing where the snapshot is built would
        // recompute it every tick, which is the same lie with more arithmetic.
        wait: o.wait ?? Math.max(0, arrivesIn ?? 0),
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
      warmers: want.warmer ?? 0,
      bins: want.bin ?? 0,
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

    // Derived before the Game is built so the id counter can clear it. Folded
    // on the way in, because a hire's list is *theirs* — copied off the kind the
    // day they were taken on and edited since — so the fold `content()` does to
    // the authored kinds never reaches it. Once, here, rather than in `jobsOf`
    // at 20Hz: from this point the roster is in today's vocabulary, and the next
    // `persist()` writes it that way.
    const roster = (w.roster ?? rosterFromUpgrades(w))
      .map((e) => ({ ...e, jobs: foldJobs(e.jobs) }));

    const game = new Game({
      worldId,
      seed: String(useSeed),
      /**
       * How hard the town is here — see `this.town` in the constructor.
       *
       * Named explicitly, like everything else in this payload, and that is the
       * trap worth knowing about rather than a style note: this function does
       * NOT spread `w`, so a field added to the save and to `saveState` is
       * still dropped on the way *in* unless it is also written here. It fails
       * in the quietest possible way — the world persists a difficulty, reloads
       * without one, and the constructor's fallback hands back the gentle
       * preset — so a shop set to hard reads as hard in the menu, plays as
       * relaxed, and nothing anywhere disagrees. Caught by a balance run in
       * which all three presets returned byte-identical takings.
       */
      difficulty: w.difficulty,
      day: w.day,
      /**
       * 0..1 through the day, and the one clock that is now READ off the save.
       *
       * It never was: every load opened at 08:00 sharp whatever the shop had
       * been doing, which is why a new world's first frame was the town already
       * out with the shutters down. `createWorld` writes `PREP_HOUR` so a new
       * shop begins before opening — see the note there — and `saveState`
       * writes it from then on, so a restart comes back to the hour it left.
       *
       * The fallback is `OPEN_HOUR` and has to be: an ephemeral game has no
       * save, so every `simulate` run and every `verify:*` sweep still starts
       * mid-morning. Defaulting these to the small hours would put every
       * headless game into the compressed night, where `step` scales world time
       * by `NIGHT_SPEED` and twelve seconds of stepping is seventy-two seconds
       * of shop — `verify:break` caught exactly that, as a hire who got bored
       * in four seconds flat.
       */
      time: w.time ?? OPEN_HOUR / 24,
      season: w.season,
      cash: w.cash,
      reputation: w.reputation,
      // Whether the doors were left open. A save with nothing to say reads as
      // open, so nobody's shop shuts itself the day this shipped — the field is
      // written `false` by `createWorld`, which is where "a new shop starts
      // shut" actually lives.
      open: w.open,
      // ...and when somebody stopped the clock, which is honoured only if it was
      // recent enough to have been a restart rather than a night off. A save
      // from before this field reads as not paused, which is what every shop in
      // the world was. See `pauseHolds`.
      pausedAt: w.pausedAt ?? null,
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
      // Which milestones this shop has already passed, and the lifetime tallies
      // the rest of them are measured against. A save with neither is a shop at
      // the bottom of the ladder, which is what a shop that has never been told
      // about it is — see the constructor.
      milestones: w.milestones ?? {},
      totals: w.totals ?? {},
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
      /**
       * People who are not connected but are still expected back.
       *
       * Keyed by the id in their browser (`who`, client/net.js) rather than by
       * a `sessionId`, which is what makes it survive the thing it is for. A row
       * holds where they stood and what they were holding, is written when they
       * leave, and is CONSUMED when they walk back in — see `addPlayer` for why
       * that consumption is a conservation rule and not housekeeping.
       *
       * It is deliberately not `players` with a flag: every loop in the sim
       * walks `this.players` meaning "a body on the floor", and an absent person
       * with an armful would be counted by the crush, drawn by the renderer and
       * offered a job. That is the `inACar` trap said about shopkeepers.
       */
      away: w.playersAt ?? {},
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
      tradedToday: this.tradedToday,
      lastDirectorDay: this.lastDirectorDay ?? null,
      ownedUpgrades: this.ownedUpgrades,
      ledger: this.ledger,
      demand: this.demand,
      milestones: this.milestones,
      totals: this.totals,
      roster: this.roster,
      nextWorkerId: this.nextWorkerId,
      placements: this.placements,
      nextFixtureId: this.nextFixtureId,
      grow: this.grow,
      doorShift: this.doorShift,
      edits: this.edits,
      ground: this.ground,
      paint: this.paint,
      yardStamped: this.yardStamped,
      awningStamped: this.awningStamped,
      shell: this.shell,
      layout: this.layout,
      layoutVersion: this.layoutVersion,
      players: this.players,
      // ...and the ones who are expected back. A body on the floor and a person
      // the shop is holding a spot for are two different lists on purpose — see
      // `away` in `create`.
      away: this.away,
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
      // What the town is like here, as the preset's id — see `this.town`. In
      // the save rather than derived from anything, for the reason the seed is:
      // it is a fact about this shop that was decided once, and a shop that read
      // its difficulty off whichever build was running would have a ledger that
      // means nothing. Left `undefined` on a save that never had one, which
      // `difficultyOf` reads as the gentle preset — so an old world round-trips
      // through here unchanged rather than being quietly stamped on first save.
      difficulty: this.difficulty,
      day: this.day,
      // ...and the hour, which was the one thing about the day a save never
      // kept. A shop that came back at 08:00 sharp however late you had been
      // working is the same class of thing `pausedAt` fixed: the usual way this
      // world goes down is a restart under somebody who never left. It also
      // makes `PREP_HOUR` land where it is meant to — written once by
      // `createWorld`, and overwritten by the shop's own clock from then on.
      time: this.time,
      cash: this.cash,
      reputation: this.reputation,
      season: this.season,
      // Whether the doors are open, and — as a wall-clock stamp rather than a
      // boolean — whether somebody has stopped the clock. See the two fields in
      // the constructor: one is a fact about the shop and the other is a fact
      // about the person sitting in front of it, which is exactly why the second
      // one goes stale and the first never does.
      open: this.open,
      tradedToday: this.tradedToday,
      pausedAt: this.paused ? this.pausedAt : null,
      lastDirectorDay: this.lastDirectorDay ?? null,
      ownedUpgrades: this.ownedUpgrades,
      // Both are written at the day rollover, *before* this runs — see
      // `onNewDay`. Saved after the day they describe rather than during the day
      // that follows, or a restart loses the day you just finished.
      ledger: this.ledger,
      demand: this.demand,
      // The ladder, and the lifetime tallies underneath it. Written beside
      // `ledger` and for the same reason: `totals` is folded in `onNewDay`
      // immediately before this runs, so a restart keeps the day it has just
      // finished rather than measuring the next milestone against a day that
      // has been thrown away.
      milestones: this.milestones,
      totals: this.totals,
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
      paint: this.paint,
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
      /**
       * ...and the same row for the humans, which is what makes a reload put
       * you back where you were.
       *
       * Both halves of the map, and it has to be both. `away` is who has already
       * left; the second half is everyone still CONNECTED, written as though
       * they had — because the way this shop usually goes down is not a tab
       * closing, it is `node --watch` restarting under a player who never left
       * at all, and `removePlayer` is never called on that path.
       *
       * Keyed by `who`, so a person with no stable id (private mode, a bot) has
       * nothing written for them and comes back at the door — which is what the
       * fallback in `removePlayer` already decided about their hands.
       */
      playersAt: Object.fromEntries([
        ...Object.entries(this.away),
        ...Object.values(this.players)
          .filter((p) => !p.staff && p.who)
          .map((p) => [p.who, {
            who: p.who,
            x: round2(p.x),
            z: round2(p.z),
            facing: p.facing ?? 0,
            carry: p.carry ?? null,
            haul: p.haul ?? null,
          }]),
      ]),
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

  /**
   * What one shopper has on them, and how full it is.
   *
   * Two questions, and only the second one is arithmetic. WHICH kit is
   * `pickKit`; how full it is is the 0..1 every staged model in the game takes
   * — growth for a crop, tier for a fixture, how far through the break for a
   * pastime, load for a van, and this. So a bag that starts flat and bulges as
   * somebody shops is authored art, and nothing here knows what a bag is.
   *
   * Full is measured against `basket_max`, which is what this shopper was ever
   * going to take, rather than against a literal: it is the number the sim
   * already uses to mean "a full shop for them", so a pensioner buying three
   * things carries a full bag and it reads as one. Clamped, because a driver
   * takes home more than they otherwise would and a stage past the last one is
   * an authoring error nobody made.
   *
   * The moment is which side of the till they are on, told the same way the
   * lines above are: `bought` is only ever set by `completeSale`.
   */
  kitOf(cust) {
    const paid = !cust.basket.length && !!cust.bought?.length;
    const arch = content().byId.archetypes[cust.archetype_id];
    const row = pickKit(cust, arch, paid ? 'leaving' : 'shopping');
    if (!row) return null;

    const units = (paid ? cust.bought : cust.basket)?.length ?? 0;
    const cap = Math.max(1, arch?.basket_max ?? 4);
    return { id: row.id, fill: r2(clamp(units / cap, 0, 1)) };
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
      // How much of the floor is under boxes. On the wire because it is a thing
      // the player can fix in a minute and cannot otherwise see the cost of —
      // the picture says "boxes", not "this is costing you patience".
      mess: round2(this.mess ?? 0),
      turnAwayAt: TURN_AWAY_AT,
      // The town, and what share of it you're getting. Sent as the two terms
      // rather than the product because they mean opposite things to a player:
      // catchment is what you buy, pull is what you earn.
      catchment: this.catchment(),
      // ...and how many of them are standing in the shop this second, which is
      // the near end of that same sentence. Not derivable on the client from
      // `occupancy`: that is a ratio against what the building holds, so the
      // same 0.4 is four people or forty.
      inShop: this.customersInside(),
      // ...and what the building holds, which is the OTHER thing that number is
      // out of. The town is the ceiling on how many could ever come; this is
      // the ceiling on how many can be in here at once, and they are different
      // sentences that a single "9 / 51" was quietly inviting you to confuse.
      // A headcount rather than the ratio the sim runs on — see `shopCapacity`.
      room: Number.isFinite(this.capacity) ? Math.round(this.capacity) : null,
      pull: round2(pull({
        reputation: this.reputation, folded: this.folded(), floor: this.town.pullFloor,
      })),
      /**
       * ...and where a bad week bottoms out, which is what makes the reputation
       * bar able to have a colour at all.
       *
       * A gauge's amber has to be a threshold the sim actually acts on rather
       * than a round number — the rule the mood bar states about `MOOD_ANNOYED`
       * and the room bar about `CROWD_FROM`. Reputation had no such line to
       * point at, which is why its bar was one colour at every level: `pull` is
       * reputation, smoothly, so nothing anywhere says "this is now bad".
       *
       * `repSettle` is that line, and it says something sharp: at or below it,
       * the only thing holding the shop up is the town FORGETTING, not anything
       * being sold. A shop parked here is not having a bad week, it is being
       * carried by the floor.
       *
       * On the wire rather than hardcoded on the client because it is the
       * difficulty preset's since step 1 of docs/difficulty.md — a bar that drew
       * red at 30% would be wrong in both directions across two worlds, and the
       * client has no other way to know which game it is in.
       */
      repSettle: this.town.repSettle,
      // The ladder, whole, every tick. It is a few dozen small rows and the panel
      // draws a progress bar off `have`/`need`, so sending the list is what
      // makes progression something you can watch rather than something you are
      // told about once. The client never invents a row — see `goals.js`.
      milestones: milestoneProgress(this),
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
      // Everything today, and the reputation tally rounded on the way past.
      // Not tidiness: `repMoves.crowd` accrues a few ten-thousandths every tick
      // a shop is packed, and the panel's own refresh test is a stringify of
      // this object — so the raw float would re-render the report ten times a
      // second for as long as the shop was busy, which is the one state in
      // which somebody is actually reading it.
      stats: { ...this.stats, repMoves: repMovesOut(this.stats.repMoves) },
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
         * What the shop has stopped stocking by itself, and how long each has
         * left before it comes back.
         *
         * `dropped` and `dropFor` have ridden in this object since the mark
         * existed, by virtue of the spread above, and nothing in `client/` ever
         * read either — which is how a permanent, compounding change to the
         * shop's range came to have no surface anywhere in the game. The panel
         * could derive this from the two maps; it must not, because the lapse
         * is arithmetic against `this.day` and a second copy of it in
         * `sections.js` is how a list starts naming items the sim has already
         * let go of. `droppedItems` is the sim's own answer, and asking it also
         * expires the stale ones.
         *
         * On the snapshot rather than in `ordersOut`, which is where this went
         * first and was wrong: that one feeds `saveState`, so a derived list
         * would be written into the save and read back as fact by a shop whose
         * day had moved on.
         */
        notStocking: this.droppedItems(),
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
          at: hourLabel(o.runHour ?? DELIVERY_RUNS[0]),
          in: r2(Math.max(0, o.arrivesAt - this.elapsed)),
          // ...and how long it was when it set off, so `in` is a *fraction* of
          // something rather than a bare number of seconds. The pair is what
          // the rail's ring is drawn from; neither half is enough alone.
          wait: r2(o.wait ?? 0),
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
        runs: DELIVERY_RUNS.map(hourLabel),
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
        // `carry ?? haul`, because a crate on your shoulder is goods looking for
        // a home exactly as much as an armful is. It read as "the only move is to
        // put it down" for as long as a shelf could only be stocked out of hands
        // — and what that produced was a box of tomatoes and no idea which of
        // seventeen units wanted them, on the one occasion you are carrying the
        // most stock. `stockShelf` takes from the shoulder now, so the chevrons
        // are a promise it can keep.
        // EVERY pile, not `lotMain`. The marker is a promise about a press and a
        // press pours every pile that fits, so naming only the biggest one left
        // the other kinds' units dark and takeable — see `stockTargets`, which
        // carries the argument this line used to make for the other answer.
        takers: !p.staff && (p.carry ?? p.haul)
          ? this.stockTargets(lotStacks(p.carry ?? p.haul).map((s) => s.item_id)) : null,
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
        // WHY they are on one. A charge taken because there was nothing to do
        // and a charge taken because they were worn out are the same picture —
        // a bot in the break room with a mug — and the difference is the whole
        // of what a promoted unit does differently, so the menu has to be able
        // to say it. Without this, promoting somebody and watching them wander
        // off looks like the unit being lazy rather than efficient.
        idleCharge: !!p.idleCharge,
        // ...and whether what they are doing is a job of work rather than a sit
        // down. Sent rather than derived from the pastime row, because the
        // client would otherwise have to know that `spot: 'roam'` means "still
        // working" — a rule about the sim's job list, read off a field that
        // says where something happens. It is what keeps a sweeper's brush
        // turning: everything else on a break stops moving, and `job` says
        // `break` for both.
        chore: !!p.chore,
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
            // Which button winds this — see `actionButton`. Null is a real
            // answer rather than a missing one: a proximity job belongs to
            // neither button, and the pill draws no mouse for it.
            btn: p.action.btn ?? null,
            at: p.action.at ? { x: r2(p.action.at.x), z: r2(p.action.at.z) } : null,
            progress: r2(Math.min(1, p.action.elapsed / (p.action.time || ACTION_TIME))),
          }
          : null,
        // ...and the ones that actually FIRED, as a running count. Sent beside
        // the armed action rather than folded into it, because the whole point
        // is that it outlives it: an action is null on the very tick the thing
        // it was going to do has happened.
        acted: p.acts ? { n: p.acts, kind: p.actKind } : null,
      })),
      // Everybody in the shop — which is not everybody in `this.customers`.
      // Somebody driving in or out is inside the car the line below draws, and
      // sending them too would put a shopper skating along the road with their
      // arms out. `inACar` is the same predicate the crush and the patience
      // budget ask; this is the one place it is about a picture.
      customers: Object.values(this.customers).filter((c) => !inACar(c)).map((c) => ({
        id: c.id, x: r2(c.x), z: r2(c.z), facing: r2(c.facing),
        // Who they are. Sent for the same reason a hire's is: an id is a
        // protocol and a name is a person, and anything the client ever says
        // about a shopper on screen has to call them something.
        name: c.name ?? null,
        color: c.color, state: c.state,
        // What is in their arms, which after the till is what they PAID for —
        // `bought`. Goods that vanished at the counter would read as the sale
        // eating them, and someone walking out with their shopping is the only
        // frame in which a shop looks like it worked. A basket abandoned on the
        // way out leaves both empty, because they put it all back.
        basket: basketGoods(c.basket.length ? c.basket : (c.bought ?? [])),
        // ...and what they are carrying it IN, if anybody has drawn one. The
        // lines above cannot say it: `bought` IS the basket, moved across at
        // the counter, so somebody mid-aisle holding five jars and somebody
        // walking out having paid for five jars sent byte-identical pictures.
        // What changed at the till is not the goods, it is who owns them, and
        // a bag is how that reads from across the shop. Drawn INSTEAD of the
        // armful, so a shop with no kits authored looks exactly as it did.
        kit: this.kitOf(c),
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
        // The boards this unit is KEPT for and has nothing on yet. Same shape a
        // stack has, and deliberately NOT in `stacks`: that list is what is
        // physically on the unit, which is what the renderer draws goods from and
        // what "2 of 3 boards in use" counts. A promised board is neither.
        //
        // It is here rather than worked out from `assigned` on the client because
        // of `cap`: how much of a thing one board holds is the tier multiplied by
        // the boards and divided by how many ways the unit is shared, and that
        // division is enforced by the sim. A second spelling of it is how a menu
        // starts promising 12 on a shelf the stocker fills to 4.
        waiting: (s.assigned ?? [])
          .filter((id) => !this.shelfStack(s, id))
          .map((id) => {
            const item = content().byId.items[id];
            return { item_id: id, qty: 0, cap: item ? this.shelfCapacity(s, item) : 0 };
          }),
        // What it is *for* and where it sits in the restock queue. Both ride the
        // snapshot rather than the layout, because they change while the shop
        // stands still — a menu reading them off the layout would show the shelf
        // you set aside ten seconds ago as still taking anything.
        assigned: s.assigned ?? [], priority: s.priority ?? 0,
        // Whether shoppers can see it, so the menu can say which it is. Two
        // units of the same design differ only by this, and nothing about the
        // model shows it — without it on the wire the button has no state.
        boh: s.boh === true,
        // …and the same is true of the shop hand's switch, which shipped SAVED
        // but never sent: `handRows` reads `live.managed`, so it was always
        // undefined, always resolved to the default, and left "Let them
        // rearrange it" permanently lit with a dead press under it while "Leave
        // it alone" sent, worked, and never moved the highlight. Two dead
        // buttons is what a control with no state on the wire looks like, and it
        // is invisible in the sim — `handMayTouch` reads the layout and was
        // right the whole time.
        managed: s.managed !== false,
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
      // What is on the floor, as a list of piles per box. The renderer stands a
      // sample of each in the crate and the HUD counts them, which is why the
      // old `item_id`/`qty` pair could not simply stay alongside: a client
      // reading the pair would draw a mixed box as whichever kind went in first
      // and count the rest as missing.
      deliveries: this.deliveries.map((d) => ({
        id: d.id,
        x: r2(d.x),
        z: r2(d.z),
        stacks: lotStacks(d),
        // Rubbish, so the renderer can draw it as rubbish. Sent only when true
        // — every crate in every existing shop is stock, and a `false` on all
        // of them is bytes at 10Hz saying nothing.
        ...(d.waste ? { waste: true } : {}),
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
   * That direction is deliberate rather than incidental. A *switch* that could
   * extend the day would be free money with no cost attached — never closing
   * would simply be correct, and a button whose right answer is always "on" is
   * not a decision. Pointed the other way it is one: shutting is something you
   * spend trade on, to rebuild an aisle without shoppers walking through it.
   *
   * The hours can be bought, which is not the same thing and answers that
   * argument rather than ignoring it: a licence is paid for once against
   * everything else the money could have been. See `tradingHours`. The toggle
   * is unchanged — it still only ever takes hours away, whatever the window is.
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
    const { open, close } = this.tradingHours();
    return close - open >= 24 || (h >= open && h < close);
  }

  /**
   * Is it daytime? The world's own hours, which nothing can buy.
   *
   * Split from `trading` the day hours became purchasable, and the split is the
   * whole of what keeps a licence from costing you real time — see `step`. This
   * is what the night compression asks, because the night is compressed for
   * being *dark*, not for the shop being shut. Identical to `trading` for every
   * shop that owns no licence, which is why nothing else moved.
   */
  daylight() {
    const h = this.time * 24;
    return h >= OPEN_HOUR && h < CLOSE_HOUR;
  }

  /**
   * When the town is out, which you can now BUY more of — an `hours` upgrade.
   *
   * The argument against this is in `isOpen` above and it is a good one: a
   * switch that extends the day would be free money with no cost attached, so
   * never closing is simply correct and there is no decision left on it. What
   * answers that is the price. A licence is bought once, against everything else
   * the money could have been, and what it buys is a *thin* stretch of hours —
   * `dayShape` is 0.25 at three in the morning against 2.6 at the evening rush —
   * paid for by whoever is standing at the till through them. That is a
   * decision; a free toggle was not.
   *
   * The window is content, not a boolean. A late licence to 22:00 and a
   * twenty-four-hour one are two rows, and neither is a feature.
   *
   * Widest wins rather than last-bought or a sum: owning two licences must not
   * depend on which order you bought them in, and adding their spans together
   * would make two eight-hour extensions a thirty-two-hour day. Clamped to the
   * clock, and a span of 24 is read as "always" by `trading` rather than as a
   * comparison that is false for exactly one instant at midnight.
   */
  tradingHours() {
    let open = OPEN_HOUR;
    let close = CLOSE_HOUR;
    for (const id of this.ownedUpgrades ?? []) {
      const up = content().byId.upgrades[id];
      if (up?.kind !== 'hours') continue;
      open = Math.min(open, clamp(Number(up.payload?.open ?? OPEN_HOUR), 0, 24));
      close = Math.max(close, clamp(Number(up.payload?.close ?? CLOSE_HOUR), 0, 24));
    }
    return { open, close };
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
   * The log line is the only trace it leaves on screen, and it earns its place
   * because pause is world-wide in a shop two people share: without it the
   * other person's game simply stops with nothing said.
   *
   * It `persist()`s, which is the one thing in here that is not obvious: a
   * paused game does not `step`, so nothing else would ever write the save
   * again — the pause would survive a restart only if something happened to
   * have saved after it, which by construction nothing does. See the field for
   * why it is stamped rather than stored as a boolean.
   */
  setPaused(paused, by = null) {
    const want = !!paused;
    if (want === this.paused) return ok({ paused: this.paused });
    this.paused = want;
    this.pausedAt = want ? Date.now() : null;
    const who = by ? `${by} ` : '';
    this.pushLog(want ? `${who}stopped the clock.` : `${who}started the clock.`);
    this.persist();
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
    // It follows the DARK and not the shutters, and not your licence either —
    // three questions now, where there used to be one. The reason the night is
    // compressed is that the town is asleep, which is a fact about the hour.
    // Hang it on `isOpen` and shutting at noon to re-plan an aisle would fling
    // you through the afternoon at 6×, which is a control that punishes the
    // thing it is for. Hang it on `trading` and buying a 24-hour licence would
    // double how long a day takes in real time — you would sit through twelve
    // dark hours for a tenth of the footfall, which is the licence charging you
    // in the one currency it was never supposed to. So `daylight` is its own
    // predicate against the world's own hours: an unlicensed shop is exactly
    // the game it was, and a licensed one still skips the dark quickly and
    // takes a night's trickle on the way past. Pause is what stops the clock.
    const world = dt * (this.daylight() ? 1 : NIGHT_SPEED);

    this.elapsed += world;
    const prevDay = this.day;

    // Before the roll reads it. One boolean rather than counting hours: what
    // the board clock wants to know is whether this was a day the shop could
    // possibly have sold anything, and a shop open for ten minutes was open.
    if (this.isOpen()) this.tradedToday = true;

    this.time += world / DAY_SECONDS;
    while (this.time >= 1) {
      this.time -= 1;
      this.day++;
    }
    if (this.day !== prevDay) this.onNewDay();

    /**
     * ...and the one line that says the shutters are still down, on the tick the
     * town comes out.
     *
     * A shut shop and a shop nobody has come into yet are the same picture — an
     * empty floor — and the difference between them is the single most
     * consequential state in the game: nothing will ever happen. The clock is
     * struck through and `#hq` wears a chip, and both are marks you have to
     * already know to look for. This fires at the exact moment being shut starts
     * costing something, which is what makes it a line rather than a nag.
     *
     * A transition rather than a state, or it is a line every tick of every
     * morning. And `wasTrading` starts *undefined* rather than false on purpose:
     * a save opened at teatime with the shutters down has not crossed anything,
     * so the first tick of a load never speaks. A new world does, because it
     * begins at `PREP_HOUR` and crosses 08:00 a few seconds later, which is the
     * whole reason the clock starts there.
     */
    const tradingNow = this.trading();
    if (tradingNow && this.wasTrading === false && !this.open) {
      this.pushLog('Trading hours have started and the shutters are still down — press O to open up.');
    }
    this.wasTrading = tradingNow;

    /**
     * ...and rot on the hour, which used to be a midnight event only because
     * that is where the call sat.
     *
     * `onNewDay` still runs it, and deliberately: the roll is where `binOrphans`
     * and the day's accounting happen, and the two have an ordering the note
     * there sets out. This is an *extra* sweep rather than a move, which costs
     * nothing because the whole thing is a threshold on age — it finds things
     * sooner and can never find them twice.
     *
     * The hour is derived rather than counted, so it survives everything that
     * moves the clock without stepping it: a `set_time` jump, a save loaded at
     * teatime, a shut shop skipping the night at 6×. Comparing the derived hour
     * against the last one seen is what makes those all the same case.
     */
    const hourNow = Math.floor(this.day * 24 + this.time * 24);
    if (this.lastSpoilHour !== hourNow) {
      // Not on the very first tick of a load: `lastSpoilHour` is in memory, so a
      // restart would otherwise always sweep, which is harmless but writes a
      // logful of spoilage the moment a save opens rather than while it runs.
      if (this.lastSpoilHour !== undefined) this.spoilStock();
      this.lastSpoilHour = hourNow;
    }

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
    // Once per tick, for `stepMood`'s reason: it is read per customer and the
    // answer is a property of the shop rather than of any of them. Same shape
    // `occupancy` has had since the crush existed.
    this.mess = this.measureMess();
    this.stepCrowdRep(dt);
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
    this.stepMilestones();
  }

  /**
   * Sweep the ladder, about once a second of world time.
   *
   * Every measure is a field read or a `length`, so what is being throttled is
   * the loop rather than the work — and once a second is well inside "the
   * moment it happened" for numbers that move at the speed of a shop. Against
   * `elapsed` rather than a tick count, which is what makes it hold at 10Hz in
   * the room and at 10000× in a balance run.
   *
   * A milestone earned during `simulate` is deliberately real: the bot's shop
   * takes the free stock and the wider town the same way yours does, or the
   * instrument stops modelling the game — the trap CLAUDE.md records about
   * auto-replant. `persist` is already a no-op on an ephemeral game, so nothing
   * a balance run earns is written to the shop it is measuring.
   */
  stepMilestones() {
    if (this.elapsed - this._milestoneAt < 1) return;
    this._milestoneAt = this.elapsed;
    checkMilestones(this);
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
    // Before `spoilStock`, which cannot see any of it: both of its loops open
    // by looking the item up and skipping what they can't find, so an orphan
    // is the one thing in the shop that never rots however long it stands
    // there. Clearing it first also means the boards and bay cells it was
    // holding are free for the rest of the roll to reason about.
    this.binOrphans();
    // ...and before `spoilStock` for the second half of the same reason: a box
    // holding eight crates' worth is eight cells of yard the shop cannot see it
    // has, and every guard below here — and every order placed tomorrow — is
    // measured in cells.
    this.splitOverfull();
    this.spoilStock();
    // Was yesterday a day the shop could have sold anything? Read and reset
    // here, once, and handed to both halves of the board clock: one ages a
    // board with stock on it (`staleBoards`, via the stamps) and one a board at
    // zero (`releaseBoards`, via its own counter), and a day with the shutters
    // down is not evidence for either. See `holdBoardClocks`.
    const traded = this.tradedToday;
    this.tradedToday = false;
    if (!traded) this.holdBoardClocks();
    this.releaseBoards(traded);
    this.payWages();
    // The town forgets a bad week. See `REP_SETTLE` for why this exists at all;
    // three things about where it sits are decisions rather than convenience.
    //
    // Gated on `traded`, for the same reason `holdBoardClocks` is: a day with
    // the shutters down is not evidence about the shop, and ungated this is a
    // week of closing early as the cheapest way back to mediocre. Staying open
    // and wearing the losses is what earns it, which is the behaviour the whole
    // change is trying to make possible again.
    //
    // Before `closeLedger`, so it lands in the finished day's `repMoves` and
    // therefore in that row's `repMove` — the sum-of-causes invariant
    // `closeLedger` rests on holds either side of this, but only here does the
    // week of columns in the Shop report add up to what the bar actually did.
    //
    // And before `persist`, which is the trap: `persist` runs at the rollover
    // and on discrete actions, never on a tick, so a drift applied after it is
    // a night of recovery a restart silently takes back.
    //
    // Both numbers are the difficulty preset's since step 1 of
    // docs/difficulty.md — how long the town's memory is, is exactly the sort of
    // thing a difficulty is. What does NOT vary is the shape: it is one-sided on
    // every preset, so a shop above the settle level is untouched whichever one
    // it is playing. A two-sided drift toward a mean is a cap on the best shops
    // in the game, which would be a balance change wearing a difficulty knob.
    if (traded && this.reputation < this.town.repSettle) {
      this.moveRep(this.town.repSettleRate * (this.town.repSettle - this.reputation), R.SETTLED);
    }
    // Before `persist`, and after the last thing that touches the day's money —
    // `payWages` is it. `spoilStock` runs first and deliberately moves no cash:
    // it prices what it binned into `stats.spoiledValue`, which is a readout of
    // money already spent rather than a second charge for it. File the finished
    // day the other side of the save and a restart drops it.
    this.closeLedger();
    this.rollTotals();
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
      // Where the shop's name finished the day, and how far it moved to get
      // there. Both, because they answer different questions and neither
      // implies the other: 62% is where you stand, and −4 points is what
      // yesterday did to you, which is the one a week of columns can show a
      // shape of. The move is the SUM of the causes rather than a difference
      // of two levels, so it is the same arithmetic the breakdown prints and
      // the two can never disagree — and a day that hit the 0 or 1 clamp
      // reports what actually landed rather than what was asked for.
      rep: round3(this.reputation),
      repMove: round3(netRep(this.stats.repMoves)),
    });
    if (this.ledger.length > LEDGER_DAYS) this.ledger = this.ledger.slice(-LEDGER_DAYS);
  }

  /**
   * THE ONE WAY REPUTATION MOVES.
   *
   * Six places used to write `this.reputation = clamp(this.reputation ± x, 0, 1)`
   * directly, which is correct and tells nobody anything: reputation is the
   * slowest number in the game and the only one with no receipt, so a shop
   * sliding from 70% to 40% over a week had no way at all of saying which of
   * seven mechanics did it. The player's question is never "what is my
   * reputation" — the HUD has always answered that — it is *what is costing me*,
   * and that is a question about causes.
   *
   * So every move goes through here with a name on it, and the tally is a
   * byproduct of the write rather than a second set of books beside it. Adding a
   * seventh way to lose reputation is one call with one new key; forgetting to
   * tally it is not something you can do, because there is nowhere else to
   * write.
   *
   * What is banked is what LANDED, not what was asked for — the clamp is applied
   * first and the difference is the tally. A shop already on the floor at zero
   * reports nothing further lost, which is true: another storm-out cost it
   * nothing it had. Raw here and rounded on the way out (see `snapshot`),
   * because the crowd drain is a few ten-thousandths a tick and a tally rounded
   * as it accumulated would stay at zero for ever.
   */
  moveRep(delta, cause) {
    if (!delta) return 0;
    const before = this.reputation;
    this.reputation = clamp(before + delta, 0, 1);
    const moved = this.reputation - before;
    // `??=` because `stats` arrives by `Object.assign` on a restore, so a
    // payload written before this field existed is a shop whose first sale
    // throws. Everything else in `stats` is a number and forgives a missing
    // one; a map does not.
    this.stats.repMoves ??= {};
    if (moved) this.stats.repMoves[cause] = (this.stats.repMoves[cause] ?? 0) + moved;
    return moved;
  }

  /**
   * Fold the finished day into the shop's lifetime tallies.
   *
   * Three numbers, and only the three the ladder in `goals.js` measures — this
   * is not a second `stats`. Everything else it wants is already a fact about
   * the shop right now (the day, the roster, reputation) and needs no memory at
   * all; these three are the ones `stats` throws away every morning.
   *
   * Beside `closeLedger` and before `persist`, for exactly the reason that one
   * is: filed the other side of the save and a restart loses the day you just
   * finished, which here reads as a milestone quietly moving further away.
   */
  rollTotals() {
    this.totals.revenue = round2(this.totals.revenue + this.stats.revenue);
    this.totals.sold += this.stats.sold;
    this.totals.harvested += this.stats.harvested;
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
      ? `Paid $${total.toFixed(2)} in lease and power — the shop is now in the red.`
      : `Paid $${total.toFixed(2)} in lease and power.`);
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
  /**
   * The date, with the time of day on the end of it.
   *
   * Every freshness clock in the shop is measured in DAYS — `shelf_life_days` is
   * the authored number — and used to be stamped as a whole one, because the
   * only thing that ever read them ran at midnight. So a board put out at 09:00
   * and one put out at 23:00 were the same age all week, and a thing that
   * crossed its life at breakfast sat there looking fine until the clock rolled.
   *
   * A float keeps the unit and adds the precision: 5.5 is lunchtime on day five,
   * `age` is still a count of days, and every comparison against
   * `STALE_BOARD_DAYS` and friends goes on reading the way it always did. An
   * integer stamp from an older save is simply a stack that was put out at
   * midnight, which is the right way for that to be wrong.
   */
  dayNow() { return this.day + this.time; }

  /**
   * Age everything that can go off.
   *
   * **Hourly, not at midnight.** This ran once, in `onNewDay`, which is why a
   * shop full of rot appeared out of nothing as the day turned: nothing decayed
   * while you were watching, and then a tenth of the shop was in the skip. The
   * timing was never a rule about food, it was where the call happened to sit.
   *
   * Two things had to change together and neither works alone. The stamps are
   * fractional now (`dayNow`), or an hourly sweep would read the same integer
   * age twenty-four times and the extra runs would find nothing; and `age` is
   * measured against `dayNow()` rather than `this.day`, or a board stocked at
   * teatime would count that whole day against itself. Rates and lives are
   * untouched — a three-day item still keeps for three days, it just stops
   * keeping at the hour it was put out rather than at the next midnight.
   *
   * It stays idempotent, which is what makes the frequency a free choice: every
   * clause here is a threshold on age, so running it more often finds things
   * sooner and never finds them twice.
   */
  spoilStock() {
    const items = content().byId.items;
    const folded = this.folded();

    /**
     * What binning this much of it just cost, at what replacing it would —
     * and, if the shop owns a skip, where the rubbish actually goes.
     *
     * Spoilage has always been an accounting event: the stack disappears at
     * midnight and a line appears in the log. That is honest about the money
     * and says nothing about the shop, which is the complaint — a tenth of
     * everything the place handles evaporating overnight, invisibly, with the
     * crew standing about doing nothing while it happens.
     *
     * So rot becomes a thing on the floor: a crate marked `waste`, standing
     * where the shelf is, for somebody to carry out. Two rules keep it from
     * being a new mechanic nobody asked for. It only happens **if you own a
     * bin** — a shop without one is the old game to the unit, which is what
     * makes the whole feature opt-in and what stops a shop that has never
     * thought about rubbish filling up with it. And the money is unchanged
     * either way: `spoiledValue` is counted here, at the moment it rots, not
     * when somebody gets round to carrying it out. What is in that crate is
     * worth nothing and is already in the P&L.
     *
     * `waste` rides on the CRATE rather than on the stack, which is the
     * narrower of the two and the one every existing reader can ignore with a
     * single test. A flag per pile would mean `lotAdd` merging good goods into
     * a rotten pile — the mixing rules know about kinds and quantities and
     * would have to learn about a third thing on every path.
     */
    const skip = this.anyBin();
    const bin = (item, qty, at = null) => {
      this.stats.spoiled += qty;
      this.stats.spoiledValue = round2(
        this.stats.spoiledValue + wholesalePrice(item, folded, this.season) * qty,
      );
      if (skip && at) this.dropWaste(item.id, qty, at);
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
        const rate = spoilRate(item, { in: shelfKind(shelf.kind) });
        if (rate <= 0) continue;
        // `keeps_mult` is the tier's contribution: a better freezer keeps for
        // longer than a basic one, whatever is in it.
        const effLife = item.shelf_life_days * this.fixtureStats(shelf).keeps_mult / rate + SPOIL_GRACE_DAYS;
        const age = this.dayNow() - stack.stockedDay;
        if (age > effLife) {
          const lost = stack.qty;
          // The board goes; the reservation stays. Binning a shelf of milk is
          // not a decision to stop selling milk there — leaving `assigned` alone
          // is what sends the stocker back with more of it. Removing the stack
          // rather than zeroing it is what frees the board for something else,
          // and it is why `shelfShares` reads the reservation first: a shop kept
          // for three things must not re-share itself every time one rots.
          this.clearStack(shelf, stack.item_id);
          bin(item, lost, shelf.browseAt ?? shelf);
          this.logGoods('spoil:shelf', {
            post: ' spoiled on the shelf and was binned.',
            goods: [{ item_id: stack.item_id, qty: lost }],
          });
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
      // Pile by pile, not box by box. A mixed crate is three clocks in one
      // container and they run at three different speeds — binning the box
      // because the lettuce in it went off would take the flour with it, which
      // is a conservation hole dressed as a feature working.
      for (const pile of lotStacks(crate)) {
        const item = items[pile.item_id];
        if (!item || !(pile.qty > 0)) continue;
        const rate = spoilRate(item);
        if (rate <= 0) continue;
        const effLife = item.shelf_life_days / rate + SPOIL_GRACE_DAYS;
        // A pile written before this has no stamp of its own and falls back to
        // the box's, which is where the clock used to live; a crate with
        // neither is treated as fresh rather than as infinitely old — a save
        // that binned the whole yard on the first morning after an update is a
        // worse bug than the one being fixed.
        const age = this.dayNow() - (pile.day ?? crate.day ?? this.dayNow());
        if (age <= effLife) continue;
        const lost = pile.qty;
        crate.stacks = lotTake(crate, pile.item_id, lost).lot?.stacks ?? [];
        bin(item, lost, crate);
        this.logGoods('spoil:yard', {
          post: ' spoiled in the yard and was binned.',
          goods: [{ item_id: pile.item_id, qty: lost }],
        });
      }
      // A box with nothing left in it goes, the same way `unload` leaves it.
      if (lotTotal(crate) <= 0) {
        this.deliveries = this.deliveries.filter((d) => d.id !== crate.id);
      }
    }
  }

  /**
   * Goods whose item row no longer exists, cleared out.
   *
   * Content is edited live and `delete_content` is one call, so an item can
   * stop existing while cases of it are standing on a board, sitting in a
   * crate, held in somebody's hands and still on a van. Nothing anywhere
   * caught that: every loop in the sim that touches stock looks the row up and
   * `continue`s when it misses, which is individually right — a lookup that
   * guessed would be worse — and the sum of all that correct forgiveness is
   * goods that can never be sold, shelved, spoiled or shifted, holding a board
   * and a bay cell for ever.
   *
   * It is not hypothetical. `verify:yard` and `verify:kitchen` author test
   * items into whatever content database they are pointed at — usually the
   * live shared one — and a shop that is open while a sweep runs will BUY
   * them, because the tags on them are real and the ordering does exactly what
   * the tag system is for. Shop 2 came out of one with 84 units of
   * `zz-yard-spud` and `zz-kit-bean` parked on a nine-cell bay, `bayRoom` down
   * to 6 out of 108, and no move available anywhere that could shift a single
   * unit. What it reads as is *empty crates*, because `syncPallet` has no
   * model to draw and only the `x12` on the front survives — so the symptom
   * points at the renderer and the cause is a row somebody deleted.
   *
   * ## The day roll, and not the moment the row goes
   *
   * The re-flow already meets this case and deliberately lets it ride
   * (`applyPlacements`), on the argument that somebody tidying the catalog
   * should not have every case of it destroyed a frame later — and a re-flow
   * fires on every wall segment, so that bin would be instant, repeated and
   * unrecoverable. A day is the shop's own unit for settling up, it is where
   * the other bin already lives, and it leaves a full in-game day to put a row
   * back if the deletion was a mistake. So the re-flow goes on forgiving and
   * this collects.
   *
   * ## It moves no money, and cannot even price what it took
   *
   * Spoilage bins without charging and attributes the loss to `spoiledValue`
   * instead. Half of that applies here and half cannot: `wholesalePrice` needs
   * the row, and the row is the thing that has gone. So this is a log line and
   * nothing in the P&L — which is honest, since the money left when the van
   * was paid and is already in `stats.spent`.
   */
  /**
   * Break any crate holding more than a crate back into crates.
   *
   * **Every write path already caps**, and that is the point of this rather than
   * an argument against it. `dropGoods` opens a new box per `crateCapacity()`,
   * `crateBoard` and `harvest` add through `crateLot()`, `dropLot` funnels into
   * `dropGoods`, and every staff put-down goes through `stow`. And a live shop on
   * day 116 still had five boxes holding 22, 29, 52, 70 and **96** units against
   * a cap of twelve — so either something writes `stacks` by a route none of
   * those cover, or they predate the cap and `deliveries` is loaded off the save
   * verbatim (`world()`), which it is. Both answers have the same fix and the
   * data is wrong either way.
   *
   * What it costs is **not** the yard arithmetic, which is the tempting wrong
   * answer: `bayRoom` and `padRoom` add up `lotTotal`, so they count a box of
   * ninety-six as ninety-six and are honest about it. Nor is it the picture —
   * `buildPallet` clamps its sample, so an over-full box draws as a full box.
   *
   * It is that **a crate is a TRIP**, which is the one thing every other rule
   * here rests on. `crateCapacity` is what makes "three crates is three trips"
   * true, and `liftCrate` hands you whatever is in the box: a ninety-six-unit
   * crate is eight trips' worth on one shoulder, in one gesture, past a cap that
   * every other way of filling a box respects. The pile that should have been
   * eight boxes you can peel is one wall you cannot divide.
   *
   * It does **not** call `dropGoods`: that merges into anything within 2.2 tiles
   * first, which is the crate it just came out of. The excess is peeled off and
   * stood on the same tile as boxes of its own, which is what a pile is —
   * `pickPallet` takes them apart by height and `liftCrate` no longer minds
   * which one you aimed at, so a split pile is a thing you can work through
   * rather than a wall.
   *
   * At the day roll beside `binOrphans`, for the same reason: it is a repair
   * rather than a rule, so it belongs where the shop tidies up after itself
   * once, not in the hot loop that would have to keep proving it.
   */
  splitOverfull() {
    const cap = this.crateCapacity();
    if (!(cap > 0)) return 0;
    let split = 0;
    // A snapshot, because the loop pushes onto the list it is walking.
    for (const d of [...this.deliveries]) {
      if (lotTotal(d) <= cap) continue;
      // Down to the brim, biggest pile first — `lotSweep`'s ordering, and for
      // its reason: it levels the box rather than emptying it in arrival order,
      // so what is left is the box a glance would have expected.
      while (lotTotal(d) > cap) {
        const s = lotStacks(d).sort((a, b) => b.qty - a.qty)[0];
        if (!s) break;
        const take = Math.min(s.qty, cap, lotTotal(d) - cap);
        if (!(take > 0)) break;
        d.stacks = lotTake(d, s.item_id, take).lot?.stacks ?? [];
        const box = {
          id: `del-${this.nextDeliveryId++}`,
          stacks: lotOf(s.item_id, take).stacks,
          x: d.x,
          z: d.z,
          // Rubbish stays rubbish. A skip's crate is over-full by exactly the
          // same routes and must not come apart into stock — `stockCrates` and
          // `dropGoods` both refuse to mix the two, and a split that dropped the
          // flag would put rot back in the supply.
          ...(d.waste ? { waste: true } : {}),
        };
        // The pile's own clock rides with it, or half a fortnight-old box comes
        // out of this fresh and the yard stops being under spoilage — which is
        // the dodge `stampPile` exists to close. `s` is the stack object as it
        // was before the take, so its stamp is still on it.
        if (s.day != null) box.stacks[0].day = s.day;
        else this.stampPile(box, s.item_id);
        this.deliveries.push(box);
        split += 1;
      }
    }
    if (split > 0) this.pushLog(`Restacked the yard — ${split} more crate${split === 1 ? '' : 's'}.`);
    return split;
  }

  binOrphans() {
    const items = content().byId.items;
    const gone = (id) => !!id && !items[id];

    let binned = 0;
    const names = new Set();
    const bin = (id, qty) => { binned += qty ?? 0; names.add(id); };

    // A board, and the reservation that holds one. The stack is goods and the
    // reservation is only a label, but both occupy a board — a unit set aside
    // for something that does not exist is a board nothing can ever land on,
    // which is the same clog wearing no stock. `applyPlacements` already drops
    // those on a re-flow; a shop that has not bought anything lately never
    // re-flows.
    for (const shelf of this.layout.shelves) {
      for (const stack of [...this.shelfStacks(shelf)]) {
        if (!gone(stack.item_id)) continue;
        bin(stack.item_id, stack.qty);
        this.clearStack(shelf, stack.item_id);
      }
      const kept = toList(shelf.assigned);
      if (kept.some(gone)) shelf.assigned = kept.filter((id) => !gone(id));
    }

    // Pile by pile and never box by box, for `spoilStock`'s reason: a mixed
    // crate holding one dead kind beside two live ones must lose the one.
    for (const crate of [...this.deliveries]) {
      for (const pile of lotStacks(crate)) {
        if (!gone(pile.item_id)) continue;
        bin(pile.item_id, pile.qty);
        crate.stacks = lotTake(crate, pile.item_id, pile.qty).lot?.stacks ?? [];
      }
      if (lotTotal(crate) <= 0) {
        this.deliveries = this.deliveries.filter((d) => d.id !== crate.id);
      }
    }

    // Hands and shoulders, separately, for the reason `haul` is its own field
    // rather than a flag on `carry`: every ordinary reader asks about one of
    // them, and an accounting sweep that learned only about `carry` is the
    // silent conservation hole CLAUDE.md records against `removePlayer` and
    // firing. Staff are in `this.players` too, and a hire can be stood holding
    // an armful of it at the moment the day turns.
    for (const p of Object.values(this.players)) {
      for (const hold of ['carry', 'haul']) {
        for (const s of lotStacks(p[hold])) {
          if (!gone(s.item_id)) continue;
          bin(s.item_id, s.qty);
          p[hold] = lotTake(p[hold], s.item_id, s.qty).lot;
        }
      }
    }

    // A hopper and a finished tray. A batch already underway is left alone —
    // its ingredients are spent, and whatever it produces lands in `output`
    // for tomorrow's sweep to take if that has gone too.
    for (const st of this.layout.stations ?? []) {
      for (const [itemId, n] of Object.entries(st.contents ?? {})) {
        if (!gone(itemId)) continue;
        bin(itemId, n);
        delete st.contents[itemId];
      }
      if (st.output && gone(st.output.item_id)) {
        bin(st.output.item_id, st.output.qty);
        st.output = null;
      }
    }

    // ...and what is still on its way, or the van lands another crate of it
    // tomorrow and this whole sweep is a treadmill. It is also the half that
    // gives the bay back today rather than at the next run: `bayRoom` counts
    // orders in flight as well as crates standing there, which is what stops
    // six orders placed in one tick all passing a check against an empty pad.
    if (this.orders.pending.some((o) => gone(o.item_id))) {
      for (const o of this.orders.pending) if (gone(o.item_id)) bin(o.item_id, o.qty);
      this.orders.pending = this.orders.pending.filter((o) => !gone(o.item_id));
    }

    if (!binned) return;
    // The ids, because there is no name left to print — the row that held it
    // is exactly what has gone. Three of them and a count, the way the van's
    // line refuses to say six things six times.
    const list = [...names];
    const said = list.slice(0, 3).join(', ')
      + (list.length > 3 ? ` and ${list.length - 3} more` : '');
    this.pushLog(`Binned ${binned} units of ${said} — not in the catalogue any more, so nothing could shelve or sell it.`);
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
      if (moving(p)) {
        // A pull you walked away from is finished, and walking away is also the
        // only thing that ends a REPEATING errand from the outside — it outlives
        // its own units on purpose (see `errandAction`), so without this it
        // would still be armed when you came back to that shelf for something
        // else, and the next press would take goods off it rather than the job
        // you had in mind. Only once it has actually fired: an errand you are
        // still walking towards is the ordinary case and must survive the walk.
        if (p.action?.took) p.errand = null;
        this.endPull(p);
        p.action = null; p.actionBlocked = null; continue;
      }

      const candidate = this.actionFor(p);

      // Nothing in range, or the target changed out from under us. Either way
      // the charge starts again from zero next time — walking off mid-ring is
      // how you decline, so it must never bank.
      if (!candidate) { this.endPull(p); p.action = null; continue; }

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
      // Every pile, not the first one. The latch exists so a refusal that will
      // keep refusing stops re-arming, and it lifts when your hands change —
      // so a key naming one kind would leave the ring winding and failing after
      // you had put down the very thing it was refusing you for.
      const held = lotStacks(p.carry).map((s) => `${s.item_id}:${s.qty}`).sort().join(',');
      const stop = p.actionBlocked;
      if (stop && stop.kind === candidate.kind
          && stop.target === candidate.target && stop.held === held) {
        this.endPull(p);
        p.action = null;
        continue;
      }
      if (!p.action || p.action.kind !== candidate.kind || p.action.target !== candidate.target) {
        this.endPull(p);
        p.action = { ...candidate, elapsed: 0 };
      }

      // Which finger, said every tick rather than stamped when the action armed.
      // `p.action` is spread once and then lives for the whole gesture — a pull
      // spans ticks on purpose — so a button worked out up there would answer
      // for the errand that armed it rather than the one standing now.
      p.action.btn = this.actionButton(p);

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
      //
      // ...unless the candidate says it does not need one (`auto`). One thing
      // does: the ripe bed under your own feet. The button is what says "this
      // one, and yes" for a job proximity could only guess at, and standing on
      // a plot answers the first half exactly — so all the press is buying
      // there is six of them per field. It is a per-action opt-in rather than
      // a mode, because everything else in this list still needs both halves.
      if (!p.pressing && !p.action.auto) { this.endPull(p); p.action.elapsed = 0; continue; }

      p.action.elapsed += dt;
      if (p.action.elapsed < (p.action.time || ACTION_TIME)) continue;

      const res = candidate.run();
      // It happened. A counter rather than a flag, because the reader is a
      // SOUND and a flag cannot say "again" — a pull turning over twice a second
      // is two units and has to be two noises.
      //
      // This exists because the client was inferring it, and the way it inferred
      // it was a guess with a constant in it: an action that leaves the snapshot
      // has either completed or been abandoned, those look identical one frame
      // later, so `DONE_AT` called anything past 60% a completion. Walking away
      // is how you decline in this game — which means declining LATE played the
      // sound of having done it, with nothing else on screen to contradict it.
      // What that reads as is the shop doing something and then not doing it.
      // Nobody can tell a sound from a bug at that point.
      if (res?.ok) { p.acts = (p.acts ?? 0) + 1; p.actKind = candidate.kind; }
      // A verb is allowed to take the action out from under us — selling the
      // fixture it was aimed at does, and so does a rummage that spends the
      // errand the press had armed. Nothing to tally and nothing to repeat.
      if (p.action) p.action.took = (p.action.took ?? 0) + (res?.took ?? 0);
      // A repeating job goes round again rather than ending: the charge starts
      // from zero, the button is still down, and the next turn of it is the
      // next unit. It stops when the thing it is pulling from says there is no
      // more to have (`more`), when it refuses, or when you let go — which is
      // the one that makes it a decision instead of a duration.
      //
      // Only the CLOCK is reset. `p.action` is the pull — it was spread from
      // the candidate on the tick this armed and it stays that object for the
      // life of the gesture — so its `time` is the interval worked out against
      // the board as it stood at the start (`pullEvery`). Taking the fresh
      // candidate's instead would re-derive it against a board that is draining
      // and the crate would fill faster and faster as it went.
      if (p.action && candidate.repeat && res?.ok && res.more) {
        p.actionBlocked = null;
        p.action.elapsed = 0;
        continue;
      }
      this.endPull(p);
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
   * Say what a repeating action came to, once, and forget the tally.
   *
   * A pull is ONE thing you did however many times the ring went round, and the
   * log is a feed of things that happened in the shop — "Took 1x Bread off the
   * shelf" six times over is the same event told six times, and it would push
   * everything else off the end. So the units are silent (`say: false`) and the
   * total is said here, at whichever of the four ends the gesture found: the
   * board ran out, your hands filled, you let go, or you walked off.
   *
   * A no-op for everything else, because `took` is only ever set by the repeat
   * branch above — which is why it can be called flatly at every place the
   * action is dropped rather than only at the ones that could be a pull.
   */
  endPull(p) {
    const a = p.action;
    if (!a?.took) return;
    a.done?.(a.took);
    a.took = 0;
  }

  /**
   * Is a repeating action part-way through?
   *
   * Both halves matter. `repeat` alone is any board you are stood at with the
   * offer showing, which the pointer is still entitled to change its mind
   * about; `took` is what says the gesture has *started* — goods have moved,
   * and the thing that moved them is a button somebody is still holding down.
   *
   * It exists because a pull is the first job in the game that spans ticks
   * while your hands change, and two verbs driven by the POINTER (`aimAt`,
   * `clearAim`) were written on the assumption that nothing does: they say
   * where an armful should GO, which becomes a live question the moment the
   * first unit lands. Cleared by `endPull`, so letting go hands the offer back.
   */
  pulling(p) {
    return !!p.action?.repeat && !!p.action.took;
  }

  /**
   * The shopper waiting at the counter you are standing at, as a job.
   *
   * Serving fires on its own, and of everything in this file it is the clearest
   * case for it. There is no ambiguity to resolve — a till with somebody at it
   * is one till and one job, which is why serving never left proximity when the
   * pickups did — and the press was buying nothing: you walked to the counter
   * *because* of the queue, and then held a button once per customer to do the
   * thing you had walked over to do.
   *
   * What still ends it is what has always ended it: `moving`. Stepping away from
   * the counter stops serving mid-ring, and there is no partial charge anywhere
   * in this game. The duration is untouched at `serveSeconds` — that is a
   * throughput number the checkout ladder divides, not a gesture.
   *
   * Its own function because `actionFor` asks it twice: once for the ordinary
   * shop floor, where it is the first thing proximity may offer, and once for
   * build mode, where it is the *only* thing. Written out in both places it
   * would be two tills serving at two speeds, which is the split that made the
   * self-firing bed the path nobody took.
   */
  serveCandidate(p) {
    const till = this.nearest(this.layout.checkouts, p, 2.2);
    if (!till?.queue?.length) return null;
    if (!till.queue.some((id) => this.customers[id]?.state === 'QUEUE')) return null;
    return {
      kind: 'serve', target: till.id, label: 'Serve', time: this.serveSeconds(till), at: till,
      auto: true,
      run: () => this.serve(p.id, till.id),
    };
  }

  /**
   * "Not while you're building" — the refusal every goods verb owes.
   *
   * `actionFor` has suspended the ordinary jobs in build mode since the mode
   * existed, and that is the whole story for anything the RING fires. What it
   * never covered is the half that arrives as its own message: a tap on a crate,
   * a tap on one board of a shelf, a tap on an appliance, and naming a square as
   * somewhere to set an armful down. Those are the gestures the POINTER owns,
   * and the pointer is exactly what build mode has taken over — so a press aimed
   * at a wall was quietly lifting a crate off the bay, which reads as the shop
   * handing you goods you never asked for in the middle of a build.
   *
   * It refuses out loud rather than declining silently, and that is the point of
   * it living here instead of being one more `paletteArmed` test on the client.
   * The client can only choose not to send; the shop can say *why*, and "exit
   * build mode" is a thing you do rather than a thing you guess at. Same
   * argument `actionAt` makes about a named job that cannot be done — you
   * pointed at that crate, so you are owed an answer about that crate.
   *
   * Serving is not in the list and cannot be: see `actionFor` for why one till
   * with somebody stood at it is the single exception the mode allows. Nor is
   * money on the counter, which is walked over rather than pressed
   * (`stepCashPickup`), and which nobody has ever wanted to decline. Those two
   * are the whole of what a shopkeeper may still do with a wall half up.
   *
   * Staff never trip it — a hire has no `build` — so the shared verbs
   * underneath (`unshelve`, `stockShelf`, `liftCrate`) are deliberately left
   * alone. Guarding the entry points is what keeps this a rule about the player
   * and their pointer rather than a rule about goods.
   */
  notWhileBuilding(p) {
    return p?.build?.on ? err('Exit build mode first') : null;
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
    //
    // Serving is the exception, and it is the only one there can be. Every
    // reason build mode suspends the rest is a reason about the POINTER — which
    // of three shelves you meant, an armful landing on the wrong one — and a
    // shopper waiting at your till is none of it: one till, one job, no aim, no
    // press, nothing of yours moving in or out of your hands. What it costs to
    // leave out is a customer standing at the counter while you put up a wall,
    // waiting for you to find the button that turns building off.
    if (p.build?.on) return this.serveCandidate(p);

    // What you *asked for* outranks everything standing here would offer, and
    // it is the only entry in this list that is not a guess about what you
    // meant. See `errandAction`.
    const named = this.errandAction(p);
    if (named) return named;

    const serve = this.serveCandidate(p);
    if (serve) return serve;

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
    // Sowing is not here. A seed is a purchase, and a purchase you did not
    // choose is one you keep making — stand at a bed, pay, walk to the next
    // bed, pay.
    //
    // Harvesting is, and it is the one job that has come back off a tap. Both
    // objections that took it away are answered.
    //
    // "Picking fills your hands, and full hands refuse you everything else"
    // stopped being true when the surplus started landing in a crate (see
    // `harvest`): a ripe bed can no longer put you in a state it then leaves
    // you stuck in, which is the whole reason a goods job was unsafe to fire
    // on its own.
    //
    // "Which one did you mean" — the reason every goods job left proximity —
    // has an answer here that an aisle of shelves does not have: the bed you
    // are STANDING ON. A plot is the ground rather than a thing standing on
    // it, so its own tile is a target exactly one bed can claim, where
    // `nearest` in a block of six beds is a question about where your feet
    // happened to stop. Deliberately not `near()`: reaching one bed from the
    // next one over is the ambiguous case, and this is the unambiguous half.
    //
    // `auto` is the rest of what was asked for. A field is six beds and a
    // press each, to do the one thing a farm is for. The other two consents
    // are untouched — `moving` still throws the charge away, so walking across
    // the farm strips nothing, and the ring still winds in full view. Stopping
    // on the bed is the press.
    const under = this.layout.plots.find((q) => q.ready && this.standingOn(p, q));
    // Straight through `actionAt`, which is where a bed's jobs are described —
    // a plot record carries its own `kind`, so it is already the shape that
    // function takes. Writing the candidate out again here is how the two paths
    // to the same bed drift apart, and one of them was already wrong once.
    if (under) return this.actionAt(p, under);
    return null;
  }

  /**
   * Are your feet on this thing's own tile?
   *
   * The precise half of "standing next to it", and the reason a goods job can
   * be back on proximity at all. `near()` is a circle of `REACH`, which on a
   * block of beds on a one-tile pitch always contains two or three — the
   * question that has no answer, and the one that took every pickup off
   * proximity in the first place. A tile has exactly one occupant.
   *
   * Only meaningful for something that IS the ground (a plot, a painted pad).
   * A shelf you cannot stand on would answer no for ever.
   */
  standingOn(p, f) {
    return Math.round(p.x) === f.x && Math.round(p.z) === f.z;
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
  actionAt(p, f, itemId = null, put = false) {
    // The side of it you are NEAREST, which is the marker's position — and with
    // somebody stood at one, the tile under their own feet.
    //
    // It used to be `workSpot(f)` flat: the one anchor, so a shopkeeper standing
    // at the end of a display table got a frame painted on the tile in front of
    // it. That reads as an instruction — go and stand there — and it was never
    // true even before this, because `REACH` reaches round a corner. A marker
    // that tells you to move while the thing is already working is the shop
    // arguing with itself.
    const at = this.spotNearest(p, f);

    if (holdsGoods(f.kind)) {
      // A board named by item is a Take — that is the shelf menu's button, and
      // it outranks stocking so that topping your hands up off a board still
      // works while you are holding some of the same thing.
      if (itemId) {
        const said = content().byId.items[itemId]?.name ?? itemId;
        // A HOLD pulls the whole board into a crate on your shoulder, and you
        // watch it fill — see `crateBoard` and `PULL_SECONDS`.
        //
        // Two things it is answering, and they are one thing really. A board
        // holds more than a pair of hands, so "take it all" only means anything
        // if what it fills is a box — and the box was already the ending, it
        // just arrived all at once at the end of a ring. Metering it (`repeat`)
        // is what turns a duration into a decision: the ring winds again from
        // zero, the errand survives, and letting go halfway is half the board.
        // Nothing got slower — the whole pull is the second the single ring
        // already cost.
        //
        // The count is said ONCE, by `done`: twelve lines of "Took 1x Bread" is
        // one event told twelve times, and it would push the rest of the log
        // off the end.
        return {
          kind: 'take',
          target: f.id,
          label: `Crate the ${said}`,
          time: this.pullEvery(p, f, itemId),
          repeat: true,
          at,
          run: () => this.crateBoard(p.id, f.id, itemId),
          done: (n) => this.logGoods(`crate:${f.id}`, {
            pre: 'Crated ', post: ` off the ${this.fixtureSaid(f)}.`,
            goods: [{ item_id: itemId, qty: n }],
          }),
        };
      }
      if (p.carry) {
        return { kind: 'stock', target: f.id, label: 'Stock', at, run: () => this.stockShelf(p.id, f.id) };
      }
      // ...and a crate on the shoulder pours straight onto the board, which is
      // the job the hires have had since hauling existed (`stockFromCrate`) and
      // the player did not. Without it the only thing a box could do was be put
      // back down: carrying twelve tomatoes to a shelf meant setting the crate
      // on the floor, lifting six out of it, stocking, and picking the box up
      // again — a dance the staff loop was deliberately written to avoid.
      // Whatever will not fit stays on your shoulder, so the next board is the
      // next tap.
      if (p.haul) {
        return { kind: 'stock', target: f.id, label: 'Stock', at, run: () => this.stockFromCrate(p.id, f.id) };
      }
      return null;
    }

    if (f.kind === 'station') {
      // **A machine has two openings, so the direction is said.** Everything
      // else in the shop offers one job per state and can be ordered by what is
      // there; an appliance can be full at both ends at once, and reading the
      // tray first meant a batch waiting in it silently took the right button
      // away — the one button whose entire meaning is putting things in. What
      // that reads as is a machine you cannot feed until you have emptied it,
      // which is not a rule anybody wrote. `put` comes off the errand and the
      // errand comes off `aimAt`, which is the right press and nothing else.
      const load = (from) => ({
        kind: 'load', target: f.id, label: 'Load', at, run: () => this.loadStation(p.id, f.id, { from }),
      });
      if (put && p.carry) return load('carry');
      // ...and out of a crate on your shoulder, which armed nothing at all — so
      // a machine you walked a box of milk over to offered no action, no
      // refusal and no message, and read as a machine that had stopped working.
      // See `loadStation`; the shelves have poured straight out of a crate
      // since hauling existed.
      if (put && p.haul) return load('haul');
      // Collecting when there is anywhere in your hands for what is in the
      // tray. `lotRoom` rather than "am I holding this already", because with
      // three kinds those stopped being the same question: hands holding
      // tomatoes have room for a loaf, and the old test armed nothing.
      if (f.output && lotRoom(p.carry, f.output.item_id, this.carryLot(p)) > 0) {
        return { kind: 'collect', target: f.id, label: 'Collect', at, run: () => this.collectStation(p.id, f.id) };
      }
      // Hands before the shoulder, the way a shelf orders them: an armful is the
      // thing you last picked up, and the crate is still there for the next tap.
      if (p.carry) return load('carry');
      if (p.haul) return load('haul');
      return null;
    }

    if (f.kind === 'bin') {
      // Both hands, and the crate first — a box on the shoulder is the bigger
      // thing to be rid of and the one you walked over here holding. Same
      // ordering `stow` uses, for the same reason.
      if (p.haul) {
        return { kind: 'bin', target: f.id, label: 'Throw away', at, run: () => this.binGoods(p.id, f.id) };
      }
      if (p.carry) {
        return { kind: 'bin', target: f.id, label: 'Throw away', at, run: () => this.binGoods(p.id, f.id) };
      }
      return null;
    }

    if (f.kind === 'plot') {
      if (f.ready) {
        // `auto` is decided HERE as well as in `actionFor`, and forgetting that
        // is a bed that says Harvest and then waits for a press anyway.
        // `errandAction` outranks proximity — that is the whole scheme — so a
        // bed you TAPPED comes back through this function rather than through
        // the standing-on-it branch, and walking to a bed is the ordinary way
        // to end up standing on one. Two paths, one answer: the flag is a fact
        // about where your feet are, not about how the job was named.
        return {
          kind: 'harvest', target: f.id, label: 'Harvest', at, auto: this.standingOn(p, f),
          run: () => this.harvest(p.id, f.id),
        };
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
      // `auto` and the time on both paths, or a till you TAPPED serves at a
      // different speed and still wants a press — the same split that made the
      // self-firing bed the path nobody took. `errandAction` outranks proximity,
      // and walking to a till is how you get to one.
      if (waiting) {
        return {
          kind: 'serve', target: f.id, label: 'Serve', time: this.serveSeconds(f), at, auto: true,
          run: () => this.serve(p.id, f.id),
        };
      }
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

    // A tile you named while holding goods — a crate on your shoulder or an
    // armful in your hands. The only errand whose address is a coordinate: the
    // drop-off above is a *region* and a fixture has an id, and putting goods
    // down on the floor is neither: it is that tile and no other, which is what
    // makes "hold on an empty square" mean somewhere rather than near somewhere.
    if (e.at === 'ground') {
      // Hands empty of both, so whatever you named this tile for is done or
      // gone: somebody unloaded the crate off your shoulder, a shelf took the
      // armful. Nothing to put down is not a refusal.
      if (!p.haul && !p.carry) { p.errand = null; return null; }
      if (Math.hypot(e.x - p.x, e.z - p.z) > UNLOAD_REACH) return null;
      // A box, or an armful — same target, same verb, and the only differences
      // are how long it takes and what the label says. Both end as a crate on
      // that tile, because a crate is the only thing goods on the floor are.
      if (!p.haul) {
        return {
          kind: 'setdown', target: 'ground', label: 'Put it down', time: ACTION_TIMES.stow,
          at: { x: e.x, z: e.z },
          run: () => spend(() => this.dropCarry(p.id, e.x, e.z)),
        };
      }
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
      // **A pile is boxes only**, and that is the rule the whole crate gesture
      // now rests on. Reaching into a buried crate used to be the fallback here,
      // on the argument that it is the one thing you can do to a box under a box
      // — and in the hand it was the opposite: standing at a stack, the common
      // thing you want is the box on top, and what you got was one unit out of
      // whichever band of a dozen pixels the pointer happened to land on. A pile
      // is now peeled rather than rummaged: take the top one off, and the one
      // under it is a crate on its own.
      if (this.crateStacked(crate)) {
        // Whichever box you aimed at, whole — `liftCrate` no longer minds which
        // one of the pile it is. Hands or shoulder already full is nothing to
        // offer rather than a refusal: there is no armful to be had here, so
        // there is nothing to say no to.
        if (p.carry || p.haul) { p.errand = null; return null; }
        return {
          kind: 'lift', target: crate.id, label: 'Pick up crate', time: ACTION_TIMES.crate, at: crate,
          run: () => spend(() => this.liftCrate(p.id, crate.id)),
        };
      }
      // A crate standing on its own keeps both jobs, chosen by the state you are
      // in rather than by a modifier nobody would find — and the choice is the
      // honest one both ways round: you cannot shoulder a box while holding
      // tomatoes, and somebody already holding six of this walked over to top up
      // rather than to pick the box up.
      if (!p.carry && !p.haul) {
        return {
          kind: 'lift', target: crate.id, label: 'Pick up crate', time: ACTION_TIMES.crate, at: crate,
          run: () => spend(() => this.liftCrate(p.id, crate.id)),
        };
      }
      if (p.haul) { p.errand = null; return null; }
      // `e.itemId` is the pile you pointed at, and it is the same field a tap on
      // one board of a shelf already fills in. Naming one takes only that;
      // naming none sweeps the box, which is the trip mixed crates exist for —
      // a reach into three kinds comes out with an armful of all three rather
      // than an armful of whichever the box called itself.
      const only = e.itemId && lotHas(crate, e.itemId) ? e.itemId : null;
      const said = only ? content().byId.items[only]?.name : null;
      return {
        kind: 'unload', target: crate.id, label: said ? `Take ${said}` : 'Take it', at: crate,
        run: () => spend(() => this.unload(p.id, crate.id, Infinity, only)),
      };
    }

    const f = this.findFixture(e.at);
    // Somebody else got there first, a stocker tidied the crate away, or the
    // shelf was sold back. There is nothing left to walk to, so stop pointing.
    if (!f) { p.errand = null; return null; }
    // Any side you could work it from, not the one tile the walk aims at —
    // see `atFixture`. Arriving still lands you on the anchor; standing at the
    // end of a unit is now equally a place the errand fires from.
    if (!this.atFixture(p, f)) return null;

    const act = this.actionAt(p, f, e.itemId, e.put);
    // It offered something when you set off and offers nothing now — the bed
    // was picked, the tray was collected. Not a refusal, just gone.
    if (!act) { p.errand = null; return null; }
    // A repeating job keeps its errand for as long as it is repeating. Spent on
    // the first unit the way every other job spends it, the second one would
    // have nothing left to arm from and a hold would take exactly one — which
    // is the old single-armful gesture wearing a longer ring.
    //
    // "An errand is spent when it fires and nothing re-arms" still holds, and
    // this is the one shape allowed to fire more than once: it only ever fires
    // under a button that is still down, and `stepActions` spends it the moment
    // you walk away from it. Standing there with the button up and pressing
    // again continues the same pull, which is what pressing again means.
    if (act.repeat) {
      return {
        ...act,
        run: () => {
          const res = act.run();
          if (!res?.ok || !res.more) p.errand = null;
          return res;
        },
      };
    }
    return { ...act, run: () => spend(act.run) };
  }

  /**
   * Which button fires the armed action.
   *
   * The prompt names one job and says nothing about the direction it is in,
   * which is the half a mouse cannot show you: a button nobody has pressed yet
   * gives no feedback at all, so "Load" and "Collect" — the two ends of one
   * machine, one per button — were the same sentence twice with nothing to say
   * the difference was which finger you used.
   *
   * READ OFF THE ERRAND rather than guessed from the job, and the errand carries
   * it as its own field rather than reusing `put`. Those look like the same bit
   * and are not: a tap on the drop-off with an armful is a setdown named by the
   * LEFT button (`walkTo`), and `placeAt` names the same kind of target with the
   * right one — so a `put`-shaped test gets the pad exactly backwards, on the one
   * target in the shop that has no id to point at.
   *
   * An errand of *none* is not a missing answer, it is the honest one: a till
   * with somebody at it and the bed under your feet are proximity jobs, and
   * `stepActions` winds them on `p.pressing`, which is one bit that says a
   * button is down and nothing whatever about which. Those get no glyph.
   */
  actionButton(p) {
    const e = p.errand;
    if (!e) return null;
    return e.btn === 'right' ? 'right' : 'left';
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
   * anything you point at, because this is the one case that names a *board*: a
   * shelf holding three things is three piles at one address, and a fixture id
   * cannot say which of them you meant.
   *
   * Two things say it now. The shelf's own menu, one row per board, which is the
   * only thing that can name a board with no stock drawn on it yet; and the
   * pointer, since the goods are drawn as themselves on the boards they are on —
   * `pickFixtureHit` answers which pile the ray met and the tap sends it straight
   * here. Same message either way, which is the point: the choice is made on the
   * client, by whichever instrument is better placed to make it.
   */
  take(playerId, { palletId = null, shelfId = null, itemId = null } = {}) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    const busy = this.notWhileBuilding(p);
    if (busy) return busy;

    const target = palletId
      ? this.deliveries.find((d) => d.id === palletId)
      : this.layout.shelves.find((s) => s.id === shelfId);
    if (!target) return err('nothing there to take');

    // Refused *before* the errand is set, so a shelf behind a wall you have not
    // put a door in yet leaves you where you stand with nothing pending, rather
    // than committed to a walk that never happens.
    //
    // A shelf says where it is worked from and a crate cannot: it is a box on the
    // floor, not furniture, so it has no `browseAt` and routing to it routed you
    // ON TO it — you stood inside the thing you had come to pick up, which reads
    // as the walk having overshot. `beside` is the crate's answer to the same
    // question `browseAt` answers for a shelf, and it is a list rather than a
    // point because any of four sides will do and only some of them may be
    // reachable — a crate against a wall, or one in the middle of a full bay.
    const spots = palletId ? this.beside(p, target) : [target.browseAt ?? target];
    let walk = null;
    for (const s of spots) {
      walk = this.walkTo(playerId, s.x, s.z);
      if (walk.ok) break;
    }
    if (!walk?.ok) return walk ?? err('No way through to there');

    p.errand = { at: palletId ?? shelfId, itemId: palletId ? null : itemId, btn: 'left' };
    return ok({ walking: walk.steps });
  }

  /**
   * Where to stand to work a crate — the tiles around it, nearest first.
   *
   * A crate does not block, so its own tile is walkable and A* was perfectly
   * happy to end the route there. Standing on the box is not wrong by any rule
   * in the sim (reach is satisfied, every verb works) and it looks like a
   * mistake, which is the only test that matters for where a walk stops.
   *
   * Four sides, and which one is decided by where you already are, so the walk
   * stops on the near side rather than crossing the pile to some canonical
   * corner. Three things can rule a side out, and the middle one is the one that
   * is easy to leave out and impossible to see missing:
   *
   * - **the ground.** `isWalkable` is the live walk grid rather than the tile
   *   kind, which is both halves at once: the ground takes a person AND nothing
   *   is standing on it. So a shelf, a till or the wall's own cell is out.
   * - **the line between.** A wall lives on the *edge* between two tiles, so the
   *   cells either side of one are both plain floor and a tile test says the side
   *   is fine. The bay backs onto the shop wall, which is exactly where this
   *   bites: `pathTo` would honour the wall and route you the long way round to a
   *   cell that is next to the crate on the grid and on the far side of a wall
   *   from it — where reach still passes, so you would pick a crate up through
   *   the wall. Same test `canWalk` and `findPath` make (`edgeBetween`/`SOLID`),
   *   because three opinions about one wall is two too many.
   * - **another crate.** Arriving stood on a different box is the same picture
   *   this function exists to stop.
   *
   * The crate's own tile stays on the end of the list, because a box walled into
   * a corner of a full bay must still be reachable — a crate you cannot pick up
   * is worse than one you stand on. Ordered rather than filtered so the caller
   * can walk the list: whether a side can be *got to* is `pathTo`'s answer, and
   * asking it here would be a second pathfinder.
   */
  beside(p, crate) {
    const cx = Math.round(crate.x);
    const cz = Math.round(crate.z);
    const occupied = (x, z) => this.deliveries.some((d) => d.id !== crate.id
      && Math.round(d.x) === x && Math.round(d.z) === z);
    const out = NEIGHBOURS
      .map(([dx, dz]) => ({ x: cx + dx, z: cz + dz }))
      .filter((s) => isWalkable(this.walk, this.layout, s.x, s.z)
        && !SOLID.has(edgeBetween(this.layout, cx, cz, s.x, s.z))
        && !occupied(s.x, s.z))
      .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    out.push({ x: cx, z: cz });
    return out;
  }

  /** Would this shelf take that item right now? */
  shelfAccepts(shelf, itemId) {
    const item = content().byId.items[itemId];
    if (!item) return false;
    // The shop's rule, and it has to be the SAME rule `boardFor` presses to:
    // this lights up where an armful in your hands could go, so a highlight
    // looser than the server is the green-ghost bug and one that is tighter is
    // a shelf refusing a press it would have taken. Written out rather than
    // called as `holds` because `vehicleFor` has a local of that name, and one
    // spelling that is sometimes a different function is worse than two.
    //
    // It was deliberately one-way for two steps — anything that named no
    // fixture could go anywhere, so a freezer lit up for bread. See `holds` in
    // `shared/tags.js` for why that is gone.
    if (homeKind(item) !== shelfKind(shelf.kind)) return false;
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
   *
   * **Every pile, not the biggest one.** It took `lotMain` for as long as this
   * had existed, on the argument that a light on every fixture is the same as no
   * light at all — and that argument is about a shop, while the marker is a
   * promise about a PRESS. One press pours every pile that fits (`pourInto`), so
   * hands holding bread and ice cream are two answers and the freezers are half
   * of them: what you saw was the shelves lit for the bread, no freezer lit at
   * all, and the ice cream going into one perfectly well when you tried it. That
   * is the green-ghost rule inverted — a unit that takes a press it never
   * advertised — and it is the same disagreement `shelfAccepts` exists to close.
   * The dilution the old note feared is bounded by `LOT_KINDS` and by the rule
   * itself: a unit still has to be the right kind, unreserved, and have a board
   * with room, so three kinds in hand is nothing like three times the shop.
   */
  stockTargets(items) {
    const ids = [...new Set((Array.isArray(items) ? items : [items]).filter(Boolean))];
    if (!ids.length) return null;
    return [
      ...this.layout.shelves.filter((s) => ids.some((id) => this.shelfAccepts(s, id))),
      ...(this.layout.stations ?? []).filter((st) => ids.some((id) => this.stationWants(st, id))),
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
    // `lotQty` rather than "is this crate's item the one" — and that swap is
    // the single most dangerous line in the whole mixed-crate change. Read the
    // old way, a box whose SECOND pile is milk answers no, the shop concludes
    // it owns none, and it buys milk it already has, every tick, until the
    // board fills from two directions. Nothing logs it and the sim looks
    // healthy; what you see is the money going. Every counting loop over a
    // container in this file goes through `lotQty` for that reason.
    for (const d of this.stockCrates()) n += lotQty(d, itemId);
    for (const o of this.orders.pending) if (o.item_id === itemId) n += o.qty ?? 0;
    for (const p of Object.values(this.players)) {
      n += lotQty(p.carry, itemId);
      // A crate on somebody's shoulder is stock the shop already owns, exactly
      // as an armful is. Missing it here would have the supplier order twelve
      // more of whatever a hire is halfway across the yard with.
      n += lotQty(p.haul, itemId);
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
   * The unit the shop keeps an item on — one place, not four.
   *
   * Nothing used to answer this, and `shelvesFor` only ever *preferred* the unit
   * an item was already on: full up, the next armful claimed a bare board on the
   * unit next door, and the shop had two homes for one thing for the rest of the
   * save. It compounds rather than settles. Each of those boards is its own line
   * in `restockQueue`, so the shop then buys for both — which is what a shop
   * that has quietly turned into four shelves of produce is looking at, and it
   * reads as the staff being stupid rather than as a rule nobody wrote.
   *
   * Answers `{ floor, back }`, each a Set of unit ids or **null** meaning "no
   * home on that side yet, so any unit there may become one". Null rather than
   * an empty Set on purpose: the two are opposite answers, and a caller that
   * conflated them would refuse the first board an item ever gets.
   *
   * Three things decide it, and each is somebody's decision rather than this
   * function's:
   *
   *   `assigned` — you TICKED it, so every unit you ticked is a home. That is
   *                the override for "I want soda in two aisles", and it is the
   *                same one `staleBoards` and `giveUpBoard` already honour.
   *   the stock  — otherwise the unit already holding the most of it wins, and
   *                the others stop being restocked and drain. Consolidating by
   *                *not filling* needs no job, no walk and no latch; the shop
   *                hand's Merge still walks a live board over when somebody is
   *                employed to.
   *   `boh`      — a stockroom unit backing up what is on the floor is the one
   *                second place that is the point rather than the bug, so each
   *                side is homed separately.
   *
   * Your own hands never read it. `boardFor` and `shelfAccepts` are untouched,
   * which is the line `orders.assign` and `giveUpBoard` already draw: the shop's
   * judgement about its own range was never a rule about what you may do.
   */
  homeShelves(itemId) {
    const out = { floor: null, back: null };
    if (!itemId) return out;
    // ONE walk. This is read from `shelvesFor`, which is read from `unload` once
    // per pile per worker per tick — the note on `shelvesFor` about a helper
    // being allowed to walk the shop exactly once applies here too.
    const floor = { kept: [], holds: [] };
    const back = { kept: [], holds: [] };
    for (const sh of this.layout.shelves) {
      const side = sh.boh === true ? back : floor;
      if (toList(sh.assigned).includes(itemId)) side.kept.push(sh);
      else if (this.shelfStack(sh, itemId)) side.holds.push(sh);
    }
    const pick = (side) => {
      // A reservation beats a holding, and beats it outright rather than joining
      // it — otherwise ticking a shelf for cheese leaves the cheese that is
      // already on the unit next door with a home of its own for ever, and the
      // reservation never fills.
      if (side.kept.length) return new Set(side.kept.map((s) => s.id));
      if (!side.holds.length) return null;
      const best = side.holds.slice().sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)
        || (this.shelfStack(b, itemId)?.qty ?? 0) - (this.shelfStack(a, itemId)?.qty ?? 0)
        || String(a.id).localeCompare(String(b.id)))[0];
      return new Set([best.id]);
    };
    out.floor = pick(floor);
    out.back = pick(back);
    return out;
  }

  /** Is this the unit the shop keeps that item on? */
  homedAt(shelf, itemId, homes = null) {
    const side = (homes ?? this.homeShelves(itemId))[shelf.boh === true ? 'back' : 'floor'];
    return !side || side.has(shelf.id);
  }

  /**
   * ...and is that unit out of room, so the rule has nothing left to bind?
   *
   * `homedAt` is a good rule with one state nobody wrote down: what happens
   * when the home fills up. The answer was "nothing" — goods you already own,
   * standing in a crate, were refused by every other shelf in the shop for as
   * long as the home stayed full. On a real save that was five items at once,
   * every one of them with a dozen legal shelves standing empty, and what you
   * watch is a yard full of crates and a crew stood next to them with nothing
   * to do. Every individual refusal is the shop correctly keeping one thing in
   * one place.
   *
   * The rule exists to stop an item getting two homes and the shop then buying
   * for both (see `homeShelves`). That is a question about the VAN, and it is
   * guarded where the money is spent — `restock` asks `homedAt` itself, in
   * `buy`, and this does not touch it. So the shop still orders for one board
   * only, and goods it has *already paid for* stop being stranded by a rule
   * about what to buy next.
   *
   * It settles rather than spreading, with no new mechanism: `homeShelves`
   * picks the unit holding the MOST, so the home stays the home, and the
   * overflow board drains and is handed back by `releaseBoards` — the same
   * "consolidated by never being chosen again" the split-board fix already
   * relies on.
   *
   * `false` when there is no home at all, because there is then no rule to be
   * out of room: `homedAt` already lets everything through.
   */
  homeFull(itemId, boh, homes = null) {
    const side = (homes ?? this.homeShelves(itemId))[boh === true ? 'back' : 'floor'];
    if (!side) return false;
    const item = content().byId.items[itemId];
    if (!item) return false;
    for (const sh of this.layout.shelves) {
      if (!side.has(sh.id)) continue;
      // Both questions, the way `shelvesFor` asks them: a unit can be out of
      // BOARDS while every board on it has space, and either one is room this
      // item cannot use.
      if (!this.shelfHasRoomFor(sh, itemId)) continue;
      if (this.shelfCapacity(sh, item) - (this.shelfStack(sh, itemId)?.qty ?? 0) > 0) return false;
    }
    return true;
  }

  /** Everything one appliance could take: the inputs of every recipe it knows. */
  applianceInputs(station, into = new Set()) {
    for (const r of this.recipesFor(station.station)) {
      for (const i of r.inputs ?? []) into.add(i.item_id);
    }
    return into;
  }

  /**
   * Which appliances each stockroom unit is the larder FOR.
   *
   * The shop-wide version of this was one set for the whole building, which is
   * right in a shop with one kitchen and wrong the moment there are two: a
   * coffee corner out front and a fryer in the back both wanted their
   * ingredients, so every larder ordered both and each of them kept half a room
   * of stock its own machines could not use. That is the original complaint
   * again at one remove, and it gets worse the more you build.
   *
   * So: **every machine is served by the larder nearest it**, and a larder no
   * machine picked stocks for the machine nearest IT. Both halves are needed and
   * the second is the one that is easy to leave out — without it, a second unit
   * in the same room as the first is chosen by nothing and takes nothing at all,
   * which reads as a shelf that has stopped working rather than as a rule.
   *
   * Straight-line distance, not a walk. `findPath` is the hot loop in the game
   * and this is asked from `shelvesFor`, which is asked per pile per worker per
   * tick; and a route that changes as you build would move a larder's range
   * while a hire was walking to it. The honest cost is a stockroom on the far
   * side of a wall two tiles from the fryer, which is a room you laid out that
   * way.
   *
   * Answers a Map of unit id → the item ids it may hold, or **null** when the
   * question does not arise — no appliances, or no back room. `backRoomTakes`
   * reads that null as yes, which is what keeps a shop with no kitchen exactly
   * the game it was.
   */
  larderRanges() {
    const stations = this.layout.stations ?? [];
    if (!stations.length) return null;
    const backs = this.layout.shelves.filter((s) => s.boh === true);
    if (!backs.length) return null;

    const gap = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
    const nearest = (from, list) => list.reduce(
      (best, c) => (!best || gap(from, c) < gap(from, best) ? c : best), null,
    );

    const out = new Map(backs.map((s) => [s.id, new Set()]));
    for (const st of stations) this.applianceInputs(st, out.get(nearest(st, backs).id));
    for (const sh of backs) {
      const set = out.get(sh.id);
      if (!set.size) this.applianceInputs(nearest(sh, stations), set);
    }
    return out;
  }

  /**
   * Would the shop put this item on that unit?
   *
   * A back-of-house unit is the kitchen's larder and nothing else — the menu
   * that marks one says so, and the code agrees: shoppers cannot see it
   * (`chooseShelf` filters `boh` out, and `stockedForTag` does not count it as
   * having any), and the only thing in the game that ever takes stock back OFF
   * one is the chef. So anything in there that no machine can use is dead the
   * moment it lands: nobody buys it, nobody cooks it, and it holds a board,
   * which is the scarce thing (`staleBoards`).
   *
   * That was the whole of what a stockroom did wrong. `pickItem` chose its range
   * the way it chooses the shop floor's — best margin × who wants it — so a
   * shelf you marked as the back room filled up with whatever sells well out
   * front, and then sat there. What it read as is a stockroom that does not
   * work.
   *
   * An ordinary shelf is not asked, and a shop with **no appliances** is the old
   * game exactly. The rule has nothing to say there, and saying "nothing, then"
   * would leave a back room you cannot stock at all — which is worse than the
   * bug, and it is the order everybody does it in.
   *
   * `ranges` rides in because `larderRanges` walks the shop and this is asked
   * per item: the caller computes it once, the same bargain `homeShelves` and
   * `shelvesFor` already strike.
   *
   * The shop's judgement only. Your own hands never read it, the same line
   * `giveUpBoard` and `orders.assign` draw: you may stand anything you like in
   * your own stockroom.
   */
  backRoomTakes(shelf, itemId, ranges = undefined) {
    if (shelf?.boh !== true) return true;
    const map = ranges === undefined ? this.larderRanges() : ranges;
    const set = map?.get(shelf.id);
    return !set || set.has(itemId);
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
   *
   * ...and `ageing` is a fourth, which is not about the board at all: a day the
   * shutters never went up is not a quiet Tuesday, it is a day the shop was not
   * asked. The spare-board release above still runs — that one is about where
   * an item is KEPT and has nothing to do with trade — so a shut shop still
   * consolidates itself, it just stops retiring its own range. See
   * `holdBoardClocks`, which is the same exception said to `staleBoards`.
   *
   * Defaults to true, so the sweeps and anything calling this by hand get the
   * behaviour they were written against.
   */
  releaseBoards(ageing = true) {
    for (const shelf of this.layout.shelves) {
      const kept = toList(shelf.assigned);
      for (const stack of [...this.shelfStacks(shelf)]) {
        if (stack.qty > 0) { stack.emptyDays = 0; continue; }
        if (kept.includes(stack.item_id)) continue;
        // A bare board on a unit that is kept for OTHER things, which is the
        // same argument as the spare-home case below and reaches it a step
        // earlier: nothing in the shop will ever walk here again, because
        // `shelvesFor` and `boardFor` both refuse this unit for this item. It is
        // `assignShelf`'s cleanup said about the boards that predate it, so a
        // save carrying one heals itself at the next roll rather than printing a
        // board the unit will not honour until the days run out.
        if (kept.length) {
          const name = content().byId.items[stack.item_id]?.name ?? stack.item_id;
          this.clearStack(shelf, stack.item_id);
          this.pushLog(`Gave the ${name} board back — that ${this.fixtureSaid(shelf)} is kept for something else.`);
          continue;
        }
        // A second home, given back the moment it empties rather than after the
        // days — because the days are there for a board that might refill, and
        // this one never will: `shelvesFor` sends the item to its home now, so
        // nothing in the shop is ever walking here again. It has to come BEFORE
        // the supply guard, which is the reason these boards were immortal — a
        // shop with two tomato beds has `homeSupply` above zero for ever, so a
        // spare tomato board could never age a single day.
        if (!this.homedAt(shelf, stack.item_id)) {
          const name = content().byId.items[stack.item_id]?.name ?? stack.item_id;
          this.clearStack(shelf, stack.item_id);
          this.pushLog(`Gave the spare ${name} board back — it is kept on one shelf now.`);
          continue;
        }
        if (this.homeSupply(stack.item_id) > 0) { stack.emptyDays = 0; continue; }
        // Held rather than reset: a shut day is not evidence either way, so the
        // two quiet days a board had already served still count when you open
        // again.
        if (!ageing) continue;
        stack.emptyDays = (stack.emptyDays ?? 0) + 1;
        if (stack.emptyDays < EMPTY_BOARD_DAYS) continue;
        const name = content().byId.items[stack.item_id]?.name ?? stack.item_id;
        this.clearStack(shelf, stack.item_id);
        this.pushLog(`Gave the ${name} board back — empty ${EMPTY_BOARD_DAYS} days with none coming.`);
      }
    }
  }

  /**
   * A day the shop never opened does not age a board.
   *
   * `staleBoards` is "nothing sold in four days" and `releaseBoards` is "empty
   * two days with none coming". Both are measured against the calendar, and
   * both are reasoning from an absence of sales — which is a fair signal about
   * an item right up until the reason nothing sold is that you had the shutters
   * down. Then it is a signal about YOU, and the shop draws the wrong
   * conclusion from it four days running: the whole range written off, item by
   * item, with the crates piling up in a yard nobody is selling out of.
   *
   * It is not hypothetical and it is not slow. A shop shut on day 94 had seven
   * items written off by day 97; turning them back on by hand bought three days
   * before the same four-day clock retired the same boards again. From inside
   * the game that is a shop that argues with you, and there is no wrong line
   * anywhere in it.
   *
   * The clocks are held rather than the tests being changed, which is the
   * pattern a roofed bed already uses: `stepCrops` moves `plantedAt` along with
   * `elapsed` so a covered crop keeps its progress without `plotGrowth` needing
   * to know about roofs. Same shape — one place that knows about the exception,
   * and every reader goes on doing arithmetic on a stamp.
   *
   * **`soldDay` only, and `stockedDay` deliberately left where it is.** They
   * look interchangeable — `staleBoards` reads `soldDay ?? stockedDay` — and
   * moving both is the obvious way to hold that fallback. It is also wrong:
   * `stockedDay` is what `spoilStock` ages, so a shop that held it would stop
   * its food rotting by shutting, which makes the shutters the cheapest
   * preservation in the game. Written that way first; the sweep below caught it.
   *
   * So a board that has never sold anything is given a stale clock of its own
   * here rather than having the shared stamp moved. That is safe because
   * `staleBoards` is `soldDay`'s ONLY reader — nothing anywhere treats it as
   * "a sale happened on this day", so seeding it costs nothing and the fallback
   * stops being load-bearing on a stamp that means something else.
   */
  holdBoardClocks() {
    for (const shelf of this.layout.shelves) {
      for (const stack of this.shelfStacks(shelf)) {
        stack.soldDay = (stack.soldDay ?? stack.stockedDay ?? this.day) + 1;
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
   * It lapses after `SHOP_DROP_DAYS`, and there are three ways to overrule it:
   *
   *   - **The supplier's `Not stocking` tab.** One press, and the reason it is
   *     first in that list is that this used to be a decision with no surface
   *     at all — see `SHOP_DROP_DAYS` for what that cost.
   *   - **Tick a shelf for it.** A reservation outranks everything in
   *     `shelvesFor` and always has; that is what a reservation is *for*.
   *   - **Put it on a shelf yourself.** `stockShelf` never reads this. The shop
   *     giving up is the shop's judgement about its own range — the same line
   *     `orders.assign` draws — and it was never a rule about your hands.
   *
   * Forever was the first shape and the note that justified it is worth keeping,
   * because the trap it describes is real: the goods are standing on a pad, so a
   * mark that simply lapsed would send somebody to carry the same units back to
   * the same board and start the same four days again. What answers it is not
   * the timer, it is where the crate goes — `dropAt` sends it to the bay, out of
   * the production buffer and into the one `homeSupply` counts, so the shop will
   * not buy more of something it is holding a crate of.
   */
  giveUpBoard(shelf, itemId, days) {
    if (!this.dropItem(itemId, SHOP_DROP_DAYS)) return;
    const name = content().byId.items[itemId]?.name ?? itemId;
    this.pushLog(
      `Stopped stocking ${name} — nothing sold in ${days} days. `
      + `Back on the list in ${SHOP_DROP_DAYS} days, or turn it back on in the supplier.`,
    );
  }

  /**
   * Where goods the shop has stopped stocking are put down.
   *
   * The bay, not the drop-off, and it is the half that makes the mark safe to
   * expire. The drop-off is the shop's *production* buffer: `padRoom` is what
   * `hasSomewhere` and `hasHome` gate the farm and the kitchen on, so a
   * discontinued line parked there does not merely sit in the way — it stops
   * your beds being picked and your machines being emptied, days later, with
   * nothing connecting the two. That is most of what "the robots just stop" was.
   *
   * The bay is where goods that came from outside wait, which is exactly what a
   * line the shop has stopped selling is. It costs `bayRoom`, and that is the
   * honest reading rather than a side effect: you are holding stock you are not
   * putting out, so the shop orders less until it is dealt with.
   *
   * Falls back to the drop-off, because a shop can have no bay at all — the
   * pads are ground somebody paints, and `dropPad` already makes the same
   * concession the other way round.
   */
  dropAt(itemId) {
    if (!this.droppedItem(itemId)) return this.dropPad();
    return this.layout.bay ?? this.dropPad();
  }

  /**
   * The mark itself, without the sentence.
   *
   * Two things now say "the shop does not stock this": the hand's own clearing
   * (`giveUpBoard`) and yours (`clearBoard`). The state is identical and the
   * REASON is not — "nothing sold in four days" and "you took it off yourself"
   * are different things to be told — so the mark is the shared half and each
   * caller keeps its own log line. Answers whether it newly landed, because a
   * caller that says nothing the second time is the difference between a shop
   * that tells you once and one that tells you every time you tidy a board.
   */
  dropItem(itemId, days = null) {
    if (this.orders.dropped[itemId] !== undefined) return false;
    this.orders.dropped[itemId] = this.day;
    // ...and how long it lasts, which is the difference between the two callers
    // rather than a second kind of mark.
    //
    // Both callers pass one now and they differ in SIZE rather than in kind:
    // taking cheese off a shelf is "not on that board" and nobody pressing Clear
    // is making a decision about the range, while four days of nothing selling
    // is the shop having actually learned something. `null` — no expiry at all —
    // is what the hand used to pass, and it is left legal only because a save
    // written before this has marks on it with no `dropFor` entry.
    //
    // A second map rather than a richer value, because `dropped` is on the save:
    // a shop that predates this has no `dropFor`, reads as permanent, and does
    // not move.
    if (days != null) {
      this.orders.dropFor ??= {};
      this.orders.dropFor[itemId] = days;
    }
    return true;
  }

  /**
   * Put it back on the list — the supplier's `Not stocking` button.
   *
   * The control this whole state was missing. There were two ways to overrule
   * the mark and both were side effects of doing something else: tick a shelf
   * for it, or stand somewhere and shelve one by hand. A control used for its
   * side effect is the shape of a missing control — the same reading that got
   * `shelf.managed` written — and here it was worse than usual, because the mark
   * itself was invisible: you had to know the mechanic existed to go looking for
   * the workaround.
   *
   * Deliberately NOT a `setItemRule` patch. `auto: false` is "never order this",
   * a standing instruction of yours; this is cancelling a judgement the shop
   * made about its own range. Folding them together would mean turning the
   * shop's guess off also wrote you a rule you never asked for, and it would
   * then survive the guess lapsing.
   *
   * Answers `ok` either way with what actually changed, because the button is
   * drawn off a snapshot that can be a tick old — pressing something that has
   * already lapsed on its own is an ordinary race, not an error worth a toast.
   */
  stockAgain(itemId) {
    if (!content().byId.items[itemId]) return err('no such item');
    const was = this.orders.dropped?.[itemId] !== undefined;
    if (was) {
      delete this.orders.dropped[itemId];
      if (this.orders.dropFor) delete this.orders.dropFor[itemId];
      this.persist();
      const name = content().byId.items[itemId]?.name ?? itemId;
      this.pushLog(`Stocking ${name} again.`);
    }
    return ok({ itemId, resumed: was });
  }

  /**
   * Everything the shop has stopped stocking, and how long each has left.
   *
   * For the panel, and it is a *derivation* rather than a second store: the two
   * maps on the save are the truth and this reads them with the same arithmetic
   * `droppedItem` lapses on, so a row can never say two days left about
   * something the sim has already let go of.
   *
   * Every row carries a number of days, including one marked before any of this
   * expired — `dropSpan` answers that, measured from the day it was actually
   * marked rather than from the load that noticed.
   */
  droppedItems() {
    const out = [];
    for (const itemId of Object.keys(this.orders.dropped ?? {})) {
      // Through the lapse rather than around it, so reading the list is also
      // what clears the expired ones — the same trick `droppedItem` plays for
      // the supplier and the log. Keys are snapshotted first, because that call
      // deletes out of the object being walked.
      if (!this.droppedItem(itemId)) continue;
      out.push({
        itemId,
        since: this.orders.dropped[itemId],
        left: Math.max(0, this.dropSpan(itemId) - (this.day - this.orders.dropped[itemId])),
      });
    }
    return out.sort((a, b) => a.left - b.left || a.itemId.localeCompare(b.itemId));
  }

  /**
   * Is any board in the shop still holding this, or set aside for it?
   *
   * The guard on both of your ways of giving up (`clearBoard`, `stripShelf`),
   * and the thing that tells "I am clearing this out" apart from "I am moving it
   * onto the unit over there". The mark is on the ITEM — it has to be, or the
   * next van lands the same goods on the unit next door — so a shop where
   * something is still stocked somewhere must not take one board coming off as
   * the whole range changing: that strands the crate on the floor AND stops
   * restocking a shelf nobody touched.
   *
   * Asked AFTER the boards have gone, so it reads the shop the press has just
   * made rather than the one before it. A reservation the verb deliberately
   * leaves behind (`stripShelf` keeps `assigned`) is the shop still being asked
   * for it, which is exactly right: strip lets go of what you never asked for
   * and keeps what you did.
   */
  stillStocked(itemId) {
    return this.layout.shelves.some((s) => (this.shelfStack(s, itemId)?.qty ?? 0) > 0
      || toList(s.assigned).includes(itemId));
  }

  /**
   * Is any board in the shop TICKED for this?
   *
   * `stillStocked`'s narrower half, and separate from it because the two answer
   * different questions. That one asks whether the shop still sells this at all
   * — stock counts, because a board with cheese on it is the shop selling
   * cheese. This one asks whether somebody *decided* it should be here, which
   * only a reservation can say: stock is a fact about today, a tick is an
   * instruction, and the whole point of the second is that it survives the first
   * running out.
   *
   * Read by `shelvesFor` to overrule a give-up, so it must stay the strict
   * question — folding stock back in would mean a board that happens to have
   * one jar left cancels a judgement the shop has just made about the jam.
   */
  keptFor(itemId) {
    return this.layout.shelves.some((s) => toList(s.assigned).includes(itemId));
  }

  /**
   * Has the shop given up on stocking this? Staff read it; your hands don't.
   *
   * Lapses itself on read rather than in `onNewDay`, the same argument
   * `staffSpentToday` makes: a counter cleared by exactly one code path is wrong
   * every time the day changes some other way — a save loaded later, a
   * `set_time` jump, a sixty-day balance run. Cleared rather than merely
   * ignored, so the supplier and the log never mention a ban that has expired.
   */
  droppedItem(itemId) {
    if (this.orders.dropped?.[itemId] === undefined) return false;
    const days = this.dropSpan(itemId);
    if (this.day - this.orders.dropped[itemId] >= days) {
      delete this.orders.dropped[itemId];
      if (this.orders.dropFor) delete this.orders.dropFor[itemId];
      return false;
    }
    return true;
  }

  /**
   * How long a mark lasts, with the missing case answered.
   *
   * A mark written before any of this expired has no `dropFor` entry, and the
   * first version of this read that as *forever* — which is right about what
   * the code used to do and wrong about what it should ever have done. It also
   * left the damage in place on precisely the saves that suffered it: a shop
   * that collected eight of these in a week would open on the fix with eight
   * permanent ones and no way out except finding the new button eight times.
   *
   * So a missing span reads as `SHOP_DROP_DAYS`, which invents nothing — the
   * DAY it was marked is already on the save, so the countdown is measured from
   * when it actually happened rather than from when the shop was next loaded.
   * A read-time default rather than a migration, the same shape `kindOf` uses
   * for a `fixtures` row with no `kind`: an old save, an export and a fresh
   * world all agree with no ceremony.
   *
   * `HAND_DROP_DAYS` marks are unaffected — your Clear has always written its
   * own span, so nothing that was five days becomes twelve.
   */
  dropSpan(itemId) {
    return this.orders.dropFor?.[itemId] ?? SHOP_DROP_DAYS;
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
      stockedDay: this.dayNow(),
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

  /**
   * The nearest square somebody standing inside a fixture can step out to.
   *
   * A re-flow can leave a person on a tile that has stopped being floor, and
   * the obvious way to do it is to set a shelf down on your own feet — the
   * ghost is green there, deliberately, because blocking yourself in is a move
   * the shop copes with. What it did NOT cope with was the person: the only
   * answer was `layout.spawn`, so putting a till down where you were standing
   * threw you across the shop and out of the building, which reads as the game
   * having crashed and reloaded rather than as a consequence of the tap.
   *
   * A flood rather than a ring scan, because the square has to be one you could
   * plausibly have walked to: the far side of the wall you were just enclosed
   * by is one step away and no use at all, so a solid edge is never crossed.
   * It spreads *through* blocked tiles, which is what gets somebody out of the
   * middle of a bank of shelving, and `limit` is what keeps that from becoming
   * a teleport by another name — past that, spawn is honestly the better answer.
   *
   * @returns {?{x: number, z: number}} Null if nothing near is standable.
   */
  stepOff(x, z, limit = 6) {
    const sx = Math.round(x);
    const sz = Math.round(z);
    const seen = new Set([`${sx},${sz}`]);
    let front = [{ x: sx, z: sz }];
    for (let d = 0; d < limit && front.length; d++) {
      const next = [];
      for (const c of front) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = c.x + dx;
          const nz = c.z + dz;
          const key = `${nx},${nz}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (nx < 0 || nz < 0 || nx >= this.layout.w || nz >= this.layout.h) continue;
          if (SOLID.has(edgeBetween(this.layout, c.x, c.z, nx, nz))) continue;
          // Nearest first, because the frontier is walked a ring at a time —
          // so the step out of a doorway is the doorway, not the aisle beyond.
          if (this.canStand(nx, nz)) return { x: nx, z: nz };
          next.push({ x: nx, z: nz });
        }
      }
      front = next;
    }
    return null;
  }

  /**
   * How fast you walk, as a multiplier — off the rows, not off an id.
   *
   * It was `includes('boots-1') ? 1.3 : 1`, which is the dead-knob trap in
   * CLAUDE.md caught in the act: the row authored `{ speedMult: 1.3 }` and
   * nothing ever read it, so retuning the boots did nothing, and a second rung
   * would have been a button that took money and changed no number. The failure
   * is silent in both directions — the boots still work, at whatever the
   * literal says.
   *
   * Best-of rather than multiplied, for `fixtureDiscount`'s reason: the ladder
   * is already ordered, so owning two rungs should read as owning the better
   * one. `SPEED_CAP` is the backstop against a row authored at 9 — a player who
   * crosses the shop in one frame walks through every reach test in the game.
   */
  speedMult() {
    const owned = this.ownedUpgrades ?? [];
    if (!owned.length) return 1;
    const best = content().upgrades
      .filter((u) => u.kind === 'speed' && owned.includes(u.id))
      .reduce((m, u) => Math.max(m, Number(u.payload?.speedMult ?? 0)), 1);
    return clamp(best, 1, SPEED_CAP);
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
    //
    // Milestones are a fourth, and the only one you cannot buy: the town grows
    // because the shop did something, which is the whole reason that is the
    // reward worth having. Unbounded on purpose where the other two saturate —
    // the ladder is finite, so what it can add is already capped by how many
    // rungs there are.
    // ...and the town's own growth, which is the fifth and the only one nobody
    // did anything to get. See `TOWN_GROWTH`: between two of the four above,
    // this is the only thing that moves, and on a shop whose reputation has
    // pinned there is otherwise nothing in the game left to move at all.
    return BASE_CATCHMENT + this.townGrowth() + countUpgrade(this, 'catchment', 'reach')
      + this.charmReach() + this.parkReach() + milestoneReach(this);
  }

  /**
   * How much the town has grown around a shop that kept opening.
   *
   * Measured on `day` and nothing else, which is the whole of what makes it the
   * world's term rather than a fifth thing you buy — see `TOWN_GROWTH`. A shop
   * that shuts for a week still ages, and that is right: the town did not stop
   * growing because you did, and the shutters already cost you the trade.
   */
  townGrowth() {
    return TOWN_GROWTH * (1 - Math.exp(-Math.max(0, this.day - 1) / TOWN_TAU));
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

  /**
   * Somebody walks in — at the door, or back where they left off.
   *
   * `who` is an id that outlives the socket (client/net.js). Handed one that
   * this shop has a record for, you come back standing where you were with what
   * you were holding, which is the whole of step 3 of docs/shipping.md.
   *
   * The record is CONSUMED on the way in, and that is not tidiness. It is what
   * makes it impossible to walk into your own shop twice and come out with two
   * armfuls of the same six loaves — two tabs share a `localStorage`, so the
   * second one is a duplicate waiting to be minted. Whoever gets here first has
   * the goods and everyone after them starts at the door.
   */
  addPlayer(id, name, who = null) {
    const spawn = this.layout.spawn;
    const colors = ['#5b8ff9', '#f2a03d', '#7cc46a', '#c98ad9'];
    // Hired staff share `this.players`, so count only the humans — otherwise
    // hiring a clerk renames and recolours the next person who joins.
    const humans = Object.values(this.players).filter((p) => !p.staff).length;
    const back = who ? this.away[who] : null;
    if (who) delete this.away[who];
    // A shop is rebuilt while you are away: the tile you were standing on can be
    // under a shelf, outside the walls, or off a map that shrank. Somewhere you
    // cannot stand is worse than the door, because there is no way to walk out
    // of it — so the spot is offered, never trusted.
    const stood = back && this.canStand(back.x, back.z);
    this.players[id] = {
      id,
      who: who ?? null,
      name: name || `Player ${humans + 1}`,
      x: stood ? back.x : spawn.x + (humans % 2 === 0 ? -1 : 1),
      z: stood ? back.z : spawn.z - 1,
      facing: stood ? (back.facing ?? 0) : 0,
      color: colors[humans % colors.length],
      // Hands and shoulder come back even when the SPOT could not, because
      // where you were standing and what you were holding are two facts and
      // only one of them can be invalidated by a wall. Dropping the armful
      // because a shelf moved is the conservation hole `removePlayer` documents.
      carry: back?.carry ?? null,
      haul: back?.haul ?? null,
      input: { dx: 0, dz: 0 },
    };
    this.pushLog(`${this.players[id].name} clocked in.`);
    return this.players[id];
  }

  /**
   * Is this somewhere a person can be? Asked of a remembered spot, once.
   *
   * The walk grid rather than `isWalkableTile` alone: a tile can be indoor floor
   * and have a shelf standing on it, and coming back inside a freezer is the
   * same "there is no way out of here" as coming back inside a wall.
   */
  canStand(x, z) {
    const { w, h, blocked } = this.layout;
    const tx = Math.round(x);
    const tz = Math.round(z);
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) return false;
    if (tx < 0 || tz < 0 || tx >= w || tz >= h) return false;
    return !blocked?.[tz * w + tx];
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
   * crates are saved. See docs/shipping.md, step 2.
   *
   * ...and step 3 arrived, so the drop is the FALLBACK now rather than the rule.
   * Handed a `who` (client/net.js) the shop remembers the person instead: where
   * they stood and what was in their hands, on `this.away`, saved with the
   * world. A reload is then the same person coming back rather than a stranger
   * arriving, which is what it always was everywhere except in this object.
   */
  removePlayer(id) {
    const p = this.players[id];
    if (!p) return;
    if (p.who) {
      // One row per person, so a row already there is somebody's goods about to
      // be overwritten — two tabs of one browser are one `who`, and the second
      // to leave would silently destroy what the first was holding. Whoever is
      // being displaced gets their armful on the floor where they left it,
      // which is the old behaviour applied to exactly the case it is still
      // right for.
      const had = this.away[p.who];
      if (had?.carry) this.dropLot(had.carry, { x: had.x, z: had.z });
      if (had?.haul) this.dropLot(had.haul, { x: had.x, z: had.z });
      // You are remembered rather than tidied away, so the goods stay in your
      // hands rather than becoming a crate on the floor. This is the whole of
      // what the paragraph above was waiting for: the drop was never the right
      // answer, it was the least-wrong one available while every reload was a
      // stranger arriving.
      this.away[p.who] = {
        who: p.who,
        x: round2(p.x),
        z: round2(p.z),
        facing: p.facing ?? 0,
        carry: p.carry ?? null,
        haul: p.haul ?? null,
      };
      // A record with stock in it that nothing writes to disk is stock
      // destroyed by the next restart, and this is usually the last thing that
      // happens before one — the tab closing IS the reload.
      this.persist();
    } else {
      // No stable id: private browsing, storage turned off, a bot. Nothing will
      // ever come back to claim it, so the old behaviour is the right one.
      if (p.carry) this.dropLot(p.carry, { x: p.x, z: p.z });
      if (p.haul) this.dropLot(p.haul, { x: p.x, z: p.z });
    }
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
    const onPad = !!pad && isPadAt(this.layout, pad, goal.x, goal.z);
    if (p.carry && onPad) {
      p.errand = { at: 'pad', itemId: null, btn: 'left' };
    }
    // A crate on the shoulder gets the same tap, said with the other verb: a
    // haul cannot be `stow`ed, because `stow` empties your HANDS, so the pad
    // names the tile you tapped rather than the region. Same sentence, one
    // cell's worth less tidy.
    //
    // Note the target is the tile you tapped, and `errandAction` re-measures
    // reach to it on arrival. The route ends stopped on it, so that is normally
    // free; what it buys is the case where the way is blocked and you stop
    // short, which has to be "you did not get there" rather than a crate landing
    // wherever you gave up.
    else if (p.haul && onPad) {
      p.errand = { at: 'ground', x: goal.x, z: goal.z, itemId: null, btn: 'left' };
    }
    // ...and a tap on ANY other tile is a walk and nothing else, which it was
    // not for four steps. Holding goods, every tap armed a setdown on the tile
    // it walked you to — and an errand outranks everything proximity offers, by
    // design, because it is supposed to be the thing you asked for. This one was
    // never asked for: it is the guess that "you tapped over there" means "put
    // that down over there", and it is live from the moment your hands are full
    // until something fires.
    //
    // What it cost is every job that fires on its own while you are carrying
    // something. Walk a crate to your own till with somebody waiting at it and
    // the shop offers to set the box down instead of serving them — so you put
    // the crate down first, which is the tell: an action that needs your hands
    // empty for no reason anybody could name. Same for the ripe bed you walk
    // onto with a box on your shoulder, which `harvest` deliberately stopped
    // minding about.
    //
    // Nothing is lost, because the square already has its own gesture: `placeAt`
    // off a held press, aimed at the cell the green ghost is drawn on. A tap
    // goes, a hold does — and putting something down is still one hold either
    // way, now pointed at the square it lands on rather than at whichever tile
    // the last tap happened to end on.
    return ok({ to: goal, steps });
  }

  /**
   * Name a square as somewhere to PUT things, without going to it.
   *
   * Its own verb, and the reason is that "over there" and "down there" are two
   * different sentences about the same tile and both have to stay available.
   * Folding this into `walkTo` — no route inside `UNLOAD_REACH` while your hands
   * are full — put the drop exactly where the aim said, and cost you the ability
   * to take a single step while holding a box: every nearby tile had stopped
   * being somewhere to stand. Before that, routing first cost the aim instead,
   * because the walk ends *on* the tile you named, so the crate always went down
   * under your feet.
   *
   * So the two are split by GESTURE rather than by distance, which is the split
   * the whole shop floor already runs on: a tap goes, a hold does. `walkTo` is
   * unchanged and still walks you anywhere; this is what the press arms, so the
   * ring winds on the square you are pointing at and the box lands there.
   *
   * Refused rather than quietly widened when it is out of reach or unstandable —
   * the client only sends it for a square it has already drawn as green, so a no
   * here means the two disagree, and a silent fallback to walking would hide it.
   */
  placeAt(id, x, z) {
    const p = this.players[id];
    if (!p) return err('no such player');
    const busy = this.notWhileBuilding(p);
    if (busy) return busy;
    if (!p.haul && !p.carry) return err('nothing in hand');

    const goal = { x: Math.round(x), z: Math.round(z) };
    if (Math.hypot(goal.x - p.x, goal.z - p.z) > UNLOAD_REACH) return err('too far to reach');
    if (!isWalkable(this.walk, this.layout, goal.x, goal.z)
        || !this.canWalk(p.x, p.z, goal.x, goal.z)) {
      return err('nothing to stand a crate on there');
    }

    // Turn to it. Putting something down is done with your hands, so standing
    // square to the shop while a box lands over your shoulder reads as the aim
    // having been ignored.
    if (goal.x !== Math.round(p.x) || goal.z !== Math.round(p.z)) {
      p.facing = Math.atan2(goal.x - p.x, goal.z - p.z);
    }
    // The pad keeps its own errand for an armful, because `stow` hands `dropGoods`
    // the pad as a REGION and fills the cells you painted — see `walkTo`.
    const pad = this.dropPadKind();
    p.errand = p.carry && pad && isPadAt(this.layout, pad, goal.x, goal.z)
      ? { at: 'pad', itemId: null, btn: 'right' }
      : { at: 'ground', x: goal.x, z: goal.z, itemId: null, btn: 'right' };
    return ok({ at: goal });
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
   *
   * `put` is the direction, carried the whole way, and it is the same field
   * `aimAt` sets for a unit you are already standing at. A walk is how the right
   * button reaches anything out of reach — it is one sentence ("this is where
   * what I am holding goes") with a walk in the middle of it — so dropping the
   * direction at the kerb means the errand that fires on arrival is a *left*
   * button's errand. A shelf never noticed, because it offers the same job
   * either way round; an appliance has two openings, and what you got was a
   * machine you walked a crate over to and then collected its tray from.
   */
  walkToFixture(id, fixtureId, put = false) {
    const f = this.findFixture(fixtureId);
    if (!f) return err('no such fixture');
    const spot = workSpot(f);
    const walk = this.walkTo(id, spot.x, spot.z);
    if (!walk.ok) return walk;
    this.players[id].errand = {
      at: fixtureId, itemId: null, put, btn: put ? 'right' : 'left',
    };
    return walk;
  }

  /**
   * Every side of a fixture somebody can work it from.
   *
   * The stored anchor first — that is the spot the generator reserved and the
   * one a walk routes to — then the ends, and the back if the piece is open all
   * round. Resolved here rather than stamped on the record because
   * `server/layout.js` deliberately never resolves a piece: the generator knows
   * a kind and a piece id and nothing about the catalog, which is what keeps it
   * a pure function of the shell and the placements.
   */
  fixtureSpots(f) {
    return spotsOf(f, {
      layout: this.layout,
      open: pieceFor(content().fixtures ?? [], f)?.open === true,
    });
  }

  /**
   * Are you standing somewhere you could work this thing?
   *
   * Replaces `near(p, workSpot(f))` everywhere a *person* is being asked. The
   * old test was one tile, which is right for the walk (a route needs one goal)
   * and wrong for the question "can I reach this from here" — you can put a loaf
   * on the end of a display table, and a shop that says otherwise is wrong about
   * its own furniture.
   */
  atFixture(p, f, radius = REACH) {
    return this.reachSpots(f).some((s) => near(p, s, radius));
  }

  /**
   * The spots for REACHING, which is not quite the list for marking.
   *
   * A bed and a decoration have no working spot at all — `spotsOf` returns
   * nothing for them on purpose, because you stand *on* a plot rather than
   * beside it and a lamp is not somewhere anybody works. The old one-tile test
   * said this by falling through to the fixture itself (`workSpotOf`'s last
   * `?? f`), and dropping that quietly stopped every bed in the game arming a
   * harvest — caught by `verify:build`, invisible in a screenshot, and exactly
   * the kind of thing a fallback nobody names gets you.
   *
   * Kept out of `fixtureSpots` so the marker list stays honest: a ring painted
   * on a bed would be telling you to go and stand where you already are.
   */
  reachSpots(f) {
    const spots = this.fixtureSpots(f);
    return spots.length ? spots : [workSpot(f)];
  }

  /**
   * ...and WHICH side you are at, for the marker to sit on.
   *
   * The nearest one, which with a person standing in it is the one under their
   * feet. This is what stops the shop pointing at a tile beside you while you
   * are already stood somewhere it will accept — an instruction to move that
   * was never true, and the whole of what reads as the game being fussy.
   */
  spotNearest(p, f) {
    let best = null;
    let bestD = Infinity;
    for (const s of this.reachSpots(f)) {
      const d = Math.hypot(s.x - p.x, s.z - p.z);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best ?? workSpot(f);
  }

  /**
   * Name a fixture from where you stand — the same sentence `placeAt` says about
   * a square, said about a thing.
   *
   * `p.pressing` is one bit. It says a button is down and nothing whatever about
   * where the pointer was when it went down, so the ring winds on whatever
   * `p.errand` happens to still hold — and an errand outlives the walk that set
   * it. Stand between two shelves with an armful and hold, and the goods went
   * onto the one you tapped some time ago rather than the one you were pointing
   * at: proximity's bug, arrived by a different road, since the aim that decided
   * it was not the aim you were making. Every other target re-aims on the way
   * down (`take` for a crate or a board, `placeAt` for a square); a unit had no
   * way to.
   *
   * Its own verb rather than `walkToFixture` with the walk skipped, for exactly
   * the reason `placeAt` is not `walkTo` with a flag: **a press must not move
   * you.** Routing to the working spot is right for a tap, which is a decision to
   * go — and wrong for the press that arms a hold, which would shuffle you one
   * square sideways as the ring starts winding, on a gesture whose whole promise
   * is that it happens where you are standing.
   *
   * Refuses out of reach rather than widening, and the reach is `workSpot`'s,
   * because that is the one `errandAction` re-measures on the other end — a
   * different test here would arm a ring that could never complete.
   */
  aimAt(id, fixtureId) {
    const p = this.players[id];
    if (!p) return err('no such player');
    const f = this.findFixture(fixtureId);
    if (!f) return err('no such fixture');
    // Out of reach arms nothing and says nothing. This is driven by the POINTER
    // (`syncStockAim`), not by a press, so a refusal here would be a red toast
    // for moving the mouse — and the two ends measure the same distance against
    // a position that is a snapshot old, so they will disagree at the edge of it
    // every time somebody stocks a shelf on the move.
    if (!this.atFixture(p, f)) return ok({ at: null });
    // Turn to it, the way `placeAt` does: the goods leave your hands towards the
    // thing you named, and standing square to the shop while they do reads as the
    // aim having been ignored.
    if (Math.round(f.x) !== Math.round(p.x) || Math.round(f.z) !== Math.round(p.z)) {
      p.facing = Math.atan2(f.x - p.x, f.z - p.z);
    }
    // `itemId` null: this names the UNIT. A board is `take`'s job, and the two
    // used to be unable to race — a board was only ever named with empty hands
    // and this only ever with full ones. A held take broke that: it spans ticks
    // and its first unit lands in your arms, so from that tick on the pointer
    // has an opinion about where the armful should GO while the pull it came
    // from is still running. See `pulling`.
    if (this.pulling(p)) return ok({ at: p.errand?.at ?? null });
    // **`put` is the direction, SAID rather than inferred**, and this is the one
    // place in the game that can say it for a *hold*: `aimAt` is the right button
    // and nothing else — one sentence, "this is where what I am holding goes" —
    // where `walkToFixture` is the left one. An errand had no direction on it
    // because nothing needed one: a shelf offers the same job either way round.
    // An appliance does not. It has two openings, and `actionAt` read the tray
    // first, so a machine with a batch waiting could not be fed at all: the ring
    // collected instead, on the button whose whole meaning is putting things in.
    p.errand = { at: fixtureId, itemId: null, put: true, btn: 'right' };
    return ok({ at: fixtureId });
  }

  /**
   * Stop offering a unit you are stood at and no longer pointing at.
   *
   * The other half of `aimAt`, and the half that fixes the *prompt* rather than
   * the target. `p.action` is republished every tick from whatever `p.errand`
   * still says, at zero progress, so a shelf named by a tap went on saying
   * "Stock…" for as long as you stood beside it — an offer nobody had made, on
   * the one label that says what the hold is about to do.
   *
   * Two clauses, and both are load-bearing.
   *
   * **Only a fixture.** A square (`placeAt`), the pad, and a crate (`take`) are
   * each named by a gesture somebody finished on purpose; the pointer owns which
   * *unit* an armful is for and owns nothing else, so those are left alone.
   *
   * **Only within reach**, which is what keeps the main stocking gesture alive.
   * Tapping a shelf across the shop walks you to it and names it, and your
   * pointer is nowhere near it for the whole of that walk — pointing elsewhere
   * while you are too far away to act is not a decision about anything. It
   * becomes one the moment you arrive, which is exactly when the offer appears.
   */
  clearAim(id) {
    const p = this.players[id];
    if (!p) return err('no such player');
    // ...and the same yield, which matters more on this end: this one is sent
    // when the pointer wants NOTHING, so a mouse that drifted off the shelf
    // would take the errand out from under a pull that is mid-armful, and the
    // hold would go dead in your hand. See `pulling`.
    if (this.pulling(p)) return ok({ cleared: false });
    const e = p.errand;
    if (!e || e.at === 'pad' || e.at === 'ground') return ok({ cleared: false });
    const f = this.findFixture(e.at);
    if (!f || !this.atFixture(p, f)) return ok({ cleared: false });
    p.errand = null;
    return ok({ cleared: true });
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

    const old = plot.crop_id ? content().byId.crops[plot.crop_id] : null;
    const replaced = old?.name ?? null;

    // What you pull up comes back, in proportion to how little of it has grown.
    //
    // This is the half that lets `harvest` replant the bed's OWN crop instead of
    // whatever seed you last touched. That rule is the right one — a bed is a
    // per-bed decision — but on its own it makes switching cost two seeds: the
    // one the harvest put back, and the one you actually wanted. Priced that
    // way it was a third of all profit over 60 days, which is why the wrong
    // rule was there in the first place.
    //
    // Scaled by growth rather than a flat refund, because the two ends are
    // genuinely different acts: a seed that went in a second ago is a seed you
    // can take back out of the soil, and pulling up an almost-ripe crop is
    // throwing away something the shop grew. `plotGrowth` is the same 0..1 the
    // renderer draws it at, so what you get back is what the bed looks like it
    // is worth. Nothing here can print money — the most you can ever recover is
    // what you paid — and turning a bed over the tick after picking it is free,
    // which is exactly the case the old rule was protecting.
    const back = old ? round2(old.seed_cost * (1 - this.plotGrowth(plot))) : 0;
    // Counted BEFORE the affordability test, with the other guards and before
    // any money moves — the trap `buyStock` fell into. A bed you are turning
    // over is worth something, so a swap you can afford out of the refund must
    // not be refused for being a cent short of the gross price.
    if (this.cash + back < crop.seed_cost) {
      return err(`need $${round2(crop.seed_cost - back).toFixed(2)} for seed`);
    }
    if (back > 0) {
      this.cash += back;
      this.stats.spent -= back;
    }
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
      ? `Turned the ${this.fixtureSaid(plot)} over from ${replaced} to ${crop.name}${
        back > 0 ? ` — $${back.toFixed(2)} of seed back` : ''}.`
      : `Sowed ${crop.name} in the ${this.fixtureSaid(plot)}.`);
    return ok({ sown: cropId, plot: plot.id, refund: back });
  }

  // ---- who works here ---------------------------------------------------
  //
  // A hire is a row in `roster`, not an upgrade you own. That is what lets you
  // take on two stockers, let one go, and give one of them a different job list
  // from the other — none of which "you own upgrade staff-stocker" can say.

  /**
   * Give a name to anyone who was hired before there were names.
   *
   * Every hire made before this shipped is called after their job — "Clerk",
   * "Stocker 2" — and the roster is saved, so without this the feature only
   * exists for people you take on from today: a shop that has been running for
   * a fortnight shows you a stock list and a couple of strangers. Cosmetic and
   * one-way, which is what makes it safe to do to a save at all; nothing in the
   * game reads a hire's name, and there has never been a way to *choose* one,
   * so there is no player decision here to overwrite.
   *
   * The test for "was never named" is the name being the kind's own, with or
   * without the counter `hire` used to add. A kind whose row has since been
   * deleted is left alone rather than guessed at — it has no body either.
   *
   * Runs in the constructor, so an ephemeral balance game names its inherited
   * roster too and `simulate`'s log reads like the shop's.
   */
  nameTheRoster() {
    const roster = this.roster ?? [];
    const kinds = content().byId.workers;
    const taken = new Set(roster.map((e) => e.name));
    for (const entry of roster) {
      const kind = kinds[entry.kind];
      if (!kind) continue;
      const legacy = new RegExp(`^${kind.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\d+)?$`);
      if (!legacy.test(entry.name ?? '')) continue;
      taken.delete(entry.name);
      entry.name = this.namer.unique(taken, { bot: true });
      taken.add(entry.name);
    }
  }

  /** Take someone on. `kindId` is a row in the workers content table. */
  hire(kindId) {
    const w = content().byId.workers[kindId];
    if (!w) return err('no such kind of worker');
    if (this.cash < w.cost) return err(`need $${w.cost.toFixed(2)} to take them on`);

    this.cash -= w.cost;
    this.stats.spent += w.cost;
    const id = `w${this.nextWorkerId++}`;
    /**
     * Somebody, rather than a second copy of a job title.
     *
     * This used to be the kind's name with a count after it — "Clerk",
     * "Clerk 2" — which told two people apart and nothing else: the roster read
     * as a stock list, and the one thing you might want to say about a hire
     * ("the one on the tills is knackered") had no way to be said. The kind has
     * not gone anywhere; it is on the row and the menu prints it as *Taken on
     * as*, which is where it belongs, because what they were hired as stops
     * being the interesting fact about them the moment there are two.
     *
     * A machine, always. A hire is drawn out of `workers` with a chassis, trim
     * and a glow — the shoppers are the ones who might be either.
     *
     * Names already on the roster are the only ones worth avoiding: they are
     * the only names in the game anything remembers.
     */
    const name = this.namer.unique(this.roster.map((e) => e.name), { bot: true });
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
      this.dropLot(body.carry, this.dropPad());
      body.carry = null;
    }
    if (body?.haul) {
      this.dropLot(body.haul, this.dropPad());
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
    // Folded first, so a client or an MCP call still holding the old three-way
    // farm vocabulary is answered rather than refused — the same shim the save
    // and the catalog get, said about the wire.
    for (const j of foldJobs(jobs)) {
      if (!JOBS.includes(j?.job)) return err(`"${j?.job}" is not a job`);
      const weight = Number(j.weight);
      if (!Number.isFinite(weight) || weight <= 0) return err('a weight has to be a positive number');
      clean.push({ job: j.job, weight: Math.min(100, Math.max(0.1, weight)) });
    }
    // How much of a day there is to hand out, and the same function the menu
    // greys the `+` with — see shared/jobs.js. Judged against what they are
    // ALREADY carrying, so a hire left over their allowance by a rollback can
    // still be rearranged downward rather than being stuck.
    const kind = content().byId.workers[entry.kind];
    if (!jobsAffordable(kind, entry.tier, clean, entry.jobs)) {
      return err(`that is more than ${entry.name} has in a day — ${jobBudget(kind, entry.tier)} at their firmware`);
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

    // Picking fills a CRATE on your shoulder, not your hands, and that is the
    // whole trip halved.
    //
    // Hands are six units and a crate is `CRATE_UNITS` — the difference is the
    // point of hauling, and the farm is where it pays most: a bed gives four to
    // ten now, so an armful was one bed and a walk. Shouldering the box first
    // makes a row of beds one journey, and it ends in the same place a full
    // armful does but better — `stockFromCrate` pours a box straight onto a
    // board, so the walk back is one tap rather than an unload-and-lift dance.
    //
    // Three conditions, and each is a rule that already existed rather than one
    // invented here. Empty hands, because you cannot shoulder a box while
    // holding loose goods (`liftCrate`, `crateBoard`) — so an armful you are
    // already carrying keeps the old behaviour below and is not silently
    // rearranged. Not a hire, because `stepStaff` is built around hands and
    // their haul only ever runs OUT OF THE YARD, which is what makes their loop
    // terminate; handing a stocker a crate in a field is a job the farm loop
    // never measured. And room in the box, which is `lotRoom` doing what it does
    // for hands: both caps at once, so a third crop finds no free board and
    // falls through to the ground rather than being lost.
    const crated = (!p.staff && !p.carry)
      ? Math.min(yieldQty, lotRoom(p.haul ?? null, crop.item_id, this.crateLot()))
      : 0;
    if (crated > 0) p.haul = lotAdd(p.haul ?? null, crop.item_id, crated, this.crateLot()).lot;

    // An armful of tomatoes no longer stops you picking the carrots next to it,
    // which is most of what mixed hands are worth on the farm: a row of four
    // beds used to be four walks to the yard, and the walk was the crop.
    const taken = Math.min(yieldQty - crated, lotRoom(p.carry, crop.item_id, this.carryLot(p)));

    // ...and what will not fit goes in a crate at your feet rather than
    // NOWHERE, which is what it used to do.
    //
    // Hands hold six and a bed gives two to seven, so picking a row was one
    // bed and a walk: the second bed's yield was clipped to whatever room was
    // left and the rest of it silently ceased to exist — a bed drawing four
    // plants handed over one and binned three, with nothing in the log and
    // nothing on the floor to say so. That is the one thing this game does not
    // do anywhere else (see `dropGoods`: an armful you let go of, a stripped
    // shelf, a hire who logs out — all of it becomes a crate), and it is why
    // the farm felt like it could only be worked one bed at a time.
    //
    // So there is no refusal here any more, and the two noes it used to give
    // are gone with it. A full pair of hands is not a reason to leave a ripe
    // crop in the ground — it is a reason for the crop to be in a box instead,
    // which is a box you can come back for, shoulder whole, or empty into the
    // bay. `dropGoods` merges within a couple of tiles, so picking six beds in
    // a block leaves one readable pile beside them rather than six pallets.
    //
    // The crate lands on the tile under YOU, not on the bed: a plot is the
    // ground rather than a thing standing on it, and a box parked on the
    // seedlings you just put back reads as the harvest having failed.
    const spare = yieldQty - crated - taken;
    if (spare > 0) this.dropGoods(crop.item_id, spare, { x: Math.round(p.x), z: Math.round(p.z) });

    if (taken > 0) p.carry = lotAdd(p.carry, crop.item_id, taken, this.carryLot(p)).lot;
    // Everything the bed grew, because everything the bed grew still exists.
    // It counted only what reached your hands while the surplus was being
    // destroyed, which was honest then and would under-report the farm now.
    this.stats.harvested += yieldQty;

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
    //
    // WHAT goes back in is the bed's own crop, and it was the globally selected
    // seed for four steps — which quietly converted whole farms.
    //
    // The old rule reads as thoughtful and is the wrong shape: `sow` sets
    // `p.selectedCrop` as a convenience ("choosing it here is choosing it"), so
    // turning ONE bed over from a coop to tomatoes silently made tomatoes the
    // answer for every other bed as well — each one converting the next time it
    // was picked, days apart, with the log saying nothing but "Sowed Tomato
    // Vine". A player who planted six varieties and did nothing afterwards but
    // harvest ends up with six beds of whatever they last touched. That is a
    // global answer to a per-bed question, and no amount of care with the
    // hotbar can avoid it.
    //
    // The money objection that put it there is real and is answered elsewhere,
    // properly: replanting the picked crop when you meant to switch charges for
    // a seed you were about to replace, so a switch bought two — a third of all
    // profit over 60 days. `sow` now refunds what it pulls up in proportion to
    // how little it has grown, so turning a bed over the moment it is picked
    // costs exactly one seed and the double charge cannot happen. A per-bed
    // decision belongs to the bed; the price of changing it belongs to the verb
    // that changes it.
    //
    // `selectedCrop` keeps its real job: the hotbar seed, for a bed that is
    // EMPTY. It just no longer reaches across the farm.
    const wanted = crop;
    const again = this.replantable(wanted);
    if (again.ok) {
      this.cash -= wanted.seed_cost;
      this.stats.spent += wanted.seed_cost;
      // The turned soil stays turned — that is the busywork this removes — and
      // the new planting rolls its own yield, so the bed immediately shows what
      // this next crop is worth rather than inheriting the last one's number.
      this.sowInto(plot, wanted);
      return ok({
        item_id: crop.item_id, qty: crated + taken, hauled: crated, spare,
        replanted: wanted.id, yield: plot.yield,
      });
    }

    // Can't re-sow it, so the old exhaust rule stands: you get the bare bed
    // back and turn it over yourself. `why` travels up so the client can say
    // which of the two it was, instead of the field just going quiet.
    this.clearPlot(plot);
    return ok({
      item_id: crop.item_id, qty: crated + taken, hauled: crated, spare, replanted: null, why: again.why,
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

    // ...and the same question about the shop rather than about the bay. The
    // guard above is where the van may LAND; this one is whether the shop has
    // anywhere for it to end up, counted wherever it is standing. See
    // `looseRoom` — the two are a pair, and the bay alone let a shop with 381
    // units on its floors go on buying because sixteen of them were not on a
    // pad. With the other refusals and before the money, the way `buyStock` had
    // to learn to put the bay check.
    const loose = this.looseRoom();
    if (loose <= 0) return err('the shop is full of crates — shelve or bin some before ordering more');
    if (take > loose) return err(`only room for ${loose} more until some of it is cleared`);

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
      // How long the whole journey is, which is the one number a countdown
      // cannot be drawn without and the client can never work out: `in` says
      // how much is left, and "five minutes left" is nearly there for somebody
      // who ordered on the hour and half way for somebody who ordered at ten
      // to. Stored rather than derived, for the same reason `runHour` is — the
      // runs are evenly spaced but a wait is not, because an order joins
      // whichever run is next. `arrivesAt` is
      // rewritten on every load, so the only surviving record of how far you
      // have come is the distance you set out to cover.
      wait: round2(run.wait),
    };
    this.orders.pending.push(order);
    this.persist();

    // One line per VAN, not per board. Keyed by the run, so everything going on
    // the same lorry lands on the same line however many separate decisions put
    // it there — which is what `restock` is, one board at a time.
    const who = this.saidBy(playerId, 'ordered');
    this.logGoods(`order:${run.hour}`, {
      pre: `${who.verb} `, post: ` — on the ${hourLabel(run.hour)} van.`,
      goods: [{ item_id: itemId, qty: take }], by: who.by,
    });
    return ok({
      ordered: take, cost: round2(cost), delivery: true, orderId: order.id,
      arrivesAt: hourLabel(run.hour), arrivesIn: round2(run.wait),
    });
  }

  /**
   * Call an order back off the list — everything of this item that has not been
   * loaded yet.
   *
   * The other end of `buyStock`, and it was missing entirely: the only way to
   * unspend money on stock was to take the delivery and then sell nothing. A
   * supplier you can only add to is a list rather than an order.
   *
   * **Loaded is the line, and it is the line the game already draws.** A van is
   * a promise (see `nextRun` — an arrival is always in the future), and once the
   * lorry has your crates on it the promise has been kept as far as the shop is
   * concerned: `onVan` is exactly that state, it is already on the wire, and it
   * is already what the supplier shows as "arriving". So cancelling is free
   * right up to the moment it is loaded and impossible afterwards, which needs
   * no new rate, no restocking fee and no second sell-back number beside
   * `FIXTURE_REFUND`.
   *
   * Per ITEM rather than per order id, because that is the shape of the
   * question: three cases of milk ordered across two runs is one decision — "I
   * do not want the milk" — and a control that made you cancel them one at a
   * time would be a list of receipts rather than a shopping list. What is loaded
   * is left alone and reported, or a press that silently did half the job reads
   * as the button not working.
   *
   * Refunds what was CHARGED (`o.cost`) rather than recomputing the price. A
   * repricing between placing and cancelling would otherwise be free money in
   * one direction and a quiet loss in the other, and the stat has to move with
   * it or the day's spend keeps money the till has back.
   */
  cancelOrder(playerId, itemId) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    if (!itemId) return err('say what to cancel');
    const loaded = new Set(this.van?.orders ?? []);
    const mine = this.orders.pending.filter((o) => o.item_id === itemId);
    if (!mine.length) return err('nothing of that on order');
    const free = mine.filter((o) => !loaded.has(o.id));
    if (!free.length) return err('that is already on the van');

    const back = round2(free.reduce((n, o) => n + (o.cost ?? 0), 0));
    const qty = free.reduce((n, o) => n + (o.qty ?? 0), 0);
    const drop = new Set(free.map((o) => o.id));
    this.orders.pending = this.orders.pending.filter((o) => !drop.has(o.id));
    this.cash = round2(this.cash + back);
    this.stats.spent = round2(Math.max(0, this.stats.spent - back));
    // A staff order cancelled gives the day's cap its money back too, or an
    // afternoon of ordering and cancelling would leave the crew unable to buy
    // anything with nothing to show for it.
    this.orders.spent = round2(Math.max(0, (this.orders.spent ?? 0) - back));

    const still = mine.length - free.length;
    this.persist();
    this.logGoods(null, {
      pre: 'Cancelled ',
      post: ` — $${back.toFixed(2)} back.${
        still ? ` ${still} lot already on the van is still coming.` : ''}`,
      goods: [{ item_id: itemId, qty }],
    });
    return ok({ cancelled: qty, refund: back, onVan: still });
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
   * The comparison is strict, so an order placed at exactly 09:00 is on the
   * 10:00 van rather than the one pulling away. That is the cutoff doing its
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
    // **Every crate standing there, rubbish included**, and that is the one line
    // in here that is a `stockCrates()` on purpose reversed. Everywhere else in
    // the game rot must not read as supply — `homeSupply` reordering what just
    // went off is the `inACar` trap `verify:bin` sweeps ten loops for — but this
    // is not a question about supply. It is a question about SPACE, and a box of
    // rot occupies a cell exactly as hard as a box of bread.
    //
    // The two claims sit together without contradiction, which is why the cell
    // test stays: rot lands where the food was, so rubbish that is not on the
    // pad still takes none of the pad's room. What is fixed is only rubbish that
    // IS on it.
    for (const d of this.deliveries) {
      if (bay.cells.some((c) => c.x === d.x && c.z === d.z)) used += lotTotal(d);
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
    // Rubbish included, for `bayRoom`'s reason — this is space, not supply. It
    // is the half that actually bit: a live shop had **all four** drop-off cells
    // standing under boxes of rot while this answered 45 units free, so the gate
    // the farm and the kitchen are held on was reading a buffer that was not
    // there.
    for (const d of this.deliveries) {
      if (pad.cells.some((c) => c.x === d.x && c.z === d.z)) used += lotTotal(d);
    }
    return Math.max(0, pad.cells.length * this.crateCapacity() - used);
  }

  /**
   * ...and the same question asked of the WHOLE shop, which is the one nobody
   * was asking.
   *
   * `bayRoom` and `padRoom` are both about a region, and each is right about the
   * thing it guards — where a van may unload, how much the farm may buffer.
   * Between them they leave a hole the size of the shop floor: a crate that is
   * not standing on either pad is counted by neither, and there is no rule
   * anywhere that a crate has to be on a pad. A stripped shelf leaves its goods
   * where the shelf stood. An armful put down lands under your feet. A hire who
   * cannot reach a pad keeps hold of it and tries again somewhere else.
   *
   * So the brake had a hole in it that widened the worse things got, and the
   * failure is not subtle once you look: a live shop on day 116 had **381 units
   * in twenty-one crates against 292 on the shelves** — more stock on the ground
   * than in the building — while `bayRoom` reported sixteen units of room and
   * the supplier went on buying, twenty-four runs a day. Every individual answer
   * was correct. `homeSupply` was right that the shop had no ice cream; the bay
   * was right that it had room for sixteen more. Nothing was asking whether the
   * shop was already drowning.
   *
   * **The limit is the yard you painted**, both pads together, which is the
   * sentence the pads have made since they became ground: how big you paint it
   * is how much it holds. What is new is that it is now measured against
   * everything loose *wherever it is standing*, so tidying stock into an aisle
   * stops the ordering the same way filling the bay does.
   *
   * That last part is a real cost and worth saying out loud, because `bayRoom`
   * explicitly declines to pay it — "counting them would mean tidying your own
   * goods into the yard stopped you being able to order." Right, and the reason
   * it is right there and wrong here is the difference between a *region* test
   * and a *total*: the bay refusing a van because you parked an armful on it is
   * a wholesaler complaining about your housekeeping, while the shop refusing to
   * buy a twenty-second crate when twenty-one are already on the floor is the
   * shop noticing it has nowhere to put anything. If you genuinely want the
   * stock, paint more storage — the same answer the farm and the kitchen get.
   */
  looseRoom() {
    const cells = (this.layout.bay?.cells?.length ?? 0) + (this.dropPad()?.cells?.length ?? 0);
    // No yard at all is not "no room" — a shop with neither pad is refused by
    // `buyStock`'s own bay guard, which says something useful, and answering
    // zero here would shadow it with a worse message.
    if (!cells) return Infinity;
    let used = 0;
    // Everywhere, which is the whole point — no cell test. Rubbish counts here
    // too, and for `bayRoom`'s reason rather than in spite of it: an order has
    // to land somewhere, and a yard under boxes of rot has nowhere whether or
    // not those boxes are sellable. The refusal names both, because "shelve
    // some" is no use to somebody whose problem is the tip.
    for (const d of this.deliveries) used += lotTotal(d);
    // What is on the van counts too, for `bayRoom`'s reason: six orders placed
    // in one tick would otherwise each pass a test against the floor as it was
    // before any of them landed.
    for (const o of this.orders.pending) used += o.qty ?? 0;
    return Math.max(0, cells * this.crateCapacity() - used);
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
   * Where a van of *this shape* has to halt so its nose ends at the edge of the
   * pad rather than on top of it.
   *
   * **It backs in**, which is the half that decides everything else. A vehicle
   * is authored nose-east, so the load bed is the `-x` end of it — the cab and
   * the windscreen are at `+x`. Driving in nose-first therefore presents the
   * cab to the pad and unloads the shopping out of the *bonnet*: the crates
   * appear behind the one part of the lorry they cannot have come out of. So
   * the last leg is reversed, which is what a lorry at a loading bay actually
   * does, and it costs no manoeuvre at all — the corner is still a 90° turn off
   * the ring, just the other way round, and pulling out afterwards is a straight
   * drive forward with no turn on the spot at either end.
   *
   * `vanRoute` stops one cell short of the bay, and the reason is in its own
   * comment: goods land on the pad, and a van parked on the crates it has just
   * put down is a picture of the wrong thing. One cell was the whole of that
   * promise for as long as a lorry was 1.56 tiles long — it overhung the pad by
   * a fifth of a tile and nobody could see it. The models are vehicle-sized now
   * (2.73 × 1.29), the anchor is nowhere near the middle, and the same lane
   * parks the thing three quarters of the way across the crates.
   *
   * So the setback is **measured off the art** (`modelExtent`, over every stage
   * so a full van and an empty one stop in the same place) rather than being a
   * second constant somebody has to remember to move. It is measured off the end
   * that arrives — the tail, since it reverses — and a vehicle drawn shorter
   * than half a tile of it gets no setback at all and stops exactly where it
   * always did.
   *
   * It is here rather than in `vanRoute` because a lane is a property of the
   * *shop* — whole tiles, computed once per re-flow, and asserted as whole tiles
   * by `verify:park` — while how long the lorry is is a property of the
   * **vehicle**, which is content and is not known until one is sent out.
   *
   * And none of it applies when the last leg does not drive *into* the pad. A
   * bay hard against the border ring collapses the lane's turn (see `laneVia`):
   * the van comes along the ring and halts beside the pad rather than end-on to
   * it, so there is nothing to reverse into and backing it off would only stop
   * it short of the crates it came for.
   *
   * @returns {{x, z, back: number|null}} where to halt, and the heading to hold
   *   on the final leg — null for "whatever driving there leaves you pointing".
   */
  vanStop(lane, row, pad) {
    const dock = lane.dock;
    const prev = lane.in[lane.in.length - 2];
    if (!prev) return { ...dock, back: null };
    // The direction of travel on the final leg. Every leg is axis-aligned, so
    // this is a unit axis vector and one of the two is always zero.
    const dx = Math.sign(dock.x - prev.x);
    const dz = Math.sign(dock.z - prev.z);
    const ahead = { x: dock.x + dx, z: dock.z + dz };
    if (!pad?.cells?.some((c) => c.x === ahead.x && c.z === ahead.z)) {
      return { ...dock, back: null };
    }
    // How far the bed sticks out behind the anchor. Half a tile of the setback
    // is the cell the van is standing on; everything past that is over the pad.
    const tail = -modelExtent(row.model).minX;
    const off = Math.max(0, tail - 0.5);
    return {
      x: dock.x - dx * off,
      z: dock.z - dz * off,
      // Facing AWAY from the pad, in `followPath`'s spelling — the same
      // `atan2(dx, dz)` a walker's heading is, so the renderer's easing turns
      // this lorry the way it turns everything else.
      back: Math.atan2(-dx, -dz),
    };
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
    // Where it actually halts, and which way round it does it — see `vanStop`.
    // Both directions get the position: the way out begins where it stood.
    const { back, ...stop } = this.vanStop(lane, row, pad);
    this.van = {
      vehicle: row.id,
      x: start.x,
      z: start.z,
      facing: 0,
      // `followPath` eats this array from the front, so it is a copy of the
      // lane rather than the lane itself — the layout's route is read by every
      // van that ever comes.
      path: [...lane.in.slice(1, -1), stop].map((p) => ({ ...p })),
      // ...and its way home is taken now rather than looked up on the way out:
      // a re-flow between arriving and leaving would otherwise hand the van a
      // route computed for a shop it is standing in the wrong version of.
      out: [stop, ...lane.out.slice(1)].map((p) => ({ ...p })),
      // Which lane it is on, kept so a re-flow can ask whether that lane is
      // still the lane. See the tail of `regenerateLayout`. It is the lane's
      // own whole-tile dock rather than `stop`, and deliberately: this is an
      // identity, not a position, and comparing a setback measured off the art
      // against a cell the generator picked would make every re-flow look like
      // a lane that had moved.
      dock: { ...lane.dock },
      // The heading it holds down the last leg, or null. A field rather than a
      // flag `followPath` reads, because `followPath` is what people walk with
      // and a pedestrian who reverses is nothing anybody wants — see `driveVan`
      // for the one line that applies it.
      back,
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
      const arrived = followPath(v, speed, dt);
      // Reversing down the drive. `followPath` faces everything the way it is
      // travelling, which is right for the ring leg and exactly wrong for the
      // last one — a lorry that noses into a loading bay unloads out of its
      // bonnet. Applied after the step rather than instead of it, so the corner
      // is an ordinary 90° turn the renderer eases through and the arrival tick
      // (which sets no heading at all) keeps what it had. See `vanStop`.
      if (v.back != null && v.path.length <= 1) v.facing = v.back;
      if (!arrived) return;
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

    for (const o of run) this.dropGoods(o.item_id, o.qty, pad);
    // One line for the run, not one per order. That is the whole point of a
    // run: everything asked for before the cutoff turns up together, and a log
    // that said it six times would read as six vans.
    //
    // It said "42 units across 6 orders", which is arithmetic rather than
    // news — it counted the paperwork instead of naming the goods, so the one
    // question you have standing at a bay ("what turned up?") was answered by
    // walking over and looking in the crates. `logGoods` is called per order and
    // merges, which also folds two orders of the same item into one chip.
    //
    // Named by its RUN, the same hour `buyStock` promised you when you ordered:
    // two vans a day means "the van's here" is ambiguous the moment you have
    // ordered off both of them.
    const hour = run.find((o) => o.runHour != null)?.runHour;
    this.logGoods(null, {
      pre: hour != null ? `The ${hourLabel(hour)} van's here — ` : "The van's here — ",
      post: ' at the bay.',
      goods: run.map((o) => ({ item_id: o.item_id, qty: o.qty })),
    });
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
   *
   * **...and it holds up to `CRATE_KINDS` of them.** Which is the half that
   * was missing for as long as a crate was `{ item_id, qty }`: a four-crop
   * harvest was four boxes on four cells, none of them a third full, and four
   * separate journeys to shift what one box would hold. A crate is a `lot` now
   * — a shelf's `stacks` said about a thing you can pick up — so the merge
   * below looks for a box with room *and* either a stack of this or a board
   * free for one. The kinds cap is what stops the merge going all the way: one
   * crate absorbing the whole yard is the same bug as one crate swallowing a
   * delivery, and it would take the pad's size with it.
   */
  dropGoods(itemId, qty, at, { exact = false } = {}) {
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

    // Top up crates already standing in this area rather than building a little
    // forest of one-unit pallets — but only to the brim, which is what stops the
    // merge going the other way and swallowing a whole delivery into one box.
    // Membership rather than a radius, because a radius around one point is the
    // wrong shape for a room — the far end of a big stockroom is still the
    // stockroom.
    // ...and never into the rubbish. `dropWaste` refuses to merge the other
    // way for the obvious reason — rot in a crate of bread — and this is the
    // same claim from the side that would actually happen: a stocker tidying an
    // armful down beside yesterday's spoilage would otherwise pour good goods
    // into the box the binman is about to walk to the skip. One flag, both
    // directions, or the conservation hole is a job doing its work correctly.
    //
    // ...unless you NAMED the square, which is what `exact` says. The 2.2 is
    // right for a drop that happened to you — a bed's surplus, a stripped
    // shelf, a hopper tipped out — where the alternative is a forest of
    // one-unit pallets down a row of beds. It is exactly wrong for a setdown
    // you aimed: pointing at the tile beside a crate and watching the goods go
    // INTO that crate is the game overruling the only instruction you gave it,
    // and sorting a mixed armful into separate boxes becomes impossible. The
    // ghost already draws the distinction — the square you pointed at is the
    // square it lights.
    const here = (d) => !d.waste && (slots.some((s) => s.x === d.x && s.z === d.z)
      || (!exact && Math.hypot(d.x - at.x, d.z - at.z) <= 2.2));

    const opts = this.crateLot();
    let left = Math.round(qty);
    let first = null;

    // A box already holding some of this beats an empty board in another box,
    // and both beat opening a new crate. Two passes rather than one sort: the
    // ordering is the point — filling the tomato box you already have is what
    // keeps a crate readable, while spending a free board is what makes mixing
    // worth having, and doing them in the other order scatters one kind across
    // every box on the pad.
    for (const pass of [true, false]) {
      for (const d of this.deliveries) {
        if (left <= 0) break;
        if (!here(d)) continue;
        if (lotHas(d, itemId) !== pass) continue;
        const res = lotAdd(d, itemId, left, opts);
        if (!res.added) continue;
        d.stacks = res.lot.stacks;
        this.stampPile(d, itemId);
        left -= res.added;
        first = first ?? d;
      }
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
      const take = Math.min(opts.cap, left);
      const del = {
        id: `del-${n}`,
        // The lot, in the shape a shelf spells it. `item_id`/`qty` are gone
        // rather than kept alongside as a convenience for the single-kind case:
        // a mirror field is right until the day a box holds two things, and then
        // every reader that never learned about the second one goes quietly
        // wrong — which for a counting loop is a shop that re-orders stock it
        // already owns. See the note on `countOnFloor`.
        stacks: lotOf(itemId, take).stacks,
        x: r2(spot.x),
        z: r2(spot.z),
      };
      this.stampPile(del, itemId);
      this.deliveries.push(del);
      left -= take;
      first = first ?? del;
    }

    return first;
  }

  /**
   * When this pile of goods was put in the box.
   *
   * The spoilage clock, and it lives on the PILE rather than on the crate. It
   * had to move the day a crate could hold two things: a mixed box stands
   * yesterday's lettuce beside a fortnight of flour, and one stamp on the box
   * has to answer for both — round one way the flour rots in three days, round
   * the other the lettuce never does.
   *
   * The older stamp always wins a merge, which is the direction that cannot be
   * gamed. Topping a three-day-old pile up with one fresh unit must not restart
   * it, or the way to beat spoilage is to walk one lettuce to the yard every
   * morning — and the yard was brought under spoilage precisely because
   * "leave it in a crate" was the dodge.
   */
  stampPile(lot, itemId) {
    const pile = (lot.stacks ?? []).find((s) => s.item_id === itemId);
    if (!pile) return;
    pile.day = Math.min(pile.day ?? this.day, this.day);
  }

  /**
   * Put a whole LOT down — every pile in it, at one spot.
   *
   * `dropGoods` takes one item and one number, which was the whole of what a
   * pair of hands could ever be. Now that hands hold three kinds, every caller
   * that used to write `dropGoods(p.carry.item_id, p.carry.qty, at)` would drop
   * whichever pile that pair of fields happened to name and bin the other two —
   * and every one of those callers is a conservation hole by construction:
   * leaving the game, being fired, a save being restored, an armful put down.
   * CLAUDE.md lists them for exactly this reason, and each is invisible except
   * as a shop that is quietly poorer.
   *
   * So it is a verb of its own rather than a loop written out four times, and
   * `dropGoods` stays the single place a crate is made.
   */
  dropLot(lot, at, opts) {
    let first = null;
    for (const s of lotStacks(lot)) {
      const made = this.dropGoods(s.item_id, s.qty, at, opts);
      first = first ?? made;
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
   * The two caps a crate is bound by, in the shape `shared/lot.js` asks for.
   *
   * One function rather than two numbers at every call site, because room for
   * four units and no free board is room for zero — a caller that checked only
   * the units would promise a merge the crate then refuses, which is the green
   * ghost bug wearing a cardboard box.
   */
  crateLot() {
    return { cap: this.crateCapacity(), kinds: CRATE_KINDS };
  }

  /** ...and the same pair for a pair of hands, which a rucksack still moves. */
  carryLot(p = null) {
    return { cap: this.carryCapacity(p), kinds: CARRY_KINDS };
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
   *
   * `want` names the pad, and it exists for exactly one caller: a hire crating
   * up a line the shop has stopped stocking walks to the BAY (`Game.dropAt`),
   * and would then be told to take it round to the drop-off by the very
   * function it walked there to call. It defaults to null, which is the
   * drop-off and is every other caller including yours — being sent to the bay
   * because of a judgement the shop made about its own range is the one thing
   * this verb has never done to the player's hands.
   */
  stow(playerId, want = null) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    if (!p.carry) return err('nothing in hand');
    const kind = want === 'bay' && this.layout.bay ? 'bay' : this.dropPadKind();
    const pad = kind === 'bay' ? this.layout.bay : this.dropPad();
    if (!pad) return err('nowhere to put it down — lay some storage first');
    if (!this.onPad(p, kind)) {
      return err(kind === 'bay' ? 'take it round to the bay' : 'take it round to the drop-off');
    }

    const qty = lotTotal(p.carry);
    const itemId = lotMain(p.carry).item_id;
    // The whole armful, every pile of it. `dropGoods` still decides which cells
    // the crates stand on — the pad goes in as a REGION, which is the ordering
    // that makes a stow fill the yard rather than one tile.
    this.dropLot(p.carry, pad);
    p.carry = null;
    // No log line. Staff `putDown` comes through here for every armful it
    // crates up, so the feed filled with a shop working normally — and the
    // crate appearing on the pad already says it, for a hire and for you.
    // The feed is for what you would otherwise miss.
    return ok({ stowed: qty, item_id: itemId });
  }

  /**
   * One unit off one board, into your hands, on a quick tap.
   *
   * The shelf's `tapCrate`, and it draws the same line a lone crate does: **a
   * tap is one, a hold is the box.** A board only had the box, so the finest
   * thing anybody could ask a shelf for was an armful, and "one loaf" meant
   * taking six and putting five back.
   *
   * It has to spend the errand for the reason `tapCrate` spells out at length:
   * the press that opened this gesture armed a *pull* on the way down — that is
   * what lets one press be either — so a tap that left it standing would empty
   * the next board you held anything near into a crate.
   *
   * **And a release that ends a pull is not a tap**, which is the one thing
   * here that is not obvious. The client rules a press a hold at 420ms, and a
   * pull of a nearly-empty board hands over its first unit before that — so a
   * short hold on a board of three sends this as well, and you would get the
   * board in a crate AND a loaf in your hand from one press. `pulling` is the
   * test the client cannot make: it knows whether goods have actually crossed
   * under this button. Swallowed rather than refused — nothing went wrong, the
   * press simply already meant something.
   *
   * `say: false` for the same reason a rummage says nothing: the unit landing
   * in your hands is the message, and a tap is a thing you do six times.
   *
   * **`put` is the other direction, and it is SAID rather than inferred** —
   * `tapCrate`'s sentence, said about a shelf, and now the rule everywhere goods
   * move: left takes, right puts. Read off your hands instead ("holding some of
   * that? then this must mean putting it back") the same press means opposite
   * things depending on state you are not looking at, so plucking one more loaf
   * off a board while carrying five would quietly hand one back.
   *
   * Which pile is `itemId` both ways round and it addresses different ends: on a
   * take it is the board you pointed at, on a put it is the pile in your HANDS,
   * falling back to the biggest — because a put cannot mean "convert", and the
   * board that ends up holding it is `boardFor`'s answer rather than the one
   * under the pointer. Point at the bread with milk in your hands and the milk
   * goes on the unit, on whichever board will have it.
   */
  tapBoard(playerId, shelfId, itemId, put = false) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    // Ahead of the pull, which cannot be running anyway: a hold that spans ticks
    // needs an errand, and no errand is armed while the mode is on.
    const busy = this.notWhileBuilding(p);
    if (busy) return busy;
    if (this.pulling(p)) return ok({ took: 0, item_id: itemId, pulled: true });

    if (put) {
      const shelf = this.layout.shelves.find((s) => s.id === shelfId);
      if (!shelf) return err('no such shelf');
      if (!near(p, shelf)) return err('too far from that shelf');
      // **Both places goods can be**, which is the trap `p.haul` sets for every
      // verb written before it existed: a crate is not a `carry`, so a put that
      // only read your hands answered "nothing in hand" to somebody standing
      // there with a box on their shoulder. The hold has always poured a crate
      // (`stockFromCrate`); it was only the tap that could not.
      const from = p.carry ?? p.haul;
      if (!from) return err('nothing in hand');
      const give = itemId && lotHas(from, itemId) ? itemId : lotMain(from).item_id;
      // One unit, through the same funnel an armful goes through. `pourInto` is
      // where a board is chosen, a reservation binds and a freezer refuses
      // bread, and a second spelling of any of that here is the drift
      // `stockShelf` and `stockFromCrate` were folded together to avoid.
      const res = this.pourInto(shelf, { stacks: [{ item_id: give, qty: 1 }] }, 1);
      if (!res.moved) return res.refusal;
      const left = lotTake(from, give, 1).lot;
      if (p.carry) p.carry = left;
      // A crate emptied to nothing stops being on your shoulder, the same way
      // `unload` leaves one on the floor — a box with no goods in it is a thing
      // you would then have to put down before you could do anything else.
      else p.haul = lotTotal(left) > 0 ? left : null;
      p.errand = null;
      p.action = null;
      return ok({ stocked: 1, item_id: give, price: res.price });
    }

    const res = this.unshelve(playerId, shelfId, itemId, { max: 1, say: false });
    if (!res.ok) return res;
    this.endPull(p);
    p.errand = null;
    p.action = null;
    return res;
  }

  /**
   * A machine you are standing at, tapped. Left takes the tray, right puts one
   * ingredient in.
   *
   * `tapBoard` said about an appliance, and it exists because a station is not a
   * shelf and both buttons had only ever learned about shelves. **The right
   * button** sent `shelf-one` at a fixture `layout.shelves` has never heard of,
   * so what came back was **"no such shelf"** — an error naming a thing you were
   * not pointing at, about a gesture that works one press either side of it. The
   * hold poured the armful in the whole time, which is what made it read as
   * feeding being all-or-nothing rather than as a hole. Same shape the skip left
   * when it fell through that branch.
   *
   * **The left button** had the opposite problem and it was quieter: a machine
   * with a batch ready is `readyToTake`, so a tap sent you to walk to it — and
   * standing there already, that walk is a no-op. What you saw was a tray of
   * finished food, a press that visibly did nothing, and the goods only moving
   * once you held the button down. The same thing `tapBoard` says about a board
   * you are stood at: sending the errand again is a press with nothing to show
   * for it.
   *
   * **One unit either way, and the hold is the lot either way** — the grade a
   * crate and a shelf board already draw, and the machine is not a good place to
   * make an exception to it. In, it is what a recipe wants: one of each, rather
   * than six loaves into a press that takes four and four loaves you then tip
   * the machine up to get back. Out, it is one portion off the tray, and the
   * hold is still there for the whole batch — which is the press you actually
   * want, since emptying the tray is what frees the machine to start the next
   * one (`stationOutputRoom`).
   *
   * The reach test is here rather than in `collectStation`, which has never made
   * one: every caller it had was already standing there — a hire who walked,
   * `actionAt`'s ring, `interact`'s proximity — and a message is not.
   */
  tapStation(playerId, stationId, put = false) {
    const p = this.players[playerId];
    const st = (this.layout.stations ?? []).find((s) => s.id === stationId);
    if (!p || !st) return err('no such appliance');
    const busy = this.notWhileBuilding(p);
    if (busy) return busy;
    if (!near(p, st.useAt, REACH) && !near(p, st, REACH)) return err('too far from it');
    // Hands, else the crate on your shoulder — the same order `actionFor` puts
    // them in, so a tap and a hold on the same machine draw from the same place.
    const res = put
      ? this.loadStation(playerId, stationId, { max: 1, from: p.carry ? 'carry' : 'haul' })
      : this.collectStation(playerId, stationId, { max: 1 });
    // Spent whether or not it worked, the same as every other tap: the press
    // that opened this gesture armed the hold on the way down (that is what
    // lets one press be either), so a tap that left the errand standing would
    // empty your hands into the next machine you walked past.
    p.errand = null;
    p.action = null;
    return res;
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
   * ONE, not an armful. `unload` is the armful and it is what a tap on a crate
   * you have to walk to arms; this is the fine-grained one, so a lone crate
   * grades properly: a tap is a unit, a hold is the box.
   *
   * And only ever a LONE crate. In a pile there is one thing a crate can be —
   * see `crateStacked` — so this refuses, and the gesture that used to send it
   * takes the top box off instead.
   */
  tapCrate(playerId, crateId, put = false, itemId = null) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    const busy = this.notWhileBuilding(p);
    if (busy) return busy;
    if (p.haul) return err('put the crate down first');

    const crate = crateId
      ? this.deliveries.find((d) => d.id === crateId)
      : this.nearest(this.deliveries, p, UNLOAD_REACH);
    if (!crate) return err('no crate here');
    if (!near(p, crate, UNLOAD_REACH)) return err('too far from the crate');
    // A pile is boxes only — see `crateStacked`. Both directions, because one
    // unit into the crate under two others is the same unanswerable "which one"
    // as one unit out of it, and the client aims the top box of a pile rather
    // than sending this at all.
    if (this.crateStacked(crate)) return err('it is in a stack — take the top crate off first');

    const items = content().byId.items;

    // Rummaging replaces whatever you had named. The press that opened this
    // gesture armed a lift on the way down — that is what lets one press be
    // either — so a tap has to spend it, or the lift sits there waiting and the
    // next time you hold anything near this crate you shoulder it instead.
    p.errand = null;
    p.action = null;

    /**
     * Which pile in the box this is about.
     *
     * Named by the pointer wherever there is one — a crate holding three things
     * is three piles at one address, exactly as a shelf is, and `pickAim`
     * answers it for both the same way. Unnamed falls back to the biggest
     * stack, which is what a gesture that did not say means and what a glance
     * would have picked anyway.
     *
     * Putting one back reads the pile off your HANDS instead, because that is
     * the end the unit is leaving from and a rummage cannot mean "convert".
     */
    if (put) {
      if (!p.carry) return err('nothing in hand to put back');
      const give = itemId && lotHas(p.carry, itemId) ? itemId : lotMain(p.carry).item_id;
      const name = items[give]?.name ?? give;
      if (lotRoom(crate, give, this.crateLot()) <= 0) {
        // Two different noes, and saying which is the whole use of the message:
        // a full box is "come back later", a box with no board left for this is
        // "that one is spoken for", and they want opposite things from you.
        return lotTotal(crate) >= this.crateCapacity()
          ? err('that crate is full')
          : err(`that crate has no room left for ${name}`);
      }
      crate.stacks = lotAdd(crate, give, 1, this.crateLot()).lot.stacks;
      p.carry = lotTake(p.carry, give, 1).lot;
      return ok({ put: 1, item_id: give, left: lotTotal(p.carry) });
    }

    // ...and taking one out.
    if (lotTotal(crate) <= 0) return err('that crate is empty');
    const take = itemId && lotHas(crate, itemId) ? itemId : lotMain(crate).item_id;
    if (lotRoom(p.carry, take, this.carryLot(p)) <= 0) {
      const name = items[take]?.name ?? take;
      // The old refusal here was "hands full of X, put it down first", which
      // said the only thing single-kind hands could mean. Mixed hands have the
      // other no as well \u2014 room for four more units and no free hand for a
      // fourth KIND \u2014 and they are not the same instruction.
      return lotTotal(p.carry) >= this.carryCapacity(p)
        ? err('hands full')
        : err(`no free hand for ${name} \u2014 put something down first`);
    }
    const out = lotTake(crate, take, 1);
    crate.stacks = out.lot?.stacks ?? [];
    p.carry = lotAdd(p.carry, take, out.took, this.carryLot(p)).lot;
    // A crate emptied to nothing stops existing, exactly as `unload` leaves it.
    // Two spellings of "the box is gone" would be a pile that keeps a ghost in
    // it, and the renderer stacks by what is in `deliveries`.
    if (lotTotal(crate) <= 0) this.deliveries = this.deliveries.filter((d) => d.id !== crate.id);
    return ok({ took: 1, item_id: take, left: lotTotal(crate) });
  }

  /**
   * Is this the crate you could actually get hold of — nothing standing on it?
   *
   * A pile is drawn oldest at the bottom, by id, so "on top" is "no crate of a
   * higher id on this tile". Taking one out from underneath would drop the
   * tower through the floor, and it is also just not a thing you can do.
   *
   * Asked in two places and that is the point. `liftCrate` refuses on it,
   * because a verb has to defend itself; `errandAction` *chooses* on it, so an
   * aim at a buried crate arms nothing rather than arming a refusal.
   */
  crateOnTop(crate) {
    const n = (d) => Number(String(d.id).slice(4)) || 0;
    return !this.deliveries.some((d) => d.id !== crate.id
      && Math.round(d.x) === Math.round(crate.x)
      && Math.round(d.z) === Math.round(crate.z)
      && n(d) > n(crate));
  }

  /**
   * ...and is it in a pile at all?
   *
   * The line between the two things a crate can be. On its own, a crate is a
   * container: reach in for an armful, or shoulder the box. In a pile it is only
   * ever a box, because "which of these do you mean" cannot be answered by a
   * pointer — a crate is a fifth of a tile tall and the buried ones show a band
   * of about a dozen pixels, so item-level access to a stack was always the
   * wrong crate's contents. Peel the top one off and what is under it is a crate
   * on its own again, which is the same answer arrived at by moving the shop
   * rather than by reading a list.
   */
  crateStacked(crate) {
    return this.deliveries.some((d) => d.id !== crate.id
      && Math.round(d.x) === Math.round(crate.x)
      && Math.round(d.z) === Math.round(crate.z));
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

    // A buried crate used to be refused here, on the grounds that taking one out
    // from underneath drops the tower through the floor. It does not: the
    // renderer stacks by id per tile, so the boxes above simply settle a step —
    // and refusing meant the crate you had *pointed at* was the one thing you
    // could not have. Pointing is how everything else in this shop is chosen, and
    // a pile of four boxes is four separate things you can see and aim at. Which
    // one you get is which one you picked, not which one is easiest.
    //
    // Staff go on taking the top one only (`crateOnTop`, in `staff.js`), and that
    // stays: a hire choosing a buried crate is a hire whose reach is decided by a
    // job loop rather than by a pointer, and the top of the pile is the answer
    // that needs no aim.

    this.deliveries = this.deliveries.filter((d) => d.id !== crate.id);
    // The box goes onto the shoulder exactly as it stood — every pile, and the
    // spoilage stamp on each. Rebuilding it from one item and one number is how
    // a mixed crate would arrive at the shelves as whichever pile was biggest,
    // with the other two gone and nothing to say where.
    p.haul = { stacks: lotStacks(crate) };
    const lifted = lotTotal(p.haul);

    // Rummaging replaces whatever you had named. The press that opened this
    // gesture armed a lift on the way down — that is what lets one press be
    // either — so a tap has to spend it, or the lift sits there waiting and the
    // next time you hold anything near this crate you shoulder it instead.
    p.errand = null;
    p.action = null;
    return ok({ lifted, item_id: lotMain(p.haul)?.item_id ?? null, items: lotStacks(p.haul) });
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

    const qty = lotTotal(p.haul);
    const itemId = lotMain(p.haul).item_id;
    // `exact`: the square you pointed at is the square it lands on, and a crate
    // one tile over is a different crate. See `dropGoods`.
    this.dropLot(p.haul, at, { exact: true });
    p.haul = null;
    return ok({ dropped: qty, item_id: itemId, at });
  }

  /**
   * ...and the same thing with what is in your HANDS.
   *
   * `stow` was the only way to let go of an armful, and it insisted on the
   * drop-off: your hands were full until you had walked them across the shop,
   * which made picking anything up a commitment rather than a move. There is
   * nothing about six loaves that needs a painted pad — `dropGoods` puts a crate
   * on any tile, which is what a stripped shelf and an emptied hopper already do
   * — so the pad stopped being a rule and went back to being what it is: the
   * place crates are *tidy*, where they fill the cells you painted and a stocker
   * comes and finds them.
   *
   * Its own verb rather than a branch in `dropCrate`, for the reason `haul` is
   * its own field: everything that accounts for hands has to keep asking about
   * hands. Sharing one function means one of the two callers reads the wrong
   * field, and getting that wrong is a conservation hole rather than a bug you
   * can see — the goods would be on the floor *and* still in your arms.
   *
   * Same two guards as `dropCrate`, and the walk grid is the right test for both
   * halves at once: the ground is walkable AND nothing is standing on it, so an
   * armful cannot be posted into a shelf you happen to be facing.
   */
  dropCarry(playerId, x = null, z = null) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    if (!p.carry) return err('nothing in hand');

    const at = { x: Math.round(x ?? p.x), z: Math.round(z ?? p.z) };
    if (!isWalkable(this.walk, this.layout, at.x, at.z)) {
      return err('nothing to stand a crate on there');
    }
    if (Math.hypot(at.x - p.x, at.z - p.z) > UNLOAD_REACH) return err('too far to reach');

    const qty = lotTotal(p.carry);
    const itemId = lotMain(p.carry).item_id;
    // One tile, so `dropGoods` gets a point rather than a region — three piles
    // put down together share the cell and stack, which is what a pile of boxes
    // on one square already means and what `pickPallet` picks apart by height.
    // `exact`, for the reason `dropCrate` gives: a named square is an
    // instruction, and a crate two tiles away must not answer it.
    this.dropLot(p.carry, at, { exact: true });
    p.carry = null;
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
   *
   * `max` is the tap's half of the grade every goods gesture in the shop draws —
   * **a tap is one unit, a hold is the lot** — and it is a bound on this funnel
   * rather than a second verb for the same reason `pourInto` is one function: a
   * hopper's rules about what a recipe wants, what is already in there and what
   * to say when it will not fit are the interesting part, and a one-unit path
   * that reimplemented them would drift from this one the day a recipe changed.
   *
   * Which pile a bounded load takes from is deliberately NOT a parameter, which
   * it is on every other one-unit verb in the game. Those are answered by the
   * pointer — a shelf's stock is drawn as itself, so `pickFixtureHit` can hand
   * back the board you meant — and a hopper's contents are not pointable at all:
   * the piles are inside the machine. So there is nothing to name it with, and a
   * hint nothing could ever set is the dead knob CLAUDE.md keeps warning about.
   * Mixed hands drain in `lotStacks` order, one tap at a time, which is a thing
   * you can watch happen and repeat.
   *
   * `from` is which hand — `'carry'` or `'haul'`. A crate on the shoulder is
   * goods looking for somewhere to be exactly as much as an armful is, and this
   * function reading only `p.carry` meant a machine offered NOTHING while you
   * were carrying a box of what it wanted: no action armed, no refusal, no
   * message. What that reads as is a machine that has stopped working. The
   * shelves learned this when hauling was added (`stockFromCrate` pours a crate
   * straight onto a board); the hopper was the one place that did not, so
   * feeding a machine out of a crate meant setting the box down, taking an
   * armful out of it, loading, and picking the box back up.
   *
   * A parameter rather than a second verb, for the reason `max` is one: what a
   * recipe wants, what is already in the hopper and what to say when it will not
   * fit is the interesting part, and a second copy of it would drift.
   */
  loadStation(playerId, stationId, { max = Infinity, from = 'carry' } = {}) {
    const p = this.players[playerId];
    const st = (this.layout.stations ?? []).find((s) => s.id === stationId);
    if (!p || !st) return err('no such appliance');
    if (!near(p, st.useAt, REACH) && !near(p, st, REACH)) return err('too far from it');
    const held = p[from];
    if (!held) return err(from === 'haul' ? 'no crate to empty' : 'nothing in hand');

    // Only accept things the recipe it is SET TO wants — otherwise the hopper
    // fills with ingredients for a recipe it isn't making, which can never come
    // out except by tipping the whole machine up. It was every recipe's inputs
    // while the machine chose for itself; now that you choose, a refusal here is
    // the machine telling you it is set to the other thing.
    const recipe = this.stationRecipe(st);
    if (!recipe) return err(`no recipes for the ${st.station} yet`);

    /**
     * Every pile the recipe wants, in one press — which is the thing mixed
     * hands are for on this end of the shop. A soup needs three ingredients,
     * and a pair of hands that could only hold one of them meant three walks
     * from the yard to the same machine, so the hopper filled at a third of the
     * speed a person can actually work at.
     *
     * The piles it has no use for stay in your hands rather than refusing the
     * lot. That is the same call the partial load below already made about a
     * hopper with room for three when you are holding four — a refusal you
     * have to do arithmetic to avoid is a refusal that reads as broken.
     */
    const wanted = lotStacks(held).filter((s) => recipe.inputs.some((i) => i.item_id === s.item_id));
    if (!wanted.length) {
      const name = lotLabel(held, content().byId.items);
      return err(`the ${st.station} is making ${recipe.name} — no use for ${name}`);
    }

    let moved = 0;
    let full = null;
    for (const s of wanted) {
      if (moved >= max) break;
      const room = this.stationHopperRoom(st, s.item_id);
      if (room <= 0) { full = full ?? s.item_id; continue; }
      const take = Math.min(s.qty, room, max - moved);
      st.contents[s.item_id] = (st.contents[s.item_id] ?? 0) + take;
      p[from] = lotTake(p[from], s.item_id, take).lot;
      moved += take;
    }
    if (!moved) {
      const name = content().byId.items[full]?.name ?? full;
      return err(`the ${st.station} is full of ${name}`);
    }
    return ok({ loaded: moved, station: st.id, contents: { ...st.contents } });
  }

  /**
   * Take the finished product out.
   *
   * `max` is the tap's half of the grade, and a bound on this funnel rather than
   * a verb of its own for `loadStation`'s reason: what a tray will give up, what
   * your hands have room for and what to say when they have none is the
   * interesting part, and a one-unit path that reimplemented it would drift.
   */
  collectStation(playerId, stationId, { max = Infinity } = {}) {
    const p = this.players[playerId];
    const st = (this.layout.stations ?? []).find((s) => s.id === stationId);
    if (!p || !st) return err('no such appliance');
    if (!st.output) return err('nothing ready');
    const madeId = st.output.item_id;
    const take = Math.min(st.output.qty, lotRoom(p.carry, madeId, this.carryLot(p)), max);
    if (take <= 0) {
      return lotTotal(p.carry) >= this.carryCapacity(p)
        ? err('hands full')
        : err(`no free hand for ${content().byId.items[madeId]?.name ?? madeId}`);
    }

    st.output.qty -= take;
    p.carry = lotAdd(p.carry, madeId, take, this.carryLot(p)).lot;
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
        //
        // Never merged (a null key): `st.output.qty` is the whole TRAY, so this
        // already says the total — a second run's line added to the first would
        // count what is standing there twice.
        if (finished) {
          this.logGoods(null, {
            post: ` ready at the ${st.station}.`,
            goods: [{ item_id: st.output.item_id, qty: st.output.qty }],
          });
        }
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
  unload(playerId, deliveryId, cap = Infinity, itemId = null) {
    const p = this.players[playerId];
    if (!p) return err('no such player');

    const del = deliveryId
      ? this.deliveries.find((d) => d.id === deliveryId)
      : this.nearest(this.deliveries, p, UNLOAD_REACH);
    if (!del) return err('no delivery here');
    if (!near(p, del, UNLOAD_REACH)) return err('too far from the pallet');

    const want = Math.min(this.carryCapacity(p) - lotTotal(p.carry), Math.max(0, cap));
    if (want <= 0) return err('hands full');

    /**
     * Named or not, and the two are different acts.
     *
     * Naming a kind is what the pointer does — a press picks the pile it landed
     * on, the way it already picks a board off a shelf — so an armful of
     * tomatoes off a mixed box is one gesture and takes only tomatoes.
     *
     * Unnamed is the sweep, and it is the whole reason mixing pays: one reach
     * into a box of three things comes out with an armful of all three, so
     * emptying it is one walk to the shelves instead of three. `lotSweep` is
     * bounded by the HANDS' caps, not the crate's — a box of five kinds into
     * three-kind hands fills three and leaves the rest in the box, rather than
     * taking five and dropping two on the floor.
     */
    const before = lotTotal(p.carry);
    if (itemId) {
      if (!lotHas(del, itemId)) {
        const name = content().byId.items[itemId]?.name ?? itemId;
        return err(`no ${name} in that crate`);
      }
      const room = lotRoom(p.carry, itemId, this.carryLot(p));
      if (room <= 0) return err('no room in your hands for that');
      const out = lotTake(del, itemId, Math.min(want, room));
      del.stacks = out.lot?.stacks ?? [];
      p.carry = lotAdd(p.carry, itemId, out.took, this.carryLot(p)).lot;
    } else {
      const swept = lotSweep(del, p.carry, want, this.carryLot(p));
      del.stacks = swept.from?.stacks ?? [];
      p.carry = swept.into;
    }
    const took = lotTotal(p.carry) - before;
    if (took <= 0) return err('hands full');

    if (lotTotal(del) <= 0) this.deliveries = this.deliveries.filter((d) => d.id !== del.id);
    // `item_id` is still here and still means "the one thing this was about",
    // because a sweep of three kinds has no single answer and every caller that
    // reads it wants a label. `items` is the honest list beside it.
    return ok({
      unloaded: took,
      item_id: itemId ?? lotMain(p.carry)?.item_id ?? null,
      items: lotStacks(p.carry),
      left: lotTotal(del),
    });
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
   *
   * `max` is how much of it this pull may have, and it exists for the hold: a
   * player takes ONE and holds the ring for the next, so the armful is a
   * gesture with a length rather than a single yes/no. A job loop has no button
   * to let go of, so the staff callers leave it alone and still sweep the board
   * in one step. `say` is off for the drip for the same reason — a pull is one
   * event, and `stepActions` says it once at the end with the total.
   */
  unshelve(playerId, shelfId, itemId, { max = Infinity, say = true } = {}) {
    const p = this.players[playerId];
    const shelf = this.layout.shelves.find((s) => s.id === shelfId);
    if (!p || !shelf) return err('no such shelf');
    if (!near(p, shelf)) return err('too far from that shelf');
    // Same refusal `tapCrate` gives, and it was missing here: hands are what
    // this fills, and a shoulder holding a box does not stop them being full of
    // box. Reachable through the shelf menu's Take row, which is why the guard
    // belongs on the verb rather than on the gesture that arms it.
    if (p.haul) return err('put the crate down first');

    const stack = this.shelfStack(shelf, itemId);
    if (!stack || stack.qty <= 0) return err('nothing on that board');

    const item = content().byId.items[itemId];
    const take = Math.min(stack.qty, lotRoom(p.carry, itemId, this.carryLot(p)), max);
    if (take <= 0) {
      return lotTotal(p.carry) >= this.carryCapacity(p)
        ? err('hands full')
        : err(`no free hand for ${item?.name ?? itemId} — put something down first`);
    }

    stack.qty -= take;
    p.carry = lotAdd(p.carry, itemId, take, this.carryLot(p)).lot;
    // Keyed by the unit, so plucking one loaf four times off the same shelf is
    // one line that counts up rather than four lines saying the same thing —
    // which is what walking a board picking singles actually looks like.
    if (say) {
      const who = this.saidBy(playerId, 'took');
      this.logGoods(`take:${shelf.id}`, {
        pre: `${who.verb} `, post: ` off the ${this.fixtureSaid(shelf)}.`,
        goods: [{ item_id: itemId, qty: take }], by: who.by,
      });
    }
    // Whether the same pull could have another one. Measured after the take, so
    // it answers the two ways a hold ends by itself — the board ran out, or your
    // hands did — and never the one it must not end on, which is you letting go.
    const more = stack.qty > 0 && lotRoom(p.carry, itemId, this.carryLot(p)) > 0;
    return ok({ took: take, item_id: itemId, left: stack.qty, more });
  }

  /**
   * Move one unit off a board into the crate on your shoulder.
   *
   * What a HOLD on a board does, one turn of the ring at a time. It is a crate
   * and not an armful because the thing being asked for is the *board*, and a
   * board holds more than a pair of hands — a hold that filled your arms would
   * stop a third of the way through the job and leave the rest as three more
   * trips. The crate was always the ending; metering it is what lets you stop
   * halfway through and keep what has crossed.
   *
   * Straight onto the shoulder (`p.haul`) rather than onto the floor, because
   * the point of it is walking off with the lot: a crate at your feet is a
   * second gesture to pick up, and it needs empty hands to pick up with anyway.
   * Which is why loose goods in your hands refuse the whole pull rather than
   * being tipped somewhere — nobody shoulders a box while holding six loaves.
   *
   * The board keeps its label at zero, exactly as `unshelve` leaves it: a stack
   * at zero is what a shelf REMEMBERS, and clearing it here would hand a
   * reserved board to whatever the next van brings.
   */
  crateBoard(playerId, shelfId, itemId) {
    const p = this.players[playerId];
    const shelf = this.layout.shelves.find((s) => s.id === shelfId);
    if (!p || !shelf) return err('no such shelf');
    if (!near(p, shelf)) return err('too far from that shelf');
    if (p.carry) return err('put what you are holding down first');

    const stack = this.shelfStack(shelf, itemId);
    if (!stack || stack.qty <= 0) return err('nothing on that board');
    if (lotRoom(p.haul ?? null, itemId, this.crateLot()) <= 0) return err('that crate is full');

    stack.qty -= 1;
    p.haul = lotAdd(p.haul ?? null, itemId, 1, this.crateLot()).lot;
    const more = stack.qty > 0 && lotRoom(p.haul, itemId, this.crateLot()) > 0;
    return ok({ took: 1, item_id: itemId, left: stack.qty, more });
  }

  /**
   * How often a unit crosses, so the whole pull lands in `PULL_SECONDS`.
   *
   * The board and the crate both bound it — you cannot take twenty off a board
   * of five, and you cannot put twenty into a box that holds twelve — so `n` is
   * the smaller, and the interval is a second divided by it. A board of twelve
   * ticks every 83ms and a board of three every third of a second, and both
   * finish at the same moment, which is the whole claim: how long a hold takes
   * is a property of the GESTURE, not of how full the shelf happens to be.
   *
   * Asked once, at the tick the pull arms, because `stepActions` keeps
   * `p.action` for the life of the pull and only ever resets its clock. Asked
   * every tick it would answer a smaller `n` each time and the box would fill
   * faster and faster as the board emptied.
   */
  pullEvery(p, shelf, itemId) {
    const on = this.shelfStack(shelf, itemId)?.qty ?? 0;
    const room = lotRoom(p.haul ?? null, itemId, this.crateLot());
    const n = Math.max(1, Math.min(on, room));
    return Math.max(PULL_STEP_MIN, PULL_SECONDS / n);
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

    // Both ways. `holds` is the shop's rule and it is now everybody's — see the
    // note on it in `shared/tags.js` for what that cost and why it is worth it.
    //
    // Two refusals rather than one, which is `assignShelf`'s split said about a
    // pair of hands: they are different mistakes and only the first has an
    // obvious fix. "Needs a freezer" tells you what to go and buy; "doesn't need
    // freezing" tells you the unit you are standing at is wrong for perfectly
    // ordinary goods, which is the half that only exists now the rule is two-way.
    const home = homeKind(item);
    const here = shelfKind(shelf.kind);
    if (home !== here) {
      return err(home !== 'shelf'
        ? `${item.name} needs a ${FIXTURES[home]?.label.toLowerCase() ?? home}`
        : `${item.name} doesn't need ${here === 'freezer' ? 'freezing' : 'heating'}`);
    }
    // A reservation refuses your hands too, and says how to take it back —
    // otherwise the shelf you set aside this morning reads as broken tonight.
    //
    // **A unit that is kept for something takes that and nothing else**, from
    // your hands and from the crew alike, and the exception this briefly carried
    // — "…unless a board is already standing for it" — was the wrong half of the
    // problem it was fixing. What made a freezer print `Frozen Pizza 0/8` above
    // `Fizzy Soda 0/24` and then refuse frozen pizza is not this rule: it is the
    // EMPTY board left behind by the press that set the unit aside, which
    // `assignShelf` now hands back on the spot. With no phantom board there is
    // nothing to disagree with, and the refusal is the honest one again. The
    // exception also quietly broke the rule from the other end: a mixed crate
    // poured onto a unit kept for bread would refill a sold-out carrot board it
    // happened to still be carrying, which is exactly the "stop making my shelves
    // something new" this reservation exists to say.
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
    if (!p.haul) return err('no crate to empty');

    const res = this.pourInto(shelf, p.haul);
    if (!res.moved) return res.refusal;
    p.haul = res.left;
    return ok({ stocked: res.moved, item_id: res.item_id, left: lotTotal(p.haul) });
  }

  /**
   * Empty as much of a lot onto one unit as it will take, pile by pile.
   *
   * The one place a mixed container meets a mixed fixture, and it is shared by
   * the two verbs that fill a shelf — an armful and a crate poured straight in
   * — for the same reason `boardFor` is: written twice they would drift, and
   * the drift is invisible, because a shelf that quietly took only the first
   * pile still looks like a shelf being stocked.
   *
   * Every pile that has a board goes; the ones that don't stay where they were.
   * That partial answer is the whole point — a unit with room for the tomatoes
   * and not the milk should take the tomatoes, because the alternative is a
   * refusal you avoid by putting things down one at a time, and that is the
   * shape mixed hands were meant to delete.
   *
   * Returns the refusal from the FIRST pile that had nowhere to go, and only
   * when nothing at all moved. `boardFor`'s messages are about a kind — needs a
   * freezer, board is spoken for, unit is out of boards — so the first is the
   * honest answer to "why did this unit refuse me", and a caller that reported
   * the last would name whichever pile happened to sort last.
   */
  pourInto(shelf, lot, max = Infinity) {
    let left = lot;
    let moved = 0;
    let first = null;
    let refusal = null;

    // There used to be a sort here putting the piles that can only live HERE at
    // the front, and `holds` going two-way is what retired it. It was the right
    // answer to a one-way rule: with a mixed crate and a freezer down to its
    // last free board, whichever pile happened to sort first took it, so a
    // crate of carrots and eggs poured into a freezer could spend the cold
    // board on the carrots and leave the eggs with nowhere in the shop to be.
    // Ordering it fixed which pile went on FIRST and could not stop the second
    // one going on at all, which is the bug it was really standing in for.
    //
    // Now a pile that does not belong on this unit is refused outright, so
    // every pile that gets a board wanted this kind of unit and there is
    // nothing left to rank them by. A sort whose reason has gone is worse than
    // no sort: it reads as load-bearing.
    for (const pile of lotStacks(lot)) {
      const item = content().byId.items[pile.item_id];
      if (!item) continue;
      const board = this.boardFor(shelf, item);
      if (!board.ok) { refusal = refusal ?? board; continue; }
      // `max` is what makes a tap one unit rather than an armful, and it is a
      // budget across the whole lot rather than a cap per pile — mixed hands
      // would otherwise put down one of each.
      const take = Math.min(board.room, pile.qty, max - moved);
      if (take <= 0) { refusal = refusal ?? board; continue; }

      const wasEmpty = board.stack.qty === 0;
      board.stack.qty += take;
      // The clock and the price belong to the board, and both are set when it
      // starts rather than every time it is topped up: restocking the milk must
      // not reset how long the milk has already been out, let alone the
      // cheese's.
      if (wasEmpty) {
        board.stack.stockedDay = this.day;
        board.stack.price = suggestedPrice(item, this.folded(), this.season);
      }
      left = lotTake(left, pile.item_id, take).lot;
      moved += take;
      first = first ?? { item_id: pile.item_id, price: board.stack.price };
    }

    return {
      moved,
      left,
      item_id: first?.item_id ?? null,
      price: first?.price ?? null,
      refusal: refusal ?? err('nothing in hand'),
    };
  }

  stockShelf(playerId, shelfId) {
    const p = this.players[playerId];
    const shelf = this.layout.shelves.find((s) => s.id === shelfId);
    if (!p || !shelf) return err('no such shelf');
    if (!near(p, shelf)) return err('too far from that shelf');
    if (!p.carry) return err('nothing in hand');

    // A unit holds three kinds and hands now hold three kinds, so one press
    // fills every board that will have what you are carrying. This is the trip
    // mixed hands were bought for: the walk from the yard was always the
    // expensive part, and it used to be one walk per kind at BOTH ends.
    const res = this.pourInto(shelf, p.carry);
    if (!res.moved) return res.refusal;
    p.carry = res.left;
    return ok({ stocked: res.moved, item_id: res.item_id, price: res.price });
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
    const home = homeKind(item);
    const here = shelfKind(shelf.kind);
    if (home !== here) {
      // Two refusals rather than one, because they are different mistakes and
      // only the first has an obvious fix. "Needs a hot counter" tells you what
      // to go and buy; "doesn't need heating" tells you the unit you are
      // standing at is wrong for perfectly ordinary goods.
      return err(home !== 'shelf'
        ? `${item.name} needs a ${FIXTURES[home].label.toLowerCase()}`
        : `${item.name} doesn't need ${here === 'freezer' ? 'freezing' : 'heating'}`);
    }

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
    // …and any BARE board this unit is not kept for goes back with the press.
    //
    // A leftover board is "a record of what happened, not a decision", and the
    // untick above leans on that: goods you did not tick stay and sell down. An
    // *empty* one has nothing left to sell down — it is a name, a price and a
    // capacity, printed in the unit's own menu, for something the unit has just
    // been told it is not for. A live freezer read `Frozen Pizza 0/8` over
    // `Fizzy Soda 0/24` and said *2 of 2 in use* while turning frozen pizza away
    // and naming soda in the refusal, which is unreadable as anything but the
    // shop being wrong about its own shelf. `releaseBoards` would have taken it
    // two quiet days later; the press that made it a lie is the honest moment.
    //
    // Empty only, and only what nobody kept — stock is never touched here, which
    // is the same line the untick draws one branch up. It is also what keeps the
    // board budget honest: the unit that refused a second reservation for want of
    // a free board now has one.
    for (const stack of [...this.shelfStacks(shelf)]) {
      if (stack.qty > 0 || shelf.assigned.includes(stack.item_id)) continue;
      this.clearStack(shelf, stack.item_id);
    }
    // …and asking for it back is how you overrule the shop having given up on
    // it (`giveUpBoard`). One mechanism rather than two: the alternative was to
    // leave the mark and let a reservation outrank it inside `shelvesFor`,
    // which works and then leaves a shop carrying a "we don't stock that"
    // against something on a shelf with its name on it. The log line promises
    // this outright, so it has to be the thing that happens.
    if (this.orders.dropped?.[itemId] !== undefined) {
      delete this.orders.dropped[itemId];
      // Both halves, or a mark you set later inherits the old cooldown.
      if (this.orders.dropFor) delete this.orders.dropFor[itemId];
    }
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
      const wants = shelfKind(shelf.kind);
      const pick = c.items.find((it) => {
        if (homeKind(it) !== wants) return false;
        return !used.has(it.id);
      }) ?? c.items.find((it) => homeKind(it) === wants);
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
        const it = c.items.find((x) => homeKind(x) === wants && !used.has(x.id));
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
    //
    // `station` is one of those, and refusing it here was a leftover from when
    // the palette named an appliance as `station:blender` and this had no way to
    // read one half of that. The bar sends the KIND now (`t.kind`, since a piece
    // id is free-form and cannot be parsed back out of an id) and keeps which
    // machine to its own side — the same place a variant lives — so arming any
    // appliance at all put "no such build tool" on screen while the ghost and
    // the purchase both went on working. `build-place` carries `spec.station`
    // and checks it against the upgrade, which is where that question belongs.
    if (!FIXTURES[tool]) return err('no such build tool');
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
      ...this.layout.shelves.map((s) => ({ ...s, kind: shelfKind(s.kind), ref: s })),
      ...this.layout.checkouts.map((c) => ({ ...c, kind: 'checkout', ref: c })),
      ...(this.layout.stations ?? []).map((s) => ({ ...s, kind: 'station', ref: s })),
      ...this.layout.plots.map((pl) => ({ ...pl, kind: 'plot', ref: pl })),
      // Decorations are fixtures to everything in build mode — you aim at one,
      // open its menu, turn it, move it, sell it back — so they belong in the
      // one list rather than growing a parallel set of verbs that do the same
      // things to a different noun. They carry their own kind because there is
      // more than one and the list they came from no longer says which.
      ...(this.layout.props ?? []).map((p) => ({ ...p, ref: p })),
      ...(this.layout.bins ?? []).map((b) => ({ ...b, kind: 'bin', ref: b })),
    ];
  }

  /**
   * Somewhere to throw things away, or null.
   *
   * Null is the ordinary answer and every rule that reads this has to be
   * written for it: a shop with no bin is every shop that exists today, and the
   * whole of what owning one changes has to hang off this being non-null. The
   * nearest is not asked for — a bin is a place a job walks to, and `findPath`
   * is what decides which one is worth the trip.
   */
  anyBin() {
    return (this.layout.bins ?? [])[0] ?? null;
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
   * ...and the same sentence about an item, for a line that names one.
   *
   * The id is the fallback rather than a blank, because content is edited live:
   * a row deleted out from under a log line should read as the id it was rather
   * than as the shop having forgotten what it just did.
   */
  itemSaid(itemId) {
    return content().byId.items[itemId]?.name ?? itemId;
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
    if (holdsGoods(f.kind)) {
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

  /**
   * One fixture verb, done to a whole selection, and said ONCE.
   *
   * Every verb in the fixture menu takes a single id, because until now the only
   * way to name a fixture was to open it. Several can be picked at a time now
   * (shift-click), and the naive answer — send the message once per fixture — is
   * wrong three ways over, none of them visible in one shop of six shelves:
   *
   * - **Re-flows.** `styleFixture` goes through `repositionFixture`, which calls
   *   `regenerateLayout` and broadcasts. Eight shelves is eight full re-runs of
   *   the generator, eight walk grids, eight teardowns of the client's entire
   *   static scene — the same cost `setBackOfHouse` argues its way out of one
   *   comment down. `holdReflow` collapses them into the one that was always
   *   enough, since nothing between them is read by anybody.
   * - **The feed.** `assignShelf` writes a line per shelf, so ticking one item
   *   across six units is one event told six times. Same argument `endPull`
   *   makes about a hold and `logRun` makes about a job loop.
   * - **The toast.** A refusal per fixture is six error toasts stacked over each
   *   other for one press. So a partial batch is an `ok` that logs what it could
   *   not do, and only a batch that changed *nothing* comes back as an error —
   *   which is the one case where the player has nothing else to look at.
   *
   * @param {string[]} ids     what to do it to, in the order the player picked
   * @param {function} run     the single-fixture verb, called with one id
   * @param {function} say     `(n) => string`, the one line for a run of them
   */
  bulkFixtures(ids, run, say = (n) => `Changed ${n} fixtures.`) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
    if (!list.length) return err('nothing selected');
    // One at a time is the old path exactly — no fold, no summary, no held
    // re-flow. The single case is every press in the game that is not a bulk
    // one, and it must not start behaving differently because bulk exists.
    if (list.length === 1) return run(list[0]);

    const lines = [];
    this.logFold = lines;
    let done = 0;
    let failed = null;
    this.holdReflow(() => {
      for (const id of list) {
        const r = run(id);
        if (r?.ok) done++;
        else failed ??= r?.error ?? 'that would not work';
      }
    });
    this.logFold = null;

    if (!done) return err(failed ?? 'nothing changed');
    // The fold's own lines are thrown away rather than replayed — they are six
    // spellings of the sentence `say` writes once. A single line is kept as it
    // was written, because a verb that only landed on one fixture has already
    // named that fixture better than a count can.
    this.pushLog(done === 1 && lines.length === 1 ? lines[0] : say(done));
    if (failed) this.pushLog(`${list.length - done} of them would not: ${failed}`);
    return ok({ done, of: list.length, error: failed });
  }

  /**
   * Hold every re-flow inside `fn`, and do the one at the end.
   *
   * A re-flow is not a repaint (see `setBackOfHouse` for the full list of what
   * it actually costs), so a batch of eight fixture verbs must not run eight of
   * them. What makes this safe rather than merely cheaper is that nothing
   * *between* the verbs reads the layout: each one looks its own fixture up,
   * checks `canPlace` against the shop as it stood before the batch — which is
   * the same shop, since none of them moves a tile — and pushes a placement.
   *
   * The alias map is merged rather than chained: a fixture is renamed at most
   * once per batch, because a selection holds each id once.
   *
   * Nested calls are a no-op wrapper, so a verb that batches internally cannot
   * strand the outer hold.
   */
  holdReflow(fn) {
    if (this.reflowHold) return fn();
    this.reflowHold = { want: false, seed: null, alias: {} };
    try {
      return fn();
    } finally {
      const held = this.reflowHold;
      this.reflowHold = null;
      if (held.want) this.regenerateLayout(held.seed, held.alias);
    }
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

    if (holdsGoods(f.kind)) {
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
   *
   * …and *who* restocks it is the half that survival decides. Tipping a unit out
   * says "I will fill this myself", so the shop lets go of what comes off it
   * (`dropItem`, the mark `clearBoard` and the shop hand both set) — otherwise
   * the crates this makes are lifted by the first stocker past and the unit is
   * back the way it was inside a minute, which reads as the button not working.
   * The reservation is what carves the exception, and it needs no code of its
   * own: `stillStocked` counts a board set aside as the shop still being asked
   * for it, so a shelf you ticked for cheese is refilled with cheese exactly as
   * it always was, and only the boards you never spoke for are let go.
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
    const tipped = [];
    for (const stack of [...stacks]) {
      if (stack.qty > 0) {
        this.dropGoods(stack.item_id, stack.qty, shelf.browseAt);
        moved += stack.qty;
        tipped.push({ item_id: stack.item_id, qty: stack.qty });
      }
    }
    shelf.stacks = [];

    // Asked once the boards are gone, and per item: a unit holding three things
    // is three separate sentences, and the one you ticked it for is not one of
    // them. See `stillStocked`.
    const gaveUp = [];
    for (const stack of stacks) {
      if ((stack.qty ?? 0) <= 0) continue;
      if (this.stillStocked(stack.item_id)) continue;
      if (this.dropItem(stack.item_id, HAND_DROP_DAYS)) {
        gaveUp.push(content().byId.items[stack.item_id]?.name ?? stack.item_id);
      }
    }

    const note = gaveUp.length
      ? ` The shop won't restock the ${gaveUp.join(' or ')} for ${HAND_DROP_DAYS} days — set a shelf aside to change that sooner.`
      : '';
    if (moved > 0) {
      this.logGoods(null, {
        pre: 'Stripped ',
        post: ` off the ${this.fixtureSaid(shelf)} — it's in crates beside it.${note}`,
        goods: tipped,
      });
    } else this.pushLog(`Cleared the labels off the ${this.fixtureSaid(shelf)}.${note}`);
    return ok({ emptied: moved, shelf: shelf.id, dropped: gaveUp.length > 0 });
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
   *
   * …and it is the one gesture of yours that tells the shop something. Taking an
   * armful (`unshelve`) or pulling the board into a crate (`crateBoard`) both
   * deliberately LEAVE the label, because a board at zero is what a shelf
   * remembers and a stocker refilling it is right. This row takes the label off,
   * so refilling it is not — see the note on the mark below.
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

    // …and the shop has to HEAR it, or Clear is the same loop `giveUpBoard`
    // exists to close, wearing your hands instead of a worker's. The crate this
    // just made is an ordinary pallet: `unload` lifts it, `shelvesFor` still
    // counts the item as part of the range, and `shelve` puts the goods back on
    // the board you cleared inside a minute — so the row that says "free the
    // board" frees it for as long as it takes somebody to walk over. Same mark,
    // same two ways out (tick a shelf for it, or stock it by hand), one reason
    // different.
    //
    // Not while another board still holds it or is set aside for it. That board
    // is where the crate belongs and the shop should go on buying for it, so
    // marking the item there would strand the goods on the floor AND quietly
    // stop restocking a shelf you never touched — which is the opposite of what
    // the press asked for. It is also why this is the item and not the board:
    // give up on one board alone and the next van lands the same thing on the
    // unit next door, which is `giveUpBoard`'s note said about a player.
    const gaveUp = qty > 0 && !this.stillStocked(itemId) && this.dropItem(itemId, HAND_DROP_DAYS);

    const note = gaveUp
      ? ` The shop won't restock ${name} for ${HAND_DROP_DAYS} days — set a shelf aside for it to change that sooner.`
      : '';
    // An empty board has no goods to draw, so it is words — `logGoods` says
    // nothing at all when handed nothing, which is right everywhere else and
    // wrong here, where taking the LABEL off is the whole event.
    if (qty > 0) {
      this.logGoods(null, {
        pre: 'Took ',
        post: ` off the ${this.fixtureSaid(shelf)} — it's in a crate beside it.${note}`,
        goods: [{ item_id: itemId, qty }],
      });
    } else this.pushLog(`Took ${name} off the ${this.fixtureSaid(shelf)}.${note}`);
    return ok({ emptied: qty, shelf: shelf.id, item: itemId, dropped: gaveUp });
  }

  /**
   * The crates that are STOCK — which is what every reader in the sim meant by
   * `deliveries` right up until one of them stopped being stock.
   *
   * Ten loops walk that list and every one of them is a different kind of wrong
   * about a crate of rot: `homeSupply` would stop the shop reordering the thing
   * that just went off, `unload` would send a stocker to shelve it, `craft`
   * would cook with it, `bayRoom` would report a bay full of rubbish that is not
   * standing on it, and `restock`'s `atTheBay` would refuse to buy while it sat
   * there. None of those looks wrong afterwards, which is the shape CLAUDE.md
   * records for `inACar`: **a container whose membership used to imply a fact
   * stops implying it the moment something can be in it that is not that fact.**
   *
   * So one spelling rather than ten flags. `this.deliveries` is still the whole
   * list, and the three readers that genuinely want the whole list keep it: the
   * renderer (rubbish is a thing you can see), your own hands (you may pick it
   * up and carry it out), and the bin job.
   */
  stockCrates() {
    return this.deliveries.filter((d) => !d.waste);
  }

  /**
   * Rubbish on the floor, as its own crate.
   *
   * Not `dropGoods`, and that is the whole of the design. `dropGoods` tops up
   * any box within a couple of tiles before opening a new one — which is right
   * for goods and catastrophic here, because the box it would top up is full of
   * things somebody is going to sell. One rotten pile merged into a crate of
   * good bread makes the whole crate rubbish or makes the rubbish stock, and
   * there is no third answer.
   *
   * So waste never merges with goods, and only ever merges with waste already
   * on the same tile — which is what keeps a week of it one readable pile
   * rather than a heap of one-unit crates.
   *
   * It is deliberately not on a pad. Rot happens where the food was, so it goes
   * down at the shelf: `padRoom` is the production buffer and rubbish must not
   * be able to stop the farm, and the walk from the aisle to the skip is the
   * thing you are meant to be able to see happening.
   */
  dropWaste(itemId, qty, at) {
    if (!(qty > 0) || !at) return null;
    const x = Math.round(at.x);
    const z = Math.round(at.z);
    const here = this.deliveries.find((d) => d.waste && d.x === x && d.z === z);
    if (here) {
      // No cap. A crate holds twelve because a crate is a TRIP, and nobody is
      // making trips with this — the pile is a readout of how bad it got.
      // The crate's OWN array, not `lotStacks` — that one hands back copies on
      // purpose ("never hands back the lot's own array", so a caller that
      // sorted the result would be reordering somebody's hands). Adding to the
      // copy is a write that lands nowhere, and what it reads as is a second
      // day of spoilage quietly failing to appear.
      const own = (here.stacks ??= []);
      const at0 = own.find((k) => k.item_id === itemId);
      if (at0) at0.qty += qty;
      else own.push({ item_id: itemId, qty, day: this.dayNow() });
      return here;
    }
    const crate = {
      id: `del-${this.nextDeliveryId++}`,
      x,
      z,
      day: this.day,
      // The flag every other reader tests. `unload`, `homeSupply`, `restock`
      // and `bayRoom` all have to skip it, and each of those is a different
      // kind of wrong if it does not: a stocker shelving rot, the shop
      // declining to reorder what just went off, and a bay that says it is
      // full of rubbish it is not standing on.
      waste: true,
      stacks: [{ item_id: itemId, qty, day: this.dayNow() }],
    };
    this.deliveries.push(crate);
    return crate;
  }

  /**
   * Throw away what you are holding.
   *
   * The first verb in the game that DESTROYS goods on purpose, and the reason
   * it took this long is the note in docs/workers.md: *"what something is worth
   * is the player's question, and a worker answering it is a worker spending
   * your money."* That is why this takes a `playerId` and why the staff job
   * beside it will only ever carry rubbish — a hire may take out what has
   * already rotted, and may never decide that six loaves are not worth keeping.
   *
   * Both hands at once. A crate on the shoulder and an armful are two places
   * goods live and you walked to the skip to be rid of what you are carrying,
   * not to be asked which half.
   *
   * It costs nothing and refunds nothing. Charging for it is the trap
   * `stow`'s note already describes — it punishes exactly the moment somebody
   * is experimenting, and what people learn instead is to stand there holding
   * it — and paying for it would make the bin a second, worse till. What it
   * costs is the walk and the goods.
   */
  binGoods(playerId, binId) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    const bin = (this.layout.bins ?? []).find((b) => b.id === binId);
    if (!bin) return err('no such bin');
    if (!p.carry && !p.haul) return err('nothing in hand');
    if (!near(p, bin.useAt ?? bin, UNLOAD_REACH)) return err('take it over to the bin');

    const gone = lotTotal(p.carry) + lotTotal(p.haul);
    // Everything, pile by pile — both hands and the shoulder. It used to name
    // the biggest pile and count the rest ("42 units — Bread and more"), which
    // is the one line where you most want to see what you just destroyed.
    const tipped = [...lotStacks(p.carry), ...lotStacks(p.haul)]
      .map((s) => ({ item_id: s.item_id, qty: s.qty }));
    p.carry = null;
    p.haul = null;
    this.logGoods(null, { pre: 'Threw away ', post: '.', goods: tipped });
    this.persist();
    return ok({ binned: gone });
  }

  /** Tip an appliance's hopper (and any finished batch) out into crates. */
  dumpStation(playerId, stationId) {
    const p = this.players[playerId];
    const st = (this.layout.stations ?? []).find((s) => s.id === stationId);
    if (!p || !st) return err('no such appliance');

    let moved = 0;
    const tipped = [];
    for (const [itemId, n] of Object.entries(st.contents ?? {})) {
      this.dropGoods(itemId, n, st.useAt);
      tipped.push({ item_id: itemId, qty: n });
      moved += n;
    }
    st.contents = {};
    if (st.output) {
      this.dropGoods(st.output.item_id, st.output.qty, st.useAt);
      tipped.push({ item_id: st.output.item_id, qty: st.output.qty });
      moved += st.output.qty;
      st.output = null;
    }
    if (moved === 0) return err('that hopper is already empty');
    // A batch already underway is left to finish — its ingredients are spent,
    // so cancelling it would destroy them for nothing.
    this.logGoods(null, {
      pre: `Emptied the ${st.station} — `, post: ' back in crates.', goods: tipped,
    });
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
    // Every glazing at the window's own price, keyed by the palette entry's id —
    // one line per look rather than one number, because the bar prints what it is
    // about to charge and a blank price on three of four buttons reads as free.
    costs['window-full'] = EDGE_COST[E.WINDOW_FULL];
    costs['window-bay'] = EDGE_COST[E.WINDOW_BAY];
    costs['window-high'] = EDGE_COST[E.WINDOW_HIGH];
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
    if (!holdsGoods(f.kind)) {
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
      //
      // ...except within a family. Putting a sign on a doorway — staff only, one
      // way — or reglazing a window is a REFIT: it charges any difference in price
      // and refunds nothing, because you still have the door and you still have
      // the wall. Charged as a swap it would cost you half a doorway to fit and
      // half a doorway again to change your mind, and a switch that bills you $17
      // both ways is not a switch. Per-edge pricing exists so a window over a wall
      // charges the gap; this is the same claim about the same line.
      //
      // `edgeFamily` and not "is it an opening": the point is what you KEEP, and
      // that is as true of a bay window over a plain one as of a signed door.
      const refit = edgeFamily(kind) && edgeFamily(kind) === edgeFamily(existing);
      const cost = refit
        ? Math.max(0, round2((EDGE_COST[kind] ?? 0) - (EDGE_COST[existing] ?? 0)))
        : round2((EDGE_COST[kind] ?? 0) - (EDGE_COST[existing] ?? 0) * FIXTURE_REFUND);
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
    // `strokeThick` off the ROW's kind, not off anything the client said — the
    // same reason `kind` is read off the row two lines up. It is the one place
    // the width rule lives, and the ghost runs this exact call.
    const cells = groundStroke({ x, z }, to, GROUND_STROKE_MAX, strokeThick(kind), this.layout);

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
      // The bulldozer's own version of that skip, and it needs one of its own
      // because taking ground up does not name a kind to compare against. It
      // used to fall out of `groundKindAt` answering null on bare grass, which
      // stopped being true the day the lawn got a row — so an eraser dragged
      // across a field would write a `k: null` entry per cell and report the
      // lot as taken up. What a stroke LEAVES is bare lawn with no design, so a
      // cell that is already that is a cell this did nothing to.
      if (!piece && had == null && this.groundKindAt(c.x, c.z) === 'lawn') continue;

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
   * Which ground kind this cell is right now, or null for ground with no kind.
   *
   * The half of a repaint the overlay can't answer: `ground` says what you
   * painted, and this says what the cell actually ended up as, which differ for
   * exactly as long as it takes a re-flow to run.
   *
   * It used to answer null for bare grass, and that was never a rule — it was
   * `GROUND` having no row whose tile was `T.GRASS`. It answers `lawn` now, so
   * a caller that meant "nobody has painted here" has to ask the overlay
   * (`painted`) rather than this. Null is left for a cell that is a bed, a wall
   * or a doorway: ground with a job that is not a ground kind.
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

  /**
   * Paint one face of a wall, or a run of them.
   *
   * `buildGround`'s sibling, and deliberately shaped like it: two ends and a
   * piece, priced per unit, half of what was there before handed back, refused
   * as a whole gesture before any of it is paid for. Somebody who has read one
   * of these has read both.
   *
   * The one thing it does NOT do is re-flow, and that is the point rather than
   * an optimisation. A painted face changes no tile, no walk grid and no
   * enclosure, so there is nothing for the generator to redo — and a re-flow
   * throws away every shopper's path and rebuilds the client's whole static
   * scene, which is a lot to spend on a colour. The room broadcasts the new
   * overlay instead and the renderer rebuilds the one group that draws walls.
   *
   * An empty piece is the brush's own null entry, exactly as Bare Ground is:
   * it strips the face back to whatever the wall is made of.
   */
  paintFaces(playerId, spec = {}) {
    const p = this.players[playerId];
    if (!p) return err('no such player');
    if (!p.build?.on) return err('not in build mode');

    const o = spec.o === 'v' ? 'v' : 'h';
    const x = Math.round(Number(spec.x));
    const z = Math.round(Number(spec.z));
    const s = Number(spec.s) < 0 ? -1 : 1;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return err('nothing there to paint');

    // Read off the ROW, never off the message — the same reason `buildGround`
    // gives: a client that named a flooring row while saying `paint` would
    // finish a wall in something the catalog prices as a floor.
    const want = String(spec.piece ?? '');
    const piece = want
      ? (content().fixtures ?? []).find((f) => f.id === want && isPaint(kindOf(f)))
      : null;
    if (want && !piece) return err('nothing in the catalog paints that');

    // The far end is an index along the line the drag started on, the way a wall
    // run's is — and the SIDE comes from the start for every face in it. See
    // `faceRun`.
    const to = spec.to == null ? null : Number(spec.to);
    const faces = faceRun(this.layout, { o, x, z, s }, to, EDGE_RUN_MAX);
    const check = canPaintFaces(this.layout, faces.length ? faces : [{ o, x, z, s }]);
    if (!check.ok) return err(check.reason);

    const unit = piece ? this.paintUnitCost(piece.id) : 0;
    let spent = 0;
    let done = 0;
    let short = false;
    const next = { ...this.paint };
    for (const f of faces) {
      const key = faceKey(f);
      const had = next[key] ?? null;
      if (had === (piece?.id ?? null)) continue;
      // Half of what is on there now back, which is `buildGround`'s rule and the
      // shop's one sell-back rate. Repainting a wall you paid for is therefore
      // cheaper than painting a bare one, and no amount of repainting prints
      // money — the same guarantee `FIXTURE_REFUND` gives every other ladder.
      const cost = round2(unit - this.paintUnitCost(had) * FIXTURE_REFUND);
      if (cost > 0 && this.cash - spent < cost) { short = true; break; }
      spent = round2(spent + cost);
      if (piece) next[key] = piece.id;
      else delete next[key];
      done++;
    }

    if (!done) {
      return short ? err(`need $${unit.toFixed(2)}`) : ok({ painted: 0, unchanged: true });
    }

    this.paint = next;
    this.cash = round2(this.cash - spent);
    if (spent > 0) this.stats.spent += spent;
    // No `regenerateLayout` — see the note above. The live layout carries the
    // overlay so a client that joins mid-session gets it, and it is the same
    // object the re-flow would have re-hung, so writing it here keeps the two
    // from disagreeing for as long as it takes something else to re-flow.
    this.layout.paint = { ...this.paint };
    this.persist();

    const what = piece ? piece.name.toLowerCase() : null;
    this.pushLog(what
      ? `Painted ${done} wall ${done === 1 ? 'face' : 'faces'} in ${what}`
        + `${spent > 0 ? ` for $${spent.toFixed(2)}` : ''}.`
      : `Stripped the paint off ${done} wall ${done === 1 ? 'face' : 'faces'}.`);
    return ok({ painted: done, cost: spent, short });
  }

  /**
   * What one face costs to paint.
   *
   * `groundUnitCost` said about a wall, down to the null: a face nobody has
   * painted refunds nothing, because nobody charged you for the wall's own
   * colour. The discount is read against the row's kind for the same reason —
   * a Storage deal must not quietly discount emulsion.
   */
  paintUnitCost(pieceId) {
    if (!pieceId) return 0;
    const row = (content().fixtures ?? []).find((f) => f.id === pieceId && isPaint(kindOf(f)));
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
      return err('lease units from the Crew menu');
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
      // ...and that is the whole of it now. `grow` is the WORLD's size — see
      // `compose` in server/layout.js.
      //
      // It used to grow the shell as well, which is what "an extension" meant
      // while the building was the only place you could put anything. It stopped
      // being the right answer the day walls went on edges and floor went on a
      // brush: a shop is something you draw, so an extension that stamps a new
      // outer wall three tiles past the one you drew leaves your wall stranded
      // inside as a line to knock through, and re-stamps the shell over
      // whatever you had put on the way. What people want out of "more space"
      // is somewhere to build, and that was the one thing it did not reliably
      // sell — the map only widened once the building passed `WORLD_W - 8`.
      //
      // The line that used to be here wrote `shell.w`/`shell.h`, and it is
      // worth knowing what it cost before anybody puts it back. `shell` is what
      // the building IS, and rewriting the object rather than extending it
      // dropped `z` — `storeNorth` reads `shell.z ?? STORE_NORTH_LEGACY`, so a
      // shop stamped at the modern z=5 silently became a legacy z=2 the moment
      // you bought space, jumping the whole building three rows north. Every
      // placement then outside it was dropped and refunded: shelves 21 -> 14,
      // plots 3 -> 0 and checkouts 1 -> **0** on a real save. Revenue $723 over
      // 60 days against $33,353 with it fixed, and what it presented as was "I
      // bought an upgrade and went broke".
      //
      // A field added to pin something down is exactly the field a wholesale
      // rewrite of its object will lose. `shell.x` is the second one now.
    }

    // Land is the only upgrade left that changes the shape of the world. Every
    // other structural one used to, because buying shelving moved shelving;
    // buying a deal on shelving moves nothing until you go and build something.
    if (up.kind === 'space') this.regenerateLayout();
    this.pushLog(`Bought ${up.name}.`);
    return ok({ upgrade: upgradeId });
  }

  /**
   * The way back off an upgrade, at `FIXTURE_REFUND`.
   *
   * "Permanent, and there is no selling it back" was true of these alone, and it
   * stopped being a rule the day both other ladders in the game grew a way down
   * (`downgradeFixture`, `demote`). What it cost was not money, it was the
   * decision: a $20,000 catchment is a bet you make once and can never unmake,
   * so the honest way to play it was to not press it — which is a button that
   * mostly does nothing.
   *
   * Half back, the same rate everything else in the shop sells at, so buying and
   * selling in a circle always loses money rather than printing it.
   *
   * Three refusals, and each is a different kind of "this is not a flag":
   *
   * - `space` bought LAND, and the building grew onto it. Selling it would have
   *   to shrink the shell, which strands every placement outside the new wall —
   *   the bug `buyUpgrade`'s own comment is about, pointed the other way.
   * - `staff` is what an old save's people were made of, read once by
   *   `rosterFromUpgrades`. Selling one would delete the record a hire was
   *   migrated from.
   * - `station` was never owned: that row is the *price* of a machine, and the
   *   machine sells back in build mode where it is standing.
   *
   * And one that is about the ladder rather than the row: a rung something else
   * you own stands on cannot be pulled out from under it, or a shop keeps
   * `catchment-retail-park` while owing nothing for the two rungs below it.
   */
  sellUpgrade(upgradeId) {
    const up = content().byId.upgrades[upgradeId];
    if (!up) return err('no such upgrade');
    if (!this.ownedUpgrades.includes(upgradeId)) return err('you do not own it');
    if (up.kind === 'space') return err('the land it bought is under the shop now');
    if (up.kind === 'staff') return err('let people go from the Crew menu');
    if (up.kind === 'station') return err('an appliance sells back in the Build menu');

    const holding = this.ownedUpgrades.filter((id) => {
      const other = content().byId.upgrades[id];
      return other && (other.requires ?? []).includes(upgradeId);
    });
    if (holding.length) {
      const names = holding.map((id) => content().byId.upgrades[id]?.name ?? id);
      return err(`${names.join(', ')} needs it — sell that first`);
    }

    const back = round2((up.cost ?? 0) * FIXTURE_REFUND);
    this.ownedUpgrades = this.ownedUpgrades.filter((id) => id !== upgradeId);
    this.cash += back;
    this.pushLog(`Sold ${up.name} back — $${back.toFixed(2)}.`);
    this.persist();
    return ok({ upgrade: upgradeId, refund: back });
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
    // `x` as well as `z`, and for the same reason said about the other axis:
    // the building has always been centred east-west, derived fresh from the
    // world's width — which is safe only while that width is a constant. Land
    // is bought in world tiles now (`storeWest`), so a re-derived centre would
    // slide the shop sideways out from under every absolute placement in it.
    this.shell = {
      w: this.layout.store.w,
      h: this.layout.store.h,
      x: this.layout.store.x,
      z: this.layout.store.z,
    };
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
    // The yard behind and the street in front, stamped by one mark because they
    // are one event: this is the ground a world starts with. Keeping a second
    // flag for the frontage would mean an existing shop — which has this one set
    // — waking up tomorrow with a road through its lawn.
    const seeded = [...defaultPads(this.layout), ...defaultStreet(this.layout)];
    if (!seeded.length) return false;
    this.ground = [...this.ground, ...seeded];
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
    // A batch is holding them (`holdReflow`). Remember what this one would have
    // carried and let the batch do it once, at the end.
    //
    // Only the plain form defers. A re-flow that is compensating differently or
    // asking for a different set of fixtures is not the one the batch is going
    // to run, and folding it in would quietly drop the difference — which is a
    // shop that refunds the wrong thing, days later, with nothing to connect it
    // to the press that caused it.
    if (this.reflowHold && compensate && !asked) {
      this.reflowHold.want = true;
      this.reflowHold.seed = newSeed ?? this.reflowHold.seed;
      Object.assign(this.reflowHold.alias, alias);
      return;
    }
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
      warmers: want.warmer ?? 0,
      bins: want.bin ?? 0,
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

    // What each wall face is painted, hung on the finished layout rather than
    // handed to the generator.
    //
    // Not tidiness — it is the feature's whole claim, made structurally instead
    // of tested. `ground` has to go IN because a painted cell becomes a
    // different tile, so the generator's own output depends on it; paint stamps
    // nothing, blocks nobody and encloses nothing, so a generator that never
    // hears about it *cannot* have been changed by it. The day this line moves
    // up into the call above is the day a colour can move a wall.
    layout.paint = { ...this.paint };

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

    // Everything a unit was holding rides across unconditionally, and what the
    // destination cannot honour is shed by the sweep below.
    //
    // There used to be a `compatible` predicate here refusing a row whose stock
    // named a fixture the destination is not, and it was the same mistake the
    // comment under it warns about, one clause along: failing that test skips
    // EVERY key, so a unit whose middle board was ice cream carried nothing at
    // all — the bread on the other two boards went with it, and so did the
    // reservations. Refusing the carry does not put goods anywhere, it simply
    // leaves them off the new record, which is destroying them. One rule, in
    // the one place that can hand them back.
    carryOver(layout.shelves, oldShelves, alias, ['stacks', 'assigned', 'priority']);

    // Boards and reservations the destination cannot honour are dropped, not
    // carried. It has to be a sweep afterwards rather than a clause in the
    // carry: failing that test skips *every* key, so refusing the row over a
    // bad reservation would destroy the goods on it to save the label. Clearing
    // it costs the player a choice they can remake; the other way round costs
    // them a shelf full of stock.
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
        return want && homeKind(want) === shelfKind(s.kind);
      });
      const boards = this.shelfBoards(s);
      const shed = [];
      s.stacks = this.shelfStacks(s).filter((k) => {
        const item = k.item_id ? c.byId.items[k.item_id] : null;
        // An item nobody can look up rides along rather than being binned. The
        // same forgiveness `pieceFor` shows a deleted design, and it matters
        // more here: content is edited live, so somebody tidying an item out of
        // the catalog would otherwise destroy every case of it on every shelf in
        // the shop, on the next re-flow, with a refund for nothing.
        if (!item) return true;
        if (homeKind(item) === shelfKind(s.kind)) return true;
        shed.push(k);
        return false;
      });
      if (s.assigned.length > boards) s.assigned = s.assigned.slice(0, boards);
      if (s.stacks.length > boards) {
        shed.push(...s.stacks.slice(boards));
        s.stacks = s.stacks.slice(0, boards);
      }
      // Cleared off the unit, never destroyed — the same crate a stripped shelf
      // makes, so a stocker walks it to somewhere it belongs. Both reasons a
      // board is shed come through here: goods the unit may not keep, and a
      // board the design no longer draws. The first was the one written as a
      // bare `filter`, which is a conservation hole you cannot see — the shop is
      // quietly poorer and there is nothing in the log to connect it to.
      //
      // Nothing can put goods on the wrong kind of unit any more (`boardFor` is
      // two-way since the pour), and this is not therefore dead: content is
      // edited live, so tagging an item `needs-freezer` this afternoon strands
      // every case of it standing on ordinary shelving, and every save in
      // existence predates whatever rule was made today. It is the sweep that
      // makes a rule change safe to make.
      for (const k of shed) {
        if (k.qty > 0) this.dropGoods(k.item_id, k.qty, s.browseAt);
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
      /**
       * Anybody at the wheel is on a lane this call has just recomputed, and
       * the answer is the van's, one step harder.
       *
       * A driver going OUT keeps going: their route was copied when they got in
       * for exactly this reason, they own nothing the shop needs back, and
       * popping a car out of existence beside the shop is worse than letting it
       * drive off a lane that moved. The one below despawns it at the border.
       *
       * A driver coming IN is parked, on the spot. Restarting the drive is what
       * the van does, and it is wrong here for a reason the van does not have: a
       * player who is building re-flows on every wall segment, and a car that
       * started its approach again each time would never arrive at all — the
       * shopper inside it is a customer who never happens, in a shop that is
       * being extended precisely because it is busy. So they take the space they
       * were already holding and walk in from it, which is exactly what a space
       * with no lane has always done.
       */
      if (inACar(cu)) {
        if (cu.state === 'DRIVE') this.parkNow(cu);
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
    // Anybody left standing in something that has just become solid — which is
    // almost always somebody who set a fixture down on their own feet. One step
    // out (`stepOff`), and the door of the shop only for somebody sealed in on
    // their own. The route goes with them: A* planned it from where they were
    // standing and `stepPlayers` deliberately does not re-check a routed walk,
    // so a path kept across a displacement walks them straight back into it.
    for (const p of Object.values(this.players)) {
      if (this.canStand(p.x, p.z)) continue;
      const to = this.stepOff(p.x, p.z) ?? layout.spawn;
      p.x = to.x;
      p.z = to.z;
      p.path = null;
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
   * A shop nobody can move in gets a name for it.
   *
   * The crush was worth mood and nothing else, and mood is per-person and resets
   * with the person: everybody in a packed shop was miserable, they left, and by
   * the next customer the shop's own record of it was gone. So a permanently
   * uncomfortable shop had no lasting consequence at all unless it got bad
   * enough to turn arrivals away at the door, which is a cliff rather than a
   * slope.
   *
   * Only while OPEN, or a shop shut with people finishing up quietly bleeds
   * reputation for a crowd it is in the middle of getting rid of. Rate-limited
   * by nothing else: `dt` is the whole of it, so it holds at 10Hz in the room
   * and at 10000x in a balance run.
   */
  stepCrowdRep(dt) {
    if (!this.isOpen()) return;
    const over = this.occupancy - CROWD_FROM;
    if (over <= 0 || !Number.isFinite(over)) return;
    this.moveRep(-CROWD_REP_RATE * over * dt, R.CROWD);
  }

  /**
   * How many people are actually in the shop right now.
   *
   * Its own method because two different questions ask it and they are not the
   * same question: how CROWDED it is (below) is a ratio against what the place
   * can hold, and how many people are in there is a headcount the HUD shows
   * beside the size of the town. A ratio cannot answer the second — 0.4 is four
   * people in a small shop and forty in a big one.
   *
   * The membership test is `inACar`'s, for the reason CLAUDE.md gives about
   * `this.customers`: since people drive, being in that object stopped meaning
   * being in the shop.
   */
  /**
   * Arrivals at a shut shop, during hours the town expects you open.
   *
   * Deliberately NOT a customer. Everything a shopper is for — a list, a basket,
   * a queue, patience draining while they browse — begins at the door, and none
   * of it can happen here: `this.customers` is walked by `stepMood`,
   * `measureOccupancy`, `moodAverage` and the snapshot, and putting somebody in
   * it who can never enter is the `inACar` trap for the third time. What the
   * feature actually needs is a tally and a reputation hit, so that is what it
   * is.
   *
   * Only inside `trading()` hours, which is the one thing that stops this
   * charging you for the night: shutting at 20:00 is closing time, and nobody
   * walks up to a bakery at 04:00 and is offended. `isOpen` is `open &&
   * trading()`, so reaching here with `trading()` true is exactly "you chose to
   * be shut while the town was about".
   *
   * Hashed rather than drawn, for `shared/hash.js`'s reason said about a
   * different loop: `simulate` forces the shutters up, so an rng draw here would
   * be dead code in every balance run and live code in every real shop — the one
   * shape that guarantees the two disagree with nothing to say why.
   */
  stepShutArrivals(dt, folded) {
    if (!this.trading()) return;
    const rate = footfall({
      day: this.day, hourFraction: this.time,
      reputation: this.reputation, folded, catchment: this.catchment(),
      pullFloor: this.town.pullFloor,
    });
    this.shutAccumulator = (this.shutAccumulator ?? 0) + (rate * SHUT_FOOTFALL / 60) * dt;
    while (this.shutAccumulator >= 1) {
      this.shutAccumulator -= 1;
      this.stats.foundShut = (this.stats.foundShut ?? 0) + 1;
      if (hash01(`${this.day}:${this.stats.foundShut}:shut`) >= SHUT_ANGER) continue;
      this.moveRep(-REP_FOUND_SHUT, R.SHUT);
      // Once per stretch of being shut rather than per person, the way the
      // packed-door line is: a shop shut for an hour would otherwise write forty
      // identical lines and bury everything else in the log.
      if (!this.sayingShut) {
        this.sayingShut = true;
        this.pushLog('Somebody came to the door and found you shut.');
      }
    }
  }

  customersInside() {
    return Object.values(this.customers)
      .reduce((n, cu) => n + (cu.state === 'ENTER' || inACar(cu) ? 0 : 1), 0);
  }

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
    // Kept, because the snapshot wants the divisor as a number and this is the
    // one place it is already worked out — it walks every shelf in the shop, and
    // asking again ten times a second to print it would be a second full sweep
    // for a figure that cannot have changed since the first.
    const capacity = this.shopCapacity();
    this.capacity = capacity;
    // A shop with no till and nothing on the shelves is not a shop with
    // infinite room; it is one nobody can use.
    return capacity > 0 ? this.customersInside() / capacity : Infinity;
  }

  /**
   * How many people this shop comfortably holds.
   *
   * Its own verb because it is a HEADCOUNT and the thing the sim runs on is a
   * ratio — and a ratio cannot be drawn as a number. `occupancy` at 0.4 is four
   * people or forty, which is exactly why the HUD could show the crush as a bar
   * and never as "9 of 24": the divisor was a local inside the measurement.
   */
  shopCapacity() {
    // Units with something on them, NOT boards. How much room a shop has is
    // about how many places there are to stand and browse, and a shelf holding
    // three things is still one shelf with one aisle in front of it — counting
    // boards would have ticking a checkbox make the building bigger.
    const stocked = this.layout.shelves.reduce((n, s) => n + (this.shelfQty(s) > 0 ? 1 : 0), 0);
    const service = this.layout.checkouts.length * CAPACITY_PER_TILL
      + stocked * CAPACITY_PER_SHELF;
    // ...and the building. The LOWER of the two, not the sum: a shop is as busy
    // as its tightest constraint, and adding a fourth till to a room that holds
    // eight people does not make it hold twelve. That direction is the whole
    // point — a tiny shop has to stay tiny however well you fit it out, or
    // "cramped" is a thing you can buy your way out of without moving a wall.
    return Math.min(service, this.floorRoom());
  }

  /**
   * How many people the floor itself holds.
   *
   * Walkable indoor tiles rather than the shell's rectangle, so a wall you draw
   * counts, an annex you floor counts, and the aisles your own shelving eats do
   * too. Read off the same two masks everything else does rather than kept as a
   * number beside the shop — `world.fixtures` is the cautionary tale.
   */
  floorRoom() {
    const { w, h, indoor, blocked } = this.layout;
    if (!indoor) return Infinity;
    let tiles = 0;
    for (let i = 0; i < w * h; i++) if (indoor[i] && !blocked?.[i]) tiles++;
    return tiles * CAPACITY_PER_TILE;
  }

  /**
   * Which tiles a shopper would rather not walk over.
   *
   * Tile indices, so `findPath` can ask `has(i)` in its inner loop without
   * touching an object — this is the hot loop in the game and it is asked once
   * per route rather than once per step, but the set is walked by every
   * expansion.
   *
   * **Everywhere, not just indoors.** A crate on the approach path is in the way
   * exactly as much as one in an aisle, and the pavement preference already
   * proves people route around things outside. The yard is where crates are
   * *supposed* to be, and it needs no exception: nothing routes a shopper
   * through the bay, so the cost is never paid.
   */
  clutterTiles() {
    const { w } = this.layout;
    const out = new Set();
    for (const d of this.deliveries) out.add(Math.round(d.z) * w + Math.round(d.x));
    return out;
  }

  /**
   * How much of the shop floor is under boxes, as a share of the walkable room.
   *
   * The mess half of the same object the clutter cost is the pathing half of:
   * one is "I had to walk round it", this is "the place is a tip".
   *
   * Three decisions in it. It counts **tiles rather than units**, because a
   * hundred loaves in one box is one thing in the way and one thing to look at,
   * while four part-crates on four cells is a mess — the same call
   * `measureOccupancy` makes about units of shelving rather than boards.
   *
   * **Rubbish counts double.** A box of stock is a shop mid-job; a box of rot is
   * a shop that has given up, and the difference is the entire reason the skip
   * exists. It is also the only lever that makes buying one worth anything to a
   * shopper rather than to your conscience.
   *
   * And it is **indoors only**, which is the opposite of `clutterTiles` on
   * purpose. Being in the way is a fact about a route and can happen anywhere;
   * being a tip is a fact about the room somebody is standing in, and a yard full
   * of crates is a yard doing its job. Charging for it would make every shop
   * permanently untidy and the term would say nothing.
   */
  measureMess() {
    const { w, h, indoor, blocked } = this.layout;
    if (!indoor) return 0;
    let floor = 0;
    for (let i = 0; i < w * h; i++) if (indoor[i] && !blocked?.[i]) floor++;
    if (!floor) return 0;

    // By CELL, so two boxes on one tile are one untidy tile. Weighted as it
    // goes, and the heavier of the two wins a shared cell — a crate of rot with
    // a crate of bread on top of it is still rot on your floor.
    const seen = new Map();
    for (const d of this.deliveries) {
      const i = Math.round(d.z) * w + Math.round(d.x);
      if (!indoor[i] || blocked?.[i]) continue;
      const weight = d.waste ? 2 : 1;
      if ((seen.get(i) ?? 0) < weight) seen.set(i, weight);
    }
    let mess = 0;
    for (const weight of seen.values()) mess += weight;
    return mess / floor;
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
      if (cu.state === 'ENTER' || cu.state === 'LEAVE' || inACar(cu)) continue;
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
   * Each one carries the **lane its car drives in on** (`c.lane`), or null. This
   * is the cache the lanes belong in and not a second one, for two reasons that
   * both come down to timing: `carLanes` reads `blocked` and `indoor` as they
   * finally are, which is true exactly when a layout is finished, and it is an
   * identical once-per-re-flow question to the A* above. Computing them in
   * `compose` instead would make every thrown-away size probe pay for a dozen
   * lane searches, and every headless sweep pay for lanes nobody drives.
   *
   * **A space with no lane is still a space.** It is parking you cannot be
   * watched arriving at, and filtering it out here would make an animation
   * change `parkReach` — see `carLanes`.
   *
   * Memoised, and it has to be: this is A* per cell, and it is asked on the
   * spawn of every shopper and on every snapshot. Once per re-flow is free, and
   * a shop with no car park never gets past the empty `padCells`.
   */
  parkSpaces() {
    if (this.parkCache?.layout === this.layout) return this.parkCache.cells;
    const door = { x: this.layout.door.x, z: this.layout.door.z - 1 };
    const near = (c) => Math.hypot(c.x - door.x, c.z - door.z);
    const usable = padCells(this.layout, 'park')
      .sort((a, b) => (near(a) - near(b)) || (a.z - b.z) || (a.x - b.x))
      // As a shopper, because it is one: the walk from the bay to the door is
      // the driver's own, so a car park whose only way in is a staff door is
      // parking nobody can use rather than parking with a long walk.
      .filter((c) => findPath(this.walk, this.layout, c, door, { shopper: true }) !== null);

    /**
     * ...paired up, because **a bay is two cells and a car is one car.**
     *
     * It was one cell one car for as long as a car was 1.16 tiles long, which
     * was smaller than the shopper who got out of it. The models are car-sized
     * now (2.05 × 1.21) and a single cell is a car parked across three of them.
     *
     * Greedy along the sorted list, which does the work the sort already did:
     * cells come out nearest-the-door first, so a pad fills from the end
     * somebody would use and the pairs are neighbours by construction. A cell
     * with no neighbour left is **not** a bay — an odd row parks one fewer car,
     * which is the honest answer and the one a player can see coming.
     *
     * The pair is stored, not just its anchor: `cells` is what the sim claims
     * and `mid` is where the car is drawn, because a car 2 tiles long standing
     * on the first of its two cells hangs out of the bay at the front.
     */
    const taken = new Set();
    const key = (c) => `${c.x},${c.z}`;
    const at = new Map(usable.map((c) => [key(c), c]));
    const bays = [];
    for (const c of usable) {
      if (taken.has(key(c))) continue;
      // Along z first: a bay you nose into off a road running east-west, which
      // is the road the world seeds and the one most people will draw.
      const mate = [{ x: c.x, z: c.z + 1 }, { x: c.x, z: c.z - 1 },
        { x: c.x + 1, z: c.z }, { x: c.x - 1, z: c.z }]
        .map((p) => at.get(key(p)))
        .find((p) => p && !taken.has(key(p)));
      if (!mate) continue;                       // a lone cell is not a bay
      taken.add(key(c));
      taken.add(key(mate));
      bays.push({
        x: c.x, z: c.z,                          // the anchor: nearest the door
        cells: [{ x: c.x, z: c.z }, { x: mate.x, z: mate.z }],
        mid: { x: (c.x + mate.x) / 2, z: (c.z + mate.z) / 2 },
        // Nose out along the bay, never at the door. A car is two tiles long
        // and the bay is two cells deep, so any other angle is a car parked
        // across its own markings — the facing is a property of the BAY now,
        // where it used to be a line of trigonometry about the shopfront.
        facing: Math.atan2(c.x - mate.x, c.z - mate.z),
      });
    }

    // One lane per bay, off its anchor — the cell a car reaches first.
    const lanes = carLanes(this.layout, bays);
    bays.forEach((b, i) => { b.lane = lanes[i]; });
    this.parkCache = { layout: this.layout, cells: bays };
    return bays;
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
   * The cars, for whoever is drawing them — driving in, standing, or driving
   * out.
   *
   * Derived from the shoppers rather than kept as its own list, so a car exists
   * for exactly as long as the person who drove it and there is no second thing
   * to tidy up. Keyed by the customer's id for the same reason the van sends
   * `vehicle`: the renderer needs to know which mesh is which one between frames,
   * and this is the only list in the game whose members appear at the edge of the
   * map, come to a stop for a minute, and leave again.
   *
   * `cu.drive` is the car's body and `cu.parkedAt` is its claim on a cell. They
   * were one field while a car never moved — the claim, the picture and the
   * walk-back-to target were the same fact — and step 5 of docs/deliveries.md is
   * where that stopped being true: a car halfway down the lane is somewhere its
   * space is not, and holding the space is the whole reason nobody else takes it
   * while it is on its way.
   */
  parkedCars() {
    const out = [];
    for (const cu of Object.values(this.customers)) {
      if (!cu.drive || !cu.car) continue;
      out.push({
        id: cu.id, vehicle: cu.car,
        x: r2(cu.drive.x), z: r2(cu.drive.z), facing: r2(cu.drive.facing ?? 0),
      });
    }
    return out;
  }

  /**
   * Who still walks up when the shutters are down, and how many of them mind.
   *
   * `SHUT_FOOTFALL` is the share of normal footfall that still turns up: the
   * town does not know you have shut, so somebody sets off, and the ones who
   * would have arrived later in the hour see the closed door from across the
   * road and never bother. Not 1.0 for that reason, and not 0 because a shop
   * that is invisible while shut is a shop whose shutters cost nothing.
   *
   * `SHUT_ANGER` is the share of those who take it personally, and the rest
   * shrug — which is what makes shutting for twenty minutes different in kind
   * from shutting for the afternoon rather than just smaller. It is a share
   * rather than a smaller hit each because that is the thing being modelled: one
   * annoyed regular, not thirty faintly disappointed ones.
   *
   * The hit itself sits between a turn-away at a packed door (0.005) and a
   * storm-out (0.03). Walking up to a shut shop in the middle of the day is
   * worse than finding it too busy — that at least says the place is popular —
   * and not as bad as queueing for ten minutes and giving up.
   */
  stepSpawning(dt, c, folded) {
    if (c.archetypes.length === 0) return;
    // Shut, but the town is still out and about. They arrive, find the door
    // closed, and go home — which is the whole feature: `isOpen` used to bail
    // here, so a shop that shut at noon simply stopped existing until it opened
    // again, and the shutters were free.
    if (!this.isOpen()) return this.stepShutArrivals(dt, folded);
    // Open again, so the next stretch of being shut gets its own line in the log.
    this.sayingShut = false;
    const rate = footfall({
      day: this.day, hourFraction: this.time,
      reputation: this.reputation, folded, catchment: this.catchment(),
      pullFloor: this.town.pullFloor,
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
        this.moveRep(-0.005, R.TURNED);
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
      /**
       * Who they are, as opposed to what they are.
       *
       * The archetype is still the interesting half to the shop — "a Foodie:
       * no artisanal" is a restocking instruction —
       * but it is a demographic, and the log was writing sentences about
       * "a Budget Parent" as though that were somebody's name. Both, now: the
       * name says which trip this was and the archetype says what to do about
       * it.
       *
       * Mostly people, some machines (`BOT_SHOPPER_SHARE`). A shopper is a
       * capsule with a nose, so nothing on screen contradicts either — unlike a
       * hire, who is visibly a machine.
       *
       * Off the namer's own stream, so a shopper's name costs the balance
       * stream nothing: the basket, budget and jitter draws below are the same
       * numbers from the same rolls they were before names existed. Avoided
       * against everyone currently in the shop and everyone on the payroll —
       * two people answering to one name at the same till is the sort of thing
       * that reads as the game having lost track of somebody.
       */
      name: this.namer.unique(
        [...Object.values(this.customers).map((c) => c.name), ...this.roster.map((e) => e.name)],
        { bot: this.namer.botShopper() },
      ),
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
      // Which space they are holding, or null for everybody who walked. The
      // CLAIM on the cell and nothing else now: it is what `freeSpace` reads so
      // nobody else takes it, and where they walk back to when they are done.
      // Where the car actually *is* is `drive`, which is a different answer for
      // the length of the lane — see `parkedCars`.
      parkedAt: car ? { x: space.x, z: space.z } : null,
      car: car?.id ?? null,
      // Nose out along the bay, worked out once when it was claimed. This is
      // the facing it settles at — while it is moving, `followPath` decides.
      parkedFacing: car ? (space.facing ?? 0) : 0,
      // Where the CAR stands: the middle of its two cells. `parkedAt` is the
      // anchor — the cell nearest the door, which is the one its driver walks
      // back to — and a two-tile car standing on that one alone hangs out of
      // the front of the bay.
      parkedMid: car ? { ...(space.mid ?? { x: space.x, z: space.z }) } : null,
      /**
       * The car's body, or null for anyone who walked: `{ x, z, facing, path,
       * phase }`, which is exactly the shape `followPath` drives and exactly
       * the shape the van is.
       *
       * Filled in below, because whether it starts at the edge of the map or
       * standing in its space is the one decision this feature makes.
       */
      drive: null,
      /**
       * ...and the lane it came in on, kept rather than looked up on the way
       * out. Same reason the van copies `lane.out` when it loads: a re-flow
       * between arriving and leaving would otherwise hand the car a route
       * computed for a shop it is standing in the wrong version of.
       */
      lane: null,
      wantCount: units,
      list: this.rollList(arch, units),
      errandAt: -1,
      missed: [],
      settled: false,
      impulsed: false,
      patience: arch.patience,
      waited: 0,
      // Read at the door rather than stored on the shop, so a planter you put
      // down helps the next person in and never the queue already inside — the
      // same rule `patience` follows, and the one that keeps a re-flow from
      // being a mood event.
      mood: this.moodBase(),
      storming: false,
      visited: [],
      targetShelf: null,
      till: null,
      wantHint: null,
    };
    this.customers[id] = cust;
    if (car) this.stats.drove++;

    /**
     * ...and if they drove, the car exists before they do.
     *
     * A lane means they arrive: the car is put down eight tiles off the map at
     * `lane.in[0]`, the shopper rides in it, and neither of them is in the shop
     * until it stops. `DRIVE` is what says so — see `stepCustomers` for the
     * three places that had to learn about a customer who has not arrived, and
     * `stepMood` for the one that costs money if it doesn't.
     *
     * No lane means the space has no straight run out to the border, and the
     * answer is exactly what this did before step 5: the car is simply standing
     * there and its driver walks in. The parking works, the arrival is not
     * something you can watch. An animation that can fail must never decide
     * whether the mechanic happens — the same bargain `loadVan` strikes about a
     * walled-in yard, and the reason `parkSpaces` keeps a lane-less cell.
     */
    const lane = car ? (space.lane ?? null) : null;
    if (car) {
      const start = lane ? lane.in[0] : (space.mid ?? space);
      cust.drive = {
        x: start.x,
        z: start.z,
        facing: cust.parkedFacing,
        // `followPath` eats this from the front, so it is a copy — the space's
        // lane is read by every car that ever parks there.
        path: lane ? lane.in.slice(1).map((p) => ({ ...p })) : [],
        phase: lane ? 'in' : 'parked',
      };
      cust.lane = lane;
    }
    if (lane) {
      cust.state = 'DRIVE';
      // The body rides with the car so that anything asking where this shopper
      // is gets an answer that is at least true. It matters in exactly one
      // place: `regenerateLayout` despawns whoever is off the tile grid, and a
      // driver still out on the approach road should go the same way a walker
      // out on the footpath does.
      cust.x = cust.drive.x;
      cust.z = cust.drive.z;
      return ok({ id, archetype: arch.id, drove: true });
    }

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
   *
   * **What the town is going mad for is read here, and it does two things.** It
   * scales the opportunistic draw — a bakery craze puts more bread on more
   * lists — and above `CRAZE_STAPLE` it makes the line a *staple*, which is the
   * half that actually costs the shop something: only a `must` line reaches
   * `failLine`'s charge, so without the promotion an unfulfilled event was
   * lost sales and no reputation at all. It can only ever promote something
   * they already wanted, which falls out of the draw rather than being a rule:
   * a tag with no affinity is never on the list, so a Health Nut still does not
   * come in for junk in the middle of a junk craze.
   *
   * The multiplier is applied to the *weights* rather than by a second draw, so
   * a shop with no modifiers on it calls `this.rng` exactly as many times as it
   * did before and every balance number downstream is untouched — the trap
   * `Game.namer` exists for, said about an event table.
   */
  rollList(arch, units, folded = this.folded()) {
    const demand = folded?.demand ?? {};
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
      .map(([tag, w]) => ({ tag, w: w * (demand[tag] ?? 1) }));
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

    // ...and anything the town is pulling hard enough on is what they came in
    // for. Last, over the finished list, so a craze promotes a staple tag they
    // were always going to ask for as readily as a line the draw just handed
    // them — and so a slump can never demote one, since a `must` is a fact
    // about the archetype and an event is weather.
    for (const line of lines.values()) {
      if ((demand[line.tag] ?? 1) >= CRAZE_STAPLE) line.must = true;
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
      this.moveRep(-REP_MISSED_STAPLE * cust.missed.length, R.MISSED);
      /**
       * Who, and what sort of shopper they were.
       *
       * Both, and in that order, because they answer different questions. The
       * name is what makes a line about one trip rather than about a
       * demographic — the same person can turn up in three lines on one visit,
       * and "A Foodie… A Foodie… A Foodie…" never said whether that was one
       * bad afternoon or three. The archetype is the restocking instruction and
       * has to survive, which is why it stays in the sentence rather than being
       * replaced by the name.
       *
       * A customer written before names (there are none saved, but the sim runs
       * against ephemeral games and sweeps that build their own) falls back to
       * naming the archetype alone.
       */
      const kind = arch?.name ?? 'customer';
      const who = cust.name ? `${cust.name} (${kind})` : kind;
      // One line per KIND of miss rather than per line, so a shopper who struck
      // out on two tags for the same reason reads as one sentence.
      const byWhy = new Map();
      for (const m of cust.missed) byWhy.set(m.why, [...(byWhy.get(m.why) ?? []), m]);
      for (const [why, misses] of byWhy) {
        const tags = misses.map((m) => tagLabel(m.tag)).join(' and ');
        const it = misses[0];
        /**
         * Said as short as it can be said and still be four different
         * instructions. A miss line is the commonest thing in the feed by a
         * distance — a shop with a gap in its range writes one per shopper —
         * so every word that is not telling the player what to stock is a word
         * pushing the rest of the day off the bottom of the log. What each
         * sentence has to keep is the tag (what to buy) or, where a price is
         * what turned them away, the item and the price (what to reprice); the
         * scene-setting "came in for… and you had none" around it was saying
         * the same thing four times a minute.
         */
        this.pushLog(
          why === 'none' ? `${who}: no ${tags}.`
            : why === 'blocked' ? `${who}: couldn't reach the ${tags}.`
              : why === 'budget' ? `${who}: ${tags} out of their budget.`
                : `${who}: ${it.what} at $${it.price.toFixed(2)}, too expensive.`,
        );
      }
    }

    if (cust.basket.length) return this.goToTill(cust, arch);
    if (first) {
      // Walking out empty-handed is a much stronger signal than a happy sale,
      // so it moves reputation harder — otherwise a busy shop can post great
      // numbers while quietly failing a third of its customers.
      this.moveRep(-0.015, R.EMPTY);
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
    // WHO is walking, which the rest of this file has never had to ask. Nothing
    // on an entity says which sort of thing it is, and `archetype_id` is the one
    // field only a shopper has — six of the eight callers here are customers.
    // Staff and the player route as they always did: a signed doorway is an
    // ordinary opening to everybody who works here.
    // A shopper walks round a box; everybody who works here walks over it. Built
    // per call rather than cached on the tick, because a route is planned once
    // and followed for many ticks — and a stale clutter set is a shopper
    // threading a crate that is no longer there, or refusing one that is.
    const shopper = !!entity.archetype_id;
    const path = findPath(this.walk, this.layout, from ?? entity, goal,
      { shopper, clutter: shopper ? this.clutterTiles() : null });
    entity.path = path ?? [];
    if (path && from) entity.path.unshift({ x: from.x, z: from.z });
    return path !== null;
  }

  /**
   * Drive a shopper's car along the leg it is on.
   *
   * `followPath` and nothing else — the same function the van drives with and
   * the same one their own legs use, handed a lane decided once per re-flow
   * rather than found per tick. **A vehicle is not a person**, which is the
   * whole reason `carLanes` exists rather than an A* call: a hatchback that
   * threaded between two planters and turned on the spot would read as a bug in
   * the renderer.
   *
   * The body rides along with the car. Nothing draws them — `snapshot` leaves a
   * shopper in a car out of `customers` — but a position that is a lie is a
   * position something eventually reads, and here it is `regenerateLayout`
   * asking who is off the edge of the world.
   *
   * Arriving is where the shopping trip actually begins: the car is set down
   * exactly on its space at the facing it was given when the space was claimed,
   * rather than wherever the last waypoint left it pointing, because a lane is
   * whole tiles and a car nosed in at the angle of the road is a car parked
   * across the bay. From there they walk in, which is the tick this used to
   * start on.
   */
  stepDrive(cust, dt) {
    const d = cust.drive;
    if (!d) { this.despawn(cust); return; }

    const speed = content().byId.vehicles?.[cust.car]?.speed || CAR_SPEED;
    const arrived = followPath(d, speed, dt);
    cust.x = d.x;
    cust.z = d.z;
    if (!arrived) return;

    // Off the map, and that is the end of them. The space goes back on the same
    // tick, which is the latest it possibly could — see `driveOff`.
    if (cust.state === 'DEPART') { this.despawn(cust); return; }

    this.parkNow(cust);
  }

  /**
   * Put the car in its space and start the shopping trip.
   *
   * Two callers and they are the same event told two ways: the car finished its
   * lane, or the shop was rebuilt underneath it and the lane is gone. Either
   * way the answer is the state a car park had before it had any lanes at all —
   * standing in the space it claimed, driver walking in.
   *
   * It is set down exactly on the cell at the facing worked out when the space
   * was claimed, rather than wherever the last waypoint left it pointing. A
   * lane is whole tiles and its final leg runs along the road, so a car nosed in
   * at the angle it was travelling is a car parked across the bay.
   */
  parkNow(cust) {
    const d = cust.drive;
    if (!d || !cust.parkedAt) { this.despawn(cust); return; }
    d.phase = 'parked';
    d.path = [];
    const mid = cust.parkedMid ?? cust.parkedAt;
    d.x = mid.x;
    d.z = mid.z;
    d.facing = cust.parkedFacing;
    // ...and their driver gets out onto the ANCHOR cell, which is a tile A*
    // can route out of. The car's midpoint is on the line between two of them.
    cust.x = cust.parkedAt.x;
    cust.z = cust.parkedAt.z;
    cust.state = 'ENTER';
    this.pathTo(cust, { x: this.layout.door.x, z: this.layout.door.z - 1 });
  }

  /**
   * The end of a shop: get in and go, or simply be gone.
   *
   * One function for both because from here they are the same event — somebody
   * has reached the tile they were walking to and there is nothing left for
   * them in the shop. A walker has no car and despawns where the old code
   * despawned them; a driver whose space had no lane despawns too, because the
   * car that appeared out of nothing is allowed to leave the same way.
   *
   * A driver with a lane holds their space for the length of the drive out, and
   * that is deliberate rather than incidental: the space is theirs until the
   * car is off the map, so a pad of one cell serves one shopping trip at a time
   * end to end. Freeing it as they pulled away would let the next arrival be
   * put down on top of a car still reversing off it.
   */
  driveOff(cust) {
    const out = cust.lane?.out;
    if (!cust.drive || !out || out.length < 2) { this.despawn(cust); return; }
    cust.state = 'DEPART';
    cust.drive.phase = 'out';
    // `out[0]` is the space it is standing in — see `laneVia`.
    cust.drive.path = out.slice(1).map((p) => ({ ...p }));
  }

  stepCustomers(dt, c, folded) {
    const open = this.isOpen();
    for (const cust of Object.values(this.customers)) {
      const arch = c.byId.archetypes[cust.archetype_id];
      if (!arch) { this.despawn(cust); continue; }
      if (!open && this.lastOrders(cust)) continue;
      if (this.stepMood(cust, dt)) continue;   // walked out; already heading for the door

      switch (cust.state) {
        // Still in the car, coming in or going out. `dt` and not the world
        // delta, for the reason `driveVan` takes it: a body with wheels must
        // not do six times the speed once the night is being skipped through.
        case 'DRIVE':
        case 'DEPART':
          this.stepDrive(cust, dt);
          break;

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
          if (followPath(cust, CUSTOMER_SPEED * (cust.storming ? STORM_SPEED : 1), dt)) {
            // At the door, or at their car. `driveOff` answers both — a walker
            // and a driver with nowhere to drive are the same despawn.
            this.driveOff(cust);
          }
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
    // Not yet through the door, or already on their way out — and `inACar` is
    // the same clause about somebody who has not even parked yet. Patience is a
    // budget the SHOP draws on, and a drive is not the shop's doing.
    if (cust.state === 'ENTER' || cust.state === 'LEAVE' || inACar(cust)) return false;

    let annoy = ANNOY_IN_SHOP;
    // `till` is set the moment a slot is claimed, so walking up the line costs
    // the same as standing in it.
    if (cust.till) annoy += ANNOY_LINE;
    // Everyone inside pays for the crush, whatever they're doing.
    if (this.occupancy > CROWD_FROM) annoy += ANNOY_CROWD * (this.occupancy - CROWD_FROM);
    // ...and the state of the place. Same shape as the crush and for the same
    // reason: everybody inside pays it whatever they are doing, because it is a
    // fact about the room rather than about their errand.
    if (this.mess > MESS_FROM) annoy += ANNOY_MESS * (this.mess - MESS_FROM);

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
    // Somebody already driving away is as dealt-with as it gets.
    if (cust.state === 'DEPART') return false;

    // Turned round on the approach — on foot, or at the wheel. A driver who
    // arrived at a shut shop and then walked to the door would be the one
    // arrival the shutters do not stop.
    if (cust.state === 'ENTER' || cust.state === 'DRIVE') { this.despawn(cust); return true; }

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
    // What the walk-out cost, rather than how many things were in the basket.
    // A count is a fact about the basket and the money is a fact about the
    // shop: three items is either 90c of crisps or a trolley of cheese, and
    // which of those just went out of the door is the whole reason the line is
    // worth reading. The prices are the ones this shopper was quoted (they are
    // stamped onto the basket line at pick-up), so it is the sale that did not
    // happen and not a list price.
    const lost = cust.basket.reduce((s, b) => s + b.price, 0);
    this.stats.abandoned++;
    this.moveRep(-0.03, R.STORMED);
    this.pushLog(lost > 0
      ? `A ${name} stormed out — $${lost.toFixed(2)} left behind.`
      : `A ${name} stormed out.`);
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
    // Happy customers nudge reputation up; a long wait blunts that — and past
    // `MOOD_ANNOYED` it goes the other way, which is the half that was missing.
    //
    // `0.004 * mood` could only ever be a gain, so every completed sale paid you
    // back however grim the trip was: a shop could annoy everybody in it, sell to
    // all of them anyway, and climb. That is the bounce-back. Pivoting on the
    // same threshold the sim already calls annoyed (and the mood bar already
    // changes colour at) means a perfect trip is worth exactly what it always
    // was, and a bad one now costs instead of paying a little less.
    //
    // Banked under two names for one number, split on the sign it came out
    // with. Netted, a busy afternoon reads "sales: nothing" and hides the whole
    // point — that you gained from forty people and gave it back to eleven who
    // had a miserable time getting served — and those are two different things
    // to do something about.
    const mood = 0.008 * (cust.mood - MOOD_ANNOYED);
    this.moveRep(mood, mood < 0 ? R.GRUMPY : R.SERVED);
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

  /**
   * ...and the other half of what decorating is worth: the mood people walk in
   * on. See `MOOD_BASE`.
   *
   * The same saturating fraction `charmReach` scales, deliberately reused
   * rather than given a curve of its own — one lot of charm is one fact about
   * the shop, and two curves would mean a room that was lovely enough to widen
   * the town but not to cheer anybody up, which is not a sentence about a shop.
   * What differs is what it is scaled INTO: reach adds people, this one closes
   * the gap up to a perfect 1 and can never exceed it.
   */
  moodBase() {
    // What the town expects today, which decays from `MOOD_BASE` towards
    // `MOOD_FLOOR` — see the note there. The charm lift is measured from
    // whatever that has become rather than from the day-one figure, or a shop
    // decorated in its first week would keep the walk-in it earned then for
    // ever and the slide would be a number nothing reads.
    //
    // Both ends of that slide are the difficulty preset's — what the town
    // expects on day one and what it has come to expect a year in. `MOOD_TAU` is
    // not: how *fast* standards rise is the same fact for everybody, and a
    // preset that moved it as well would be saying two things with one button.
    const { moodBase, moodFloor } = this.town;
    const want = moodFloor + (moodBase - moodFloor)
      * Math.exp(-Math.max(0, this.day - 1) / MOOD_TAU);
    const c = this.charm();
    const lift = c > 0 ? 1 - Math.exp(-c / CHARM_HALF) : 0;
    const room = want + (1 - want) * lift;
    // ...and what they had heard, which scales the room rather than adding to
    // it. See `MOOD_REP`: a shop with no name gets three quarters of whatever
    // the room was worth, and the room is still the way back.
    return clamp(room * (1 - MOOD_REP + MOOD_REP * clamp(this.reputation, 0, 1)), 0, 1);
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

    // Somebody who drove walks back to the car, gets in, and drives off — see
    // `driveOff`, which is where the walk ends. Their space is held right up
    // until `despawn` and no earlier: a car that freed its bay the moment its
    // owner joined the queue is a car park that holds more shopping trips than
    // it holds cars, and one that freed it as the car pulled away would put the
    // next arrival down on top of it.
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
    // Any pile in the box your hands have room for. The old test asked whether
    // the crate held the one thing you were carrying, which with mixed
    // containers on both ends is neither necessary nor sufficient.
    if (pallet && lotStacks(pallet).some((s) => lotRoom(p.carry, s.item_id, this.carryLot(p)) > 0)) {
      return this.unload(playerId, pallet.id);
    }
    if (p.carry && this.onPad(p, this.dropPadKind())) return this.stow(playerId);

    // 3. An appliance: take the finished product, or tip in what you're holding.
    const station = this.nearest(this.layout.stations ?? [], p, REACH, (o) => o.useAt);
    if (station) {
      if (station.output) return this.collectStation(playerId, station.id);
      if (p.carry) return this.loadStation(playerId, station.id);
      if (p.haul) return this.loadStation(playerId, station.id, { from: 'haul' });
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

  /**
   * Put a line on the feed.
   *
   * Every line carries an `id`, which the client keys its DOM lines by. That is
   * what makes `logGoods` below possible at all: a line that grows a second item
   * has to be the SAME line on screen, not a new one shoved on top of it, and
   * the client has no other way to tell "this entry changed" from "here is
   * another entry".
   */
  pushLog(msg, extra = null) {
    // A batch is folding them (`bulkFixtures`): the six lines one press wrote
    // are six spellings of one event, and the batch writes that event itself.
    // Collected rather than dropped, because a batch that landed on exactly one
    // fixture keeps the line the verb wrote for it.
    if (this.logFold) { this.logFold.push(msg); return; }
    this.logSeq = (this.logSeq ?? 0) + 1;
    this.log.push({ id: this.logSeq, day: this.day, t: r2(this.time), msg, ...(extra ?? {}) });
    if (this.log.length > 200) this.log.shift();
  }

  /**
   * One line for a run of the same thing happening to several items.
   *
   * `endPull` above makes this argument about a single gesture; this is the same
   * argument about a job loop. `restock` orders one board at a time — that is
   * what makes it stop at the right amount — so a shop topping itself up wrote
   * five lines saying "3x Bread ordered", "6x Milk ordered"… and the feed shows
   * six. What a player wants to know is that a van was called and what is on it,
   * which is one event, and the itemising was pushing everything else off the
   * bottom.
   *
   * So a caller hands over its own goods and a `key`, and a second call with the
   * same key **amends the line it already wrote** rather than adding to the pile.
   * Only ever the newest line, deliberately: anything else happening in between
   * is a real event that came after, and reaching back past it to grow an older
   * line would print the shop's history out of order. A `null` key never merges,
   * which is what a one-off with several items in it wants — a strip, a hopper
   * tipped out — and it is the honest spelling of "this is one event", rather
   * than an id nothing will ever match.
   *
   * The goods are on the entry twice. `msg` spells them out in words, which is
   * what MCP's `get_log` and every headless reader see; `goods` is the same list
   * as data, which the client draws as `2x <icon>` chips instead — six names is
   * a paragraph and six icons is a glance. Keep both: a feed that only rendered
   * as pictures would say nothing to anything that isn't the browser.
   */
  /**
   * "Marla took" / "Took" — who did it, in front of the sentence.
   *
   * Two things come back rather than one, and they are not the same fact. The
   * words go in `msg`, which is the only channel MCP and the verify sweeps have;
   * `by` is the roster id, which the client resolves to a *picture* of that hire
   * at their grade and in their skin — `artForWorker`, the same call the roster
   * bar makes. A name alone would be the staff-glyph bug wearing text: four bots
   * doing four different things, told apart only by reading.
   *
   * Nothing for the player. It is your own shop and your own hands, so a chip
   * saying you did the thing you just did is a label on every line that carries
   * no news — and the absence of one is then exactly the signal that matters,
   * which is "somebody else did this".
   *
   * The id and not the name, because a hire can be renamed, repainted and
   * promoted after the line is written, and the line should follow them. A hire
   * who has been let go resolves to nothing and the line keeps its words, which
   * is why the name is in `msg` as well.
   */
  saidBy(playerId, verb) {
    const p = this.players[playerId];
    return p?.hire
      ? { by: p.hire, verb: `${p.name} ${verb}` }
      : { by: null, verb: verb[0].toUpperCase() + verb.slice(1) };
  }

  logGoods(key, { pre = '', post = '', goods, by = null }) {
    const add = (into) => {
      for (const g of goods) {
        if (!(g.qty > 0)) continue;
        const had = into.find((x) => x.item_id === g.item_id);
        if (had) had.qty += g.qty;
        else into.push({ item_id: g.item_id, qty: g.qty });
      }
      return into;
    };
    const last = this.log[this.log.length - 1];
    // Who did it is part of the match, not just the key. Two hires working the
    // same shelf are two events with two faces on them, and folding them into
    // one line would put one bot's name on the other's armful.
    if (key && last?.key === key && last.day === this.day
      && (last.by ?? null) === by && Array.isArray(last.goods)) {
      add(last.goods);
      last.t = r2(this.time);
      last.msg = `${pre}${saidGoods(last.goods)}${post}`;
      return;
    }
    const own = add([]);
    if (!own.length) return;
    this.pushLog(`${pre}${saidGoods(own)}${post}`, { key, goods: own, pre, post, by });
  }
}

// ---------------------------------------------------------------------------

/**
 * "2x Bread, 6x Milk" — the words half of a `logGoods` line.
 *
 * Falls back to the id for an item the catalogue no longer has, the way every
 * other reader of a stored `item_id` does. A line is written once and read
 * afterwards, so the row it names can be deleted between the two — see
 * `binOrphans`.
 */
function saidGoods(goods) {
  const items = content().byId.items;
  return goods.map((g) => `${g.qty}x ${items[g.item_id]?.name ?? g.item_id}`).join(', ');
}

function freshStats() {
  return {
    revenue: 0, spent: 0, sold: 0, abandoned: 0,
    spoiled: 0, spoiledValue: 0, harvested: 0, tilled: 0, leftEmpty: 0, turnedAway: 0, foundShut: 0, byItem: {},
    // What moved reputation today, by cause, signed. Not a second copy of the
    // counts above: `abandoned` says three people stormed out and this says what
    // that cost, which is the only form the question is ever asked in — a shop
    // sheds reputation from seven different places at seven different rates, so
    // "one walked out" and "the shop was packed for an hour" are the same size
    // of incident and nothing like the same size of damage. Written by exactly
    // one function (`moveRep`), so it cannot drift from the number it explains.
    repMoves: {},
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
// Moved to `shared/build.js` when the client had to ask it too — the press that
// names a unit is refused out of reach, so the client decides whether to send
// and this decides whether it lands. Re-exported under the name this file has
// always called it, so nothing below had to learn a new one.
const workSpot = workSpotOf;

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
 * Reputation, to a tenth of a percentage point.
 *
 * Its own precision rather than `r2`'s, because reputation is read as a
 * percentage: two decimals of a 0..1 number is whole points only, which would
 * round every single one of the day's causes to nothing and print a breakdown
 * of zeroes under a bar that had visibly moved. Three is exactly what the panel
 * shows — one decimal of a point — so the wire, the ledger and the readout all
 * agree by construction.
 */
const round3 = (v) => Math.round(v * 1000) / 1000;
/** The same map, rounded, for the wire. See `Game.moveRep`. */
const repMovesOut = (moves) => Object.fromEntries(
  Object.entries(moves ?? {}).map(([k, v]) => [k, round3(v)]).filter(([, v]) => v !== 0),
);
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
