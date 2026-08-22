#!/usr/bin/env node
/**
 * THE PLAYGROUND — MCP server for Sprocket & Stock.
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

import { START_TIERS, DEFAULT_TIER } from '../shared/start.js';
import { DIFFICULTIES, NEW_DIFFICULTY } from '../shared/difficulty.js';
import { JOBS } from '../shared/schemas.js';

/**
 * What each job actually does, for the tool description.
 *
 * Keyed off `JOBS` rather than written out beside it, and the enum below is
 * `JOBS` itself — because this file had a hand-copied list and it had gone stale
 * twice over. `merchandise` was missing from the prose entirely, which is
 * the shape of the problem: the enum is what validates, so a job absent from
 * this hand-copied list cannot be authored onto a worker through the only
 * surface content is supposed to go through — complete in the sim and
 * unreachable from here.
 *
 * A job with no line here still validates and simply goes undescribed, which is
 * the right way round: the sim decides what jobs exist, and this is a gloss.
 */
const JOB_HELP = {
  serve: 'man a till and take payment',
  restock: 'order wholesale to refill an empty shelf',
  unload: 'carry a pallet at the delivery bay onto shelves',
  shelve: 'put whatever is in hand onto a legal shelf',
  farm: 'work the beds — pick what is ripe, sow what is turned, turn what is rough',
  craft: 'load an appliance and collect what it made',
  tidy: 'crate up anything that has nowhere to go, and carry rubbish out to the skip',
  merchandise: 'take goods back OFF a shelf — clear a dead board, merge a split one',
};
const JOB_LINES = JOBS
  .map((j) => `  ${j.padEnd(12)}${JOB_HELP[j] ?? ''}`.trimEnd())
  .join('\n');

/**
 * The tiers, spelled out for whoever is reading the tool schema.
 *
 * Built from the table rather than written twice, for the reason every other
 * derived-not-matched thing in this codebase is: a description that has drifted
 * from the numbers is worse than none, because it is the only thing an agent
 * choosing a tier has to go on.
 */
const TIER_HELP = START_TIERS
  .map((t) => `"${t.id}" ${t.name}: $${t.cash}, ${t.fixtures.shelf} shelves, `
    + `${t.fixtures.freezer} freezer, ${t.fixtures.checkout} till, ${t.fixtures.plot} beds`)
  .join('. ');

/** ...and the same, derived the same way, for how hard the town is. */
const DIFFICULTY_HELP = DIFFICULTIES
  .map((d) => `"${d.id}" ${d.name}: a bad week settles at ${Math.round(d.repSettle * 100)}% `
    + `reputation, ${Math.round(d.pullFloor * 100)}% of the town comes anyway, `
    + `shoppers walk in at mood ${d.moodBase}`)
  .join('. ');

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
    tier: z.enum(START_TIERS.map((t) => t.id)).optional()
      .describe('How much shop it opens with — the money AND the size of the building, because the '
        + 'generator grows the shop until its contents fit, so fewer shelves is a shorter walk. '
        + `Defaults to "${DEFAULT_TIER}". ${TIER_HELP}`),
    difficulty: z.enum(DIFFICULTIES.map((d) => d.id)).optional()
      .describe('How hard the town is on the shop — a separate axis from tier, which is only about '
        + 'how much shop you open with. It decides how far a neglected shop can slide and how much '
        + 'trade a shop nobody rates still gets. Creation-only: it is a fact about the save, like the '
        + `seed, and a shop that changed it halfway has a ledger that means nothing. Defaults to "${NEW_DIFFICULTY}". `
        + `NOTE for balance work: a world made before this existed reads as "relaxed", which carries the game's original `
        + `constants — so comparing a new world against an old one compares two difficulties. ${DIFFICULTY_HELP}`),
    cash: z.number().optional()
      .describe("Starting money, overriding the tier's. Clamped to 0–1,000,000."),
    shelves: z.number().optional()
      .describe("Shelf units the shop opens with, overriding the tier's. Clamped to 1–25. Set only at creation: "
        + 'the building is stamped the first time the world opens, and after that the shop is what is standing in it.'),
    plots: z.number().optional()
      .describe("Farm plots the shop opens with, overriding the tier's. Clamped to 1–32. Creation-only, same as shelves."),
  },
}, async (args) => text(await call('POST', '/worlds', args)));

server.registerTool('delete_world', {
  title: 'Delete a shop',
  description:
    'Permanently delete one save slot: its shop, its money, its upgrades, its staff and its world events. Content is untouched, because content belongs to every world.\n\n'
    + 'This cannot be undone and there is no backup. Confirm with the person you are working with before calling it — "my world is bust" usually means reset_economy, which keeps the shop you built. '
    + 'It will delete the last remaining world if you ask it to, leaving an empty menu that new_world starts again from.',
  inputSchema: {
    world: z.string().describe('World id from list_worlds. Exact — there is no fuzzy match on purpose.'),
  },
}, async ({ world }) => text(await call('DELETE', `/worlds/${encodeURIComponent(world)}`)));

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
    kind: z.enum(['item', 'crop', 'archetype', 'event', 'upgrade', 'recipe', 'fixture', 'worker', 'pastime', 'skin', 'vehicle', 'kit']).describe('Which kind of content to list.'),
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

/**
 * The two ways a thing can show that it is doing something. Shared by
 * `create_fixture` and `create_pastime`, because a part is a part — the flags
 * live on the model, not on the kind of content that happens to carry it.
 */
const MOTION_HELP =
  'MOTION makes a part move. `motion: {kind, hz, amount}` on any part, where kind is:\n'
  + '  spin   turns about its own Y axis. `hz` is turns a second; `amount` says nothing here.\n'
  + '  bob    rises and falls by `amount` tiles, `hz` times a second.\n'
  + '  shake  judders by `amount` tiles across the ground. A press, a fryer basket.\n'
  + '  pulse  swells and shrinks by `amount` of its own size. A lamp, an element, a heater.\n'
  + '  sweep  points AT the piece\'s `signal` instead of looping — a clock hand. See SIGNAL.\n'
  + 'A part that can be BUSY moves while it is busy — only an appliance can be busy today — and a part on anything else simply always moves, so a ceiling fan or a mobile turns by authoring one flag. '
  + 'Keep it small: at this camera an `amount` over about 0.08 reads as a fault rather than as a machine, and above about 4Hz anything bobbing is a blur.';

const SIGNAL_HELP =
  'SIGNAL makes the piece watch the SHOP rather than itself. `signal: "time"` is how far through the day it is (0 at midnight, 0.5 at noon); `signal: "open"` is 1 while the shop is actually serving and 0 otherwise. '
  + 'It replaces the 0..1 the tier ladder normally drives the art with, so put it on decorations and never on anything with a real ladder — a shelf with a signal stops showing which shelf you bought.\n'
  + 'Two things read it, and a piece may use both:\n'
  + '  stages  the whole look swaps. Two stages at `at: 0` and `at: 0.5` on `signal: "open"` is a sign that reads CLOSED and then OPEN. Order them the way the number runs, so stage 1 is the OFF one.\n'
  + '  sweep   a part turns to it. `motion: {kind: "sweep", turns, pivot}` where `turns` is whole turns over one run of the signal — on `time`, 2 is an hour hand and 24 is a minute hand, and both read twelve o\'clock at midnight with no offset. '
  + '`pivot` is the point it hinges on in model space, which a hand needs and a fan does not: leave it out and the part turns about its own middle, which on a hand is a compass needle. '
  + 'Turns are CLOCKWISE; make `turns` negative for a face watched from the other side, which is how a double-sided clock reads right from both.\n'
  + 'A sweep part must be FLAT, because the axis it turns about is the one it is thinnest on: a hand in an upright face is thin on z, so it swings in that face. '
  + 'Nothing in the sim reads any of this — it is a picture of the world, so it never needs `simulate`.';

const WORK_HELP =
  'WORK is what it looks like WHILE IT IS RUNNING — a second model, drawn over the piece only for as long as it is mid-batch, in the machine\'s own model space so a puff authored at the spout comes out of the spout. '
  + 'Its stages are driven by how far through the batch it is, NOT by tier: stage 1 is what has just gone in and the last stage is what is about to come out, so dough -> risen -> browned is three stages of one bake. '
  + '(The tier ladder already owns `model`\'s 0..1, which is why this is a model of its own rather than more parts on that one.) '
  + 'A part flagged `drift` in here rises, spreads and fades on a loop — that is steam — and a part with `motion` moves. '
  + 'Author it on a VARIANT to give one machine its own, or on the piece to cover every machine nobody has drawn a specific one for. '
  + 'It moves no number and no shopper reads it, so it never needs `simulate` — but a machine with none is a machine you cannot tell is on, which is the whole reason it exists.';

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
    + '  prop-ceiling  a decoration hanging from the ceiling, so indoors only\n'
    + '  floor         the ground itself — painted over an area, not placed on a tile\n'
    + '  paint         a finish for one SIDE of a wall — painted along a run, not on a cell\n'
    + '  road          the same, and the lane a van or a shopper\'s car would rather drive on\n'
    + '  path          pavement — the same again, for feet. A `stripes` design of one laid across a road is a crossing.\n'
    + '  bay/drop/break/park/paddock  the pads — ground that carries a job. Deliveries land, stock waits, staff rest, shoppers park, animals graze.\n\n'
    + 'GROUND is the odd one and the only kind with no `model`: it is not a thing standing in a cell, it IS the cell, so what you author is `surface` — a colour, an optional second colour and how they repeat. '
    + 'It is also the only kind priced PER TILE, and it is what makes a walled extension usable: walls decide what counts as indoors, floor decides what a shelf can stand on. Price it so paving a back room is a real decision — the shipped range is $6 to $22 a tile.\n\n'
    + 'Props never block: people walk past them. A barrel that stopped somebody would need to own its cell, and a cell can only say one thing at a time — so anything that must be walked around is a shelf, not a prop.\n\n'
    + 'Several pieces may name one kind, and that is the point: a second shelf design, a corner till, four different planters. They share the kind\'s rules and nothing else — each carries its own model, its own variants, its own tier ladder and its own price.\n\n'
    + 'TIERS are the progression. Tier 1 is what a newly built one already is, so it must cost 0. Every tier after it is something the player pays to step up to, in place, keeping its stock. The multipliers are what the upgrade is FOR — a tier that changes no numbers and no art is a button that takes money and does nothing:\n'
    + '  capacity_mult  how many units it holds (shelves, freezers)\n'
    + '  keeps_mult     how long goods last on it (freezers especially)\n'
    + '  speed_mult     how fast it works (appliances; on a plot, how fast crops grow; on a till, how fast a sale rings through)\n'
    + '  unattended     CHECKOUTS ONLY. What share of that speed it manages with nobody behind it. 0 (the default, and every till until one was authored otherwise) means the line waits for a person. Above 0 is self-service: the shopper rings themselves up at speed_mult x unattended, so 0.5 is a till that serves itself at half the speed somebody working it would manage.\n\n'
    + 'Give the model `stages` to make each tier look different — stage 1 is tier 1, the last stage is the top tier. '
    + 'Models are authored facing EAST (that is rotation 0, the side a shopper stands on), roughly one tile wide, sitting on y=0 upward. Keep the top below 1.1, which is wall height — anything taller stands over the building.\n\n'
    + 'A prop-ceiling piece is the exception: its origin IS the ceiling, so draw it DOWNWARD with negative y. A pendant is a cord at about y=-0.15, a shade at y=-0.36 and a bulb below that. Drawn upward it pushes through the roof and reads as a lamp floating outside the shop.\n\n'
    + 'A fixture that holds stock says WHERE it holds it: flag each part goods should stand on with `surface: true` and they are drawn on those boards, top row filling first. '
    + 'Leave it off and stock piles on top of the whole thing instead, which is what a counter wants. Face an open unit east so its rows are not drawn behind their own back panel.\n\n'
    + 'ANYTHING YOU PUT OVER A BOARD HAS TO CLEAR IT. Goods fill from the TOP board down, because on this camera each board hides the one below, so a canopy, header or chiller top sitting close over the top board is not a detail — it is where every unit of stock goes, and none of it can be seen. '
    + 'A shelf holding four loaves then draws four loaves and looks empty, which reads as stock that never arrived rather than as art. Leave each board the headroom its neighbours have (the shipped shelf pitch is 0.35) and raise the uprights and the glass with the lid, or it floats. '
    + 'A board covered by another BOARD is fine — that is shelving, and on an L the wings overlap at the corner. `npm run docs:fixtures` flags whatever fails, and the renderer moves stock off a covered board rather than drawing into it.\n\n'
    + 'A part can also carry `alpha` (0.05..1) to be glass — a freezer door you see the stock through, a window. Glass casts no shadow.\n\n'
    + 'VARIANTS are other shapes of the same piece — a corner unit, an endcap, a low one — and they are looks only. They carry a model and nothing else, because the numbers live on the shared tier ladder: '
    + 'a corner shelf costs and holds exactly what a straight one does, restyling something already built is free and keeps its stock, and no variant can move the balance. Tiers cost money and change numbers; variants are taste.\n\n'
    + 'EMITS makes it a lamp. The renderer honours it; nothing in the sim reads it, so a light is worth exactly what it looks like today. Only the eight nearest the camera get a real light — that cap is deliberate, so author lamps as fittings you would actually put in a room rather than as a way to floodlight one.\n\n'
    + 'COST is what one costs to put down. Leave it 0 on a shelf, freezer, till or plot and it stays priced by the upgrade that sells that kind, which is how the whole economy still works. A prop has no upgrade behind it, so a prop with no cost is free — price your decorations.\n\n'
    + `${WORK_HELP}\n\n`
    + `${MOTION_HELP}\n\n`
    + `${SIGNAL_HELP}\n\n`
    + STAGE_HELP,
  inputSchema: {
    id: z.string().describe('Slug, yours to choose, e.g. "terracotta-planter" or "chiller-shelf". Reuse one to update it.'),
    kind: z.enum(['shelf', 'freezer', 'warmer', 'checkout', 'station', 'plot', 'pen', 'bin', 'prop-floor', 'prop-ceiling', 'floor', 'road', 'path', 'bay', 'drop', 'break', 'park', 'paint'])
      .describe('Which build rules it plays by. Closed set — this is not a way to invent kinds.'),
    name: z.string().describe('Display name, e.g. "Shelving". This is what the build palette calls it.'),
    model: z.any().optional().describe('{parts:[...]} or {stages:[{name, at, parts:[...]}]}. Required for everything except GROUND (floor, road, bay, drop, break, park), which has no model. ' + STAGE_HELP),
    work: z.any().optional().describe('What it looks like while it is WORKING — same shape as `model`, staged by how far through a batch it is rather than by tier. Appliances only, for now: nothing else in the game can be busy. ' + WORK_HELP),
    body: z.any().optional().describe('PENS ONLY. The ANIMAL — a body that walks around the paddock, rather than a part of the shed it came out of. Same shape as `model` but with NO stages: one pen draws as many copies of this as its `heads` allows, each ambling somewhere different, so there is no 0..1 to spend on it. Author it in ONE TILE standing at the origin, NOSE EAST like every other piece of art here — the renderer turns it to face where it is walking. Draw the shelter in `model` and the creature in here; a shed with a cow painted on it is a photograph of a farm. Leave it out for a piece whose animal is not worth drawing loose — a beehive is the whole picture, and bees on the grass are not. It moves no number: heads come off the paddock and the rung whether or not anybody has drawn one.'),
    surface: z.object({
      color: z.string().describe('#rrggbb. The main colour of the floor.'),
      accent: z.string().optional().describe('#rrggbb, the second colour of the pattern. Left out it is a darker shade of the first, which is usually what you want.'),
      bars: z.number().int().min(1).max(8).optional()
        .describe('STRIPES ONLY: how many bars a cell is painted with (default 3). The gaps are always the same width as the bars, so this one number is the whole marking: 2 is a wide continental crossing, 5 is a hatched box junction.'),
      pattern: z.enum(['plain', 'checker', 'planks', 'stripes', 'tufts', 'brick', 'tiles']).default('plain')
        .describe('How the two colours repeat, tile by tile. "plain" uses only the first. "stripes" is bands one cell wide running along z — that is a pedestrian crossing, and it is the one pattern whose direction means something, so the same design laid east-west and north-south reads as bars across your way or rails along it. Three of these are not a per-cell colour at all but real geometry laid over the cell, because a cell is about a metre and a half and nothing flat and finer than that survives a 45° camera: "stripes" (bars), "tufts" (blades of grass, GROUND only — it is what makes a lawn) and "brick"/"tiles" (courses stood proud of the face — brick is long and half-bonded, tiles are square and stacked with a finer joint; PAINT mostly, and in both, colour is the brick and accent is the mortar the flat of the wall takes).'),
    }).optional().describe('GROUND AND PAINT ONLY, and required for one. PAINT is the same authoring shape stood up: a finish for one SIDE of a wall, priced per face, and the two sides of a wall are two decisions the player makes separately. It changes nothing but the picture \u2014 no shopper, no path and no tile reads it \u2014 so a new shade is a row and never a balance run. Ground is a colour and a repeat — there is no geometry, because it is seen edge-on at 45° with a shop standing on it and nothing finer than a tile survives that. The four PADS carry a job, and how big you paint one is how much it holds: `bay` is where wholesale orders land as pallets, `drop` is where hands are cleared and stock waits, `break` seats one resting worker per cell, and `park` parks one shopper\'s car per cell. `floor` and `road` carry none — they are only a look. A road is a PREFERENCE and never a permission: every outdoor cell is drivable already, so what a painted one changes is which lane the van and the cars choose, which means you can draw the drive rather than watch a lorry cross your lawn.'),
    yields: z.object({
      cash: z.number().min(0).max(500).describe('How much money one payout is.'),
      every: z.number().min(1).max(1440).default(60).describe('In-game MINUTES between payouts. A day is 24x60 of these.'),
    }).optional().describe('Makes this piece EARN. It pays into a pile of cash on the floor that somebody has to walk over and collect \u2014 the same entity a till drops, so it renders, is picked up and is tidied away by code that already exists. Money you have to fetch is a decision; money that appears in the bank is a trickle nobody sees. Run `simulate` after authoring one: this is the only field on a fixture that prints money.'),
    produces: z.object({
      item_id: z.string().describe('Which existing item one batch is made of. Create the item first.'),
      qty: z.number().int().min(1).max(64).default(1).describe('How much one batch is.'),
      every: z.number().min(1).max(1440).default(60).describe('In-game MINUTES a batch takes. A day is 24x60 of these.'),
    }).optional().describe('PENS ONLY, and required for one — a pen with no `produces` is a hutch with nothing in it. Makes this piece produce GOODS on its own clock, with no sowing and no seed: what you pay is the price of the pen. They stand in the pen until somebody collects them from its gate. The tier ladder is what makes a rung worth buying: `speed_mult` shortens the wait and `capacity_mult` is how many batches it will stockpile before it stalls, so tier 1 holds exactly one batch and then stops, and `heads` is how many animals it keeps. Nothing else reads this field.'),
    charm: z.number().min(0).max(20).optional()
      .describe('How much nicer this makes the shop look, which is how far word of it travels. It raises CATCHMENT \u2014 how much of the town is within reach at all \u2014 rather than reputation, because reputation is what the people who already came in think of you. Saturating: about half the maximum at 10 total charm across the whole shop, so a room full of pot plants is worth about as much as one nice centrepiece. 1 is a pleasant pot plant, 5 is a centrepiece.'),
    open: z.boolean().optional()
      .describe('Can you walk all the way round it? A shelf-like unit (shelf, freezer, appliance) is always workable from its FRONT and both ENDS — that is the kind, not the piece. This says this particular design has no back panel either, so all four sides work: true for a display table or an island unit, false (the default) for anything with a solid back. Reach and the working-spot markers only — where the generator reserves a spot, where a tap walks you and where one may be built are all unchanged. It is the one field on a piece that is not a look: a unit two people can work at once changes how the shop flows, so run `simulate` after setting it.'),
    signal: z.enum(['time', 'open']).optional()
      .describe('Makes this piece watch the shop: "time" is how far through the day it is, "open" is whether it is serving. It REPLACES the tier ladder as what drives the art, so it belongs on decorations only. Drives `stages` (the look swaps) and any part flagged `motion: {kind: "sweep"}` (the part turns to it). ' + SIGNAL_HELP),
    variants: z.any().optional().describe('Optional other shapes of this kind: [{id, name, model, work}]. Looks only — no costs, no multipliers, and the kind\'s own model is always offered alongside them as "Standard". `work` is optional and falls back to the piece\'s, which is how one generic "steam and a light" covers every appliance nobody has drawn a specific one for.'),
    tiers: z.array(z.object({
      name: z.string().describe('What this rung is called, e.g. "Chilled" or "Deep Freeze".'),
      cost: z.number().min(0).describe('What stepping up to it costs. Tier 1 must be 0.'),
      capacity_mult: z.number().min(0.1).max(10).default(1),
      keeps_mult: z.number().min(0.1).max(20).default(1),
      speed_mult: z.number().min(0.1).max(10).default(1),
      unattended: z.number().min(0).max(1).default(0)
        .describe('Checkouts only. What share of its speed it manages with nobody behind it. 0 = needs a person, which is every till until now; 0.5 = serves itself at half the speed a clerk would.'),
      heads: z.number().int().min(1).max(24).default(1)
        .describe('PENS ONLY. The most animals this rung will keep, however much grazing the player paints around it. The PADDOCK is the supply and this is the ceiling, and you need both: a field alone is one brush stroke buying an unbounded speed-up, and a rung alone is a number with no land behind it. Small animals crowd in and big ones do not \u2014 a hen house keeps 3, a cattle pen keeps 2. Give tier 1 at LEAST 2, or a paddock can never help that pen and the brush reads as broken. Defaults to 1, which is a pen that keeps the one animal pens have always kept.'),
    })).min(1).max(6).describe('Lowest rung first. Tier 1 is what a new one already is.'),
    cost: z.number().min(0).optional()
      .describe('What one costs to build — per TILE for ground (floor, bay, drop, break). 0 (the default) means "priced by the upgrade that sells this kind" — right for fixtures, free for props and for ground, neither of which has an upgrade behind it.'),
    emits: z.object({
      color: z.string().describe('#rrggbb. Warm for a bulb, cold for a chiller light.'),
      intensity: z.number().min(0).max(4).default(1).describe('Brightness. 1 is a room fitting; above 2 washes an aisle out.'),
      range: z.number().min(0.5).max(12).default(4).describe('How far the glow carries, in tiles.'),
    }).optional().describe('Makes this piece a lamp. Renderer-only — no shopper behaves differently under it yet.'),
    sfx: z.object({
      loop: z.string().optional().describe('A noise it holds open. On something that can be BUSY (an appliance) it runs only while it is working; on anything else it runs always, which is what a fridge does.'),
      use: z.string().optional().describe('When somebody works it.'),
      done: z.string().optional().describe('When a batch finishes.'),
    }).optional().describe('What it SOUNDS like — `emits` for the other sense. Each field names a sound the game ships, exactly as `model` names shapes the renderer knows: today "machine" (an appliance running) and "hum" (a fridge), beside the one-shots — click, confirm, error, milestone, pickup, putdown, crate, coins, harvest, sale, annoyed, angry, beep, upgrade, downgrade, place, remove, robot. An id that names nothing is SILENCE, and silence is indistinguishable from a piece meant to be quiet, so check the spelling — nothing renders it and nothing logs it. Four loops play at once, nearest you first, and each is mixed far below the one-shots on purpose: a sound you hear once and a sound that is on while you stand there are not the same kind of loud.'),
    sort: z.number().min(-99).max(99).optional()
      .describe('Where it sits on the build bar — HIGHER FLOATS TO THE FRONT, and 0 (the default) means "wherever the catalogue put you". The order is otherwise the order rows were authored in, which is nobody\'s decision, and only the first nine entries of a tab wear a number key — so rank the piece a player reaches for nine times in ten above the ones they will buy once. 1 is where the palette\'s own eraser sits (Bare Ground, Bare Wall), so 2 or more is "ahead of the eraser" and 0 is "in with everything else". Purely an ordering on the bar: it moves no number and never needs `simulate`.'),
    tags: z.array(z.string()).optional()
      .describe('Call list_tags first. On a DECORATION these file it on the Decoration tab of the build bar, which is the one thing its kind cannot say — `prop-floor` and `prop-ceiling` describe how a thing attaches, and a planter and a barrel attach identically. `plant` puts it under Greenery, `lamp` under Lighting, `sign` under Signs, and anything else (or nothing) lands in Odds and ends. Those tabs only appear once there are more decorations than fit the number keys, so tag every one you author and the palette sorts itself out the day it needs to. On everything else nothing reads them yet.'),
  },
}, async (args) => text(await call('POST', '/content/fixture', args)));

server.registerTool('create_worker', {
  title: 'Design a kind of worker',
  description:
    'Create or update a kind of worker the player can hire — what they look like, what they cost, and what they are willing to do. Live in the running shop within about a second.\n\n'
    + 'JOBS are the whole point. A worker is not a role with a hardcoded program; it is a list of jobs with weights, and one generic brain draws from that list. The job names are fixed, because each one is a routine in the sim — anything else is a worker who stands still:\n'
    + `${JOB_LINES}\n\n`
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
      job: z.enum(JOBS),
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
    + `${MOTION_HELP}\n\n`
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

server.registerTool('create_skin', {
  title: 'Design a look a hire can wear',
  description:
    'Create or update a skin — what ONE hire looks like, worn over whatever kind of worker they are. Live in the running shop within about a second, including on the staff already on shift.\n\n'
    + 'A skin is a PALETTE, not a body. This is the important thing about it and the reason it is not a fixture-style variant: one skin row works on every kind of worker that exists and every kind anybody adds later, so "Rust Bucket" is authored once rather than once per kind. It also means no skin can ever redraw a bot into something that reads as a customer, which is what staff art exists to prevent.\n\n'
    + 'SLOTS are the colours. A worker model flags each part with a `tint` naming one of three slots, and this is what fills them:\n'
    + '  chassis  the main body\n'
    + '  trim     panels, limbs, the base\n'
    + '  glow     the visor and any lights\n'
    + 'Every slot is optional. A skin that sets only `glow` changes the visor and leaves the bot otherwise as drawn — the cheapest way to tell two of the same kind apart.\n\n'
    + 'A part that names NO slot is untouchable, and that is where the job payload lives. A clerk\'s till and a chef\'s pan keep their own colours under every skin in the game, which is what keeps "which bot is that" answerable after you have recoloured all five.\n\n'
    + 'EXTRAS are parts bolted ON — a hat, an antenna, a scarf. They are added to the body and can never replace or remove any of it, so the silhouette always survives. An extra may name a `tint` itself, so a hat can come out in the skin\'s own trim colour without authoring the hex twice. A worker stands about 0.9 tall on y=0 facing EAST, so y above 0.95 is hat territory.\n\n'
    + 'A skin is free to wear, free to change and moves no number — there is nowhere on it to put one. So it never needs `simulate` re-run, which is exactly the same split a fixture makes between its variants and its tiers.',
  inputSchema: {
    id: z.string().describe('Slug, e.g. "rust-bucket".'),
    name: z.string().describe('Display name, e.g. "Rust Bucket". Max 32 chars — it goes in a menu.'),
    slots: z.object({
      chassis: z.string().optional().describe('Main body colour, #rrggbb.'),
      trim: z.string().optional().describe('Panels, limbs and base, #rrggbb.'),
      glow: z.string().optional().describe('Visor and lights, #rrggbb.'),
    }).optional().describe('Which tint slots this skin fills. All optional — an unset slot keeps the authored colour.'),
    extras: z.array(z.any()).max(4).optional().describe(
      'Cosmetic parts bolted onto the body, e.g. [{shape:"cone", color:"#c94f3d", pos:[0,1.02,0], scale:[0.18,0.16,0.18]}]. '
      + 'Added, never swapped in, so the base silhouette always survives. May carry `tint` to take a slot colour.',
    ),
    tags: z.array(z.string()).optional().describe('For events to aim at. Never aim at an id.'),
  },
}, async (args) => text(await call('POST', '/content/skin', args)));

server.registerTool('create_vehicle', {
  title: 'Design something that drives',
  description:
    'Create or update a vehicle — the van that brings wholesale orders in, or a car a customer arrives in. Live in the running shop within about a second.\n\n'
    + 'A vehicle is authored exactly the way a worker is, and for the same reason: it is a thing you LOOK at, and everything in this game you look at is a row somebody can draw. Nothing about a van is hardcoded anywhere.\n\n'
    + 'USE says which part of the game owns it, and it is a closed set because each entry is a routine somebody had to write — a `use` nobody implemented is a van that never drives anywhere:\n'
    + '  delivery  brings a wholesale run in from the edge of the map and unloads it at the bay\n'
    + '  customer  a shopper drove; it sits in the car park while they shop, and they take a bigger basket home\n\n'
    + 'CAPACITY IS THE ONLY NUMBER THE SIM READS, in crates. It is therefore the only field that can move the balance and the only reason to run `simulate` after authoring one — a delivery run cannot bring more than this, and a driver takes home this much more than somebody on foot. Speed and the model are worth exactly what they look like.\n\n'
    + 'MODEL is staged by HOW LOADED IT IS: the 0..1 that picks between stages is what fraction of `capacity` is on board, so an empty bed, a couple of crates and a full load is authored art and no code in the game knows what a crate looks like. A car has nothing to fill, so give it plain `parts`.\n\n'
    + 'Author it NOSE EAST, length along x, sitting on y=0 upward — about 1.5 tiles long, 0.7 wide and under 0.8 tall for a van, smaller for a car. Wheels are the one thing to watch: `rot` is Y-axis only, so a cylinder cannot be laid on its side. Use a sphere squashed on z (scale like [0.3, 0.3, 0.14]) and it reads as a wheel from this camera.\n\n'
    + 'There is no tier ladder, on purpose. A bigger van is a SECOND VEHICLE with its own art, not a rung on this one — that way the upgrade is something you can see you bought, and capacity has exactly one spelling instead of living on both the row and the rung.\n\n'
    + 'Models are capped at 8 parts per stage, which is tight for something this shape. Four wheels, a cab and a bed is seven; spend the last one on the load.\n\n'
    + STAGE_HELP,
  inputSchema: {
    id: z.string().describe('Slug, e.g. "box-lorry". Reuse one to update it.'),
    name: z.string().describe('Display name, e.g. "Box lorry".'),
    use: z.enum(['delivery', 'customer']).describe('Which code owns it. Closed set — this is not a way to invent uses.'),
    model: z.any().describe('{parts:[...]} or {stages:[{name, at, parts:[...]}]}. For a delivery vehicle the 0..1 driving the stages is how full it is. ' + STAGE_HELP),
    speed: z.number().min(0.1).max(20).optional().describe('Tiles per second along its route. Cosmetic — when an order lands is decided by the run it joined, not by how fast the art got there. 3.2 is a van, 2.6 is a worker on foot.'),
    capacity: z.number().int().min(1).max(40).describe('How many crates it carries. THE one number with consequences — run `simulate` after changing it.'),
    color: z.string().optional().describe('Bodywork, #rrggbb, where the model does not say otherwise.'),
    tags: z.array(z.string()).optional().describe('Call list_tags first. Events aim at tags, never at a vehicle id.'),
  },
}, async (args) => text(await call('POST', '/content/vehicle', args)));

server.registerTool('create_kit', {
  title: 'Design something somebody carries',
  description:
    'Create or update a kit — a prop a shopper has on them. A paper bag they walk out with, a basket they fill as they go, a trolley, a thief\'s swag sack. Live in the running shop within about a second.\n\n'
    + 'A KIT IS AN OBJECT, NOT AN ACTIVITY, and that is the line between this and `create_pastime`. A pastime has a clock, a spot to stand and an amount of energy it puts back; the prop is a detail of it. A kit has none of those — it is only the thing in their hands. If what you are authoring has a duration, it is a pastime.\n\n'
    + 'IT REPLACES THE LOOSE ARMFUL. Without a kit a shopper carries their shopping as individual little models at chest height, which is right while they are choosing — "they picked up a cheese" is worth seeing — and wrong once they have paid, when it is five jars floating in front of every customer heading for the door. Author no kits and the game looks exactly as it did.\n\n'
    + 'USE says the moment it is carried in, and it is a closed set because each entry is a moment the sim knows it is in and can hand a fullness to:\n'
    + '  shopping  in the shop, filling a basket\n'
    + '  leaving   paid, on the way out with what they bought\n\n'
    + 'TAGS ARE WHO GETS IT, matched against the archetype\'s own `tags` — never an archetype id. Leave them off and anybody may carry it. Two rows for the same `use` are drawn between by `weight`, so a shop can have a mix of carrier bags.\n\n'
    + 'MOVES NO NUMBER. A kit is a look: it changes nothing about how much somebody buys, how fast they shop or what they will pay, so there is never a reason to run `simulate` after authoring one. If you want a trolley that makes people buy MORE, that is a mechanic and it needs code — say so rather than authoring a big model and hoping.\n\n'
    + 'MODEL is staged by HOW FULL IT IS: the 0..1 that picks between stages is how much is in it, so a bag that starts flat and bulges, or a basket that fills up, is authored art and no code knows what a bag is.\n\n'
    + 'Author it HANGING WHERE A HAND IS, in the person\'s own space: they are about 0.68 across and 0.8 tall, so a bag sits around y 0.2–0.5 and about x 0.26 out to one side. Keep it under about 0.35 across or it reads as luggage. Front is +z.\n\n'
    + STAGE_HELP,
  inputSchema: {
    id: z.string().describe('Slug, e.g. "paper-bag". Reuse one to update it.'),
    name: z.string().describe('Display name, e.g. "Paper bag".'),
    use: z.enum(['shopping', 'leaving']).describe('The moment it is carried in. Closed set — this is not a way to invent moments.'),
    model: z.any().describe('{parts:[...]} or {stages:[{name, at, parts:[...]}]}. The 0..1 driving the stages is how full it is. ' + STAGE_HELP),
    tags: z.array(z.string()).optional().describe('Which shoppers get it, matched against the archetype\'s tags. Omit for anyone. Never an archetype id.'),
    weight: z.number().min(0).max(100).optional().describe('Relative likelihood against other kits for the same `use`. 0 retires a row without deleting it.'),
  },
}, async (args) => text(await call('POST', '/content/kit', args)));

server.registerTool('set_worker_skin', {
  title: 'Put a look on one hire',
  description:
    'Dress one member of staff in a skin, or strip them back to the colours their kind was drawn in.\n\n'
    + 'Free, instant and reversible — a skin costs nothing and moves no number, so this is not a purchase and never needs `simulate` re-run. Get worker ids from get_state; skin ids from list_content with kind "skin".\n\n'
    + 'Omit `skin` (or pass null) to take the current one off. That is a real argument rather than a missing one: it is how a bot gets back to factory colours without needing a "default" skin row that somebody could delete.',
  inputSchema: {
    workerId: z.string().describe('Roster id of the hire, e.g. "w3". From get_state.'),
    skin: z.string().nullable().optional().describe('Skin id to put on them, or null/omitted to take it off.'),
  },
}, async (args) => text(await call('POST', '/worker/skin', args)));

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
    + 'hours buys a licence to trade outside the usual 08:00-20:00 (payload {"open":0,"close":24}); the widest window you own wins, and the night still '
    + 'runs at 6x whatever you hold, so what a licence buys is a thin overnight trickle rather than a longer real-time day.\n\n'
    + 'Note that shelf/freezer/plot/checkout upgrades also set the per-unit price in build mode, where the player buys and places one fixture at a time: '
    + 'a cheaper bundle makes single fixtures cheaper to build and cheaper to sell back.',
  inputSchema: {
    id: z.string(),
    name: z.string(),
    description: z.string().default(''),
    cost: z.number().min(0),
    // Kept in step with `UpgradeSchema` — a kind the schema accepts and this
    // enum does not is a kind you cannot author through the tool that exists to
    // author it, and the refusal names zod rather than the gap.
    kind: z.enum(['shelf', 'freezer', 'warmer', 'plot', 'checkout', 'floor', 'capacity', 'speed', 'decor', 'staff', 'station', 'space', 'catchment', 'hours']),
    payload: z.record(z.string(), z.any()).default({}).describe('Knobs for that kind, e.g. {"plots":4}, {"speedMult":1.3}, {"station":"blender"}, {"width":4,"depth":2}, {"reach":18} or {"open":0,"close":24}.'),
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
    kind: z.enum(['item', 'crop', 'archetype', 'event', 'upgrade', 'recipe', 'fixture', 'worker', 'pastime', 'skin', 'vehicle', 'kit']),
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
    hour: z.number().min(0).max(23.9).optional().describe('Hour of day. Business hours are 08:00-20:00.'),
    skipDays: z.number().int().min(1).max(60).optional().describe('Jump this many days forward, running end-of-day for each.'),
  },
}, async (args) => text(await call('POST', '/time', args)));

server.registerTool('set_shop', {
  title: 'Open, shut or pause the shop',
  description:
    'Raise or drop the shutters, and stop or start time. Business hours are still 08:00-20:00 — the shutters can only shut you EARLIER, never later, so a shop with its shutters up serves nobody at 03:00. '
    + 'A brand-new world starts shut, so if you spawn customers into one or screenshot it and nothing is happening, this is why. '
    + 'Pausing freezes the whole world (nobody moves, nothing grows, no van arrives) and is not saved.',
  inputSchema: {
    open: z.boolean().optional().describe('true raises the shutters, false drops them. Shoppers already in the queue are served; everyone else settles up and leaves.'),
    paused: z.boolean().optional().describe('true stops time dead, false starts it again.'),
  },
}, async (args) => text(await call('POST', '/shop', args)));

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
  title: 'Run the world director now',
  description:
    'Force the world director to decide what happens in town, instead of waiting for the next in-game day. '
    + 'There is no model behind this: it invents an event from the season and the tags the shop actually '
    + 'carries, and draws an authored `events` row about a quarter of the time.',
  inputSchema: {},
}, async () => text(await call('POST', '/director/run', {})));

server.registerTool('get_director_context', {
  title: 'See the shop as the director sees it',
  description:
    'Return a one-screen summary of the shop as it stands — day, season, cash, reputation, what is on the '
    + 'shelves, what is selling, which tags are in play. Read it before authoring an event for this shop by hand.',
  inputSchema: {},
}, async () => text(await call('GET', '/director/context')));

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[sprout-and-stock mcp] connected, talking to ${API}`);
