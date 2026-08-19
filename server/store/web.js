/**
 * THE WEB STORE — the same nineteen functions, with no database under them.
 *
 * The second implementation of the contract in `server/db.js`, and the reason
 * that contract exists. A bundler alias swaps this in for `store/sqlite.js`
 * (see vite.config.js), so nothing that reads the store ever learns which one it
 * is on and Node never parses this file at all.
 *
 * Three decisions, and each of them is the doc's argument made real:
 *
 * **Content is the seed export, and it is read-only.** Not SQLite compiled to
 * wasm — about a megabyte of query engine to answer questions nobody is allowed
 * to ask, because the thing that writes content is MCP and MCP cannot reach a
 * tab. `data/seed/*.json` is already the export format and already committed, so
 * the catalogue is an import. `upsert` and `remove` THROW; see below.
 *
 * **The save is in memory, and the vault is behind it.** IndexedDB is
 * asynchronous and this contract is not — `content()` refreshes inside a timer,
 * `Game.persist` is called from the middle of a tick, `world()` is read during
 * construction. So the whole of a browser's saved state is read into memory once
 * by `openStore()` and every contract call after that is a plain object lookup.
 * Writes go to memory first and reach the vault afterwards, never the other way
 * round.
 *
 * **The vault is injected**, which is what makes any of this testable: pass
 * `memoryVault()` and the entire store runs in Node, which is exactly what
 * `npm run verify:store` does when it asserts that a shop played against this
 * file and a shop played against SQLite are the same shop.
 */

import itemsSeed from '../../data/seed/items.json' with { type: 'json' };
import cropsSeed from '../../data/seed/crops.json' with { type: 'json' };
import archetypesSeed from '../../data/seed/archetypes.json' with { type: 'json' };
import eventsSeed from '../../data/seed/events.json' with { type: 'json' };
import upgradesSeed from '../../data/seed/upgrades.json' with { type: 'json' };
import recipesSeed from '../../data/seed/recipes.json' with { type: 'json' };
import fixturesSeed from '../../data/seed/fixtures.json' with { type: 'json' };
import workersSeed from '../../data/seed/workers.json' with { type: 'json' };
import pastimesSeed from '../../data/seed/pastimes.json' with { type: 'json' };
import skinsSeed from '../../data/seed/skins.json' with { type: 'json' };
import vehiclesSeed from '../../data/seed/vehicles.json' with { type: 'json' };
import kitsSeed from '../../data/seed/kits.json' with { type: 'json' };

import { SCHEMAS } from '../../shared/schemas.js';
import { DEFAULT_WORLD_ID, worldStateKey } from './keys.js';

export { DEFAULT_WORLD_ID, worldStateKey };

const RAW = {
  items: itemsSeed,
  crops: cropsSeed,
  archetypes: archetypesSeed,
  events: eventsSeed,
  upgrades: upgradesSeed,
  recipes: recipesSeed,
  fixtures: fixturesSeed,
  workers: workersSeed,
  pastimes: pastimesSeed,
  skins: skinsSeed,
  vehicles: vehiclesSeed,
  kits: kitsSeed,
};

/**
 * Columns `npm run export` strips, put back on the way in.
 *
 * They are bookkeeping and no mechanic reads them — the export drops them so
 * that content diffs stay legible. But `all()` on the SQLite side hands them
 * over, and the promise this file makes is that the two stores are
 * indistinguishable: a sweep comparing rows field by field would otherwise fail
 * on two columns nothing cares about, which is a false alarm that would teach
 * everybody to ignore the real one.
 */
const BOOKKEEPING = { created_by: 'seed', created_at: 0 };

/** Which schema validates a table's rows. The same map `writeContent` keeps. */
const KIND = {
  items: 'item', crops: 'crop', archetypes: 'archetype', events: 'event',
  upgrades: 'upgrade', recipes: 'recipe', fixtures: 'fixture', workers: 'worker',
  pastimes: 'pastime', skins: 'skin', vehicles: 'vehicle', kits: 'kit',
};

/**
 * THE SEED ROWS, PUT THROUGH THE SAME GATE THEY GO THROUGH ON THE WAY INTO
 * SQLITE — and this is not belt and braces, it is the only reason the two
 * stores agree.
 *
 * `npm run seed` does not copy JSON into a database. It calls `writeContent`,
 * which *parses* each row, and a zod parse is not only a yes or a no: it fills
 * in every default the schema declares. So a part authored without `alpha` is
 * stored with `alpha: 1`, and a fixture authored without `tiers` is stored with
 * `[]`. `data/seed/*.json` is a dump of that database taken at some point, which
 * means it is a MIXTURE — rows re-saved since a field was added carry it, rows
 * that have not been touched since do not.
 *
 * Read raw, then, this store would hand the renderer `alpha: undefined` for some
 * items and `1` for others, off the same committed file, with the split decided
 * by which rows somebody happened to edit last. `verify:store` found exactly
 * that: ninety rows differing in `model`, `tiers` or `surface`, none of which
 * would have crashed anything and all of which would have drawn slightly wrong.
 *
 * A row the current schema refuses is dropped with a warning rather than
 * thrown, which is `seed.js`'s call: one bad row in a shipped catalogue is an
 * item nobody can buy, and a hard failure is a game that will not start.
 */
const parsed = new Map();
function rowsOf(table) {
  if (parsed.has(table)) return parsed.get(table);
  const schema = SCHEMAS[KIND[table]];
  const out = [];
  for (const row of RAW[table] ?? []) {
    if (!schema) { out.push(row); continue; }
    const res = schema.safeParse(row);
    if (res.success) out.push(res.data);
    else console.warn(`[store] dropped ${table} "${row?.id}" — ${res.error.issues[0]?.message}`);
  }
  parsed.set(table, out);
  return out;
}

// ---------------------------------------------------------------------------
// The vault — how memory reaches the disk (or doesn't)
// ---------------------------------------------------------------------------

/**
 * A vault is four async methods over a string key. Deliberately tiny, because
 * everything with an opinion about what a save *is* lives above it.
 *
 * @typedef {{
 *   get(key: string): Promise<any>,
 *   set(key: string, value: any): Promise<void>,
 *   del(key: string): Promise<void>,
 *   keys(): Promise<string[]>,
 * }} Vault
 */

/** Nothing survives the process. What the sweeps run against. */
export function memoryVault() {
  const map = new Map();
  return {
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : undefined; },
    async set(key, value) { map.set(key, structuredClone(value)); },
    async del(key) { map.delete(key); },
    async keys() { return [...map.keys()]; },
  };
}

/**
 * IndexedDB, one object store, keys as above.
 *
 * `localStorage` was the obvious alternative and is the wrong one twice: it is
 * synchronous *on the main thread* (so a 300KB save blob written mid-tick is a
 * frame dropped), and it caps out somewhere around 5MB, which a shop with a
 * fortnight of ledger in it can reach.
 */
export function idbVault(name = 'sprocket-and-stock', store = 'kv') {
  let dbp = null;
  const open = () => (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve(req?.result);
    });
  };
  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    set: (key, value) => run('readwrite', (s) => s.put(value, key)).then(() => undefined),
    del: (key) => run('readwrite', (s) => s.delete(key)).then(() => undefined),
    keys: () => run('readonly', (s) => s.getAllKeys()).then((k) => [...(k ?? [])].map(String)),
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const ROW = 'row:';   // one world's menu entry
const SAVE = 'save:'; // one world's blob, keyed by `worldStateKey`
const MODS = 'mods';  // every live modifier, in one value

let vault = memoryVault();
let opened = false;

/** id -> world row */
let rows = new Map();
/** `state:<id>` -> save blob */
let saves = new Map();
/** the modifiers table, ids minted here the way AUTOINCREMENT does */
let mods = [];
let nextModId = 1;

/** Keys written since the last flush. */
const dirty = new Set();
let flushing = null;

/**
 * Read the vault into memory. **Await this before anything constructs a Game.**
 *
 * Not part of the store contract, exactly as `db()` is not: each store has its
 * own way of waking up and the entry point is the only thing that should know
 * which one it is looking at. The difference from SQLite's is that this one is
 * asynchronous and therefore cannot be done lazily on first read — which is the
 * whole reason it is a step in the boot sequence rather than a detail.
 */
export async function openStore(v = idbVault()) {
  vault = v;
  rows = new Map();
  saves = new Map();
  mods = [];
  nextModId = 1;
  dirty.clear();

  for (const key of await vault.keys()) {
    const value = await vault.get(key);
    if (value === undefined) continue;
    if (key.startsWith(ROW)) rows.set(key.slice(ROW.length), value);
    else if (key.startsWith(SAVE)) saves.set(key.slice(SAVE.length), value);
    else if (key === MODS) mods = Array.isArray(value) ? value : [];
  }
  nextModId = mods.reduce((n, m) => Math.max(n, m.id + 1), 1);
  opened = true;
  return { worlds: rows.size, saves: saves.size };
}

/** For the sweeps, and for a "delete everything" button that does not exist yet. */
export function resetStore() {
  rows = new Map();
  saves = new Map();
  mods = [];
  nextModId = 1;
  dirty.clear();
}

function touch(key) {
  dirty.add(key);
  // A microtask rather than a timer: several writes inside one tick collapse
  // into one flush, and a flush is never more than a tick behind the memory it
  // is copying. Errors are logged and swallowed — a vault that cannot write is
  // a save that will not survive the tab closing, which is bad, and a sim that
  // stops ticking because of it is worse.
  flushing ??= Promise.resolve().then(async () => {
    flushing = null;
    const keys = [...dirty];
    dirty.clear();
    for (const k of keys) {
      try {
        if (k === MODS) await vault.set(MODS, mods);
        else if (k.startsWith(ROW)) {
          const id = k.slice(ROW.length);
          if (rows.has(id)) await vault.set(k, rows.get(id)); else await vault.del(k);
        } else if (k.startsWith(SAVE)) {
          const id = k.slice(SAVE.length);
          if (saves.has(id)) await vault.set(k, saves.get(id)); else await vault.del(k);
        }
      } catch (err) {
        console.error('[store] could not write', k, err);
      }
    }
  });
}

/** Wait for everything written so far to have reached the vault. */
export async function flushStore() {
  while (flushing) await flushing;
}

// ---------------------------------------------------------------------------
// Content — read-only
// ---------------------------------------------------------------------------

/**
 * Fresh objects every call, the way a SELECT hands out fresh rows.
 *
 * Not an optimisation to remove later. `content.js` builds its `byId` maps out
 * of whatever this returns, so handing back the imported module objects would
 * put the *bundle's* catalogue one mutation away from anything that scribbled on
 * a row — and a bundled module cannot be reloaded to undo it. This is the
 * `structuredClone` in `world()` making the same argument about a different
 * shallow copy, and it costs one clone per table per boot, because
 * `contentVersion` never moves and so `load()` runs exactly once.
 */
export function all(table) {
  if (!RAW[table]) return [];
  return rowsOf(table).map((row) => ({ ...BOOKKEEPING, ...structuredClone(row) }));
}

export function get(table, id) {
  if (!RAW[table]) return null;
  const row = rowsOf(table).find((r) => r.id === id);
  return row ? { ...BOOKKEEPING, ...structuredClone(row) } : null;
}

/**
 * A constant, and this is load-bearing rather than lazy.
 *
 * The room polls this every 250ms so that a write from *another process* is
 * noticed within a tick. There is no other process here. A counter that moved —
 * anything derived from a clock, say — would reload the registry and rebuild
 * every menu in the game four times a second, for ever, and nothing would say a
 * word about it.
 */
export function contentVersion() {
  return 1;
}

/**
 * The two refusals, and they must stay refusals.
 *
 * A store that cannot author content and pretends otherwise is the worst
 * failure available here: the write appears to work, the row is in the registry,
 * the shop plays as though it exists — and it is gone on reload, along with
 * however long somebody spent authoring it. Throwing puts the error where the
 * caller is (`writeContent` already returns `{ok:false}` shapes) instead of in
 * a log nobody reads tomorrow.
 */
export function upsert() {
  throw new Error('this build ships a fixed catalogue — content is authored in the desktop build, over MCP');
}

export function remove() {
  throw new Error('this build ships a fixed catalogue — content is authored in the desktop build, over MCP');
}

// ---------------------------------------------------------------------------
// The save
// ---------------------------------------------------------------------------

export function getWorld(key, fallback = null) {
  if (!saves.has(key)) return fallback;
  return structuredClone(saves.get(key));
}

export function setWorld(key, value) {
  saves.set(key, structuredClone(value));
  touch(SAVE + key);
  return value;
}

// ---------------------------------------------------------------------------
// Save slots
// ---------------------------------------------------------------------------

const cloneRow = (r) => (r ? { ...r } : null);

export function listWorldRows() {
  return [...rows.values()].sort((a, b) => b.played_at - a.played_at).map(cloneRow);
}

export function worldRow(id) {
  return cloneRow(rows.get(id)) ?? null;
}

export function insertWorldRow({ id, name, seed }) {
  const now = Date.now();
  rows.set(id, { id, name, seed: String(seed), created_at: now, played_at: now });
  touch(ROW + id);
  return worldRow(id);
}

export function touchWorldRow(id) {
  const row = rows.get(id);
  if (!row) return;
  row.played_at = Date.now();
  touch(ROW + id);
}

export function renameWorldRow(id, name) {
  const row = rows.get(id);
  if (row) { row.name = name; touch(ROW + id); }
  return worldRow(id);
}

export function deleteWorldRow(id) {
  // Same three deletions the SQLite transaction makes, and in the same breath:
  // a half-deleted world is a row the menu offers you with no save behind it.
  // Content is untouched — it belongs to every world at once.
  const had = rows.delete(id);
  saves.delete(worldStateKey(id));
  touch(SAVE + worldStateKey(id));
  touch(ROW + id);
  const before = mods.length;
  mods = mods.filter((m) => m.world_id !== id);
  if (mods.length !== before) touch(MODS);
  return had;
}

// ---------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------

export function activeModifiers(day, worldId = DEFAULT_WORLD_ID) {
  return mods.filter((m) => m.world_id === worldId && m.expires_day > day).map((m) => ({ ...m }));
}

/**
 * An identical live row is a duplicate write, never a second event — the same
 * rule the SQLite store states at length, and the two have to agree or a shop
 * loaded in a browser accumulates HUD chips a desktop one does not.
 */
export function addModifier({
  worldId = DEFAULT_WORLD_ID, source, label = '', tag,
  demand_mult = 1, price_mult = 1, expires_day,
}) {
  const dupe = mods.some((m) => m.world_id === worldId && m.source === source
    && m.label === label && m.tag === tag && m.demand_mult === demand_mult
    && m.price_mult === price_mult && m.expires_day === expires_day);
  if (dupe) return false;

  mods.push({
    id: nextModId++, world_id: worldId, source, label, tag,
    demand_mult, price_mult, expires_day,
  });
  touch(MODS);
  return true;
}

export function pruneModifiers(day, worldId = DEFAULT_WORLD_ID) {
  const before = mods.length;
  mods = mods.filter((m) => !(m.world_id === worldId && m.expires_day <= day));
  const gone = before - mods.length;
  if (gone) touch(MODS);
  return gone;
}

export function clearModifiers(source, worldId = DEFAULT_WORLD_ID) {
  const before = mods.length;
  mods = mods.filter((m) => !(m.world_id === worldId && (source ? m.source === source : true)));
  const gone = before - mods.length;
  if (gone) touch(MODS);
  return gone;
}

/** Whether `openStore` has run. The entry point's assertion, not the sim's. */
export function isOpen() {
  return opened;
}
