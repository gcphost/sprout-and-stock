/**
 * THE SQLITE STORE — the live content store, and the only one that can write.
 *
 * This is one implementation of the contract in `server/db.js`, which is what
 * the rest of the server imports. Nothing outside this file and the handful of
 * Node-only scripts named below should reach in here directly; if you find
 * yourself importing `server/store/sqlite.js` from game code, the thing you
 * wanted probably belongs on the interface instead.
 *
 * It exports three things that are NOT on that interface and deliberately never
 * will be — `db()`, `DATA_DIR` and `SEED_DIR`. They are facts about a file on a
 * disk: the boot handle, the directory the database lives in, and the directory
 * `npm run seed` and `npm run export` read and write. A second store has no
 * answer to any of them, and giving it one would mean inventing a fake path so
 * that a script which cannot run there would fail slightly later. See
 * docs/browser.md.
 *
 * Content (items, crops, customers, events, upgrades) lives here rather than
 * in source files. That's the whole trick behind the co-op playground:
 *
 *   - Two people can add content at the same time with zero merge conflicts.
 *   - An MCP `create_item()` call is live in-game on the next tick. No restart,
 *     no hot-reload, no file write.
 *   - Bad content is rejected at the door by zod, so nobody can wedge the server.
 *
 * Git still gets a copy: `data/seed/*.json` boots a fresh DB, and
 * `npm run export` dumps the live DB back out to those files to commit.
 *
 * WHAT DOES *NOT* GO IN HERE: behaviour. Mechanics, rendering and systems are
 * real code in real files, because code belongs in git where it can be
 * reviewed and diffed. Data is data; logic is logic.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_WORLD_ID, worldStateKey } from './keys.js';

export { DEFAULT_WORLD_ID, worldStateKey };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// `../..` and not `..`: this file lives in server/store/ now. A wrong number of
// hops here does not fail — `db()` cheerfully creates a brand new database at
// the wrong path, so the shop still opens and it is simply empty, which reads as
// the save having been lost rather than as a path being off by one directory.
export const DATA_DIR = path.join(__dirname, '..', '..', 'data');
export const SEED_DIR = path.join(DATA_DIR, 'seed');
const DB_PATH = process.env.SNS_DB ?? path.join(DATA_DIR, 'game.db');

/** Content tables — anything an agent is allowed to write to. */
export const CONTENT_TABLES = ['items', 'crops', 'archetypes', 'events', 'upgrades', 'recipes', 'fixtures', 'workers', 'pastimes', 'skins', 'vehicles', 'kits'];

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS items (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  tags           TEXT NOT NULL,           -- JSON array
  base_cost      REAL NOT NULL,
  base_price     REAL NOT NULL,
  shelf_life_days REAL NOT NULL DEFAULT 5,
  stack          INTEGER NOT NULL DEFAULT 12,
  model          TEXT NOT NULL,           -- JSON
  created_by     TEXT NOT NULL DEFAULT 'seed',
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS crops (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  item_id      TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  grow_minutes REAL NOT NULL,
  yield_min    INTEGER NOT NULL DEFAULT 1,
  yield_max    INTEGER NOT NULL DEFAULT 3,
  seed_cost    REAL NOT NULL,
  seasons      TEXT NOT NULL DEFAULT '[]',
  model        TEXT NOT NULL,
  created_by   TEXT NOT NULL DEFAULT 'seed',
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS archetypes (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  affinities        TEXT NOT NULL,        -- JSON tag->weight
  price_sensitivity REAL NOT NULL DEFAULT 0.5,
  patience          REAL NOT NULL DEFAULT 60,
  budget_min        REAL NOT NULL DEFAULT 10,
  budget_max        REAL NOT NULL DEFAULT 50,
  basket_min        INTEGER NOT NULL DEFAULT 1,
  basket_max        INTEGER NOT NULL DEFAULT 4,
  spawn_weight      REAL NOT NULL DEFAULT 1,
  steal_chance      REAL NOT NULL DEFAULT 0,
  color             TEXT NOT NULL DEFAULT '#d98cb3',
  created_by        TEXT NOT NULL DEFAULT 'seed',
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  effects       TEXT NOT NULL,            -- JSON [{tag, demand_mult, price_mult}]
  duration_days INTEGER NOT NULL DEFAULT 2,
  weight        REAL NOT NULL DEFAULT 1,
  min_day       INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT NOT NULL DEFAULT 'seed',
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS upgrades (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cost        REAL NOT NULL,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  requires    TEXT NOT NULL DEFAULT '[]',
  created_by  TEXT NOT NULL DEFAULT 'seed',
  created_at  INTEGER NOT NULL
);

-- Turn ingredients into something worth more than the sum of its parts.
-- The station column names the appliance it needs, so a recipe written today
-- works on an appliance added next month.
CREATE TABLE IF NOT EXISTS recipes (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  station    TEXT NOT NULL,               -- 'blender' | 'toaster' | ...
  inputs     TEXT NOT NULL,               -- JSON [{item_id, qty}]
  output_id  TEXT NOT NULL,
  output_qty INTEGER NOT NULL DEFAULT 1,
  minutes    REAL NOT NULL DEFAULT 1,     -- in-game minutes to make
  created_by TEXT NOT NULL DEFAULT 'seed',
  created_at INTEGER NOT NULL
);

-- What each kind of fixture looks like and how far it upgrades. The build
-- RULES stay in shared/build.js — this is only its appearance and its tiers,
-- so a shelf can be redrawn or given a third tier without a deploy.
CREATE TABLE IF NOT EXISTS fixtures (
  id         TEXT PRIMARY KEY,            -- yours to choose
  kind       TEXT NOT NULL DEFAULT '',    -- a kind build.js knows; blank = the id
  name       TEXT NOT NULL,
  model      TEXT NOT NULL,               -- JSON, staged by tier
  work       TEXT NOT NULL DEFAULT 'null',-- JSON, staged by how far through a batch
  tiers      TEXT NOT NULL DEFAULT '[]',  -- JSON [{name, cost, ...mults}]
  variants   TEXT NOT NULL DEFAULT '[]',  -- JSON [{id, name, model, work}] — looks only
  cost       REAL NOT NULL DEFAULT 0,     -- 0 = priced by the upgrade that sells it
  emits      TEXT NOT NULL DEFAULT 'null',-- JSON {color, intensity, range} or null
  sfx        TEXT NOT NULL DEFAULT 'null',-- JSON {loop, use, done} or null
  surface    TEXT NOT NULL DEFAULT 'null',-- JSON {color, accent, pattern}: floors only
  yields     TEXT NOT NULL DEFAULT 'null',-- JSON {cash, every} or null: it earns
  charm      REAL NOT NULL DEFAULT 0,     -- how far word of the shop travels
  open       INTEGER NOT NULL DEFAULT 0,  -- 1 = workable from the back too
  signal     TEXT,                        -- which world quantity drives the art
  sort       REAL NOT NULL DEFAULT 0,     -- where it sits on the build bar; higher leads
  tags       TEXT NOT NULL DEFAULT '[]',  -- JSON array
  created_by TEXT NOT NULL DEFAULT 'seed',
  created_at INTEGER NOT NULL
);

-- A kind of worker you can hire. Mirrors the fixtures table on purpose: same
-- staged model, same tier ladder, so a worker is authored exactly like a shelf
-- and reuses the machinery that already restages a model as it climbs.
CREATE TABLE IF NOT EXISTS workers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '[]',   -- JSON array
  model      TEXT NOT NULL,                -- JSON, staged by tier
  tiers      TEXT NOT NULL DEFAULT '[]',   -- JSON [{name, cost, ...mults}]
  jobs       TEXT NOT NULL DEFAULT '[]',   -- JSON [{job, weight}]
  cost       REAL NOT NULL DEFAULT 0,
  wage       REAL NOT NULL DEFAULT 0,
  speed      REAL NOT NULL DEFAULT 2.6,    -- tiles per second
  pace       REAL NOT NULL DEFAULT 0.7,    -- seconds between jobs
  carry      REAL NOT NULL DEFAULT 6,
  color      TEXT NOT NULL DEFAULT '#7a9e4b',
  created_by TEXT NOT NULL DEFAULT 'seed',
  created_at INTEGER NOT NULL
);

-- What a worker does when they are not working. Flavour is authored; the two
-- numbers the sim reads are seconds and restores, which together decide what
-- a break costs the shop. (No backticks in here — this whole block is a JS
-- template literal, and one would end it mid-schema.)
CREATE TABLE IF NOT EXISTS pastimes (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  doing      TEXT NOT NULL,                -- what the roster says they're up to
  spot       TEXT NOT NULL DEFAULT 'here', -- here | outside | bay | till
  seconds    REAL NOT NULL DEFAULT 20,
  restores   REAL NOT NULL DEFAULT 0.5,
  buys       TEXT NOT NULL DEFAULT '[]',   -- JSON array of item tags
  weight     REAL NOT NULL DEFAULT 1,
  tags       TEXT NOT NULL DEFAULT '[]',   -- JSON array
  model      TEXT NOT NULL DEFAULT 'null', -- JSON, staged by break progress
  created_by TEXT NOT NULL DEFAULT 'seed',
  created_at INTEGER NOT NULL
);

-- What one hire looks like, worn over whatever kind they are. Deliberately not
-- shaped like a variant: there is no model column and there never should be.
-- A skin is a palette (slots) plus cosmetics that bolt on (extras), so one row
-- fits every worker kind that exists and every kind added later, and no skin
-- can redraw a bot into something that reads as a customer. See SkinSchema.
CREATE TABLE IF NOT EXISTS skins (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slots      TEXT NOT NULL DEFAULT '{}',   -- JSON {chassis, trim, glow}
  extras     TEXT NOT NULL DEFAULT '[]',   -- JSON array of parts, added not swapped
  tags       TEXT NOT NULL DEFAULT '[]',   -- JSON array
  created_by TEXT NOT NULL DEFAULT 'seed',
  created_at INTEGER NOT NULL
);

-- Something that drives. A delivery van, a customer's car, and whatever else
-- turns up on the ground outside — authored the same way a worker is, because a
-- vehicle is a thing you LOOK at and everything in this game you look at is a
-- row somebody can draw.
--
-- CAPACITY is the only column the sim reads as a number, so it is the only one
-- that can move the balance. Everything else here is what it looks like and how
-- fast it appears to travel, which is worth exactly what it looks like.
--
-- No tiers column, deliberately, and it is not an oversight to be corrected
-- later: a ladder would put capacity in two places at once (the row and the rung
-- you are on), and the bigger van is meant to be an upgrade you can SEE, which
-- means a second row with its own art rather than a number on the first one.
-- (No backticks in here — see the pastimes note above.)
CREATE TABLE IF NOT EXISTS vehicles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  use        TEXT NOT NULL DEFAULT 'delivery', -- delivery | customer
  tags       TEXT NOT NULL DEFAULT '[]',   -- JSON array
  model      TEXT NOT NULL,                -- JSON, staged by how loaded it is
  speed      REAL NOT NULL DEFAULT 3.2,    -- tiles per second
  capacity   INTEGER NOT NULL DEFAULT 4,   -- crates
  color      TEXT NOT NULL DEFAULT '#c9d1d9',
  created_by TEXT NOT NULL DEFAULT 'seed',
  created_at INTEGER NOT NULL
);

-- Something somebody has on them: a shopping bag, a basket, a trolley. Not a
-- pastime with the clock taken out -- a break is an activity and this is only
-- the object, so a row here has no seconds, no spot and nothing it restores.
--
-- USE is the moment it is carried in, out of the closed list in schemas.js,
-- and TAGS is who carries it, matched against the archetype's. Those two
-- columns are the whole assignment: a thief's swag bag is a row tagged thief,
-- and no code in the game knows what a swag bag is. (No backticks in here --
-- see the pastimes note above.)
CREATE TABLE IF NOT EXISTS kits (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  use        TEXT NOT NULL DEFAULT 'leaving',  -- the moment; see KIT_USES
  tags       TEXT NOT NULL DEFAULT '[]',   -- JSON array, matched on the shopper
  weight     REAL NOT NULL DEFAULT 1,
  model      TEXT NOT NULL,                -- JSON, staged by how full it is
  created_by TEXT NOT NULL DEFAULT 'seed',
  created_at INTEGER NOT NULL
);

-- ---- runtime state (not authored content) ----

-- One row per save slot. The shop itself lives in the world table under
-- 'state:<id>' (no backticks in here — see the pastimes note above);
-- this is the index the menu reads, so listing every save never has to parse
-- half a dozen full world blobs to find out what they're called.
--
-- Content is deliberately NOT in here. Items, crops, customers and fixtures are
-- one shared library across every world — that is the whole co-op premise, and
-- a per-world content table would mean the tomato your kid added only exists in
-- the world they happened to be standing in.
CREATE TABLE IF NOT EXISTS worlds (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  seed       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  played_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS world (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                     -- JSON
);

-- Active demand/price modifiers. Written by the world director, read by pricing.
-- Scoped to one world: a heat wave in your shop is not a heat wave in mine.
CREATE TABLE IF NOT EXISTS modifiers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id    TEXT NOT NULL DEFAULT 'default',
  source      TEXT NOT NULL,              -- 'director' | 'event:<id>' | 'manual'
  label       TEXT NOT NULL DEFAULT '',
  tag         TEXT NOT NULL,
  demand_mult REAL NOT NULL DEFAULT 1,
  price_mult  REAL NOT NULL DEFAULT 1,
  expires_day INTEGER NOT NULL
);

-- Bumped on every content write. The room polls this and reloads its content
-- registry when it changes — that's the "live in-game next tick" mechanism.
CREATE TABLE IF NOT EXISTS content_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  v  INTEGER NOT NULL
);
INSERT OR IGNORE INTO content_version (id, v) VALUES (1, 1);
`;

/** Auto-bump content_version whenever any content table changes. */
function buildTriggers() {
  return CONTENT_TABLES.flatMap((t) =>
    ['INSERT', 'UPDATE', 'DELETE'].map((op) => `
      CREATE TRIGGER IF NOT EXISTS bump_${t}_${op.toLowerCase()}
      AFTER ${op} ON ${t}
      BEGIN UPDATE content_version SET v = v + 1 WHERE id = 1; END;
    `),
  ).join('\n');
}

let _db = null;

export function db() {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.exec(SCHEMA);
  addLateColumns(_db);
  migrateToWorlds(_db);
  _db.exec(buildTriggers());
  return _db;
}

/**
 * Columns that arrived after somebody already had a database.
 *
 * `CREATE TABLE IF NOT EXISTS` does exactly nothing to a table that already
 * exists, so a column added to SCHEMA above reaches new databases only — and
 * the first write against an old one fails on a column it has never heard of.
 * Adding them here on open keeps a live world working across a `git pull`,
 * which for this game is the normal case rather than the exceptional one.
 */
const ADDED_COLUMNS = [
  ['fixtures', 'variants', "TEXT NOT NULL DEFAULT '[]'"],
  // The kinds/pieces split. Blank rather than NULL, and read as "this row names
  // its own kind" — which is precisely what it meant before there was a column.
  ['fixtures', 'kind', "TEXT NOT NULL DEFAULT ''"],
  ['fixtures', 'cost', 'REAL NOT NULL DEFAULT 0'],
  ['fixtures', 'emits', "TEXT NOT NULL DEFAULT 'null'"],
  // What it sounds like. 'null' is "this one is quiet", which is every piece
  // authored before a fixture could make a noise — so no live shop got louder
  // on the day this landed.
  ['fixtures', 'sfx', "TEXT NOT NULL DEFAULT 'null'"],
  ['fixtures', 'tags', "TEXT NOT NULL DEFAULT '[]'"],
  // What a floor is made of. Every row that predates floors has none, and
  // 'null' is exactly right for them: nothing but a `floor` piece ever reads it.
  ['fixtures', 'surface', "TEXT NOT NULL DEFAULT 'null'"],
  // The first two things a piece can do that are neither a look nor a place to
  // put stock. 'null' and 0 are "this one just sits there", which is what every
  // row written before them does.
  ['fixtures', 'yields', "TEXT NOT NULL DEFAULT 'null'"],
  ['fixtures', 'charm', 'REAL NOT NULL DEFAULT 0'],
  // What it looks like while it is working. 'null' is "it looks the same busy
  // as it does idle", which is every piece written before appliances could show
  // they were running — and is why nothing in a live shop changed on the day
  // this landed.
  ['fixtures', 'work', "TEXT NOT NULL DEFAULT 'null'"],
  // Whether you can walk all the way round it. 0 is "it has a back", which is
  // true of every unit authored before the question could be asked — so no shop
  // gains a side it did not have on the day this landed.
  ['fixtures', 'open', 'INTEGER NOT NULL DEFAULT 0'],
  // Which world quantity drives the art. Nullable rather than `NOT NULL DEFAULT
  // ''` like `kind` above, and the difference is the one this column is for: a
  // blank kind means "this row names itself", which is a real answer, while a
  // piece that watches nothing has nothing to name. The zod field is
  // `.nullable()`, so an empty string would be a value it refuses on the way
  // back in — a row that saves and will not reload.
  ['fixtures', 'signal', 'TEXT'],
  // 'null' rather than '{}': a pastime with no prop drawn for it yet has no
  // model at all, and an empty object is a model that fails its own schema.
  ['pastimes', 'model', "TEXT NOT NULL DEFAULT 'null'"],
  // Every modifier written before there was more than one world belonged to the
  // world that is now `default`, which is exactly what the DEFAULT says.
  ['modifiers', 'world_id', "TEXT NOT NULL DEFAULT 'default'"],
  // An archetype written before shopping lists came for nothing in particular,
  // and an empty staple list is exactly that shopper.
  ['archetypes', 'staple_tags', "TEXT NOT NULL DEFAULT '[]'"],
  // What kind of shopper this is, for anything authored to match them on — a
  // kit today. Empty is every archetype written before kits existed, and a kit
  // with no tags of its own still goes to them, so no shopper changes.
  ['archetypes', 'tags', "TEXT NOT NULL DEFAULT '[]'"],
  // Nobody written before docs/security.md steals, which is the same claim the
  // schema default makes and has to be made twice: the column decides what an
  // existing row reads back as, and the schema decides what a new row that
  // omits it is. Disagree and the two halves of one control drift apart.
  ['archetypes', 'steal_chance', 'REAL NOT NULL DEFAULT 0'],
  // Where a piece sits on the build bar. 0 is "wherever the catalogue put you"
  // and the sort is stable, so every row authored before this reads back as the
  // palette it has always been — which is the same claim the schema default
  // makes, and it has to be made in both places for the reason above.
  ['fixtures', 'sort', 'REAL NOT NULL DEFAULT 0'],
];

function addLateColumns(handle) {
  for (const [table, col, decl] of ADDED_COLUMNS) {
    const has = handle.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
    if (!has) handle.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  }
}

/**
 * Carry a single-world database over to the multi-world layout.
 *
 * The shop used to live under one key called `state`. It now lives under
 * `state:<id>`, so this renames the old key rather than copying it: two rows
 * that both look like the live save is precisely the sort of thing that reads
 * fine and costs an afternoon, because whichever one you are looking at seems
 * right and the game is playing the other.
 *
 * Idempotent, and safe on a brand new database — there is nothing to rename and
 * `server/worlds.js` creates the first world on boot instead.
 */
function migrateToWorlds(handle) {
  // `saves` was created from the first commit and never read or written once.
  // Dropping it here rather than leaving it as scenery: a table called `saves`
  // sitting next to the real save is a wrong answer waiting to be believed.
  handle.exec('DROP TABLE IF EXISTS saves');

  const legacy = handle.prepare("SELECT value FROM world WHERE key = 'state'").get();
  if (!legacy) return;

  const already = handle.prepare('SELECT id FROM worlds WHERE id = ?').get(DEFAULT_WORLD_ID);
  if (!already) {
    let seed = 'sprout-1';
    try { seed = String(JSON.parse(legacy.value).seed ?? seed); } catch { /* keep the default */ }
    const now = Date.now();
    handle.prepare(`INSERT INTO worlds (id, name, seed, created_at, played_at)
                    VALUES (?, ?, ?, ?, ?)`)
      .run(DEFAULT_WORLD_ID, 'First shop', seed, now, now);
  }

  handle.prepare('INSERT OR REPLACE INTO world (key, value) VALUES (?, ?)')
    .run(worldStateKey(DEFAULT_WORLD_ID), legacy.value);
  handle.prepare("DELETE FROM world WHERE key = 'state'").run();
  console.log(`[db] migrated the existing save to world "${DEFAULT_WORLD_ID}"`);
}

/** Current content version. Cheap enough to call every tick. */
export function contentVersion() {
  return db().prepare('SELECT v FROM content_version WHERE id = 1').get().v;
}

// ---------------------------------------------------------------------------
// Row <-> object mapping. SQLite has no JSON columns, so we (de)serialise here
// and nowhere else — the rest of the codebase only ever sees real objects.
// ---------------------------------------------------------------------------

const JSON_FIELDS = {
  items: ['tags', 'model'],
  crops: ['seasons', 'model'],
  archetypes: ['affinities', 'staple_tags', 'tags'],
  events: ['effects'],
  upgrades: ['payload', 'requires'],
  recipes: ['inputs'],
  fixtures: ['model', 'work', 'tiers', 'variants', 'emits', 'sfx', 'surface', 'yields', 'tags'],
  workers: ['tags', 'model', 'tiers', 'jobs'],
  pastimes: ['buys', 'tags', 'model'],
  skins: ['slots', 'extras', 'tags'],
  vehicles: ['tags', 'model'],
  kits: ['tags', 'model'],
};

/**
 * Columns that are a yes/no in the schema and an INTEGER in here.
 *
 * SQLite has no boolean and better-sqlite3 refuses to bind one, so a field zod
 * validated as `z.boolean()` cannot go straight into a column — and coming back
 * out it is 1, which `=== true` quietly answers no to. Both directions, in the
 * one pair of functions every read and write already goes through, so nothing
 * downstream has to know which storage a field happens to have.
 */
const BOOL_FIELDS = {
  fixtures: ['open'],
};

function hydrate(table, row) {
  if (!row) return null;
  const out = { ...row };
  for (const f of JSON_FIELDS[table] ?? []) {
    try {
      out[f] = JSON.parse(row[f]);
    } catch {
      out[f] = Array.isArray(row[f]) ? [] : {};
    }
  }
  for (const f of BOOL_FIELDS[table] ?? []) out[f] = !!row[f];
  return out;
}

function dehydrate(table, obj) {
  const out = { ...obj };
  for (const f of JSON_FIELDS[table] ?? []) {
    if (out[f] !== undefined) out[f] = JSON.stringify(out[f]);
  }
  for (const f of BOOL_FIELDS[table] ?? []) {
    if (out[f] !== undefined) out[f] = out[f] ? 1 : 0;
  }
  return out;
}

export function all(table) {
  return db().prepare(`SELECT * FROM ${table}`).all().map((r) => hydrate(table, r));
}

export function get(table, id) {
  return hydrate(table, db().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
}

/**
 * Insert or replace a content row. Assumes the object has already been
 * validated by the matching zod schema — callers must not skip that.
 */
export function upsert(table, obj, createdBy = 'agent') {
  const row = dehydrate(table, { ...obj, created_by: createdBy, created_at: Date.now() });
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})
               ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== 'id' && c !== 'created_at')
                 .map((c) => `${c} = excluded.${c}`).join(', ')}`;
  db().prepare(sql).run(row);
  return get(table, obj.id);
}

export function remove(table, id) {
  return db().prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// World key/value + modifiers
// ---------------------------------------------------------------------------

export function getWorld(key, fallback = null) {
  const row = db().prepare('SELECT value FROM world WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export function setWorld(key, value) {
  db().prepare('INSERT INTO world (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
  return value;
}

// ---------------------------------------------------------------------------
// Save slots
//
// Rows only. Everything with an opinion about what a world *is* — naming one,
// creating its first save, throwing one away — lives in server/worlds.js.
// ---------------------------------------------------------------------------

export function listWorldRows() {
  return db().prepare('SELECT * FROM worlds ORDER BY played_at DESC').all();
}

export function worldRow(id) {
  return db().prepare('SELECT * FROM worlds WHERE id = ?').get(id) ?? null;
}

export function insertWorldRow({ id, name, seed }) {
  const now = Date.now();
  // A database written before the sweeper was removed still has a `pinned`
  // column on this table — NOT NULL, but with a default, so naming the columns
  // we do write keeps an old file and a fresh one taking the same insert. It is
  // read by nothing now; dropping it would mean rebuilding the table for a dead
  // integer, and a save someone is playing is not worth that.
  db().prepare(`INSERT INTO worlds (id, name, seed, created_at, played_at)
                VALUES (?, ?, ?, ?, ?)`)
    .run(id, name, String(seed), now, now);
  return worldRow(id);
}

/** Last opened. What the menu sorts by. */
export function touchWorldRow(id) {
  db().prepare('UPDATE worlds SET played_at = ? WHERE id = ?').run(Date.now(), id);
}

export function renameWorldRow(id, name) {
  db().prepare('UPDATE worlds SET name = ? WHERE id = ?').run(name, id);
  return worldRow(id);
}

/**
 * Delete a world and everything that belongs only to it: its save blob and its
 * modifiers. Content is untouched — it belongs to every world at once.
 *
 * One transaction, because a half-deleted world is a row the menu offers you
 * that has no save behind it.
 */
export function deleteWorldRow(id) {
  const handle = db();
  const wipe = handle.transaction(() => {
    handle.prepare('DELETE FROM modifiers WHERE world_id = ?').run(id);
    handle.prepare('DELETE FROM world WHERE key = ?').run(worldStateKey(id));
    return handle.prepare('DELETE FROM worlds WHERE id = ?').run(id).changes > 0;
  });
  return wipe();
}

export function activeModifiers(day, worldId = DEFAULT_WORLD_ID) {
  return db().prepare('SELECT * FROM modifiers WHERE world_id = ? AND expires_day > ?')
    .all(worldId, day);
}

/**
 * An identical live row is a duplicate write, never a second event: the economy
 * folds same-event rows down to one anyway, so the extra row moves no number
 * and only pads the HUD. Skipping it means no path — a restart, a double
 * `run_director`, a test — can pile up rows that lie about what is happening.
 * Two rows that differ in any value are two real effects and both go in.
 *
 * @returns {boolean} whether a row was written.
 */
export function addModifier({
  worldId = DEFAULT_WORLD_ID, source, label = '', tag,
  demand_mult = 1, price_mult = 1, expires_day,
}) {
  const dupe = db().prepare(`SELECT id FROM modifiers
                             WHERE world_id = ? AND source = ? AND label = ? AND tag = ?
                               AND demand_mult = ? AND price_mult = ? AND expires_day = ?`)
    .get(worldId, source, label, tag, demand_mult, price_mult, expires_day);
  if (dupe) return false;

  db().prepare(`INSERT INTO modifiers (world_id, source, label, tag, demand_mult, price_mult, expires_day)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(worldId, source, label, tag, demand_mult, price_mult, expires_day);
  return true;
}

export function pruneModifiers(day, worldId = DEFAULT_WORLD_ID) {
  return db().prepare('DELETE FROM modifiers WHERE world_id = ? AND expires_day <= ?')
    .run(worldId, day).changes;
}

export function clearModifiers(source, worldId = DEFAULT_WORLD_ID) {
  return source
    ? db().prepare('DELETE FROM modifiers WHERE world_id = ? AND source = ?').run(worldId, source).changes
    : db().prepare('DELETE FROM modifiers WHERE world_id = ?').run(worldId).changes;
}
