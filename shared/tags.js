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
  // Who works here. Same vocabulary idea as the rest: a world event that wants
  // to slow every hire down aims at a tag, never at a role id.
  staff: ['staff', 'front-of-house', 'back-of-house', 'outdoor', 'kitchen', 'fast', 'clumsy', 'green'],
  // What a decoration IS, which is the one thing its kind cannot say: `prop-floor`
  // and `prop-ceiling` are about how it attaches, and a planter and a barrel
  // attach identically. These file it on the Decoration bar (`DECOR_SUBS`,
  // client/sections.js), so tagging one is how it lands under Greenery rather
  // than in the everything-else drawer — the same move the shop makes with
  // items, said about the palette instead of about demand.
  decor: ['plant', 'lamp', 'sign'],
};

/** Flat list of every known tag. */
export const ALL_TAGS = Object.values(TAG_GROUPS).flat();

/**
 * The channels of the demand meter, in the order it draws them.
 *
 * The category group and nothing else, because a department is the one tag
 * dimension a shop is *organised* by — you buy in produce, you give it shelves,
 * and you can tell at a glance whether you have any. `cheap` and `trendy` are
 * real demand and belong on an item, but "how much cheap have you got" is not a
 * question the shop floor can answer, so a bar reading it would be a number
 * with nowhere to act on it.
 *
 * It is a named export rather than `TAG_GROUPS.category` at the call site so
 * that the meter's channel set is a decision recorded here, beside the
 * vocabulary, rather than a group somebody reads and might reorder for
 * unrelated reasons — the order is load-bearing (see docs/ui-shell.md).
 */
export const DEPARTMENTS = TAG_GROUPS.category;

/**
 * What to call a tag when a *sentence* has to say it.
 *
 * Only the ones that misread on their own, and the fallback is the tag itself —
 * so this never has to be kept complete, and a tag invented next week reads as
 * itself rather than as a gap. "A Snack Kid came in for kids and you had none"
 * was the one that forced it: `kids` is exactly the right tag on the item and
 * exactly the wrong word in the log line, which is a presentation problem and
 * must not become a content one. Nobody should ever be tempted to retag a
 * shelf to make a message read better.
 */
export const TAG_LABELS = {
  kids: "kids' stuff",
  gift: 'something to give',
  party: 'party food',
  holiday: 'something festive',
  household: 'household bits',
  produce: 'fresh produce',
  junk: 'junk food',
  healthy: 'something healthy',
  cheap: 'a bargain',
};

/** How to say a tag out loud. Itself, unless it misreads — see `TAG_LABELS`. */
export const tagLabel = (tag) => TAG_LABELS[tag] ?? tag;

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
  'needs-freezer': { spoilMultiplier: 1, requiresFixture: 'freezer' },
  /**
   * Everything the kitchen makes, and the reason spoilage looked switched off.
   *
   * `prepared` is a *department* tag that every crafted good already carries, so
   * reading it a second way here is the same move `IMPULSE_TAGS` makes — it
   * costs nothing and no existing item has to be re-tagged. Before it, the seven
   * crafted goods were the only items in the game with a `shelf_life_days` that
   * nothing read: a latte authored at one day never went off, because
   * `spoilRate` only ever looked at this table and `prepared` was not in it. A
   * shelf life that is dead data is worse than no shelf life, because the
   * authoring tool asks for it and the docs say it means something.
   *
   * Three, because a sandwich made this morning is not a tomato. It is the
   * fastest rate in the table on purpose — the kitchen is the one place in the
   * shop that can make stock faster than it sells, and something has to be the
   * cost of running it flat out.
   */
  prepared: { spoilMultiplier: 3 },
  fragile: { damageChance: 0.06 },
  bulky: { shelfSlots: 2 },
  heavy: { carryCost: 2 },
};

/**
 * What cold is worth to something that did not ask for it, and what its absence
 * costs something that did.
 *
 * These are the two halves of what `needs-freezer` MEANS, and both used to be
 * missing in the same direction. The tag shipped as `spoilMultiplier: 0.25` —
 * "frozen goods keep" — which is true of the goods and says nothing about the
 * freezer, and `spoilStock` never read the number anyway. So ice cream on a
 * warm shelf kept for its full authored 45 days: the tag that exists to say
 * "this must be kept cold" had no opinion about not being kept cold.
 *
 * The rule now is that an item's authored `shelf_life_days` is its life IN the
 * fixture it asks for. Cold is therefore neutral to a frozen good (it is
 * already the assumption) and a bonus to anything else, and warmth is what the
 * tag is actually about.
 */
export const CHILL_KEEPS = 0.25;
export const WARM_PENALTY = 20;

/**
 * What tempts somebody who is already standing in the queue.
 *
 * Same tag-keyed shape as BEHAVIOUR_TAGS, and for the same reason: an impulse
 * buy is a property of the *goods*, not of a fixture or an item id, so a sweet
 * invented next week is endcap material the moment it is tagged `candy`.
 *
 * Deliberately not a new tag group. These are ordinary tags read a second way
 * — inventing an `impulse` tag would mean every existing item is wrong until
 * somebody goes back and re-tags it.
 */
export const IMPULSE_TAGS = {
  candy: 1.8,
  snack: 1.6,
  kids: 1.5,
  cheap: 1.4,
  beverage: 1.3,
  luxury: 0.4,   // nobody grabs a truffle on the way past
  bulky: 0.3,    // nor a sack of anything
};

/**
 * How much more (or less) likely this item is to be grabbed on the way out.
 * Strongest pull wins rather than multiplying: a cheap snack is one impulse
 * buy, not 1.6 × 1.4 of one.
 *
 * @returns {number} multiplier, 1 if nothing about the item is tempting.
 */
export function impulsePull(item) {
  let pull = 1;
  let touched = false;
  for (const tag of item.tags) {
    const w = IMPULSE_TAGS[tag];
    if (w === undefined) continue;
    // Furthest from neutral in either direction — a bulky luxury is dragged
    // down by whichever tag says "not on the way past" loudest.
    if (!touched || Math.abs(Math.log(w)) > Math.abs(Math.log(pull))) pull = w;
    touched = true;
  }
  return pull;
}

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
 * How fast this item spoils, as a divisor on its authored shelf life.
 * 1 is "exactly as long as it says on the row", 2 is twice as fast, and
 * 0 means it never spoils at all.
 *
 * `chilled` is whether it is sitting in a freezer. It is a parameter rather
 * than something the caller applies afterwards because the answer is not a
 * bonus you can add on at the end: cold is worth four times as much to milk as
 * it is to a tub of ice cream, whose authored life already assumes it. Working
 * that out at the call site is how the fixture ended up with a hardcoded `× 4`
 * beside a tag multiplier nobody read.
 *
 * @param {object} item
 * @param {{chilled?: boolean}} [where]
 */
export function spoilRate(item, { chilled = false } = {}) {
  // Anything explicitly shelf-stable wins over an incidental perishable tag,
  // and wins before anything else can multiply it back up above zero.
  if (item.tags.includes('shelf-stable')) return 0;

  let rate = 0;
  for (const tag of item.tags) {
    const b = BEHAVIOUR_TAGS[tag];
    if (b?.spoilMultiplier !== undefined) rate = Math.max(rate, b.spoilMultiplier);
  }
  if (rate <= 0) return 0;

  // A frozen good is authored at its frozen life, so a freezer is what it
  // expects rather than a favour — and the shelf it should never have been put
  // on is the whole point of the tag.
  if (requiredFixture(item) === 'freezer') return chilled ? rate : rate * WARM_PENALTY;

  return chilled ? rate * CHILL_KEEPS : rate;
}
