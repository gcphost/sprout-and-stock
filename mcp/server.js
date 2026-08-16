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
// Save slots
//
// There is more than one shop now, and every other tool here acts on exactly
// one of them. Which one is decided by `use_world`, and — because that pointer
// is shared with anyone else driving this server — every reply says which world
// it landed on. Check it.
// ---------------------------------------------------------------------------

server.registerTool('list_worlds', {
  title: 'List the save slots',
  description:
    'List every shop that exists: its id, name, day, cash, season, whether anyone is playing it right now, and which one tools currently act on (`focused`). '
    + 'Call this first when you are asked to do anything to "the game" and you are not sure which shop is meant — with several saves, poking the wrong one is silent.\n\n'
    + 'Content (items, crops, customers, fixtures, workers, recipes) is NOT per-world. It is one shared library every shop reads from, so creating an item adds it to all of them at once.',
  inputSchema: {},
}, async () => text(await call('GET', '/worlds')));

server.registerTool('use_world', {
  title: 'Choose which shop to act on',
  description:
    'Point every later tool call at one shop, by id from list_worlds. Stays put until changed, and survives a server restart.\n\n'
    + 'IMPORTANT: this pointer is SHARED. Two people can be driving this server with an agent each, and setting it moves both. '
    + 'If you are working on a specific shop, set it at the start of the job and re-check `world` in the replies you get back — a call that quietly landed somewhere else looks exactly like a call that worked.\n\n'
    + 'Pass no id to clear it, which puts the default back to the busiest live shop.',
  inputSchema: {
    world: z.string().optional().describe('World id from list_worlds. Omit to clear the pointer.'),
  },
}, async ({ world }) => text(await call('POST', '/focus', { world: world ?? null })));

server.registerTool('create_world', {
  title: 'Start a new shop',
  description:
    'Create a save slot: a fresh shop on day one with starting cash, its own building, its own farm and its own world events. '
    + 'Does not switch to it — call use_world afterwards if you want to work on it.\n\n'
    + 'Everything authored (items, crops, customers, fixtures, workers, recipes) is shared, so a new world opens with the whole catalogue already in it. What is fresh is the money, the day, the building and what the shop owns.',
  inputSchema: {
    name: z.string().optional().describe('What to call it, e.g. "Balance testing". Defaults to "Shop N".'),
    seed: z.string().optional().describe('Decides the shape of the building and fields. Omit for a random one.'),
    cash: z.number().optional().describe('Starting money. Defaults to 250. Clamped to 0–1,000,000.'),
    shelves: z.number().optional()
      .describe('Shelf units the shop opens with. Defaults to 6, clamped to 1–25. Set only at creation: '
        + 'the building is stamped the first time the world opens, and after that the shop is what is standing in it.'),
    plots: z.number().optional()
      .describe('Farm plots the shop opens with. Defaults to 4, clamped to 1–32. Creation-only, same as shelves.'),
  },
}, async (args) => text(await call('POST', '/worlds', args)));

server.registerTool('delete_world', {
  title: 'Delete a shop',
  description:
    'Permanently delete one save slot: its shop, its money, its upgrades, its staff and its world events. Content is untouched, because content belongs to every world.\n\n'
    + 'This cannot be undone and there is no backup. Confirm with the person you are working with before calling it — "my world is bust" usually means reset_economy, which keeps the shop you built. '
    + 'Refuses to delete the only remaining world.',
  inputSchema: {
    world: z.string().describe('World id from list_worlds. Exact — there is no fuzzy match on purpose.'),
  },
}, async ({ world }) => text(await call('DELETE', `/worlds/${encodeURIComponent(world)}`)));

server.registerTool('keep_world', {
  title: 'Protect a shop from cleanup, or stop protecting it',
  description:
    'Worlds nobody has opened for a fortnight are deleted automatically to keep the menu short (SNS_WORLD_TTL_DAYS on the server). '
    + 'A kept world is never swept, however long it sits. Worlds with somebody in them, and the last world standing, are never swept either.\n\n'
    + 'Use this on anything that matters — a long save, a shop somebody is proud of — before it has a chance to go quiet for two weeks.',
  inputSchema: {
    world: z.string().describe('World id from list_worlds.'),
    kept: z.boolean().default(true).describe('true to protect it, false to let it be swept again.'),
  },
}, async ({ world, kept }) => text(await call('PATCH', `/worlds/${encodeURIComponent(world)}`, { pinned: kept })));

// ---------------------------------------------------------------------------
// Looking at the world
// ---------------------------------------------------------------------------

server.registerTool('get_state', {
  title: 'Read the live game state',
  description:
    'Read the running shop right now: cash, day, time, season, reputation, every shelf and what is on it, every farm plot, who is in the store, and which world modifiers are active. '
    + 'Call this before changing anything, and again afterwards to confirm the change landed. This is the ground truth — do not guess at game state.\n\n'
    + 'Acts on whichever shop use_world points at, and the reply says which under `world`. If nobody has that shop open, reading it OPENS it — the sim starts running and closes itself again a few minutes later.',
  inputSchema: {},
}, async () => text(await call('GET', '/state')));

server.registerTool('screenshot', {
  title: 'See the game',
  description:
    'Take a PNG screenshot of the running game from a connected browser and return it as an image. '
    + 'Call this after any visual change — a new item model, a layout change, a rendering tweak — so you can actually see the result instead of assuming it worked.\n\n'
    + 'Needs a browser tab open ON THE SHOP YOU ARE WORKING ON — the server has no renderer, so an unattended world has nothing that could take the picture. '
    + 'The link that opens a specific one is /?world=<id>.',
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
    + 'Pay attention to `deadStock` (items nobody ever bought — usually a tagging mistake) and `verdict`.\n\n'
    + 'It copies the shop use_world points at — its staff, its upgrades, its fixtures — and reports which under `startedWith.world`. '
    + 'Two runs of one seed against two different shops are two different experiments, so check that field before believing a before/after.',
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
  description: 'List all items, crops, customer archetypes, events, upgrades or recipes currently in the game. Check here before creating something to avoid duplicating an id.',
  inputSchema: {
    kind: z.enum(['item', 'crop', 'archetype', 'event', 'upgrade', 'recipe', 'fixture', 'worker', 'pastime']).describe('Which kind of content to list.'),
  },
}, async ({ kind }) => text(await call('GET', `/content/${kind}`)));

const MODEL_HELP =
  'Appearance, built from primitives — there are no art assets in this game, so you describe what it looks like here. '
  + '`parts` is 1-8 shapes (box, sphere, cone, cylinder, capsule), each with a #rrggbb `color`, `pos` [x,y,z] and `scale` [x,y,z] in world units where 1 = one floor tile. '
  + 'Keep props roughly 0.3-0.5 units tall and sitting on y=0 upward. Example: a tomato is a red sphere at [0,0.16,0] scaled [0.3,0.28,0.3] with a small green cone on top.';


const STAGE_HELP =
  'A model is either `parts` (looks the same always) or `stages` (changes as it goes along). '
  + 'Each stage is {name, at, parts}, where `at` is where on a 0..1 run that look takes over — the first stage must start at 0. '
  + 'What feeds that 0..1 depends on the thing: a crop feeds its growth, so stages are seed -> sprout -> laden plant; '
  + 'a fixture feeds its tier, so stages are what tier 1, 2 and 3 look like.';

server.registerTool('create_fixture', {
  title: 'Design a piece: a fixture, a decoration or a lamp',
  description:
    'Create or update one entry in the build catalog — what it looks like, what it costs and how far a player can upgrade one. Live in the running shop within about a second.\n\n'
    + 'KINDS ARE CODE, PIECES ARE CONTENT. The `id` is yours to choose and there can be as many pieces as you like; `kind` says which build rules it plays by, and that list is closed because where a thing may go, whether it blocks and which side you work it from are behaviour:\n'
    + '  shelf         stock, indoors, browsed from the side it faces\n'
    + '  freezer       the same, for anything frozen\n'
    + '  checkout      takes money, needs room alongside for a queue\n'
    + '  station       an appliance (which machine it is still comes from its upgrade)\n'
    + '  plot          a farm bed, outdoors, on bare grass\n'
    + '  prop-floor    a decoration standing on the floor, indoors or out\n'
    + '  prop-ceiling  a decoration hanging from the ceiling, so indoors only\n\n'
    + 'Props never block: people walk past them. A barrel that stopped somebody would need to own its cell, and a cell can only say one thing at a time — so anything that must be walked around is a shelf, not a prop.\n\n'
    + 'Several pieces may name one kind, and that is the point: a second shelf design, a corner till, four different planters. They share the kind\'s rules and nothing else — each carries its own model, its own variants, its own tier ladder and its own price.\n\n'
    + 'TIERS are the progression. Tier 1 is what a newly built one already is, so it must cost 0. Every tier after it is something the player pays to step up to, in place, keeping its stock. The multipliers are what the upgrade is FOR — a tier that changes no numbers and no art is a button that takes money and does nothing:\n'
    + '  capacity_mult  how many units it holds (shelves, freezers)\n'
    + '  keeps_mult     how long goods last on it (freezers especially)\n'
    + '  speed_mult     how fast it works (appliances; on a plot, how fast crops grow)\n\n'
    + 'Give the model `stages` to make each tier look different — stage 1 is tier 1, the last stage is the top tier. '
    + 'Models are authored facing EAST (that is rotation 0, the side a shopper stands on), roughly one tile wide, sitting on y=0 upward. Keep the top below 1.1, which is wall height — anything taller stands over the building.\n\n'
    + 'A prop-ceiling piece is the exception: its origin IS the ceiling, so draw it DOWNWARD with negative y. A pendant is a cord at about y=-0.15, a shade at y=-0.36 and a bulb below that. Drawn upward it pushes through the roof and reads as a lamp floating outside the shop.\n\n'
    + 'A fixture that holds stock says WHERE it holds it: flag each part goods should stand on with `surface: true` and they are drawn on those boards, top row filling first. '
    + 'Leave it off and stock piles on top of the whole thing instead, which is what a counter wants. Face an open unit east so its rows are not drawn behind their own back panel.\n\n'
    + 'A part can also carry `alpha` (0.05..1) to be glass — a freezer door you see the stock through, a window. Glass casts no shadow.\n\n'
    + 'VARIANTS are other shapes of the same piece — a corner unit, an endcap, a low one — and they are looks only. They carry a model and nothing else, because the numbers live on the shared tier ladder: '
    + 'a corner shelf costs and holds exactly what a straight one does, restyling something already built is free and keeps its stock, and no variant can move the balance. Tiers cost money and change numbers; variants are taste.\n\n'
    + 'EMITS makes it a lamp. The renderer honours it; nothing in the sim reads it, so a light is worth exactly what it looks like today. Only the eight nearest the camera get a real light — that cap is deliberate, so author lamps as fittings you would actually put in a room rather than as a way to floodlight one.\n\n'
    + 'COST is what one costs to put down. Leave it 0 on a shelf, freezer, till or plot and it stays priced by the upgrade that sells that kind, which is how the whole economy still works. A prop has no upgrade behind it, so a prop with no cost is free — price your decorations.\n\n'
    + STAGE_HELP,
  inputSchema: {
    id: z.string().describe('Slug, yours to choose, e.g. "terracotta-planter" or "chiller-shelf". Reuse one to update it.'),
    kind: z.enum(['shelf', 'freezer', 'checkout', 'station', 'plot', 'prop-floor', 'prop-ceiling'])
      .describe('Which build rules it plays by. Closed set — this is not a way to invent kinds.'),
    name: z.string().describe('Display name, e.g. "Shelving". This is what the build palette calls it.'),
    model: z.any().describe('{parts:[...]} or {stages:[{name, at, parts:[...]}]}. ' + STAGE_HELP),
    variants: z.any().optional().describe('Optional other shapes of this kind: [{id, name, model}]. Looks only — no costs, no multipliers, and the kind\'s own model is always offered alongside them as "Standard".'),
    tiers: z.array(z.object({
      name: z.string().describe('What this rung is called, e.g. "Chilled" or "Deep Freeze".'),
      cost: z.number().min(0).describe('What stepping up to it costs. Tier 1 must be 0.'),
      capacity_mult: z.number().min(0.1).max(10).default(1),
      keeps_mult: z.number().min(0.1).max(20).default(1),
      speed_mult: z.number().min(0.1).max(10).default(1),
    })).min(1).max(6).describe('Lowest rung first. Tier 1 is what a new one already is.'),
    cost: z.number().min(0).optional()
      .describe('What one costs to build. 0 (the default) means "priced by the upgrade that sells this kind" — right for fixtures, free for props.'),
    emits: z.object({
      color: z.string().describe('#rrggbb. Warm for a bulb, cold for a chiller light.'),
      intensity: z.number().min(0).max(4).default(1).describe('Brightness. 1 is a room fitting; above 2 washes an aisle out.'),
      range: z.number().min(0.5).max(12).default(4).describe('How far the glow carries, in tiles.'),
    }).optional().describe('Makes this piece a lamp. Renderer-only — no shopper behaves differently under it yet.'),
    tags: z.array(z.string()).optional()
      .describe('Call list_tags first. Nothing reads these on a piece yet — they are here so a shop dressed "cosy" can mean something later.'),
  },
}, async (args) => text(await call('POST', '/content/fixture', args)));

server.registerTool('create_worker', {
  title: 'Design a kind of worker',
  description:
    'Create or update a kind of worker the player can hire — what they look like, what they cost, and what they are willing to do. Live in the running shop within about a second.\n\n'
    + 'JOBS are the whole point. A worker is not a role with a hardcoded program; it is a list of jobs with weights, and one generic brain draws from that list. The job names are fixed, because each one is a routine in the sim — anything else is a worker who stands still:\n'
    + '  serve    man a till and take payment\n'
    + '  restock  order wholesale to refill an empty shelf\n'
    + '  unload   carry a pallet at the delivery bay onto shelves\n'
    + '  shelve   put whatever is in hand onto a legal shelf\n'
    + '  till     turn rough soil over\n'
    + '  sow      plant the chosen crop in a bare bed\n'
    + '  harvest  pick a ripe plot\n'
    + '  craft    load an appliance and collect what it made\n'
    + '  tidy     crate up anything that has nowhere to go\n\n'
    + 'WEIGHT is how much of that worker\'s attention a job gets. They draw from the list weighted, then fall through to the rest if the drawn job has nothing to do — so weight reads as priority when only one job has work, and as a share of the day when several do. serve 10 + harvest 3 is a till worker who wanders out to the crops when nobody is queueing.\n\n'
    + 'TIERS are the promotion ladder, exactly like a fixture. Tier 1 is who you hired, so it must cost 0. Later tiers cost money and should change numbers AND art, or the button takes money and does nothing:\n'
    + '  speed_mult  how fast they walk\n'
    + '  pace_mult   how quickly they pick up the next job\n'
    + '  carry_mult  how much they carry in one trip\n\n'
    + 'Give the model `stages` so a promotion is visible — stage 1 is tier 1, the last stage is the top tier. A worker model stands about 0.9 tall on y=0, facing EAST.\n\n'
    + 'Run `simulate` afterwards. Staff drive most of the shop, so a fast or cheap worker moves the economy more than any single item does.\n\n'
    + STAGE_HELP,
  inputSchema: {
    id: z.string().describe('Slug, e.g. "butcher".'),
    name: z.string().describe('Display name, e.g. "Butcher".'),
    tags: z.array(z.string()).optional().describe('Call list_tags first. Events aim at tags, never at a worker id.'),
    model: z.any().describe('{parts:[...]} or {stages:[{name, at, parts:[...]}]}. ' + STAGE_HELP),
    jobs: z.array(z.object({
      job: z.enum(['serve', 'restock', 'unload', 'shelve', 'till', 'sow', 'harvest', 'craft', 'tidy']),
      weight: z.number().min(0.1).max(100).default(1).describe('Share of their attention. Relative to the other jobs.'),
    })).min(1).describe('What they will do, and how much of each.'),
    tiers: z.array(z.object({
      name: z.string().describe('What this rung is called, e.g. "Head chef".'),
      cost: z.number().min(0).describe('What promoting to it costs. Tier 1 must be 0.'),
      speed_mult: z.number().min(0.1).max(10).default(1),
      pace_mult: z.number().min(0.1).max(10).default(1),
      carry_mult: z.number().min(0.1).max(10).default(1),
    })).min(1).max(6).optional().describe('Lowest rung first. Omit for a worker who cannot be promoted.'),
    cost: z.number().min(0).describe('One-off, to take them on.'),
    wage: z.number().min(0).optional().describe('Charged every day they stay on. 0 is free labour.'),
    speed: z.number().min(0.1).max(20).optional().describe('Tiles per second. 2.6 is the shop standard.'),
    pace: z.number().min(0.05).max(10).optional().describe('Seconds between jobs. Lower is busier; 0.45 is a brisk clerk.'),
    carry: z.number().int().min(1).optional().describe('Units per trip. 6 matches the player.'),
    color: z.string().optional().describe('Hex, e.g. "#7a9e4b".'),
  },
}, async (args) => text(await call('POST', '/content/worker', args)));

server.registerTool('create_pastime', {
  title: 'Design something a worker does on their break',
  description:
    'Create or update a pastime — what a worker goes and does when they are worn out. Live in the running shop within about a second.\n\n'
    + 'A worker loses energy with every job they finish. As it drops they get slower, and below a quarter of a tank they stop and take a break: one pastime is drawn by weight, they walk to its spot, and it puts `restores` back. This is deliberately NOT one of the assignable jobs — a job is drawn by weight and answers "how much of their day", while a break is a threshold you hit when you are spent.\n\n'
    + 'SPOT is where they have to be, and it must be somewhere the layout actually has:\n'
    + '  here     wherever they finished — leaning on the nearest thing\n'
    + '  outside  out the front, on the path\n'
    + '  bay      round the back at the delivery bay, out of sight\n'
    + '  till     propped against a counter, pretending to look busy\n\n'
    + 'SECONDS and RESTORES are the only two numbers the sim reads, and together they decide what a break costs you: a long break that restores little is a worker who is barely ever working.\n\n'
    + 'BUYS makes them a customer of your own shop. Give it item tags and they take one matching item off a shelf and pay the shelf price for it, which lands in the day\'s takings. A snack with no stock on the shelf simply does not happen, so it never blocks the break.\n\n'
    + 'MODEL is the prop they have with them — a mug, a phone, a vape and its cloud, a sandwich. It hangs on the worker for the length of the break and goes when they get back to work, and it is what makes a break visible from across the shop rather than only in their menu. A worker is about 0.9 tall, their front is +z and their hands are around y 0.6, so [0.16, 0.6, 0.28] is "held out in front" and anything past y 0.9 floats over their head. They also slump and rock while they are resting whether or not you give them a prop, so a pastime with no model is legible, just anonymous.\n\n'
    + 'Give the model `stages` and the 0..1 that picks between them is HOW FAR THROUGH THE BREAK THEY ARE — the first thing in the game to drive a staged model from time. So a mug empties, a sandwich goes down to the crusts, a cloud builds and thins. That whole arc is authored, and no code knows what a mug is.\n\n'
    + 'Flag a part `drift: true` and it stops being held: it rises off where you put it, spreads, fades out and starts again. Vapour, steam, the glow off a phone screen. That loop is the one thing stages cannot say, because a stage arc plays once across a twenty-second break — so use stages for what the break does to the prop, and `drift` for what never stops.\n\n'
    + 'Keep `doing` to one short clause — it is shown in a 214px panel and anything longer is ellipsised away.',
  inputSchema: {
    id: z.string().describe('Slug, e.g. "vape-out-back".'),
    name: z.string().describe('Display name, e.g. "Vape out back".'),
    doing: z.string().describe('What the roster says while they are at it, e.g. "vaping out back". One clause.'),
    spot: z.enum(['here', 'outside', 'bay', 'till']).default('here').describe('Where they have to be.'),
    seconds: z.number().min(1).max(600).default(20).describe('How long it takes, in seconds of game time.'),
    restores: z.number().min(0.05).max(1).default(0.5).describe('How much of a full tank it puts back, 0..1.'),
    buys: z.array(z.string()).max(6).optional()
      .describe('Item tags they will buy one of, off your own shelf, at the shelf price. Call list_tags first.'),
    weight: z.number().min(0).max(100).default(1).describe('Relative likelihood of picking this one.'),
    tags: z.array(z.string()).optional().describe('For events to aim at, e.g. "outdoor". Never aim at an id.'),
    model: z.any().optional().describe(
      'The prop they have with them: {parts:[...]} or {stages:[{name, at, parts:[...]}]}. '
      + 'Here the 0..1 feeding the stages is how far through the break they are, so stages are the arc of it — a full mug, a half one, a drained one. '
      + 'A part with `drift: true` rises, spreads and fades on a loop instead of being held. Omit for a break with no prop.',
    ),
  },
}, async (args) => text(await call('POST', '/content/pastime', args)));

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
    'Add a kind of shopper. `affinities` maps tag -> how much they like it (-1 to 1), and that determines what they buy — no per-item logic. '
    + 'They arrive with a shopping list of TAGS rolled from those affinities; `staple_tags` are the ones they actually came for and will hold against you. '
    + 'Adding an archetype with a tag affinity nothing currently carries is a good way to create demand for items that do not exist yet.',
  inputSchema: {
    id: z.string().describe('lowercase-kebab-case unique id, e.g. "night-shift-worker".'),
    name: z.string(),
    affinities: z.record(z.string(), z.number().min(-2).max(2)).describe('tag -> weight, roughly -1 to 1. e.g. {"junk":0.9,"healthy":-0.6}'),
    staple_tags: z.array(z.string()).max(8).default([]).describe(
      'Tags this shopper actually came in for, e.g. ["dairy"]. Miss one and they leave annoyed and it is counted under `unmetDemand` in simulate. '
      + 'Everything else on their list is drawn from `affinities` and is opportunistic. Leave empty for a browser.',
    ),
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
    + 'catchment moves the shop somewhere more people walk past (payload {"reach":n}, added to a base of 16). It is the only thing that raises how '
    + 'many customers exist at all — everything else competes for a share of them — so it is the closest thing the game has to a level. '
    + 'Re-run `simulate` after adding a rung: it changes the ceiling on every day that follows.\n\n'
    + 'Note that shelf/freezer/plot/checkout upgrades also set the per-unit price in build mode, where the player buys and places one fixture at a time: '
    + 'a cheaper bundle makes single fixtures cheaper to build and cheaper to sell back.',
  inputSchema: {
    id: z.string(),
    name: z.string(),
    description: z.string().default(''),
    cost: z.number().min(0),
    kind: z.enum(['shelf', 'freezer', 'plot', 'checkout', 'capacity', 'speed', 'decor', 'staff', 'station', 'space', 'catchment']),
    payload: z.record(z.string(), z.any()).default({}).describe('Knobs for that kind, e.g. {"plots":4}, {"speedMult":1.3}, {"station":"blender"}, {"width":4,"depth":2} or {"reach":18}.'),
    requires: z.array(z.string()).default([]).describe('Upgrade ids that must be owned first.'),
  },
}, async (args) => text(await call('POST', '/content/upgrade', args)));

server.registerTool('create_recipe', {
  title: 'Create or update a recipe',
  description:
    'Teach an appliance to turn ingredients into something worth more than the sum of its parts, or update an existing recipe by reusing its id. Live in the running shop within about a second.\n\n'
    + 'The `station` is named, not hardcoded, so a recipe written today works on an appliance added next month — it just has to match the `payload.station` of a station upgrade (list_content upgrade to see which exist). '
    + 'A player tips ingredients into the appliance and the chef, or they themselves, take the finished goods out.\n\n'
    + 'The output item must already exist, and it earns its price from ITS OWN tags — so tag a crafted item for what it is (a smoothie is beverage + healthy), not for what went into it. '
    + 'Run simulate afterwards: the balance bot does not work appliances, so crafted goods show up under deadStock there and have to be judged in the live shop instead.',
  inputSchema: {
    id: z.string().describe('lowercase-kebab-case unique id, e.g. "berry-smoothie".'),
    name: z.string().describe('Display name, shown in the appliance menu.'),
    station: z.string().describe('Which appliance makes it, e.g. "blender". Must match a station upgrade payload.'),
    inputs: z.array(z.object({
      item_id: z.string(),
      qty: z.number().int().min(1).max(20).default(1),
    })).min(1).max(4).describe('Ingredients consumed per batch. Every item_id must already exist.'),
    output_id: z.string().describe('Item id produced. Must already exist — create_item it first.'),
    output_qty: z.number().int().min(1).max(20).default(1),
    minutes: z.number().min(0.1).max(120).default(1).describe('In-game minutes per batch.'),
  },
}, async (args) => text(await call('POST', '/content/recipe', args)));

server.registerTool('delete_content', {
  title: 'Delete content',
  description: 'Remove an item, crop, archetype, event, upgrade or recipe from the live game. Deleting an item also deletes crops that produce it.',
  inputSchema: {
    kind: z.enum(['item', 'crop', 'archetype', 'event', 'upgrade', 'recipe', 'fixture', 'worker', 'pastime']),
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

server.registerTool('set_reputation', {
  title: 'Set standing in the town',
  description:
    'Set reputation directly, 0..1. Reputation drives footfall via `pull`, which floors at 0.08 and recovers at only +0.004 per sale — '
    + 'so a shop knocked to the floor gets a trickle of customers however well it is stocked, and cannot earn its way back out. '
    + 'Use this to undo damage a bug did; `reset_economy` also fixes it but takes the day and the cash with it.',
  inputSchema: {
    set: z.number().min(0).max(1).describe('0 = nobody has heard of you, 1 = the best shop in town. 0.5 is a fresh start.'),
  },
}, async (args) => text(await call('POST', '/reputation', args)));

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

server.registerTool('reset_economy', {
  title: 'Start the money over',
  description:
    'Put day, cash, season and reputation back to a fresh start on the shop that already exists. '
    + 'Upgrades, staff, fixtures, hand-placed positions, walls and shelf stock all survive — this resets what a run earned, not what it owns. '
    + 'Active modifiers are cleared, and customers mid-shop are sent home rather than left to pay old prices into a day-one till.\n\n'
    + 'Pass stock to refill every shelf and replant every plot on the way out, so day one opens full instead of wearing the last run\'s empty aisles.\n\n'
    + 'To also throw away upgrades, staff and fixtures, stop the server and run `npm run reset:economy -- --all --world=<id>` — that one is deliberately not available live.\n\n'
    + 'This is almost always what "my world is bust" wants, rather than delete_world: it puts the money back to day one and keeps the shop.',
  inputSchema: {
    stock: z.boolean().default(false).describe('Fill every shelf and plant every plot after resetting.'),
  },
}, async (args) => text(await call('POST', '/reset-economy', args)));

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
