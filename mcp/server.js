#!/usr/bin/env node
/**
 * THE PLAYGROUND — MCP server for Sprout & Stock.
 *
 * This is what turns "a game we're building" into "a game we're building
 * *inside*". Point a Claude Code agent at this and it can read the live world,
 * see it, add content to it, and stress-test the economy — all against the
 * running shop, without restarting anything or touching a file.
 *
 * It's a thin client over the game server's HTTP control API, which means it
 * works identically whether the server is on this machine or on the other side
 * of a Cloudflare tunnel. That's how two people on two machines drive one
 * shared world.
 *
 * Config:
 *   SNS_API    base URL of the control API (default http://localhost:2567/api)
 *   SNS_TOKEN  bearer token, if the server was started with one
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API = (process.env.SNS_API ?? 'http://localhost:2567/api').replace(/\/$/, '');
const TOKEN = process.env.SNS_TOKEN;

async function call(method, path, body) {
  const headers = { 'content-type': 'application/json', 'x-author': 'mcp' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;

  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Can't reach the game server at ${API}. Is it running? (npm run dev)\n${err.message}`,
    );
  }

  const type = res.headers.get('content-type') ?? '';
  if (type.startsWith('image/')) {
    return { image: Buffer.from(await res.arrayBuffer()).toString('base64') };
  }

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { ok: false, error: text.slice(0, 400) }; }
  if (!res.ok && json.error) throw new Error(json.error);
  return json;
}

const text = (v) => ({
  content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
});

const server = new McpServer({ name: 'sprout-and-stock', version: '0.1.0' });

// ---------------------------------------------------------------------------
// Looking at the world
// ---------------------------------------------------------------------------

server.registerTool('get_state', {
  title: 'Read the live game state',
  description:
    'Read the running shop right now: cash, day, time, season, reputation, every shelf and what is on it, every farm plot, who is in the store, and which world modifiers are active. '
    + 'Call this before changing anything, and again afterwards to confirm the change landed. This is the ground truth — do not guess at game state.',
  inputSchema: {},
}, async () => text(await call('GET', '/state')));

server.registerTool('screenshot', {
  title: 'See the game',
  description:
    'Take a PNG screenshot of the running game from a connected browser and return it as an image. '
    + 'Call this after any visual change — a new item model, a layout change, a rendering tweak — so you can actually see the result instead of assuming it worked. '
    + 'Requires at least one browser tab to have the game open.',
  inputSchema: {},
}, async () => {
  const res = await call('GET', '/screenshot');
  return { content: [{ type: 'image', data: res.image, mimeType: 'image/png' }] };
});

server.registerTool('get_log', {
  title: 'Read the shop event log',
  description: 'Read recent in-world events: sales, spoilage, world events, day rollovers. Useful for working out why the numbers look the way they do.',
  inputSchema: { count: z.number().int().min(1).max(200).default(30).describe('How many recent entries.') },
}, async ({ count }) => text(await call('GET', `/log?n=${count}`)));

// ---------------------------------------------------------------------------
// Balance testing — the highest-value tool here
// ---------------------------------------------------------------------------

server.registerTool('simulate', {
  title: 'Run a headless balance test',
  description:
    'Fast-forward a throwaway copy of the game for N in-game days with a bot shopkeeper, and return the economy results: profit per day, what sold, what never sold, spoilage, abandoned baskets, and a plain-language verdict. 100 days takes about a second.\n\n'
    + 'CALL THIS whenever you change anything that touches money — adding or repricing an item, editing a customer archetype, changing an upgrade cost, tuning demand. '
    + 'Balance is invisible from reading code; this is the only way to know if a change made the game unplayable. It runs against a separate world, so it never disturbs the live shop.\n\n'
    + 'Pay attention to `deadStock` (items nobody ever bought — usually a tagging mistake) and `verdict`.',
  inputSchema: {
    days: z.number().int().min(1).max(500).default(30).describe('In-game days to simulate.'),
    seed: z.string().default('sim').describe('World seed. Same seed gives identical results, so use one seed to compare before/after a change.'),
    startCash: z.number().min(0).default(250).describe('Starting money.'),
    priceMult: z.number().min(0.1).max(5).default(1).describe('How much the bot marks up vs the suggested price. 1 = suggested, 1.5 = gouging.'),
  },
}, async (args) => text(await call('POST', '/simulate', args)));

// ---------------------------------------------------------------------------
// Content — the main thing an agent adds to this game
// ---------------------------------------------------------------------------

server.registerTool('list_tags', {
  title: 'List the tag vocabulary',
  description:
    'List every tag the game knows, grouped by kind (category, quality, property, diet, occasion, season, trend). '
    + 'READ THIS BEFORE creating any item, crop or customer — tags are how everything in this game connects. An item tagged correctly automatically gets the right price, the right demand, the right customers and the right spoilage. An item with made-up tags will exist but nobody will ever buy it.',
  inputSchema: {},
}, async () => text(await call('GET', '/tags')));

server.registerTool('list_content', {
  title: 'List existing content',
  description: 'List all items, crops, customer archetypes, events, or upgrades currently in the game. Check here before creating something to avoid duplicating an id.',
  inputSchema: {
    kind: z.enum(['item', 'crop', 'archetype', 'event', 'upgrade']).describe('Which kind of content to list.'),
  },
}, async ({ kind }) => text(await call('GET', `/content/${kind}`)));

const MODEL_HELP =
  'Appearance, built from primitives — there are no art assets in this game, so you describe what it looks like here. '
  + '`parts` is 1-8 shapes (box, sphere, cone, cylinder, capsule), each with a #rrggbb `color`, `pos` [x,y,z] and `scale` [x,y,z] in world units where 1 = one floor tile. '
  + 'Keep props roughly 0.3-0.5 units tall and sitting on y=0 upward. Example: a tomato is a red sphere at [0,0.16,0] scaled [0.3,0.28,0.3] with a small green cone on top.';

server.registerTool('create_item', {
  title: 'Create or update an item',
  description:
    'Add a sellable item to the live game, or update an existing one by reusing its id. It appears in the running shop within about a second — no restart, no file edit, no merge conflict.\n\n'
    + 'Tags do all the work: they determine who wants it, what it should cost, whether it spoils, whether it needs a freezer, and how seasons and world events affect it. Call list_tags first. '
    + 'Invalid content is rejected with an explanation and the running game is unaffected, so it is safe to try.',
  inputSchema: {
    id: z.string().describe('lowercase-kebab-case unique id, e.g. "hot-sauce".'),
    name: z.string().describe('Display name.'),
    tags: z.array(z.string()).min(1).describe('Tags from list_tags. This is the most important field — see list_tags.'),
    base_cost: z.number().min(0).describe('What you pay the supplier per unit.'),
    base_price: z.number().min(0).describe('Suggested shelf price. Must be >= base_cost.'),
    shelf_life_days: z.number().min(0).default(5).describe('Days before it spoils. Ignored if tagged shelf-stable.'),
    stack: z.number().int().min(1).default(12).describe('How many fit in one shelf stack.'),
    model: z.any().describe(MODEL_HELP),
  },
}, async (args) => text(await call('POST', '/content/item', args)));

server.registerTool('create_crop', {
  title: 'Create or update a growable crop',
  description:
    'Add something the player can plant on a farm plot. It produces an existing item when harvested, so create the item first. '
    + 'Appears in the seed bar of every connected player immediately.',
  inputSchema: {
    id: z.string().describe('lowercase-kebab-case unique id, e.g. "pepper-plant".'),
    name: z.string(),
    item_id: z.string().describe('Which existing item this yields when harvested.'),
    grow_minutes: z.number().min(0.1).max(600).describe('Real-world minutes from planting to harvest. Existing crops range 0.8 to 2.5.'),
    yield_min: z.number().int().min(1).default(1),
    yield_max: z.number().int().min(1).default(3),
    seed_cost: z.number().min(0),
    seasons: z.array(z.enum(['spring', 'summer', 'autumn', 'winter'])).default([]).describe('Empty means it grows all year.'),
    model: z.any().describe(MODEL_HELP),
  },
}, async (args) => text(await call('POST', '/content/crop', args)));

server.registerTool('create_archetype', {
  title: 'Create or update a customer type',
  description:
    'Add a kind of shopper. `affinities` maps tag -> how much they like it (-1 to 1), and that alone determines what they buy — no per-item logic. '
    + 'Adding an archetype with a tag affinity nothing currently carries is a good way to create demand for items that do not exist yet.',
  inputSchema: {
    id: z.string().describe('lowercase-kebab-case unique id, e.g. "night-shift-worker".'),
    name: z.string(),
    affinities: z.record(z.string(), z.number().min(-2).max(2)).describe('tag -> weight, roughly -1 to 1. e.g. {"junk":0.9,"healthy":-0.6}'),
    price_sensitivity: z.number().min(0).max(1).default(0.5).describe('0 = ignores price tags, 1 = extremely price driven.'),
    patience: z.number().min(5).max(600).default(60).describe('Seconds they will queue before abandoning their basket.'),
    budget_min: z.number().min(0).default(10),
    budget_max: z.number().min(0).default(50),
    basket_min: z.number().int().min(1).default(1),
    basket_max: z.number().int().min(1).default(4),
    spawn_weight: z.number().min(0).default(1).describe('Relative likelihood vs other archetypes.'),
    color: z.string().default('#d98cb3').describe('#rrggbb — how they look in game.'),
  },
}, async (args) => text(await call('POST', '/content/archetype', args)));

server.registerTool('create_event', {
  title: 'Create or update a world event',
  description:
    'Add an event the world director can fire — a heat wave, a trend, a shortage. Effects are expressed against tags, so an event written today still works on items invented next month.',
  inputSchema: {
    id: z.string(),
    name: z.string(),
    description: z.string().default(''),
    effects: z.array(z.object({
      tag: z.string(),
      demand_mult: z.number().min(0).max(10).default(1),
      price_mult: z.number().min(0).max(10).default(1),
    })).min(1),
    duration_days: z.number().int().min(1).max(30).default(2),
    weight: z.number().min(0).default(1),
    min_day: z.number().int().min(0).default(0),
  },
}, async (args) => text(await call('POST', '/content/event', args)));

server.registerTool('create_upgrade', {
  title: 'Create or update a shop upgrade',
  description:
    'Add something the player can buy to expand. `kind` drives what it does: plot/shelf/freezer/checkout grant fixtures and re-flow the building, '
    + 'space buys floor area (payload {"width":n,"depth":n}) so the shop itself gets bigger, station adds an appliance (payload {"station":"blender"}), '
    + 'capacity/speed change the player, staff hires an NPC worker (payload {"role":"clerk"|"stocker"|"farmhand"|"chef"}), decor is cosmetic.\n\n'
    + 'Note that shelf/freezer/plot/checkout upgrades also set the per-unit price in build mode, where the player buys and places one fixture at a time: '
    + 'a cheaper bundle makes single fixtures cheaper to build and cheaper to sell back.',
  inputSchema: {
    id: z.string(),
    name: z.string(),
    description: z.string().default(''),
    cost: z.number().min(0),
    kind: z.enum(['shelf', 'freezer', 'plot', 'checkout', 'capacity', 'speed', 'decor', 'staff', 'station', 'space']),
    payload: z.record(z.string(), z.any()).default({}).describe('Knobs for that kind, e.g. {"plots":4}, {"speedMult":1.3}, {"station":"blender"} or {"width":4,"depth":2}.'),
    requires: z.array(z.string()).default([]).describe('Upgrade ids that must be owned first.'),
  },
}, async (args) => text(await call('POST', '/content/upgrade', args)));

server.registerTool('delete_content', {
  title: 'Delete content',
  description: 'Remove an item, crop, archetype, event or upgrade from the live game. Deleting an item also deletes crops that produce it.',
  inputSchema: {
    kind: z.enum(['item', 'crop', 'archetype', 'event', 'upgrade']),
    id: z.string(),
  },
}, async ({ kind, id }) => text(await call('DELETE', `/content/${kind}/${id}`)));

// ---------------------------------------------------------------------------
// Poking the live world
// ---------------------------------------------------------------------------

server.registerTool('stock_shop', {
  title: 'Fill the shelves and plant the fields',
  description:
    'Instantly stock every shelf with a sensible item and plant every farm plot at staggered growth stages, for free. '
    + 'Call this before screenshot when you want to *see* the shop rather than an empty building — for example to check how a new item you just created actually looks on a shelf. Staging only; it is not part of normal play.',
  inputSchema: {},
}, async () => text(await call('POST', '/stock', {})));

server.registerTool('spawn_customer', {
  title: 'Spawn customers now',
  description:
    'Drop customers into the shop immediately instead of waiting for footfall. '
    + 'Use this to test a change straight away — spawn the archetype that should want your new item and watch whether they actually buy it.',
  inputSchema: {
    count: z.number().int().min(1).max(30).default(1),
    archetypeId: z.string().optional().describe('Specific archetype id. Omit for a weighted random pick.'),
  },
}, async (args) => text(await call('POST', '/spawn', args)));

server.registerTool('set_time', {
  title: 'Jump the clock',
  description: 'Set the in-game day or hour, or skip days forward. Use it to reach a state quickly — a specific season, the evening rush, or the day an event unlocks.',
  inputSchema: {
    day: z.number().int().min(1).optional(),
    hour: z.number().min(0).max(23.9).optional().describe('Hour of day. The shop is open 08:00-20:00.'),
    skipDays: z.number().int().min(1).max(60).optional().describe('Jump this many days forward, running end-of-day for each.'),
  },
}, async (args) => text(await call('POST', '/time', args)));

server.registerTool('add_cash', {
  title: 'Add or set money',
  description: 'Give the shop money (or set an exact amount) so you can test something expensive without grinding for it.',
  inputSchema: {
    amount: z.number().optional().describe('Amount to add. Negative removes.'),
    set: z.number().optional().describe('Set the balance to exactly this instead.'),
  },
}, async (args) => text(await call('POST', '/cash', args)));

server.registerTool('add_modifier', {
  title: 'Force a demand or price change',
  description:
    'Directly push demand or price for a tag, without waiting for the director. '
    + 'The fastest way to check that a new tag actually does something: spike it and watch whether customers change behaviour.',
  inputSchema: {
    tag: z.string().describe('Which tag to affect.'),
    demand_mult: z.number().min(0).max(10).default(1).describe('1 = no change, 3 = frenzy, 0.3 = slump.'),
    price_mult: z.number().min(0).max(10).default(1).describe('Multiplier on fair market price.'),
    days: z.number().int().min(1).max(30).default(2),
    label: z.string().default('manual').describe('Shown to players in the HUD.'),
  },
}, async (args) => text(await call('POST', '/modifier', args)));

server.registerTool('clear_modifiers', {
  title: 'Clear world modifiers',
  description: 'Remove active demand/price modifiers to get back to a neutral baseline before measuring something.',
  inputSchema: { source: z.string().optional().describe('Only clear this source (e.g. "manual", "director"). Omit to clear everything.') },
}, async (args) => text(await call('POST', '/modifiers/clear', args)));

server.registerTool('regenerate_layout', {
  title: 'Regenerate the shop and farm layout',
  description:
    'Rebuild the store and fields from a new seed. Shelf stock, planted crops and appliance contents are carried across, and so is anything the player has positioned by hand in build mode. '
    + 'Use it to get a different shop shape, or to check that a layout change works across many seeds rather than just the one you were looking at.\n\n'
    + 'Pass clearPlacements to also throw away every hand-placed fixture and go back to a purely procedural shop. That does not change what the shop owns — the same number of shelves, tills and plots come back, just wherever the generator wants them.',
  inputSchema: {
    seed: z.string().optional().describe('Seed to use. Omit for a fresh random one.'),
    clearPlacements: z.boolean().default(false).describe('Discard hand-placed fixture positions and let the generator lay everything out again.'),
  },
}, async (args) => text(await call('POST', '/regenerate', args)));

server.registerTool('run_director', {
  title: 'Run the AI world director now',
  description:
    'Force the world director to decide what happens in town, instead of waiting for the next in-game day. '
    + 'Falls back to a hand-written event if no ANTHROPIC_API_KEY is configured on the server.',
  inputSchema: {},
}, async () => text(await call('POST', '/director/run', {})));

server.registerTool('get_director_context', {
  title: 'See what the director is told',
  description: 'Return the exact world summary passed to the AI director. Useful when its events feel off — usually the context is missing something.',
  inputSchema: {},
}, async () => text(await call('GET', '/director/context')));

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[sprout-and-stock mcp] connected, talking to ${API}`);
