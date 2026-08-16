/**
 * SAVE SLOTS — what a world is, who is in one, and which one you meant.
 *
 * Everything above this file talks about "the game". Everything below it talks
 * about rows. This is the layer in between: it names worlds, mints their first
 * save, hands out the live room for one, and sweeps the ones nobody comes back
 * to.
 *
 * The one rule worth stating out loud, because the rest of the codebase leans
 * on it: **content is not part of a world.** Items, crops, customers, fixtures,
 * workers and recipes are one shared library that every save reads from. That
 * is the whole co-op premise — a tomato added over MCP has to show up in your
 * shop and in the one next door — and it is why `deleteWorld` never touches a
 * content table.
 */

import { matchMaker } from 'colyseus';

import {
  DEFAULT_WORLD_ID, listWorldRows, worldRow, insertWorldRow, deleteWorldRow,
  touchWorldRow, renameWorldRow, pinWorldRow, getWorld, setWorld,
} from './db.js';
import { world as loadWorld, saveWorld, DEFAULT_WORLD } from './content.js';
import { rooms, primaryRoom } from './rooms/MartRoom.js';

/**
 * How long a world can go unopened before the sweeper bins it.
 *
 * Deliberately a fortnight rather than a couple of days: the cost of being
 * wrong here is somebody's shop, and a save you last touched a week ago is not
 * abandoned, it is Tuesday. `SNS_WORLD_TTL_DAYS=0` turns the sweep off.
 */
const TTL_DAYS = Number(process.env.SNS_WORLD_TTL_DAYS ?? 14);
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * A readable id, because an agent has to type these into `use_world` and
 * `w1f3k2p` tells nobody anything. Collisions get a numeric tail rather than a
 * rejection — two shops called "Corner Shop" is a thing a family does.
 */
function mintId(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24)
    || 'shop';
  if (!worldRow(base)) return base;
  for (let n = 2; n < 500; n++) {
    if (!worldRow(`${base}-${n}`)) return `${base}-${n}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

const randomSeed = () => Math.random().toString(36).slice(2, 8);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Every live room playing a given world. Usually one; more only mid-restart. */
export function roomsFor(worldId) {
  return [...rooms].filter((r) => r.worldId === worldId);
}

/**
 * What the menu shows for one save.
 *
 * Read off the live room when there is one, and off the save blob otherwise.
 * That order matters: a room holds an hour of play that `persist()` has written
 * but `played_at` has not moved for, so asking the row would show a shop that
 * is being played right now as sitting at whatever it was when it opened.
 */
export function summarise(row) {
  const live = roomsFor(row.id);
  const g = live[0]?.game;
  const w = g ?? loadWorld(row.id);
  return {
    id: row.id,
    name: row.name,
    seed: row.seed,
    pinned: !!row.pinned,
    created_at: row.created_at,
    played_at: row.played_at,
    live: live.length > 0,
    players: live.reduce((n, r) => n + r.clients.length, 0),
    day: w.day ?? DEFAULT_WORLD.day,
    cash: Math.round((w.cash ?? DEFAULT_WORLD.cash) * 100) / 100,
    season: w.season ?? DEFAULT_WORLD.season,
    reputation: w.reputation ?? DEFAULT_WORLD.reputation,
    upgrades: (w.ownedUpgrades ?? []).length,
    staff: (w.roster ?? []).length,
  };
}

export function listWorlds() {
  return listWorldRows().map(summarise);
}

export function getWorldSummary(id) {
  const row = worldRow(id);
  return row ? summarise(row) : null;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * What a new shop may be started with, and how silly an ask may get.
 *
 * All three are *starting* state, and two of them can only ever be set here.
 * Cash is spent from the first minute; the counts are read exactly once, by
 * `starterShop`, before `freezeShell` stamps the building and the shop becomes
 * its placements. After that the shop is what is standing in it, and asking for
 * "twelve shelves" has nowhere to land.
 *
 * The ceilings are what `verify:layout` actually sweeps — 25 shelves, 32 plots —
 * rather than a guess at what the generator will take. Past the sweep the
 * failure is a shop nobody can walk through, which is invisible from the menu
 * that asked for it.
 *
 * Season is deliberately not here. `onNewDay` derives it from the day, so a
 * shop started in winter is spring again by the next morning: a field that
 * unpicks itself inside one in-game day is worse than no field at all.
 */
const START_LIMITS = {
  cash: { min: 0, max: 1e6, cents: true },
  shelves: { min: 1, max: 25 },
  plots: { min: 1, max: 32 },
};

/**
 * One asked-for number, or `undefined` for "you didn't say".
 *
 * Blank has to mean the default rather than zero, because every one of these
 * arrives from a text box somebody left alone. Out of range is clamped rather
 * than refused: bouncing a whole new shop over a typo'd shelf count is a worse
 * trade than quietly giving you 25. The menu used to print all three ranges to
 * say so, which is a paragraph spent on a rule that only fires for numbers
 * nobody types — the boxes carry `min`/`max` and this clamps whatever arrives.
 */
function startingNumber(v, { min, max, cents = false }) {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  const clamped = Math.min(max, Math.max(min, n));
  return cents ? Math.round(clamped * 100) / 100 : Math.round(clamped);
}

/** The save patch for whatever was asked for. Empty when nothing was. */
function startingState({ cash, shelves, plots }) {
  const state = {};
  if (cash !== undefined) state.cash = cash;
  if (shelves === undefined && plots === undefined) return state;

  // `fixtures` here is the one-shot budget `starterShop` reads to furnish a shop
  // nobody has opened yet, not the stored ledger step 9 retired: it is merged
  // over the base shop, so naming only `shelf` still gets you your till, and
  // the first `persist()` overwrites it with the ledger derived from what
  // actually got placed. `shelves`/`plots` beside it are the compat mirror
  // `persist()` writes for older builds — set them here too, or a save reads
  // one way for one day and the other way forever after.
  state.fixtures = {};
  if (shelves !== undefined) { state.fixtures.shelf = shelves; state.shelves = shelves; }
  if (plots !== undefined) { state.fixtures.plot = plots; state.plots = plots; }
  return state;
}

/**
 * Mint a save slot and the save behind it.
 *
 * The blank save is written here rather than left for `Game.create` so the menu
 * can show a brand new world's day and cash before anybody has opened it —
 * otherwise a world you just made reads as empty until you go in. That is also
 * what makes the starting numbers work: they have to be on the save *before*
 * the first `Game.create` reads it, because that is the read that stamps them
 * into a building.
 */
export function createWorld({ name, seed, cash, shelves, plots } = {}) {
  const label = String(name ?? '').trim().slice(0, 32) || `Shop ${listWorldRows().length + 1}`;
  const id = mintId(label);
  const useSeed = String(seed ?? '').trim() || randomSeed();
  const start = startingState({
    cash: startingNumber(cash, START_LIMITS.cash),
    shelves: startingNumber(shelves, START_LIMITS.shelves),
    plots: startingNumber(plots, START_LIMITS.plots),
  });

  const row = insertWorldRow({ id, name: label, seed: useSeed });
  saveWorld(id, { ...DEFAULT_WORLD, seed: useSeed, ...start });
  const extras = Object.keys(start).length ? ` started with ${JSON.stringify(start)}` : '';
  console.log(`[worlds] created "${label}" (${id}, seed ${useSeed})${extras}`);
  return summarise(row);
}

export function renameWorld(id, name) {
  const label = String(name ?? '').trim().slice(0, 32);
  if (!label) return null;
  const row = renameWorldRow(id, label);
  return row ? summarise(row) : null;
}

export function pinWorld(id, pinned) {
  const row = pinWorldRow(id, pinned);
  return row ? summarise(row) : null;
}

/**
 * Throw a world away, along with the room playing it.
 *
 * The room goes first and the row goes second. The other order leaves a live
 * room ticking a world with no save row, which persists happily to a key
 * nothing will ever read again and looks — from inside the game — completely
 * normal.
 *
 * **The last world may go too.** It used to be refused, on the grounds that a
 * menu with nothing in it is a dead end — but it isn't one: the list says "no
 * shops yet" and the button under it makes one, which is the same place a new
 * install starts. What the guard actually did was make deleting your shops
 * depend on the order you did it in, and leave the one you least wanted
 * (usually the throwaway you were testing with) as the one that would not go.
 * The sweep still stops at one, because that is unattended.
 */
export async function deleteWorld(id) {
  if (!worldRow(id)) return { ok: false, error: `no world "${id}"` };

  for (const room of roomsFor(id)) {
    // Ephemeral, so the dispose hook cannot write the save back over the delete.
    room.game.ephemeral = true;
    await room.disconnect();
  }
  if (focusedWorldId() === id) setWorld('focus', null);

  const gone = deleteWorldRow(id);
  if (gone) console.log(`[worlds] deleted "${id}"`);
  return { ok: gone, deleted: gone ? id : null };
}

/** Called when somebody joins. Keeps the menu's sort order and the sweep honest. */
export function markPlayed(id) {
  if (worldRow(id)) touchWorldRow(id);
}

// ---------------------------------------------------------------------------
// The sweep
//
// Auto-deletion is real deletion, so it refuses four ways rather than one: a
// pinned world, a world with a room open, the last world standing, and anything
// touched inside the TTL. Every removal is logged with how long it had been
// sitting, because the first question after "where did my shop go" is "when did
// it decide that".
// ---------------------------------------------------------------------------

export function sweepWorlds({ now = Date.now(), ttlDays = TTL_DAYS } = {}) {
  if (!ttlDays) return { swept: [], skipped: 'disabled' };

  const rows = listWorldRows();
  const swept = [];
  for (const row of rows) {
    if (rows.length - swept.length <= 1) break;
    if (row.pinned) continue;
    if (roomsFor(row.id).length) continue;
    const idleDays = (now - row.played_at) / DAY_MS;
    if (idleDays < ttlDays) continue;

    deleteWorldRow(row.id);
    swept.push({ id: row.id, name: row.name, idleDays: Math.round(idleDays) });
    console.log(`[worlds] swept "${row.name}" (${row.id}) — untouched for ${Math.round(idleDays)} days`);
  }
  return { swept };
}

// ---------------------------------------------------------------------------
// Which world did you mean?
// ---------------------------------------------------------------------------

/**
 * The world MCP acts on when a call doesn't name one.
 *
 * Stored on the database rather than in a module variable so it survives the
 * `node --watch` restart that happens every time somebody saves a server file —
 * a pointer that resets itself mid-session is worse than no pointer, because it
 * silently goes back to poking whichever shop is busiest.
 *
 * It is shared. Both agents on this server read the same pointer, which is why
 * every route that resolves through it reports the world it landed on.
 */
export function focusedWorldId() {
  const id = getWorld('focus');
  return id && worldRow(id) ? id : null;
}

export function setFocus(id) {
  if (id === null) return setWorld('focus', null);
  if (!worldRow(id)) return null;
  setWorld('focus', id);
  return id;
}

/**
 * Resolve a world id from an explicit name, then the focus pointer, then the
 * busiest live room, then the most recently played save.
 *
 * The busiest-room step is what the control API did before any of this existed,
 * and it stays third so that an agent which never calls `use_world` keeps
 * behaving exactly as it used to.
 */
export function resolveWorldId(explicit) {
  if (explicit && worldRow(explicit)) return explicit;
  if (explicit) throw new Error(`no world "${explicit}" — call list_worlds to see what exists`);

  const focused = focusedWorldId();
  if (focused) return focused;

  const busiest = primaryRoom();
  if (busiest?.worldId && worldRow(busiest.worldId)) return busiest.worldId;

  // Rows come back most-recently-played first, so with nothing open at all this
  // is the shop you were in last — which is the one you meant.
  return listWorldRows()[0]?.id ?? null;
}

/**
 * The live room for a world, starting one if nobody has it open.
 *
 * Starting it is the point. Everything an agent does — reset a broken economy,
 * stock the shelves, run the director — used to need a browser tab open, which
 * meant "my world is bust" could only be fixed from inside the world. Now the
 * room boots headless, does the work, and the idle timer disposes it a few
 * minutes later.
 */
export async function roomForWorld(worldId) {
  const existing = roomsFor(worldId);
  if (existing.length) {
    // Prefer whichever has people in it — after a devMode restart there can
    // briefly be a stale empty room for the same world.
    return existing.reduce((a, b) => (b.clients.length > a.clients.length ? b : a));
  }
  if (!worldRow(worldId)) throw new Error(`no world "${worldId}"`);

  await matchMaker.createRoom('mart', { worldId });
  const started = roomsFor(worldId);
  if (!started.length) throw new Error(`could not start world "${worldId}"`);
  return started[0];
}

/**
 * On boot: a brand new database gets a shop to walk into.
 *
 * The mark that it has done so is its own boolean, and it has to be — "does
 * this database have any worlds" is a different question, and answering it
 * instead hands you a shop back on the next boot every time you delete your
 * last one. In dev that is every file save, so a deliberate clean-out would
 * undo itself within seconds and read as the delete having silently failed.
 * Same trap, same shape, as `freezeYard`'s mark: see CLAUDE.md.
 */
export function ensureAWorld() {
  if (getWorld('worldsSeeded')) return null;
  setWorld('worldsSeeded', true);
  if (listWorldRows().length) return null;
  return createWorld({ name: 'First shop', seed: DEFAULT_WORLD.seed });
}

export { DEFAULT_WORLD_ID };
