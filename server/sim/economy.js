/**
 * THE ECONOMY — where "adaptive" actually happens.
 *
 * Every number here is derived from TAGS, never from item ids. That's the
 * whole reason a brand-new AI-invented item slots straight into a running
 * game: the moment it exists it has demand, a fair price, seasonal swings and
 * a set of customers who want it, all inferred from its tags.
 *
 * Nothing in this file needs to change when content is added. If you find
 * yourself writing `if (item.id === ...)` here, stop — add a tag instead.
 */

import { desireFor, DEPARTMENTS } from '../../shared/tags.js';

/**
 * Collapse the active modifier rows into per-tag multipliers.
 * Multiple modifiers on the same tag stack multiplicatively (a heat wave
 * during a viral-drink trend really should compound).
 */
/**
 * How far a tag's multiplier is ever allowed to travel. Events overlap — a
 * three-day shortage that fires again on day two used to multiply with itself,
 * and three copies of a 1.9x price event put lettuce on the shelf at $59
 * against a $2.50 base. Nobody could afford anything and the shop looked
 * broken rather than eventful.
 */
const PRICE_BAND = [0.35, 2.5];
const DEMAND_BAND = [0.1, 4];
/**
 * ...and the same ceiling said about people, which is tighter at the top than
 * demand's on purpose. A tag's spawn multiplier is a share of every arrival,
 * and a `3` on one archetype in a town of twenty is already most of the queue;
 * past that an event stops reading as a takeover and starts reading as the
 * other nineteen kinds of shopper having been deleted. The floor is 0 rather
 * than 0.1 because "nobody like that comes in today" is a story an event is
 * allowed to tell, where a demand of zero is a shop nothing can sell out of.
 */
const SPAWN_BAND = [0, 3];

/**
 * Whichever of two rows pulls a tag further from 1 on one field.
 *
 * The `?? 1` matters on `spawn_mult` and is harmless on the two older fields,
 * which is why it is written once rather than three times: `spawn_mult` is a
 * column added to a table that already had rows in it, so a modifier really can
 * arrive without one — from a web store's vault, which keeps its rows as
 * objects rather than behind a column with a DEFAULT. Read bare it is
 * `undefined`, `undefined - 1` is NaN, and NaN loses every comparison, so the
 * strongest pull would silently become whichever row happened to come first.
 */
const strongerPull = (a, b, field) => (
  Math.abs((a[field] ?? 1) - 1) > Math.abs((b[field] ?? 1) - 1)
    ? (a[field] ?? 1)
    : (b[field] ?? 1)
);

/**
 * One row per event-and-tag: within one event take its strongest pull on a tag
 * rather than stacking its own duplicates; across different events, genuine
 * compounding is fine.
 *
 * A pile of identical rows is a bookkeeping artefact, not five heat waves — see
 * `addModifier`, which now refuses to write one.
 */
function dedupeModifiers(modifiers) {
  const perEvent = new Map();
  for (const m of modifiers) {
    const key = `${m.label || m.source}::${m.tag}`;
    const prev = perEvent.get(key);
    if (!prev) { perEvent.set(key, m); continue; }
    perEvent.set(key, {
      ...m,
      demand_mult: strongerPull(m, prev, 'demand_mult'),
      price_mult: strongerPull(m, prev, 'price_mult'),
      spawn_mult: strongerPull(m, prev, 'spawn_mult'),
    });
  }
  return [...perEvent.values()];
}

export function foldModifiers(modifiers) {
  const demand = {};
  const price = {};
  // Who walks in, keyed by an ARCHETYPE's tag rather than an item's — the same
  // table, read by `spawnCustomer` instead of by pricing. The two vocabularies
  // are allowed to overlap and nothing here cares: a tag no archetype carries
  // is an entry nobody ever looks up, which is exactly what `demand` already
  // does with a tag nothing stocks.
  const spawn = {};
  for (const m of dedupeModifiers(modifiers)) {
    demand[m.tag] = (demand[m.tag] ?? 1) * m.demand_mult;
    price[m.tag] = (price[m.tag] ?? 1) * m.price_mult;
    spawn[m.tag] = (spawn[m.tag] ?? 1) * (m.spawn_mult ?? 1);
  }
  for (const t of Object.keys(demand)) demand[t] = clamp(demand[t], DEMAND_BAND[0], DEMAND_BAND[1]);
  for (const t of Object.keys(price)) price[t] = clamp(price[t], PRICE_BAND[0], PRICE_BAND[1]);
  for (const t of Object.keys(spawn)) spawn[t] = clamp(spawn[t], SPAWN_BAND[0], SPAWN_BAND[1]);
  // An all-1 table is deleted rather than carried, and that is not tidiness —
  // `spawnCustomer` short-circuits on an empty one to leave its draw exactly
  // as it found it, and every modifier in every save today folds to all-1.
  for (const t of Object.keys(spawn)) if (spawn[t] === 1) delete spawn[t];
  return { demand, price, spawn };
}

/**
 * The folded tables as a list, strongest pull on demand first — the shape the
 * HUD meter draws.
 *
 * One entry per *tag*, not per event, and that is the point: a baking craze
 * wanting bakery and a heat wave not wanting it used to be two pills arguing
 * with each other on screen, when what the customer actually does is the
 * product of the two. Fold first, draw second, and the strip can never disagree
 * with the sim.
 */
export function modifierMeter({ demand, price }) {
  const tags = new Set([...Object.keys(demand), ...Object.keys(price)]);
  return [...tags]
    .map((tag) => ({ tag, demand: round2(demand[tag] ?? 1), price: round2(price[tag] ?? 1) }))
    .filter((m) => m.demand !== 1 || m.price !== 1)
    .sort((a, b) => Math.abs(Math.log(b.demand)) - Math.abs(Math.log(a.demand)));
}

/**
 * Fewest asks a department needs before a missed one is allowed to fill the bar.
 *
 * One shopper coming in for meat on a quiet Tuesday and finding none is a 100%
 * failure rate on a sample of one, and without a floor it draws exactly as long
 * a bar as a department failing forty people. The smoothing in `demand` damps
 * this across days; this damps it within one.
 */
const MIN_WANT = 3;

/**
 * THE DEMAND METER — what the town is asking of each department, against what
 * your shop actually does about it.
 *
 * This is an RCI meter and it is built like one: a fixed set of channels in a
 * fixed order, present whether or not anything is happening, each showing
 * *pressure* rather than activity. Its predecessor drew the active world-event
 * modifiers folded per tag, which looks similar and is a different thing
 * entirely — the rows were whichever tags the director had written about, so
 * they appeared and expired under you, and a week with no events drew nothing
 * at all. You cannot learn to read a panel whose rows move.
 *
 * Every bar is one signed number in -1..1, and the two halves are two different
 * measurements deliberately, because "stock more of this" and "you are wasting
 * shelves on this" are not ends of one scale:
 *
 *   right — the share of asks naming that department you failed to fill. People
 *           came in for it and walked out without it.
 *   left  — the share of your shelf boards given to that department beyond what
 *           its share of *sales* justifies. It is sat there not earning.
 *
 * The two halves read two different tallies on purpose, and the first cut got
 * this wrong in a way worth recording. Both were asks, which meant a department
 * nobody names directly pinned at full negative forever however well it sold —
 * `frozen` and `prepared` are in no archetype's affinities, so a frozen pizza
 * only ever leaves the shop by answering a `cheap` or `kids` line. Measured on
 * asks, a shop selling nine frozen lines a day was told to tear its freezers
 * out. Sales are observable for every department whether or not anyone can name
 * it, which is why the left half is `moved` and not `served`.
 *
 * Boards rather than units, and that is the other load-bearing choice: a *full*
 * shelf of tinned goods is a shop doing its job, and measuring stock in units
 * would read forty tins against six sales and call a well-kept aisle an
 * overstock. What can actually be wrong is the *allocation* — three boards given
 * to a department nobody shops — and allocation is counted in boards. It is also
 * the half a player can act on: you cannot un-buy stock, but you can relabel a
 * shelf.
 *
 * With nothing recorded at all, every bar is zero rather than fully negative. A
 * shop on its first morning has stocked shelves and no shoppers yet, and a meter
 * reading "get rid of all of it" is worse than one reading nothing, which is at
 * least true.
 *
 * @param asked  smoothed asks per tag — see `Game.demandNow`
 * @param served smoothed fills per tag, same scale
 * @param moved  smoothed units sold per department, same scale
 * @param boards how many shelf boards carry each department
 * @param folded the active modifier tables, so an event that says the town
 *               wants twice the bakery moves the bakery bar
 */
export function departmentMeter({ asked, served, moved, boards, folded }) {
  const rows = DEPARTMENTS.map((dept) => {
    const event = folded.demand[dept] ?? 1;
    return {
      dept,
      event: round2(event),
      want: (asked[dept] ?? 0) * event,
      got: served[dept] ?? 0,
      sales: moved[dept] ?? 0,
      boards: boards[dept] ?? 0,
    };
  });

  const totalSales = rows.reduce((s, r) => s + r.sales, 0);
  const totalWant = rows.reduce((s, r) => s + r.want, 0);
  const totalBoards = rows.reduce((s, r) => s + r.boards, 0);

  // Only `net`, `fill`, `boards` and `event` leave here. `want`, `got` and
  // `sales` are smoothed indices rather than counts of shoppers — see
  // `Game.demandNow` — so putting them on the wire would hand the HUD figures
  // that look like counts and are not. `fill` is the same information as a
  // share, which is true at any scale, and `boards` really is a count.
  return rows.map(({ dept, event, want, got, sales, boards: b }) => {
    const fill = want > 0 ? round2(Math.min(1, got / want)) : null;
    // Nobody has shopped here yet, so nothing is short and nothing is spare.
    if (totalWant <= 0 && totalSales <= 0) return { dept, net: 0, fill, boards: b, event };
    const short = want > 0
      ? Math.min(1, Math.max(0, want - got) / Math.max(MIN_WANT, want))
      : 0;
    const deserves = totalSales > 0 ? (sales / totalSales) * totalBoards : 0;
    const spare = b > 0 ? Math.max(0, b - deserves) / b : 0;
    return { dept, net: round2(clamp(short - spare, -1, 1)), fill, boards: b, event };
  });
}

/** Strongest multiplier across all of an item's tags. */
function tagMult(item, table) {
  let mult = 1;
  for (const tag of item.tags) {
    if (table[tag] !== undefined) mult *= table[tag];
  }
  return mult;
}

/** Seasonal nudge: in-season items sell better, out-of-season ones sag a bit. */
const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
export function seasonMult(item, season) {
  const itemSeasons = item.tags.filter((t) => SEASONS.includes(t));
  if (itemSeasons.length === 0) return 1;
  return itemSeasons.includes(season) ? 1.35 : 0.75;
}

/**
 * What the supplier charges you today.
 * Shortage events push this up, which is what makes them hurt.
 */
export function wholesalePrice(item, folded, season) {
  return item.base_cost * tagMult(item, folded.price) * (1 + (seasonMult(item, season) - 1) * 0.3);
}

/**
 * The price the game suggests you charge. Players can override per shelf —
 * this is just the default and the "fair value" the AI reasons about.
 */
export function suggestedPrice(item, folded, season) {
  return round2(item.base_price * tagMult(item, folded.price) * seasonMult(item, season));
}

/**
 * Will this customer put this item in their basket?
 *
 * Combines: how much their tags say they want it, how inflated the price is
 * versus fair value, how price-sensitive they are, and the current world
 * modifiers. Returns a 0..1-ish probability the sim rolls against.
 */
export function purchaseChance({ item, archetype, price, folded, season, reputation = 0.5 }) {
  const desire = desireFor(item, archetype.affinities);
  if (desire <= 0) return 0;

  const fair = suggestedPrice(item, folded, season);
  // How overpriced is it? 1.0 = fair, 2.0 = double.
  const ratio = fair > 0 ? price / fair : 1;

  // Price pain grows faster than linearly, scaled by how much they care.
  const overcharge = Math.max(0, ratio - 1);
  const pricePenalty = overcharge ** 1.6 * (0.4 + archetype.price_sensitivity * 2.2);

  // A bargain is actively tempting.
  const bargainBonus = Math.max(0, 1 - ratio) * archetype.price_sensitivity * 1.2;

  const demandBoost = tagMult(item, folded.demand);
  const seasonBoost = seasonMult(item, season);

  const raw = desire * demandBoost * seasonBoost * (0.75 + reputation * 0.5)
    + bargainBonus
    - pricePenalty;

  return clamp(raw / 2.2, 0, 0.97);
}

/**
 * How determined somebody is about the thing they left the house for.
 *
 * `purchaseChance` is a *browse* — the odds that something you happened to walk
 * past is tempting enough — and the `/ 2.2` above is what makes it one: a fair
 * price and a healthy affinity comes out around a quarter, because most of what
 * a shopper walks past should stay on the shelf. Rolling a staple against that
 * same number is the bug this exists to fix. A Budget Parent whose staple is
 * `dairy` had a 24% chance of taking fairly-priced milk off the only dairy
 * shelf in the shop, and the other 76% were logged to the player as *"came in
 * for dairy and you had none"* — see `Game.failLine`. Milk matches one affinity
 * at 0.6, so no amount of stocking or pricing could move it.
 *
 * The curve is "they will look at more than one before giving up": one browse
 * repeated `STAPLE_RESOLVE` times. It is deliberately a transform of the browse
 * odds rather than a number of its own, because that keeps the two properties
 * that matter. Priced out is still priced out — 0 maps to 0, so an overpriced
 * staple is refused exactly as hard as it was, and the ladder of consequences
 * for gouging is untouched. And everything that already moves a purchase —
 * reputation, a world event, the season, a bargain — still moves this, in the
 * same direction, without a second formula to keep in step.
 */
const STAPLE_RESOLVE = 3;
export function stapleChance(browse) {
  return clamp(1 - (1 - clamp(browse, 0, 1)) ** STAPLE_RESOLVE, 0, 0.97);
}

/**
 * Score every stocked shelf for a customer and return the ones worth walking to,
 * best first. Used by the customer FSM to pick a destination.
 */
/**
 * How close to a till a board has to be to be an endcap, in tiles.
 *
 * There is no endcap fixture and there should not be one — `BUILD_KINDS` is
 * closed because where a thing may go is behaviour, and an endcap is neither a
 * new behaviour nor a new piece. It is a shelf you chose to put next to a
 * checkout, so it is a distance, and that makes *placement* worth money.
 *
 * Here rather than beside `impulseBuy`, which is where it started, because two
 * things read it now: the sim, to decide whether somebody in the queue is
 * looking at it, and `pickItem`, to decide what the shop stocks there. Those
 * two disagreeing is the shop auto-filling a spot it then prices as ordinary.
 * `staff.js` cannot import `sim/index.js` — that file imports it — so a shared
 * constant had to live somewhere neither owns.
 */
export const IMPULSE_RADIUS = 2.6;

export function rankShelves({ shelves, items, archetype, folded, season, reputation, boardPull }) {
  const scored = [];
  for (const shelf of shelves) {
    // One entry per BOARD, not per unit. A shelf holding milk and cheese is two
    // offers standing in one place, and collapsing it to one would make which of
    // them a shopper sees depend on which board happened to be written first.
    // `stack` rides along because everything downstream — the price they pay,
    // the qty they take, the board they take it off — is the stack's, not the
    // fixture's.
    for (const stack of shelf.stacks ?? []) {
      if (!stack.item_id || stack.qty <= 0) continue;
      const item = items[stack.item_id];
      if (!item) continue;
      // …times how good a spot the board is in. A multiplier applied here
      // rather than a term inside `purchaseChance`, because that function is
      // about the ITEM and the PERSON — what it costs, who wants it, what the
      // season is doing to it — and where a shop chose to stand it is a fact
      // about neither. Same shape `LIST_BONUS`, `stapleChance` and the impulse
      // pull all take: one clean chance, weighted by its caller's own question.
      //
      // Applied BEFORE the 0.05 cut, or a board can be ranked in on a height it
      // is then not judged by, which is a shopper walking to the bottom shelf
      // for something they were never going to buy.
      const chance = purchaseChance({
        item, archetype, price: stack.price, folded, season, reputation,
      }) * (boardPull ? boardPull(shelf, stack.item_id) : 1);
      if (chance > 0.05) scored.push({ shelf, stack, item, chance });
    }
  }
  scored.sort((a, b) => b.chance - a.chance);
  return scored;
}

/**
 * The two humps of a shopping day — a morning rush and a bigger after-work one
 * — plus the flat trickle in between. Peaks at 1.60 (the evening); averages
 * 0.765 across the whole day.
 *
 * BOTH PEAKS HAVE TO LIE INSIDE TRADING HOURS, and the morning one did not.
 *
 * This is a *shape* over the whole 24, so it answers perfectly well at 3am —
 * and nothing ever asks it there, because `stepSpawning` bails on `isOpen()`
 * and `stepShutArrivals` bails on `trading()`. So the hours outside 08:00–20:00
 * are not a trickle nobody sees, they are footfall that never happens: whatever
 * the curve puts there is thrown away, silently, every single day.
 *
 * The morning peak sat at 0.32 — **07:41**, nineteen minutes before opening —
 * with σ = √(0.012/2) = 0.0775, so 43% of the morning hump fell before the
 * doors and was simply deleted. What that reads as from a chair is a dead
 * morning and a shop that only wakes up after lunch, which is a complaint about
 * the *day*, not about a constant nineteen minutes out. On a day-1 shop
 * (catchment 18.2, pull 0.47) it was 6 arrivals between 08:00 and 12:00 against
 * 12 across the same four hours of the afternoon.
 *
 * 0.375 is 09:00 — a real hour somebody would shop at, 0.54σ inside opening,
 * and the whole-day mean and peak are untouched (0.765 / 1.60) because the
 * curve did not change shape, only where it sits. Measured on the same shop:
 * 26 → 29 arrivals a day, and the morning goes 6 → 9.
 *
 * It is deliberately NOT pushed further in. The evening peak sits 1.615σ inside
 * closing, and matching that would put the morning at 11:00, which stops being
 * a morning rush and merges with the after-work one — two humps is the thing
 * being modelled.
 *
 * The trap for the next hand on these numbers: `OPEN_HOUR`/`CLOSE_HOUR` live in
 * `server/sim/index.js` and a licence can widen them (`buyUpgrade`, the 24-hour
 * one), so this file cannot import them and the agreement is by hand. Move a
 * peak, or move the trading hours, and check the peak is still under the roof.
 */
export function dayShape(hourFraction) {
  const t = hourFraction;
  const morning = Math.exp(-((t - 0.375) ** 2) / 0.012);
  const evening = Math.exp(-((t - 0.68) ** 2) / 0.018) * 1.35;
  return 0.25 + morning + evening;
}

/**
 * What share of the people in range choose your shop today, 0..1.
 *
 * Split out from footfall because it is the half that your *shopkeeping*
 * moves, and it is bounded: you cannot pull more than everybody. Reputation
 * used to be an unbounded multiplier on an invented constant, which is a very
 * different thing — it meant a good shop conjured people out of nowhere and
 * had no ceiling to work towards.
 *
 * A world event still makes the town keener, but only up to the same 1.0.
 *
 * `floor` is the difficulty preset's (`shared/difficulty.js`), and it is a
 * parameter rather than a constant for one reason: it is the number that
 * decides whether a shop nobody rates still has an income. It defaults to the
 * gentle preset's 0.08, so every caller that has not been told otherwise — and
 * every test of this function on its own — behaves exactly as it always did.
 */
export function pull({ reputation, folded, floor = 0.08 }) {
  const mods = Object.values(folded.demand);
  const pressure = mods.length ? mods.reduce((a, b) => a + b, 0) / mods.length : 1;
  // Nobody has heard of a brand new shop, and nobody hates one either — the
  // floor is what walks past and comes in anyway.
  return clamp(reputation * clamp(pressure, 0.4, 3), floor, 1);
}

/**
 * How many customers should be milling about right now, per minute.
 *
 *     catchment × pull × shape
 *
 * `catchment` is how many people are within reach of the shop — the town, not
 * the shop. It is the one term shopkeeping cannot move, which is exactly why
 * it is here: without it reputation was a closed loop with nothing outside it,
 * it pinned at 1.0 within a few days of any competent run, and from then on
 * the shop had a fixed ceiling it could neither raise nor fall from. Stock
 * bought you customers, a bigger shop always paid for itself, and there was no
 * such thing as building something the town could not support.
 *
 * Now the ceiling is the town's, and moving it is what an upgrade is for.
 *
 * Three things move it, and they are all the same sentence — how far away
 * somebody would come from. An upgrade is a better address, `charmReach` is a
 * shop worth crossing town for, and `parkReach` is somewhere to put the car. The
 * two you can *build* both saturate against a ceiling of their own
 * (`Game.catchment`), because a term you can pour ground or pot plants into
 * without limit is not a town, it is a printing press.
 *
 * None of that makes it a term shopkeeping moves. Restocking, pricing and
 * serving still cannot touch it — they are `pull`, they are bounded by 1.0, and
 * that is still the whole reason the split is here.
 */
export function footfall({ day, hourFraction, reputation, folded, catchment = 16, pullFloor }) {
  // Weekends are busier — more of the town is out and about, not a keener town.
  const weekend = day % 7 === 6 || day % 7 === 0 ? 1.5 : 1;
  return catchment * weekend * dayShape(hourFraction) * pull({ reputation, folded, floor: pullFloor });
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round2 = (v) => Math.round(v * 100) / 100;
