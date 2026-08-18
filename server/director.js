/**
 * THE AI WORLD DIRECTOR.
 *
 * Once per in-game day, this reads the state of the shop and decides what the
 * world does next: a heat wave, a viral snack, a supply shortage, a new trend.
 * It writes those decisions into the `modifiers` table as tag-based demand and
 * price multipliers, which the economy already knows how to read.
 *
 * THE ONE RULE: the simulation never blocks on this.
 *
 *   - It runs async, off the tick loop.
 *   - If the API is slow, erroring, rate-limited, or there's no key at all,
 *     the game keeps running on the last known modifiers and falls back to
 *     picking a hand-written event from the `events` table.
 *   - Its output is schema-constrained and then re-validated locally, so a
 *     weird response can't corrupt the world.
 *
 * That's what makes "adaptive" safe to ship: the AI is an enhancement layer,
 * never a dependency.
 */

import Anthropic from '@anthropic-ai/sdk';
import { content } from './content.js';
import { addModifier } from './db.js';
import { ALL_TAGS } from '../shared/tags.js';

/** Runs once per in-game day. Override for testing. */
const MIN_DAYS_BETWEEN_RUNS = 1;

/**
 * Model is configurable so you can trade cost for creativity without editing
 * code. Opus is the default; Haiku is dramatically cheaper if you end up
 * running the director very often.
 */
const MODEL = process.env.SNS_DIRECTOR_MODEL ?? 'claude-opus-5';

let client = null;
let inFlight = false;

function getClient() {
  if (client) return client;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  client = new Anthropic();
  return client;
}

/**
 * The schema the model must fill in. Because this is enforced by the API's
 * structured-output mode, we get valid JSON back or nothing — there is no
 * "parse the model's prose and hope" step anywhere in this file.
 */
/**
 * Which tags the model may name — the ones something in the catalogue carries,
 * not the whole vocabulary.
 *
 * `ALL_TAGS` is what a tag *can* be; this is what a tag currently *means* in
 * this shop. The local director has always filtered its drivers this way and
 * says why: an event about a tag no item has is a headline that changes
 * nothing, which is the same failure as authoring an item with invented tags,
 * seen from the other end. The API path was reading the vocabulary, so it could
 * spend a whole day's event on `generic` or `winter` — both real tags, neither
 * of them on a single item — and produce a toast, a log line and no change to
 * any number in the shop.
 *
 * Built per call rather than once: content is edited live, so the enum has to
 * be the catalogue as it stands this morning.
 */
function liveTags() {
  const live = new Set(content().items.flatMap((i) => i.tags ?? []));
  const usable = ALL_TAGS.filter((t) => live.has(t));
  // Nothing stocked at all — a brand new world mid-wipe. Hand back the whole
  // vocabulary rather than an empty enum, which no schema can satisfy.
  return usable.length ? usable : ALL_TAGS;
}

const directorSchema = () => ({
  type: 'object',
  properties: {
    headline: {
      type: 'string',
      description: 'A short in-world news headline, max 8 words. Shown to players as a toast.',
    },
    description: {
      type: 'string',
      description: 'One sentence explaining what is happening in the town today.',
    },
    modifiers: {
      type: 'array',
      description: 'Between 1 and 4 tag-based demand/price effects for this event.',
      items: {
        type: 'object',
        properties: {
          tag: {
            type: 'string',
            enum: liveTags(),
            description: 'Which tag this affects. Must be one of the known tags.',
          },
          demand_mult: {
            type: 'number',
            description: 'Multiplier on how much customers want items with this tag. 1 = no change, 0.4 = slump, 3 = frenzy.',
          },
          price_mult: {
            type: 'number',
            description: 'Multiplier on fair market price for this tag. Raises what suppliers charge AND what customers accept.',
          },
          days: {
            type: 'integer',
            description: 'How many in-game days this lasts, 1 to 5.',
          },
        },
        required: ['tag', 'demand_mult', 'price_mult', 'days'],
        additionalProperties: false,
      },
    },
  },
  required: ['headline', 'description', 'modifiers'],
  additionalProperties: false,
});

/**
 * Build the context the director reasons about. Kept deliberately small and
 * readable — it's also what `GET /api/director/context` returns, so you can
 * see exactly what the AI is being told.
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

const SYSTEM_PROMPT = `You are the world director for a cozy farming and mini-mart game.

Once per in-game day you decide what happens in the town, and express it purely
as multipliers on ITEM TAGS. You never reference specific item IDs — tags only.
That way your events keep working when the players invent new items tomorrow.

Guidelines:
- Be varied and surprising. Weather, trends, local news, rival shops, festivals,
  supply problems, school holidays, a food influencer visiting.
- Keep it cozy and family-friendly. This is played by a parent and their kid.
- React to the state you are given. An empty shop, a bad reputation, or a
  runaway best-seller are all good things to write an event about.
- Most days should be mild (multipliers 0.7 to 1.6). Occasionally go big
  (up to 3.5) for a memorable day.
- demand_mult changes how much people want something. price_mult changes what
  it costs to buy AND what customers will tolerate paying. A shortage is high
  price_mult; a craze is high demand_mult.
- Do not make every day a boom. Slumps are interesting too.`;

/**
 * Ask the model for today's world event.
 * @returns {Promise<{ok: boolean, source: string, headline?: string, error?: string}>}
 */
export async function runDirector(game, { force = false } = {}) {
  // Guard: one at a time, and not more than once per in-game day.
  if (inFlight) return { ok: false, source: 'skipped', error: 'director already running' };
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

  const api = getClient();
  if (!api) return applyFallback(game, 'no ANTHROPIC_API_KEY set');

  inFlight = true;

  try {
    const response = await api.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      // The director is a small, frequent, creative call — medium effort is
      // the right trade here. Raise it if events start feeling repetitive.
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: directorSchema() },
      },
      messages: [{ role: 'user', content: `Here is the shop today:\n\n${describeWorld(game)}\n\nDecide what happens in town today.` }],
    });

    // Safety classifiers can decline; that is a normal outcome, not a crash.
    if (response.stop_reason === 'refusal') {
      return applyFallback(game, 'model declined the request');
    }

    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) return applyFallback(game, 'empty response');

    const plan = JSON.parse(text);
    return applyPlan(game, plan, 'director');
  } catch (err) {
    console.error('[director] failed, falling back:', err.message);
    return applyFallback(game, err.message);
  } finally {
    inFlight = false;
  }
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
 * Write a plan's modifiers into the DB. Every value is clamped locally — the
 * schema constrains shape, this constrains magnitude, so even a valid-looking
 * response can't produce a 500x demand spike.
 */
function applyPlan(game, plan, source) {
  // The enum the model was handed is already the live catalogue (`liveTags`),
  // so this is the belt to that pair of braces: a model can ignore an enum, a
  // plan can arrive from `add_modifier` by hand, and the tags an event names are
  // the one thing about it that has to be true of THIS shop. A craze for
  // something nobody sells is a toast, a log line and no number moving —
  // indistinguishable, from the player's chair, from the director being broken.
  const live = new Set(content().items.flatMap((i) => i.tags ?? []));
  const mods = (plan.modifiers ?? []).filter((m) => live.has(m.tag)).slice(0, 4);
  const dropped = (plan.modifiers ?? []).length - mods.length;
  if (dropped > 0) console.warn(`[director] dropped ${dropped} modifier(s) naming a tag nothing stocks`);
  if (mods.length === 0) return applyFallback(game, 'plan had no modifiers the shop could feel');

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
 * No API key, an error, or a refusal — invent one locally instead.
 *
 * Hand-written `events` rows are still drawn from now and then, because a
 * set piece somebody wrote on purpose beats a generated one, and because
 * they're the place to put an event with a story the generator can't tell.
 * They're the garnish now rather than the whole supply.
 */
function applyFallback(game, reason) {
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
