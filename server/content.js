/**
 * THE LIVE CONTENT REGISTRY.
 *
 * Holds every item/crop/archetype/event/upgrade in memory so the sim can read
 * them at 20Hz without touching disk. Calls `refresh()` each tick; if the DB's
 * content_version changed (because someone's agent just inserted a row) it
 * reloads and fires listeners.
 *
 * Net effect: an MCP `create_item()` shows up in the running game within ~50ms,
 * with no restart and nobody's file getting overwritten.
 */

import { all, contentVersion, getWorld, setWorld, worldStateKey } from './db.js';
import { SCHEMAS, unknownTags } from '../shared/schemas.js';
import { BUILD_KINDS } from '../shared/build.js';
import { kindOf } from '../shared/pieces.js';
import { upsert } from './db.js';

let cache = null;
let loadedVersion = -1;
const listeners = new Set();

function load() {
  const items = all('items');
  const crops = all('crops');
  const archetypes = all('archetypes');
  const events = all('events');
  const upgrades = all('upgrades');
  const recipes = all('recipes');
  const fixtures = all('fixtures');
  const workers = all('workers');
  const pastimes = all('pastimes');

  cache = {
    items,
    crops,
    archetypes,
    events,
    upgrades,
    recipes,
    fixtures,
    workers,
    pastimes,
    byId: {
      items: Object.fromEntries(items.map((i) => [i.id, i])),
      crops: Object.fromEntries(crops.map((c) => [c.id, c])),
      archetypes: Object.fromEntries(archetypes.map((a) => [a.id, a])),
      events: Object.fromEntries(events.map((e) => [e.id, e])),
      upgrades: Object.fromEntries(upgrades.map((u) => [u.id, u])),
      recipes: Object.fromEntries(recipes.map((r) => [r.id, r])),
      fixtures: Object.fromEntries(fixtures.map((f) => [f.id, f])),
      workers: Object.fromEntries(workers.map((w) => [w.id, w])),
      pastimes: Object.fromEntries(pastimes.map((p) => [p.id, p])),
    },
    version: loadedVersion,
  };
  return cache;
}

/**
 * Reload if the DB changed. Call this once per tick — it's a single indexed
 * SELECT when nothing changed, which is free at our tick rate.
 */
export function refresh() {
  const v = contentVersion();
  if (v === loadedVersion && cache) return false;
  loadedVersion = v;
  load();
  for (const fn of listeners) {
    try { fn(cache); } catch (err) { console.error('[content] listener failed:', err); }
  }
  return true;
}

export function content() {
  if (!cache) refresh();
  return cache;
}

/** Subscribe to content changes (used to push a "content updated" toast to clients). */
export function onContentChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Validate + write a content row. This is the ONLY sanctioned write path —
 * MCP tools, the AI director and seed loading all funnel through here so
 * nothing unvalidated can ever reach the DB.
 *
 * @returns {{ok: true, row: object, warnings: string[]} | {ok: false, error: string}}
 */
export function writeContent(kind, data, createdBy = 'agent') {
  const schema = SCHEMAS[kind];
  if (!schema) return { ok: false, error: `unknown content kind "${kind}"` };

  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: issues };
  }

  const value = parsed.data;
  const warnings = [];

  // Referential checks that zod can't do on its own.
  if (kind === 'crop' && !content().byId.items[value.item_id]) {
    return { ok: false, error: `crop references item_id "${value.item_id}" which does not exist — create the item first` };
  }
  if (kind === 'upgrade') {
    const missing = value.requires.filter((r) => !content().byId.upgrades[r]);
    if (missing.length) warnings.push(`requires unknown upgrades: ${missing.join(', ')}`);
  }
  if (kind === 'recipe') {
    // A recipe that names an item nobody has created can never be made, and
    // would fail silently at the station instead of here.
    const items = content().byId.items;
    if (!items[value.output_id]) {
      return { ok: false, error: `recipe outputs "${value.output_id}" which does not exist — create the item first` };
    }
    const missing = value.inputs.map((i) => i.item_id).filter((id) => !items[id]);
    if (missing.length) {
      return { ok: false, error: `recipe needs items that do not exist: ${missing.join(', ')}` };
    }
  }
  if (kind === 'fixture' && !BUILD_KINDS.includes(kindOf(value))) {
    // The id is yours; the kind is not. Where a thing may go, whether it blocks
    // and which side you use it from are build rules, so a piece naming a kind
    // nobody implemented is scenery — the same gate `JOBS` puts in front of a
    // worker whose job is a function that doesn't exist.
    return {
      ok: false,
      error: value.kind
        ? `"${value.kind}" is not a build kind — it has to be one of: ${BUILD_KINDS.join(', ')}`
        : `a piece has to say what kind it is, one of: ${BUILD_KINDS.join(', ')}`,
    };
  }
  if (value.tags) {
    const unknown = unknownTags(value.tags);
    if (unknown.length) warnings.push(`unrecognised tags (they'll still work, but check for typos): ${unknown.join(', ')}`);
  }
  if (value.affinities) {
    const unknown = unknownTags(Object.keys(value.affinities));
    if (unknown.length) warnings.push(`affinities reference unrecognised tags: ${unknown.join(', ')}`);
  }

  const table = { item: 'items', crop: 'crops', archetype: 'archetypes', event: 'events', upgrade: 'upgrades', recipe: 'recipes', fixture: 'fixtures', worker: 'workers', pastime: 'pastimes' }[kind];
  const row = upsert(table, value, createdBy);
  refresh();
  return { ok: true, row, warnings };
}

// ---------------------------------------------------------------------------
// World bootstrap
// ---------------------------------------------------------------------------

export const DEFAULT_WORLD = {
  seed: 'sprout-1',
  day: 1,
  /** Minutes into the current in-game day (day is 24 "minutes" long by default). */
  clock: 6 * 60,
  cash: 250,
  reputation: 0.5,
  season: 'spring',
  ownedUpgrades: [],
  plots: 4,
  // Six is the floor for a shop to feel stocked: with six archetypes shopping,
  // fewer than this and a third of them find nothing they want and leave.
  shelves: 6,
};

/**
 * The save keys that *are* the economy, as opposed to the shop you built.
 *
 * Named as an allow-list of what a reset touches rather than a keep-list of
 * what it spares, because `persist()` gains keys over time — `edits` is recent
 * — and a keep-list silently drops each new one the day it's added. Anything
 * saved later survives a reset by default, which is the safe way to be wrong.
 */
export const ECONOMY_KEYS = ['day', 'cash', 'reputation', 'season'];

/** What a fresh shop starts on. One definition; the offline script, the live
 *  reset route and `DEFAULT_WORLD` itself all read it from here. */
export function freshEconomy() {
  return Object.fromEntries(ECONOMY_KEYS.map((k) => [k, DEFAULT_WORLD[k]]));
}

/**
 * One save slot's world state.
 *
 * Every caller names the world it means. There is deliberately no "current
 * world" default down here: this is the layer that reads and writes saves, and
 * a default at this depth is how a balance run ends up measuring one shop and
 * overwriting another. Who is playing what is decided in `server/worlds.js`.
 */
export function world(worldId) {
  // Reading never writes. It used to create the row it couldn't find, which was
  // harmless when there was one world and is not now: an ephemeral game — a
  // balance run, a verify sweep — names a world that was never meant to exist,
  // and a read that creates it leaves a save behind with no slot in the menu
  // pointing at it. `createWorld` does the creating, in one place, on purpose.
  return { ...DEFAULT_WORLD, ...(getWorld(worldStateKey(worldId)) ?? {}) };
}

export function saveWorld(worldId, patch) {
  return setWorld(worldStateKey(worldId), { ...world(worldId), ...patch });
}
