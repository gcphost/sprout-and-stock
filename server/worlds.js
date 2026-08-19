/**
 * SAVE SLOTS — what a world is, who is in one, and which one you meant.
 *
 * Everything above this file talks about "the game". Everything below it talks
 * about rows. This is the layer in between: it names worlds, mints their first
 * save, and hands out the live room for one.
 *
 * A save is kept until somebody deletes it, and that is the whole policy. There
 * used to be a sweeper that binned worlds nobody had opened for a fortnight,
 * which is why the menu carried a Keep button: a shop could go away on its own,
 * so you needed a way to say "not this one". Nothing expires now, so there is
 * nothing to protect a world from, and both halves are gone.
 *
 * The one rule worth stating out loud, because the rest of the codebase leans
 * on it: **content is not part of a world.** Items, crops, customers, fixtures,
 * workers and recipes are one shared library that every save reads from. That
 * is the whole co-op premise — a tomato added over MCP has to show up in your
 * shop and in the one next door — and it is why `deleteWorld` never touches a
 * content table.
 */

import {
  DEFAULT_WORLD_ID, listWorldRows, worldRow, insertWorldRow, deleteWorldRow,
  touchWorldRow, renameWorldRow, getWorld, setWorld,
} from './db.js';
import { world as loadWorld, saveWorld, DEFAULT_WORLD } from './content.js';
// From `shop.js` and not `MartRoom.js`: what this module wants is the live-room
// registry, and reaching it through the Colyseus binding would pull a websocket
// server into every build that imports this file — including a browser one,
// which is where `createWorld` is now also called from. See docs/browser.md.
import { rooms, primaryRoom } from './rooms/shop.js';
import { startTier, tierFixtures } from '../shared/start.js';
import { cleanName, SHOP_NAME_MAX } from '../shared/names.js';
import { startDifficulty, difficultyOf } from '../shared/difficulty.js';
import { PREP_HOUR } from './sim/index.js';

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
    created_at: row.created_at,
    played_at: row.played_at,
    live: live.length > 0,
    players: live.reduce((n, r) => n + r.clients.length, 0),
    day: w.day ?? DEFAULT_WORLD.day,
    cash: Math.round((w.cash ?? DEFAULT_WORLD.cash) * 100) / 100,
    season: w.season ?? DEFAULT_WORLD.season,
    // Resolved rather than raw, so a save that predates the field answers
    // `relaxed` — the preset it is actually being played on — instead of null.
    // Nothing in the menu can then draw a shop as having no difficulty, which
    // is not a state any shop is in.
    difficulty: difficultyOf(w.difficulty).id,
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
 * All of it is *starting* state, and the counts can only ever be set here. Cash
 * is spent from the first minute; the counts are read exactly once, by
 * `starterShop`, before `freezeShell` stamps the building and the shop becomes
 * its placements. After that the shop is what is standing in it, and asking for
 * "twelve shelves" has nowhere to land.
 *
 * The counts are a **tier** now (`shared/start.js`) rather than three numbers
 * somebody types, and `shelves`/`plots` survive as an override on top of one —
 * they are how a balance run asks for a shop no tier describes, and they are
 * not in the menu any more, because a shelf count chosen before you have seen a
 * shelf is a decision with nothing behind it.
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

/**
 * The save patch a new shop starts from: money, and the shop around it.
 *
 * The tier is always written, even when nobody chose one, and that is the one
 * decision in here worth stating. It could default at read time instead —
 * `starterShop` merges over `BASE_FIXTURES`, so a save with no `fixtures` at all
 * furnishes perfectly well — but then what a shop opened with would depend on
 * which build was running the day somebody walked into it, and a save minted in
 * the menu and opened next week would be a different shop from the one the
 * buttons described. Writing it at creation is what makes the choice a *fact
 * about that save*.
 */
function startingState({ cash, tier, difficulty, shelves, plots }) {
  const state = { cash: cash ?? startTier(tier).cash };

  /**
   * ...and how hard the town is, which is written for the same reason the tier
   * is and defaults the OTHER WAY from how it is read.
   *
   * `startDifficulty` falls back to `normal`; `difficultyOf`, which every load
   * goes through, falls back to `relaxed`. That is not an inconsistency, it is
   * the whole safety of the feature: `relaxed` carries the constants the game
   * shipped with, so every save that predates this field and every headless
   * game — `simulate`, all fifteen `verify:*` sweeps — reads exactly the numbers
   * it always did, while a shop somebody starts today gets a game with a bottom
   * to it. See `shared/difficulty.js`.
   */
  state.difficulty = startDifficulty(difficulty).id;

  // `fixtures` here is the one-shot budget `starterShop` reads to furnish a shop
  // nobody has opened yet, not the stored ledger step 9 retired: it is merged
  // over the base shop, so a tier naming only `shelf` would still get you your
  // till, and the first `persist()` overwrites it with the ledger derived from
  // what actually got placed.
  state.fixtures = tierFixtures(tier);
  if (shelves !== undefined) state.fixtures.shelf = shelves;
  if (plots !== undefined) state.fixtures.plot = plots;

  // The compat mirror `persist()` writes for older builds — set here too, or a
  // save reads one way for one day and the other way forever after.
  state.shelves = state.fixtures.shelf;
  state.plots = state.fixtures.plot;
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
export function createWorld({ name, seed, cash, tier, difficulty, shelves, plots } = {}) {
  const label = cleanName(name, SHOP_NAME_MAX) || `Shop ${listWorldRows().length + 1}`;
  const id = mintId(label);
  const useSeed = String(seed ?? '').trim() || randomSeed();
  const start = startingState({
    cash: startingNumber(cash, START_LIMITS.cash),
    tier,
    difficulty,
    shelves: startingNumber(shelves, START_LIMITS.shelves),
    plots: startingNumber(plots, START_LIMITS.plots),
  });

  const row = insertWorldRow({ id, name: label, seed: useSeed });
  /**
   * ...and it starts SHUT.
   *
   * The one line that makes opening up a thing you do rather than a thing the
   * clock does to you: the first act in a new shop is walking to the door and
   * raising the shutters, with a bare building and no shoppers in it while you
   * decide where the freezer goes.
   *
   * Written here rather than defaulted in `Game` on purpose, and the asymmetry
   * is the point. A save that has never heard of the field reads as OPEN, so
   * nobody's shop shuts itself on the day this shipped, and every headless game
   * — `simulate`, every `verify:*` sweep — trades exactly as it always did. Put
   * the default the other way round and a balance run measures a shop that never
   * opens, which reports as zero revenue with nothing in the output to say why.
   */
  /**
   * ...and it starts two hours BEFORE trading, which is the other half of the
   * same sentence.
   *
   * Shut at 08:00 with the town already out is a shop that is late; shut at
   * 06:00 is a shop that has not opened yet, and the two are the same pixels
   * with a different meaning on the clock. Written here for exactly the reason
   * `open: false` is — a save with nothing to say still reads as mid-morning,
   * so no headless game and no existing shop moves.
   *
   * It buys about five real seconds (`PREP_HOUR` says why), so it is the frame
   * and not the fix. The line in `step` at 08:00 and the pulse on the sign are
   * the fix.
   */
  saveWorld(id, {
    ...DEFAULT_WORLD, seed: useSeed, open: false, time: PREP_HOUR / 24, ...start,
  });
  console.log(`[worlds] created "${label}" (${id}, seed ${useSeed}) `
    + `as a ${startTier(tier).name.toLowerCase()} on ${start.difficulty}: ${JSON.stringify(start)}`);
  return summarise(row);
}

export function renameWorld(id, name) {
  const label = cleanName(name, SHOP_NAME_MAX);
  if (!label) return null;
  const row = renameWorldRow(id, label);
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

/** Called when somebody joins. Keeps the menu's sort order honest. */
export function markPlayed(id) {
  if (worldRow(id)) touchWorldRow(id);
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

  // Loaded here rather than at the top of the file, for the same reason the
  // import in `server/director.js` moved: this is the ONE line in this module
  // that needs a matchmaker, and a static import of it would make Colyseus a
  // hard dependency of listing, creating, renaming and deleting a shop — none
  // of which have ever needed one. In a build with no matchmaker this function
  // is simply never called: there is one room and it is already running.
  // `@vite-ignore` is load-bearing rather than decoration. A dynamic import is
  // still an edge in the module graph, so without it a browser bundle follows
  // this line into the whole Colyseus server and dies resolving `@pm2/io` — an
  // error naming a process-metrics package, from a file about save slots, with
  // nothing in it to suggest an import that is never executed there. Left
  // unresolved, it is a line this build never reaches: there is one room and it
  // is already running.
  const { matchMaker } = await import(/* @vite-ignore */ 'colyseus');
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
