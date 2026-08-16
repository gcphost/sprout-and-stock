/**
 * HTTP CONTROL API — the playground's back door.
 *
 * The MCP server is a thin wrapper over these routes, which means:
 *   - MCP works from another machine over the tunnel with no extra plumbing,
 *   - you can drive the game with `curl` when you're debugging MCP itself,
 *   - and there's exactly one place where "things that can change the game"
 *     is defined and guarded.
 *
 * Set SNS_TOKEN to require `Authorization: Bearer <token>` on every /api route.
 * Do that before exposing the tunnel publicly.
 */

import express from 'express';
import { primaryRoom, rooms } from './rooms/MartRoom.js';
import { content, writeContent, refresh } from './content.js';
import { simulate } from './sim/simulate.js';
import { remove, addModifier, clearModifiers, activeModifiers } from './db.js';
import { TAG_GROUPS, ALL_TAGS } from '../shared/tags.js';
import { runDirector, describeWorld } from './director.js';
import { OPEN_HOUR } from './sim/index.js';
import {
  listWorlds, getWorldSummary, createWorld, deleteWorld, renameWorld, pinWorld,
  resolveWorldId, roomForWorld, focusedWorldId, setFocus, sweepWorlds,
} from './worlds.js';

const KINDS = {
  item: 'items', crop: 'crops', archetype: 'archetypes',
  event: 'events', upgrade: 'upgrades', recipe: 'recipes', fixture: 'fixtures',
  worker: 'workers',
  pastime: 'pastimes',
};

/**
 * Routes a *player* needs, as opposed to routes an agent needs.
 *
 * `SNS_TOKEN` exists to stop a public tunnel handing strangers the content
 * database. It was never meant to stop the game loading, and once the menu
 * lives behind an HTTP call, gating all of /api means nobody can pick a world
 * on a tunnel you secured — the game simply never starts.
 *
 * So: reading the world list, making a world, and posting a screenshot back are
 * open. Deleting, renaming, pinning and everything that edits content or pokes
 * the sim still needs the token. Anyone who can join can already bulldoze the
 * shop from inside it; nobody who can join should be able to delete it whole.
 */
const OPEN_ROUTES = [
  ['GET', '/worlds'],
  ['POST', '/worlds'],
  ['POST', '/screenshot/upload'],
];

const isOpenRoute = (req) => OPEN_ROUTES.some(([m, p]) => req.method === m && req.path === p);

export function createApi() {
  const api = express.Router();
  api.use(express.json({ limit: '2mb' }));

  // ---- auth -------------------------------------------------------------
  api.use((req, res, next) => {
    const token = process.env.SNS_TOKEN;
    if (!token) return next();
    if (isOpenRoute(req)) return next();
    const header = req.get('authorization') ?? '';
    if (header === `Bearer ${token}`) return next();
    res.status(401).json({ ok: false, error: 'bad or missing token' });
  });

  /**
   * The live game a request is about, starting its world if nobody has it open.
   *
   * Which world: `world` in the body or query if the caller named one, then the
   * `use_world` pointer, then the busiest room, then the last one played. That
   * order means an agent that never heard of save slots behaves exactly as it
   * did when there was only one.
   *
   * Acting on a world OPENS it — a room boots headless and the sim starts
   * running. That is deliberate and it is what makes "my world is bust, reset
   * it" fixable without a browser tab open. The idle timer closes it again a
   * few minutes later.
   */
  const gameFor = async (req) => {
    const asked = req.body?.world ?? req.query?.world ?? null;
    const worldId = resolveWorldId(asked ? String(asked) : null);
    if (!worldId) throw new HttpError(503, 'there are no worlds — create one first');
    const room = await roomForWorld(worldId);
    return room.game;
  };

  // ---- read -------------------------------------------------------------

  api.get('/health', (req, res) => {
    const room = primaryRoom();
    res.json({
      ok: true,
      room: room?.roomId ?? null,
      players: room ? Object.keys(room.game.players).length : 0,
      contentVersion: content().version,
      world: resolveWorldId(null),
      focused: focusedWorldId(),
      worlds: listWorlds().length,
    });
  });

  // ---- save slots --------------------------------------------------------

  api.get('/worlds', wrap((req, res) => {
    res.json({ ok: true, focused: focusedWorldId(), worlds: listWorlds() });
  }));

  // `cash`, `shelves` and `plots` are starting state, and the last two can only
  // be set here — see `createWorld`. Blank or absent means the default; out of
  // range is clamped, not refused.
  api.post('/worlds', wrap((req, res) => {
    res.json({
      ok: true,
      world: createWorld({
        name: req.body?.name,
        seed: req.body?.seed,
        cash: req.body?.cash,
        shelves: req.body?.shelves,
        plots: req.body?.plots,
      }),
    });
  }));

  api.delete('/worlds/:id', wrapAsync(async (req, res) => {
    const result = await deleteWorld(req.params.id);
    if (!result.ok) throw new HttpError(409, result.error);
    res.json(result);
  }));

  api.patch('/worlds/:id', wrap((req, res) => {
    let world = getWorldSummary(req.params.id);
    if (!world) throw new HttpError(404, `no world "${req.params.id}"`);
    if (req.body?.name !== undefined) world = renameWorld(req.params.id, req.body.name) ?? world;
    if (req.body?.pinned !== undefined) world = pinWorld(req.params.id, !!req.body.pinned);
    res.json({ ok: true, world });
  }));

  api.post('/worlds/sweep', wrap((req, res) => {
    res.json({ ok: true, ...sweepWorlds({ ttlDays: req.body?.ttlDays }) });
  }));

  // Which world an agent's later calls mean, when they don't say. Shared across
  // everyone talking to this server — see `focusedWorldId`.
  api.post('/focus', wrap((req, res) => {
    const id = req.body?.world ?? null;
    if (id === null) {
      setFocus(null);
      return res.json({ ok: true, focused: null, world: resolveWorldId(null) });
    }
    if (!setFocus(String(id))) throw new HttpError(404, `no world "${id}"`);
    res.json({ ok: true, focused: String(id), world: getWorldSummary(String(id)) });
  }));

  api.get('/state', wrapAsync(async (req, res) => {
    const g = await gameFor(req);
    res.json({
      ok: true,
      ...g.snapshot(),
      // Which shop this is. On every response that touches a world, because the
      // `use_world` pointer is shared between everyone driving this server —
      // your agent can be pointed somewhere by mine, and a reply that doesn't
      // name the world it acted on makes that invisible.
      world: g.worldId,
      seed: g.seed,
      ownedUpgrades: g.ownedUpgrades,
      layout: {
        version: g.layoutVersion,
        store: g.layout.store,
        shelfCount: g.layout.shelves.length,
        plotCount: g.layout.plotCount ?? g.layout.plots.length,
        checkoutCount: g.layout.checkouts.length,
        // What the player has positioned by hand, vs what the generator laid
        // out. Without this an agent can see the shop but not why it's shaped
        // the way it is.
        placements: g.placements,
        buildCosts: g.buildCosts(),
        grow: g.grow,
        doorShift: g.doorShift,
      },
    });
  }));

  api.get('/tags', (req, res) => {
    res.json({ ok: true, groups: TAG_GROUPS, all: ALL_TAGS });
  });

  api.get('/content/:kind', wrap((req, res) => {
    const table = KINDS[req.params.kind];
    if (!table) throw new HttpError(400, `unknown kind "${req.params.kind}"`);
    res.json({ ok: true, kind: req.params.kind, rows: content()[table] });
  }));

  api.get('/log', wrapAsync(async (req, res) => {
    const g = await gameFor(req);
    res.json({ ok: true, world: g.worldId, log: g.log.slice(-Number(req.query.n ?? 30)) });
  }));

  api.get('/modifiers', wrapAsync(async (req, res) => {
    const g = await gameFor(req);
    res.json({ ok: true, world: g.worldId, day: g.day, modifiers: activeModifiers(g.day, g.worldId) });
  }));

  // ---- content writes ----------------------------------------------------

  api.post('/content/:kind', wrap((req, res) => {
    const kind = req.params.kind;
    if (!KINDS[kind]) throw new HttpError(400, `unknown kind "${kind}"`);
    const result = writeContent(kind, req.body, req.get('x-author') ?? 'agent');
    if (!result.ok) return res.status(422).json(result);
    // Nudge the live room so the change lands this tick rather than next poll.
    refresh();
    res.json(result);
  }));

  api.delete('/content/:kind/:id', wrap((req, res) => {
    const table = KINDS[req.params.kind];
    if (!table) throw new HttpError(400, `unknown kind "${req.params.kind}"`);
    const gone = remove(table, req.params.id);
    refresh();
    res.json({ ok: gone, removed: gone ? req.params.id : null });
  }));

  // ---- playground controls ----------------------------------------------

  // Deliberately does NOT open a room: a balance run copies a save, it doesn't
  // play it. Starting the world to measure it would have the sim ticking
  // underneath the copy, which is the one thing an ephemeral run is for.
  api.post('/simulate', wrap((req, res) => {
    const worldId = resolveWorldId(req.body?.world ? String(req.body.world) : null);
    if (!worldId) throw new HttpError(503, 'there are no worlds — create one first');
    res.json(simulate({ ...(req.body ?? {}), worldId }));
  }));

  api.post('/stock', wrapAsync(async (req, res) => {
    const g = await gameFor(req);
    res.json({ ...g.autoStock(), world: g.worldId });
  }));

  api.post('/spawn', wrapAsync(async (req, res) => {
    const g = await gameFor(req);
    const n = Math.min(Number(req.body?.count ?? 1), 30);
    const out = [];
    for (let i = 0; i < n; i++) out.push(g.spawnCustomer(req.body?.archetypeId));
    res.json({ ok: true, world: g.worldId, spawned: out.filter((o) => o.ok).length, results: out });
  }));

  api.post('/regenerate', wrapAsync(async (req, res) => {
    const g = await gameFor(req);
    // Hand-placed fixtures survive a reseed by default — that's the point of
    // placing them. `clearPlacements` is the way back to a purely procedural
    // shop, keeping the same *number* of everything: since step 9 the shop is
    // its placements, so emptying the list and regenerating would hand back an
    // empty building rather than a tidy one. `reflow` counts first.
    const cleared = req.body?.clearPlacements ? g.placements.length : 0;
    const seed = req.body?.seed ?? `re-${Date.now()}`;
    const layout = cleared ? g.reflow(null, seed) : g.regenerateLayout(seed);
    res.json({
      ok: true, world: g.worldId, seed: g.seed, version: g.layoutVersion,
      shelves: layout.shelves.length, plots: layout.plots.length,
      clearedPlacements: cleared,
    });
  }));

  api.post('/time', wrapAsync(async (req, res) => {
    const g = await gameFor(req);
    if (req.body?.day !== undefined) g.day = Math.max(1, Number(req.body.day));
    if (req.body?.hour !== undefined) g.time = Math.min(0.999, Math.max(0, Number(req.body.hour) / 24));
    if (req.body?.skipDays) {
      g.day += Number(req.body.skipDays);
      g.time = OPEN_HOUR / 24;
      g.onNewDay();
    }
    res.json({ ok: true, world: g.worldId, day: g.day, hour: Math.round(g.time * 24 * 10) / 10 });
  }));

  api.post('/cash', wrapAsync(async (req, res) => {
    const g = await gameFor(req);
    const amount = Number(req.body?.amount ?? 0);
    if (req.body?.set !== undefined) g.cash = Number(req.body.set);
    else g.cash += amount;
    res.json({ ok: true, world: g.worldId, cash: Math.round(g.cash * 100) / 100 });
  }));

  /**
   * Set standing in the town directly.
   *
   * Exists because reputation is the one economic value with no way back: it
   * drives footfall through `pull`, which floors at 0.08, and it recovers at
   * +0.004 per sale — so a shop knocked to the floor gets ~8% of its customers
   * and cannot earn its way out, however well it is stocked. `reset-economy`
   * would fix it and also take the day and the cash with it, which is not a
   * repair, it is a new game.
   */
  api.post('/reputation', wrapAsync(async (req, res) => {
    const g = await gameFor(req);
    const set = Number(req.body?.set);
    if (!Number.isFinite(set)) throw new HttpError(400, 'set is required, 0..1');
    const before = g.reputation;
    g.reputation = Math.min(1, Math.max(0, set));
    g.persist();
    res.json({
      ok: true,
      world: g.worldId,
      before: Math.round(before * 1000) / 1000,
      reputation: Math.round(g.reputation * 1000) / 1000,
    });
  }));

  api.post('/modifier', wrapAsync(async (req, res) => {
    const g = await gameFor(req);
    const { tag, demand_mult = 1, price_mult = 1, days = 2, label = 'manual' } = req.body ?? {};
    if (!tag) throw new HttpError(400, 'tag is required');
    addModifier({
      worldId: g.worldId,
      source: 'manual', label, tag,
      demand_mult: Number(demand_mult), price_mult: Number(price_mult),
      expires_day: g.day + Number(days),
    });
    g.invalidateModifiers();
    res.json({ ok: true, world: g.worldId, tag, expires_day: g.day + Number(days) });
  }));

  // Start the money over on the shop you already built. `stock` refills every
  // shelf and replants every plot on the way out, which is what "reset it to
  // fully stocked" means — otherwise day one opens with day twenty-seven's
  // half-empty aisles.
  api.post('/reset-economy', wrapAsync(async (req, res) => {
    const g = await gameFor(req);
    const result = g.resetEconomy();
    const stocked = req.body?.stock ? g.autoStock() : null;
    res.json({ ...result, world: g.worldId, stocked });
  }));

  api.post('/modifiers/clear', wrapAsync(async (req, res) => {
    const g = await gameFor(req);
    const n = clearModifiers(req.body?.source, g.worldId);
    g.invalidateModifiers();
    res.json({ ok: true, world: g.worldId, cleared: n });
  }));

  // ---- the AI director ---------------------------------------------------

  api.post('/director/run', wrapAsync(async (req, res) => {
    const g = await gameFor(req);
    const result = await runDirector(g, { force: true });
    res.json({ ...result, world: g.worldId });
  }));

  api.get('/director/context', wrapAsync(async (req, res) => {
    const g = await gameFor(req);
    res.json({ ok: true, world: g.worldId, context: describeWorld(g) });
  }));

  // ---- screenshot --------------------------------------------------------

  // The browser POSTs its rendered PNG here in response to a screenshot
  // request. Deliberately HTTP rather than the game websocket — see
  // MartRoom.requestScreenshot for why.
  //
  // Asked of every room rather than of the primary one: the id identifies the
  // waiter, and the tab that was asked for a picture is not necessarily in the
  // busiest shop. `resolveScreenshot` returns false for an id a room has never
  // heard of, so this is a lookup, not a broadcast.
  api.post('/screenshot/upload', wrap((req, res) => {
    const { id, dataUrl } = req.body ?? {};
    if (!id) throw new HttpError(400, 'id is required');
    res.json({ ok: [...rooms].some((room) => room.resolveScreenshot(id, dataUrl)) });
  }));

  api.get('/screenshot', wrapAsync(async (req, res) => {
    const worldId = resolveWorldId(req.query?.world ? String(req.query.world) : null);
    const room = [...rooms].find((r) => r.worldId === worldId && r.clients.length > 0);
    if (!room) {
      // Deliberately not started headless like every other route: there is no
      // renderer on the server, so a room with nobody in it has nothing that
      // could take the picture. Saying so beats an eight-second timeout.
      throw new HttpError(503, `nobody has "${worldId}" open in a browser — open that world in a tab first`);
    }
    const dataUrl = await room.requestScreenshot();
    if (!dataUrl) throw new HttpError(502, 'client returned no image');

    if (req.query.format === 'dataurl') return res.json({ ok: true, world: worldId, dataUrl });
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    res.type('png').send(Buffer.from(b64, 'base64'));
  }));

  // ---- errors ------------------------------------------------------------
  api.use((err, req, res, next) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('[api]', err);
    res.status(status).json({ ok: false, error: err.message });
  });

  return api;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const wrap = (fn) => (req, res, next) => {
  try { fn(req, res); } catch (e) { next(e); }
};
const wrapAsync = (fn) => (req, res, next) => fn(req, res).catch(next);
