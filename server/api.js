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
import { primaryRoom } from './rooms/MartRoom.js';
import { content, writeContent, refresh } from './content.js';
import { simulate } from './sim/simulate.js';
import { remove, addModifier, clearModifiers, activeModifiers } from './db.js';
import { TAG_GROUPS, ALL_TAGS } from '../shared/tags.js';
import { runDirector, describeWorld } from './director.js';
import { OPEN_HOUR } from './sim/index.js';

const KINDS = {
  item: 'items', crop: 'crops', archetype: 'archetypes',
  event: 'events', upgrade: 'upgrades', recipe: 'recipes',
};

export function createApi() {
  const api = express.Router();
  api.use(express.json({ limit: '2mb' }));

  // ---- auth -------------------------------------------------------------
  api.use((req, res, next) => {
    const token = process.env.SNS_TOKEN;
    if (!token) return next();
    const header = req.get('authorization') ?? '';
    if (header === `Bearer ${token}`) return next();
    res.status(401).json({ ok: false, error: 'bad or missing token' });
  });

  const game = () => {
    const room = primaryRoom();
    if (!room) throw new HttpError(503, 'no live room — is the game server running?');
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
    });
  });

  api.get('/state', wrap((req, res) => {
    const g = game();
    res.json({
      ok: true,
      ...g.snapshot(),
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

  api.get('/log', wrap((req, res) => {
    res.json({ ok: true, log: game().log.slice(-Number(req.query.n ?? 30)) });
  }));

  api.get('/modifiers', wrap((req, res) => {
    res.json({ ok: true, day: game().day, modifiers: activeModifiers(game().day) });
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

  api.post('/simulate', wrap((req, res) => {
    res.json(simulate(req.body ?? {}));
  }));

  api.post('/stock', wrap((req, res) => {
    res.json(game().autoStock());
  }));

  api.post('/spawn', wrap((req, res) => {
    const g = game();
    const n = Math.min(Number(req.body?.count ?? 1), 30);
    const out = [];
    for (let i = 0; i < n; i++) out.push(g.spawnCustomer(req.body?.archetypeId));
    res.json({ ok: true, spawned: out.filter((o) => o.ok).length, results: out });
  }));

  api.post('/regenerate', wrap((req, res) => {
    const g = game();
    // Hand-placed fixtures survive a reseed by default — that's the point of
    // placing them. `clearPlacements` is the way back to a purely procedural
    // shop without touching what the shop owns.
    const cleared = req.body?.clearPlacements ? g.placements.length : 0;
    if (cleared) g.placements = [];
    const layout = g.regenerateLayout(req.body?.seed ?? `re-${Date.now()}`);
    res.json({
      ok: true, seed: g.seed, version: g.layoutVersion,
      shelves: layout.shelves.length, plots: layout.plots.length,
      clearedPlacements: cleared,
    });
  }));

  api.post('/time', wrap((req, res) => {
    const g = game();
    if (req.body?.day !== undefined) g.day = Math.max(1, Number(req.body.day));
    if (req.body?.hour !== undefined) g.time = Math.min(0.999, Math.max(0, Number(req.body.hour) / 24));
    if (req.body?.skipDays) {
      g.day += Number(req.body.skipDays);
      g.time = OPEN_HOUR / 24;
      g.onNewDay();
    }
    res.json({ ok: true, day: g.day, hour: Math.round(g.time * 24 * 10) / 10 });
  }));

  api.post('/cash', wrap((req, res) => {
    const g = game();
    const amount = Number(req.body?.amount ?? 0);
    if (req.body?.set !== undefined) g.cash = Number(req.body.set);
    else g.cash += amount;
    res.json({ ok: true, cash: Math.round(g.cash * 100) / 100 });
  }));

  api.post('/modifier', wrap((req, res) => {
    const g = game();
    const { tag, demand_mult = 1, price_mult = 1, days = 2, label = 'manual' } = req.body ?? {};
    if (!tag) throw new HttpError(400, 'tag is required');
    addModifier({
      source: 'manual', label, tag,
      demand_mult: Number(demand_mult), price_mult: Number(price_mult),
      expires_day: g.day + Number(days),
    });
    g.invalidateModifiers();
    res.json({ ok: true, tag, expires_day: g.day + Number(days) });
  }));

  api.post('/modifiers/clear', wrap((req, res) => {
    const n = clearModifiers(req.body?.source);
    game().invalidateModifiers();
    res.json({ ok: true, cleared: n });
  }));

  // ---- the AI director ---------------------------------------------------

  api.post('/director/run', wrapAsync(async (req, res) => {
    const result = await runDirector(game(), { force: true });
    res.json(result);
  }));

  api.get('/director/context', wrap((req, res) => {
    res.json({ ok: true, context: describeWorld(game()) });
  }));

  // ---- screenshot --------------------------------------------------------

  // The browser POSTs its rendered PNG here in response to a screenshot
  // request. Deliberately HTTP rather than the game websocket — see
  // MartRoom.requestScreenshot for why.
  api.post('/screenshot/upload', wrap((req, res) => {
    const room = primaryRoom();
    const { id, dataUrl } = req.body ?? {};
    if (!room || !id) throw new HttpError(400, 'id is required');
    res.json({ ok: room.resolveScreenshot(id, dataUrl) });
  }));

  api.get('/screenshot', wrapAsync(async (req, res) => {
    const room = primaryRoom();
    if (!room) throw new HttpError(503, 'no live room');
    const dataUrl = await room.requestScreenshot();
    if (!dataUrl) throw new HttpError(502, 'client returned no image');

    if (req.query.format === 'dataurl') return res.json({ ok: true, dataUrl });
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
