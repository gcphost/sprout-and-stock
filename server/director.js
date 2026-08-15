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
const DIRECTOR_SCHEMA = {
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
            enum: ALL_TAGS,
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
};

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
  if (!force && game._lastDirectorDay !== undefined
      && game.day - game._lastDirectorDay < MIN_DAYS_BETWEEN_RUNS) {
    return { ok: false, source: 'skipped', error: 'already ran today' };
  }

  const api = getClient();
  if (!api) return applyFallback(game, 'no ANTHROPIC_API_KEY set');

  inFlight = true;
  game._lastDirectorDay = game.day;

  try {
    const response = await api.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      // The director is a small, frequent, creative call — medium effort is
      // the right trade here. Raise it if events start feeling repetitive.
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: DIRECTOR_SCHEMA },
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
 * Write a plan's modifiers into the DB. Every value is clamped locally — the
 * schema constrains shape, this constrains magnitude, so even a valid-looking
 * response can't produce a 500x demand spike.
 */
function applyPlan(game, plan, source) {
  const mods = (plan.modifiers ?? []).slice(0, 4);
  if (mods.length === 0) return applyFallback(game, 'plan had no modifiers');

  for (const m of mods) {
    addModifier({
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

/**
 * No API key, an error, or a refusal — pick one of the hand-written events
 * from the `events` table instead. The game is fully playable this way; the
 * AI just makes the world less predictable.
 */
function applyFallback(game, reason) {
  const eligible = content().events.filter((e) => e.min_day <= game.day);
  if (eligible.length === 0) {
    return { ok: false, source: 'fallback', error: `${reason}; no eligible events either` };
  }

  const picked = game.rng.weighted(eligible, 'weight');
  for (const eff of picked.effects) {
    addModifier({
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
  return { ok: true, source: 'fallback', reason, headline: picked.name, modifiers: picked.effects.length };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
