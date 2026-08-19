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
  property: ['perishable', 'shelf-stable', 'needs-freezer', 'needs-warmer', 'fragile', 'bulky', 'heavy'],
  // Diet / lifestyle filters.
  diet: ['organic', 'vegan', 'vegetarian', 'gluten-free', 'healthy', 'junk'],
  // When do people buy it?
  occasion: ['breakfast', 'lunch', 'dinner', 'party', 'holiday', 'gift', 'kids'],
  // Seasonal demand swings.
  season: ['spring', 'summer', 'autumn', 'winter'],
  // Cultural momentum — the world director loves messing with these.
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
  decor: ['plant', 'lamp', 'sign', 'furniture'],
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
 * itself rather than as a gap. "A Snack Kid: no kids." was the one that forced
 * it: `kids` is exactly the right tag on the item and
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
   * The same claim about heat, and the reason `requiresFixture` was always
   * spelled as a kind rather than as a flag.
   *
   * Everything the kitchen serves hot — a roast chicken, chips, a toastie —
   * carried nothing that said so, so it went on ordinary shelving beside the
   * bread and kept for its authored life. The tag was half-written from the
   * day it existed: cold food had somewhere it had to be and hot food did not.
   *
   * Same `spoilMultiplier` as the freezer's for the same reason — the number
   * says "this goes off", and how fast is `shelf_life_days` on the item. What
   * the tag decides is WHERE, and `MISKEPT_PENALTY` is what ignoring it costs.
   */
  'needs-warmer': { spoilMultiplier: 1, requiresFixture: 'warmer' },
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
 * What a fixture is worth to something that did not ask for it, and what being
 * in the wrong one costs something that did.
 *
 * These are the two halves of what `needs-freezer` MEANS, and both used to be
 * missing in the same direction. The tag shipped as `spoilMultiplier: 0.25` —
 * "frozen goods keep" — which is true of the goods and says nothing about the
 * freezer, and `spoilStock` never read the number anyway. So ice cream on a
 * warm shelf kept for its full authored 45 days: the tag that exists to say
 * "this must be kept cold" had no opinion about not being kept cold.
 *
 * The rule is that an item's authored `shelf_life_days` is its life IN the
 * fixture it asks for. Everything else is a departure from that.
 *
 * `CHILL_KEEPS` is the one *bonus* here, and it is the odd one out on purpose:
 * a freezer is the only fixture in the shop that is kind to goods with no
 * opinion about it. Milk keeps longer in one, and so does a tomato.
 *
 * `HEAT_SPOILS` is the same sentence about the hot counter and comes out the
 * other way, which is the whole reason it is not simply `1 / CHILL_KEEPS` or a
 * reused constant: a warmer is a machine for holding cooked food at serving
 * temperature, and anything else put in one is being cooked slowly. It is
 * deliberately mild next to `MISKEPT_PENALTY` — leaving a loaf under a heat
 * lamp is a bad idea, not the same order of bad idea as leaving ice cream out.
 *
 * `MISKEPT_PENALTY` is what it costs to ignore the tag outright: goods that
 * named a fixture and are not in it. One number for both directions, because
 * the claim is symmetric — an item's authored life assumes its own fixture, so
 * being anywhere else is the same size of lie whichever way the thermometer
 * points. It was `WARM_PENALTY` while a freezer was the only thing that could
 * be asked for; the name had to go, because for a hot counter's goods the
 * penalty is for being COLD and a constant reading `WARM` would be exactly
 * backwards at the one site that uses it.
 */
export const CHILL_KEEPS = 0.25;
export const HEAT_SPOILS = 4;
export const MISKEPT_PENALTY = 20;

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

/**
 * Which kind of unit this item lives on — the one it asked for, or plain
 * shelving if it asked for nothing.
 *
 * The pair below is the whole stocking rule, and it exists as two named
 * functions because it was written out by hand in six files and eleven places,
 * every one of them some spelling of `(itemIsFrozen) === (shelfIsFreezer)`.
 * That is a correct rule with exactly two kinds in the world and a silent bug
 * with three: a hot counter is not a freezer, so under the old test it took
 * bread and turned the roast chicken away.
 *
 * `homeKind` is deliberately total — it always names one of `STOCK_KINDS` —
 * because the boolean it replaces had a third state nobody could see. "Needs
 * nothing" and "needs a freezer" were `null` and `'freezer'`, and every caller
 * then had to remember that `null` means shelf. Saying so once is what lets
 * `holds` be a single `===`.
 */
export function homeKind(item) {
  return requiredFixture(item) ?? 'shelf';
}

/**
 * May a unit of this kind carry this item?
 *
 * Everybody's rule: the staff, reservations, the re-flow, the balance bot, and
 * your own hands. It was the shop's alone for two steps — `boardFor` refused
 * only goods that had NAMED a fixture, so you could stand a loaf in a freezer
 * and watch what that did to it, and `spoilRate`'s opinion about all six
 * combinations was what made that survivable.
 *
 * What killed it is that the loose rule is not a freedom you take, it is one
 * that gets taken on your behalf. A crate is mixed and `pourInto` empties it
 * pile by pile, so a crate of carrots and eggs poured into a freezer put the
 * carrots on a cold board — one press, no refusal, and the eggs, which have
 * nowhere else in the shop to be, left in the box. The bug reads as the shop
 * choosing wrong, and it is: you asked it to fill a freezer and it did the one
 * thing you could not have meant.
 *
 * That could be fixed by ordering the piles, and was, and the fix was the tell.
 * Ordering decides which pile goes on FIRST and cannot stop the second one
 * going on at all — so the freezer still filled its spare boards with carrots,
 * one board later. There is no ranking that expresses "and then stop", because
 * the thing being asked for is a refusal.
 *
 * `spoilRate` keeps its six combinations and they are not dead. Content is
 * edited live, so an item can be tagged `needs-freezer` while cases of it are
 * standing on ordinary shelving, and a save predates any rule made today —
 * which is what the re-flow's shed is for.
 */
export function holds(kind, item) {
  return homeKind(item) === kind;
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
 * `in` is which of `STOCK_KINDS` it is sitting on. It is a parameter rather
 * than something the caller applies afterwards because the answer is not a
 * bonus you can add on at the end: cold is worth four times as much to milk as
 * it is to a tub of ice cream, whose authored life already assumes it. Working
 * that out at the call site is how the fixture ended up with a hardcoded `× 4`
 * beside a tag multiplier nobody read.
 *
 * It was a `chilled` BOOLEAN while a freezer was the only fixture goods could
 * ask for, and the hot counter is why it is a kind now. A boolean has no way to
 * say "in the wrong special fixture" — a roast chicken in a freezer would have
 * come out as `chilled: true`, which used to mean "it is where it wants to be",
 * so the shop would have reported a chicken frozen solid as perfectly kept.
 *
 * @param {object} item
 * @param {{in?: string}} [where] which of `STOCK_KINDS` it is on. Plain
 *   shelving by default, which is what everything that does not ask is.
 */
export function spoilRate(item, { in: kind = 'shelf' } = {}) {
  // Anything explicitly shelf-stable wins over an incidental perishable tag,
  // and wins before anything else can multiply it back up above zero.
  if (item.tags.includes('shelf-stable')) return 0;

  let rate = 0;
  for (const tag of item.tags) {
    const b = BEHAVIOUR_TAGS[tag];
    if (b?.spoilMultiplier !== undefined) rate = Math.max(rate, b.spoilMultiplier);
  }
  if (rate <= 0) return 0;

  // What it asked for. Anything with no opinion is asking for plain shelving,
  // which is the same answer an untagged item has always given — it is only
  // written down now, because "no requirement" and "a requirement that happens
  // to be met" have to reach the same line below.
  const wants = requiredFixture(item) ?? 'shelf';

  // Where it wants to be is where its authored shelf life is measured. This is
  // the case that has to come first: it covers ordinary goods on ordinary
  // shelving as well as a chicken in a hot counter, and both are simply `rate`.
  if (kind === wants) return rate;

  // It named a fixture and this is not that fixture. Symmetric on purpose —
  // ice cream on a shelf and a roast chicken on that same shelf are both goods
  // being kept somewhere their shelf life never assumed.
  if (wants !== 'shelf') return rate * MISKEPT_PENALTY;

  // Left with goods that asked for nothing, in a fixture that has an opinion
  // anyway. Cold is a favour and heat is not.
  if (kind === 'freezer') return rate * CHILL_KEEPS;
  if (kind === 'warmer') return rate * HEAT_SPOILS;
  return rate;
}
