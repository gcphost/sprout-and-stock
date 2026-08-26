/**
 * THE WORLD DIRECTOR.
 *
 * Once per in-game day, this reads the state of the shop and decides what the
 * world does next: a heat wave, a viral snack, a supply shortage, a new trend.
 * It writes those decisions into the `modifiers` table as tag-based demand and
 * price multipliers, which the economy already knows how to read.
 *
 * THERE IS NO MODEL IN HERE, and the order those words go in matters. For as
 * long as an API call was called "the director" and this was called "the
 * fallback", the game read as the degraded version of itself — and it never
 * was. What is below is a driver tag drawn from the season and filtered to tags
 * something in the shop actually carries; allies that ride along and a rival
 * that takes the other side of it; multipliers rolled in bands; a duration; a
 * headline from a template; and a no-repeat guard over the last three drivers,
 * because a small pool deals the same story three days running. Beside it,
 * authored `events` rows drawn a quarter of the time, for a set piece somebody
 * wrote on purpose. That is a world-event system. What the model bought on top
 * of it was *phrasing*, at the cost of a network call, a bill, and a dependency
 * that cannot go in a browser at all.
 *
 * The argument in full is in docs/steam.md §4, which asked for this cut before
 * there was a web build to force it. Two things fall out beyond the obvious:
 * nothing a player reads is generated at runtime, so a shipped game answers "no"
 * to every AI-disclosure question a store asks; and `@anthropic-ai/sdk` leaves
 * the dependency list.
 *
 * THE ONE RULE that survives unchanged: the simulation never blocks on this. It
 * is still called without being awaited (`ShopRoom.pushState`) and it still
 * returns a result rather than throwing, so a bad content row cannot take the
 * tick down.
 *
 * Agents still write events — `add_modifier` and `create_event` over MCP are
 * untouched, and authoring is where a model belongs in this project: at the
 * keyboard, not in the build.
 */

import { content } from './content.js';
import { addModifier } from './db.js';

/** Runs once per in-game day. Override for testing. */
const MIN_DAYS_BETWEEN_RUNS = 1;

/**
 * A readable summary of the shop as it stands.
 *
 * Nothing in the sim reads it — it is what `GET /api/director/context` (and
 * therefore `get_director_context` over MCP) returns, which is how an agent
 * looks at a shop before authoring an event for it by hand. It outlived the
 * model call it was written for because that is the job it was always doing:
 * saying what is true of this shop today, in one screen.
 */
export function describeWorld(game) {
  const c = content();
  const shelves = game.layout.shelves
    .filter((s) => s.item_id)
    .map((s) => `${s.item_id} x${s.qty} @ $${s.price}`);

  const topSellers = Object.entries(game.stats.byItem)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, n]) => `${id} (${n})`);

  return [
    `Day ${game.day}, season ${game.season}.`,
    `Cash $${game.cash.toFixed(2)}, reputation ${(game.reputation * 100).toFixed(0)}%.`,
    `Shop has ${game.layout.shelves.length} shelves and ${game.layout.plots.length} farm plots.`,
    `On the shelves right now: ${shelves.length ? shelves.join(', ') : 'nothing — the shop is empty'}.`,
    `Selling well today: ${topSellers.length ? topSellers.join(', ') : 'nothing yet'}.`,
    `Yesterday ${game.stats.abandoned} customers abandoned their baskets and ${game.stats.leftEmpty} left without finding anything.`,
    `Item tags in play: ${[...new Set(c.items.flatMap((i) => i.tags))].join(', ')}.`,
  ].join('\n');
}

/**
 * Decide today's world event.
 *
 * Still `async` and still returning a result rather than throwing, both of which
 * are contracts with `ShopRoom.pushState` rather than leftovers: it is called
 * without being awaited, so a rejected promise here would be an unhandled one,
 * and the tick must never wait on whatever this grows into next.
 *
 * @returns {Promise<{ok: boolean, source: string, headline?: string, error?: string}>}
 */
export async function runDirector(game, { force = false } = {}) {
  // Not more than once per in-game day. (The one-at-a-time guard went with the
  // network call: there is no longer an await between claiming the day and
  // acting on it, so there is no window in which a second run could start.)
  if (!force && game.lastDirectorDay != null
      && game.day - game.lastDirectorDay < MIN_DAYS_BETWEEN_RUNS) {
    return { ok: false, source: 'skipped', error: 'already ran today' };
  }

  // Claim the day up front, synchronously, and write it to the save.
  //
  // Both mistakes this fixes were invisible: the guard used to be set *after*
  // the API-key check, so the no-key fallback path — the one that runs for
  // anyone without a key, i.e. the common case — never marked the day at all;
  // and it lived only in memory, so even when it was set, a restart lost it.
  // Between them, every `npm run dev` reload fired another world event onto
  // the same day. Five copies of one heat wave is what that looks like.
  markRan(game);

  return stageEvent(game, 'local director');
}

/**
 * Remember that today has had its event, in the one place that survives a
 * restart. `persist()` is a no-op on an ephemeral game, so a balance run can
 * never write the live save.
 */
function markRan(game) {
  game.lastDirectorDay = game.day;
  game.persist();
}

/**
 * Write a plan's modifiers into the DB, clamped.
 *
 * The clamp stays now that every plan is one this file invented, and that is
 * deliberate: a plan can also arrive from `add_modifier` by hand over MCP, and
 * an authored `days: 500` is exactly as capable of wrecking a shop as a
 * hallucinated one was.
 */
function applyPlan(game, plan, source) {
  // The tags an event names are the one thing about it that has to be true of
  // THIS shop, whoever wrote it: `inventEvent` already draws from the live
  // catalogue, and a plan from `add_modifier` has had no such filter applied. A
  // craze for something nobody sells is a toast, a log line and no number
  // moving — indistinguishable, from the player's chair, from the director
  // being broken.
  const live = new Set(content().items.flatMap((i) => i.tags ?? []));
  const mods = (plan.modifiers ?? []).filter((m) => live.has(m.tag)).slice(0, 4);
  const dropped = (plan.modifiers ?? []).length - mods.length;
  if (dropped > 0) console.warn(`[director] dropped ${dropped} modifier(s) naming a tag nothing stocks`);
  if (mods.length === 0) return stageEvent(game, 'plan had no modifiers the shop could feel');

  for (const m of mods) {
    addModifier({
      // A heat wave in one shop is not a heat wave in the shop next door. The
      // director runs per world, so what it writes belongs to that world.
      worldId: game.worldId,
      source,
      label: plan.headline ?? source,
      tag: m.tag,
      demand_mult: clamp(Number(m.demand_mult) || 1, 0.1, 5),
      price_mult: clamp(Number(m.price_mult) || 1, 0.3, 4),
      // The invented events never set it — `inventEvent` tells one story about
      // a driver TAG on the shelves, and its plan is filtered above against
      // tags that live on items, where a spawn tag lives on an archetype. So
      // this reads 1 for everything the generator writes, and is here so that
      // a plan which does say something about the crowd is not silently
      // dropped on the way to the row.
      spawn_mult: clamp(Number(m.spawn_mult) || 1, 0, 3),
      expires_day: game.day + clamp(Math.round(Number(m.days) || 2), 1, 5),
    });
  }

  game.invalidateModifiers();
  game.pushLog(`📰 ${plan.headline}${plan.description ? ` — ${plan.description}` : ''}`);
  return { ok: true, source, headline: plan.headline, modifiers: mods.length };
}

// ---------------------------------------------------------------------------
// THE LOCAL DIRECTOR.
//
// No key, no credits, no network — and the thing it replaced was worse than
// the API in one specific way that matters more than prose: a fixed pool of
// hand-written events runs out. Play a fortnight and you have seen all of
// them, which makes the world feel *smaller* the longer you play.
//
// So this generates instead of picking. The model is deliberately small:
// every event is one story about a single DRIVER tag. Something happens to
// it, tags that travel with it ride along, and the tag people substitute for
// it moves the other way. That last part is what stops an event reading as a
// dice roll — a run on frozen food should visibly cost the fresh aisle, and
// then you have a decision rather than a number.
//
// It leans on the same insight the rest of the game does: nothing here is
// about specific items, so a generator that only knows tags automatically
// covers every item anyone ever adds, including ones authored after it.
// ---------------------------------------------------------------------------

/** Tags that move together. A run on one lifts these, more gently. */
const ALLIES = {
  produce: ['organic', 'healthy', 'vegan', 'perishable'],
  dairy: ['breakfast', 'perishable', 'classic'],
  bakery: ['breakfast', 'artisanal', 'classic'],
  meat: ['dinner', 'premium', 'perishable'],
  frozen: ['needs-freezer', 'kids', 'snack'],
  beverage: ['breakfast', 'trendy', 'party'],
  snack: ['junk', 'kids', 'party'],
  prepared: ['lunch', 'dinner', 'shelf-stable'],
  candy: ['kids', 'junk', 'party'],
  pantry: ['shelf-stable', 'classic', 'cheap'],
  condiment: ['shelf-stable', 'pantry'],
  household: ['bulky', 'shelf-stable'],
  healthy: ['organic', 'vegan', 'produce', 'gluten-free'],
  organic: ['healthy', 'premium', 'produce'],
  vegan: ['healthy', 'organic', 'gluten-free'],
  junk: ['snack', 'candy', 'cheap'],
  premium: ['luxury', 'artisanal', 'gift'],
  luxury: ['premium', 'gift', 'artisanal'],
  cheap: ['generic', 'pantry'],
  party: ['candy', 'snack', 'beverage'],
  holiday: ['gift', 'luxury', 'party'],
  gift: ['premium', 'holiday'],
  kids: ['candy', 'snack', 'breakfast'],
  breakfast: ['dairy', 'bakery', 'beverage'],
  trendy: ['viral', 'premium', 'artisanal'],
  viral: ['trendy', 'snack'],
  nostalgic: ['classic', 'candy'],
  classic: ['nostalgic', 'pantry'],
};

/** ...and what people buy *instead*, which moves the opposite way. */
const RIVALS = {
  produce: ['frozen', 'prepared'],
  frozen: ['produce', 'prepared'],
  prepared: ['produce', 'bakery'],
  healthy: ['junk', 'candy'],
  junk: ['healthy', 'organic'],
  organic: ['cheap', 'generic'],
  premium: ['cheap', 'generic'],
  luxury: ['cheap', 'generic'],
  cheap: ['premium', 'luxury'],
  trendy: ['classic', 'nostalgic'],
  viral: ['classic'],
  classic: ['trendy', 'viral'],
  nostalgic: ['trendy'],
  snack: ['produce', 'healthy'],
  candy: ['healthy'],
  bakery: ['gluten-free'],
  meat: ['vegan', 'vegetarian'],
  vegan: ['meat'],
  dairy: ['vegan'],
};

/**
 * Which tags can plausibly drive an event in each season.
 *
 * The old fixed pool dealt a Heat Wave in winter, which is the kind of thing
 * that reads as the world not paying attention. Note this is about the
 * *story*, not the maths — `seasonMult` already handles in-season demand, so
 * this only decides what today's headline is allowed to be about.
 */
const SEASON_DRIVERS = {
  spring: ['produce', 'organic', 'healthy', 'vegan', 'gluten-free', 'breakfast', 'trendy', 'household'],
  summer: ['frozen', 'beverage', 'party', 'snack', 'kids', 'produce', 'viral', 'candy'],
  autumn: ['bakery', 'pantry', 'condiment', 'classic', 'nostalgic', 'dinner', 'meat', 'household'],
  winter: ['holiday', 'gift', 'luxury', 'prepared', 'dinner', 'dairy', 'premium', 'candy'],
};

const SURGE_HEADLINES = [
  '{T} craze sweeps the neighbourhood',
  'Everyone suddenly wants {t}',
  '{T} goes viral overnight',
  'Queues down the street for {t}',
  'Food column raves about {t}',
  'Rival shop sells clean out of {t}',
  'Run on {t} at the market',
];

const SLUMP_HEADLINES = [
  'Shoppers go off {t}',
  '{T} loses its shine',
  'Nobody is buying {t} this week',
  '{T} suddenly feels dated',
  'Bad write-up hits {t}',
  '{T} glut leaves shelves untouched',
];

/**
 * Invent today's event.
 *
 * Candidate drivers are filtered to tags something in the shop's catalogue
 * actually carries — an event about a tag no item has is a headline that
 * changes nothing, which is the same failure as authoring an item with
 * invented tags, just seen from the other end.
 */
function inventEvent(game) {
  const c = content();
  const live = new Set(c.items.flatMap((i) => i.tags ?? []));
  if (live.size === 0) return null;

  const seasonal = (SEASON_DRIVERS[game.season] ?? []).filter((t) => live.has(t));
  // Fall back to anything the shop stocks, so an unusual catalogue still gets
  // events rather than silence.
  const pool = seasonal.length ? seasonal : [...live].filter((t) => ALLIES[t] || RIVALS[t]);
  if (pool.length === 0) return null;

  // Don't tell the same story twice running. A season only has a handful of
  // plausible drivers, so an unguarded draw produced "shoppers go off healthy"
  // three days in a row — which reads as the world being stuck rather than
  // varied. Deliberately not persisted: repeating across a restart is fine,
  // and it keeps this out of the save format.
  const recent = game.recentDrivers ?? [];
  const fresh = pool.filter((t) => !recent.includes(t));
  const driver = game.rng.pick(fresh.length ? fresh : pool);
  game.recentDrivers = [driver, ...recent].slice(0, 3);
  const surge = game.rng.float(0, 1) < 0.62;   // good news slightly more often
  const rng = game.rng;

  const usable = (list) => (list ?? []).filter((t) => live.has(t) && t !== driver);
  const allies = shuffled(usable(ALLIES[driver]), rng).slice(0, rng.int(1, 2));
  const rival = shuffled(usable(RIVALS[driver]).filter((t) => !allies.includes(t)), rng)[0] ?? null;

  const mods = [{
    tag: driver,
    demand_mult: surge ? rng.float(1.8, 2.8) : rng.float(0.35, 0.6),
    price_mult: surge ? rng.float(1.15, 1.45) : rng.float(0.8, 0.95),
    days: 0,
  }];
  for (const tag of allies) {
    mods.push({
      tag,
      demand_mult: surge ? rng.float(1.25, 1.6) : rng.float(0.7, 0.9),
      price_mult: surge ? rng.float(1.05, 1.2) : rng.float(0.92, 1),
      days: 0,
    });
  }
  if (rival) {
    mods.push({
      tag: rival,
      demand_mult: surge ? rng.float(0.55, 0.8) : rng.float(1.2, 1.5),
      price_mult: surge ? rng.float(0.9, 1) : rng.float(1.05, 1.15),
      days: 0,
    });
  }

  const days = rng.int(2, 4);
  for (const m of mods) m.days = days;

  const template = rng.pick(surge ? SURGE_HEADLINES : SLUMP_HEADLINES);
  const headline = template.replace('{T}', titleCase(driver)).replace('{t}', driver);
  const ride = allies.length ? `${listPhrase(allies)} ${allies.length > 1 ? 'ride' : 'rides'} along` : null;
  const cost = rival ? `${titleCase(rival)} takes the other side of it` : null;

  return {
    headline,
    description: [ride, cost].filter(Boolean).join('; ') || `Lasts ${days} days`,
    modifiers: mods,
  };
}

/**
 * Today's event: an authored one a quarter of the time, otherwise an invented
 * one. This IS the director — it was called `applyFallback` while there was a
 * model in front of it, and the rename is the point rather than tidying, for
 * the reason at the top of this file.
 *
 * Hand-written `events` rows are still drawn from now and then, because a set
 * piece somebody wrote on purpose beats a generated one, and because they're
 * the place to put an event with a story the generator can't tell. They're the
 * garnish rather than the whole supply.
 */
function stageEvent(game, reason) {
  // Same don't-repeat rule the generator uses, for the same reason: the pool is
  // small, so an unguarded weighted draw dealt Baking Craze three days running.
  const recent = game.recentEvents ?? [];
  const all = content().events.filter((e) => e.min_day <= game.day);
  const eligible = all.filter((e) => !recent.includes(e.id));

  if (eligible.length > 0 && game.rng.float(0, 1) < 0.25) {
    const picked = game.rng.weighted(eligible, 'weight');
    game.recentEvents = [picked.id, ...recent].slice(0, 3);
    for (const eff of picked.effects) {
      addModifier({
        worldId: game.worldId,
        source: `event:${picked.id}`,
        label: picked.name,
        tag: eff.tag,
        demand_mult: eff.demand_mult,
        price_mult: eff.price_mult,
        // Straight through, unclamped, because the schema is the clamp on this
        // path — an authored row is somebody's decision rather than a
        // generator's roll, and `foldModifiers` bands it either way.
        spawn_mult: eff.spawn_mult,
        expires_day: game.day + picked.duration_days,
      });
    }
    game.invalidateModifiers();
    game.pushLog(`📰 ${picked.name} — ${picked.description}`);
    return { ok: true, source: 'authored', reason, headline: picked.name, modifiers: picked.effects.length };
  }

  const plan = inventEvent(game);
  if (plan) return { ...applyPlan(game, plan, 'local'), reason };
  return { ok: false, source: 'local', error: `${reason}; nothing to invent an event about` };
}

/** Fisher-Yates on a copy, off the game's seeded rng so runs stay repeatable. */
function shuffled(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const titleCase = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const listPhrase = (list) => (list.length < 2
  ? titleCase(list[0] ?? '')
  : `${list.slice(0, -1).map(titleCase).join(', ')} and ${titleCase(list[list.length - 1])}`);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
