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

export function foldModifiers(modifiers) {
  // Within one event, take its strongest pull on a tag rather than stacking
  // its own duplicates; across different events, genuine compounding is fine.
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

  const demand = {};
  const price = {};
  for (const m of perEvent.values()) {
    demand[m.tag] = (demand[m.tag] ?? 1) * m.demand_mult;
    price[m.tag] = (price[m.tag] ?? 1) * m.price_mult;
  }
  for (const t of Object.keys(demand)) demand[t] = clamp(demand[t], DEMAND_BAND[0], DEMAND_BAND[1]);
  for (const t of Object.keys(price)) price[t] = clamp(price[t], PRICE_BAND[0], PRICE_BAND[1]);
  return { demand, price };
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
    if (!shelf.item_id || shelf.qty <= 0) continue;
    const item = items[shelf.item_id];
    if (!item) continue;
    const chance = purchaseChance({
      item, archetype, price: shelf.price, folded, season, reputation,
    });
    if (chance > 0.05) scored.push({ shelf, item, chance });
  }
  scored.sort((a, b) => b.chance - a.chance);
  return scored;
}

/**
 * How many customers should be milling about right now.
 * Driven by reputation, the day-of-week rhythm, and any demand modifiers —
 * so a viral event genuinely makes the shop busier, not just pickier.
 */
export function footfall({ day, hourFraction, reputation, folded, baseRate = 14 }) {
  // Two humps: a morning rush and a bigger after-work rush.
  const t = hourFraction;
  const morning = Math.exp(-((t - 0.32) ** 2) / 0.012);
  const evening = Math.exp(-((t - 0.68) ** 2) / 0.018) * 1.35;
  const shape = 0.25 + morning + evening;

  // Weekends are busier.
  const weekend = day % 7 === 6 || day % 7 === 0 ? 1.5 : 1;

  // Average demand pressure across all tags currently modified.
  const mods = Object.values(folded.demand);
  const pressure = mods.length ? mods.reduce((a, b) => a + b, 0) / mods.length : 1;

  return baseRate * shape * weekend * (0.5 + reputation) * clamp(pressure, 0.4, 3);
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round2 = (v) => Math.round(v * 100) / 100;
