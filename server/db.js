/**
 * THE DATABASE — the live content store.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, '..', 'data');
export const SEED_DIR = path.join(DATA_DIR, 'seed');
const DB_PATH = process.env.SNS_DB ?? path.join(DATA_DIR, 'game.db');

/** Content tables — anything an agent is allowed to write to. */
export const CONTENT_TABLES = ['items', 'crops', 'archetypes', 'events', 'upgrades', 'recipes'];

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

-- ---- runtime state (not authored content) ----

CREATE TABLE IF NOT EXISTS world (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                     -- JSON
);

-- Active demand/price modifiers. Written by the AI director, read by pricing.
CREATE TABLE IF NOT EXISTS modifiers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,              -- 'director' | 'event:<id>' | 'manual'
  label       TEXT NOT NULL DEFAULT '',
  tag         TEXT NOT NULL,
  demand_mult REAL NOT NULL DEFAULT 1,
  price_mult  REAL NOT NULL DEFAULT 1,
  expires_day INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS saves (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
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
  _db.exec(buildTriggers());
  return _db;
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
  archetypes: ['affinities'],
  events: ['effects'],
  upgrades: ['payload', 'requires'],
  recipes: ['inputs'],
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
  return out;
}

function dehydrate(table, obj) {
  const out = { ...obj };
  for (const f of JSON_FIELDS[table] ?? []) {
    if (out[f] !== undefined) out[f] = JSON.stringify(out[f]);
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

export function activeModifiers(day) {
  return db().prepare('SELECT * FROM modifiers WHERE expires_day > ?').all(day);
}

export function addModifier({ source, label = '', tag, demand_mult = 1, price_mult = 1, expires_day }) {
  db().prepare(`INSERT INTO modifiers (source, label, tag, demand_mult, price_mult, expires_day)
                VALUES (?, ?, ?, ?, ?, ?)`)
    .run(source, label, tag, demand_mult, price_mult, expires_day);
}

export function pruneModifiers(day) {
  return db().prepare('DELETE FROM modifiers WHERE expires_day <= ?').run(day).changes;
}

export function clearModifiers(source) {
  return source
    ? db().prepare('DELETE FROM modifiers WHERE source = ?').run(source).changes
    : db().prepare('DELETE FROM modifiers').run().changes;
}
