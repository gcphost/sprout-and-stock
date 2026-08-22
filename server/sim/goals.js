/**
 * MILESTONES — the shop's own ladder, and the only thing in the game that
 * congratulates you.
 *
 * A shop that is going well and a shop that is going nowhere look identical for
 * the first twenty minutes: the numbers in the corner move, and nothing ever
 * *says* anything. This is the half that says it — forty-five rows, each one a
 * number the shop already keeps, with a reward on the far side of it.
 *
 * Three rules hold the whole thing together, and each of them is why this is a
 * code file rather than a content table:
 *
 * **A milestone is a measurement, not a quest.** Every row is one function of
 * game state that already exists — takings, units sold, crops picked, the day,
 * the roster, reputation. Nothing tracks a milestone *while* you play, nothing
 * has to be armed, and a shop that earned three of them before this shipped
 * gets all three on the next tick. That is also what makes them safe to add:
 * a new row is a new measure, and no save has to know about it.
 *
 * **A reward may not be a thing you unlock.** Cash, a free run of stock on the
 * next van, and the town growing are the three, and all three are numbers that
 * already have a meaning. Anything that granted a fixture or an upgrade would
 * be a second way to own something, and every rule in the shop about what you
 * own is written against `placements` and `ownedUpgrades`.
 *
 * **The town is the one that is worth having.** `Game.catchment` is the term
 * shopkeeping can never move — you can restock, decorate and pave your way to a
 * better shop, and the number of people who live near it is not a decision.
 * Growing it is the one reward that is not more of what you already had, and it
 * is why the modal says how many people are in reach now rather than just
 * naming the milestone.
 */

import { content } from '../content.js';
import { DEPARTMENTS, homeKind } from '../../shared/tags.js';
import { isProp, padCells, shelfKind } from '../../shared/build.js';
import { R } from '../../shared/reputation.js';

/**
 * A lifetime tally, as "the days that are done" plus "today so far".
 *
 * The same split `Game.demandNow` makes, and for the same reason: `stats` is
 * wiped every morning, so a milestone measured off it alone would count the
 * first hundred pounds of *every day*, and one measured off `totals` alone
 * would not move until the day rolled over — which on day one is the entire
 * session. `ledger` cannot answer it either: it is capped at 30 days, so
 * lifetime takings stop being recoverable from it the month after they matter.
 */
const lifetime = (g, key) => (g.totals?.[key] ?? 0) + (g.stats?.[key] ?? 0);

/**
 * ...and the same tally for TODAY alone, which is the other kind of rung.
 *
 * "Take $50,000" is a shop that kept going; "take $2,500 in one day" is a shop
 * that had a Saturday, and the two are different achievements that happen to be
 * measured in dollars. `stats` is wiped every morning, which is exactly what
 * makes it the right source here and the wrong one above.
 */
const today = (g, key) => g.stats?.[key] ?? 0;

/**
 * A rung that is a yes/no, as the number the ladder is written in.
 *
 * `measure` is compared with `>=` against `need`, so a claim like "you have
 * built a kitchen" is `need: 1` and this. The panel draws a bar off `have/need`
 * that will read empty and then full with nothing in between, which is right —
 * there is no such thing as being two thirds of the way to owning an oven, and
 * `first-sale` has read that way since the ladder shipped.
 */
const yes = (b) => (b ? 1 : 0);

/** How many of a kind of fixture are standing in the shop. */
const built = (g, kind) => (g.placements ?? []).filter((p) => p.kind === kind).length;

/**
 * THE ONE RULE A NEW RUNG HAS TO OBEY, because it is not obvious and the sweep
 * is unforgiving: **the first instant a measure is true is the award**.
 *
 * `checkMilestones` runs once a second of world time and marks a rung done for
 * ever, so a measure only means what it says if it is true at a *moment* that
 * deserves it. Three shapes work and one does not:
 *
 * - `lifetime` and standing state (the day, the roster, what is built) only ever
 *   climb, so any instant they pass the bar is the right one.
 * - `today` peaks are fine for COUNTS — `stats.sold` reaching 100 is a fact
 *   about the day whatever happens after it.
 * - `today` is a trap for ABSENCES. "A day with nobody turned away" is true at
 *   00:01 on every day the shop has ever had, so it would award itself on the
 *   next tick and read as the ladder being broken. `flawless-day` is the one
 *   rung of that shape and it waits for `!g.trading()` with a hundred sales
 *   already banked — the absence is only a claim once the day is over.
 */


/**
 * The ladder. Roughly in the order a shop meets them, which is the order the
 * panel lists them in — nothing enforces it, and nothing has to: they are
 * measurements, so earning them out of order is simply a shop that did.
 *
 * `unit` is how the number reads rather than what it is, because "$100" and
 * "100 sold" are the same integer and only one of them makes sense with a
 * dollar sign in front of it.
 */
export const MILESTONES = [
  {
    id: 'first-sale',
    name: 'Open for business',
    blurb: 'Sell something to somebody who walked in off the street.',
    unit: 'count',
    need: 1,
    /**
     * Every rung pays cash, and this one pays the float over again.
     *
     * A shop opens on $250, which is about two crates and a seed tray — so the
     * first hour was spent waiting for one shelf to sell through before
     * anything could be done at all. Doubling the float the moment somebody
     * buys something turns the opening from a wait into a choice, and it is
     * paid out of the one event that proves the shop works rather than handed
     * over at creation, where it would just be a bigger starting number nobody
     * earned.
     *
     * The opening is deliberately the steep part — 250, then 500 for the first
     * hundred taken, then 500 for the first seed in the ground — because that
     * is the stretch where the float is the reason nothing is happening. The
     * middle is just as deliberately flat: a shop taking $2,000 does not need
     * $400, and the reason that rung still pays is that a ladder with a gap in
     * it reads as a rung that is broken.
     */
    measure: (g) => lifetime(g, 'sold'),
    reward: { cash: 250, supplies: 12 },
  },
  {
    /**
     * THE ONE RUNG THAT IS NOT A CONGRATULATION.
     *
     * Patience is a budget every annoyance draws on and it is entirely
     * invisible: a shopper who has had enough turns round and walks out, and
     * from across the shop that is the same picture as a shopper leaving
     * because they are done. The only trace is a line in the feed and 0.03 off
     * the slowest number in the game — so the first thing anybody learns about
     * the mechanic is a reputation bar that has been sliding for a week.
     *
     * The ladder is the machinery that already stops the world to explain
     * something, so this borrows it rather than inventing a second modal. What
     * it costs is that the file's own header says milestones are the thing that
     * congratulates you, and one row here does not. That is the honest trade:
     * the alternative is a card of its own with its own arming, its own
     * once-ever flag and its own reason not to fire twice, all of which
     * `checkMilestones` already is.
     *
     * It obeys the one rule a rung has to: `repMoves` is wiped every morning,
     * but `checkMilestones` runs once a second, so the first instant it is true
     * is inside the day it happened. Measured off the CAUSE rather than off a
     * counter of its own — a storm-out already writes `R.STORMED` through
     * `moveRep`, so this is a measurement of state the shop keeps and not a new
     * thing to keep.
     *
     * The reward is deliberately the smallest one on the ladder and it is
     * `supplies` rather than cash: a card that hands you money for upsetting
     * somebody reads as a bounty on it, where a van bringing stock reads as the
     * thing to do about it — which is what the blurb says to do.
     */
    id: 'first-storm',
    name: 'Somebody walked out',
    blurb: 'A shopper ran out of patience and left with nothing. Queues, bare '
      + 'shelves and a crowded floor all wear people down — and one who leaves '
      + 'angry costs you six who were merely turned away.',
    unit: 'count',
    need: 1,
    measure: (g) => yes((g.stats?.repMoves?.[R.STORMED] ?? 0) < 0),
    reward: { supplies: 12 },
    // Not the fanfare. See `sound` in `checkMilestones`' payload.
    sound: 'angry',
  },
  {
    id: 'take-100',
    name: 'First hundred',
    blurb: 'Take $100 over the counter.',
    unit: 'money',
    need: 100,
    measure: (g) => lifetime(g, 'revenue'),
    // Five times what it asks for, which is the only rung on the ladder that
    // pays a multiple of its own bar. The opening is where money is the
    // difference between a decision and a wait, and $100 of takings is a shop
    // that has proved it works and still cannot afford to change anything
    // about itself.
    reward: { cash: 500, town: 1, supplies: 12 },
  },
  {
    id: 'first-plant',
    name: 'Something in the ground',
    blurb: 'Put a seed in one of your beds and let it get on with it.',
    unit: 'count',
    need: 1,
    // The bed rather than the crop, because `first-harvest` below already has
    // the crop and the two are a fortnight apart. The farm is the one system
    // you own on day one and can go a week without pressing a button on: four
    // beds of bare soil look exactly like four beds you are resting.
    measure: (g) => yes((g.layout?.plots ?? []).some((p) => p.crop_id)),
    /**
     * Enough to start up the ladder rather than enough to finish it.
     *
     * Taking all four starting beds to Greenhouse is 4 × ($90 + $260) = $1,400,
     * and tier costs take no discount — `plot-2` and `plot-3` cut what a NEW
     * bed costs to build, never what an existing one costs to improve. Paying
     * the whole $1,400 here was tried and is not what this rung is for: it
     * lands in the first two minutes, so it would have been bigger than every
     * rung below `take-10000` and would have handed over the finished farm in
     * exchange for one seed. $500 is five raised beds' worth of the first step,
     * which is the decision — the second step is one the farm can pay for.
     */
    reward: { cash: 500, supplies: 6 },
  },
  {
    id: 'first-harvest',
    name: 'Something you grew',
    blurb: 'Pick a crop off one of your own beds.',
    unit: 'count',
    need: 1,
    measure: (g) => lifetime(g, 'harvested'),
    reward: { cash: 50 },
  },
  {
    id: 'take-500',
    name: 'Five hundred taken',
    blurb: 'Keep the tills busy until the shop has taken $500.',
    unit: 'money',
    need: 500,
    measure: (g) => lifetime(g, 'revenue'),
    // Double what it asks for, and the last rung that pays a multiple of its own
    // bar — the opening is `first-sale` 250, `take-100` 500, `first-plant` 500
    // and this, and after it the ladder goes back to being sized against the
    // shop rather than against the float.
    reward: { cash: 1000, supplies: 18 },
  },
  {
    id: 'first-hire',
    name: 'Something else to do it',
    blurb: 'Put a unit on the floor. It stocks, it serves, and the lease comes off the till every morning.',
    unit: 'count',
    need: 1,
    measure: (g) => g.roster.length,
    reward: { cash: 150, supplies: 18 },
  },
  {
    id: 'first-build',
    name: 'Something you drew',
    blurb: 'Put up a wall, a window or a doorway of your own.',
    unit: 'count',
    need: 1,
    /**
     * `edits` is the player's overlay on the generated shell, so the building
     * you were handed cannot satisfy this — it is one edge you decided on.
     *
     * Deliberately the lowest bar on the ladder. Build mode is the largest
     * system in the game and the only one with nothing on the shop floor to
     * walk into: a shelf is where the shelves are, a bed is out the back, and a
     * wall is a mode you have to already know is there.
     */
    measure: (g) => (g.edits ?? []).filter((e) => e.k > 0).length,
    reward: { cash: 100, supplies: 12 },
  },
  {
    id: 'sold-100',
    name: 'A hundred sales',
    blurb: 'A hundred things over the counter, whatever they were.',
    unit: 'count',
    need: 100,
    measure: (g) => lifetime(g, 'sold'),
    reward: { cash: 200, supplies: 24 },
  },
  /*
   * ---------------------------------------------------------------------------
   * THE SURVIVAL RUNGS, which are the one sub-ladder you cannot fail and the
   * only reason they pay what they pay.
   *
   * Every other rung on the ladder is a thing the shop DID — takings, sales,
   * a wall you drew, a crop you picked — and each of them is therefore a
   * measurement of how well it is going. `g.day` is not: it is a measurement of
   * having turned up, which is worth nothing on day ninety and is worth the
   * whole opening on day seven. A shop starts on $250 — two crates and a seed
   * tray — and until the first shelf sells through there is nothing to decide
   * with, so the early game reads as a wait rather than a shop.
   *
   * So the survival ladder is front-loaded and tapers: $500 at a week, $350 at
   * two, $250 at three, and then a month is its own step up at $600. That is
   * backwards from every other run of rungs in here, and deliberately: what it
   * is paying for is the float being thin, and the float stops being thin.
   * By `hundred-days` it is back to being a nod.
   *
   * None of the three new ones pays `town`, and that is not an oversight — the
   * sixteen rungs that do are sized so that finishing the ladder exactly doubles
   * the catchment you started with (see `milestoneReach`). A rung added to fix
   * an opening should not quietly move the number the whole endgame is built on.
   * ---------------------------------------------------------------------------
   */

  {
    id: 'week-one',
    name: 'A week in',
    blurb: 'Still open on day seven.',
    unit: 'day',
    need: 7,
    measure: (g) => g.day,
    // The biggest single payment on the ladder until `take-2000`, and it lands
    // about forty minutes in. A week of trading on the starting float leaves a
    // shop with a range it chose one crate at a time; this is the first moment
    // it can buy a decision rather than a restock.
    reward: { cash: 500, town: 1, supplies: 24 },
  },
  {
    id: 'range-6',
    name: 'Six departments',
    blurb: 'Have goods on the shelves from six different parts of the shop at once.',
    unit: 'count',
    need: 6,
    // Breadth, which is the one thing takings cannot say: a shop selling
    // nothing but crisps and a shop selling groceries book the same money, and
    // only one of them fills a shopping list. `stats.unmet` is the number this
    // is really about — a tag somebody came in for and walked past you for.
    measure: (g) => stockedDepartments(g).size,
    reward: { cash: 250, supplies: 24 },
  },
  {
    id: 'take-2000',
    name: 'Two thousand taken',
    blurb: 'Word is getting round.',
    unit: 'money',
    need: 2000,
    measure: (g) => lifetime(g, 'revenue'),
    reward: { cash: 400, town: 1, supplies: 24 },
  },
  {
    id: 'best-day-500',
    name: 'A five-hundred-dollar day',
    blurb: 'Take $500 between opening and closing.',
    unit: 'money',
    need: 500,
    // The first rung measured on `stats` rather than the lifetime tally, and
    // the pair is the point: `take-2000` above is a shop that kept going, this
    // is a shop that had a Saturday.
    measure: (g) => today(g, 'revenue'),
    // Matched to the day it asks for — a shop that can take $500 between
    // opening and closing can spend $500 on being able to do it again.
    reward: { cash: 500, supplies: 24 },
  },
  {
    id: 'week-two',
    name: 'A fortnight',
    blurb: 'Still open on day fourteen.',
    unit: 'day',
    need: 14,
    measure: (g) => g.day,
    reward: { cash: 350, supplies: 24 },
  },
  {
    id: 'week-three',
    name: 'Three weeks',
    blurb: 'Still open on day twenty-one.',
    unit: 'day',
    need: 21,
    // The last of the weeklies. Day 28 would be a fourth and it is not here:
    // `month-one` is eight in-game hours later, and two rungs that close
    // together read as one rung that fired twice.
    measure: (g) => g.day,
    reward: { cash: 250, supplies: 24 },
  },
  {
    id: 'month-one',
    name: 'A month in',
    blurb: 'Still open on day thirty.',
    unit: 'day',
    need: 30,
    measure: (g) => g.day,
    // Up from the weeklies rather than down from them: the tapering run is
    // weeks, and a month is the next unit up rather than the fourth week.
    reward: { cash: 600, town: 1, supplies: 36 },
  },
  {
    id: 'harvest-100',
    name: 'A hundred picked',
    blurb: 'A hundred crops off your own beds — stock nobody had to pay for.',
    unit: 'count',
    need: 100,
    measure: (g) => lifetime(g, 'harvested'),
    reward: { cash: 300, town: 1 },
  },
  {
    id: 'crew-3',
    name: 'A shift of three',
    blurb: 'Three units on lease at once — somebody can be on a charge and the doors stay open.',
    unit: 'count',
    need: 3,
    measure: (g) => g.roster.length,
    reward: { cash: 300, supplies: 24 },
  },
  {
    id: 'first-promotion',
    name: 'A firmware update',
    blurb: 'Move one of your crew up a grade.',
    unit: 'count',
    need: 2,
    // The best grade on the roster, so a shop that has only ever hired reads
    // 1/2 — which is true, and is the point: everybody starts on grade one and
    // the ladder above it is the half nobody presses. It goes down as well as
    // up, so this can read lower tomorrow; a rung already earned stays earned,
    // which is the same promise `week-one` makes about a shop that shuts.
    measure: (g) => g.roster.reduce((n, r) => Math.max(n, r.tier ?? 1), 0),
    reward: { cash: 250, supplies: 18 },
  },
  {
    id: 'well-liked',
    name: 'Well thought of',
    blurb: 'Get the shop’s reputation up to three quarters.',
    unit: 'percent',
    need: 0.75,
    measure: (g) => g.reputation,
    reward: { cash: 500, town: 1, supplies: 24 },
  },
  {
    id: 'break-room',
    name: 'Somewhere to charge',
    blurb: 'Paint a break area. One cell seats one of your crew.',
    unit: 'count',
    need: 1,
    // Painted cells rather than "somebody took a break in it", because a break
    // has always happened *somewhere* — the shop with no room takes them at the
    // spot the pastime authored, and a rung that could not tell those apart
    // would be true of every shop in the game.
    measure: (g) => padCells(g.layout, 'break').length,
    reward: { cash: 300, supplies: 18 },
  },
  {
    id: 'sold-500',
    name: 'Five hundred sales',
    blurb: 'The shop is a habit for somebody now.',
    unit: 'count',
    need: 500,
    measure: (g) => lifetime(g, 'sold'),
    reward: { cash: 750, town: 1, supplies: 36 },
  },
  {
    id: 'stockroom',
    name: 'Out the back',
    blurb: 'Keep a unit back-of-house, so the shop floor has something behind it.',
    unit: 'count',
    need: 1,
    measure: (g) => yes((g.layout?.shelves ?? []).some((s) => s.boh)),
    reward: { cash: 350, supplies: 24 },
  },
  {
    id: 'first-kitchen',
    name: 'Something the shop makes itself',
    blurb: 'Put an appliance on the floor — an oven, a juicer, a coffee machine.',
    unit: 'count',
    need: 1,
    measure: (g) => built(g, 'station'),
    reward: { cash: 450, supplies: 24 },
  },
  {
    id: 'first-warmer',
    name: 'Kept hot',
    blurb: 'Build a hot counter — the third thing a unit of shelving can be.',
    unit: 'count',
    need: 1,
    measure: (g) => built(g, 'warmer'),
    reward: { cash: 450, supplies: 24 },
  },
  {
    id: 'car-park',
    name: 'Somewhere to park',
    blurb: 'Paint a bay a shopper can drive into and walk to the door from.',
    unit: 'count',
    need: 1,
    // `parkSpaces` rather than painted cells: a bay is two cells, and one
    // nobody can reach on foot widens the town by nothing. It is the same
    // function the sim claims a space out of, so the rung cannot disagree with
    // whether anybody actually parks there.
    measure: (g) => g.parkSpaces().length,
    reward: { cash: 500, town: 1, supplies: 24 },
  },
  {
    id: 'take-10000',
    name: 'Ten thousand taken',
    blurb: 'The corner shop that everybody uses.',
    unit: 'money',
    need: 10000,
    measure: (g) => lifetime(g, 'revenue'),
    reward: { cash: 1500, supplies: 36 },
  },

  /*
   * ---------------------------------------------------------------------------
   * THE FAR END, which exists because the ladder used to stop here.
   *
   * `take-10000` was the top rung, and a shop taking a thousand a day meets it
   * on about day twelve — so the feature that exists to say something about how
   * the shop is doing went quiet for every shop that was doing well, which is
   * exactly backwards. A live save was seventy days past the end of it.
   *
   * Two rules shape this half, and neither applies to the twelve above:
   *
   * **The rungs get further apart than the shop gets bigger.** Takings climb
   * 10k → 25k → 50k → 100k → 250k, so each one is a longer wait than the last
   * even for a shop that is still growing. A ladder whose rungs kept pace would
   * be a progress bar, and the point of a milestone is that it is occasional.
   *
   * **The town is the only reward that still means anything up here.** $2,000
   * is a decision on day nine and a rounding error on day ninety, and a free
   * van of stock is worth less the better stocked you are — but `catchment` is
   * a term nothing else in the game can move, so it is the reward every rung
   * from here that is genuinely hard pays. See the note on `milestoneReach`.
   * ---------------------------------------------------------------------------
   */

  {
    id: 'best-day-1000',
    name: 'A thousand-dollar day',
    blurb: 'Take $1,000 between opening and closing.',
    unit: 'money',
    need: 1000,
    measure: (g) => today(g, 'revenue'),
    reward: { cash: 600, supplies: 36 },
  },
  {
    id: 'harvest-500',
    name: 'Five hundred picked',
    blurb: 'Five hundred crops off your own beds.',
    unit: 'count',
    need: 500,
    measure: (g) => lifetime(g, 'harvested'),
    reward: { cash: 700, town: 1, supplies: 36 },
  },
  {
    id: 'sold-1000',
    name: 'A thousand sales',
    blurb: 'A thousand things over the counter.',
    unit: 'count',
    need: 1000,
    measure: (g) => lifetime(g, 'sold'),
    reward: { cash: 800, supplies: 36 },
  },
  {
    id: 'charming',
    name: 'Worth crossing town for',
    blurb: 'Get the shop to ten charm — lamps, plants, awnings, anything somebody chose.',
    unit: 'count',
    need: 10,
    // Charm rather than `charmReach`, because reach saturates. Ten charm is
    // about half way to `CHARM_MAX`, which is the point where another planter
    // has visibly stopped paying — so the rung has measured the whole of what
    // decorating is worth rather than asking for a warehouse of pot plants.
    measure: (g) => g.charm(),
    reward: { cash: 900, supplies: 24 },
  },
  {
    id: 'fixtures-25',
    name: 'A proper shop',
    blurb: 'Twenty-five fixtures standing on the floor.',
    unit: 'count',
    need: 25,
    // Props excluded, or a wall of bunting is a supermarket. `isProp` is the
    // same test that decides a thing weighs nothing: a decoration stamps no
    // tile and reserves no working spot, so counting one here would be counting
    // something nobody can shop from.
    measure: (g) => (g.placements ?? []).filter((p) => !isProp(p.kind)).length,
    reward: { cash: 1000, supplies: 36 },
  },
  {
    id: 'crew-6',
    name: 'Six on the floor',
    blurb: 'Six units on lease. That is a rota rather than a shift.',
    unit: 'count',
    need: 6,
    measure: (g) => g.roster.length,
    reward: { cash: 1100, supplies: 36 },
  },
  {
    id: 'hundred-days',
    name: 'A hundred days',
    blurb: 'Still here on day one hundred.',
    unit: 'day',
    need: 100,
    measure: (g) => g.day,
    reward: { cash: 1250, town: 1, supplies: 36 },
  },
  {
    id: 'take-25000',
    name: 'Twenty-five thousand taken',
    blurb: 'The shop has turned over more than most people earn in a year.',
    unit: 'money',
    need: 25000,
    measure: (g) => lifetime(g, 'revenue'),
    reward: { cash: 2000, supplies: 48 },
  },
  {
    id: 'flawless-day',
    name: 'A day without a hitch',
    blurb: 'Close on a hundred sales with nobody turned away, nobody giving up in the queue and nobody leaving empty-handed.',
    unit: 'count',
    need: 1,
    /**
     * The one rung shaped as an ABSENCE, and the reason the note above the
     * ladder says what it says: all three of these counters read zero at one
     * minute past midnight on the worst day the shop has ever had.
     *
     * `!g.trading()` is what turns them into a result rather than a starting
     * position, and the hundred sales are what stop this being a rung you earn
     * by being quiet — a shop nobody visits turns nobody away. It is also the
     * only rung on the ladder you can fail *by growing*, which is the honest
     * shape of it: every point of `catchment` the rest of the ladder pays makes
     * this one harder until you find the floor space for them.
     */
    measure: (g) => yes(
      !g.trading()
      && today(g, 'sold') >= 100
      && today(g, 'turnedAway') === 0
      && today(g, 'abandoned') === 0
      && today(g, 'leftEmpty') === 0,
    ),
    reward: { cash: 2250, town: 1, supplies: 36 },
  },
  {
    id: 'sold-2500',
    name: 'Twenty-five hundred sales',
    blurb: 'Somebody in this town has bought their dinner off you a hundred times.',
    unit: 'count',
    need: 2500,
    measure: (g) => lifetime(g, 'sold'),
    reward: { cash: 2500, supplies: 48 },
  },
  {
    id: 'spotless',
    name: 'Not a bad word',
    blurb: 'Reputation at a hundred per cent.',
    unit: 'percent',
    need: 1,
    measure: (g) => g.reputation,
    reward: { cash: 2750, town: 1, supplies: 48 },
  },
  {
    id: 'best-day-2500',
    name: 'Two and a half in a day',
    blurb: 'Take $2,500 between opening and closing.',
    unit: 'money',
    need: 2500,
    measure: (g) => today(g, 'revenue'),
    reward: { cash: 3000, supplies: 48 },
  },
  {
    id: 'take-50000',
    name: 'Fifty thousand taken',
    blurb: 'Half way to the number that sounds silly.',
    unit: 'money',
    need: 50000,
    measure: (g) => lifetime(g, 'revenue'),
    reward: { cash: 3500, town: 1, supplies: 48 },
  },
  {
    id: 'harvest-2500',
    name: 'A farm, then',
    blurb: 'Twenty-five hundred crops off your own beds — stock nobody ever paid for.',
    unit: 'count',
    need: 2500,
    measure: (g) => lifetime(g, 'harvested'),
    reward: { cash: 4000, supplies: 48 },
  },
  {
    id: 'crew-12',
    name: 'A dozen on lease',
    blurb: 'Twelve units. The wage bill is a number you check now.',
    unit: 'count',
    need: 12,
    measure: (g) => g.roster.length,
    reward: { cash: 4500, supplies: 48 },
  },
  {
    id: 'take-100000',
    name: 'Six figures',
    blurb: 'A hundred thousand dollars over the counter.',
    unit: 'money',
    need: 100000,
    measure: (g) => lifetime(g, 'revenue'),
    reward: { cash: 6000, town: 1, supplies: 60 },
  },
  {
    id: 'year-one',
    name: 'A year of it',
    blurb: 'Day three hundred and sixty-five. Four winters, and you are still opening up.',
    unit: 'day',
    need: 365,
    measure: (g) => g.day,
    reward: { cash: 7500, town: 1, supplies: 60 },
  },
  {
    id: 'sold-10000',
    name: 'Ten thousand sales',
    blurb: 'Ten thousand things carried out of your door.',
    unit: 'count',
    need: 10000,
    measure: (g) => lifetime(g, 'sold'),
    reward: { cash: 9000, supplies: 60 },
  },
  {
    id: 'take-250000',
    name: 'A quarter of a million',
    blurb: 'The last rung. There is nothing above this one — it is your shop now.',
    unit: 'money',
    need: 250000,
    measure: (g) => lifetime(g, 'revenue'),
    reward: { cash: 12000, town: 1, supplies: 60 },
  },
];

/**
 * Which departments the shop currently has goods on a board of.
 *
 * Read off the shelves rather than off `stats.moved`, because the claim is
 * about the RANGE you keep rather than what happened to sell today — a full
 * dairy board nobody bought from is still a shop that stocks dairy. An empty
 * board does not count, for the same reason a reservation is not stock: what
 * `range-6` is really about is `stats.unmet`, and a shopper cannot buy a label.
 */
function stockedDepartments(g) {
  const c = content();
  const depts = new Set(DEPARTMENTS);
  const out = new Set();
  for (const s of g.layout?.shelves ?? []) {
    for (const k of g.shelfStacks(s)) {
      if (!(k.qty > 0)) continue;
      for (const t of c.byId.items[k.item_id]?.tags ?? []) if (depts.has(t)) out.add(t);
    }
  }
  return out;
}

const byId = Object.fromEntries(MILESTONES.map((m) => [m.id, m]));

/** Earned, as a set. `done` is a plain array on the save so it stays readable. */
const earned = (g) => new Set(g.milestones?.done ?? []);

/**
 * How much bigger the town is because of what you have done, in the units
 * `Game.catchment` adds up in.
 *
 * **Derived from the done list rather than stored beside it**, which is the
 * `fixtureCounts` argument said about a reward: a stored total can double-count
 * a milestone on a restart or keep one you have never earned, and there is
 * nothing to compare it against to find out. A row whose `town` is edited later
 * moves every shop that earned it, which is right — it is a balance number, and
 * balance numbers live in code.
 */
export function milestoneReach(g) {
  let n = 0;
  for (const id of earned(g)) n += byId[id]?.reward?.town ?? 0;
  return n;
}

/**
 * Take the ladder out of a game, for a sweep that is measuring something else.
 *
 * A milestone pays real money and lands real crates, so any script that drives
 * a shop through a sale and then asserts what the cash did is measuring the
 * ladder as well from the day this shipped — `verify:till` caught it on "the
 * shop has not banked the takings — expected 0, got 250". That is the
 * `fresh()` trap in CLAUDE.md in its second form: not a field that was added,
 * but one that newly *matters*.
 *
 * Marked done rather than switched off, because "off" would be a second state
 * the sim has to carry and every reader would have to remember. A sweep that is
 * deliberately testing the ladder simply does not call this.
 *
 * `simulate` deliberately does NOT call it: a balance bot that never sees a
 * feature is the broken instrument, not the honest control.
 */
export function silenceMilestones(g) {
  const all = MILESTONES.map((m) => m.id);
  g.milestones = { done: all, known: [...all] };
}

/** What the shop has done and what is left, as the panel reads it. */
export function milestoneProgress(g) {
  const done = earned(g);
  return MILESTONES.map((m) => ({
    id: m.id,
    name: m.name,
    blurb: m.blurb,
    unit: m.unit,
    need: m.need,
    // Clamped, because a bar that reads 340/100 on something you finished last
    // week is arithmetic where a tick should be.
    have: done.has(m.id) ? m.need : Math.min(m.need, round(m.measure(g))),
    done: done.has(m.id),
    reward: m.reward,
  }));
}

const round = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);

/**
 * Award anything that has come due, and say so.
 *
 * Called from `step`, throttled by the caller — every measure here is a field
 * read or a `length`, so the cost is the loop rather than the work, and once a
 * second is well inside "the moment it happened" for a number that moves at the
 * speed of a shop.
 *
 * Everything it awards goes through the ordinary machinery: cash is cash, the
 * town is a term in `catchment`, and a gift of stock is an order on the next
 * van — nothing here invents a second way for goods or money to arrive.
 */
export function checkMilestones(g) {
  /**
   * A rung this save has never been SWEPT AGAINST banks what is already true
   * rather than celebrating it.
   *
   * A rung is a measurement — it asks whether something is true now, never
   * whether anybody watched it happen — and that is what makes the ladder free
   * to add to. The cost lands entirely on the shop that existed before the rung
   * did: a save on day 148 with thirteen staff and a perfect reputation is
   * three rungs true at once, so opening it fired three cards, stopped the
   * world, and handed over three deliveries before the player had moved.
   * Congratulating somebody for a thing they did last month reads as the
   * feature misfiring, which is the opposite of what a first impression is for.
   *
   * So they are marked done and nothing else: no card, no gift, one log line.
   * They still count toward `milestoneReach` — the town is derived from the
   * done list, deliberately, and a second list of rungs-that-do-not-count would
   * be a number kept beside the shop rather than read off it.
   *
   * **Per rung rather than per save**, which is the half that took two goes to
   * get right. `milestones.opened` asked this question once — had this shop
   * ever been swept? — and that is the same question only while the ladder
   * never changes. Add thirty-one rungs to it and every established shop in the
   * world is already past its opening sweep, so a shop on day 81 meets ten of
   * them in one tick and is congratulated ten times in a row: the exact bad
   * moment `opened` was written to prevent, arriving on the *second* impression
   * instead of the first. Asking per rung cannot go wrong again however many
   * are added later, and it costs one list on the save.
   *
   * A brand-new shop still banks nothing, because on day one with no staff and
   * no sales nothing on the ladder is true yet — which is why this needs no
   * special case for a new world.
   */
  const known = new Set(g.milestones.known ?? []);
  const done = earned(g);
  const banked = [];
  let met = false;
  for (const m of MILESTONES) {
    const fresh = !known.has(m.id);
    if (fresh) {
      met = true;
      known.add(m.id);
      g.milestones.known.push(m.id);
    }
    if (done.has(m.id)) continue;
    if (!(m.measure(g) >= m.need)) continue;
    done.add(m.id);
    g.milestones.done.push(m.id);
    if (fresh) banked.push(m.name);
    else award(g, m);
  }

  if (met) {
    // Straight to the save, rather than waiting for the day to turn: a restart
    // in between would meet these rungs for the first time all over again and
    // say it twice. Harmless either way — the set is the same — but a line
    // about your shop's history that appears on every boot is a line you learn
    // to ignore.
    if (banked.length) {
      g.pushLog(`${banked.length} milestone${banked.length === 1 ? '' : 's'} already met: ${banked.join(', ')}.`);
    }
    g.persist();
  }
}

function award(g, m) {
  const got = [];

  if (m.reward.cash > 0) {
    g.cash = Math.round((g.cash + m.reward.cash) * 100) / 100;
    got.push(`$${m.reward.cash.toFixed(2)}`);
  }

  // The town, spelled out as the number it becomes rather than as the step —
  // "+1" says nothing about a shop whose catchment you have never been shown.
  // `catchment()` already counts this one, because the done list is what it
  // reads and the row went on it above.
  if (m.reward.town > 0) {
    got.push(`the town grew to ${round(g.catchment())} in reach`);
  }

  if (m.reward.supplies > 0) {
    const sent = giftSupplies(g, m.reward.supplies);
    if (sent) got.push(sent);
  }

  g.pushLog(`Milestone: ${m.name}${got.length ? ` — ${got.join(', ')}.` : '.'}`);

  /**
   * ...and the modal, which is the whole point of the feature and the one bit
   * the sim cannot do itself.
   *
   * A queue rather than a call, for the reason the director's headline is one:
   * `Game` has no room and no sockets, and a shop that awarded two milestones
   * in one tick has two things to say. `MartRoom.pushState` drains it.
   */
  g.milestoneNews.push({
    id: m.id,
    name: m.name,
    blurb: m.blurb,
    reward: m.reward,
    // Which noise the card makes, when it is not the fanfare. Only `first-storm`
    // sets it, and it is on the ROW rather than decided by the client so that a
    // rung and the sound it makes cannot drift apart in two files.
    sound: m.sound ?? null,
    got,
    // What the town is now, for every award rather than only the ones that grew
    // it: the modal is where anybody ever finds out this number exists.
    catchment: round(g.catchment()),
  });
}

/**
 * A free run of stock, on the next van.
 *
 * **An order rather than a crate**, which is the one decision in here worth
 * defending. `dropGoods` would put the pallets on the pad this instant and it
 * would be wrong twice over: a gift that teleports is the supplier-as-vending-
 * machine bug that step 1 of docs/deliveries.md removed, and a pile of crates
 * appearing behind you while a modal is up is a delivery nobody saw arrive.
 * Filed as ordinary pending orders at `cost: 0`, the lorry brings it, the
 * stocker puts it away, and the whole feature is four fields.
 *
 * Bounded by `bayRoom` with the rest of the guards, because a run that turns up
 * with more than the pad can hold has nowhere to land — and a shop with no bay
 * at all simply gets the rest of the reward and a line saying so.
 */
function giftSupplies(g, units) {
  const room = g.bayRoom();
  const take = Math.min(units, Math.max(0, room));
  if (take <= 0) return null;

  const picks = giftItems(g, take);
  if (!picks.length) return null;

  const c = content();
  const run = g.nextRun();
  for (const p of picks) {
    g.orders.pending.push({
      id: `ord-${g.nextOrderId++}`,
      item_id: p.id,
      qty: p.qty,
      cost: 0,
      placedDay: g.day,
      placedAt: Math.round(g.time * 24 * 100) / 100,
      runHour: run.hour,
      arrivesAt: g.elapsed + run.wait,
      wait: Math.round(run.wait * 100) / 100,
      // Nothing reads this yet. It is here because a $0 order is otherwise
      // indistinguishable from one somebody placed while the money was in the
      // supplier's hands, and the supplier's list is where it will show up.
      gift: true,
    });
  }
  const total = picks.reduce((n, p) => n + p.qty, 0);
  const what = picks.length === 1
    ? `${total}x ${c.byId.items[picks[0].id]?.name ?? picks[0].id}`
    : `${total} units of stock`;
  return `${what} on the way, free`;
}

/**
 * What to send, and how much of each.
 *
 * The shop's own answer first: whatever `restockQueue` says the shelves are
 * short of, which is the same order the stocker buys in. A gift of something
 * nothing in the shop has a board for is a crate that sits on the pad until it
 * rots, so a kind the shop does not own is never chosen — the `homeKind`/
 * `shelfKind` pair rather than a `frozen` boolean, because a warmer is not a
 * shelf and a boolean cannot say so.
 *
 * The fallback matters more than it looks: a brand-new shop's shelves are bare
 * and unreserved, so `restockQueue` names units without naming goods, and the
 * very first milestone in the ladder is earned in a shop in exactly that state.
 */
function giftItems(g, units) {
  const c = content();
  const owns = new Set(g.layout.shelves.map((s) => shelfKind(s.kind)));
  const crafted = new Set(c.recipes.map((r) => r.output_id));
  const seen = new Set();
  const wanted = [];
  const add = (id) => {
    if (!id || seen.has(id)) return;
    const it = c.byId.items[id];
    // Anything a recipe makes has to be made — `buyStock` refuses to order it,
    // and a gift is not the place to invent an exception to that.
    if (!it || crafted.has(id) || !owns.has(homeKind(it))) return;
    seen.add(id);
    wanted.push(it);
  };

  for (const s of g.restockQueue()) {
    const assigned = Array.isArray(s.assigned) ? s.assigned : [s.assigned];
    for (const id of assigned) add(id);
    for (const k of g.shelfStacks(s)) add(k.item_id);
  }

  if (!wanted.length) {
    for (const it of c.items) {
      if (crafted.has(it.id) || !owns.has(homeKind(it))) continue;
      wanted.push(it);
    }
    // Cheapest first, so a shop with nothing on its shelves is handed the
    // staples it can actually sell rather than one tin of something exotic.
    wanted.sort((a, b) => (a.base_cost ?? 0) - (b.base_cost ?? 0));
  }

  const picks = [];
  let left = units;
  for (const it of wanted.slice(0, 3)) {
    if (left <= 0) break;
    const qty = Math.min(left, it.stack ?? 12);
    if (qty <= 0) continue;
    picks.push({ id: it.id, qty });
    left -= qty;
  }
  return picks;
}
