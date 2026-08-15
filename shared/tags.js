/**
 * THE TAG VOCABULARY — the heart of the whole game.
 *
 * Nothing in this game is hardcoded to a specific item. Customers don't want
 * "tomato #47"; they want things that are `produce` + `cheap` + `organic`.
 *
 * That means when you (or the AI) invent a brand new item, you just give it
 * tags — and pricing, demand, spoilage, and "which customers want it" all
 * work immediately. No other file needs to change. Ever.
 *
 * ADDING A TAG: append it to the right group below. That's it.
 * Tags not listed here still work, they just won't be suggested in tooling.
 */

export const TAG_GROUPS = {
  // What kind of thing is it?
  category: [
    'produce', 'dairy', 'bakery', 'meat', 'frozen', 'beverage',
    'snack', 'household', 'prepared', 'candy', 'condiment', 'pantry',
  ],
  // How fancy?
  quality: ['generic', 'cheap', 'premium', 'luxury', 'artisanal'],
  // Physical behaviour — drives spoilage, shelf space, carry weight.
  property: ['perishable', 'shelf-stable', 'needs-freezer', 'fragile', 'bulky', 'heavy'],
  // Diet / lifestyle filters.
  diet: ['organic', 'vegan', 'vegetarian', 'gluten-free', 'healthy', 'junk'],
  // When do people buy it?
  occasion: ['breakfast', 'lunch', 'dinner', 'party', 'holiday', 'gift', 'kids'],
  // Seasonal demand swings.
  season: ['spring', 'summer', 'autumn', 'winter'],
  // Cultural momentum — the AI director loves messing with these.
  trend: ['trendy', 'classic', 'nostalgic', 'viral'],
};

/** Flat list of every known tag. */
export const ALL_TAGS = Object.values(TAG_GROUPS).flat();

/** Reverse lookup: tag -> which group it belongs to. */
export const TAG_GROUP_OF = Object.fromEntries(
  Object.entries(TAG_GROUPS).flatMap(([group, tags]) => tags.map((t) => [t, group])),
);

/**
 * Tags that change how the simulation physically behaves (not just demand).
 * Kept separate so the sim can ask "is this perishable?" without a big switch.
 */
export const BEHAVIOUR_TAGS = {
  perishable: { spoilMultiplier: 1 },
  'shelf-stable': { spoilMultiplier: 0 },
  'needs-freezer': { spoilMultiplier: 0.25, requiresFixture: 'freezer' },
  fragile: { damageChance: 0.06 },
  bulky: { shelfSlots: 2 },
  heavy: { carryCost: 2 },
};

/**
 * Score how much a customer archetype wants an item, ignoring price.
 *
 * `affinities` is a plain map of tag -> weight in roughly -1..1.
 * Unlisted tags contribute nothing, so a customer that has never "heard of"
 * a new tag is simply neutral about it rather than broken.
 *
 * @returns {number} desire, typically 0..~3. Higher means "I want this".
 */
export function desireFor(item, affinities) {
  let score = 0;
  let matched = 0;
  for (const tag of item.tags) {
    const w = affinities[tag];
    if (w === undefined) continue;
    score += w;
    matched++;
  }
  // A customer who matches on several tags is more confident than one who
  // matched a single lucky tag — but with diminishing returns.
  if (matched > 1) score *= 1 + Math.min(matched - 1, 3) * 0.12;
  return Math.max(0, score);
}

/**
 * Does this item need a special fixture (freezer, etc.) to sit on a shelf?
 * Returns the fixture name or null.
 */
export function requiredFixture(item) {
  for (const tag of item.tags) {
    const b = BEHAVIOUR_TAGS[tag];
    if (b?.requiresFixture) return b.requiresFixture;
  }
  return null;
}

/** How many shelf slots one stack of this item occupies. */
export function shelfSlots(item) {
  return item.tags.includes('bulky') ? 2 : 1;
}

/**
 * How fast this item spoils, as a multiplier on the base rate.
 * 0 means it never spoils.
 */
export function spoilRate(item) {
  let rate = 0;
  for (const tag of item.tags) {
    const b = BEHAVIOUR_TAGS[tag];
    if (b?.spoilMultiplier !== undefined) rate = Math.max(rate, b.spoilMultiplier);
  }
  // Anything explicitly shelf-stable wins over an incidental perishable tag.
  if (item.tags.includes('shelf-stable')) return 0;
  return rate;
}
