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

import { desireFor } from '../../shared/tags.js';

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
      demand_mult: Math.abs(m.demand_mult - 1) > Math.abs(prev.demand_mult - 1) ? m.demand_mult : prev.demand_mult,
      price_mult: Math.abs(m.price_mult - 1) > Math.abs(prev.price_mult - 1) ? m.price_mult : prev.price_mult,
    });
  }
  return [...perEvent.values()];
}

export function foldModifiers(modifiers) {
  const demand = {};
  const price = {};
  for (const m of dedupeModifiers(modifiers)) {
    demand[m.tag] = (demand[m.tag] ?? 1) * m.demand_mult;
    price[m.tag] = (price[m.tag] ?? 1) * m.price_mult;
  }
  for (const t of Object.keys(demand)) demand[t] = clamp(demand[t], DEMAND_BAND[0], DEMAND_BAND[1]);
  for (const t of Object.keys(price)) price[t] = clamp(price[t], PRICE_BAND[0], PRICE_BAND[1]);
  return { demand, price };
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
 * Score every stocked shelf for a customer and return the ones worth walking to,
 * best first. Used by the customer FSM to pick a destination.
 */
export function rankShelves({ shelves, items, archetype, folded, season, reputation }) {
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
      const chance = purchaseChance({
        item, archetype, price: stack.price, folded, season, reputation,
      });
      if (chance > 0.05) scored.push({ shelf, stack, item, chance });
    }
  }
  scored.sort((a, b) => b.chance - a.chance);
  return scored;
}

/**
 * The two humps of a shopping day — a morning rush and a bigger after-work one
 * — plus the flat trickle in between. Peaks a little over 2; averages ~0.64
 * across the whole day.
 */
export function dayShape(hourFraction) {
  const t = hourFraction;
  const morning = Math.exp(-((t - 0.32) ** 2) / 0.012);
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
 */
export function pull({ reputation, folded }) {
  const mods = Object.values(folded.demand);
  const pressure = mods.length ? mods.reduce((a, b) => a + b, 0) / mods.length : 1;
  // Nobody has heard of a brand new shop, and nobody hates one either — the
  // floor is what walks past and comes in anyway.
  return clamp(reputation * clamp(pressure, 0.4, 3), 0.08, 1);
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
 */
export function footfall({ day, hourFraction, reputation, folded, catchment = 16 }) {
  // Weekends are busier — more of the town is out and about, not a keener town.
  const weekend = day % 7 === 6 || day % 7 === 0 ? 1.5 : 1;
  return catchment * weekend * dayShape(hourFraction) * pull({ reputation, folded });
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round2 = (v) => Math.round(v * 100) / 100;
